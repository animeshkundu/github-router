import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  configureServeDefaultPermissionMode,
  injectAllowRules,
  NATIVE_RESEARCH_ALLOW_RULES,
  planModeAllowRules,
  sanitizeServeSettingsEnv,
  SEAMLESS_BUILTIN_TOOLS,
} from "~/lib/mcp-permissions-settings"

const tmps: string[] = []
afterEach(async () => {
  while (tmps.length) await fs.rm(tmps.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function settingsFile(initial?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
  tmps.push(dir)
  const p = path.join(dir, "settings.json")
  if (initial !== undefined) await fs.writeFile(p, JSON.stringify(initial), "utf8")
  return p
}

async function read(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

describe("configureServeDefaultPermissionMode", () => {
  it("sets defaultMode=default (NON-bypass) on a fresh file, leaving allow absent", async () => {
    const p = await settingsFile()
    const r = await configureServeDefaultPermissionMode(p)
    expect(r.written).toBe(true)
    expect((await read(p)).permissions).toEqual({ defaultMode: "default" })
  })

  it("PRESERVES the user's allow/deny/ask posture and only overrides defaultMode", async () => {
    const p = await settingsFile({
      permissions: {
        allow: ["Read(*)", "Glob(*)", "Bash(ls *)", "mcp__peers"],
        deny: ["Bash(rm *)"],
        ask: ["WebFetch"],
        defaultMode: "bypassPermissions",
      },
      other: 1,
    })
    const r = await configureServeDefaultPermissionMode(p)
    expect(r.written).toBe(true)
    const j = await read(p)
    const perms = j.permissions as Record<string, unknown>
    // a stale bypass is overridden to default so canUseTool stays live
    expect(perms.defaultMode).toBe("default")
    // the user's curated allow list is carried through UNCHANGED (no clearing)
    expect(perms.allow).toEqual(["Read(*)", "Glob(*)", "Bash(ls *)", "mcp__peers"])
    expect(perms.deny).toEqual(["Bash(rm *)"])
    expect(perms.ask).toEqual(["WebFetch"])
    expect(j.other).toBe(1)
  })

  it("is a no-op when already default (regardless of allow contents)", async () => {
    const p = await settingsFile({
      permissions: { defaultMode: "default", allow: ["Read", "Bash(git *)"] },
    })
    const r = await configureServeDefaultPermissionMode(p)
    expect(r.written).toBe(false)
    // allow untouched
    expect((await read(p)).permissions).toEqual({
      defaultMode: "default",
      allow: ["Read", "Bash(git *)"],
    })
  })

  it("PRESERVES an explicit non-bypass mode (plan / acceptEdits) — they keep canUseTool live", async () => {
    for (const mode of ["plan", "acceptEdits"]) {
      const p = await settingsFile({ permissions: { defaultMode: mode, allow: ["Read"] } })
      const r = await configureServeDefaultPermissionMode(p)
      expect(r.written).toBe(false)
      expect((await read(p)).permissions).toEqual({ defaultMode: mode, allow: ["Read"] })
    }
  })

  it("refuses to overwrite a non-object settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
    tmps.push(dir)
    const p = path.join(dir, "settings.json")
    await fs.writeFile(p, "[1,2,3]", "utf8")
    await expect(configureServeDefaultPermissionMode(p)).rejects.toThrow(/not a JSON object/)
  })
})

describe("SEAMLESS_BUILTIN_TOOLS", () => {
  const tools: string[] = [...SEAMLESS_BUILTIN_TOOLS]
  it("NEVER lists the two interaction tools (they must reach the user)", () => {
    expect(tools).not.toContain("AskUserQuestion")
    expect(tools).not.toContain("ExitPlanMode")
  })

  it("covers the routine coding surface", () => {
    for (const t of ["Read", "Bash", "Edit", "Write", "Task", "WebSearch"]) {
      expect(tools).toContain(t)
    }
  })
})

describe("sanitizeServeSettingsEnv", () => {
  it("strips CLAUDE_CODE_COORDINATOR_MODE from the env block, preserving the rest", async () => {
    const p = await settingsFile({
      env: {
        CLAUDE_CODE_COORDINATOR_MODE: "1",
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        SOME_OTHER: "x",
      },
      permissions: { defaultMode: "bypassPermissions" },
    })
    const r = await sanitizeServeSettingsEnv(p)
    expect(r.removed).toEqual(["CLAUDE_CODE_COORDINATOR_MODE"])
    const j = await read(p)
    // coordinator removed; agent-teams (additive) + unrelated keys preserved
    expect(j.env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", SOME_OTHER: "x" })
    expect((j.permissions as Record<string, unknown>).defaultMode).toBe("bypassPermissions")
  })

  it("strips auth/routing/remote/model keys that would re-route the serve agent off the proxy", async () => {
    const p = await settingsFile({
      env: {
        ANTHROPIC_BASE_URL: "https://my-gateway.example",
        ANTHROPIC_API_KEY: "sk-real",
        ANTHROPIC_AUTH_TOKEN: "tok",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        ANTHROPIC_MODEL: "some-non-copilot-slug",
        CLAUDE_CODE_SUBAGENT_MODEL: "override-all-subagents",
        CLAUDE_CODE_REMOTE: "1",
        SESSION_INGRESS_URL: "https://ingress",
        CLAUDE_CONFIG_DIR: "/somewhere/else",
        // kept: additive experimental flag + an unrelated app var
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        MY_APP_FLAG: "keep",
      },
    })
    const r = await sanitizeServeSettingsEnv(p)
    expect(r.removed).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_REMOTE", "SESSION_INGRESS_URL",
        "CLAUDE_CONFIG_DIR",
      ]),
    )
    // additive + unrelated keys survive
    expect((await read(p)).env).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      MY_APP_FLAG: "keep",
    })
  })

  it("is a no-op (no write) when coordinator mode is absent", async () => {
    const p = await settingsFile({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" } })
    const before = await fs.stat(p)
    const r = await sanitizeServeSettingsEnv(p)
    expect(r.removed).toEqual([])
    // file untouched (mtime unchanged — no rewrite)
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs)
  })

  it("is a no-op when there is no env block", async () => {
    const p = await settingsFile({ permissions: { defaultMode: "bypassPermissions" } })
    expect((await sanitizeServeSettingsEnv(p)).removed).toEqual([])
  })

  it("returns nothing for a missing (ENOENT) settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
    tmps.push(dir)
    expect((await sanitizeServeSettingsEnv(path.join(dir, "nope.json"))).removed).toEqual([])
  })

  it("refuses to overwrite a non-object settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
    tmps.push(dir)
    const p = path.join(dir, "settings.json")
    await fs.writeFile(p, '"a string"', "utf8")
    await expect(sanitizeServeSettingsEnv(p)).rejects.toThrow(/not a JSON object/)
  })
})

