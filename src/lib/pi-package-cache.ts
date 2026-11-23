import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { writeFileAtomic } from "./atomic-file"
import { PATHS } from "./paths"
import type { PiPackageEntry } from "./pi-models-settings"

/**
 * Durable npm-package cache for Pi launches, shared by LINK, never by copy.
 *
 * Pi installs the mirror's `packages[]` into `<agentDir>/npm` on every boot,
 * and the agent dir is a fresh per-launch mirror (`pi-agent-<pid>-<rand>`) —
 * so without a cache every launch pays a full registry install (~5s + `added
 * N packages` noise that bypasses `npm_config_loglevel=error`). Pi skips the
 * install when the package dir already exists and the installed version
 * satisfies the configured range — and unpinned `npm:name` specs match ANY
 * installed version — so pointing `<mirror>/npm` at a durable tree makes
 * repeat launches install nothing: faster AND silent.
 *
 * Copies were the original design and the bug. Pre-seeding a mirror with
 * `fs.cp` measured 27 s (88 MB / 14.6k files) and saving it back 32 s, while
 * the launcher arms a 5 s shutdown fail-safe (`setTimeout(exit, 5000)`) around
 * `onShutdown`. Every save was therefore killed mid-`fs.cp`, leaving a
 * truncated entry with a FRESH mtime; the next launch trusted that mtime,
 * copied the truncated tree, Pi found its `packages[]` missing and reinstalled
 * them, and the loop never ended (observed: an entry whose `node_modules`
 * held 7 directories and a lockfile naming 269, so Pi saw "already installed"
 * for nothing it needed and reinstalled everything, every launch). A directory
 * link
 * (`junction` on Windows, works without elevation) is O(1) in both directions
 * and needs no shutdown work at all: Pi installs into the durable entry
 * directly, so the entry is always exactly what a launch left there.
 *
 * The invariant that makes a shared tree safe — `<mirror>/npm` is linked ONLY
 * to an entry that is (a) newly created and empty, (b) verified complete, or
 * (c) complete against the configured package set but still awaiting packages.
 * Never to a stale entry, and never to one known to be internally inconsistent
 * that could not be retired. Every other path leaves `<mirror>/npm` absent, so
 * Pi installs into the per-launch tree exactly as it did before the cache
 * existed. Two consequences worth knowing:
 *
 *  - nothing destructive ever runs on the shutdown path. Seed validates, so a
 *    shutdown could only rediscover what the next seed finds on its own; the
 *    32 s copy this replaces was cut short by the 5 s fail-safe every single
 *    time, and an `rm -rf` of the same tree would be the same bug with a new
 *    verb (5-30 s on Windows with Defender, and it fails partially).
 *  - a tree we must discard is renamed aside first and deleted on the side, so
 *    the launch never waits for the delete and never loses a recoverable tree.
 *
 * Keyed by the exact package set (sorted spec fingerprints), so flag
 * combinations (`--helpers`/`--ui`/`--search`/`--browse`) each get their own
 * entry and can never cross-contaminate. Entries older than the max age are a
 * miss AND are retired — a linked stale tree would let Pi skip the install, so
 * the cache could never refresh — and the launch that missed installs into the
 * new (empty) entry, which is what makes the following launch a hit. Opt out
 * entirely with `GH_ROUTER_PI_NO_PACKAGE_CACHE=1`.
 *
 * Max age defaults to 24h, not the original 7d. Pi resolves an unpinned
 * `npm:name` spec to whatever is already installed, so the max age IS the
 * worst-case staleness of every extension the user runs — a week of it meant a
 * fix published upstream on Monday was still missing the following Sunday.
 * A day bounds the lag without making the cache pointless: the npm install it
 * avoids takes ~5s, so one refresh per day is paid back by every other launch
 * that day. Override with `GH_ROUTER_PI_PACKAGE_CACHE_HOURS`.
 */

export const PI_PACKAGE_CACHE_MAX_AGE_MS = 24 * 3600 * 1000

export const PI_PACKAGE_CACHE_HOURS_ENV = "GH_ROUTER_PI_PACKAGE_CACHE_HOURS"

