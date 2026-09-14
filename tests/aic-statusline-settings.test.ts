import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildAicStatusHookCommand,
  injectAicStatusLineIntoSettingsFile,
} from "~/lib/aic-statusline-settings"

const STATUS_COMMAND = "/stable/hooks.mjs internal-aic-status"

describe("injectAicStatusLineIntoSettingsFile", () => {
  let dir: string
  let settingsPath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-sl-"))
    settingsPath = path.join(dir, "settings.json")
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>

  test("creates settings.json with statusLine when the file is missing", async () => {
    const r = await injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND)
    expect(r).toEqual({ written: true, mode: "injected" })
    expect(await read()).toEqual({
      statusLine: { type: "command", command: STATUS_COMMAND },
    })
  })

  test("adds statusLine alongside existing keys", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ model: "opus" }, null, 2))
    const r = await injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND)
    expect(r).toEqual({ written: true, mode: "injected" })
    const out = await read()
    expect(out.model).toBe("opus")
    expect(out.statusLine).toEqual({ type: "command", command: STATUS_COMMAND })
  })

  test("wrap mode: preserves the user's command and reports it back", async () => {
    const userCommand = "/home/u/.claude/statusline.sh"
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: userCommand } }, null, 2),
    )
    const r = await injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND)
    expect(r).toEqual({ written: true, mode: "wrapped", userCommand })
    // Ours is installed; the user's survives via env, not in the file.
    expect(await read()).toEqual({
      statusLine: { type: "command", command: STATUS_COMMAND },
    })
  })

  test("idempotent: an existing internal-aic-status command is left alone", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: STATUS_COMMAND } }),
    )
    const r = await injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND)
    expect(r).toEqual({ written: false, reason: "already-set" })
  })

  test("unrecognized statusLine shapes are left untouched", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: "fancy", widget: true } }),
    )
    const r = await injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND)
    expect(r).toEqual({ written: false, reason: "unrecognized" })
    expect(await read()).toEqual({ statusLine: { type: "fancy", widget: true } })
  })

  test("refuses a non-object settings.json rather than clobbering it", async () => {
    await fs.writeFile(settingsPath, JSON.stringify(["nope"]))
    await expect(
      injectAicStatusLineIntoSettingsFile(settingsPath, STATUS_COMMAND),
    ).rejects.toThrow(/not a JSON object/)
  })
})

describe("buildAicStatusHookCommand", () => {
  test("composes the internal subcommand through the self invocation", () => {
    const cmd = buildAicStatusHookCommand({ execPath: "/bin/x", scriptPath: "/s/hooks.mjs" })
    expect(cmd).toContain("internal-aic-status")
    expect(cmd).toContain("/s/hooks.mjs")
  })
})
