import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  FIRST_MATE_GUARD_MATCHER,
  buildFirstMateGuardHookCommand,
} from "~/internal-first-mate-guard"
import { injectStopHookIntoSettingsFile } from "~/lib/orchestration/stop-gate-hook"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-guard-hook-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("capability-shaping PreToolUse hook wiring (config assertion)", () => {
  test("injects a PreToolUse hook scoped to the denied tools", async () => {
    const settingsPath = path.join(dir, "settings.json")
    const command = buildFirstMateGuardHookCommand("/usr/bin/bun", "/app/main.ts")
    const merged = await injectStopHookIntoSettingsFile(
      settingsPath,
      command,
      "PreToolUse",
      undefined,
      FIRST_MATE_GUARD_MATCHER,
    )
    const serialized = JSON.stringify(merged)
    expect(serialized).toContain("PreToolUse")
    expect(serialized).toContain("internal-first-mate-guard")
    expect(serialized).toContain("mcp__workers__")
    // The matcher scopes it to the authoring/worker tools only.
    expect(FIRST_MATE_GUARD_MATCHER).toContain("Edit")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("Write")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("mcp__workers__")
    // Round-trips to disk as valid JSON.
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>
    expect(onDisk.hooks).toBeDefined()
  })
})
