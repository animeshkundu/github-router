import { describe, expect, test } from "bun:test"

import { buildLaunchCommand, type LaunchTarget } from "../src/lib/launch"

function claudeTarget(extraArgs: string[]): LaunchTarget {
  return { kind: "claude-code", envVars: {}, extraArgs }
}

// F10: github-router's claude launcher must not force --dangerously-skip-permissions
// when the caller already requested an explicit --permission-mode (ai-or-die's
// claude-bridge appends one for a fleet create_session with permissionMode). The
// flags conflict, and the explicit mode must win.
describe("buildLaunchCommand F10 permission-mode handling", () => {
  test("adds --dangerously-skip-permissions when no --permission-mode is requested", () => {
    const { cmd } = buildLaunchCommand(claudeTarget([]))
    expect(cmd).toContain("--dangerously-skip-permissions")
  })

  test("drops --dangerously-skip-permissions when --permission-mode is present (two-token form)", () => {
    const { cmd } = buildLaunchCommand(claudeTarget(["--permission-mode", "plan"]))
    expect(cmd).not.toContain("--dangerously-skip-permissions")
    expect(cmd).toContain("--permission-mode")
    expect(cmd).toContain("plan")
  })

  test("drops --dangerously-skip-permissions when --permission-mode uses the =value form", () => {
    const { cmd } = buildLaunchCommand(claudeTarget(["--permission-mode=acceptEdits"]))
    expect(cmd).not.toContain("--dangerously-skip-permissions")
    expect(cmd).toContain("--permission-mode=acceptEdits")
  })

  test("a codex target is unaffected by the permission-mode logic", () => {
    const { cmd } = buildLaunchCommand({ kind: "codex", envVars: {}, extraArgs: [] })
    expect(cmd).not.toContain("--dangerously-skip-permissions")
    expect(cmd[cmd.length - 1] === "--dangerously-skip-permissions").toBe(false)
  })
})
