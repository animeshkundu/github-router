import { describe, expect, mock, test } from "bun:test"

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildStaticPack } from "../src/internal-prompt-submit"
import { fileRewriteFlagStore } from "../src/lib/orchestration/stop-gate-policy"

import {
  buildSolRewriteSystem,
  buildStaticContextPack,
  CHEAPEST_REWRITE_BRIEF_CAP,
  CHEAPEST_REWRITE_GUIDANCE_CAP,
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
  PROMPT_STEER_GOAL,
  type PromptSubmitV2IO,
} from "../src/lib/orchestration/prompt-submit-hook"

function makeRewriteIo(overrides: Partial<CheapestRewriteIO> = {}): {
  io: CheapestRewriteIO
  searchCode: ReturnType<typeof mock<CheapestRewriteIO["searchCode"]>>
  inferSol: ReturnType<typeof mock<CheapestRewriteIO["inferSol"]>>
  hasRewriteRun: ReturnType<typeof mock<CheapestRewriteIO["hasRewriteRun"]>>
  markRewriteRun: ReturnType<typeof mock<CheapestRewriteIO["markRewriteRun"]>>
} {
  const searchCode = mock<CheapestRewriteIO["searchCode"]>(
    overrides.searchCode ?? (async () => ""),
  )
  const inferSol = mock<CheapestRewriteIO["inferSol"]>(
    overrides.inferSol ?? (async () => ""),
  )
  const hasRewriteRun = mock<CheapestRewriteIO["hasRewriteRun"]>(
    overrides.hasRewriteRun ?? (async () => false),
  )
  const markRewriteRun = mock<CheapestRewriteIO["markRewriteRun"]>(
    overrides.markRewriteRun ?? (async () => {}),
  )
  const io: CheapestRewriteIO = {
    searchCode,
    inferSol,
    staticPack: overrides.staticPack ?? (async () => ({ agentsMd: "", claudeMd: "", repoStructure: "", verifyCommand: "" })),
    hasRewriteRun,
    markRewriteRun,
  }
  if (overrides.timeoutMs !== undefined) io.timeoutMs = overrides.timeoutMs
  return { io, searchCode, inferSol, hasRewriteRun, markRewriteRun }
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
  test("system prompt states budget, zero-tool exit, and the contract framing", () => {
    const sys = buildSolRewriteSystem({ searchEnabled: true, bluebirdEnabled: false, turnBudget: 3 })
    expect(sys).toContain("at most 3 tool turns")
    expect(sys).toContain("ZERO tools")
    expect(sys).toContain("mini-tier")
    expect(sys).toContain(DEEP_GROUNDING_FLAG)
    // Grounded execution contract: the sections it must emit.
    for (const label of ["INTENT", "GROUNDING", "CONSTRAINTS", "VERIFY", "OPEN QUESTIONS", "PLAN"]) {
      expect(sys).toContain(label)
    }
    // Authority + fidelity invariant.
    expect(sys).toContain("AUTHORITATIVE")
    expect(sys.toLowerCase()).toContain("never invent")
    // Optional plan.
    expect(sys).toContain("OPTIONAL")
  })

  test("system prompt is anti-CoT: no step-by-step / reasoning scaffold", () => {
    const sys = buildSolRewriteSystem({ searchEnabled: true, bluebirdEnabled: false, turnBudget: 3 })
    const lower = sys.toLowerCase()
    // It must NOT instruct Luna to reason step-by-step. (The prompt does mention
    // the phrase inside a negation — "do NOT tell Luna to 'think step by
    // step'" — so assert on the absence of affirmative scaffold phrasing.)
    expect(lower).not.toMatch(/step[- ]by[- ]step[,.]?\s*(then|and|first|before)/)
    expect(lower).not.toContain("think step by step and")
    // It explicitly forbids prescribing a procedure.
    expect(lower).toContain("do not tell luna")
    expect(lower).toContain("procedural recipe")
  })

  test("static pack omits empty sections and caps guidance", () => {
    const pack = buildStaticContextPack({
      prompt: "do X",
      agentsMd: "",
      claudeMd: "",
      repoStructure: "",
      verifyCommand: "",
      searchContext: "",
    })
    expect(pack).toBe("USER REQUEST:\ndo X")
    const long = buildStaticContextPack({
      prompt: "do X",
      agentsMd: "a".repeat(99_999),
      claudeMd: "b".repeat(99_999),
      repoStructure: "c".repeat(99_999),
      verifyCommand: "",
      searchContext: "s",
    })
    expect(long.length).toBeLessThan(99_999)
    expect(long).toContain("AGENTS.md")
  })

  test("static pack passes the user prompt through in full (never truncates)", () => {
    const hugePrompt = `User wants: ${"x".repeat(20_000)} END_OF_PROMPT`
    const pack = buildStaticContextPack({
      prompt: hugePrompt,
      agentsMd: "a".repeat(99_999),
      claudeMd: "",
      repoStructure: "",
      verifyCommand: "",
      searchContext: "",
    })
    expect(pack).toContain(hugePrompt)
    expect(pack).toContain("END_OF_PROMPT")
  })

  test("static pack includes the verify command line when present", () => {
    const pack = buildStaticContextPack({
      prompt: "do X",
      agentsMd: "",
      claudeMd: "",
      repoStructure: "",
      verifyCommand: "VERIFY COMMAND: npm test",
      searchContext: "",
    })
    expect(pack).toContain("VERIFY COMMAND: npm test")
  })

  test("wrap strips control lines, adds authority framing, caps length", () => {
    expect(wrapLunaBrief("   ")).toBe("")
    const wrapped = wrapLunaBrief(`INTENT: do X\n${DEEP_GROUNDING_FLAG}\nNEED_MORE: something\nCONSTRAINTS: 1. a`)
    expect(wrapped).toContain("EXECUTION BRIEF")
    expect(wrapped).toContain("non-authoritative")
    expect(wrapped).toContain("remains authoritative")
    expect(wrapped).not.toContain(DEEP_GROUNDING_FLAG)
    expect(wrapped).not.toContain("NEED_MORE:")
    expect(wrapped).toContain("INTENT: do X")
    const huge = wrapLunaBrief("x".repeat(99_999))
    expect(huge.length).toBeLessThanOrEqual(CHEAPEST_REWRITE_BRIEF_CAP + 300)
  })
})

