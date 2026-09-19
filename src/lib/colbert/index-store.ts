/**
 * ColBERT index store: router-owned sidecar metadata, the per-query
 * freshness verdict (git HEAD / dirty check), the `COLGREP_DATA_DIR`
 * derivation, and the debounce ledger for background `init` builds.
 *
 * colgrep owns the PHYSICAL index dir (keyed by xxh3(path|model) under
 * COLGREP_DATA_DIR) and its own incremental updater. We do NOT key the
 * physical dir by commit — that would force a full rebuild per commit.
 * Instead the router keeps a tiny metadata sidecar per workspace and
 * computes a freshness verdict on each query so we never LABEL a stale
 * result as `ready` (design §4, Risk #3).
 *
 * Staleness model:
 *   - `fresh`  ⇔ status ready AND HEAD == lastIndexedHead AND tree not
 *               dirtier than it was at index time. → serve semantic.
 *   - `stale`  ⇔ status ready but HEAD moved (branch switch / commits)
 *               OR the working tree is dirty since the last index. →
 *               honest `stale` notice, NO results (per the dropped-
 *               fallback contract — we do NOT silently re-search).
 *   - non-git workspace → no lastIndexedHead; freshness falls back to
 *     mtime reasoning, which is exactly colgrep's own incremental signal,
 *     so a clean ready index is treated as fresh.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { runManagedExeCapture } from "../exec"
import { resolveExecutable } from "../exec"
import { PATHS } from "../paths"

import { colgrepBinAsset, MODEL_ID, ortLibAsset } from "./manifest"
import { isPidAlive } from "./lifecycle"
import { canonicalColbertModelDir } from "./provision"

/** Sidecar metadata per workspace. Router-owned; colgrep never reads it. */
export interface ColbertMeta {
  workspace: string
  model: string
  modelRev: string
  /** Engine-change triggers: a change forces a full rebuild. */
  binarySha?: string
  ortSha?: string
  status: "absent" | "building" | "ready" | "failed"
  lastIndexedHead?: string
  lastIndexedDirty?: boolean
  lastIndexedAt?: string
  /** Why the last build failed (drives the self-heal vs operator-actionable
   * decision). `crashed` = the build PID died without writing a result
   * (proxy kill / OOM); `stuck` = the inactivity watchdog killed a hung
   * build; `corrupt` = physical PLAID shards are incoherent;
   * `error` = colgrep non-zero exit; `launch` = spawn threw. */
  failureClass?: "crashed" | "stuck" | "corrupt" | "error" | "launch"
  /** Consecutive failed build attempts; reset to 0 on a successful build.
   * Caps the self-heal so a persistently-failing workspace stops retrying. */
  failedAttempts?: number
  /**
   * The inputs in effect when the current failure streak was recorded.
   *
   * `failedAttempts` is evidence about a SPECIFIC set of inputs, not a
   * permanent verdict on the workspace. Without this, a streak that reaches
   * the cap is terminal for the life of the process — a build that failed on
   * one bad commit, or under an old colgrep binary, would keep vetoing
   * retries long after the cause was gone. Comparing these against the
   * current state lets `handleFailure` tell "the same inputs failed again"
   * from "the inputs changed, so the streak is stale".
   *
   * Deliberately separate from `lastIndexedHead` / `lastIndexedDirty`: those
   * mean "what we successfully indexed" on the ready path and feed the
   * git-freshness comparison, so reusing them would entangle failure-reset
   * with freshness.
   */
  failedAt?: {
    head?: string
    dirty?: boolean
    binarySha?: string
    ortSha?: string
    modelRev?: string
  }
  /**
   * Which router-bug epoch this entry was last reconciled against. A sidecar
   * behind `WATCHDOG_EPOCH` has its watchdog-attributed failure streak
   * cleared once — see `applyWatchdogEpoch`. Absent on entries written before
   * this field existed, which is exactly the population that needs the reset.
   */
  watchdogEpoch?: number
  /** Owning `init` PID (boot-sweep reclassification). */
  buildPid?: number
  /** Per-proxy-run UUID (ownership disambiguation for the boot sweep). */
  ownerInstanceId?: string
}

export type Freshness =
  | "fresh"
  | "stale"
  | "absent"
  | "building"
  | "crashed"
  | "corrupt"
  | "failed"

const GIT_TIMEOUT_MS = 4000

/** Grace window after a `building` write before a workspace with no live
 * build PID is declared `crashed` — covers the cross-process window where
 * one proxy wrote `building` but hasn't yet recorded the colgrep child PID. */
const BUILD_SPAWN_GRACE_MS = 30_000

/**
 * Hash a workspace path the same way the metadata sidecar is keyed.
 * NOTE: this is the ROUTER-OWNED meta key, independent of colgrep's
 * internal xxh3 physical-dir key (we never need to predict colgrep's
 * key because we pass the workspace as colgrep's PATH arg and let it
 * route). A stable sha256-prefix of the canonical path is sufficient.
 */
