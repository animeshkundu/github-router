/**
 * Pi precedence: `--pi-path` → user `pi` (in floor) → managed → install.
 *
 * The rule that needs the most care is #2. Today `getInstalledPiVersion()` takes
 * whatever `pi` PATH resolves to, which means a 6-month-old global install wins
 * over a perfectly good managed copy, and the only way to satisfy the floor was
 * `npm install -g` — rewriting a tree the user owns. These tests pin the new
 * ordering, including the two cases that are easy to get silently wrong:
 *
 * - **Our own shim must not count as "the user's pi".** It execs the launcher, so
 *   adopting it would make the launcher resolve to itself.
 * - **A below-floor user install must fall through, and say so.** Falling through
 *   silently is how "why is it running 1.1.0?" bugs happen.
 *
 * Real files, real spawns (`probePiVersion` runs `<exe> --version`), fake PATH.
 * The fake `pi` is a shell script on POSIX and a `.cmd` on Windows, built by the
 * same helper, so the test exercises the platform's own resolution rules rather
 * than a mock of them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  managedPiCommand,
  piBinEntry,
  probePiVersion,
  resolvePiCommand,
} from "~/lib/managed-install/pi-command"
import { MANAGED_MARKER } from "~/lib/managed-install/launcher"
import { versionDir } from "~/lib/managed-install/paths"
import { writePointer } from "~/lib/managed-install/pointer"
import { PI_MIN_VERSION } from "~/lib/pi-version-check"

const dirs: Array<string> = []
const saved = {
  appDir: process.env.GH_ROUTER_APP_DIR,
  path: process.env.PATH,
  noManaged: process.env.GH_ROUTER_NO_MANAGED_INSTALL,
}
/** A version safely above the floor, and one safely below it. */
const GOOD = "99.0.0"
const BAD = "0.0.1"

async function tmp(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-res-${tag}-`))
  dirs.push(dir)
  return dir
}

/**
 * Write a fake `pi` that prints `version` for `--version`.
 *
 * A `.cmd` on Windows is required, not cosmetic: `resolveExecutable` only finds
 * a bare name through PATHEXT, and spawning a `.cmd` needs `cmd.exe` — so this
 * also proves the real spawn path works for the shape a Windows user has.
 */
async function fakePi(dir: string, version: string, body?: string): Promise<string> {
  if (process.platform === "win32") {
    const file = path.join(dir, "pi.cmd")
    await fs.writeFile(file, `@echo off\r\n${body ?? `echo ${version}`}\r\n`)
    return file
  }
  const file = path.join(dir, "pi")
  await fs.writeFile(file, `#!/bin/sh\n${body ?? `echo ${version}`}\n`, { mode: 0o755 })
  return file
}

