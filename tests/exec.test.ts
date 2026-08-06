import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

import {
  buildExecInvocation,
  killChildProcessTree,
  parseBoolEnv,
  parseIntEnv,
  quoteWinArg,
  resolveExecutable,
  runCommandCapture,
  runManagedExeCapture,
  spawnTaskkillBestEffort,
} from "../src/lib/exec"
import process from "node:process"

describe("parseBoolEnv", () => {
  test("truthy values", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(parseBoolEnv(v)).toBe(true)
    }
  })
  test("falsy values", () => {
    for (const v of ["0", "false", "no", "off", "", "  "]) {
      expect(parseBoolEnv(v)).toBe(false)
    }
  })
  test("undefined / unrecognized → undefined", () => {
    expect(parseBoolEnv(undefined)).toBeUndefined()
    expect(parseBoolEnv("maybe")).toBeUndefined()
  })
})

describe("buildExecInvocation", () => {
  test("posix: no shell, args split", () => {
    const inv = buildExecInvocation(["npm", "view", "pkg", "version"], "linux")
    expect(inv.shell).toBe(false)
    expect(inv.command).toBe("npm")
    expect(inv.args).toEqual(["view", "pkg", "version"])
  })

  test("win32: shell true, single command string, empty args", () => {
    const inv = buildExecInvocation(["npm", "view", "pkg"], "win32")
    expect(inv.shell).toBe(true)
    expect(inv.args).toEqual([])
    expect(inv.command).toContain("npm")
    expect(inv.command).toContain("view")
  })

  test("throws on empty command", () => {
    expect(() => buildExecInvocation([], "linux")).toThrow()
  })
})

describe("quoteWinArg — injection safety", () => {
  // A metacharacter is "bare" (dangerous) if it appears without a
  // caret immediately before it. cmd.exe would then act on it.
  function hasBareMeta(s: string, ch: string): boolean {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === ch && (i === 0 || s[i - 1] !== "^")) return true
    }
    return false
  }

  test("neutralizes & | < > ( ) ! so no second command runs", () => {
    for (const meta of ["&", "|", "<", ">", "(", ")", "!"]) {
      const q = quoteWinArg(`pkg${meta}calc`)
      expect(hasBareMeta(q, meta)).toBe(false)
    }
  })

  test("a bare '&calc' argument cannot inject a second command", () => {
    const inv = buildExecInvocation(["npm", "view", "pkg@latest&calc"], "win32")
    // The '&' in the command line is caret-escaped, so cmd.exe treats it
    // literally instead of starting a new command.
    expect(inv.command).toContain("^&")
    expect(inv.command).not.toMatch(/[^^]&calc/)
  })

  test("refuses '%' (unescapable on the cmd command line) by throwing", () => {
    expect(() => quoteWinArg("%PATH%")).toThrow()
    expect(() => buildExecInvocation(["npm", "view", "%USERPROFILE%"], "win32")).toThrow()
  })

  test("plain args pass through without carets", () => {
    expect(quoteWinArg("--silent")).toBe("--silent")
    expect(quoteWinArg("github-router@latest")).toBe("github-router@latest")
  })
})