export function metaHashForWorkspace(workspace: string): string {
  // ONE identity function for every surface (see `canonicalWorkspace`). This
  // previously resolved+folded WITHOUT realpath, so a workspace reached
  // through a symlink got a different sidecar key than the project-dir
  // lookup derived — two meta files, one physical index, and one of them
  // permanently reporting `absent`. That is the macOS `/var`→`/private/var`
  // shape, and it hits every temp workspace there.
  const canonical = canonicalWorkspace(workspace)
  // Cheap FNV-1a 32-bit → hex; collision risk negligible for the small
  // number of workspaces a single user touches, and the file content
  // also carries the full `workspace` path for disambiguation.
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

function metaPath(workspace: string): string {
  return path.join(PATHS.COLBERT_META_DIR, `${metaHashForWorkspace(workspace)}.json`)
}

/** Read the sidecar metadata for a workspace (null if none yet). */
/**
 * Bump this when a router-side bug could have written a failure verdict that
 * was never the workspace's fault. A sidecar stamped with an older epoch gets
 * its watchdog-attributed streak cleared ONCE, then is stamped forward.
 *
 * Epoch 1: the fail-safe-probe fix. Before it, `indexDirSignature` could not
 * match colgrep's Windows extended-length `project_path`, so the inactivity
 * watchdog killed healthy builds and recorded `stuck` — which is refused
 * forever at a cap of 2. Those users are still capped after upgrading,
 * because the existing reset triggers on git/model/engine inputs and none of
 * those changed. This is the only thing that un-sticks them.
 * Epoch 2: widened to include `corrupt`, once it became clear the identity
 * bug MANUFACTURED corrupt verdicts (a null project-dir lookup was recorded
 * as corruption).
 *
 * Epoch 3: clearing the streak was not enough — `freshnessVerdict` returns
 * `failed` straight off `meta.status`, before it looks at the disk, so a
 * zeroed counter still short-circuited every query. The reset now drops the
 * status as well.
 *
 * Epoch 4: the shard-tiling validator false-positived on every
 * incrementally-updated index (`embedding_offset` is a write-cursor
 * artifact, never a read invariant — verified against next-plaid v1.7.0
 * source), manufacturing `corrupt` verdicts that quarantine+delete looped
 * deterministically into capped `failed`. Any stored `corrupt` streak may
 * be this bug, so it clears once like the rest.
 */
const WATCHDOG_EPOCH = 4

/**
 * Failure classes the router-side bugs could have manufactured.
 *
 * `stuck`/`crashed` came from the blind watchdog. `corrupt` belongs here too,
 * which is not obvious: `repairCorruptIndex` recorded `failureClass:"corrupt"`
 * whenever `colbertProjectDir` returned null, and a null lookup is exactly
 * what the identity bug produced for a perfectly healthy index. So a stored
 * `corrupt` is not reliable evidence about the workspace — it may be evidence
 * about us. Observed on the machine where this was diagnosed: a `corrupt`
 * marker sitting next to an index that validates as coherent with 15 shards
 * and 1.24M embeddings.
 *
 * Clearing it is safe because it only resets the STREAK. The next query still
 * re-derives the verdict from the shards on disk, so an index that really is
 * corrupt is re-detected immediately and quarantined as before.
 *
 * `launch` stays excluded: a spawn failure (missing binary, unrunnable ORT)
 * is genuinely about the environment, and the existing engine-sha reset
 * already covers the case where an upgrade fixes it.
 */
const EPOCH_CLEARABLE = new Set(["stuck", "crashed", "corrupt"])

/**
 * Clear a stale failure streak that a router-side bug produced.
 *
 * Bounded by construction: it fires only while the stored epoch is behind,
 * and the caller stamps the current epoch on the next write, so it is one
 * reset per epoch bump rather than a reset loop.
 */
function applyWatchdogEpoch(meta: ColbertMeta): ColbertMeta {
  if ((meta.watchdogEpoch ?? 0) >= WATCHDOG_EPOCH) return meta
  const clearable =
    meta.status === "failed"
    && meta.failureClass !== undefined
    && EPOCH_CLEARABLE.has(meta.failureClass)
  if (!clearable) return { ...meta, watchdogEpoch: WATCHDOG_EPOCH }
  // Clear the STATUS too, not just the streak. `freshnessVerdict` returns
  // `failed` straight off `meta.status` before it ever looks at the disk, so
  // zeroing the counter alone leaves the workspace exactly as dead — the
  // marker still short-circuits every query. Dropping to `ready` makes the
  // next verdict re-derive from the shards on disk: a genuinely corrupt or
  // missing index is re-detected immediately and re-quarantined, and a
  // healthy one finally becomes visible again.
  return {
    ...meta,
    watchdogEpoch: WATCHDOG_EPOCH,
    status: "ready",
    failureClass: undefined,
    failedAttempts: 0,
    failedAt: undefined,
  }
}

export async function readColbertMeta(
  workspace: string,
): Promise<ColbertMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(workspace), "utf8")
    const parsed = JSON.parse(raw) as ColbertMeta
    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
      return applyWatchdogEpoch(parsed)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Per-workspace write serializer. `runInit` issues a pre-spawn
 * `building` write, an `onSpawn` write that patches in the colgrep child
 * PID, and a final `ready`/`failed` write. Chaining them per workspace
 * guarantees the final write lands AFTER the (fire-and-forget) onSpawn
 * write, so a `ready` result is never clobbered back to `building` by a
 * late atomic-rename.
 */