/**
 * How long a tree renamed aside by `retireEntryTree` waits for the next
 * launch's sweep. The delete is best-effort and runs off the launch path; if it
 * could not finish (a file was held open), the next launch within the hour
 * still finds the trash and finishes the job. Exported for tests.
 */
export const PI_PACKAGE_CACHE_TRASH_TTL_MS = 60 * 60 * 1000

/** Rename target prefix for a retired `node_modules`. */
const TRASH_PREFIX = ".trash-"

/**
 * Marker file recording that the entry's tree passed a full validation, so the
 * O(N) walk (269 keys: 7 ms warm here, 1-3 s against a cold or AV-scanned
 * directory) does not run on every boot. Lives beside `npm/`, not inside it, so
 * writing it cannot disturb `npm/`'s mtime — the freshness clock below.
 */
const STAMP_NAME = ".pi-cache-ok"

const STAMP_SCHEMA_VERSION = 1

/** Bound on concurrent `stat`s during validation (269 keys traded 41 ms → 7 ms). */
const VALIDATION_CONCURRENCY = 32

/** Bounded retries for the off-path delete of a retired tree (Windows sharing). */
const RETIRE_DELETE_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const

/**
 * Effective max age. Read per call rather than at module load so a test (or a
 * long-lived process re-reading config) can change the env and observe it, and
 * so a malformed value degrades to the default instead of `NaN` day math —
 * `Date.now() - mtime > NaN` is always false, which would make every entry
 * eternally fresh.
 */
export function piPackageCacheMaxAgeMs(): number {
  const raw = (process.env[PI_PACKAGE_CACHE_HOURS_ENV] ?? "").trim()
  if (!raw) return PI_PACKAGE_CACHE_MAX_AGE_MS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return PI_PACKAGE_CACHE_MAX_AGE_MS
  return hours * 3600 * 1000
}

/**
 * Whether the cache may be used at all (env opt-out honoured per call, same
 * reason as the max age above). `pi-paths` reads this too, to decide whether
 * `<mirror>/npm` is the launcher's to own, so the two must agree.
 */
export function piPackageCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GH_ROUTER_PI_NO_PACKAGE_CACHE !== "1"
}

/** Stable fingerprint of one `packages[]` entry (order-independent). */
export function piPackageSpecFingerprint(entry: PiPackageEntry): string {
  if (typeof entry === "string") return entry
  const join = (v: ReadonlyArray<string> | undefined): string => [...(v ?? [])].sort().join(",")
  return [
    entry.source,
    `ext:${join(entry.extensions)}`,
    `skills:${join(entry.skills)}`,
    `prompts:${join(entry.prompts)}`,
    `themes:${join(entry.themes)}`,
  ].join("::")
}

/** Order-independent cache key for a launch's full `packages[]` slice. */
export function piPackageCacheKey(packages: ReadonlyArray<PiPackageEntry>): string {
  const specs = packages.map(piPackageSpecFingerprint).sort()
  return createHash("sha256").update(specs.join("\n")).digest("hex").slice(0, 16)
}

export function piPackageCacheDir(key: string): string {
  return path.join(PATHS.APP_DIR, "pi-packages", key)
}

export interface PiPackageSeedResult {
  /** True when the mirror's npm root is a verified, complete tree for this package set. */
  hit: boolean
  /** Path that IS `<mirrorDir>/npm` after this call (link, or plain dir on fallback). */
  npmRoot: string
  /** One line for `--debug` / the launch warning: why it hit or missed. */
  reason: string
}

/**
 * Package NAME a `packages[]` entry asks npm for, or null when the entry is not
 * an npm spec at all (`local:`, `git:`, `https:`, a bare path). `npm:@scope/pkg`
 * keeps its scope; `npm:foo@^1.2.3` loses only the version — the cut is at the
 * last `@` that comes after the last `/`, which is what makes a scoped name
 * survive intact.
 */
function npmPackageName(entry: PiPackageEntry): string | null {
  const source = typeof entry === "string" ? entry : entry.source
  if (!source.startsWith("npm:")) return null
  const rest = source.slice("npm:".length).trim()
  const at = rest.lastIndexOf("@")
  const name = (at > rest.lastIndexOf("/") ? rest.slice(0, at) : rest).trim()
  return name === "" ? null : name
}

