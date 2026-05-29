/**
 * Tests for `src/lib/worker-agent/bash.ts`.
 *
 * Covers the load-bearing guarantees from the plan:
 *   - timeout fires + reports `timedOut: true`
 *   - 1 MiB per-stream output cap with truncation marker
 *   - abort signal kills the child (POSIX: within 2 s of the SIGKILL
 *     escalation)
 *   - strict env allowlist: secrets in the parent env are NOT visible
 *     to the spawned shell
 *   - POSIX process-group kill: grandchildren spawned by `bash -c
 *     "sleep & wait"` are reaped (verified via `pgrep`)
 *
 * Platform coverage: POSIX tests (`bash -c`) and Windows tests
 * (`cmd.exe /d /s /c`) each have dedicated describe blocks. POSIX-
 * only details (process groups, /bin/bash) are guarded by
 * `if (IS_WINDOWS) return`; Windows-only tests (cmd.exe exit codes,
 * taskkill tree-kill, env allowlist via `%VAR%` syntax) are guarded
 * by `if (!IS_WINDOWS) return`. Both code paths are load-bearing —
 * see CLAUDE.md "Windows-first CI" for the primary-target policy.
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` ("Bash hardening").
 */

import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { runBash } from "../src/lib/worker-agent/bash"

const IS_WINDOWS = process.platform === "win32"

function freshWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wa-bash-"))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