const _metaWriteChains = new Map<string, Promise<void>>()

/** Atomically write the sidecar metadata for a workspace (serialized). */
export async function writeColbertMeta(meta: ColbertMeta): Promise<void> {
  const key = metaHashForWorkspace(meta.workspace)
  const prev = _metaWriteChains.get(key) ?? Promise.resolve()
  const next = prev.then(() => writeColbertMetaUnchained(meta))
  // Swallow chain-internal errors so one failed write doesn't poison the
  // chain for subsequent callers; each call still sees its own rejection.
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  _metaWriteChains.set(key, settled)
  // Drop the entry once this write settles AND nothing newer took its place.
  // Without this the map grows one permanent entry per distinct workspace for
  // the life of the process — unbounded under `serve`, which handles many.
  // The identity check is what makes it safe: a newer chain for the same key
  // must not be evicted, or two writers would stop being serialized.
  // (Same pattern as `serializeWrite` in `~/lib/first-mate/durable-store`.)
  void settled.then(() => {
    if (_metaWriteChains.get(key) === settled) _metaWriteChains.delete(key)
  })
  return next
}

async function writeColbertMetaUnchained(meta: ColbertMeta): Promise<void> {
  await fs.mkdir(PATHS.COLBERT_META_DIR, { recursive: true })
  const dest = metaPath(meta.workspace)
  // Stamp the current epoch on every write. Without this the read-side reset
  // would re-fire on each read (it would keep seeing a behind-epoch entry),
  // turning a one-shot recovery into an unbounded loop.
  const stamped: ColbertMeta = { ...meta, watchdogEpoch: WATCHDOG_EPOCH }
  const tmp = `${dest}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(stamped, null, 2))
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Whether a COMPLETED colgrep index exists on disk for this workspace.
 * The preflight uses this to distinguish `building`/`absent` (no
 * completed index → don't spawn a foreground colgrep) from a real
 * index. We scan COLGREP_DATA_DIR for any per-project dir containing a
 * `project.json` whose canonical path matches this workspace AND an
 * `index/metadata.json` marker.
 */
export async function colbertProjectDir(workspace: string): Promise<string | null> {
  const indicesDir = PATHS.COLBERT_INDICES_DIR
  let names: Array<string>
  try {
    names = await fs.readdir(indicesDir)
  } catch {
    return null
  }
  const wantCanonical = await realpathForCompare(workspace)
  for (const name of names) {
    if (name === ".gh-router-meta" || name.includes(".corrupt-")) continue
    const dir = path.join(indicesDir, name)
    let proj: { path?: string; project_path?: string; model?: string }
    try {
      proj = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"))
    } catch {
      continue
    }
    const projPath = proj.path ?? proj.project_path
    if (!projPath || (await realpathForCompare(projPath)) !== wantCanonical) continue
    // The raw model spelling is part of colgrep's project key. Require the
    // exact proxy spelling so a slash-variant legacy key is never selected.
    if (proj.model !== canonicalColbertModelDir()) {
      continue
    }
    return dir
  }
  return null
}

export type IndexIntegrity =
  | { verdict: "not-built" }
  | { verdict: "coherent"; shardCount: number; embeddingCount: number }
  | { verdict: "suspect"; reason: string }
  | { verdict: "corrupt"; reason: string }

/**
 * Validate PLAID shard metadata readability — NOT tiling.
 *
 * Deliberately NOT a contiguity check: `embedding_offset` is a write-cursor
 * artifact for incremental appends, never a read invariant. Verified against
 * next-plaid v1.7.0 source: the sole read of `embedding_offset` anywhere
 * (next-plaid `update.rs`, append-to-last cursor) is on the WRITE path;
 * search reads the merged concatenation + SQLite doc mapping, neither of
 * which consults offsets. Incremental updates (and worktree-seed +
 * reconcile) legitimately leave non-tiling layouts — overlapping and
 * gapped intervals on a colgrep-healthy index (observed live: 23 shards,
 * search serving correctly, zero SQLite doc duplicates).
 *
 * The previous tiling check therefore false-positived on every
 * incrementally-updated index, and the quarantine+delete+rebuild response
 * re-seeded into the identical layout deterministically — a self-
 * perpetuating failure loop ending in capped `failed`. Corrupt is now
 * reserved for genuinely unreadable stores (which colgrep itself cannot
 * load either).
 */
export function validateIndexIntegrity(projectIndexDir: string): IndexIntegrity {
  let names: Array<string>
  try {
    names = readdirSync(projectIndexDir).filter((name) => /^\d+\.metadata\.json$/.test(name))
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { verdict: "not-built" }
      : { verdict: "corrupt", reason: "index directory unreadable" }
  }
  if (names.length === 0) return { verdict: "not-built" }

  let sum = 0
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(projectIndexDir, name), "utf8")) as {
        embedding_offset?: unknown
        num_embeddings?: unknown
      }
      const start = parsed.embedding_offset
      const count = parsed.num_embeddings
      if (
        typeof start !== "number" ||
        typeof count !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        start < 0 ||
        count < 0
      ) {
        return { verdict: "corrupt", reason: `invalid shard metadata: ${name}` }
      }
      sum += count
    } catch {
      return { verdict: "corrupt", reason: `unreadable shard metadata: ${name}` }
    }
  }

  return { verdict: "coherent", shardCount: names.length, embeddingCount: sum }
}

export async function completedIndexOnDisk(workspace: string): Promise<boolean> {
  const projectDir = await colbertProjectDir(workspace)
  if (!projectDir) return false
  return validateIndexIntegrity(path.join(projectDir, "index")).verdict !== "not-built"
}

/**
 * Strip a Windows extended-length prefix.
 *
 * `\\?\Q:\dir` → `Q:\dir`, and `\\?\UNC\server\share` → `\\server\share`
 * (naively slicing 4 there would yield the relative `UNC\server\share`).
 * colgrep stores `project_path` in this form — 50 of 53 dirs on the machine
 * where this was diagnosed — so every comparison against its `project.json`
 * has to account for it.
 */
function stripExtendedPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`
  if (p.startsWith("\\\\?\\")) return p.slice(4)
  return p
}

