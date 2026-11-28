/**
 * The shared optional payload: resolution, refusal, and the install mechanics.
 *
 * Two things are being pinned here, and they are different in kind.
 *
 * 1. **Resolution is a pure filesystem question** (`installedOptional`). It runs
 *    from a synchronous caller on every structural search and every rerank, so it
 *    must be cheap, must prefer the newest copy, and must refuse a half-written
 *    one. Those three properties are asserted against real directories.
 * 2. **Installation is a supply-chain event.** The payload is code that the next
 *    launch executes, fetched at runtime from a registry, so the rules are:
 *    exact version, `--ignore-scripts`, `--no-global`, scrubbed npm env, publish
 *    by rename. The opt-in test installs a 6 KB stand-in for the same reason the
 *    managed-install test does — the mechanics are identical and the real payload
 *    is 547 MB.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  OPTIONAL_PACKAGES,
  OPTIONAL_REQUIRED_FILE,
  compareVersions,
  ensureOptionalPackage,
  gcOptional,
  installedOptional,
  optionalInstallDisabled,
  optionalTarget,
} from "~/lib/managed-install/optional"
import { optionalRoot } from "~/lib/managed-install/paths"

const dirs: Array<string> = []
const saved = {
  appDir: process.env.GH_ROUTER_APP_DIR,
  disabled: process.env.GH_ROUTER_NO_OPTIONAL_INSTALL,
}
const realNpm = process.env.GH_ROUTER_TEST_REAL_NPM === "1"

async function freshApp(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `optional-${tag}-`))
  dirs.push(dir)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

/** Materialize a complete payload for `pkg@version`. */
async function fakePayload(pkg: string, version: string, complete = true): Promise<string> {
  const target = optionalTarget(pkg as never, version)
  const payload = path.join(target, "node_modules", ...pkg.split("/"))
  await fs.mkdir(payload, { recursive: true })
  await fs.writeFile(path.join(payload, "package.json"), JSON.stringify({ name: pkg, version }))
  if (complete) {
    const required = path.join(payload, OPTIONAL_REQUIRED_FILE[pkg as never])
    await fs.mkdir(path.dirname(required), { recursive: true })
    await fs.writeFile(required, "// payload\n")
  }
  return payload
}

/**
 * Put an executable FAKE `npm` on PATH and return a restore function.
 *
 * Both flavours are written so the same test runs on macOS, WSL, and Windows: a
 * POSIX `/bin/sh` script, and a `.cmd` shim for the Windows branch of
 * `resolveExecutable`. The Windows half matters beyond parity — it is the only
 * place a test drives a `.cmd` npm through the batch envelope on a host where the
 * command layer is Windows-specific.
 *
 * Whatever the fake prints goes through `printf`/`echo` verbatim, so callers keep
 * the text free of shell metacharacters. Anything reading PATH in here sees ONLY
 * this directory, so the POSIX half must use shell builtins.
 */
async function fakeNpm(reply: {
  stdout?: string
  stderr?: string
  code?: number
}): Promise<() => void> {
  const code = reply.code ?? 0
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "optional-fake-npm-"))
  dirs.push(bin)
  const sh = [
    "#!/bin/sh",
    ...(reply.stdout ? [`printf '%s\\n' '${reply.stdout}'`] : []),
    ...(reply.stderr ? [`printf '%s\\n' '${reply.stderr}' >&2`] : []),
    `exit ${code}`,
    "",
  ].join("\n")
  await fs.writeFile(path.join(bin, "npm"), sh)
  await fs.chmod(path.join(bin, "npm"), 0o755)
  const cmd = [
    "@ECHO OFF",
    ...(reply.stdout ? [`echo ${reply.stdout}`] : []),
    ...(reply.stderr ? [`>&2 echo ${reply.stderr}`] : []),
    `exit /b ${code}`,
    "",
  ].join("\r\n")
  await fs.writeFile(path.join(bin, "npm.cmd"), cmd)
  const savedPath = process.env.PATH
  process.env.PATH = bin
  return () => {
    process.env.PATH = savedPath
  }
}