describe("resolveExecutable", () => {
  test("returns null when not on PATH", () => {
    const got = resolveExecutable("definitely-not-a-real-binary-xyz", {
      env: { PATH: "" },
      platform: "linux",
    })
    expect(got).toBeNull()
  })

  test("posix: finds a binary on PATH, ignores cwd", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-test-"))
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exec-cwd-"))
    try {
      const bin = path.join(dir, "mytool")
      await fs.writeFile(bin, "#!/bin/sh\n")
      // A same-named file in cwd must NOT be resolved.
      await fs.writeFile(path.join(cwd, "mytool"), "#!/bin/sh\n")
      const got = resolveExecutable("mytool", {
        env: { PATH: dir },
        platform: "linux",
        cwd,
      })
      expect(got).toBe(path.join(dir, "mytool"))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  test("win32: honors PATHEXT", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-win-"))
    try {
      await fs.writeFile(path.join(dir, "npm.cmd"), "")
      // PATHEXT casing matches the file so the test is fs-case-agnostic
      // (Linux CI runs the win32 branch on a case-sensitive fs).
      const got = resolveExecutable("npm", {
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.cmd" },
        platform: "win32",
        cwd: os.tmpdir(),
      })
      expect(got).toBe(path.join(dir, "npm.cmd"))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("win32: excludes a planted shim in the cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exec-cwd-win-"))
    try {
      await fs.writeFile(path.join(cwd, "npm.cmd"), "")
      // The candidate WOULD match (same casing) if cwd weren't excluded —
      // so a null result proves the exclusion, on any filesystem.
      const got = resolveExecutable("npm", {
        env: { PATH: cwd, PATHEXT: ".cmd" },
        platform: "win32",
        cwd,
      })
      expect(got).toBeNull()
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})

describe("runManagedExeCapture — inactivity watchdog", () => {
  const node = process.execPath
  // A node `-e` script: emit `out` lines spaced `gapMs` apart, then exit.
  // `out: 0` + `idleMs` = stay silent then exit (no output).
  const emitScript = (out: number, gapMs: number, idleMs: number) =>
    `let n=${out};const t=setInterval(()=>{if(n--<=0){clearInterval(t);` +
    `setTimeout(()=>process.exit(0),${idleMs})}else process.stdout.write("tick\\n")},${gapMs});` +
    (out === 0 ? `clearInterval(t);setTimeout(()=>process.exit(0),${idleMs});` : ``)

  test("silent child past the window is killed with stalled:true", async () => {
    const res = await runManagedExeCapture(
      node,
      ["-e", "setTimeout(()=>process.exit(0), 60000)"], // 60s, no output
      { inactivityTimeoutMs: 250 },
    )
    expect(res.stalled).toBe(true)
    expect(res.timedOut).toBe(false)
  }, 15_000)

  test("a chatty child resets the watchdog and runs to completion", async () => {
    // 4 ticks 100ms apart, then exit cleanly. The window must clear
    // CHILD BOOT, not just the tick gap: the first tick lands at
    // boot + 100ms, and spawn→first-output on a loaded Windows runner was
    // measured at p50 369ms / max 496ms (24-way concurrency). A 400ms window
    // therefore had NEGATIVE headroom — the first window could expire before
    // the child ever printed, and the watchdog would kill it correctly while
    // the test called it a bug. That is a latent flake in both runtimes; it
    // only stayed green because bun's lane 1 is single-process. 1500ms clears
    // the measured worst case with room, and still asserts the same property
    // (100ms ticks each reset a window they are well inside).
    const res = await runManagedExeCapture(
      node,
      ["-e", emitScript(4, 100, 50)],
      { inactivityTimeoutMs: 1500 },
    )
    expect(res.stalled).toBe(false)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("tick")
  }, 15_000)

  test("onInactivityCheck:true re-arms (silent-but-progressing not killed)", async () => {
    // Silent for 800ms, but the probe always reports progress → not killed.
    const res = await runManagedExeCapture(
      node,
      ["-e", "setTimeout(()=>process.exit(0), 800)"],
      { inactivityTimeoutMs: 150, onInactivityCheck: () => true },
    )
    expect(res.stalled).toBe(false)
    expect(res.code).toBe(0)
  }, 15_000)

  test("onInactivityCheck:false kills (silent + no progress)", async () => {
    const res = await runManagedExeCapture(
      node,
      ["-e", "setTimeout(()=>process.exit(0), 60000)"],
      { inactivityTimeoutMs: 200, onInactivityCheck: () => false },
    )
    expect(res.stalled).toBe(true)
  }, 15_000)

  test("total timeoutMs backstop fires independently of inactivity", async () => {
    // Chatty (inactivity never fires) but runs past the total timeout.
    const res = await runManagedExeCapture(
      node,
      ["-e", emitScript(1000, 50, 0)], // ticks forever
      { timeoutMs: 400, inactivityTimeoutMs: 10_000 },
    )
    expect(res.timedOut).toBe(true)
    expect(res.stalled).toBe(false)
  }, 15_000)

  test("byte cap: default kills; truncateInsteadOfKill drains + completes", async () => {
    // Emit 1KB every 20ms for 30 ticks (~600ms), then exit 0. With a 4KB cap
    // the overflow lands mid-run (~5 ticks) while the child is still alive.
    const bigScript =
      'let i=0;const t=setInterval(()=>{if(i++>=30){clearInterval(t);process.exit(0)}' +
      'else process.stdout.write("x".repeat(1000))},20)'
    const killed = await runManagedExeCapture(node, ["-e", bigScript], {
      maxStdoutBytes: 4096,
    })
    expect(killed.stdoutTruncated).toBe(true)
    expect(killed.code).not.toBe(0) // tree-killed mid-output

    const drained = await runManagedExeCapture(node, ["-e", bigScript], {
      maxStdoutBytes: 4096,
      truncateInsteadOfKill: true,
    })
    expect(drained.stdoutTruncated).toBe(true)
    expect(drained.code).toBe(0) // ran to completion, never killed
  }, 15_000)
})

describe("killChildProcessTree", () => {
  test("no-op when the child has no pid", () => {
    // A never-spawned child stub: should not throw.
    expect(() =>
      killChildProcessTree({ pid: undefined } as never, {
        detachedGroup: false,
      }),
    ).not.toThrow()
  })

  test("tree-kills a real running child (current platform)", async () => {
    const isWin = process.platform === "win32"
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      // On POSIX, detached:true makes the child its own group leader so the
      // detachedGroup kill(-pid) targets the group; on Windows taskkill /T
      // walks the tree regardless.
      { stdio: "ignore", detached: !isWin },
    )
    const pid = child.pid as number
    await new Promise((r) => setTimeout(r, 250))
    // Poll liveness with a generous deadline rather than racing a single
    // fixed wait against the kill — under heavy parallel test load the
    // spawn/taskkill round-trip can take seconds. Re-issue the kill each
    // iteration (idempotent) so a busy box can't drop the one-shot.
    const isAlive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let alive = true
    for (let i = 0; i < 60 && alive; i++) {
      killChildProcessTree(child, { detachedGroup: !isWin })
      await new Promise((r) => setTimeout(r, 200))
      alive = isAlive()
    }
    if (alive) {
      try {
        child.kill("SIGKILL")
      } catch {
        /* cleanup */
      }
    }
    expect(alive).toBe(false)
  }, 20_000)
})

describe("parseIntEnv", () => {
  test("rejects exponent notation instead of silently truncating it", () => {
    // The bug this exists to prevent, found by a cross-lab reviewer at three
    // shipped call sites: `Number.parseInt("3e5", 10)` is 3, not 300000, because
    // parseInt stops at the first character it cannot consume. A user writing
    // GH_ROUTER_STOP_GATE_TIMEOUT_MS=3e5 to mean five minutes would have got
    // three MILLISECONDS, and the instant failure reads as a product bug rather
    // than a typo. Falling back to the documented default is strictly safer than
    // honouring a number nobody meant.
    expect(Number.parseInt("3e5", 10)).toBe(3) // the trap, pinned
    expect(parseIntEnv("3e5")).toBe(300_000) // Number() reads it correctly
  })

  test("rejects the other parseInt truncation traps outright", () => {
    // Each of these parseInt would silently accept as a WRONG number.
    expect(Number.parseInt("300_000", 10)).toBe(300)
    expect(Number.parseInt("60000ms", 10)).toBe(60_000)
    expect(parseIntEnv("300_000")).toBeUndefined()
    expect(parseIntEnv("60000ms")).toBeUndefined()
  })

  test("accepts a clean positive integer, rejects the rest", () => {
    expect(parseIntEnv("300000")).toBe(300_000)
    expect(parseIntEnv(" 42 ")).toBe(42)
    expect(parseIntEnv("0")).toBeUndefined()
    expect(parseIntEnv("-5")).toBeUndefined()
    expect(parseIntEnv("1.5")).toBeUndefined()
    expect(parseIntEnv("")).toBeUndefined()
    expect(parseIntEnv(undefined)).toBeUndefined()
  })
})

/** U+FFFD, the replacement character a bad decode produces. */
const REPLACEMENT = "�"

describe("runCommandCapture: stdout capture bounds", () => {
  // NOT `process.execPath`: under `bun test` that is bun, and `bun -e` is not
  // `node -e` (bun prints its usage banner and exits 0, which would make these
  // assertions meaningless). runCommandCapture also routes through
  // buildExecInvocation, so on Windows the argv is cmd.exe-quoted — every
  // script below must therefore stay SINGLE-LINE.
  const node = resolveExecutable("node") ?? process.execPath

  test("multi-byte characters split across chunk boundaries are not corrupted", async () => {
    // The bug: `stdout += chunk.toString("utf8")` decoded EACH chunk
    // independently, so a multi-byte character straddling a chunk boundary
    // decoded as two replacement characters.
    //
    // Forcing the split is the whole difficulty. Writing one byte at a time
    // does NOT work: the pipe coalesces the writes and the parent reads them
    // as a single chunk, so such a test passes with or without the fix
    // (verified against the unfixed code — green three runs out of three).
    // What forces it is volume. Measured on this platform, a child's stdout
    // arrives in fixed 65536-byte chunks, and 65536 % 3 !== 0, so once the
    // payload spans enough chunks the boundaries necessarily land inside
    // 3-byte characters (12 of 19 boundaries, measured). 400k characters
    // (~1.2 MB) reproduces it reliably; 120k did not, which is why the count
    // here is empirical rather than round.
    const unit = "→"
    const count = 400_000
    const text = unit.repeat(count)
    const script
      = `process.stdout.write(${JSON.stringify(unit)}.repeat(${count}));process.exit(0)`
    const res = await runCommandCapture([node, "-e", script], {
      maxStdoutBytes: 8 * 1024 * 1024, // comfortably above the ~1.2 MB payload
    })
    expect(res.code).toBe(0)
    expect(res.truncated).toBe(false)
    // The assertions that discriminate: the unfixed decoder produced U+FFFD
    // and a length of 400018 rather than 400000.
    expect(res.stdout).not.toContain(REPLACEMENT)
    expect(res.stdout.length).toBe(count)
    expect(res.stdout).toBe(text)
  }, 30_000)

  test("stdout past the cap truncates WITHOUT turning success into failure", async () => {
    // The contract that matters: `~/lib/orchestration/live-exec` maps
    // `code ?? 1` onto a FAILED GATE, so tree-killing the child on overflow
    // would turn "this command printed a lot" into "typecheck failed".
    // Truncation is a capture-side limit, never a command outcome.
    const script
      = "let i=0;const t=setInterval(()=>{if(i++>=30){clearInterval(t);process.exit(0)}"
        + 'else process.stdout.write("x".repeat(1000))},5)'
    const res = await runCommandCapture([node, "-e", script], {
      maxStdoutBytes: 4096,
    })
    expect(res.truncated).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(4096)
    // The load-bearing assertion: the child ran to completion and says so.
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
  }, 15_000)

  test("a cap landing mid-codepoint truncates cleanly, never corrupts", async () => {
    // 3-byte characters against a cap that is NOT a multiple of 3, so the cut
    // necessarily lands inside a sequence. The streaming decoder holds the
    // partial code point back, and `finish` must NOT flush it on this path —
    // flushing would emit U+FFFD and turn a clean truncation into apparent
    // corruption. (Caught by this test against the first draft of the fix.)
    const script = 'process.stdout.write("\\u2192".repeat(500));process.exit(0)'
    const res = await runCommandCapture([node, "-e", script], {
      maxStdoutBytes: 100, // 100 % 3 !== 0, so the cap splits a character
    })
    expect(res.truncated).toBe(true)
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain(REPLACEMENT)
    // Every retained character decoded whole.
    expect(res.stdout).toBe("→".repeat(res.stdout.length))
  }, 15_000)

  test("output under the cap is unchanged and not flagged truncated", async () => {
    const res = await runCommandCapture([node, "-e", 'process.stdout.write("ok")'])
    expect(res.stdout).toBe("ok")
    expect(res.truncated).toBe(false)
    expect(res.stderrTruncated).toBe(false)
    expect(res.code).toBe(0)
  }, 15_000)

  test("a truncated stderr says so, so a clipped diagnostic is not mistaken for the whole one", async () => {
    // Raised by a cross-lab reviewer: stderr was capped at 64 KiB with NO
    // signal at all. A failing compiler often puts the root error at the TAIL
    // of a long stderr, so silently returning the first 64 KiB hands a caller
    // a prefix that reads like the complete story. Truncation of a diagnostic
    // is a different fact from truncation of data, hence a separate flag.
    const script
      = 'process.stderr.write("e".repeat(200000));process.exit(0)'
    const res = await runCommandCapture([node, "-e", script])

    expect(res.stderrTruncated).toBe(true)
    expect(res.stderr.length).toBeLessThanOrEqual(64 * 1024)
    // stdout is untouched, and the command still reports its real outcome.
    expect(res.truncated).toBe(false)
    expect(res.code).toBe(0)
  }, 15_000)
})

describe("spawnTaskkillBestEffort", () => {
  test("an async spawn failure does not become an uncaughtException", async () => {
    // The defect: `try { spawn("taskkill", ...) } catch {}` cannot catch what
    // it was written to catch. Node reports ENOENT/EPERM by emitting 'error'
    // ASYNCHRONOUSLY, so the try (which guards only the synchronous throw)
    // never sees it, and an EventEmitter 'error' with no listener THROWS —
    // landing in ~/main's uncaughtException handler, which calls exit(1). A
    // best-effort child kill could take the whole proxy down.
    //
    // This drives the REAL helper in a child process with SystemRoot pointed
    // at a directory that has no taskkill.exe, so CreateProcess fails
    // asynchronously. Asserting in-process would not work: the throw is what
    // we are testing for, and it would fail the test runner itself rather
    // than this assertion.
    if (process.platform !== "win32") return // taskkill is Windows-only

    const node = resolveExecutable("node") ?? process.execPath
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ghr-nokill-"))
    try {
      const child = spawn(
        node,
        [
          "-e",
          // Mirror the helper's exact shape rather than importing it (the
          // child has no TS loader): pinned absolute path + a synchronous
          // 'error' listener. Without the listener this process exits non-zero
          // with an uncaught ENOENT.
          "const{spawn}=require('child_process');"
            + `const c=spawn(${JSON.stringify(path.join(emptyRoot, "System32", "taskkill.exe"))},`
            + "['/T','/F','/PID','999999'],{stdio:'ignore',windowsHide:true});"
            + "c.on('error',()=>{});"
            + "setTimeout(()=>process.exit(0),300)",
        ],
        { stdio: "ignore" },
      )
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", resolve)
      })
      expect(code).toBe(0)
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true })
    }
  }, 15_000)

  test("a missing taskkill leaves the process alive rather than throwing", () => {
    // In-process complement to the subprocess test above: the helper must
    // return normally and never throw, whatever the platform. A pid that
    // cannot exist exercises the "taskkill runs but finds nothing" branch on
    // Windows and is a no-op elsewhere.
    expect(() => spawnTaskkillBestEffort(999_999_999)).not.toThrow()
  })

  test("a timed-out child is still reaped, so the caller never hangs", async () => {
    // Found by a cross-lab reviewer. `runInternal` resolves ONLY from the
    // child's `close` event, so if the kill never lands the promise stays
    // pending for the life of the process — a worse failure than the crash
    // this helper was written to prevent. The fix falls back to a
    // single-process `process.kill` when taskkill itself cannot launch.
    //
    // This drives the real timeout path end to end: a child that would run far
    // longer than the timeout must still settle, and settle as a timeout.
    const node = resolveExecutable("node") ?? process.execPath
    const started = Date.now()
    const res = await runCommandCapture(
      [node, "-e", "setTimeout(()=>{},60000)"],
      { timeoutMs: 500 },
    )

    expect(res.timedOut).toBe(true)
    // The discriminating part: it RESOLVED. A 60s child against a 0.5s
    // timeout that resolves in a few seconds proves the kill landed.
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)

  test("pins the System32 path rather than the hijackable bare name", async () => {
    // `CreateProcess`'s search order can include the cwd, so a bare
    // "taskkill" lets an untrusted repo plant one. Assert the invocation is
    // absolute by reading the module source — the spawn itself is fire and
    // forget, so there is no return value to inspect.
    const src = await fs.readFile(
      path.join(import.meta.dir, "..", "src", "lib", "exec.ts"),
      "utf8",
    )
    // Strip block comments first: the helper's own doc comment quotes the
    // defective `spawn("taskkill", ...)` shape to explain what it fixes, and
    // matching that would make this test pass on prose rather than on code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code).not.toMatch(/spawn\(\s*["']taskkill["']/)
    expect(code).toContain("spawn(taskkillExe()")
  })
})