describe("runCheapestRewrite", () => {
  test("success path returns additive contract from a single Sol call", async () => {
    const { io, inferSol, searchCode } = makeRewriteIo({
      searchCode: async (_q, mode) => `${mode}-hit`,
      inferSol: async () => "INTENT: refactor auth.\nCONSTRAINTS: behavior-preserving.",
    })
    const { brief, timedOut } = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: true, bluebirdEnabled: false, io })
    expect(timedOut).toBe(false)
    expect(brief).not.toBeNull()
    expect(brief ?? "").toContain("EXECUTION BRIEF")
    expect(brief ?? "").toContain("refactor auth")
    expect(inferSol.mock.calls.length).toBe(1)
    expect(searchCode.mock.calls.map((c) => c[1]).sort()).toEqual(["lexical", "semantic"])
  })

  test("fail-open: Sol rejection yields { brief: null, timedOut: false }", async () => {
    const { io } = makeRewriteIo({
      inferSol: async () => { throw new Error("sol down") },
    })
    const result = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: true, bluebirdEnabled: false, io })
    expect(result).toEqual({ brief: null, timedOut: false })
  })

  test("fail-open: empty Sol output yields { brief: null, timedOut: false }", async () => {
    const { io } = makeRewriteIo({ inferSol: async () => "   " })
    const result = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(result).toEqual({ brief: null, timedOut: false })
  })

  test("adaptive extension: flag + NEED_MORE triggers one follow-up round (parallel lexical+semantic)", async () => {
    const seen: Array<[string, string]> = []
    const { io, inferSol, searchCode } = makeRewriteIo({
      searchCode: async (q, mode) => { seen.push([q, mode]); return `result-for-${q}` },
      inferSol: mock(async (_system: string, user: string) => {
        if (user.includes("FOLLOW-UP GROUNDING")) return "INTENT: final grounded contract."
        return `${DEEP_GROUNDING_FLAG}\nNEED_MORE: auth middleware\nINTENT: draft.`
      }),
    })
    // semantic enabled -> follow-up must search BOTH modes in parallel.
    const { brief } = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: true, bluebirdEnabled: false, io })
    expect(brief).not.toBeNull()
    expect(brief ?? "").toContain("final grounded contract")
    const followUpModes = seen.filter(([q]) => q === "auth middleware").map(([, m]) => m).sort()
    expect(followUpModes).toEqual(["lexical", "semantic"])
    expect(inferSol.mock.calls.length).toBe(2)
    // initial lexical + semantic, then follow-up lexical + semantic = 4.
    expect(searchCode.mock.calls.length).toBe(4)
  })

  test("no extension without flag: single Sol call", async () => {
    const { io, inferSol } = makeRewriteIo({
      inferSol: async () => "INTENT: simple contract, no flag.",
    })
    const { brief } = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(brief).not.toBeNull()
    expect(inferSol.mock.calls.length).toBe(1)
  })

  test("timeout is TERMINAL: hung Sol yields { brief: null, timedOut: true } quickly", async () => {
    const { io } = makeRewriteIo({
      inferSol: () => new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("late"), 5_000)
        t.unref?.()
      }),
      timeoutMs: 50,
    })
    const start = performance.now()
    const result = await runCheapestRewrite({ prompt: SUBSTANTIVE, searchEnabled: false, bluebirdEnabled: false, io })
    expect(result).toEqual({ brief: null, timedOut: true })
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

  test("extracts a VERIFY COMMAND from package.json test/build/lint scripts", () => {
    const dir = makeWorkspace({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", build: "tsc", lint: "eslint" },
        dependencies: {},
      }),
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toContain("VERIFY COMMAND:")
      expect(pack.verifyCommand).toContain("npm run test")
      expect(pack.verifyCommand).toContain("npm run build")
      expect(pack.verifyCommand).toContain("npm run lint")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("verify command is empty when no recognized scripts exist", () => {
    const dir = makeWorkspace({ "package.json": JSON.stringify({ scripts: { start: "node ." } }) })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing workspace yields empty strings (fail-open)", () => {
    const pack = buildStaticPack(path.join(tmpdir(), "gh-router-does-not-exist-12345"))
    expect(pack).toEqual({ agentsMd: "", claudeMd: "", repoStructure: "", verifyCommand: "" })
  })
})