/**
 * The package names a cache entry MUST contain to count as complete, sorted and
 * de-duplicated. Derived from the launch's own `packages[]`, never from the
 * entry's lockfile: npm rewrites `.package-lock.json` after every individual
 * `npm install`, and Pi installs one package at a time, so a lock listing 1 of
 * 5 packages is a normal intermediate state. Trusting the lock alone would call
 * a half-installed tree complete — a milder rerun of the bug this file exists
 * to prevent. Non-npm entries are skipped: they are not resolvable by name
 * here and must never make an entry permanently invalid.
 */
export function requiredPackageNames(packages: ReadonlyArray<PiPackageEntry>): Array<string> {
  const names = new Set<string>()
  for (const entry of packages) {
    const name = npmPackageName(entry)
    if (name !== null) names.add(name)
  }
  return [...names].sort()
}

function npmDirOf(root: string): string {
  return path.join(root, "npm")
}

async function mtimeMsOf(dir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(dir)
    return stat.mtimeMs
  } catch {
    return null
  }
}

/** Case-fold on win32 only: junctions reached through a mapped drive differ in case. */
function samePathText(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Do two paths name the same filesystem object? Both sides go through
 * `realpath`, so a link compared against its target matches. A path that does
 * not resolve is never "the same" — a dangling link is exactly the case that
 * must be rejected rather than adopted.
 */
async function samePath(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    fs.realpath(a).catch(() => null),
    fs.realpath(b).catch(() => null),
  ])
  if (left === null || right === null) return false
  return samePathText(left, right)
}

/**
 * Stats fanned out with a hard cap, returning the items whose probe said no (or
 * threw — an unreadable path and a missing one are the same verdict here).
 * Order of the result follows completion, so callers sort before printing.
 */
async function missingOf<T>(
  items: ReadonlyArray<T>,
  probe: (item: T) => Promise<boolean>,
): Promise<Array<T>> {
  const missing: Array<T> = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      // Claimed synchronously before the await, so no two workers see the
      // same index.
      const item = items[cursor++]
      try {
        if (await probe(item)) continue
      } catch {
        // Fall through: the tree does not have what was promised.
      }
      missing.push(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(VALIDATION_CONCURRENCY, items.length) }, worker))
  return missing
}

/** `packages` keys npm wrote into the hidden lockfile, minus the prefix itself. */
function lockPackageKeys(parsed: unknown): Array<string> | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const packagesField = (parsed as { packages?: unknown }).packages
  if (typeof packagesField !== "object" || packagesField === null) return null
  // "" is the install prefix (`<entry>/npm`), not something to stat below
  // node_modules, and it is always present — counting it would inflate the
  // entry count in every message.
  return Object.keys(packagesField).filter((key) => key.length > 0)
}

type CacheEntryVerdict =
  | { ok: true; packages: number; entries: number; lock: "checked" | "absent" }
  | { ok: false; part: "packages" | "lockfile"; reason: string }

/**
 * Is this entry a complete tree for the given package names?
 *
 * Two parts, in order, because the failure modes mean opposite things:
 *
 *  A. Every configured npm package must have
 *     `<entry>/npm/node_modules/<name>/package.json`. A shortfall means "not
 *     installed yet" — another launch may be mid-install, or Pi simply has not
 *     reached that package — so it is a miss the launch can finish, NOT
 *     corruption to destroy.
 *  B. Only then is `.package-lock.json` worth reading, as the record of what
 *     npm wrote for those packages: every key it lists must exist on disk. A
 *     lock that outruns its tree is npm interrupted mid-write (7 dirs against
 *     a 269-key lock), and that entry is worthless.
 *
 * A missing or unparseable lock is UNVERIFIED, not invalid: `package-lock=false`
 * in a user `.npmrc` means the hidden lock is never written at all, and calling
 * that invalid would wipe an 88 MB tree at every boot forever. Part B only ever
 * applies to a lock that exists.
 */
