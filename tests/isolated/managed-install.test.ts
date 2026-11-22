/**
 * `<APP_DIR>/m/` end-to-end: real `npm install`s into a throwaway app dir.
 *
 * These are the tests the design actually needs, because every failure this
 * module has had was a filesystem or npm behaviour, not a logic error:
 *
 * - `rename` onto a non-empty directory (`ENOTEMPTY`) — the corrupt-aside path;
 * - `npm install` exiting 0 while installing nothing (the `npm_config_*` table in
 *   `npm-env.ts`) — the entry-verification path;
 * - a crashed install leaving `.staging-*` behind — the GC path;
 * - two installers racing — adopt-vs-publish.
 *
 * They install `is-number` (one 6 KB package, no scripts) rather than the real
 * 66 MB payload, and they patch `NPM_PACKAGE`/`ENTRY_RELATIVE` through the module
 * under test's own dependency to keep the assertions honest about the layout.
 * Opt-in via `GH_ROUTER_TEST_REAL_NPM=1` for the network-dependent ones.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ensureManagedInstall,
  gcManaged,
  managedEntryPath,
} from "~/lib/managed-install/install"
import {
  __resetManagedTestTarget,
  __setManagedTestTarget,
  managedRoot,
  stagingDir,
  trashDir,
  versionDir,
} from "~/lib/managed-install/paths"
import {
  readInstalledMarker,
  readPointer,
  writeInstalledMarker,
  writePointer,
} from "~/lib/managed-install/pointer"
import {
  BACKOFF_HOURS,
  installAllowedNow,
  mayAttemptNow,
  nextAttemptAtFor,
  patchInstallState,
  readInstallState,
} from "~/lib/managed-install/state"

const dirs: Array<string> = []
const saved = { appDir: process.env.GH_ROUTER_APP_DIR }
const realNpm = process.env.GH_ROUTER_TEST_REAL_NPM === "1"

/**
 * The seam: install a 6 KB package with no install scripts into the REAL self
 * layout, then assert the mechanics production depends on. Without this the suite
 * would only ever test mocked npm, and every bug this module has had was a
 * filesystem/npm behaviour rather than a logic error.
 */
const TINY = "is-number"
const TINY_ENTRY = "node_modules/is-number/index.js"

async function freshApp(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `mgd-install-${tag}-`))
  dirs.push(dir)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

beforeEach(() => {
  process.env.GH_ROUTER_NO_MANAGED_INSTALL = ""
})

