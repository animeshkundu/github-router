import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { configureServePermissionsBypass } from "~/lib/mcp-permissions-settings"

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
