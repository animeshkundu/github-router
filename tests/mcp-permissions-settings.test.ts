import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  configureServePermissionsBypass,
  injectMcpServerAllowRules,
  sanitizeServeSettingsEnv,
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

describe("configureServePermissionsBypass", () => {
  it("sets defaultMode=bypassPermissions and clears allow on a fresh file", async () => {
    const p = await settingsFile()
    const r = await configureServePermissionsBypass(p)
    expect(r.written).toBe(true)
    expect((await read(p)).permissions).toEqual({ defaultMode: "bypassPermissions", allow: [] })
  })

  it("clears a mirrored restrictive allow-list (so CloudCLI gets an empty allowedTools) and overrides 'plan'", async () => {
    const p = await settingsFile({
      permissions: {
        allow: ["Read(*)", "Glob(*)", "Bash(ls *)", "mcp__peers"],
        deny: ["Bash(rm *)"],
        ask: ["WebFetch"],
        defaultMode: "plan",
      },
      other: 1,
    })
    const r = await configureServePermissionsBypass(p)
    expect(r.written).toBe(true)
    expect(r.clearedAllow).toBe(4)
    const j = await read(p)
    const perms = j.permissions as Record<string, unknown>
    expect(perms.defaultMode).toBe("bypassPermissions")
    expect(perms.allow).toEqual([])
    // deny/ask and unrelated keys preserved
    expect(perms.deny).toEqual(["Bash(rm *)"])
    expect(perms.ask).toEqual(["WebFetch"])
    expect(j.other).toBe(1)
  })

  it("is a no-op when already bypass with an empty allow", async () => {
    const p = await settingsFile({ permissions: { defaultMode: "bypassPermissions", allow: [] } })
    const r = await configureServePermissionsBypass(p)
    expect(r.written).toBe(false)
  })

  it("refuses to overwrite a non-object settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
    tmps.push(dir)
    const p = path.join(dir, "settings.json")
    await fs.writeFile(p, "[1,2,3]", "utf8")
    await expect(configureServePermissionsBypass(p)).rejects.toThrow(/not a JSON object/)
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

describe("injectMcpServerAllowRules", () => {
  it("adds bare mcp__<server> allow rules for each resolved key on a fresh file", async () => {
    const p = await settingsFile()
    const r = await injectMcpServerAllowRules(p, ["peers", "search", "workers", "orchestrate", "decide"])
    expect(r.added).toEqual([
      "mcp__peers", "mcp__search", "mcp__workers", "mcp__orchestrate", "mcp__decide",
    ])
    expect((await read(p)).permissions).toEqual({
      allow: ["mcp__peers", "mcp__search", "mcp__workers", "mcp__orchestrate", "mcp__decide"],
    })
  })

  it("uses collision-resolved keys (gh-router-*) and preserves existing allow/deny/ask", async () => {
    const p = await settingsFile({
      permissions: { allow: ["Read", "WebSearch"], deny: ["Bash(rm *)"], defaultMode: "plan" },
    })
    const r = await injectMcpServerAllowRules(p, ["gh-router-peers", "search"])
    expect(r.added).toEqual(["mcp__gh-router-peers", "mcp__search"])
    const perms = (await read(p)).permissions as Record<string, unknown>
    expect(perms.allow).toEqual(["Read", "WebSearch", "mcp__gh-router-peers", "mcp__search"])
    expect(perms.deny).toEqual(["Bash(rm *)"])
    expect(perms.defaultMode).toBe("plan")
  })

  it("is idempotent (no write, no duplicates) when rules already present", async () => {
    const p = await settingsFile({ permissions: { allow: ["mcp__peers", "mcp__search"] } })
    const before = await fs.stat(p)
    const r = await injectMcpServerAllowRules(p, ["peers", "search"])
    expect(r.added).toEqual([])
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs)
  })

  it("dedupes and skips falsy keys", async () => {
    const p = await settingsFile()
    const r = await injectMcpServerAllowRules(p, ["peers", "peers", "", "search"])
    expect(r.added).toEqual(["mcp__peers", "mcp__search"])
  })

  it("is a no-op for an empty key list", async () => {
    const p = await settingsFile({ permissions: { allow: ["Read"] } })
    const before = await fs.stat(p)
    expect((await injectMcpServerAllowRules(p, [])).added).toEqual([])
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs)
  })
})
