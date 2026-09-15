import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Pinned profiles (fast/cheap/cheap1m/cheapest) run router-provided
 * surfaces only: user-supplied subagent `.md` files must not reach the
 * Task enum, and user-supplied hooks for router-guarded events must not
 * survive in the disposable per-launch mirror. The operator's real
 * `~/.claude/` is never touched — both purges are mirror-scoped.
 */

// Same homedir-mock pattern as tests/isolated/lib-paths.test.ts so
// PATHS.CLAUDE_CONFIG_DIR resolves under a temp dir.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-purge-"))
const { mock } = await import("bun:test")
mock.module("node:os", () => {
  const real = os
  return {
    default: { ...real, homedir: () => tempHome },
    ...real,
    homedir: () => tempHome,
  }
})

const { PATHS, purgeNonRouterAgentsFromMirror } = await import("~/lib/paths")
const { purgeNonRouterHooksForPinnedProfile } = await import(
  "~/lib/orchestration/stop-gate-hook"
)

describe("purgeNonRouterAgentsFromMirror", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(PATHS.CLAUDE_CONFIG_DIR, "agents"), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  })

  test("removes user .md files, keeps router-shaped peer files", async () => {
    const dir = path.join(PATHS.CLAUDE_CONFIG_DIR, "agents")
    // Router-shaped (PID may be dead or alive — shape alone protects it).
    await fs.writeFile(path.join(dir, `peer-${process.pid}-abcdef12-Explore.md`), "router")
    await fs.writeFile(path.join(dir, "my-custom-agent.md"), "user")
    await fs.writeFile(path.join(dir, "notes.md"), "user")
    await fs.writeFile(path.join(dir, "helper.txt"), "not-md")
    const removed = await purgeNonRouterAgentsFromMirror()
    expect(removed).toBe(2)
    const remaining = (await fs.readdir(dir)).sort()
    expect(remaining).toEqual(["helper.txt", `peer-${process.pid}-abcdef12-Explore.md`])
  })

  test("missing agents dir resolves to zero", async () => {
    await fs.rm(path.join(PATHS.CLAUDE_CONFIG_DIR, "agents"), { recursive: true, force: true })
    expect(await purgeNonRouterAgentsFromMirror()).toBe(0)
  })
})

describe("purgeNonRouterHooksForPinnedProfile", () => {
  let dir: string
  let settingsPath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-hook-purge-"))
    settingsPath = path.join(dir, "settings.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("strips guarded hooks, preserves everything else", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
          PreToolUse: [
            { matcher: "^(Task|Agent)$", hooks: [{ type: "command", command: "user-guard" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "user-edit-guard" }] },
          ],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-submit" }] }],
          PostToolUse: [
            { matcher: "ExitPlanMode", hooks: [{ type: "command", command: "user-review" }] },
            { matcher: "Write", hooks: [{ type: "command", command: "user-write-note" }] },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "user-bind" }] }],
        },
      }),
    )
    const { removed } = await purgeNonRouterHooksForPinnedProfile(settingsPath)
    expect(removed).toBe(4)
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>
    expect(settings.model).toBe("opus")
    expect(settings.hooks).toEqual({
      PreToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "user-edit-guard" }] },
      ],
      PostToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "user-write-note" }] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: "user-bind" }] }],
    })
  })

  test("no guarded hooks means no write", async () => {
    const content = JSON.stringify({ hooks: { SessionStart: [] } })
    await fs.writeFile(settingsPath, content)
    expect(await purgeNonRouterHooksForPinnedProfile(settingsPath)).toEqual({ removed: 0 })
    expect(await fs.readFile(settingsPath, "utf8")).toBe(content)
  })

  test("missing file resolves to zero", async () => {
    expect(
      await purgeNonRouterHooksForPinnedProfile(path.join(dir, "absent.json")),
    ).toEqual({ removed: 0 })
  })
})