/**
 * Is the volume holding `p` case-insensitive?
 *
 * Probed at runtime rather than inferred from `process.platform`, because
 * the platform is wrong in both directions: APFS can be formatted
 * case-SENSITIVE (folding there merges two genuinely distinct workspaces),
 * and Linux routinely mounts case-INSENSITIVE volumes such as exfat/NTFS
 * (not folding there splits one workspace into two identities).
 *
 * Cheap and memoized per filesystem root: stat the path back through a
 * case-flipped spelling of its own basename. Falls back to the platform
 * default only when the probe itself cannot run.
 */
const _caseInsensitiveByRoot = new Map<string, boolean>()

function volumeIsCaseInsensitive(p: string): boolean {
  const root = path.parse(path.resolve(p)).root || path.sep
  const cached = _caseInsensitiveByRoot.get(root)
  if (cached !== undefined) return cached

  const platformDefault =
    process.platform === "win32" || process.platform === "darwin"
  let result = platformDefault
  try {
    // Walk up to the nearest existing ancestor so a not-yet-created
    // workspace still probes its real volume.
    let probe = path.resolve(p)
    for (let i = 0; i < 64 && !existsSync(probe); i++) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    const base = path.basename(probe)
    if (base && /[a-z]/i.test(base)) {
      const flipped =
        base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase()
      const sibling = path.join(path.dirname(probe), flipped)
      result = existsSync(sibling)
    }
  } catch {
    // Keep the platform default.
  }
  _caseInsensitiveByRoot.set(root, result)
  return result
}

/** Test-only: clear the memoized per-volume case-sensitivity probe. */
export function __resetCaseProbeForTests(): void {
  _caseInsensitiveByRoot.clear()
}

/**
 * THE canonical identity for a workspace. Every surface that answers "is this
 * the same workspace?" — the meta sidecar key, the colgrep project-dir lookup,
 * the watchdog signature, the init/search locks, and the argument handed to
 * colgrep — must go through this and nothing else.
 *
 * They previously disagreed four different ways, and the disagreement is what
 * made a healthy index invisible: colgrep writes `\\?\Q:\...`, the lookup
 * normalized it to `//?/q:/...`, and nothing ever matched.
 *
 * Order matters: realpath FIRST (it resolves symlinks — the macOS
 * `/var`→`/private/var` and `/tmp`→`/private/tmp` shapes — expands 8.3 short
 * names, and returns the true on-disk casing), THEN strip any extended-length
 * prefix from the *result*. `realpathSync.native` was measured to already
 * return a clean `Q:\Software\github-router` for all input spellings, so the
 * strip is belt-and-braces rather than load-bearing; it costs nothing and
 * covers the fallback path where realpath could not run at all.
 */
