import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  MANAGED_MARKER,
  ensureLauncher,
  hasManagedMarker,
  launcherSource,
} from "~/lib/managed-install/launcher"
import { launcherPath, managedRoot, versionDir } from "~/lib/managed-install/paths"
import { writePointer } from "~/lib/managed-install/pointer"

const dirs: Array<string> = []
const savedAppDir = process.env.GH_ROUTER_APP_DIR

async function useTempAppDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-launcher-"))
  dirs.push(dir)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

/**
 * Lay down a fake payload that reports how it was invoked, so the launcher's
 * argv/exit-code/signal contract can be asserted without any real package.
 */
async function writeFakePayload(version: string, body: string): Promise<string> {
  const entry = path.join(versionDir("self", version), "node_modules/github-router/dist/main.js")
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(path.join(path.dirname(path.dirname(path.dirname(path.dirname(entry)))), "package.json"),
    JSON.stringify({ name: "github-router", version, dependencies: {} }))
  await fs.writeFile(entry, body)
  return entry
}

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function runLauncher(launcher: string, args: Array<string>, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, launcher, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  // Bun exposes the signal on the process object only via `signalCode`.
  return { code, signal: (proc.signalCode ?? null) as NodeJS.Signals | null, stdout, stderr }
}

afterEach(async () => {
  if (savedAppDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = savedAppDir
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("launcher source constraints", () => {
  test("imports nothing but node: builtins — it must survive the package tree being deleted", () => {
    const imports = [...launcherSource().matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!)
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) expect(specifier.startsWith("node:")).toBe(true)
  })

  test("carries the ownership marker so a shim/reinstall can recognise it", () => {
    expect(hasManagedMarker(launcherSource())).toBe(true)
    expect(launcherSource()).toContain(MANAGED_MARKER)
  })

  test("never references the package bootstrap or an app module", () => {
    const src = launcherSource()
    expect(src).not.toContain("dist/bin.js")
    expect(src).not.toContain("~/lib/")
    expect(src).not.toContain("consola")
  })
})

describe("ensureLauncher", () => {
  test("writes an executable file, then leaves an identical one alone", async () => {
    await useTempAppDir()
    const first = await ensureLauncher("self")
    expect(first.written).toBe(true)
    expect(first.path).toBe(launcherPath("self"))
    // POSIX only: Windows has no execute bit (`fs.stat().mode` there reflects the
    // read-only attribute, so this reads 0 for a perfectly executable .mjs). The
    // launcher is invoked as `node launcher.mjs` there, which needs no bit.
    if (process.platform !== "win32") {
      expect((await fs.stat(first.path)).mode & 0o111).not.toBe(0)
    }
    expect(await fs.readFile(first.path, "utf8")).toBe(launcherSource())

    const second = await ensureLauncher("self")
    expect(second.written).toBe(false)
  })

  test("rewrites a stale launcher (upgrade path) and a hand-edited one", async () => {
    await useTempAppDir()
    await ensureLauncher("pi")
    await fs.writeFile(launcherPath("pi"), "// older launcher\n")
    const rewritten = await ensureLauncher("pi")
    expect(rewritten.written).toBe(true)
    expect(await fs.readFile(launcherPath("pi"), "utf8")).toBe(launcherSource())
  })

  test("self and pi get independent launchers", async () => {
    await useTempAppDir()
    await ensureLauncher("self")
    expect(await fs.readdir(managedRoot("self"))).toContain("launcher.mjs")
    expect(await fs.readdir(managedRoot("pi")).catch(() => [] as string[])).toEqual([])
  })
})

describe("the emitted launcher, executed for real", () => {
  test("re-execs the payload with the caller's argv, exactly once, no extra banner", async () => {
    await useTempAppDir()
    const entry = await writeFakePayload(
      "1.2.3",
      // One line of "banner" so a double-exec would be visible as two lines.
      `process.stdout.write("payload:" + ${JSON.stringify("1.2.3")} + " " + JSON.stringify(process.argv.slice(2)) + "\\n")\n`,
    )
    await writePointer({ kind: "self", version: "1.2.3", runtimeHint: process.execPath })
    const { path: launcher } = await ensureLauncher("self")

    const result = await runLauncher(launcher, ["pi", "-m", "local", "a b"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('payload:1.2.3 ["pi","-m","local","a b"]')
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    expect(result.stderr).toBe("")
    void entry
  })

  test("propagates the payload's exit code verbatim", async () => {
    await useTempAppDir()
    // 78 = "config error" in sysexits; a code the launcher must not swallow.
    await writeFakePayload("1.2.3", "process.exit(78)\n")
    await writePointer({ kind: "self", version: "1.2.3" })
    const { path: launcher } = await ensureLauncher("self")

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(78)
  })

  test("a missing pointer exits 78 with the two actionable commands", async () => {
    await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(78)
    expect(result.stderr).toContain("current.json is missing")
    expect(result.stderr).toContain("github-router update")
    expect(result.stderr).toContain("npm install -g github-router")
    // Nothing ran: the message is the whole output.
    expect(result.stdout).toBe("")
  })

  test("a corrupt pointer says so instead of crashing", async () => {
    const root = await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    await fs.writeFile(path.join(root, "m", "self", "current.json"), "{not json")

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("not valid JSON")
    expect(result.stderr).toContain("github-router update")
  })

  test("an unsupported schema version is refused, not guessed", async () => {
    const root = await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    await fs.writeFile(
      path.join(root, "m", "self", "current.json"),
      JSON.stringify({ schemaVersion: 2, version: "1.2.3", entry: "x.js" }),
    )

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(78)
    expect(result.stderr).toContain("unsupported pointer schema 2")
  })

  test("a pointer whose payload is missing fails with the entry path, not a stack trace", async () => {
    await useTempAppDir()
    await writePointer({ kind: "self", version: "9.9.9" })
    const { path: launcher } = await ensureLauncher("self")

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(78)
    expect(result.stderr).toContain("the live payload is missing")
    expect(result.stderr).toContain("9.9.9")
    // A Node stack trace would be a bug: this is a designed failure.
    expect(result.stderr).not.toContain("    at ")
  })

  test("refuses an unsafe entry rather than executing it", async () => {
    const root = await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    const outside = path.join(root, "evil.js")
    await fs.writeFile(outside, 'process.stdout.write("PWNED")\n')
    for (const entry of ["../../evil.js", path.join(root, "evil.js")]) {
      await fs.writeFile(
        path.join(root, "m", "self", "current.json"),
        JSON.stringify({ schemaVersion: 1, kind: "self", version: "1.2.3", entry }),
      )
      const result = await runLauncher(launcher, [])
      expect(result.stdout).not.toContain("PWNED")
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("unsafe entry")
    }
  })

  test("refuses a version that would escape the version dir", async () => {
    const root = await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    await fs.writeFile(
      path.join(root, "m", "self", "current.json"),
      JSON.stringify({ schemaVersion: 1, kind: "self", version: "../../..", entry: "package.json" }),
    )
    const result = await runLauncher(launcher, [])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("invalid version")
  })

  test("GH_ROUTER_MANAGED_DRY_RUN reports the resolved target without running it", async () => {
    await useTempAppDir()
    await writeFakePayload("1.2.3", 'process.stdout.write("should not run")\n')
    await writePointer({ kind: "self", version: "1.2.3" })
    const { path: launcher } = await ensureLauncher("self")

    // The seam is gated: without `GH_ROUTER_MANAGED_TEST=1` a stray
    // GH_ROUTER_MANAGED_DRY_RUN in a user's environment would make every hook
    // "succeed" by printing JSON instead of doing its work.
    const result = await runLauncher(launcher, [], {
      GH_ROUTER_MANAGED_TEST: "1",
      GH_ROUTER_MANAGED_DRY_RUN: "1",
    })
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("should not run")
    const parsed = JSON.parse(result.stdout.trim()) as { version: string; entryPath: string }
    expect(parsed.version).toBe("1.2.3")
    expect(parsed.entryPath.endsWith(path.join("1.2.3", "node_modules/github-router/dist/main.js"))).toBe(true)
  })

  test("the DANGEROUS seams are inert without the explicit opt-in", async () => {
    // Two ways these bite in production if ungated:
    //  - a leaked GH_ROUTER_MANAGED_ENTRY executes an ARBITRARY file on every
    //    launch (it is checked before the absolute/traversal guards);
    //  - a leaked GH_ROUTER_MANAGED_DRY_RUN makes every hook exit 0 having
    //    printed JSON, a "success" that did nothing.
    await useTempAppDir()
    await writeFakePayload("1.2.3", 'process.stdout.write("payload-ran")\n')
    await writePointer({ kind: "self", version: "1.2.3" })
    const { path: launcher } = await ensureLauncher("self")
    const evil = path.join(os.tmpdir(), `evil-${process.pid}.cjs`)
    dirs.push(evil)
    await fs.writeFile(evil, 'process.stdout.write("EVIL-RAN")\n')

    const result = await runLauncher(launcher, [], {
      GH_ROUTER_MANAGED_ENTRY: evil,
      GH_ROUTER_MANAGED_DRY_RUN: "1",
    })
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("EVIL-RAN")
    expect(result.stdout).not.toContain('"entryPath"')
    expect(result.stdout).toContain("payload-ran")
  })

  test("the emitted launcher carries a WORKING engines.node floor", async () => {
    // `LAUNCHER_BODY` is a String.raw template, so a `\\d` in the source is TWO
    // characters in the emitted file: `range.match(/(\\d+)/)` matches a literal
    // backslash followed by d's, never "20". The runtime-floor check then returns
    // null for every real range and silently never filters a runtime — dead code
    // that looks alive. Assert on the EMITTED bytes, which is where the mistake
    // was, and on the behaviour: a payload declaring engines.node >= 22 must not
    // be run by a runtime reporting 20.
    const source = launcherSource()
    const matchLine = source.split("\n").find((line) => line.includes("range.match"))
    expect(matchLine).toBeDefined()
    const backslashes = [...(matchLine ?? "")].filter((char) => char === "\\").length
    expect(backslashes).toBe(1)

    // Behavioural half: run the emitted launcher with a doctored process.versions
    // so `runningNodeMajor` reports 20 against a payload demanding 22. The floor
    // must send it to the pointer's runtimeHint instead of `process.execPath`.
    await useTempAppDir()
    const entry = await writeFakePayload("4.5.6", 'process.stdout.write("payload-ran")\n')
    await fs.writeFile(
      path.join(path.dirname(path.dirname(path.dirname(path.dirname(entry)))), "package.json"),
      JSON.stringify({ name: "github-router", version: "4.5.6", engines: { node: ">=22" } }),
    )
    await writePointer({ kind: "self", version: "4.5.6", runtimeHint: process.execPath })
    const { path: launcher } = await ensureLauncher("self")
    const prelude = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "launcher-major-")), "prelude.cjs")
    dirs.push(path.dirname(prelude))
    // Fake a Node 20 runtime, then hand over to the real launcher.
    await fs.writeFile(
      prelude,
      `Object.defineProperty(process.versions, "node", { value: "20.11.0" })\n`
        + `require(${JSON.stringify(launcher)})\n`,
    )
    const proc = Bun.spawn([process.execPath, prelude], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    // Whatever runtime it picked, the payload must still have run — the floor only
    // decides WHICH runtime, never whether to run.
    expect(stdout).toContain("payload-ran")
  })

  test.skipIf(process.platform === "win32")(
    "a payload killed by a signal is reported as that signal, never as exit 0",
    async () => {
      // The launcher installs forwarding handlers for SIGINT/SIGTERM/SIGHUP. Node
      // does not re-raise a signal that has a listener, so a naive
      // `process.kill(process.pid, signal)` on the child's death is a no-op that
      // falls through to exit 0 — a killed session looks like a clean run to a
      // supervisor. The listeners must be removed first.
      //
      // POSIX only: Windows has no signals. `process.kill` there terminates the
      // process immediately with the exception code as the exit status, so there
      // is no `signal` and no 128+n convention to preserve — the property this
      // test exists to protect does not exist on that platform.
      await useTempAppDir()
      await writeFakePayload("1.2.3", 'process.kill(process.pid, "SIGTERM")\n')
      await writePointer({ kind: "self", version: "1.2.3" })
      const { path: launcher } = await ensureLauncher("self")

      const result = await runLauncher(launcher, [])
      const killedBySignal = result.signal === "SIGTERM"
      const shellConvention = result.code === 143
      expect(killedBySignal || shellConvention).toBe(true)
      expect(result.code).not.toBe(0)
    },
  )

  test("a stale runtimeHint below the payload's engines floor is skipped for node on PATH", async () => {
    // The "launcher stopped working after a node upgrade" bug: the hint is a
    // file that no longer exists (or is too old), so the launcher must fall
    // through instead of dead-ending.
    await useTempAppDir()
    await writeFakePayload("1.2.3", 'process.stdout.write("ok")\n')
    await writePointer({ kind: "self", version: "1.2.3", runtimeHint: "/nonexistent/bin/node-19" })
    const { path: launcher } = await ensureLauncher("self")

    const result = await runLauncher(launcher, [])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("ok")
  })
})