async function validateCacheEntry(
  entryNpm: string,
  requiredNames: ReadonlyArray<string>,
): Promise<CacheEntryVerdict> {
  const nodeModules = path.join(entryNpm, "node_modules")
  const missingPackages = await missingOf(requiredNames, async (name) => {
    const stat = await fs.stat(path.join(nodeModules, name, "package.json"))
    return stat.isFile()
  })
  if (missingPackages.length > 0) {
    const sorted = [...missingPackages].sort()
    const shown = sorted.slice(0, 5).join(", ")
    const more = sorted.length > 5 ? ", …" : ""
    return {
      ok: false,
      part: "packages",
      reason: `cached tree is missing ${sorted.length} of ${requiredNames.length} configured packages (${shown}${more})`,
    }
  }

  let lockKeys: Array<string> | null
  try {
    lockKeys = lockPackageKeys(
      JSON.parse(await fs.readFile(path.join(nodeModules, ".package-lock.json"), "utf8")),
    )
  } catch {
    lockKeys = null
  }
  if (lockKeys === null) {
    return { ok: true, packages: requiredNames.length, entries: 0, lock: "absent" }
  }

  const missingEntries = await missingOf(lockKeys, async (key) => {
    await fs.stat(path.join(entryNpm, key))
    return true
  })
  if (missingEntries.length > 0) {
    return {
      ok: false,
      part: "lockfile",
      reason: `cached tree is missing ${missingEntries.length} lockfile entries`,
    }
  }
  return { ok: true, packages: requiredNames.length, entries: lockKeys.length, lock: "checked" }
}

interface CacheStamp {
  schemaVersion: number
  key: string
  packages: Array<string>
  entries: number
  validatedAt: string
}

function stampPath(entry: string): string {
  return path.join(entry, STAMP_NAME)
}

/**
 * Grace on the stamp's mtime comparison, absorbing the difference between
 * `Date.now()` and the filesystem's timestamp rounding. Five milliseconds is
 * far below any real modification, and a change landing inside it is
 * indistinguishable from the stamp write itself.
 */
const STAMP_MTIME_TOLERANCE_MS = 5

/**
 * Is there a stamp that lets this boot skip the walk? Every condition is a way
 * the claim could be wrong: schema, key, package set and max-age window must
 * all match, and the tree must not have been touched since the stamp was
 * written (`node_modules`'s mtime is the cheap proxy — deleting a package dir
 * or rewriting a lockfile bumps it). That last check is what stops a stamp from
 * vouching for a tree that changed after validation, which is the only way a
 * stale stamp could reintroduce the half-tree this file exists to prevent. One
 * `stat` covers both the "still exists" and "still untouched" halves.
 */
async function stampIsFresh(
  entry: string,
  entryNpm: string,
  key: string,
  names: ReadonlyArray<string>,
): Promise<boolean> {
  let stamp: Partial<CacheStamp>
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(stampPath(entry), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return false
    stamp = parsed as Partial<CacheStamp>
  } catch {
    return false
  }
  if (stamp.schemaVersion !== STAMP_SCHEMA_VERSION) return false
  if (stamp.key !== key) return false
  if (!Array.isArray(stamp.packages) || stamp.packages.length !== names.length) return false
  if (!stamp.packages.every((name, index) => name === names[index])) return false
  if (typeof stamp.entries !== "number") return false
  if (typeof stamp.validatedAt !== "string") return false
  const validatedAt = Date.parse(stamp.validatedAt)
  if (!Number.isFinite(validatedAt)) return false
  if (Date.now() - validatedAt > piPackageCacheMaxAgeMs()) return false
  const nodeModulesMtime = await mtimeMsOf(path.join(entryNpm, "node_modules"))
  if (nodeModulesMtime === null) return false
  return nodeModulesMtime <= validatedAt + STAMP_MTIME_TOLERANCE_MS
}

