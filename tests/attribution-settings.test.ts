import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { injectAttributionSuppressionIntoSettingsFile } from "~/lib/attribution-settings"

describe("injectAttributionSuppressionIntoSettingsFile", () => {
  let dir: string
  let settingsPath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-attr-"))
    settingsPath = path.join(dir, "settings.json")
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>

  test("creates settings.json with empty attribution when the file is missing", async () => {
    const r = await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    expect(r.written).toBe(true)
    expect(await read()).toEqual({ attribution: { commit: "", pr: "" } })
  })

  test("adds attribution to an existing file and preserves other keys", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ model: "opus", hooks: { Stop: [] } }, null, 2),
    )
    const r = await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    expect(r.written).toBe(true)
    const out = await read()
    expect(out.attribution).toEqual({ commit: "", pr: "" })
    // Untouched user keys survive the merge.
    expect(out.model).toBe("opus")
    expect(out.hooks).toEqual({ Stop: [] })
  })

  test("presence guard: an existing `attribution` is NOT overridden", async () => {
    const userAttr = { attribution: { commit: "mine", pr: "mine-pr" } }
    await fs.writeFile(settingsPath, JSON.stringify(userAttr, null, 2))
    const r = await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    expect(r).toEqual({ written: false, reason: "user-set" })
    // Byte-for-byte the user's value.
    expect((await read()).attribution).toEqual({ commit: "mine", pr: "mine-pr" })
  })

  test("presence guard: an existing (deprecated) `includeCoAuthoredBy` wins", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }, null, 2))
    const r = await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    expect(r).toEqual({ written: false, reason: "user-set" })
    const out = await read()
    expect(out.includeCoAuthoredBy).toBe(true)
    // We do NOT add a conflicting `attribution` alongside the user's choice.
    expect("attribution" in out).toBe(false)
  })

  test("refuses a non-object settings.json rather than clobbering it", async () => {
    await fs.writeFile(settingsPath, JSON.stringify(["not", "an", "object"]))
    await expect(
      injectAttributionSuppressionIntoSettingsFile(settingsPath),
    ).rejects.toThrow(/not a JSON object/)
    // The original content is untouched.
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual([
      "not",
      "an",
      "object",
    ])
  })

  test("leaves no temp file behind after a successful write", async () => {
    await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(["settings.json"])
  })

  test("second call on the already-suppressed file is a no-op (our value reads as set)", async () => {
    await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    const r = await injectAttributionSuppressionIntoSettingsFile(settingsPath)
    expect(r).toEqual({ written: false, reason: "user-set" })
    expect((await read()).attribution).toEqual({ commit: "", pr: "" })
  })
})