afterEach(async () => {
  if (saved.appDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = saved.appDir
  delete process.env.GH_ROUTER_NO_MANAGED_INSTALL
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("state helpers", () => {
  test("the backoff ladder widens and sticks at 24 h", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")
    const hoursOf = (failures: number): number =>
      (Date.parse(nextAttemptAtFor(failures, now)) - now) / 3_600_000
    expect(hoursOf(1)).toBe(BACKOFF_HOURS[0]!)
    expect(hoursOf(2)).toBe(BACKOFF_HOURS[1]!)
    expect(hoursOf(3)).toBe(BACKOFF_HOURS[2]!)
    expect(hoursOf(40)).toBe(24)
  })

  test("installAllowedNow is true with no window and false inside one", () => {
    expect(installAllowedNow({})).toBe(true)
    expect(installAllowedNow({ nextAttemptAt: "not a date" })).toBe(true)
    expect(installAllowedNow({ nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })).toBe(
      false,
    )
    expect(installAllowedNow({ nextAttemptAt: new Date(Date.now() - 60_000).toISOString() })).toBe(
      true,
    )
  })

  test("mayAttemptNow lets a RESERVATION through but respects a real BACKOFF", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    // A reservation: the window is set, but nothing has failed yet.
    expect(mayAttemptNow({ nextAttemptAt: future })).toBe(true)
    expect(mayAttemptNow({ nextAttemptAt: future, consecutiveFailures: 0 })).toBe(true)
    // A real failure: the ladder is in force.
    expect(mayAttemptNow({ nextAttemptAt: future, consecutiveFailures: 1 })).toBe(false)
    // An expired window is always in the past, whatever the failure count.
    expect(
      mayAttemptNow({
        nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveFailures: 3,
      }),
    ).toBe(true)
  })

  test("patchInstallState merges onto what is CURRENTLY on disk", async () => {
    await freshApp("state")
    await patchInstallState("self", { npmCache: "/cache-a", lastError: "boom" })
    // Simulate another process writing in between.
    await patchInstallState("self", { lastOrigin: "npx" })
    expect(await readInstallState("self")).toEqual({
      npmCache: "/cache-a",
      lastError: "boom",
      lastOrigin: "npx",
    })
    // `undefined` deletes, which is how a success clears the backoff.
    await patchInstallState("self", { lastError: undefined, nextAttemptAt: undefined })
    const after = await readInstallState("self")
    expect(after.lastError).toBeUndefined()
    expect(after.npmCache).toBe("/cache-a")
  })

  test("a corrupt state file reads as empty, never throws", async () => {
    const app = await freshApp("state-corrupt")
    await fs.mkdir(managedRoot("self"), { recursive: true })
    await fs.writeFile(path.join(managedRoot("self"), "install-state.json"), "{oops")
    expect(await readInstallState("self")).toEqual({})
    void app
  })
})

describe("ensureManagedInstall: refusals", () => {
  test("the env opt-out wins over everything", async () => {
    await freshApp("opt-out")
    process.env.GH_ROUTER_NO_MANAGED_INSTALL = "1"
    const outcome = await ensureManagedInstall({ kind: "self", version: "1.2.3" })
    expect(outcome.kind).toBe("disabled")
  })

  test("an invalid version never reaches a path join", async () => {
    await freshApp("bad-version")
    for (const version of ["../evil", "1.2", "latest", "1.2.3 && rm -rf /"]) {
      const outcome = await ensureManagedInstall({ kind: "self", version })
      expect(outcome.kind).toBe("failed")
      expect(outcome.detail).toContain("invalid version")
    }
  })

  test("a backoff window short-circuits before npm is touched", async () => {
    await freshApp("backoff")
    // Every field the failure path actually writes. `consecutiveFailures` is the
    // one that makes this a BACKOFF rather than a reservation: see the next test.
    await patchInstallState("self", {
      nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
      consecutiveFailures: 1,
      lastError: "previous failure",
    })
    const outcome = await ensureManagedInstall({ kind: "self", version: "1.2.3" })
    expect(outcome.kind).toBe("backoff")
    expect(outcome.detail).toContain("previous failure")
    // `force` is the documented escape hatch that bypasses the window; it must
    // get past the backoff (it may still fail later, for other reasons).
    const forced = await ensureManagedInstall({ kind: "self", version: "1.2.3", force: true })
    expect(forced.kind).not.toBe("backoff")
  })

  test("a bare RESERVATION is not a backoff: an explicit update still runs", async () => {
    // The bug this pins: every attempt writes `nextAttemptAt` optimistically so
    // two launches cannot both run npm. If that window were read as a failure,
    // `npx github-router@latest` (which reserves, then hands off) followed one
    // second later by `github-router update` would print "last attempt failed
    // (unknown error)" and install nothing — even though nothing had failed and
    // the user asked for it explicitly. The install LOCK is what serialises
    // attempts; the ladder is only for real failures.
    await freshApp("reservation")
    await patchInstallState("self", {
      lastAttemptAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const outcome = await ensureManagedInstall({ kind: "self", version: "1.2.3" })
    expect(outcome.kind).not.toBe("backoff")
  })
})

describe("ensureManagedInstall: adopt-before-install", () => {
  test("a complete existing version is adopted without running npm", async () => {
    await freshApp("adopt")
    const version = "3.1.0"
    const entry = path.join(versionDir("self", version), "node_modules/github-router/dist/main.js")
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.writeFile(entry, "// payload\n")
    await writeInstalledMarker("self", { version, packages: {} })

    const outcome = await ensureManagedInstall({ kind: "self", version })
    expect(["adopted", "installed"]).toContain(outcome.kind)
    expect(outcome.version).toBe(version)
    const pointer = await readPointer("self")
    expect(pointer?.version).toBe(version)
    // Nothing was installed: no package.json was generated, and no node_modules
    // beyond the fake we placed.
    //
    // Order-insensitive: `readdir` guarantees no order on any platform, and this
    // assertion failed on the Linux job with the same two names reversed. What it
    // means is "exactly these entries", so that is what it must say.
    const entries = await fs.readdir(versionDir("self", version))
    expect(entries.toSorted()).toEqual([".installed.json", "node_modules"])
  })

  test("a version dir with an entry but no marker is NOT adopted", async () => {
    await freshApp("no-marker")
    const version = "3.1.0"
    const entry = path.join(versionDir("self", version), "node_modules/github-router/dist/main.js")
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.writeFile(entry, "// half-installed\n")
    // No marker → probeVersion refuses. The install then fails (no such version
    // on the registry), but the important assertion is that it did NOT adopt.
    const outcome = await ensureManagedInstall({ kind: "self", version })
    expect(outcome.kind).not.toBe("adopted")
  })
})

describe("gcManaged", () => {
  test("sweeps stale staging/trash and keeps the live + two newest versions", async () => {
    await freshApp("gc")
    await fs.mkdir(managedRoot("self"), { recursive: true })

    // Four versions, deliberately out of order with descending mtimes.
    const versions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]
    const base = Date.now() - 30 * 24 * 3600_000
    for (const [index, version] of versions.entries()) {
      const dir = versionDir("self", version)
      await fs.mkdir(dir, { recursive: true })
      const stamp = new Date(base + index * 24 * 3600_000)
      await fs.utimes(dir, stamp, stamp)
    }
    // Live pointer → 1.0.0 (the oldest). So protected = {1.0.0, 4.0.0, 3.0.0}.
    await writePointer({ kind: "self", version: "1.0.0" })

    // A fresh staging dir survives (an install may be running), an old one goes.
    const fresh = stagingDir("self")
    await fs.mkdir(fresh, { recursive: true })
    const stale = path.join(managedRoot("self"), ".staging-999-deadbeef")
    await fs.mkdir(stale, { recursive: true })
    await fs.utimes(stale, new Date(base), new Date(base))
    const trash = trashDir("self")
    await fs.mkdir(trash, { recursive: true })
    await fs.utimes(trash, new Date(base), new Date(base))

    const report = await gcManaged("self")
    const remaining = (await fs.readdir(managedRoot("self"))).sort()
    // Protected: the live pointer (1.0.0) plus the two NEWEST (4.0.0, 3.0.0).
    // 2.0.0 is the fourth and oldest-by-recency, well past the 7-day floor.
    expect(remaining).toContain("1.0.0")
    expect(remaining).toContain("4.0.0")
    expect(remaining).toContain("3.0.0")
    expect(remaining).not.toContain("2.0.0")
    expect(report.removedVersions).toEqual(["2.0.0"])
    // The stale attempt dirs are gone; the fresh staging (an install may be
    // running right now) and the `.trash-*` younger than an hour survive.
    expect(remaining).toContain(path.basename(fresh))
    expect(remaining).not.toContain(".staging-999-deadbeef")
    expect(report.removedStaging).toEqual([".staging-999-deadbeef"])
    expect(report.removedTrash).toEqual([path.basename(trash)])
  })

  test("the 7-day floor protects a version even when it is neither live nor newest", async () => {
    await freshApp("gc-floor")
    await fs.mkdir(managedRoot("self"), { recursive: true })
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) {
      await fs.mkdir(versionDir("self", version), { recursive: true })
    }
    // All created just now: every one is inside the floor.
    await writePointer({ kind: "self", version: "1.0.0" })
    const report = await gcManaged("self")
    expect(report.removedVersions).toEqual([])
    expect(report.kept.some((k) => k.reason === "within-7-day-floor")).toBe(true)
  })

  test("an UNREADABLE pointer aborts the sweep instead of deleting the live tree", async () => {
    // The worst failure in this file. `readPointer` collapses every non-ENOENT
    // error into `null`, and GC reads `null` as "nothing is live, nothing to
    // protect". A transient EPERM/EBUSY (a virus scanner holding current.json, a
    // torn read on a network home) would therefore delete the version the pointer
    // names — unrecoverable without a reinstall, on the machine that is already
    // unhealthy. A directory at the pointer path is the deterministic stand-in for
    // "the read failed for a reason other than ENOENT" (EISDIR).
    await freshApp("gc-unreadable")
    await fs.mkdir(managedRoot("self"), { recursive: true })
    await fs.mkdir(path.join(managedRoot("self"), "current.json"))
    const base = Date.now() - 60 * 24 * 3600_000
    // 1.0.0 is the live one, chosen so it is ALSO outside the two newest by mtime
    // and past the 7-day floor: exactly the tree a blind sweep would delete.
    for (const [index, version] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
      const dir = versionDir("self", version)
      await fs.mkdir(dir, { recursive: true })
      const stamp = new Date(base + index * 24 * 3600_000)
      await fs.utimes(dir, stamp, stamp)
    }
    const report = await gcManaged("self")
    expect(report.removedVersions).toEqual([])
    expect((await fs.readdir(managedRoot("self"))).sort()).toEqual([
      "1.0.0",
      "2.0.0",
      "3.0.0",
      "current.json",
    ])
  })

  test("an abandoned atomic-write temp file is swept once it is old", async () => {
    // A killed `writeFileAtomic` leaves `<file>.<pid>.<rand>.tmp` behind; nothing
    // else in this sweep matched that shape, so they accumulated.
    await freshApp("gc-tmp")
    await fs.mkdir(managedRoot("self"), { recursive: true })
    const stale = path.join(managedRoot("self"), "current.json.12345-deadbeef.tmp")
    await fs.writeFile(stale, "{}")
    const old = new Date(Date.now() - 2 * 3600_000)
    await fs.utimes(stale, old, old)
    const fresh = path.join(managedRoot("self"), "current.json.12346-cafebabe.tmp")
    await fs.writeFile(fresh, "{}")
    const report = await gcManaged("self")
    expect(report.removedTransient).toEqual(["current.json.12345-deadbeef.tmp"])
    expect((await fs.readdir(managedRoot("self"))).sort()).toEqual(["current.json.12346-cafebabe.tmp"])
  })

  test("a missing managed root is a no-op, not an error", async () => {
    await freshApp("gc-empty")
    expect(await gcManaged("self")).toEqual({
      removedStaging: [],
      removedTrash: [],
      removedTransient: [],
      removedVersions: [],
      kept: [],
    })
  })
})

describe("the optimistic reservation does not harden when the lock is held", () => {
  test("a skipped attempt restores the previous window instead of installing a backoff", async () => {
    // Two launches race. The loser writes an optimistic `nextAttemptAt` (so a
    // third launch backs off), loses the lock, and would otherwise leave a 1 h
    // window behind for an install that was never attempted — after which the
    // next launch reports `backoff` on a healthy machine and skips the update it
    // was asked to perform.
    await freshApp("lock-reservation")
    const { withInstallLockResult } = await import("~/lib/update-lock")
    const held = withInstallLockResult("managed-self.lock", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })
    let outcome
    try {
      outcome = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
    } finally {
      __resetManagedTestTarget()
    }
    expect(outcome.kind).toBe("locked")
    const state = await readInstallState("self")
    expect(state.nextAttemptAt).toBeUndefined()
    expect(state.consecutiveFailures ?? 0).toBe(0)
    expect(installAllowedNow(state)).toBe(true)
    await held
  })
})

