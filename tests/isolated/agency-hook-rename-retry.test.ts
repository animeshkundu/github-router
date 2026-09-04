import { afterEach, describe, expect, mock, test } from "bun:test"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

const realRename = fsSync.promises.rename.bind(fsSync.promises)
let failuresRemaining = 0
let renameAttempts = 0

async function stubbedRename(from: fsSync.PathLike, to: fsSync.PathLike): Promise<void> {
  renameAttempts += 1
  if (failuresRemaining > 0) {
    failuresRemaining -= 1
    const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException
    error.code = "EPERM"
    throw error
  }
  await realRename(from, to)
}

mock.module("node:fs/promises", () => {
  const patched = { ...fsSync.promises, rename: stubbedRename }
  return { ...patched, default: patched }
})

const { sanitizeAgencyHooksInSettingsFile } = await import(
  "~/lib/agency-hook-settings"
)

const dirs: string[] = []

const HTTP_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "Notification",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "TeammateIdle",
  "TaskCompleted",
  "SessionEnd",
]

function agencySettings(): Record<string, unknown> {
  const url = "http://127.0.0.1:7824/hook/a4617907-0b9e-4bcf-b4ef-b10d7c5a31be"
  const hooks: Record<string, unknown[]> = {}
  for (const event of HTTP_EVENTS) {
    hooks[event] = [{
      matcher: "*",
      hooks: [{
        type: "http",
        url,
        timeout: event === "PermissionRequest" ? 1800 : 10,
      }],
    }]
  }
  return { hooks }
}

async function target(): Promise<string> {
  const dir = await fsSync.promises.mkdtemp(path.join(os.tmpdir(), "agency-retry-"))
  dirs.push(dir)
  const settingsPath = path.join(dir, "settings.json")
  await fsSync.promises.writeFile(settingsPath, JSON.stringify(agencySettings()))
  return settingsPath
}

afterEach(async () => {
  failuresRemaining = 0
  renameAttempts = 0
  for (;;) {
    const dir = dirs.pop()
    if (!dir) break
    await fsSync.promises.rm(dir, { recursive: true, force: true })
  }
})

describe("Agency hook settings rename retries", () => {
  test("recovers from transient Windows EPERM contention", async () => {
    const settingsPath = await target()
    failuresRemaining = 2

    await sanitizeAgencyHooksInSettingsFile(settingsPath)

    expect(renameAttempts).toBe(3)
    const settings = JSON.parse(await fsSync.promises.readFile(settingsPath, "utf8"))
    expect(settings.hooks.PreToolUse).toEqual([])
  })

  test("persistent contention is bounded and leaves no temporary file", async () => {
    const settingsPath = await target()
    failuresRemaining = Number.MAX_SAFE_INTEGER

    await expect(sanitizeAgencyHooksInSettingsFile(settingsPath)).rejects.toThrow(/EPERM/)
    expect(renameAttempts).toBe(4)
    const leftovers = (await fsSync.promises.readdir(path.dirname(settingsPath)))
      .filter((name) => name.includes(".agency.tmp"))
    expect(leftovers).toEqual([])
  })

  test("mirror provisioning propagates persistent sanitizer write failure", async () => {
    const settingsPath = await target()
    failuresRemaining = Number.MAX_SAFE_INTEGER

    // The sanitizer's caller must fail the launch rather than leave a known
    // Agency cohort in the mirror to become a 404 storm after nonce rotation.
    await expect(sanitizeAgencyHooksInSettingsFile(settingsPath)).rejects.toThrow(/EPERM/)
    const unchanged = JSON.parse(await fsSync.promises.readFile(settingsPath, "utf8"))
    expect(unchanged.hooks.PreToolUse).toHaveLength(1)
  })
})