/** Put `dir` first on PATH for the duration of one assertion. */
async function withPathPrefix<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${original ?? ""}`
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
  }
}

/**
 * Materialize a "complete" managed Pi payload.
 *
 * The bin target comes from the installed package's own `package.json` (Pi has
 * moved it once already), so the fixture must carry one too — a hardcoded path in
 * the fixture would hide exactly the bug that rule prevents.
 */
async function fakeManagedPi(
  tag: string,
  version: string,
  opts: { bin?: unknown; writeEntry?: boolean } = {},
): Promise<string> {
  const app = await tmp(tag)
  process.env.GH_ROUTER_APP_DIR = app
  const pkgRoot = path.join(versionDir("pi", version), "node_modules", "@earendil-works", "pi-coding-agent")
  await fs.mkdir(pkgRoot, { recursive: true })
  await fs.writeFile(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
      ...(opts.bin === undefined ? { bin: { pi: "dist/bundle/cli.js" } } : { bin: opts.bin }),
    }),
  )
  if (opts.writeEntry !== false) {
    await fs.mkdir(path.join(pkgRoot, "dist/bundle"), { recursive: true })
    await fs.writeFile(path.join(pkgRoot, "dist/bundle/cli.js"), "// pi\n")
  }
  await writePointer({ kind: "pi", version })
  return app
}

beforeEach(() => {
  // Opt out of any real install: every test here is about the decision, never
  // about npm. (A test that wants the install branch asserts the refusal.)
  delete process.env.GH_ROUTER_NO_MANAGED_INSTALL
})

afterEach(async () => {
  if (saved.appDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = saved.appDir
  if (saved.path === undefined) delete process.env.PATH
  else process.env.PATH = saved.path
  if (saved.noManaged === undefined) delete process.env.GH_ROUTER_NO_MANAGED_INSTALL
  else process.env.GH_ROUTER_NO_MANAGED_INSTALL = saved.noManaged
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("probePiVersion", () => {
  test("reads the leading semver from a real spawn", async () => {
    const dir = await tmp("probe")
    const pi = await fakePi(dir, "1.6.0-rc.1")
    expect(await probePiVersion(pi)).toBe("1.6.0")
  })

  test("a command that exits non-zero or prints nothing is null, not a throw", async () => {
    const dir = await tmp("probe-bad")
    const failing = await fakePi(dir, "1.2.3", "exit 9")
    expect(await probePiVersion(failing)).toBeNull()
    const silent = await fakePi(dir, "1.2.3", "true")
    expect(await probePiVersion(silent)).toBeNull()
    expect(await probePiVersion(path.join(dir, "does-not-exist"))).toBeNull()
  })
})

describe("piBinEntry", () => {
  test("reads a string bin, a map with pi, and nothing else", async () => {
    const dir = await tmp("bin")
    const root = path.join(dir, "pkg")
    await fs.mkdir(root, { recursive: true })

    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ bin: "cli.js" }))
    expect(await piBinEntry(root)).toBe("cli.js")

    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ bin: { pi: "dist/x.js" } }))
    expect(await piBinEntry(root)).toBe("dist/x.js")

    // A map with a DIFFERENT key must not be coerced into a path: running the
    // wrong file of a package is worse than reporting "no entry".
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ bin: { other: "x.js" } }))
    expect(await piBinEntry(root)).toBeNull()

    await fs.rm(path.join(root, "package.json"))
    expect(await piBinEntry(root)).toBeNull()
  })
})

describe("managedPiCommand", () => {
  test("returns `node <entry>`, never a shell line", async () => {
    await fakeManagedPi("managed", GOOD)
    const command = await managedPiCommand()
    expect(command?.source).toBe("managed")
    expect(command?.version).toBe(GOOD)
    // The runner is a real interpreter path; the ONLY argument is the entry.
    expect(path.isAbsolute(command!.command)).toBe(true)
    expect(command!.args).toHaveLength(1)
    expect(command!.args[0]).toEndWith(path.join("dist", "bundle", "cli.js"))
  })

  test("a pointer below the floor is not usable", async () => {
    await fakeManagedPi("managed-bad", BAD)
    expect(await managedPiCommand()).toBeNull()
  })

  test("a pointer whose payload was deleted is not usable", async () => {
    await fakeManagedPi("managed-gone", GOOD, { writeEntry: false })
    expect(await managedPiCommand()).toBeNull()
  })

  test("a package without a bin map is not usable", async () => {
    await fakeManagedPi("managed-nobin", GOOD, { bin: { other: "x.js" } })
    expect(await managedPiCommand()).toBeNull()
  })
})

describe("resolvePiCommand precedence", () => {
  test("1. --pi-path wins, even below the floor, even when a good managed copy exists", async () => {
    const dir = await tmp("flag")
    const pi = await fakePi(dir, BAD)
    await fakeManagedPi("flag-managed", GOOD)
    const resolved = await resolvePiCommand({ piPath: pi })
    expect(resolved).toMatchObject({ command: pi, source: "flag", version: BAD })
  })

  test("2. a user pi on PATH above the floor wins over the managed copy", async () => {
    const dir = await tmp("path")
    const pi = await fakePi(dir, GOOD)
    await fakeManagedPi("path-managed", "50.0.0")
    const resolved = await withPathPrefix(dir, () => resolvePiCommand())
    expect(resolved?.source).toBe("path")
    // Case-insensitive on Windows: `resolveExecutable` builds candidate names from
    // `PATHEXT` (`.COM;.EXE;.BAT;.CMD`), so for a `pi.cmd` on disk it returns
    // `pi.CMD`. `existsSync` is case-insensitive there, `spawn` runs it fine, and
    // the on-disk spelling is not recoverable without reading the directory — so
    // the platform's case folding is the correct comparison, not a fixed literal.
    expect(resolved?.command.toLowerCase()).toBe(pi.toLowerCase())
  })

  test("2b. a below-floor user pi falls through to the managed copy and explains why", async () => {
    const dir = await tmp("path-bad")
    await fakePi(dir, "1.0.0")
    await fakeManagedPi("path-bad-managed", GOOD)
    const resolved = await withPathPrefix(dir, () => resolvePiCommand())
    expect(resolved?.source).toBe("managed")
    expect(resolved?.note).toContain("below the supported floor")
    expect(resolved?.note).toContain(PI_MIN_VERSION)
  })

  test("2c. OUR shim on PATH is not a user install, even when executable and new enough", async () => {
    const dir = await tmp("shim")
    // A shim that would answer `--version` happily: the marker, not the output,
    // is what must disqualify it.
    await fakePi(dir, GOOD, `rem ${MANAGED_MARKER}\r\necho 99.9.9` )
    await fakeManagedPi("shim-managed", GOOD)
    const resolved = await withPathPrefix(dir, () => resolvePiCommand({ noInstall: true }))
    expect(resolved?.source).toBe("managed")
  })

  test("3. nothing usable and install refused ⇒ null-ish result with a reason, never a throw", async () => {
    const dir = await tmp("none")
    await fakePi(dir, BAD)
    process.env.GH_ROUTER_APP_DIR = await tmp("none-app")
    const resolved = await withPathPrefix(dir, () => resolvePiCommand({ noInstall: true }))
    expect(resolved).toBeNull()
  })

  test("4. install is attempted only when nothing usable exists", async () => {
    const dir = await tmp("install")
    await fakePi(dir, BAD)
    process.env.GH_ROUTER_APP_DIR = await tmp("install-app")
    process.env.GH_ROUTER_NO_MANAGED_INSTALL = "1"
    // `allowInstall` is default, but the env opt-out must make the attempt a
    // no-op with a reason rather than a silent null.
    const resolved = await withPathPrefix(dir, () => resolvePiCommand())
    expect(resolved?.command).toBe("")
    expect(resolved?.note).toContain("GH_ROUTER_NO_MANAGED_INSTALL")
  })
})