describe("the install lock on a machine that has never installed anything", () => {
  test("creates the app dir instead of reporting 'another install is in progress'", async () => {
    // A real bug this had: `open(lock, "wx")` on a nonexistent app dir threw
    // ENOENT, `isStale` then read "disappeared => stale", and the installer
    // reported `skipped` — the user-facing message for "a live process holds
    // this lock" — on a machine with no other process running. The `-g`,
    // toolbelt and colbert lock holders can all run before anything has created
    // `<APP_DIR>`, so the mkdir has to live in the lock helper.
    const root = await freshApp("fresh-lock")
    const { withInstallLockResult } = await import("~/lib/update-lock")
    let ran = false
    const result = await withInstallLockResult("self-update.lock", async () => {
      ran = true
    })
    expect(result.outcome).toBe("ran")
    expect(ran).toBe(true)
    // And it cleaned up after itself.
    expect(await fs.readdir(root)).not.toContain("self-update.lock")
  })

  test("a second holder is reported as skipped, not as a failure", async () => {
    await freshApp("fresh-lock-held")
    const { withInstallLockResult } = await import("~/lib/update-lock")
    let release: () => void = () => {}
    const held = withInstallLockResult("managed-self.lock", async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    // Give the first holder a tick to create the file.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await withInstallLockResult("managed-self.lock", async () => {})
    expect(second.outcome).toBe("skipped")
    release()
    expect((await held).outcome).toBe("ran")
  })
})

describe("the install lock reports what actually failed", () => {
  test("a create error that is NOT EEXIST is a failure, not 'another process is installing'", async () => {
    // The bug: every `mkdir`/`open` error was mapped to `null`, `null` meant
    // "held", and `install.ts` turned "held" into `kind:"locked"` — the
    // user-facing sentence "another github-router process is installing; retry
    // shortly". On an unwritable or odd APP_DIR that message repeats forever and
    // blames a process that does not exist.
    //
    // `GH_ROUTER_APP_DIR` pointing UNDER a regular file is the deterministic
    // stand-in for "the create failed for its own reason": both the mkdir and the
    // open fail with a path-component error, with no dependency on permissions,
    // on being root, or on the platform's EISDIR/EEXIST split for a directory at
    // the lock path.
    //
    // The CODE differs by platform (POSIX `ENOTDIR`, Windows `ENOENT` — its
    // path resolver does not distinguish "a file is in the way" from "no such
    // thing"), and this test is about the MEANING, not the errno: any non-EEXIST
    // failure must be `failed`, never `locked`. Pinning `ENOTDIR` made a correct
    // implementation fail the Windows job.
    const root = await freshApp("lock-enotdir")
    const blocker = path.join(root, "not-a-dir")
    await fs.writeFile(blocker, "x")
    process.env.GH_ROUTER_APP_DIR = path.join(blocker, "app")
    const { withInstallLockResult } = await import("~/lib/update-lock")
    const result = await withInstallLockResult("managed-self.lock", async () => {})
    expect(result.outcome).toBe("failed")
    expect(result.outcome === "failed" ? String(result.error) : "").toContain("could not create the install lock")
    const code = result.outcome === "failed" ? ((result.error as NodeJS.ErrnoException).code ?? "") : ""
    expect(code).not.toBe("EEXIST")
    expect(["ENOTDIR", "ENOENT"]).toContain(code)
  })

  test("a holder does not delete a lock that was stolen from it", async () => {
    // A laptop that suspends mid-install ages the mtime past STALE_LOCK_MS, so a
    // second process legitimately steals the lock. Without an ownership check the
    // ORIGINAL holder's `finally` removes the thief's fresh lock and its heartbeat
    // keeps the file alive — a third installer then joins instead of being
    // serialized. The lock body is the ownership token.
    await freshApp("lock-steal")
    const { withInstallLockResult } = await import("~/lib/update-lock")
    const lock = path.join(process.env.GH_ROUTER_APP_DIR!, "managed-self.lock")
    let release: () => void = () => {}
    const held = withInstallLockResult("managed-self.lock", async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Steal it: replace the file with a different owner's token.
    await fs.writeFile(lock, "thief-token", "utf8")
    release()
    expect((await held).outcome).toBe("ran")
    // The thief's lock survived the original holder's cleanup.
    expect(await fs.readFile(lock, "utf8")).toBe("thief-token")
  })
})

describe("managedEntryPath", () => {
  test("points at the app entry, never the bootstrap", async () => {
    await freshApp("entry-path")
    const entry = managedEntryPath("self", "1.2.3")
    expect(entry).toBe(path.join(versionDir("self", "1.2.3"), "node_modules/github-router/dist/main.js"))
    expect(entry).not.toContain("bin.js")
  })
})

describe("a real npm install (opt-in: GH_ROUTER_TEST_REAL_NPM=1)", () => {
  afterEach(() => {
    __resetManagedTestTarget()
  })

  test.skipIf(!realNpm)(
    "installs, verifies the entry, records provenance, publishes by rename, and points at it",
    async () => {
      await freshApp("real")
      __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })

      const outcome = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
      expect(outcome.kind).toBe("installed")
      expect(outcome.version).toBe("7.0.0")

      const dir = versionDir("self", "7.0.0")
      const entry = path.join(dir, TINY_ENTRY)
      expect(await fs.readFile(entry, "utf8")).toContain("module.exports")

      const marker = await readInstalledMarker("self", "7.0.0")
      expect(marker?.version).toBe("7.0.0")
      expect(marker?.packages?.[`${TINY}@7.0.0`]?.resolved).toContain("registry.npmjs.org")
      expect(marker?.packages?.[`${TINY}@7.0.0`]?.integrity).toStartWith("sha512-")

      const pointer = await readPointer("self")
      expect(pointer?.version).toBe("7.0.0")
      expect(pointer?.entry).toBe(TINY_ENTRY)
      expect(pointer?.entryPath).toBe(entry)

      // No staging left behind (the rename moved it away, and the `finally` is a
      // no-op). A `.staging-*` survivor here would mean the sweep is load-bearing
      // for a bug we have not fixed.
      const survivors = (await fs.readdir(managedRoot("self"))).filter((n) =>
        n.startsWith(".staging-"),
      )
      expect(survivors).toEqual([])
    },
    180_000,
  )

  test.skipIf(!realNpm)(
    "a second install of the same version adopts it instead of re-installing",
    async () => {
      await freshApp("real-adopt")
      __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })
      const first = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
      expect(first.kind).toBe("installed")

      const markerBefore = await fs.stat(path.join(versionDir("self", "7.0.0"), TINY_ENTRY))
      const second = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
      expect(["adopted", "installed"]).toContain(second.kind)
      // The payload is untouched: adopt must not reinstall over a live tree.
      const markerAfter = await fs.stat(path.join(versionDir("self", "7.0.0"), TINY_ENTRY))
      expect(markerAfter.mtimeMs).toBe(markerBefore.mtimeMs)

      const staging = (await fs.readdir(managedRoot("self"))).filter((n) =>
        n.startsWith(".staging-"),
      )
      expect(staging).toEqual([])
    },
    180_000,
  )

  test.skipIf(!realNpm)(
    "a corrupt version dir is moved aside and replaced (the ENOTEMPTY path)",
    async () => {
      await freshApp("real-corrupt")
      __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })
      // A half-written tree: the entry exists but no marker, and a junk file sits
      // in it so `rename` onto it fails ENOTEMPTY.
      const dir = versionDir("self", "7.0.0")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "junk.txt"), "leftover")

      const outcome = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
      expect(outcome.kind).toBe("installed")
      expect(await fs.readFile(path.join(dir, TINY_ENTRY), "utf8")).toContain("module.exports")
      // The junk is gone with the old tree — the new payload is clean.
      expect(await fs.access(path.join(dir, "junk.txt")).then(() => true, () => false)).toBe(false)
      // And the old tree is in a `.trash-*` dir for GC, not silently deleted.
      const trashed = (await fs.readdir(managedRoot("self"))).filter((n) =>
        n.startsWith(".trash-"),
      )
      expect(trashed).toHaveLength(1)
      expect(await fs.readFile(path.join(managedRoot("self"), trashed[0]!, "junk.txt"), "utf8")).toBe(
        "leftover",
      )
    },
    180_000,
  )

  test.skipIf(!realNpm)(
    "a hostile npm_config_* environment still produces a complete install",
    async () => {
      await freshApp("real-hostile")
      __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })
      const hostile: Record<string, string> = {
        npm_config_global: "true",
        npm_config_dry_run: "true",
        npm_config_workspaces: "true",
        npm_config_omit: "optional",
        npm_config_allow_scripts: "is-number",
        npm_config_location: "global",
        npm_config_only: "prod",
      }
      const savedEnv = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]))
      Object.assign(process.env, hostile)
      try {
        const outcome = await ensureManagedInstall({ kind: "self", version: "7.0.0" })
        expect(outcome.kind).toBe("installed")
        expect(await fs.access(path.join(versionDir("self", "7.0.0"), TINY_ENTRY))).toBeDefined()
      } finally {
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    },
    180_000,
  )

  test.skipIf(!realNpm)(
    "a version that does not exist fails without publishing a pointer",
    async () => {
      await freshApp("real-missing")
      __setManagedTestTarget("self", { package: TINY, entry: TINY_ENTRY })
      const outcome = await ensureManagedInstall({ kind: "self", version: "0.0.1-does-not-exist" })
      expect(outcome.kind).toBe("failed")
      expect(outcome.detail).toContain("npm install")
      // The critical property: a failed install must not move the pointer.
      expect(await readPointer("self", { verifyEntry: false })).toBeNull()
      // And it must not leave a version dir that a later probe would adopt.
      expect(
        await fs.access(versionDir("self", "0.0.1-does-not-exist")).then(() => true, () => false),
      ).toBe(false)
    },
    180_000,
  )
})