export function canonicalWorkspace(p: string): string {
  let out = stripExtendedPrefix(p)
  try {
    // `.native` (GetFinalPathNameByHandleW / realpath(3)) — NOT the JS
    // variant, which leaves the `\\?\` prefix intact, does not expand 8.3
    // names, and preserves caller casing instead of the on-disk truth.
    out = stripExtendedPrefix(realpathSync.native(out))
  } catch {
    // The leaf is not on disk (a workspace about to be created, deleted, or
    // on an unmounted volume). Resolving the NEAREST EXISTING ANCESTOR and
    // re-appending the remainder keeps the key STABLE across that boundary.
    //
    // Falling back to the raw path instead would make a workspace's identity
    // change the moment it disappears: under a symlinked parent — which is
    // every temp workspace on macOS, where `/var` → `/private/var` — the live
    // key resolves through the link and the post-deletion key does not. The
    // sidecar written while it existed then becomes unfindable, so the boot
    // sweep cannot reap it and a re-created workspace starts from a different
    // key than its own index. Caught by macOS CI on the first run.
    out = resolveThroughExistingAncestor(out)
  }
  out = path.resolve(out)
  if (volumeIsCaseInsensitive(out)) out = out.toLowerCase()
  // Separator-normalize so `Q:\x` and `Q:/x` are one key. Harmless on POSIX,
  // where backslash is a legal filename character but `path.resolve` has
  // already produced forward slashes.
  return process.platform === "win32" ? out.replaceAll("\\", "/") : out
}

/**
 * Realpath as much of `p` as exists, then re-append the missing tail. Keeps a
 * not-yet-created or just-deleted path on the same canonical root as its live
 * self.
 */
function resolveThroughExistingAncestor(p: string): string {
  const abs = path.resolve(p)
  const tail: Array<string> = []
  let cur = abs
  for (let i = 0; i < 64; i++) {
    try {
      const real = stripExtendedPrefix(realpathSync.native(cur))
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) break // hit the root without finding anything
      tail.push(path.basename(cur))
      cur = parent
    }
  }
  return abs
}

function canonicalForCompare(p: string): string {
  return canonicalWorkspace(p)
}

/** Sync realpath-aware canonicalization. Retained as a named alias so call
 * sites read intentionally; `canonicalWorkspace` already realpaths. */
function canonicalRealpathSync(p: string): string {
  return canonicalWorkspace(p)
}

/** Recursive (bytes, fileCount) of a directory; sync + best-effort. A
 * colgrep index is a bounded set of shards so the walk stays small. */
function dirSizeSync(dir: string): [number, number] {
  let bytes = 0
  let count = 0
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [0, 0]
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const [b, c] = dirSizeSync(p)
      bytes += b
      count += c
    } else {
      try {
        bytes += statSync(p).size
        count += 1
      } catch {
        // vanished mid-walk — skip
      }
    }
  }
  return [bytes, count]
}

/**
 * (sync) Progress signature of a workspace's colgrep index dir for the init
 * inactivity watchdog: `${totalBytes}:${fileCount}` of the project dir, or
 * `null` if it isn't on disk yet. colgrep is SILENT on a non-TTY pipe
 * during the (potentially multi-hour) encode phase, so output is useless as
 * a progress signal — but it writes index shards incrementally, so a
 * changing signature means "still progressing" and a frozen one means
 * "hung". Successive signatures drive the watchdog: change ⇒ re-arm, frozen
 * ⇒ kill. Sync because it's called from a `setTimeout` (not awaited).
 */
/**
 * Result of one progress probe.
 *
 * Three states, not `string | null`. Collapsing them was the fault boundary:
 * `null` meant "no index yet" AND "could not match the dir" AND "readdir
 * failed", and the watchdog read all of them as *no progress* — so a path
 * mismatch (which was permanent on Windows) killed healthy, actively-writing
 * builds and capped the workspace forever. UNKNOWN must never be evidence of
 * a stall; only an OBSERVED signature that stops changing is.
 */
export type IndexProgress =
  | { kind: "observed"; signature: string }
  | { kind: "not-created" }
  | { kind: "unknown" }

export function indexDirSignature(workspace: string): IndexProgress {
  const indicesDir = PATHS.COLBERT_INDICES_DIR
  let names: Array<string>
  try {
    names = readdirSync(indicesDir)
  } catch {
    // The store itself is unreadable — we cannot tell, so say so.
    return { kind: "unknown" }
  }
  const want = canonicalRealpathSync(workspace)
  for (const name of names) {
    if (name === ".gh-router-meta") continue
    // Skip quarantined husks. A `.corrupt-*` dir keeps the original
    // `project.json`, so it still matches this workspace — and its size is
    // frozen. If this probe returned the husk's signature instead of the
    // live build's, the inactivity watchdog would see no growth, judge a
    // healthy rebuild stalled, and kill it — turning a one-off repair into
    // a rebuild death loop. `colbertProjectDir` already skips these; this
    // probe must agree.
    if (name.includes(".corrupt-")) continue
    const dir = path.join(indicesDir, name)
    let proj: { path?: string; project_path?: string; model?: string }
    try {
      proj = JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8"))
    } catch {
      continue
    }
    const projPath = proj.path ?? proj.project_path
    if (!projPath || canonicalRealpathSync(projPath) !== want) continue
    // Same model check as `colbertProjectDir`. Without it the two lookups
    // disagree on a FORKED dir — one written for this workspace under a
    // different `--model` spelling, which colgrep keys separately. The probe
    // would then size a directory the router will never serve, and a fork is
    // frozen (nothing writes to it), so the watchdog would read "no growth"
    // during a perfectly healthy build of the canonical index and kill it.
    // That is the exact failure the fail-safe probe exists to prevent,
    // reachable again through the one comparison that was not unified.
    // Observed live: signature `observed` while `colbertProjectDir` returned
    // null, because only the forked dir survived on disk.
    if (proj.model !== canonicalColbertModelDir()) continue
    const [bytes, count] = dirSizeSync(dir)
    return { kind: "observed", signature: `${bytes}:${count}` }
  }
  // Scanned the store cleanly and this workspace has no project dir: colgrep
  // has not created one yet. Distinct from `unknown` — a build that has not
  // started writing is normal, and must not be mistaken for a hang.
  return { kind: "not-created" }
}