describe("runBash happy path", () => {
  test("captures stdout from echo", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const result = await runBash("echo hello-world", {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("hello-world")
      expect(result.timedOut).toBe(false)
      expect(result.killed).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("preserves non-zero exit code", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const result = await runBash("exit 42", {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      expect(result.exitCode).toBe(42)
      expect(result.timedOut).toBe(false)
      expect(result.killed).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe("runBash timeout", () => {
  test("fires after timeoutMs and reports timedOut: true", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const start = Date.now()
      const result = await runBash("sleep 5", {
        cwd: dir,
        timeoutMs: 100,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      const elapsed = Date.now() - start
      expect(result.timedOut).toBe(true)
      // Allow generous slack for the SIGKILL escalation + cleanup.
      expect(elapsed).toBeLessThan(5000)
      // exit code is the signal mapping (128+) or whatever the
      // shell reported on termination — definitely not 0.
      expect(result.exitCode).not.toBe(0)
    } finally {
      cleanup()
    }
  })
})

describe("runBash output cap", () => {
  test("truncates stdout at 1 MiB and appends marker", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      // Produce ~2 MiB of output via `yes` truncated by `head`.
      // Each `yes` line is "y\n" = 2 bytes; 2 MiB = 1,048,576 lines.
      const result = await runBash(
        "yes | head -c 2097152",
        {
          cwd: dir,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          disableNetwork: false,
        },
      )
      expect(result.stdout).toContain("[bash: stdout truncated at 1MB]")
      // Captured body should not exceed 1 MiB + marker bytes by much.
      expect(result.stdout.length).toBeLessThan(1024 * 1024 + 256)
    } finally {
      cleanup()
    }
  })
})

describe("runBash abort signal", () => {
  test("aborted signal kills the child and reports killed: true", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const controller = new AbortController()
    try {
      const start = Date.now()
      const pending = runBash("sleep 30", {
        cwd: dir,
        timeoutMs: 60_000,
        signal: controller.signal,
        disableNetwork: false,
      })
      // Give spawn a moment to actually start.
      setTimeout(() => controller.abort(), 50)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result.killed).toBe(true)
      // Must wrap up well within the SIGKILL grace + slack.
      expect(elapsed).toBeLessThan(5000)
    } finally {
      cleanup()
    }
  })
})

describe("runBash env allowlist", () => {
  test("does NOT leak secret-like parent env vars to the shell", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const SECRET = "super-secret-token-DO-NOT-LEAK"
    const previous = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = SECRET
    try {
      const result = await runBash('printf "%s" "$GITHUB_TOKEN"', {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      expect(result.exitCode).toBe(0)
      // The variable should be unset from the child's perspective,
      // which makes "$GITHUB_TOKEN" expand to the empty string.
      expect(result.stdout).toBe("")
      // Defense-in-depth: ensure the literal secret never appears.
      expect(result.stdout).not.toContain(SECRET)
      expect(result.stderr).not.toContain(SECRET)
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previous
      cleanup()
    }
  })

  test("preserves PATH so common executables resolve", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const result = await runBash('command -v git >/dev/null && echo OK', {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("OK")
    } finally {
      cleanup()
    }
  })
})

describe("runBash process-group kill (POSIX)", () => {
  test("descendant sleep is reaped when abort fires", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const controller = new AbortController()
    // Use a clearly-recognizable sleep duration so pgrep can find it
    // without false-positives on system sleeps.
    const MARKER = 3373
    try {
      const pending = runBash(
        `sleep ${MARKER} & echo "started=$!"; wait`,
        {
          cwd: dir,
          timeoutMs: 30_000,
          signal: controller.signal,
          disableNetwork: false,
        },
      )
      // Give the shell time to spawn the grandchild sleep.
      await new Promise((r) => setTimeout(r, 200))
      // Confirm the sleep actually exists before we kill.
      let preKillFound = false
      try {
        const pgrepOut = execSync(`pgrep -fl 'sleep ${MARKER}'`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
        preKillFound = pgrepOut.includes(String(MARKER))
      } catch {
        // pgrep returns non-zero when no match — test setup
        // mismatch, but don't fail the test for environment issues
      }
      // Skip silently if the test environment couldn't even
      // observe the grandchild (e.g. pgrep absent, race) — the kill
      // assertion would be vacuous in that case.
      if (!preKillFound) return

      controller.abort()
      await pending

      // Allow the SIGTERM → SIGKILL escalation to finish.
      await new Promise((r) => setTimeout(r, 2500))

      let stillRunning = true
      try {
        execSync(`pgrep -f 'sleep ${MARKER}'`, {
          stdio: ["ignore", "pipe", "ignore"],
        })
      } catch {
        // pgrep exit 1 = no matches, which is what we want.
        stillRunning = false
      }
      expect(stillRunning).toBe(false)
    } finally {
      cleanup()
    }
  }, 30_000)
})

describe("runBash stdin", () => {
  test("stdin is ignored", async () => {
    if (IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      // `cat` with stdin: 'ignore' should see EOF immediately and exit.
      const start = Date.now()
      const result = await runBash("cat", {
        cwd: dir,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      const elapsed = Date.now() - start
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
      expect(elapsed).toBeLessThan(3000)
    } finally {
      cleanup()
    }
  })
})

describe("runBash disableNetwork param", () => {
  test("accepts the flag but does NOT enforce it (caller's job)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      // The flag is accepted for symmetry; we explicitly do NOT
      // block the command at this layer — verify with `echo` since
      // it cannot make network calls and the assertion is about the
      // flag being a no-op pass-through, not enforcement.
      const result = await runBash("echo would-be-net", {
        cwd: dir,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        disableNetwork: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("would-be-net")
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Windows cmd.exe code-path coverage
// ---------------------------------------------------------------------------
// The POSIX tests above use `bash -c` and POSIX utilities (sleep, yes,
// pgrep). The tests below verify the `cmd.exe /d /s /c` code path that
// runBash takes on Windows. Each test is the cmd.exe equivalent of a
// POSIX test above; both paths are load-bearing per CLAUDE.md
// "Windows-first CI".
// ---------------------------------------------------------------------------

describe("runBash (Windows cmd.exe)", () => {
  test("preserves non-zero exit code via exit /b", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const result = await runBash("exit /b 42", {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      expect(result.exitCode).toBe(42)
      expect(result.timedOut).toBe(false)
      expect(result.killed).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("timeout fires and reports timedOut: true", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const start = Date.now()
      // `ping -n 6 127.0.0.1` blocks for ~5 seconds on Windows.
      const result = await runBash("ping -n 6 127.0.0.1 >NUL", {
        cwd: dir,
        timeoutMs: 100,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      const elapsed = Date.now() - start
      expect(result.timedOut).toBe(true)
      // taskkill /T /F should terminate promptly.
      expect(elapsed).toBeLessThan(5000)
      expect(result.exitCode).not.toBe(0)
    } finally {
      cleanup()
    }
  })

  test("truncates stdout at 1 MiB and appends marker", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      // Produce ~2 MiB of output via a cmd.exe for-loop. Each
      // iteration prints a 99-char line + \r\n = 101 bytes;
      // 20500 iterations ≈ 2.07 MB, well over the 1 MiB cap.
      const result = await runBash(
        "for /L %i in (1,1,20500) do @echo " +
          "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" +
          "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
        {
          cwd: dir,
          timeoutMs: 60_000,
          signal: new AbortController().signal,
          disableNetwork: false,
        },
      )
      expect(result.stdout).toContain("[bash: stdout truncated at 1MB]")
      // Captured body should not exceed 1 MiB + marker bytes by much.
      expect(result.stdout.length).toBeLessThan(1024 * 1024 + 256)
    } finally {
      cleanup()
    }
  })

  test("abort signal kills the child and reports killed: true", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const controller = new AbortController()
    try {
      const start = Date.now()
      // `ping -n 31` blocks for ~30 seconds.
      const pending = runBash("ping -n 31 127.0.0.1 >NUL", {
        cwd: dir,
        timeoutMs: 60_000,
        signal: controller.signal,
        disableNetwork: false,
      })
      // Give spawn a moment to actually start.
      setTimeout(() => controller.abort(), 50)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result.killed).toBe(true)
      // taskkill /T /F should terminate the tree promptly.
      expect(elapsed).toBeLessThan(5000)
    } finally {
      cleanup()
    }
  })

  test("does NOT leak secret-like parent env vars to cmd.exe", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const SECRET = "super-secret-token-DO-NOT-LEAK"
    const previous = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = SECRET
    try {
      // cmd.exe: `if defined VAR (echo LEAK) else (echo EMPTY)`
      const result = await runBash(
        'if defined GITHUB_TOKEN (echo LEAK:%GITHUB_TOKEN%) else (echo EMPTY)',
        {
          cwd: dir,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          disableNetwork: false,
        },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("EMPTY")
      // Defense-in-depth: ensure the literal secret never appears.
      expect(result.stdout).not.toContain(SECRET)
      expect(result.stderr).not.toContain(SECRET)
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previous
      cleanup()
    }
  })

  test("preserves PATH so common executables resolve", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      const result = await runBash(
        "where git >NUL 2>&1 && echo OK || echo MISSING",
        {
          cwd: dir,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          disableNetwork: false,
        },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("OK")
    } finally {
      cleanup()
    }
  })

  test("taskkill /T /F terminates child tree on abort", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    const controller = new AbortController()
    try {
      const start = Date.now()
      // Long-running ping spawns a child process tree.
      const pending = runBash("ping -n 9999 127.0.0.1 >NUL", {
        cwd: dir,
        timeoutMs: 60_000,
        signal: controller.signal,
        disableNetwork: false,
      })
      // Give the child time to start, then abort.
      setTimeout(() => controller.abort(), 200)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result.killed).toBe(true)
      // The whole thing must wrap up well within 5 seconds —
      // if taskkill /T /F didn't work, ping would hang for ~9999s.
      expect(elapsed).toBeLessThan(5000)
    } finally {
      cleanup()
    }
  })

  test("stdin is ignored (findstr exits on empty stdin)", async () => {
    if (!IS_WINDOWS) return
    const { dir, cleanup } = freshWorkspace()
    try {
      // `findstr "."` reads stdin; with stdin: 'ignore' it sees EOF
      // immediately and exits with code 1 (no match on empty input).
      const start = Date.now()
      const result = await runBash('findstr "."', {
        cwd: dir,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        disableNetwork: false,
      })
      const elapsed = Date.now() - start
      // findstr exit 1 = no match (expected with empty stdin).
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      // Must not hang waiting for input — should complete in well
      // under 3 seconds.
      expect(elapsed).toBeLessThan(3000)
    } finally {
      cleanup()
    }
  })
})
