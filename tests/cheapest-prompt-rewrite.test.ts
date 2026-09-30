import { describe, expect, mock, test } from "bun:test"

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildStaticPack } from "../src/internal-prompt-submit"

import {
  buildSolRewriteSystem,
  buildStaticContextPack,
  CHEAPEST_REWRITE_BRIEF_CAP,
  CHEAPEST_REWRITE_MAX_TURNS,
  CHEAPEST_REWRITE_DEFAULT_TURNS,
  DEEP_GROUNDING_FLAG,
  isCheapestRewriteDisabledEnv,
  isCheapestRewriteEligible,
  parseNeedMoreQuery,
  resolveRewriteTurnBudget,
  runCheapestRewrite,
  wrapLunaBrief,
  type CheapestRewriteIO,
} from "../src/lib/cheapest-prompt-rewrite"
import {
  decidePromptSubmitV2,
  type PromptSubmitV2IO,
} from "../src/lib/orchestration/prompt-submit-hook"

function makeRewriteIo(overrides: Partial<CheapestRewriteIO> = {}): {
  io: CheapestRewriteIO
  searchCode: ReturnType<typeof mock<CheapestRewriteIO["searchCode"]>>
  inferSol: ReturnType<typeof mock<CheapestRewriteIO["inferSol"]>>
} {
  const searchCode = mock<CheapestRewriteIO["searchCode"]>(
    overrides.searchCode ?? (async () => ""),
  )
  const inferSol = mock<CheapestRewriteIO["inferSol"]>(
    overrides.inferSol ?? (async () => ""),
  )
  const io: CheapestRewriteIO = {
    searchCode,
    inferSol,
    staticPack: overrides.staticPack ?? (async () => ({ agentsMd: "", claudeMd: "", repoStructure: "" })),
  }
  if (overrides.timeoutMs !== undefined) io.timeoutMs = overrides.timeoutMs
  return { io, searchCode, inferSol }
}

function makeV2Io(): PromptSubmitV2IO {
  return {
    searchCode: async () => "",
    infer: async () => "",
    readFindings: async () => null,
    clearFindings: async () => {},
    storePrompt: async () => {},
  }
}

const SUBSTANTIVE = "Please refactor the auth handler across all modules"