/**
 * Realpath-aware canonicalization for matching a workspace against
 * colgrep's stored `project_path`. colgrep stores the OS realpath (e.g.
 * macOS `/tmp` → `/private/tmp`, Windows 8.3 short names), so a plain
 * `path.resolve` comparison misses. Falls back to `canonicalForCompare`
 * when realpath fails (path doesn't exist yet).
 */
async function realpathForCompare(p: string): Promise<string> {
  // `canonicalWorkspace` is sync but cheap (one realpath + string work), and
  // sharing ONE implementation is the whole point: the async and sync sides
  // disagreeing is what made a healthy index invisible.
  return canonicalWorkspace(p)
}

/**
 * Compute the freshness verdict for a query against a workspace.
 *
 * Routing (per the dropped-fallback contract):
 *   - `failed`   — sidecar says failed → caller returns isError.
 *   - `building` — a tracked init is live OR no completed index on disk
 *                  → caller returns building notice (NO results).
 *   - `absent`   — never indexed → caller kicks a debounced background
 *                  init, returns absent (isError).
 *   - `stale`    — ready but HEAD moved / tree dirty since index → caller
 *                  returns stale notice (NO results, NO re-search).
 *   - `fresh`    — ready + completed index + HEAD matches + not newly
 *                  dirty → caller spawns colgrep search.
 */
/**
 * Why a `stale` verdict lags the index. `content` = the tree moved
 * (HEAD/dirty) while the embedding bits are unchanged — servable with a
 * label when the delta is small. `engine` = the binary/runtime/model bits
 * changed — the embedding space may differ, never servable without a
 * rebuild. `suspect` = shards look structurally odd — never servable.
 */
export type StaleKind = "content" | "engine" | "suspect"

export interface FreshnessResult {
  verdict: Freshness
  meta: ColbertMeta | null
  head?: string
  dirty?: boolean
  /** Present on verdict:"stale": why the index lags. */
  staleKind?: StaleKind
  /** Files changed since the index (content-stale only, capped). */
  staleFiles?: Array<string>
  /** True when more files changed than listed. */
  staleTruncated?: boolean
}

/**
 * Max stale files still servable with a label (serve-while-stale). An LLM
 * editing session typically dirties a handful of files per turn; beyond
 * this the index is too far behind to label honestly and the query falls
 * back to lexical. Override with `GH_ROUTER_SERVE_STALE_MAX_FILES`.
 */
export function serveStaleMaxFiles(): number {
  const raw = Number(process.env.GH_ROUTER_SERVE_STALE_MAX_FILES)
  if (Number.isSafeInteger(raw) && raw > 0) return raw
  return 200
}

/** Cap on delta enumeration (beyond → staleTruncated). */
const DELTA_ENUM_CAP = 1000

/**
 * True when semantic results may be served for this verdict: fresh, or
 * stale-by-content with a small, fully-enumerated delta. Engine/suspect
 * stale, failed/crashed/corrupt/building/absent are never servable.
 */
export function isServableVerdict(v: FreshnessResult): boolean {
  if (v.verdict === "fresh") return true
  if (v.verdict !== "stale") return false
  if (v.staleKind !== "content") return false
  if (v.staleTruncated) return false
  return (v.staleFiles?.length ?? Number.POSITIVE_INFINITY) <= serveStaleMaxFiles()
}

