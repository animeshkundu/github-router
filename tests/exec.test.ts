import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

import {
  buildExecInvocation,
  parseBoolEnv,
  quoteWinArg,
  resolveExecutable,
} from "../src/lib/exec"

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
      const got = resolveExecutable("npm", {
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
        cwd: os.tmpdir(),
      })
      // Match is case-insensitive on Windows; the returned ext takes
      // PATHEXT's casing (.CMD), which still points at the real file.
      expect(got?.toLowerCase()).toBe(path.join(dir, "npm.cmd").toLowerCase())
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("win32: excludes a planted shim in the cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exec-cwd-win-"))
    try {
      await fs.writeFile(path.join(cwd, "npm.cmd"), "")
      // PATH lists the cwd explicitly — must still be skipped.
      const got = resolveExecutable("npm", {
        env: { PATH: cwd, PATHEXT: ".CMD" },
        platform: "win32",
        cwd,
      })
      expect(got).toBeNull()
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})