// ---------------------------------------------------------------------------
// VERIFY COMMAND — ecosystem generic. The line is handed to Luna as *the*
// command that verifies the work, so a wrong guess is worse than no guess.
// These pin the runner resolution, the monorepo ascent, the .NET tier, and the
// marker ladder (including the honest "" cases).
// ---------------------------------------------------------------------------

describe("buildStaticPack VERIFY COMMAND runner resolution", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-router-verify-"))
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  const pkg = (
    extra: Record<string, unknown>,
    scripts: Record<string, string> = { test: "x" },
  ) => JSON.stringify({ scripts, ...extra })

  test("bun lockfile yields `bun run test`, never `bun test`", () => {
    // `bun test` invokes Bun's BUILT-IN runner and ignores the `test` script,
    // which here is a build + orchestrator chain — so the `run` form is the
    // only correct one.
    const dir = makeWorkspace({
      "bun.lock": "",
      "package.json": pkg({}, { test: "bun run build && bun scripts/run-tests.ts" }),
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("VERIFY COMMAND: bun run test")
      expect(pack.verifyCommand).not.toContain("bun test ")
      expect(pack.repoStructure).toContain("ecosystem: node (bun)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("yarn lockfile yields yarn commands", () => {
    const dir = makeWorkspace({
      "yarn.lock": "",
      "package.json": pkg({}, { test: "jest", lint: "eslint ." }),
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("VERIFY COMMAND: yarn run test ; yarn run lint")
      expect(pack.repoStructure).toContain("ecosystem: node (yarn)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("versioned packageManager is read as a NAME, not a version", () => {
    const dir = makeWorkspace({ "package.json": pkg({ packageManager: "pnpm@9.1.0" }) })
    try {
      expect(buildStaticPack(dir).verifyCommand).toBe("VERIFY COMMAND: pnpm run test")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("lockfile-less repos infer the runner from script bodies", () => {
    const dir = makeWorkspace({ "package.json": pkg({}, { test: "bun run test" }) })
    try {
      expect(buildStaticPack(dir).verifyCommand).toBe("VERIFY COMMAND: bun run test")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a vitest/jest dependency never produces `npx npm …`", () => {
    const dir = makeWorkspace({
      "package.json": pkg({ devDependencies: { vitest: "^1" } }, { test: "vitest" }),
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("VERIFY COMMAND: npm run test")
      expect(pack.verifyCommand).not.toContain("npx")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a monorepo sub-package uses the workspace root scripts and says where to run them", () => {
    const dir = makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "pnpm-lock.yaml": "",
      "package.json": pkg({}, { test: "turbo test", build: "turbo build" }),
      "packages/web/package.json": JSON.stringify({ name: "web", devDependencies: {} }),
    })
    const sub = path.join(dir, "packages/web")
    try {
      const pack = buildStaticPack(sub)
      expect(pack.verifyCommand).toContain(`VERIFY COMMAND (run from ${dir}):`)
      expect(pack.verifyCommand).toContain("pnpm run test")
      expect(pack.verifyCommand).toContain("pnpm run build")
      expect(pack.repoStructure).toContain("ecosystem: node (pnpm, workspace root)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildStaticPack VERIFY COMMAND .NET tier", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-router-dotnet-"))
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  test("a solution yields dotnet build/test, plus format when .editorconfig exists", () => {
    const dir = makeWorkspace({
      "Fake.sln": "Microsoft Visual Studio Solution File\n",
      ".editorconfig": "root = true\n",
      "src/App/App.csproj": "<Project/>\n",
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe(
        "VERIFY COMMAND: dotnet build ; dotnet test ; dotnet format --verify-no-changes",
      )
      expect(pack.repoStructure).toContain("ecosystem: dotnet (Fake.sln)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a nested csproj alone yields dotnet without the format check", () => {
    const dir = makeWorkspace({ "src/App/App.csproj": "<Project/>\n" })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("VERIFY COMMAND: dotnet build ; dotnet test")
      expect(pack.repoStructure).toContain("ecosystem: dotnet (App.csproj)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildStaticPack VERIFY COMMAND marker ladder", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-router-marker-"))
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  const cases: Array<[string, Record<string, string>, string]> = [
    ["go", { "go.mod": "module x\n" }, "VERIFY COMMAND: go build ./... ; go test ./... ; go vet ./..."],
    ["rust", { "Cargo.toml": "[package]\n" }, "VERIFY COMMAND: cargo build ; cargo test"],
    ["elixir", { "mix.exs": "defmodule X do\nend\n" }, "VERIFY COMMAND: mix test"],
    ["ruby", { Gemfile: "source 'x'\n" }, "VERIFY COMMAND: bundle exec rake test"],
    ["ruby with spec/", { Gemfile: "source 'x'\n", "spec/x_spec.rb": "" }, "VERIFY COMMAND: bundle exec rspec"],
    ["deno", { "deno.json": JSON.stringify({ tasks: { test: "t" } }) }, "VERIFY COMMAND: deno task test"],
    ["make", { Makefile: "test:\n\tgo test\n\nbuild:\n\tgo build\n" }, "VERIFY COMMAND: make test ; make build"],
  ]

  for (const [name, files, expected] of cases) {
    test(`${name} yields its canonical command`, () => {
      const dir = makeWorkspace(files)
      try {
        expect(buildStaticPack(dir).verifyCommand).toBe(expected)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test("python picks the runner from its lockfile and appends only configured linters", () => {
    const dir = makeWorkspace({
      "uv.lock": "",
      "pyproject.toml": "[project]\nname='x'\n[tool.ruff]\n",
      "tests/test_x.py": "",
    })
    try {
      const pack = buildStaticPack(dir)
      expect(pack.verifyCommand).toBe("VERIFY COMMAND: uv run pytest ; ruff check .")
      expect(pack.repoStructure).toContain("ecosystem: python (pyproject.toml)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("poetry is detected without a uv lockfile", () => {
    const dir = makeWorkspace({
      "poetry.lock": "",
      "pyproject.toml": "[project]\nname='x'\n[tool.mypy]\n",
      "tests/test_x.py": "",
    })
    try {
      expect(buildStaticPack(dir).verifyCommand).toBe(
        "VERIFY COMMAND: poetry run pytest ; mypy .",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const noCommand: Array<[string, Record<string, string>]> = [
    ["a Makefile with no known target", { Makefile: "deploy:\n\techo hi\n" }],
    ["a deno.json with no test task", { "deno.json": JSON.stringify({ tasks: { build: "b" } }) }],
    ["a python project with no tests", { "pyproject.toml": "[project]\nname='x'\n" }],
    ["an empty project", { "README.md": "hi\n" }],
  ]

  for (const [name, files] of noCommand) {
    test(`${name} yields no command rather than a guess`, () => {
      const dir = makeWorkspace(files)
      try {
        expect(buildStaticPack(dir).verifyCommand).toBe("")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe("buildStaticPack hierarchical guidance", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-router-guidance-"))
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  test("a subdirectory session picks up the repo root's AGENTS.md", () => {
    const dir = makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "AGENTS.md": "ROOT AGENTS\n",
      "sub/AGENTS.md": "SUB AGENTS\n",
      "sub/package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    })
    try {
      const pack = buildStaticPack(path.join(dir, "sub"))
      expect(pack.agentsMd).toContain("SUB AGENTS")
      expect(pack.agentsMd).toContain("ROOT AGENTS")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("closest guidance wins the shared cap (head truncation keeps the head)", () => {
    // Root-first ordering plus a head-truncating slice would silently starve
    // the nearest file — the exact bug this pins.
    const dir = makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "AGENTS.md": "ROOT AGENTS\n",
      "sub/AGENTS.md": `SUB AGENTS\n${"S".repeat(3900)}\n`,
    })
    try {
      const pack = buildStaticPack(path.join(dir, "sub"))
      expect(pack.agentsMd.length).toBeLessThanOrEqual(CHEAPEST_REWRITE_GUIDANCE_CAP)
      expect(pack.agentsMd.startsWith("SUB AGENTS")).toBe(true)
      expect(pack.agentsMd).toContain("ROOT AGENTS")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("guidance ABOVE the repo root is never read", () => {
    // The parent-of-repo case is the real hazard: a user's ~/CLAUDE.md must not
    // be injected into an unrelated project's rewrite.
    const outer = makeWorkspace({
      "CLAUDE.md": "PARENT CLAUDE\n",
      "AGENTS.md": "PARENT AGENTS\n",
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/AGENTS.md": "REPO AGENTS\n",
      "repo/sub/package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    })
    try {
      const pack = buildStaticPack(path.join(outer, "repo/sub"))
      expect(pack.agentsMd).toContain("REPO AGENTS")
      expect(pack.agentsMd).not.toContain("PARENT AGENTS")
      expect(pack.claudeMd).toBe("")
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
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
    expect(result.inject).toContain("EXECUTION BRIEF")
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

describe("one-shot rewrite flag store", () => {
  function makeFlagDir(): string {
    return mkdtempSync(path.join(tmpdir(), "gh-router-rewrite-flag-"))
  }

  test("missing file reads false; marked reads true; sessions isolated", async () => {
    const dir = makeFlagDir()
    try {
      const store = fileRewriteFlagStore(dir)
      expect(await store.hasRun("s1")).toBe(false)
      await store.markRun("s1")
      expect(await store.hasRun("s1")).toBe(true)
      expect(await store.hasRun("s2")).toBe(false)
      // Idempotent re-mark.
      await store.markRun("s1")
      expect(await store.hasRun("s1")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("decidePromptSubmitV2 one-shot rewrite gate", () => {
  function cheapestV2Input(stdin: string, rewrite: CheapestRewriteIO, lunaGoal = "SCOPE: focused\nGOAL: do X") {
    const io = makeV2Io()
    io.infer = async () => lunaGoal
    return {
      stdin,
      steerEnabled: true,
      searchEnabled: false,
      io,
      profile: "cheapest",
      rewriteDisabled: false,
      rewrite,
    } as const
  }

  test("first substantive prompt rewrites and marks the session", async () => {
    const { io: rewrite, inferSol, markRewriteRun } = makeRewriteIo({
      inferSol: async () => "Goal: refactor auth. Steps: 1. Search 2. Edit.",
    })
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite),
    )
    expect(result.inject).toContain("EXECUTION BRIEF")
    expect(inferSol.mock.calls.length).toBe(1)
    expect(markRewriteRun.mock.calls.length).toBe(1)
    expect(markRewriteRun.mock.calls[0]).toEqual(["s1"])
  })

  test("second substantive prompt skips Sol and uses the Luna path", async () => {
    const { io: rewrite, inferSol, markRewriteRun } = makeRewriteIo({
      hasRewriteRun: async () => true,
      inferSol: async () => "SOL BRIEF SHOULD NOT APPEAR",
    })
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite),
    )
    expect(result.inject).toContain("SCOPE: focused")
    expect(result.inject).not.toContain("SOL BRIEF SHOULD NOT APPEAR")
    expect(inferSol.mock.calls.length).toBe(0)
    expect(markRewriteRun.mock.calls.length).toBe(0)
  })

  test("failed first attempt still consumes the one shot (spend once, fail-open after)", async () => {
    const { io: rewrite, markRewriteRun } = makeRewriteIo({
      inferSol: async () => { throw new Error("sol down") },
    })
    const lunaGoal = "SCOPE: focused\nGOAL: do X"
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite, lunaGoal),
    )
    // Failed over to the Luna path, but the session is marked.
    expect(result.inject).toContain(lunaGoal)
    expect(markRewriteRun.mock.calls.length).toBe(1)
  })

  test("rewrite timeout is TERMINAL: cheap regex goal only, no Luna fallback call", async () => {
    const lunaGoal = "SCOPE: focused\nGOAL: SHOULD NOT APPEAR"
    const { io: rewrite, markRewriteRun } = makeRewriteIo({
      inferSol: () => new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("late"), 5_000)
        t.unref?.()
      }),
      timeoutMs: 50,
    })
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite, lunaGoal),
    )
    // Falls open to the cheap regex goal, NOT the Luna scope path.
    expect(result.inject).toContain(PROMPT_STEER_GOAL)
    expect(result.inject).not.toContain(lunaGoal)
    expect(markRewriteRun.mock.calls.length).toBe(1)
  })

  test("trivial first prompt does not consume the shot; later substantive rewrites", async () => {
    const { io: rewrite, inferSol, markRewriteRun } = makeRewriteIo({
      inferSol: async () => "Goal: refactor auth.",
    })
    const trivial = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: "hi" }), rewrite),
    )
    expect(trivial.inject).toBe("")
    expect(markRewriteRun.mock.calls.length).toBe(0)
    const substantive = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite),
    )
    expect(substantive.inject).toContain("EXECUTION BRIEF")
    expect(inferSol.mock.calls.length).toBe(1)
  })

  test("missing session id fails closed: no Sol spend", async () => {
    const { io: rewrite, inferSol, markRewriteRun } = makeRewriteIo({
      inferSol: async () => "SHOULD NOT APPEAR",
    })
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ prompt: SUBSTANTIVE }), rewrite),
    )
    expect(result.inject).not.toContain("SHOULD NOT APPEAR")
    expect(inferSol.mock.calls.length).toBe(0)
    expect(markRewriteRun.mock.calls.length).toBe(0)
  })

  test("flag-store read error fails closed: no Sol spend", async () => {
    const { io: rewrite, inferSol } = makeRewriteIo({
      hasRewriteRun: async () => { throw new Error("disk gone") },
      inferSol: async () => "SHOULD NOT APPEAR",
    })
    const result = await decidePromptSubmitV2(
      cheapestV2Input(JSON.stringify({ session_id: "s1", prompt: SUBSTANTIVE }), rewrite),
    )
    expect(result.inject).not.toContain("SHOULD NOT APPEAR")
    expect(inferSol.mock.calls.length).toBe(0)
  })
})
