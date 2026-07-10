import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { injectMcpPermissionsIntoSettingsFile } from "~/lib/mcp-permissions-settings"

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

describe("injectMcpPermissionsIntoSettingsFile", () => {
  it("creates permissions.allow with mcp__<key> entries on a fresh (missing) file", async () => {
    const p = await settingsFile()
    const r = await injectMcpPermissionsIntoSettingsFile(p, ["peers", "search", "workers"])
    expect(r.written).toBe(true)
    const j = await read(p)
    expect((j.permissions as { allow: string[] }).allow).toEqual([
      "mcp__peers",
      "mcp__search",
      "mcp__workers",
    ])
  })

  it("merges into an existing allow (dedup) and never touches deny/ask", async () => {
    const p = await settingsFile({
      permissions: { allow: ["mcp__peers", "Bash(git*)"], deny: ["mcp__evil"], ask: ["WebFetch"] },
      other: 1,
    })
    const r = await injectMcpPermissionsIntoSettingsFile(p, ["peers", "search"])
    expect(r.added).toEqual(["mcp__search"])
    const j = await read(p)
    const perms = j.permissions as { allow: string[]; deny: string[]; ask: string[] }
    expect(perms.allow).toEqual(["mcp__peers", "Bash(git*)", "mcp__search"])
    expect(perms.deny).toEqual(["mcp__evil"])
    expect(perms.ask).toEqual(["WebFetch"])
    expect(j.other).toBe(1)
  })

  it("is a no-op when every entry is already present", async () => {
    const p = await settingsFile({ permissions: { allow: ["mcp__peers"] } })
    const r = await injectMcpPermissionsIntoSettingsFile(p, ["peers"])
    expect(r.written).toBe(false)
    expect(r.added).toEqual([])
  })

  it("does nothing for an empty key list", async () => {
    const p = await settingsFile()
    const r = await injectMcpPermissionsIntoSettingsFile(p, [])
    expect(r.written).toBe(false)
    // file was never created
    await expect(fs.access(p)).rejects.toThrow()
  })

  it("refuses to overwrite a non-object settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-mcpperm-"))
    tmps.push(dir)
    const p = path.join(dir, "settings.json")
    await fs.writeFile(p, "[1,2,3]", "utf8")
    await expect(injectMcpPermissionsIntoSettingsFile(p, ["peers"])).rejects.toThrow(/not a JSON object/)
  })

  it("bypass:true sets defaultMode=bypassPermissions and overrides a mirrored 'plan'", async () => {
    const p = await settingsFile({ permissions: { allow: ["Read(*)"], defaultMode: "plan" } })
    const r = await injectMcpPermissionsIntoSettingsFile(p, ["peers", "workers"], { bypass: true })
    expect(r.written).toBe(true)
    expect(r.bypass).toBe(true)
    const perms = (await read(p)).permissions as { allow: string[]; defaultMode: string }
    expect(perms.defaultMode).toBe("bypassPermissions")
    expect(perms.allow).toEqual(["Read(*)", "mcp__peers", "mcp__workers"])
  })

  it("bypass:true writes even with no server keys (just the mode)", async () => {
    const p = await settingsFile()
    const r = await injectMcpPermissionsIntoSettingsFile(p, [], { bypass: true })
    expect(r.written).toBe(true)
    expect((await read(p)).permissions).toEqual({ defaultMode: "bypassPermissions" })
  })

  it("bypass:true is a no-op when already bypass with all keys present", async () => {
    const p = await settingsFile({ permissions: { allow: ["mcp__peers"], defaultMode: "bypassPermissions" } })
    const r = await injectMcpPermissionsIntoSettingsFile(p, ["peers"], { bypass: true })
    expect(r.written).toBe(false)
  })
})
