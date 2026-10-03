import { describe, expect, test } from "bun:test"

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  decodeRebriefPayload,
  isRebriefHardGateEnabled,
  isRebriefProfileEligible,
  isRebriefUserInvoked,
  resolveRebriefPrompt,
} from "../src/internal-rebrief"
import {
  buildRebriefSkill,
  REBRIEF_SKILL,
} from "../src/lib/injected-skills/rebrief-skill"
import { injectedSkillsForLaunch } from "../src/lib/injected-skills"
import { buildRebriefSystem, buildSolRewriteSystem, buildStaticContextPack, DEEP_GROUNDING_FLAG } from "../src/lib/cheapest-prompt-rewrite"
import { fileRebriefBindingStore } from "../src/lib/orchestration/stop-gate-policy"

describe("fileRebriefBindingStore", () => {
  test("write-then-read round-trips and honors cwd key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rebrief-binding-"))
    try {
      const store = fileRebriefBindingStore(dir)
      await store.write({ sessionId: "s1", transcriptPath: "/t.jsonl", cwd: "/work", atMs: Date.now() })
      const rec = await store.read("/work")
      expect(rec?.sessionId).toBe("s1")
      expect(rec?.transcriptPath).toBe("/t.jsonl")
      expect(await store.read("/other")).toBeNull()
      await store.write({ sessionId: "s2", transcriptPath: "/t2.jsonl", cwd: "/work", atMs: Date.now() - 25 * 60 * 60 * 1000 })
      expect(await store.read("/work")).toBeNull() // stale >24h is ignored
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("rebrief profile gate", () => {
  test("cheapest-only (case-insensitive, trimmed)", () => {
    expect(isRebriefProfileEligible("cheapest")).toBe(true)
    expect(isRebriefProfileEligible("  Cheapest ")).toBe(true)
    expect(isRebriefProfileEligible("standard")).toBe(false)
    expect(isRebriefProfileEligible("cheap")).toBe(false)
    expect(isRebriefProfileEligible(undefined)).toBe(false)
    expect(isRebriefProfileEligible("")).toBe(false)
  })

  test("hard gate on by default; explicit opt-out only", () => {
    expect(isRebriefHardGateEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(isRebriefHardGateEnabled({ GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED: "1" } as NodeJS.ProcessEnv)).toBe(true)
    expect(isRebriefHardGateEnabled({ GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED: "0" } as NodeJS.ProcessEnv)).toBe(false)
    expect(isRebriefHardGateEnabled({ GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED: "false" } as NodeJS.ProcessEnv)).toBe(false)
    expect(isRebriefUserInvoked({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isRebriefUserInvoked({ GH_ROUTER_REBRIEF_USER_INVOKED: "1" } as NodeJS.ProcessEnv)).toBe(true)
  })

})

describe("decodeRebriefPayload", () => {
  test("parses hook fields; never throws", () => {
    const p = decodeRebriefPayload(JSON.stringify({
      session_id: "s1",
      prompt: "Fix the auth handler",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
    }))
    expect(p.sessionId).toBe("s1")
    expect(p.prompt).toBe("Fix the auth handler")
    expect(p.transcriptPath).toBe("/tmp/t.jsonl")
    expect(p.cwd).toBe("/repo")
    expect(p.isSubagent).toBe(false)
  })

  test("flags subagent contexts", () => {
    const p = decodeRebriefPayload(JSON.stringify({ session_id: "s", agent_type: "worker-explore" }))
    expect(p.isSubagent).toBe(true)
  })

  test("garbage stdin yields empty payload", () => {
    const p = decodeRebriefPayload("not json")
    expect(p.sessionId).toBe("")
    expect(p.isSubagent).toBe(false)
  })
})

describe("resolveRebriefPrompt", () => {
  test("--ask wins over hook and stored prompts", () => {
    expect(resolveRebriefPrompt({ ask: " refined ", hookPrompt: "hook", storedPrompt: "stored" })).toBe("refined")
    expect(resolveRebriefPrompt({ ask: "", hookPrompt: "hook", storedPrompt: "stored" })).toBe("hook")
    expect(resolveRebriefPrompt({ ask: "", hookPrompt: "", storedPrompt: "stored" })).toBe("stored")
    expect(resolveRebriefPrompt({})).toBe("")
  })
})

describe("gh-rebrief skill", () => {
  test("frontmatter: user-only (model cannot self-invoke)", () => {
    expect(REBRIEF_SKILL.name).toBe("gh-rebrief")
    expect(REBRIEF_SKILL.md).toContain("name: gh-rebrief")
    expect(REBRIEF_SKILL.md).toContain("user-invocable: true")
    expect(REBRIEF_SKILL.md).toContain("disable-model-invocation: true")
  })

  test("description is concise, third-person, triggerable", () => {
    const fm = REBRIEF_SKILL.md.split("---")[1] ?? ""
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1] ?? ""
    expect(desc.length).toBeGreaterThan(0)
    expect(desc.length).toBeLessThanOrEqual(1024)
    expect(desc).not.toMatch(/^(?:I|You)\s/)
    expect(desc).toMatch(/use when|when/i)
  })

  test("body matches the launch search backend (repo convention)", () => {
    const lexical = buildRebriefSkill(false, false).md
    expect(lexical).toContain("lexical code search only")
    const semantic = buildRebriefSkill(true, false).md
    expect(semantic).toContain("lexical + semantic")
    const bluebird = buildRebriefSkill(false, true).md
    expect(bluebird).toContain("Bluebird")
  })

  test("cheapest launch materializes rebrief without --swe", () => {
    const skills = injectedSkillsForLaunch({
      profileId: "cheapest",
      workerSkillsActive: false,
      firstMateEnabled: false,
    })
    expect(skills.map((s) => s.name)).toEqual(["gh-rebrief"])
  })

  test("cheapest launch with --swe keeps pipeline + rebrief", () => {
    const skills = injectedSkillsForLaunch({
      profileId: "cheapest",
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    })
    expect(skills.map((s) => s.name)).toContain("gh-rebrief")
    expect(skills.map((s) => s.name)).toContain("gh-gather-context")
  })

  test("other pinned profiles without --swe still get nothing", () => {
    for (const profileId of ["fast", "cheap", "cheap1m", "balanced"] as const) {
      expect(injectedSkillsForLaunch({
        profileId,
        workerSkillsActive: false,
        firstMateEnabled: false,
      })).toEqual([])
    }
  })
})

describe("sessionContext (rebrief excerpt in Sol pack)", () => {
  test("absent on the first-prompt path (backward compatible)", () => {
    const pack = buildStaticContextPack({
      prompt: "Fix auth",
      agentsMd: "",
      claudeMd: "",
      repoStructure: "",
      verifyCommand: "",
      searchContext: "",
    })
    expect(pack).not.toContain("SESSION CONTEXT")
  })

  test("rendered as untrusted grounding signal when present, user request first", () => {
    const pack = buildStaticContextPack({
      prompt: "Fix auth",
      agentsMd: "",
      claudeMd: "",
      repoStructure: "",
      verifyCommand: "",
      searchContext: "",
      sessionContext: "Recent transcript excerpt",
    })
    expect(pack.indexOf("USER REQUEST:")).toBe(0)
    expect(pack).toContain("SESSION CONTEXT")
    expect(pack).toContain("untrusted data")
    expect(pack).toContain("Recent transcript excerpt")
  })

  test("system prompt scopes SESSION CONTEXT as untrusted only on the rebrief path (Sol rewrite builder)", () => {
    const firstPrompt = buildSolRewriteSystem({ searchEnabled: true, bluebirdEnabled: false, turnBudget: 3 })
    expect(firstPrompt).not.toContain("SESSION CONTEXT")
    const rebrief = buildSolRewriteSystem({
      searchEnabled: true,
      bluebirdEnabled: false,
      turnBudget: 3,
      hasSessionContext: true,
    })
    expect(rebrief).toContain("SESSION CONTEXT")
    expect(rebrief).toContain("untrusted transcript data")
    expect(rebrief).toContain("USER REQUEST")
  })

  test("rebrief system prompt is an XML-structured framing advisor and scopes untrusted data", () => {
    const sys = buildRebriefSystem({ searchEnabled: true, bluebirdEnabled: false, turnBudget: 3, hasSessionContext: true })
    expect(sys).toContain("<course_correction>")
    expect(sys).toContain("<next_action>")
    expect(sys).toContain("untrusted data")
    expect(sys).toContain("AUTHORITATIVE")
    expect(sys.toLowerCase()).toContain("never invent")
    expect(sys).toContain(DEEP_GROUNDING_FLAG)
  })
})