/** Record a passed validation. Best-effort — an unwritable stamp only costs a scan. */
async function writeStamp(
  entry: string,
  key: string,
  names: ReadonlyArray<string>,
  entries: number,
): Promise<void> {
  const stamp: CacheStamp = {
    schemaVersion: STAMP_SCHEMA_VERSION,
    key,
    packages: [...names],
    entries,
    validatedAt: new Date().toISOString(),
  }
  try {
    await writeFileAtomic(stampPath(entry), `${JSON.stringify(stamp)}\n`, { mode: 0o600 })
  } catch (err) {
    consola.debug("Pi package cache: could not write the validation stamp:", err)
  }
}

/**
 * Drop the stamp. Called before every destructive step so a wipe can never
 * leave a stamp claiming the wiped tree is fine; the next launch then re-walks
 * and re-stamps honestly.
 */
async function dropStamp(entry: string): Promise<void> {
  try {
    await fs.rm(stampPath(entry), { force: true })
  } catch (err) {
    consola.debug("Pi package cache: could not drop the validation stamp:", err)
  }
}

/**
 * Is another LIVE launch using this entry? Returns its PID, else null.
 *
 * Load-bearing now that the tree is shared: deleting a target leaves every
 * junction to it dangling (verified — junctions do not error when their target
 * disappears), and `mkdir` does not recreate the target, so Pi's own install
 * then fails at boot with ENOENT instead of falling back to a cold cache.
 *
 * Deliberately not a cross-process lock. A lock would serialise launches and
 * make the second one pay a full install anyway, for a case that only arises
 * when an entry is stale or corrupt while a session still runs from it. This
 * guard is conservative in the safe direction (an unreadable PID counts as
 * alive, and PID reuse can only cost one launch its shared tree), needs no
 * clock skew or hostname logic, and cannot deadlock.
 */
async function entryInUseByOtherLaunch(entryNpm: string): Promise<number | null> {
  const target = await fs.realpath(entryNpm).catch(() => null)
  if (target === null) return null // Nothing there yet, so nobody can be using it.
  // Mirrors live under the same app dir the cache entries do, in `pi-paths`.
  const mirrorsRoot = path.join(PATHS.APP_DIR, "pi-mirrors")
  let mirrors: Array<string>
  try {
    mirrors = await fs.readdir(mirrorsRoot)
  } catch {
    return null
  }
  for (const name of mirrors) {
    const match = /^pi-agent-(\d+)-[0-9a-f]+$/.exec(name)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    if (!Number.isFinite(pid) || pid === process.pid) continue
    const link = path.join(mirrorsRoot, name, "npm")
    try {
      if (!(await fs.lstat(link)).isSymbolicLink()) continue
    } catch {
      continue
    }
    const resolved = await fs.realpath(link).catch(() => null)
    if (resolved === null || !samePathText(resolved, target)) continue
    if (isPidAlive(pid)) return pid
  }
  return null
}

/**
 * Only `ESRCH` (and the `ENOENT` some platforms report for a vanished pid) mean
 * "gone". `EPERM` from another user's process and `EINVAL` both mean the
 * process is there and we may not signal it — counting those as dead would
 * delete a tree out from under a live session.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code !== "ESRCH" && code !== "ENOENT"
  }
}

/**
 * Move an entry's `node_modules` out of the way without waiting on a delete.
 *
 * `rm -rf` of this tree is what a shutdown copy used to be followed by, and on
 * Windows with Defender it takes 5-30 s and fails partially, which would put the
 * same overrun on the launch path. A rename is atomic or it does nothing:
 * measured here, it fails with EPERM when a child file is held open, so the
 * fallback is an in-place delete — but the common case (nothing holding it) is
 * instant and the tree stays recoverable until the off-path delete lands.
 *
 * A fresh empty `node_modules` is always recreated so npm has a prefix, and the
 * stamp is always dropped. `<entry>` itself is never removed.
 */