export async function freshnessVerdict(workspace: string): Promise<FreshnessResult> {
  const meta = await readColbertMeta(workspace)
  if (!meta || meta.status === "absent") {
    return { verdict: "absent", meta }
  }
  if (meta.status === "failed") {
    return { verdict: "failed", meta }
  }
  if (meta.status === "building") {
    // A build is only genuinely "building" if THIS proxy has an init in
    // flight for it (covers the brief window between the pre-spawn `building`
    // write and the onSpawn pid write) OR the recorded build PID is alive.
    // Mirror the boot sweep's liveness check per-query so a MID-SESSION crash
    // (proxy-killed / OOM build) is caught on the next query, not only at
    // the next boot. NEVER kill here — a live PID may be a recycled
    // unrelated process; we only reclassify (same discipline as the sweep).
    const pid = typeof meta.buildPid === "number" ? meta.buildPid : 0
    if (isInitInFlight(workspace) || (pid > 0 && isPidAlive(pid))) {
      return { verdict: "building", meta }
    }
    // No live PID and not in flight in THIS proxy. Another proxy may have
    // just written `building` and not yet recorded the colgrep child PID
    // (cross-process spawn window) — grant a short grace based on the
    // build-start (`lastIndexedAt`) before declaring it crashed.
    const startedMs = meta.lastIndexedAt ? Date.parse(meta.lastIndexedAt) : NaN
    if (
      Number.isFinite(startedMs) &&
      Date.now() - startedMs < BUILD_SPAWN_GRACE_MS
    ) {
      return { verdict: "building", meta }
    }
    // Dead/unknown build PID. If a completed index landed on disk, the
    // build finished but the ready-write was lost (crash between done +
    // write) → fall through to the normal ready/git-freshness path below.
    // Otherwise it crashed mid-build with no usable index.
    if (!(await completedIndexOnDisk(workspace))) {
      return { verdict: "crashed", meta }
    }
  }
  // status === "ready". Confirm a completed index is actually on disk;
  // a meta marker without an index (crash between mark-ready and write)
  // must NOT be served as fresh.
  const projectDir = await colbertProjectDir(workspace)
  if (!projectDir) return { verdict: "building", meta }
  const integrity = validateIndexIntegrity(path.join(projectDir, "index"))
  if (integrity.verdict === "not-built") return { verdict: "building", meta }
  if (integrity.verdict === "corrupt") return { verdict: "corrupt", meta }
  // Suspect: structurally odd but not provably corrupt. Refuse to serve
  // semantic results, but take the NON-destructive route — `stale` keeps the
  // bytes on disk and rebuilds in the background, so if the layout turns out
  // to be legal we have lost nothing but a rebuild.
  if (integrity.verdict === "suspect") {
    return { verdict: "stale", meta, staleKind: "suspect" as const }
  }

  // Engine changes require a clean rebuild; an index generated by different
  // binary/runtime bits is not safe to label semantic-ready. This is STALE,
  // not corrupt: the shards are structurally coherent, just built by other
  // bits. `corrupt` would quarantine and DELETE them, which on the first
  // query after any upgrade would destroy a perfectly good index — and a
  // legacy meta predating these fields has `undefined` here, so every
  // existing user would hit it exactly once, at upgrade. `stale` keeps the
  // old index searchable while a background rebuild runs.
  const binarySha = colgrepBinAsset()?.sha256
  const ortSha = ortLibAsset()?.sha256
  if (
    (binarySha && meta.binarySha !== binarySha) ||
    (ortSha && meta.ortSha !== ortSha)
  ) {
    return { verdict: "stale", meta, staleKind: "engine" as const }
  }
  // Git freshness. Non-git workspace → no head; treat ready as fresh
  // (mtime is colgrep's own incremental signal).
  const git = await gitState(workspace)
  if (!git.isRepo) {
    return { verdict: "fresh", meta }
  }
  const headMoved =
    meta.lastIndexedHead !== undefined && git.head !== meta.lastIndexedHead
  // Dirtier than at index time: the working tree is dirty now but the
  // index was taken on a clean tree (or we have no record). A tree that
  // was already dirty at index time and is still dirty is not newly
  // stale by this check alone (colgrep's incremental updater covers the
  // delta), but a clean→dirty transition since indexing IS stale.
  const newlyDirty = git.dirty && meta.lastIndexedDirty !== true
  if (headMoved || newlyDirty) {
    // Content-stale: the embedding bits are unchanged, only the tree moved.
    // Enumerate the delta so callers can serve-while-stale when it is small
    // (an LLM editing session typically dirties a handful of files).
    const delta = await gitDeltaFiles(
      workspace,
      headMoved ? meta.lastIndexedHead : undefined,
      headMoved ? git.head : undefined,
    )
    return {
      verdict: "stale",
      meta,
      head: git.head,
      dirty: git.dirty,
      staleKind: "content" as const,
      staleFiles: delta.files,
      staleTruncated: delta.truncated,
    }
  }
  return { verdict: "fresh", meta, head: git.head, dirty: git.dirty }
}

/**
 * Files changed since the index: `git diff --name-only` between the indexed
 * and current HEAD (when the head moved) UNION the working-tree porcelain
 * set. Capped at DELTA_ENUM_CAP (beyond → truncated). Fail-closed: any git
 * failure yields truncated (unprovably-small), so servability refuses.
 *
 * Exported for the service backend, which computes its own servability
 * against its own sidecar (it must NOT reuse `freshnessVerdict` — that
 * verdict describes the colgrep sidecar's state, not the service index's).
 */