describe("cheapest rewrite env + eligibility", () => {
  test("disabled flag recognizes 1/true/yes/on, ignores unset/0", () => {
    expect(isCheapestRewriteDisabledEnv({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isCheapestRewriteDisabledEnv({ GH_ROUTER_DISABLE_CHEAPEST_REWRITE: "0" } as NodeJS.ProcessEnv)).toBe(false)
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(isCheapestRewriteDisabledEnv({ GH_ROUTER_DISABLE_CHEAPEST_REWRITE: v } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  test("eligible only for cheapest + non-trivial + steer on + not disabled", () => {
    const base = { profile: "cheapest", promptIsNonTrivial: true, steerEnabled: true, rewriteDisabled: false }
    expect(isCheapestRewriteEligible(base)).toBe(true)
    expect(isCheapestRewriteEligible({ ...base, profile: "standard" })).toBe(false)
    expect(isCheapestRewriteEligible({ ...base, profile: undefined })).toBe(false)
    expect(isCheapestRewriteEligible({ ...base, promptIsNonTrivial: false })).toBe(false)
    expect(isCheapestRewriteEligible({ ...base, steerEnabled: false })).toBe(false)
    expect(isCheapestRewriteEligible({ ...base, rewriteDisabled: true })).toBe(false)
  })
})

describe("adaptive turn budget", () => {
  test("defaults to 3, extends to 5 on deep-grounding flag", () => {
    expect(resolveRewriteTurnBudget(null)).toBe(CHEAPEST_REWRITE_DEFAULT_TURNS)
    expect(resolveRewriteTurnBudget("plain brief")).toBe(3)
    expect(resolveRewriteTurnBudget(`brief\n${DEEP_GROUNDING_FLAG}`)).toBe(CHEAPEST_REWRITE_MAX_TURNS)
    expect(CHEAPEST_REWRITE_DEFAULT_TURNS).toBe(3)
    expect(CHEAPEST_REWRITE_MAX_TURNS).toBe(5)
  })

  test("parses NEED_MORE follow-up query, capped", () => {
    expect(parseNeedMoreQuery("no flag here")).toBe("")
    expect(parseNeedMoreQuery("NEED_MORE: auth middleware usage\nmore")).toBe("auth middleware usage")
    expect(parseNeedMoreQuery(`x\n${DEEP_GROUNDING_FLAG}\nNEED_MORE: ${"q".repeat(500)}`).length).toBeLessThanOrEqual(280)
  })
})

describe("system prompt + pack + wrap", () => {
  test("system prompt states budget, zero-tool exit, and Luna rules", () => {
    const sys = buildSolRewriteSystem({ searchEnabled: true, bluebirdEnabled: false, turnBudget: 3 })
    expect(sys).toContain("at most 3 tool turns")
    expect(sys).toContain("ZERO tools")
    expect(sys).toContain("mini-tier")
    expect(sys).toContain(DEEP_GROUNDING_FLAG)
  })

  test("static pack omits empty sections and caps guidance", () => {
    const pack = buildStaticContextPack({
      prompt: "do X",
      agentsMd: "",
      claudeMd: "",
      repoStructure: "",
      searchContext: "",
    })
    expect(pack).toBe("USER REQUEST:\ndo X")
    const long = buildStaticContextPack({
      prompt: "do X",
      agentsMd: "a".repeat(99_999),
      claudeMd: "b".repeat(99_999),
      repoStructure: "c".repeat(99_999),
      searchContext: "s",
    })
    expect(long.length).toBeLessThan(99_999)
    expect(long).toContain("AGENTS.md")
  })

  test("wrap strips control lines, adds advisory header, caps length", () => {
    expect(wrapLunaBrief("   ")).toBe("")
    const wrapped = wrapLunaBrief(`Goal: do X\n${DEEP_GROUNDING_FLAG}\nNEED_MORE: something\nSteps: 1. a`)
    expect(wrapped).toContain("LUNA BRIEF (advisory, additive")
    expect(wrapped).not.toContain(DEEP_GROUNDING_FLAG)
    expect(wrapped).not.toContain("NEED_MORE:")
    expect(wrapped).toContain("Goal: do X")
    const huge = wrapLunaBrief("x".repeat(99_999))
    expect(huge.length).toBeLessThanOrEqual(CHEAPEST_REWRITE_BRIEF_CAP + 200)
  })
})

describe("runCheapestRewrite", () => {
  test("success path returns additive brief from a single Sol call", async () => {
    const { io, inferSol, searchCode } = makeRewriteIo({
      searchCode: async (_q, mode) => `${mode}-hit`,
      inferSol: async () => "Goal: refactor auth. Steps: 1. Search 2. Edit 3. Test.",
    })
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: true, bluebirdEnabled: false, io })
    expect(brief).not.toBeNull()
    expect(brief ?? "").toContain("LUNA BRIEF")
    expect(brief ?? "").toContain("refactor auth")
    expect(inferSol.mock.calls.length).toBe(1)
    expect(searchCode.mock.calls.map((c) => c[1]).sort()).toEqual(["lexical", "semantic"])
  })

  test("fail-open: Sol rejection yields null (caller falls back to Luna path)", async () => {
    const { io } = makeRewriteIo({
      inferSol: async () => { throw new Error("sol down") },
    })
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: true, bluebirdEnabled: false, io })
    expect(brief).toBeNull()
  })

  test("fail-open: empty Sol output yields null", async () => {
    const { io } = makeRewriteIo({ inferSol: async () => "   " })
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(brief).toBeNull()
  })

  test("adaptive extension: flag + NEED_MORE triggers one follow-up round", async () => {
    const seen: Array<string> = []
    const { io, inferSol, searchCode } = makeRewriteIo({
      searchCode: async (q) => { seen.push(q); return `result-for-${q}` },
      inferSol: mock(async (_system: string, user: string) => {
        if (user.includes("FOLLOW-UP GROUNDING")) return "Goal: final grounded brief."
        return `${DEEP_GROUNDING_FLAG}\nNEED_MORE: auth middleware\nGoal: draft.`
      }),
    })
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(brief).not.toBeNull()
    expect(brief ?? "").toContain("final grounded brief")
    expect(seen).toContain("auth middleware")
    expect(inferSol.mock.calls.length).toBe(2)
    expect(searchCode.mock.calls.length).toBe(2) // initial lexical + follow-up
  })

  test("no extension without flag: single Sol call even with NEED_MORE-like text absent", async () => {
    const { io, inferSol } = makeRewriteIo({
      inferSol: async () => "Goal: simple brief, no flag.",
    })
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(brief).not.toBeNull()
    expect(inferSol.mock.calls.length).toBe(1)
  })

  test("timeout fail-open: hung Sol falls back to null quickly", async () => {
    const { io } = makeRewriteIo({
      inferSol: () => new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("late"), 5_000)
        t.unref?.()
      }),
      timeoutMs: 50,
    })
    const start = performance.now()
    const brief = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(brief).toBeNull()
    expect(performance.now() - start).toBeLessThan(1_000)
  })
})