describe("planModeAllowRules", () => {
  it("builds bare mcp__<server> rules for each key plus the native research tools", () => {
    expect(planModeAllowRules(["peers", "search", "codex-cli"])).toEqual([
      "mcp__peers", "mcp__search", "mcp__codex-cli", "WebSearch", "WebFetch",
    ])
  })

  it("dedupes/skips falsy server keys; native tools always included", () => {
    expect(planModeAllowRules(["peers", "peers", ""])).toEqual([
      "mcp__peers", "WebSearch", "WebFetch",
    ])
    expect(planModeAllowRules([])).toEqual([...NATIVE_RESEARCH_ALLOW_RULES])
  })

  it("does NOT include mutating/delegation natives (Bash/Task/Edit/Write)", () => {
    const rules = planModeAllowRules(["peers"])
    for (const forbidden of ["Bash", "Task", "Skill", "Workflow", "Edit", "Write", "SendMessage"]) {
      expect(rules).not.toContain(forbidden)
    }
  })
})

describe("injectAllowRules", () => {
  it("adds the given rules to permissions.allow on a fresh file", async () => {
    const p = await settingsFile()
    const r = await injectAllowRules(p, ["mcp__peers", "mcp__search", "WebSearch", "WebFetch"])
    expect(r.added).toEqual(["mcp__peers", "mcp__search", "WebSearch", "WebFetch"])
    expect((await read(p)).permissions).toEqual({
      allow: ["mcp__peers", "mcp__search", "WebSearch", "WebFetch"],
    })
  })

  it("preserves existing allow/deny/ask and dedupes against what's present", async () => {
    const p = await settingsFile({
      permissions: { allow: ["Read", "WebSearch"], deny: ["Bash(rm *)"], defaultMode: "plan" },
    })
    const r = await injectAllowRules(p, planModeAllowRules(["gh-router-peers"]))
    // WebSearch already present → not re-added; WebFetch + mcp added
    expect(r.added).toEqual(["mcp__gh-router-peers", "WebFetch"])
    const perms = (await read(p)).permissions as Record<string, unknown>
    expect(perms.allow).toEqual(["Read", "WebSearch", "mcp__gh-router-peers", "WebFetch"])
    expect(perms.deny).toEqual(["Bash(rm *)"])
    expect(perms.defaultMode).toBe("plan")
  })

  it("is idempotent (no write, no duplicates) when rules already present", async () => {
    const p = await settingsFile({ permissions: { allow: ["mcp__peers", "WebSearch", "WebFetch"] } })
    const before = await fs.stat(p)
    const r = await injectAllowRules(p, ["mcp__peers", "WebSearch", "WebFetch"])
    expect(r.added).toEqual([])
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs)
  })

  it("is a no-op for an empty rule list", async () => {
    const p = await settingsFile({ permissions: { allow: ["Read"] } })
    const before = await fs.stat(p)
    expect((await injectAllowRules(p, [])).added).toEqual([])
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs)
  })
})