async function retireEntryTree(entry: string, entryNpm: string): Promise<void> {
  const nodeModules = path.join(entryNpm, "node_modules")
  await dropStamp(entry)
  const trash = path.join(entryNpm, `${TRASH_PREFIX}${Date.now()}-${randomBytes(4).toString("hex")}`)
  let renamed = false
  try {
    await fs.rename(nodeModules, trash)
    renamed = true
  } catch (err) {
    consola.debug("Pi package cache: could not move the tree aside, deleting in place:", err)
  }
  if (!renamed) {
    try {
      await fs.rm(nodeModules, RETIRE_DELETE_OPTS)
    } catch (err) {
      consola.debug("Pi package cache: in-place delete did not finish:", err)
    }
  }
  try {
    await fs.mkdir(nodeModules, { recursive: true })
  } catch (err) {
    consola.debug("Pi package cache: could not recreate node_modules:", err)
    return
  }
  if (!renamed) return
  // Off the launch path on purpose: the tree is already out of the way, so the
  // bytes can go whenever they go. A failure here is the next sweep's problem.
  void fs.rm(trash, RETIRE_DELETE_OPTS).catch((err: unknown) => {
    consola.debug("Pi package cache: retired tree will be collected later:", err)
  })
}

/**
 * Forget npm's own bookkeeping at the entry root, used when the tree is retired
 * for staleness: a root lockfile still describing the retired tree would let
 * the next install resolve the OLD versions, which is the opposite of what a
 * stale retirement is for. Cheap (two small files), and only when the tree is
 * already being thrown away.
 */
async function forgetEntryManifests(entryNpm: string): Promise<void> {
  await Promise.all(
    ["package.json", "package-lock.json"].map((name) =>
      fs.rm(path.join(entryNpm, name), { force: true }).catch(() => undefined),
    ),
  )
}

/**
 * Collect trees retired in past launches. Best-effort, never awaited by the
 * caller: junk older than an hour is deleted in the background, and whatever
 * refuses to go is retried on the next boot.
 */
function collectRetiredTrees(entryNpm: string): void {
  void (async () => {
    let names: Array<string>
    try {
      names = await fs.readdir(entryNpm)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(TRASH_PREFIX))
        .map(async (name) => {
          const dir = path.join(entryNpm, name)
          try {
            const stat = await fs.stat(dir)
            if (Date.now() - stat.mtimeMs < PI_PACKAGE_CACHE_TRASH_TTL_MS) return
            await fs.rm(dir, RETIRE_DELETE_OPTS)
          } catch (err) {
            consola.debug(`Pi package cache: retired tree ${name} not collected yet:`, err)
          }
        }),
    )
  })().catch((err: unknown) => {
    consola.debug("Pi package cache: trash collection skipped:", err)
  })
}

/** Remove whatever sits at the mirror's npm path, link or real dir. */
async function clearMirrorNpm(mirrorNpm: string): Promise<void> {
  try {
    const stat = await fs.lstat(mirrorNpm)
    // `unlink` on a link removes only the link; the entry it pointed at is
    // untouched either way.
    if (stat.isSymbolicLink()) await fs.unlink(mirrorNpm)
    else await fs.rm(mirrorNpm, { recursive: true, force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") consola.debug("Pi package cache: could not clear the mirror's npm path:", err)
  }
}

/**
 * Is `<mirror>/npm` already the link we would plant? Checked before every
 * link and before every clear, so a second call in the same launch reuses the
 * link instead of unlinking and recreating it (churn, and a window in which
 * the mirror has no npm root at all).
 */
async function linkIsCorrect(mirrorNpm: string, entryNpm: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(mirrorNpm)).isSymbolicLink()) return false
  } catch {
    return false
  }
  return samePath(mirrorNpm, entryNpm)
}

/**
 * Make sure nothing but our link sits at `<mirror>/npm`.
 *
 * This path is inside the per-launch mirror, which this module owns: it is
 * created by `ensurePiAgentMirror`, swept by PID on the next launch, and never
 * holds a user file (the user's own `npm` tree is deliberately not mirrored —
 * see `SKIP` in `pi-paths`). So a real dir or file here is either a tree a
 * previous launch installed into after a fallback, or debris from an earlier
 * call in this process, and replacing it is safe.
 */
async function prepareMirrorNpm(mirrorNpm: string, entryNpm: string): Promise<void> {
  try {
    await fs.lstat(mirrorNpm)
  } catch {
    return // ENOENT — nothing to prepare.
  }
  if (await linkIsCorrect(mirrorNpm, entryNpm)) return
  await clearMirrorNpm(mirrorNpm)
}