describe("buildStaticPack", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-router-static-pack-"))
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  test("prefers AGENTS.md, falls back to CLAUDE.md, empty when both missing", () => {
    const withAgents = makeWorkspace({ "AGENTS.md": "# rules", "CLAUDE.md": "# other" })
    try {
      const pack = buildStaticPack(withAgents)
      expect(pack.agentsMd).toContain("# rules")
      expect(pack.claudeMd).toBe("")
    } finally {
      rmSync(withAgents, { recursive: true, force: true })
    }
    const withClaudeOnly = makeWorkspace({ "CLAUDE.md": "# other" })
    try {
      const pack = buildStaticPack(withClaudeOnly)
      expect(pack.agentsMd).toBe("")
      expect(pack.claudeMd).toContain("# other")
    } finally {
      rmSync(withClaudeOnly, { recursive: true, force: true })
    }
    const empty = makeWorkspace({})
    try {
      const pack = buildStaticPack(empty)
      expect(pack.agentsMd).toBe("")
      expect(pack.claudeMd).toBe("")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("repo structure lists top-level entries plus package.json scripts snippet", () => {
    const dir = makeWorkspace({
      "package.json": JSON.stringify({ scripts: { build: "x", test: "y" }, dependencies: { zod: "^1" } }),
      "src/index.ts": "",
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.repoStructure).toContain("src/")
      expect(pack.repoStructure).toContain("package.json")
      expect(pack.repoStructure).toContain("build")
      expect(pack.repoStructure).toContain("zod")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing workspace yields empty strings (fail-open)", () => {
    const pack = buildStaticPack(path.join(tmpdir(), "gh-router-does-not-exist-12345"))
    expect(pack).toEqual({ agentsMd: "", claudeMd: "", repoStructure: "" })
  })
})

describe("decidePromptSubmitV2 cheapest branch", () => {
  test("cheapest + rewrite IO injects the Sol brief (additive, original ask preserved)", async () => {
    const { io: rewrite } = makeRewriteIo({
      inferSol: async () => "Goal: refactor auth. Steps: 1. Search 2. Edit.",
    })
    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }),
      steerEnabled: true,
      searchEnabled: false,
      io: makeV2Io(),
      profile: "cheapest",
      rewriteDisabled: false,
      rewrite,
    })
    expect(result.inject).toContain("LUNA BRIEF")
    expect(result.inject).toContain("refactor auth")
  })

  test("non-cheapest profile ignores rewrite IO and uses the Luna scope path", async () => {
    const { io: rewrite, inferSol } = makeRewriteIo({
      inferSol: async () => "SOL BRIEF SHOULD NOT APPEAR",
    })
    const lunaGoal = "SCOPE: focused\nGOAL: do X"
    const io = makeV2Io()
    io.infer = async () => lunaGoal
    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }),
      steerEnabled: true,
      searchEnabled: false,
      io,
      profile: "standard",
      rewriteDisabled: false,
      rewrite,
    })
    expect(result.inject).toContain(lunaGoal)
    expect(result.inject).not.toContain("SOL BRIEF SHOULD NOT APPEAR")
    expect(inferSol.mock.calls.length).toBe(0)
  })

  test("rewriteDisabled skips Sol and uses the Luna scope path", async () => {
    const { io: rewrite, inferSol } = makeRewriteIo({
      inferSol: async () => "SOL BRIEF SHOULD NOT APPEAR",
    })
    const lunaGoal = "SCOPE: focused\nGOAL: do X"
    const io = makeV2Io()
    io.infer = async () => lunaGoal
    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }),
      steerEnabled: true,
      searchEnabled: false,
      io,
      profile: "cheapest",
      rewriteDisabled: true,
      rewrite,
    })
    expect(result.inject).toContain(lunaGoal)
    expect(inferSol.mock.calls.length).toBe(0)
  })

  test("rewrite failure falls back to the Luna scope path (fail-open)", async () => {
    const { io: rewrite } = makeRewriteIo({
      inferSol: async () => { throw new Error("sol down") },
    })
    const lunaGoal = "SCOPE: focused\nGOAL: do X"
    const io = makeV2Io()
    io.infer = async () => lunaGoal
    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }),
      steerEnabled: true,
      searchEnabled: false,
      io,
      profile: "cheapest",
      rewriteDisabled: false,
      rewrite,
    })
    expect(result.inject).toContain(lunaGoal)
  })

  test("trivial cheapest prompt makes no Sol call", async () => {
    const { io: rewrite, inferSol } = makeRewriteIo({
      inferSol: async () => "SHOULD NOT APPEAR",
    })
    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "hi" }),
      steerEnabled: true,
      io: makeV2Io(),
      profile: "cheapest",
      rewriteDisabled: false,
      rewrite,
    })
    expect(result.inject).toBe("")
    expect(inferSol.mock.calls.length).toBe(0)
  })
})
