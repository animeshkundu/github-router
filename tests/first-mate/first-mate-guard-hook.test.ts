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
  test("injects a PreToolUse hook scoped to Bash and local delegation tools", async () => {
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
    // The matcher scopes it to local worker/orchestrate tools + Bash (B1), not file-authoring tools.
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("Edit")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("Write")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("NotebookEdit")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("mcp__workers__")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("mcp__orchestrate__")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("Bash")
    // Round-trips to disk as valid JSON.
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>
    expect(onDisk.hooks).toBeDefined()
  })
})

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const MAIN = path.join(REPO_ROOT, "src/main.ts")

/** Run the guard subcommand with a PreToolUse payload; resolve its exit code. */
async function runGuard(payload: string): Promise<number> {
  const proc = Bun.spawn(["bun", MAIN, "internal-first-mate-guard"], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(payload),
    stdout: "ignore",
    stderr: "ignore",
  })
  return proc.exited
}

/** Run the guard and capture stdout (for the allow+additionalContext path). */
async function runGuardCapture(payload: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", MAIN, "internal-first-mate-guard"], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, stdout }
}

describe("capability-shaping PreToolUse hook (end-to-end enforcement)", () => {
  test("allows Write, blocks a mutating Bash, allows read-only Bash", async () => {
    // exit 2 = block; exit 0 = allow (Claude Code hook convention).
    expect(await runGuard(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x" } }))).toBe(0)
    expect(
      await runGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo x > f" } })),
    ).toBe(2)
    expect(
      await runGuard(JSON.stringify({ tool_name: "mcp__workers__implement", tool_input: {} })),
    ).toBe(2)
    expect(
      await runGuard(JSON.stringify({ tool_name: "mcp__orchestrate__run_workflow", tool_input: {} })),
    ).toBe(2)
    expect(
      await runGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr view 42" } })),
    ).toBe(0)
  }, 20_000)

  test("fails CLOSED on an unparseable payload", async () => {
    expect(await runGuard("not json{")).toBe(2)
  }, 20_000)

  test("#11: allows read-only control-flow with a PreToolUse additionalContext reminder", async () => {
    const { code, stdout } = await runGuardCapture(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "for f in a b; do gh pr view $f; done" } }),
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; additionalContext?: string }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse")
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("control-flow")
  }, 20_000)

  test("#11: blocks control-flow that hides a write (exec-escape floor)", async () => {
    expect(
      await runGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: 'for f in *; do rm "$f"; done' } })),
    ).toBe(2)
    // A plain read-only allow still emits NO stdout (only the reminder path does).
    const { code, stdout } = await runGuardCapture(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr view 42" } }),
    )
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("")
  }, 20_000)
})