type LinkOutcome = { ok: true } | { ok: false; reason: string }

const SYMLINK_FALLBACK_REASON = "symlink unavailable; this launch installs into its own tree"
const LINK_MISMATCH_REASON =
  "symlink does not resolve to the cache entry; this launch installs into its own tree"

/**
 * Plant `<mirror>/npm` -> `<entry>/npm` and prove it stuck.
 *
 * The link is the whole mechanism, so its failure must degrade, never fail: an
 * EPERM (no junction privilege), an EACCES, or a filesystem that refuses
 * symlinks means this launch installs into its own tree exactly as it did
 * before the cache existed. The `realpath` check afterwards is the only defence
 * against a link we did not plant (a stale one, or one pre-created at that
 * path) being adopted as if it were the cache.
 */
async function linkEntry(entryNpm: string, mirrorNpm: string): Promise<LinkOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reuse first: `prepareMirrorNpm` has already cleared anything wrong, so an
    // existing correct link just needs proving, not replacing.
    if (await linkIsCorrect(mirrorNpm, entryNpm)) return { ok: true }
    try {
      await fs.symlink(entryNpm, mirrorNpm, process.platform === "win32" ? "junction" : "dir")
      break
    } catch (err) {
      // A second attempt is worth it when something stale sits at the path (a
      // dangling link still answers `realpath` with ENOENT, so the reuse check
      // above cannot see it, and `symlink` then refuses with EEXIST).
      if (attempt === 1) {
        consola.debug("Pi package cache: symlink unavailable:", err)
        // A refused symlink can still leave a stub behind on some filesystems.
        await fs.rm(mirrorNpm, { recursive: true, force: true }).catch(() => undefined)
        return { ok: false, reason: SYMLINK_FALLBACK_REASON }
      }
      await clearMirrorNpm(mirrorNpm)
    }
  }
  if (!(await samePath(mirrorNpm, entryNpm))) {
    consola.debug(`Pi package cache: ${mirrorNpm} does not resolve to ${entryNpm}; unlinking it.`)
    await fs.unlink(mirrorNpm).catch(() => undefined)
    return { ok: false, reason: LINK_MISMATCH_REASON }
  }
  return { ok: true }
}

function seedResult(mirrorNpm: string, hit: boolean, reason: string): PiPackageSeedResult {
  return { hit, npmRoot: mirrorNpm, reason }
}

/**
 * Point `<mirror>/npm` at the durable entry for this package set, verifying it
 * first. Never copies a tree (that is what the 5 s shutdown budget used to
 * truncate), never deletes on the launch path without renaming aside first, and
 * never throws: a cache that cannot be set up leaves the mirror with no `npm`
 * at all, so this launch installs into its own tree.
 */
