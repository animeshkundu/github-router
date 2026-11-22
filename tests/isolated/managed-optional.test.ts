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

/** Write `optional/install-state.json` verbatim (the guard's only input). */
async function writeStateForTest(
  packages: Record<string, Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(optionalRoot(), { recursive: true })
  await fs.writeFile(
    path.join(optionalRoot(), "install-state.json"),
    `${JSON.stringify({ packages }, null, 2)}\n`,
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
    } finally {
      process.env.PATH = savedPath
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
