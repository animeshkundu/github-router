import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

import {
  buildExecInvocation,
  parseBoolEnv,
  quoteWinArg,
  resolveExecutable,
  runManagedExeCapture,
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
    // 4 ticks 100ms apart (< the 400ms window each), then exit cleanly.
    const res = await runManagedExeCapture(
      node,
      ["-e", emitScript(4, 100, 50)],
      { inactivityTimeoutMs: 400 },
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
})