export async function seedPiPackageCache(
  mirrorDir: string,
  packages: ReadonlyArray<PiPackageEntry>,
): Promise<PiPackageSeedResult> {
  const mirrorNpm = npmDirOf(mirrorDir)
  if (!piPackageCacheEnabled()) return seedResult(mirrorNpm, false, "cache disabled")
  const key = piPackageCacheKey(packages)
  const entry = piPackageCacheDir(key)
  const entryNpm = npmDirOf(entry)
  const names = requiredPackageNames(packages)
  const maxAge = piPackageCacheMaxAgeMs()
  try {
    await fs.mkdir(mirrorDir, { recursive: true })
    collectRetiredTrees(entryNpm)
    await prepareMirrorNpm(mirrorNpm, entryNpm)

    const inUseReason = (pid: number): PiPackageSeedResult => {
      consola.debug(`Pi package cache ${key}: entry is in use by launch ${pid}; leaving it alone.`)
      return seedResult(
        mirrorNpm,
        false,
        `cache entry is in use by launch ${pid}; this launch installs into its own tree`,
      )
    }

    const mtime = await mtimeMsOf(entryNpm)
    if (mtime !== null && Date.now() - mtime > maxAge) {
      // Never link a stale tree: Pi would see satisfying versions, install
      // nothing, and the entry would keep its old mtime — stale forever.
      const holder = await entryInUseByOtherLaunch(entryNpm)
      if (holder !== null) {
        await clearMirrorNpm(mirrorNpm)
        return inUseReason(holder)
      }
      const ageHours = Math.floor((Date.now() - mtime) / 3600000)
      const stale = `cached tree was stale (${ageHours}h old, max ${Math.round(maxAge / 3600000)}h)`
      consola.debug(`Pi package cache ${key}: ${stale}; retiring it and refilling from the registry.`)
      await retireEntryTree(entry, entryNpm)
      await forgetEntryManifests(entryNpm)
      const link = await linkEntry(entryNpm, mirrorNpm)
      return seedResult(mirrorNpm, false, link.ok ? stale : link.reason)
    }

    if (mtime === null) {
      // Cold: the entry is created empty and Pi installs into it, which is what
      // makes the next launch a hit.
      await fs.mkdir(entryNpm, { recursive: true })
      await dropStamp(entry)
      const link = await linkEntry(entryNpm, mirrorNpm)
      return seedResult(
        mirrorNpm,
        false,
        link.ok ? "no cached tree for this package set" : link.reason,
      )
    }

    if (await stampIsFresh(entry, entryNpm, key, names)) {
      const link = await linkEntry(entryNpm, mirrorNpm)
      return seedResult(
        mirrorNpm,
        link.ok,
        link.ok ? `cached tree verified (${names.length} packages, stamp)` : link.reason,
      )
    }

    const verdict = await validateCacheEntry(entryNpm, names)
    if (!verdict.ok) {
      consola.debug(`Pi package cache ${key}: ${verdict.reason}`)
      // Whatever the verdict, the stamp must go: the tree just disagreed with
      // its own record, and a stamp that survived that would be a claim nobody
      // re-checked.
      await dropStamp(entry)
      if (verdict.part === "lockfile") {
        // A lock that outruns its own tree is worth nothing and must not be
        // handed to Pi half-populated. A shortfall against the configured set
        // is a normal intermediate state, so that tree stays and this launch's
        // install finishes it.
        const holder = await entryInUseByOtherLaunch(entryNpm)
        if (holder !== null) {
          await clearMirrorNpm(mirrorNpm)
          return inUseReason(holder)
        }
        await retireEntryTree(entry, entryNpm)
      }
      const link = await linkEntry(entryNpm, mirrorNpm)
      return seedResult(mirrorNpm, false, link.ok ? verdict.reason : link.reason)
    }

    await writeStamp(entry, key, names, verdict.entries)
    const detail = verdict.lock === "absent" ? "no lockfile" : "full scan"
    const link = await linkEntry(entryNpm, mirrorNpm)
    return seedResult(
      mirrorNpm,
      link.ok,
      link.ok ? `cached tree verified (${verdict.packages} packages, ${detail})` : link.reason,
    )
  } catch (err) {
    consola.debug("Pi package cache seed skipped:", err)
    return seedResult(mirrorNpm, false, "cache setup failed; this launch installs into its own tree")
  }
}

/**
 * Sweep cache entries whose `npm/` tree is older than the max age. Best-effort,
 * never throws. Runs opportunistically at boot — and skips entries another live
 * launch is installing into, for the dangling-link reason spelled out on
 * `entryInUseByOtherLaunch`.
 */
export async function sweepStalePiPackageCaches(): Promise<void> {
  if (!piPackageCacheEnabled()) return
  const root = path.join(PATHS.APP_DIR, "pi-packages")
  let entries: Array<string>
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryDir = path.join(root, entry)
      const npmDir = npmDirOf(entryDir)
      try {
        const holder = await entryInUseByOtherLaunch(npmDir)
        if (holder !== null) {
          consola.debug(`Pi package cache sweep: skipping ${entry}, in use by launch ${holder}.`)
          return
        }
        const mtime = await mtimeMsOf(npmDir)
        if (mtime === null || Date.now() - mtime > piPackageCacheMaxAgeMs()) {
          await fs.rm(entryDir, { recursive: true, force: true })
        }
      } catch (err) {
        consola.debug(`Pi package cache sweep: skipping ${entry}:`, err)
      }
    }),
  )
}