/** Write `optional/install-state.json` verbatim (the guard's only input). */
async function writeStateForTest(
  packages: Record<string, Record<string, unknown>>,
  // Defaults to the schema this build writes. Passing an older number simulates a
  // state file left behind by a previous release, which is a distinct case: the
  // ladder it carries may describe a failure that build caused rather than one the
  // machine hit (see `migrateState`).
  schemaVersion = 2,
): Promise<void> {
  await fs.mkdir(optionalRoot(), { recursive: true })
  await fs.writeFile(
    path.join(optionalRoot(), "install-state.json"),
    `${JSON.stringify({ schemaVersion, packages }, null, 2)}\n`,
  )
}

beforeEach(() => {
  delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
})

afterEach(async () => {
  if (saved.appDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = saved.appDir
  if (saved.disabled === undefined) delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
  else process.env.GH_ROUTER_NO_OPTIONAL_INSTALL = saved.disabled
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("installedOptional", () => {
  test("nothing installed reads as null, not an error", async () => {
    await freshApp("none")
    for (const pkg of OPTIONAL_PACKAGES) expect(installedOptional(pkg)).toBeNull()
  })

  test("a complete copy is found at its package directory", async () => {
    await freshApp("one")
    const payload = await fakePayload("@huggingface/transformers", "4.3.2")
    expect(installedOptional("@huggingface/transformers")).toBe(payload)
  })

  test("a copy missing its entry file is refused", async () => {
    await freshApp("partial")
    await fakePayload("tree-sitter-wasms", "0.1.13", false)
    expect(installedOptional("tree-sitter-wasms")).toBeNull()
  })

  test("the NEWEST complete copy wins even when the older one sorts first on disk", async () => {
    await freshApp("newest")
    await fakePayload("@huggingface/transformers", "4.1.0")
    const newest = await fakePayload("@huggingface/transformers", "4.10.0")
    expect(installedOptional("@huggingface/transformers")).toBe(newest)
  })

  test("an incomplete NEWEST copy does not shadow a complete older one", async () => {
    await freshApp("fallback")
    const older = await fakePayload("@huggingface/transformers", "4.1.0")
    await fakePayload("@huggingface/transformers", "4.10.0", false)
    expect(installedOptional("@huggingface/transformers")).toBe(older)
  })

  test("junk directory names are ignored rather than parsed", async () => {
    await freshApp("junk")
    const root = optionalRoot()
    for (const name of ["README", "@huggingface__transformers@latest", "..", ".staging-x"]) {
      await fs.mkdir(path.join(root, name), { recursive: true })
    }
    expect(installedOptional("@huggingface/transformers")).toBeNull()
  })

  test("the two packages never resolve to each other", async () => {
    await freshApp("cross")
    const transformer = await fakePayload("@huggingface/transformers", "4.3.2")
    expect(installedOptional("tree-sitter-wasms")).toBeNull()
    expect(installedOptional("@huggingface/transformers")).toBe(transformer)
  })
})

describe("compareVersions", () => {
  test("orders on the numeric triple, not lexically", () => {
    expect(compareVersions("4.10.0", "4.9.0")).toBeGreaterThan(0)
    expect(compareVersions("4.9.0", "4.10.0")).toBeLessThan(0)
    expect(compareVersions("0.1.13", "0.1.13")).toBe(0)
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(0)
  })
})

describe("refusals", () => {
  test("GH_ROUTER_NO_OPTIONAL_INSTALL wins before any probe", async () => {
    await freshApp("disabled")
    process.env.GH_ROUTER_NO_OPTIONAL_INSTALL = "1"
    expect(optionalInstallDisabled()).toBe(true)
    const result = await ensureOptionalPackage("@huggingface/transformers")
    expect(result.dir).toBeNull()
    expect(result.detail).toContain("GH_ROUTER_NO_OPTIONAL_INSTALL")
    // Nothing was created: no npm, no state file, no staging.
    await expect(fs.readdir(optionalRoot())).rejects.toThrow()
  })

  test("an already-installed payload is returned without installing", async () => {
    await freshApp("present")
    const payload = await fakePayload("tree-sitter-wasms", "0.1.13")
    const result = await ensureOptionalPackage("tree-sitter-wasms")
    expect(result.dir).toBe(payload)
    expect(result.installed).toBeUndefined()
  })
})

describe("the off switch", () => {
  test("accepts the same spellings as every other GH_ROUTER_* flag", () => {
    // A local `raw === "1" || raw === "true"` made `TRUE`/`yes`/`on` fall through
    // to ENABLED — an off switch that silently turns a 547 MB download ON when
    // the user writes it in the obvious other way.
    for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(optionalInstallDisabled({ GH_ROUTER_NO_OPTIONAL_INSTALL: value })).toBe(true)
    }
    for (const value of ["0", "false", "no", "off", "", undefined]) {
      expect(optionalInstallDisabled({ GH_ROUTER_NO_OPTIONAL_INSTALL: value })).toBe(false)
    }
  })
})

describe("upgrades", () => {
  test("an installed copy does not block installing a NEWER version", async () => {
    // The bug: `existing → return existing` ran BEFORE version resolution, so the
    // first copy ever installed won forever — `update` reported the stale one
    // "ready" and a fix shipped in a new payload could never reach that machine.
    //
    // Deterministic without a network: the test seam pins the version, so
    // resolution needs no `npm view`, and a FAKE npm on PATH makes the install
    // attempt fail in one line. What is asserted is the decision, not the install:
    // the call must NOT hand back the 8.8.8 payload.
    if (process.platform === "win32") return // the fake npm is a POSIX shell script
    await freshApp("upgrade")
    const stale = await fakePayload("tree-sitter-wasms", "8.8.8")
    // NOT `freshApp` here: that would re-point GH_ROUTER_APP_DIR at the bin dir and
    // hide the stale payload this test exists to compare against.
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "optional-upgrade-bin-"))
    dirs.push(bin)
    const npmPath = path.join(bin, "npm")
    // The dependency is pinned in the generated package.json, not on argv, so the
    // fake reads the STAGING package.json — that is where the requested version
    // actually appears. Builtins only (`read`/`printf`/`case`): PATH is just this
    // one directory, so `cat`/`ls` do not exist.
    await fs.writeFile(
      npmPath,
      `#!/bin/sh\n`
        + `while IFS= read -r line; do case "$line" in *9.9.9*) printf '%s\\n' "$line";; esac; done `
        + `< package.json > "${path.join(bin, "npm-argv")}"\nexit 1\n`,
    )
    await fs.chmod(npmPath, 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = bin
    const { __setOptionalTestSubject, __resetOptionalTestSubject } = await import(
      "~/lib/managed-install/optional"
    )
    __setOptionalTestSubject({
      pkg: "tree-sitter-wasms",
      packageName: "tree-sitter-wasms",
      version: "9.9.9",
      requiredFile: OPTIONAL_REQUIRED_FILE["tree-sitter-wasms"],
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms")
      expect(result.dir).toBeNull()
      // It tried to install 9.9.9 instead of returning the 8.8.8 payload.
      expect(await fs.readFile(path.join(bin, "npm-argv"), "utf8")).toContain("9.9.9")
      expect(String(result.detail ?? "")).toContain("failed (exit 1)")
      // The old copy is untouched: failing to upgrade must never lose it.
      expect(await fs.readFile(path.join(stale, "package.json"), "utf8")).toContain("8.8.8")
    } finally {
      process.env.PATH = savedPath
      __resetOptionalTestSubject()
    }
  })
})

describe("a reservation is not a backoff", () => {
  test("a zero-failure window lets the attempt through; a failure window does not", async () => {
    // `nextAttemptAt` is written before every attempt so two processes cannot
    // both download 500 MB, AND it is the backoff ladder's output. Reading the
    // former as the latter made `github-router update`, issued while an
    // on-demand install was still running, report "backing off after a failed
    // tree-sitter-wasms install" when nothing had failed.
    //
    // Both cases are distinguished WITHOUT touching the network by emptying PATH:
    // past the guard the answer is "npm is not on PATH"; stopped by the guard it
    // is "backing off".
    await freshApp("reservation")
    const savedPath = process.env.PATH
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "no-npm-on-path-"))
    try {
      await writeStateForTest({
        "tree-sitter-wasms": {
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      })
      const reserved = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(String(reserved.detail ?? "")).toContain("npm is not on PATH")

      await writeStateForTest({
        "tree-sitter-wasms": {
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
          consecutiveFailures: 1,
          lastError: "boom",
        },
      })
      const failed = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(String(failed.detail ?? "")).toContain("backing off")
      // The message has to say WHEN and how to skip the wait. A ladder that can
      // reach 24h behind a bare "backing off" is indistinguishable from a broken
      // install, and neither the timestamp nor `--force` is discoverable otherwise.
      expect(String(failed.detail ?? "")).toContain("next attempt")
      expect(String(failed.detail ?? "")).toContain("--force")
    } finally {
      process.env.PATH = savedPath
    }
  })

  test("a ladder written by an older schema is retired, not waited out", async () => {
    // The failure this pins: a bug in the command layer made `npm view` reject
    // every `^`-range spec, so both payloads recorded a failure and a 1h window.
    // After the fix the ladder was still there, and the only thing it did was
    // keep the payload uninstalled for at least an hour per startup — a state no
    // code change could climb, because the recorded failure was re-read as a
    // fresh one. A schema bump retires it.
    await freshApp("schema")
    const savedPath = process.env.PATH
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "no-npm-on-path-"))
    try {
      // Schema 1 (the field is absent) with a live 1h window and one failure.
      await writeStateForTest(
        {
          "tree-sitter-wasms": {
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
            consecutiveFailures: 1,
            lastError: "could not resolve a version to install",
          },
        },
        1,
      )
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      // Past the guard: the stale window is gone, so the attempt runs and only
      // then discovers there is no npm.
      expect(String(result.detail ?? "")).toContain("npm is not on PATH")
      expect(String(result.detail ?? "")).not.toContain("backing off")

      // The migration keeps what describes the DISK and drops what described the
      // old failure. The attempt ended at "npm is not on PATH", which records
      // nothing, so what is left is the migrated entry with no ladder at all.
      const state = JSON.parse(
        await fs.readFile(path.join(optionalRoot(), "install-state.json"), "utf8"),
      ) as { schemaVersion?: number; packages?: Record<string, Record<string, unknown>> }
      expect(state.schemaVersion).toBe(2)
      const entry = state.packages?.["tree-sitter-wasms"] ?? {}
      expect(entry.consecutiveFailures).toBeUndefined()
      expect(entry.nextAttemptAt).toBeUndefined()
      expect(entry.lastError).toBeUndefined()
      // `lastAttemptAt` survives: it records when, not why.
      expect(typeof entry.lastAttemptAt).toBe("string")
    } finally {
      process.env.PATH = savedPath
    }
  })

  test("a ladder from a FUTURE schema is not trusted either", async () => {
    // The mirror case, and the reason the comparison is equality rather than
    // `<`: a newer build may attach new semantics to `consecutiveFailures` (a
    // different ladder, a different clock, a per-version window). Honouring a
    // number this build cannot interpret has two failure modes, and both are
    // worse than one wasted attempt: it can suppress a payload for an unknown
    // period, or re-attempt a 547 MB download on every start. Dropping the ladder
    // costs at most one early attempt.
    await freshApp("future-schema")
    const savedPath = process.env.PATH
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "no-npm-on-path-"))
    try {
      await writeStateForTest(
        {
          "tree-sitter-wasms": {
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
            consecutiveFailures: 5,
            lastError: "written by a newer build",
          },
        },
        99,
      )
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(String(result.detail ?? "")).toContain("npm is not on PATH")
      expect(String(result.detail ?? "")).not.toContain("backing off")
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe("what a resolution failure says", () => {
  test("a resolution failure climbs the same 1h/6h/24h ladder as an install failure", async () => {
    // The bug this pins: `consecutiveFailures: 1` was hard-set on every resolution
    // failure, so the ladder never climbed — an offline machine spawned npm once an
    // hour forever, and a machine poisoned by a since-fixed bug could not climb out.
    // Deterministic: the fake npm always fails, and the window is rewound between
    // attempts so the guard lets each through immediately.
    await freshApp("resolve-ladder")
    const restore = await fakeNpm({ stderr: "npm ERR! network request failed", code: 1 })
    try {
      const windows: number[] = []
      for (let attempt = 0; attempt < 4; attempt++) {
        const statePath = path.join(optionalRoot(), "install-state.json")
        try {
          const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
            packages: Record<string, { nextAttemptAt: string }>
          }
          state.packages["tree-sitter-wasms"]!.nextAttemptAt = new Date(Date.now() - 1000).toISOString()
          await fs.writeFile(statePath, JSON.stringify(state, null, 2))
        } catch {
          // No state file yet: the first attempt writes it.
        }
        await ensureOptionalPackage("tree-sitter-wasms", {})
        const after = JSON.parse(await fs.readFile(statePath, "utf8")) as {
          packages: Record<string, { consecutiveFailures: number; nextAttemptAt: string }>
        }
        const entry = after.packages["tree-sitter-wasms"]!
        expect(entry.consecutiveFailures).toBe(attempt + 1)
        windows.push((Date.parse(entry.nextAttemptAt) - Date.now()) / 3_600_000)
      }
      // 1h, 6h, then the 24h cap holds.
      expect(windows[0]).toBeCloseTo(1, 1)
      expect(windows[1]).toBeCloseTo(6, 1)
      expect(windows[2]).toBeCloseTo(24, 1)
      expect(windows[3]).toBeCloseTo(24, 1)
      // The message must carry the wait and the escape hatch, because a 24h ladder
      // behind a bare "failed" is indistinguishable from a broken install.
      const last = await ensureOptionalPackage("tree-sitter-wasms", { force: true })
      expect(String(last.detail ?? "")).toContain("--force retries now")
    } finally {
      restore()
    }
  })

  test("npm's own error text is flattened and stripped before it is stored or printed", async () => {
    // `lastError` is untrusted: it comes from npm, which comes from whatever
    // registry answered. Three shapes matter — an ANSI/control sequence (which can
    // rewrite the terminal line the user is reading), a registry URL carrying
    // credentials (npm echoes the request URL, and this file is 0644), and sheer
    // length.
    const esc = String.fromCharCode(27)
    await freshApp("sanitize")
    const restore = await fakeNpm({
      stderr:
        `${esc}[31mnpm ERR! failed for https://user:s3cr3t@mirror.internal/npm${esc}[0m`
        + `${esc}[2K`
        + ` ${esc}[1msecond${esc}[0m segment`,
      code: 1,
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      const detail = String(result.detail ?? "")
      expect(detail).not.toContain(esc)
      // Removing the ESC byte alone is not enough: the parameters it introduced
      // stay behind as printable garbage. Measured before this was fixed — a
      // coloured npm error came out as `[31mE401 for …[0m`, which is worse than
      // what it replaced and still puts terminal framing in a state file.
      expect(detail).not.toContain("[31m")
      expect(detail).not.toContain("[2K")
      expect(detail).not.toContain("[1m")
      expect(detail).not.toContain("[0m")
      expect(detail).not.toContain("s3cr3t")
      expect(detail).toContain("[REDACTED]")
      // The parts that make it a diagnosis survive.
      expect(detail).toContain("npm ERR! failed for")
      expect(detail).toContain("mirror.internal/npm")
      // One line, however many the source had.
      expect(detail.split(/\r?\n/)).toHaveLength(1)
      // And the same sanitised text is what a support thread would read.
      const state = JSON.parse(
        await fs.readFile(path.join(optionalRoot(), "install-state.json"), "utf8"),
      ) as { packages?: Record<string, { lastError?: string }> }
      const stored = String(state.packages?.["tree-sitter-wasms"]?.lastError ?? "")
      expect(stored).not.toContain(esc)
      expect(stored).not.toContain("[31m")
      expect(stored).not.toContain("s3cr3t")
      expect(stored.length).toBeLessThanOrEqual(400)
    } finally {
      restore()
    }
  })

  test("a resolution failure while a payload IS installed is reported, not hidden", async () => {
    // The early return for an on-disk payload skipped the failure branch entirely,
    // so `update` said "ready" while every future UPGRADE would fail at the first
    // step. The payload still wins (fail-open is correct — throwing away a working
    // 547 MB install because a probe failed would be worse), but the reason has to
    // reach the diagnostics.
    await freshApp("installed-but-unresolvable")
    await fakePayload("tree-sitter-wasms", "0.1.13")
    const restore = await fakeNpm({ stdout: '{"error":{"code":"E401","summary":"Unauthorized"}}', code: 1 })
    const seen: string[] = []
    const { setManagedDiagnosticReporter } = await import("~/lib/managed-install/diagnostics")
    setManagedDiagnosticReporter((level, message) => {
      if (level === "debug") seen.push(message)
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(result.dir).not.toBeNull()
      expect(seen.join("\n")).toContain("could not be resolved")
      expect(seen.join("\n")).toContain("E401")
      // No ladder: an attempt that delivered a usable payload did not fail.
      const state = await fs
        .readFile(path.join(optionalRoot(), "install-state.json"), "utf8")
        .catch(() => "")
      expect(state).not.toContain("consecutiveFailures")
    } finally {
      setManagedDiagnosticReporter(undefined)
      restore()
    }
  })

  test("the reason npm gives is what the user is told, not a lone brace", async () => {
    // Under `--json` npm writes its error ENVELOPE to stdout and leaves stderr
    // empty, so reading "the first line of either stream" reports `{`. Measured
    // against real npm on this machine for the exact failure this branch exists
    // to explain:
    //
    //   stdout: {"error":{"code":"EINVALIDTAGNAME","summary":"Invalid tag name "^^0.1.13" …"}}
    //   stderr: ""
    //
    // So the assertion is on the code and the summary, and on the absence of the
    // brace that a line-based read produced. Runs on all three platforms because
    // the fake npm is written in both flavours.
    await freshApp("npm-error")
    const restore = await fakeNpm({
      stdout: '{"error":{"code":"EINVALIDTAGNAME","summary":"Invalid tag name","detail":""}}',
      code: 1,
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(result.dir).toBeNull()
      const detail = String(result.detail ?? "")
      expect(detail).toContain("EINVALIDTAGNAME")
      expect(detail).toContain("Invalid tag name")
      expect(detail).not.toMatch(/failed \(exit 1\): \{$/)
      // The same text is what lands in the state file, which is where a user or a
      // support thread reads it.
      const state = JSON.parse(
        await fs.readFile(path.join(optionalRoot(), "install-state.json"), "utf8"),
      ) as { packages?: Record<string, { lastError?: string }> }
      expect(String(state.packages?.["tree-sitter-wasms"]?.lastError ?? "")).toContain(
        "EINVALIDTAGNAME",
      )
    } finally {
      restore()
    }
  })

  test("a non-JSON failure still reports its first line", async () => {
    // The fallback half: a crashed npm, a proxy error page, or a spawn-level
    // message on stderr has no envelope to parse, and losing that text would be
    // worse than losing the JSON shape.
    await freshApp("npm-plaintext")
    const restore = await fakeNpm({
      stderr: "npm ERR! network getaddrinfo ENOTFOUND registry.invalid",
      code: 1,
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      expect(String(result.detail ?? "")).toContain("getaddrinfo ENOTFOUND")
    } finally {
      restore()
    }
  })

  test("a URL with two `@`s does not leave its password in clear", async () => {    // Non-greedy userinfo redaction stopped at the FIRST `@`, so
    // `https://a@b:tok2@host/x` became `https://[REDACTED]@b:tok2@host/x` — the
    // secret kept, the username thrown away. A URL may legally carry several.
    await freshApp("two-ats")
    const restore = await fakeNpm({
      stderr: "npm ERR! 401 for https://a@b:tok2@reg.internal/x",
      code: 1,
    })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      const detail = String(result.detail ?? "")
      expect(detail).not.toContain("tok2")
      expect(detail).toContain("https://[REDACTED]@reg.internal/x")
    } finally {
      restore()
    }
  })

  test("an unterminated escape sequence, a bidi override and an 8-bit CSI all go", async () => {
    // Measured shapes the first version of this sanitiser let through:
    //   - an OSC with no BEL/ST terminator (common in truncated npm output) had
    //     its ESC stripped by the control pass, leaving `itle with spaces` — the
    //     payload minus its first character, in a file a support thread reads;
    //   - U+202E (right-to-left override) is not a control byte, so it survived
    //     and can make the rest of a line read backwards in a terminal; and
    //   - `\u009b` is the single-byte CSI of a C1 terminal, which the ESC-based
    //     pattern does not match at all.
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    await freshApp("sanitize-exotic")
    const restore = await fakeNpm({
      stderr:
        `${esc}]8;;https://u:pw@h/x`
        + ` then ${String.fromCharCode(0x202e)}backwards`
        + ` then ${String.fromCharCode(0x9b)}31mcyan`
        + ` then ${esc}]0;title${bel}done`,
      code: 1,
    })
    try {
      const detail = String((await ensureOptionalPackage("tree-sitter-wasms", {})).detail ?? "")
      expect(detail).not.toContain(esc)
      expect(detail).not.toContain(bel)
      expect(detail).not.toContain(String.fromCharCode(0x202e))
      // The unterminated OSC's payload must not come back with its head chopped.
      expect(detail).not.toContain("ttps://")
      // What is left of the real sentence survives.
      expect(detail).toContain("then")
      expect(detail).toContain("cyan")
      expect(detail).toContain("done")
      expect(detail.split(/\r?\n/)).toHaveLength(1)
    } finally {
      restore()
    }
  })

  test("truncation happens after redaction, so a cut cannot leak a prefix", async () => {
    // The cap is 300 characters. If it were applied BEFORE the credential pass, a
    // URL straddling the boundary would be cut mid-secret and the redactor would
    // no longer recognise it — the leak would be a PARTIAL token, which is still a
    // token. Redacting first makes truncation cosmetic.
    await freshApp("cap-order")
    const restore = await fakeNpm({
      stderr: `${"y".repeat(290)} https://u:supersecret@reg.internal/x`,
      code: 1,
    })
    try {
      const detail = String((await ensureOptionalPackage("tree-sitter-wasms", {})).detail ?? "")
      expect(detail).not.toContain("supersecret")
      expect(detail).not.toContain("supersecr")
      expect(detail).not.toContain("supers")
      expect(detail).toContain("https://[")
    } finally {
      restore()
    }
  })

  test("a silent failure does not leave a dangling colon", async () => {
    // npm killed by a signal, or a wrapper that exits non-zero without a word,
    // leaves both streams empty. The measured output used to be
    // `npm view … failed (exit 1): ` with nothing after the colon, which reads as
    // a truncated message rather than a silent child.
    await freshApp("npm-silent")
    const restore = await fakeNpm({ code: 1 })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", {})
      const detail = String(result.detail ?? "")
      expect(detail).toContain("failed (exit 1) with no message")
      expect(detail).not.toMatch(/:\s*$/)
    } finally {
      restore()
    }
  })

  test("a resolution failure does not erase the version of the payload on disk", async () => {
    // `--force` reaches the resolution-failure branch with a working payload
    // already installed. Clearing `version` there records "we have nothing" for a
    // payload a reader can `ls`, and the next `installedOptional` lookup has to
    // work around it.
    await freshApp("force-keeps-version")
    await fakePayload("tree-sitter-wasms", "0.1.13")
    await writeStateForTest({
      "tree-sitter-wasms": { lastAttemptAt: new Date().toISOString(), version: "0.1.13" },
    })
    const restore = await fakeNpm({ stderr: "npm ERR! network down", code: 1 })
    try {
      const result = await ensureOptionalPackage("tree-sitter-wasms", { force: true })
      expect(result.dir).toBeNull()
      expect(String(result.detail ?? "")).toContain("network down")
      const state = JSON.parse(
        await fs.readFile(path.join(optionalRoot(), "install-state.json"), "utf8"),
      ) as { packages?: Record<string, { version?: string; consecutiveFailures?: number }> }
      expect(state.packages?.["tree-sitter-wasms"]?.version).toBe("0.1.13")
      expect(state.packages?.["tree-sitter-wasms"]?.consecutiveFailures).toBe(1)
    } finally {
      restore()
    }
  })
})

describe("gcOptional", () => {
  test("keeps the two newest per package, sweeps abandoned staging/trash", async () => {
    await freshApp("gc")
    const old = new Date(Date.now() - 60 * 24 * 3600_000)
    const versions = ["0.1.10", "0.1.11", "0.1.12"]
    for (const [index, version] of versions.entries()) {
      const payload = await fakePayload("tree-sitter-wasms", version)
      const stamp = new Date(old.getTime() + index * 86_400_000)
      await fs.utimes(payload, stamp, stamp)
      await fs.utimes(path.dirname(path.dirname(payload)), stamp, stamp)
    }
    const staging = path.join(optionalRoot(), ".staging-123-deadbeef")
    const trash = path.join(optionalRoot(), ".trash-cafebabe")
    await fs.mkdir(staging, { recursive: true })
    await fs.mkdir(trash, { recursive: true })
    await fs.utimes(staging, old, old)
    await fs.utimes(trash, old, old)
    const freshStaging = path.join(optionalRoot(), ".staging-999-feedface")
    await fs.mkdir(freshStaging, { recursive: true })

    const report = await gcOptional()
    const remaining = (await fs.readdir(optionalRoot())).sort()
    expect(report.removed).toEqual(["tree-sitter-wasms@0.1.10"])
    expect(remaining).toContain("tree-sitter-wasms@0.1.11")
    expect(remaining).toContain("tree-sitter-wasms@0.1.12")
    expect(remaining).not.toContain("tree-sitter-wasms@0.1.10")
    expect(report.removedTransient.sort()).toEqual([".staging-123-deadbeef", ".trash-cafebabe"])
    expect(remaining).toContain(".staging-999-feedface")
  })

  test("a copy named in `protect` survives the sweep", async () => {
    // Nothing on disk records which copy a process has loaded, and POSIX lets
    // `fs.rm` delete a memory-mapped payload (`EBUSY` only saves Windows). So the
    // installer names the copy it replaced; GC must honour that even when the copy
    // ranks below the newest two and is past the floor.
    await freshApp("gc-protect")
    const old = new Date(Date.now() - 60 * 24 * 3600_000)
    for (const [index, version] of ["0.1.10", "0.1.11", "0.1.12"].entries()) {
      const payload = await fakePayload("tree-sitter-wasms", version)
      const stamp = new Date(old.getTime() + index * 86_400_000)
      await fs.utimes(payload, stamp, stamp)
      await fs.utimes(path.dirname(path.dirname(payload)), stamp, stamp)
    }
    const report = await gcOptional(Date.now(), ["tree-sitter-wasms@0.1.10"])
    expect(report.removed).toEqual([])
    expect((await fs.readdir(optionalRoot())).sort()).toEqual([
      "tree-sitter-wasms@0.1.10",
      "tree-sitter-wasms@0.1.11",
      "tree-sitter-wasms@0.1.12",
    ])
  })

  test("the age floor protects every copy on a fresh machine", async () => {
    await freshApp("gc-floor")
    for (const version of ["0.1.10", "0.1.11", "0.1.12"]) {
      await fakePayload("tree-sitter-wasms", version)
    }
    const report = await gcOptional()
    expect(report.removed).toEqual([])
    expect((await fs.readdir(optionalRoot())).length).toBeGreaterThanOrEqual(3)
  })

  test("a missing optional root is a no-op", async () => {
    await freshApp("gc-empty")
    expect(await gcOptional()).toEqual({ removed: [], removedTransient: [] })
  })
})

describe("a real npm install (opt-in: GH_ROUTER_TEST_REAL_NPM=1)", () => {
  test.skipIf(!realNpm)(
    "installs is-number into the optional layout, verifies it, and sweeps staging",
    async () => {
      await freshApp("real")
      // The only way to exercise the real installer without 547 MB: a stand-in
      // package with the same shape (a `node_modules/<pkg>/package.json` plus one
      // required file). Both halves of the layout are keyed by string, so this
      // is the same code path.
      const { __setOptionalTestSubject } = await import("~/lib/managed-install/optional")
      __setOptionalTestSubject({
        pkg: "tree-sitter-wasms",
        packageName: "is-number",
        version: "7.0.0",
        requiredFile: "index.js",
      })
      try {
        const result = await ensureOptionalPackage("tree-sitter-wasms")
        expect(result.installed).toBe(true)
        expect(result.dir).toEndWith(path.join("node_modules", "is-number"))
        const payload = path.join(result.dir!, "index.js")
        expect(await fs.readFile(payload, "utf8")).toContain("module.exports")
        // The layout is `<pkg>@<version>`, so provenance/GC can see it.
        expect(path.basename(path.dirname(path.dirname(result.dir!)))).toBe("tree-sitter-wasms@7.0.0")
        // A second call adopts, and never spawns npm again.
        const again = await ensureOptionalPackage("tree-sitter-wasms")
        expect(again.dir).toBe(result.dir)
        expect(await fs.readdir(optionalRoot())).not.toContain(".staging-" as never)
        const left = (await fs.readdir(optionalRoot())).filter((n) => n.startsWith(".staging-"))
        expect(left).toEqual([])
      } finally {
        const { __resetOptionalTestSubject } = await import("~/lib/managed-install/optional")
        __resetOptionalTestSubject()
      }
    },
    180_000,
  )
})