export async function gitDeltaFiles(
  workspace: string,
  baseHead: string | undefined,
  currentHead: string | undefined,
): Promise<{ files: Array<string>; truncated: boolean }> {
  const files = new Set<string>()
  let truncated = false
  if (baseHead && currentHead && baseHead !== currentHead) {
    const diff = await gitNameOnly(workspace, baseHead, currentHead)
    for (const f of diff.files) files.add(f)
    truncated = truncated || diff.truncated
    if (files.size >= DELTA_ENUM_CAP) {
      return { files: [...files].slice(0, DELTA_ENUM_CAP), truncated: true }
    }
  }
  const porcelain = await gitPorcelainFiles(workspace)
  for (const f of porcelain.files) {
    if (files.size >= DELTA_ENUM_CAP) {
      truncated = true
      break
    }
    files.add(f)
  }
  truncated = truncated || porcelain.truncated
  return { files: [...files], truncated }
}

/** `git status --porcelain=v1` paths (rename target for `R  old -> new`). */
async function gitPorcelainFiles(
  workspace: string,
): Promise<{ files: Array<string>; truncated: boolean }> {
  const git = resolveExecutable("git")
  if (!git) return { files: [], truncated: true }
  try {
    const res = await runManagedExeCapture(
      git,
      ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=normal"],
      { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024 },
    )
    if (res.code !== 0) return { files: [], truncated: true }
    const files: Array<string> = []
    let truncated = res.stdoutTruncated
    for (const line of res.stdout.split("\n")) {
      if (files.length >= DELTA_ENUM_CAP) {
        truncated = true
        break
      }
      if (line.length < 4) continue
      const rest = line.slice(3)
      // Rename/copy entries report `old -> new`; the index keys the new path.
      const arrow = rest.indexOf(" -> ")
      const rel = arrow >= 0 ? rest.slice(arrow + 4) : rest
      // Quoted paths (spaces/specials) arrive `"..."`-wrapped; unquote the
      // common case rather than mis-keying the file.
      const unquoted =
        rel.startsWith('"') && rel.endsWith('"') && rel.length >= 2
          ? rel.slice(1, -1)
          : rel
      if (unquoted.length > 0) files.push(unquoted)
    }
    return { files, truncated }
  } catch {
    return { files: [], truncated: true }
  }
}

/** `git diff --name-only <from> <to>`, capped. */
async function gitNameOnly(
  workspace: string,
  fromHead: string,
  toHead: string,
): Promise<{ files: Array<string>; truncated: boolean }> {
  const git = resolveExecutable("git")
  if (!git) return { files: [], truncated: true }
  try {
    // --no-renames: renames report as delete+add, both keyed correctly for
    // a content delta (the old path's units are stale, the new path's are
    // missing — exactly what the label must convey).
    const res = await runManagedExeCapture(
      git,
      ["-C", workspace, "diff", "--name-only", "--no-renames", fromHead, toHead],
      { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024 },
    )
    if (res.code !== 0) return { files: [], truncated: true }
    const files: Array<string> = []
    let truncated = res.stdoutTruncated
    for (const line of res.stdout.split("\n")) {
      const rel = line.trim()
      if (rel.length === 0) continue
      if (files.length >= DELTA_ENUM_CAP) {
        truncated = true
        break
      }
      files.push(rel)
    }
    return { files, truncated }
  } catch {
    return { files: [], truncated: true }
  }
}

/** Cheap, bounded git probe via the native-exe runner. */
export async function gitState(
  workspace: string,
): Promise<{ isRepo: boolean; head?: string; dirty?: boolean }> {
  const git = resolveExecutable("git")
  if (!git) return { isRepo: false }
  try {
    const inside = await runManagedExeCapture(
      git,
      ["-C", workspace, "rev-parse", "--is-inside-work-tree"],
      { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 },
    )
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { isRepo: false }
    }
    const head = await runManagedExeCapture(
      git,
      ["-C", workspace, "rev-parse", "HEAD"],
      { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 },
    )
    const status = await runManagedExeCapture(
      git,
      ["-C", workspace, "status", "--porcelain"],
      { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024 },
    )
    return {
      isRepo: true,
      head: head.code === 0 ? head.stdout.trim() || undefined : undefined,
      dirty: status.code === 0 ? status.stdout.trim().length > 0 : undefined,
    }
  } catch {
    return { isRepo: false }
  }
}

// ---------------------------------------------------------------------
// Background-init debounce (per workspace+model)
// ---------------------------------------------------------------------

const _initInFlight = new Set<string>()

/** True iff a background init for this workspace is already in flight. */
export function isInitInFlight(workspace: string): boolean {
  return _initInFlight.has(initKey(workspace))
}

/** Mark a background init started (debounce). Returns false if already running. */
export function tryClaimInit(workspace: string): boolean {
  const k = initKey(workspace)
  if (_initInFlight.has(k)) return false
  _initInFlight.add(k)
  return true
}

/** Release the debounce claim (call in the init's finally). */
export function releaseInit(workspace: string): void {
  _initInFlight.delete(initKey(workspace))
}

function initKey(workspace: string): string {
  return `${MODEL_ID}::${canonicalForCompare(workspace)}`
}

/** Test-only: clear the in-flight debounce set. */
export function __resetInitDebounceForTests(): void {
  _initInFlight.clear()
}
