import { beforeEach, describe, expect, mock, test } from "bun:test"

import {
  looksLikeUnknownUpdateCommand,
  updateClaude,
  type UpdateClaudeDeps,
} from "../src/lib/claude-version-check"

// Dependency injection (NOT mock.module) so this test can't pollute the
// process-global module registry that the isolated launch tests rely on.
function makeDeps(over: Partial<UpdateClaudeDeps> = {}): {
  deps: Partial<UpdateClaudeDeps>
  capture: ReturnType<typeof mock>
  voidRun: ReturnType<typeof mock>
} {
  const capture = mock()
  const voidRun = mock()
  const deps: Partial<UpdateClaudeDeps> = {
    resolveExecutable: ((name: string) =>
      name === "claude" ? "/abs/claude" : name === "npm" ? "/abs/npm" : null) as UpdateClaudeDeps["resolveExecutable"],
    runCommandCapture: capture as unknown as UpdateClaudeDeps["runCommandCapture"],
    runCommandVoid: voidRun as unknown as UpdateClaudeDeps["runCommandVoid"],
    withInstallLock: (async (_n: string, fn: () => Promise<void>) => {
      await fn()
      return true
    }) as UpdateClaudeDeps["withInstallLock"],
    ...over,
  }
  return { deps, capture, voidRun }
}

describe("looksLikeUnknownUpdateCommand", () => {
  test("matches unknown-command messages", () => {
    expect(looksLikeUnknownUpdateCommand("error: unknown command 'update'")).toBe(true)
    expect(looksLikeUnknownUpdateCommand("unrecognized subcommand 'update'")).toBe(true)
  })
  test("does NOT match normal `claude update` output (regression guard)", () => {
    expect(looksLikeUnknownUpdateCommand("Claude Code is up to date (2.1.165)")).toBe(false)
    expect(looksLikeUnknownUpdateCommand("Checking for updates to latest version...")).toBe(false)
  })
})

describe("updateClaude", () => {
  let d: ReturnType<typeof makeDeps>
  beforeEach(() => {
    d = makeDeps()
  })

  test("`claude update` exit 0 → success, NO npm fallback (fixes the dual-install false-negative)", async () => {
    d.capture.mockResolvedValue({
      code: 0,
      stdout: "Claude Code is up to date (2.1.165)",
      stderr: "",
    })
    await updateClaude("2.1.165", d.deps)

    expect(d.capture).toHaveBeenCalledTimes(1)
    expect(d.capture.mock.calls[0][0]).toEqual(["/abs/claude", "update"])
    expect(d.voidRun).not.toHaveBeenCalled()
  })

  test("unknown-command output → npm fallback", async () => {
    d.capture.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "error: unknown command 'update'",
    })
    d.voidRun.mockResolvedValue({ code: 0, stdout: "", stderr: "" })
    await updateClaude("2.1.165", d.deps)

    expect(d.voidRun).toHaveBeenCalledTimes(1)
    const cmd = d.voidRun.mock.calls[0][0] as string[]
    expect(cmd[0]).toBe("/abs/npm")
    expect(cmd).toContain("install")
    expect(cmd).toContain("-g")
  })

  test("a non-unknown-command failure throws and does NOT npm-fallback", async () => {
    d.capture.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "network error during update",
    })
    await expect(updateClaude("2.1.165", d.deps)).rejects.toThrow()
    expect(d.voidRun).not.toHaveBeenCalled()
  })
})
