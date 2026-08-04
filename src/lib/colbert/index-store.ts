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

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
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
  // Use a require-free hash. Canonicalize separators + lowercase on
  // Windows so the same workspace maps to one key regardless of casing.
  const canonical =
    process.platform === "win32"
      ? path.resolve(workspace).toLowerCase().replace(/\\/g, "/")
      : path.resolve(workspace)
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
export async function readColbertMeta(
  workspace: string,
): Promise<ColbertMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(workspace), "utf8")
    const parsed = JSON.parse(raw) as ColbertMeta
    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
      return parsed
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
  _metaWriteChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

async function writeColbertMetaUnchained(meta: ColbertMeta): Promise<void> {
  await fs.mkdir(PATHS.COLBERT_META_DIR, { recursive: true })
  const dest = metaPath(meta.workspace)
  const tmp = `${dest}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2))
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

/** Validate the contiguous embedding interval encoded by PLAID shard metadata. */
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

  const intervals: Array<{ start: number; count: number }> = []
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
      intervals.push({ start, count })
    } catch {
      return { verdict: "corrupt", reason: `unreadable shard metadata: ${name}` }
    }
  }

  // Tie-break by count so a legal zero-count shard sharing a start offset
  // with a populated one is visited FIRST. Visited second, its `start` would
  // sit behind the advanced cursor and read as an overlap, condemning a
  // healthy index.
  intervals.sort((a, b) => a.start - b.start || a.count - b.count)
  // Overlap is unambiguous corruption: two shards claiming the same embedding
  // address cannot both be right. A GAP is only SUSPECT. We never established
  // that a valid colgrep generation must tile [0, N) — a deleted range could
  // legally be retained as a hole, and the one corrupt sample we have shows
  // overlaps too, so it is no evidence that gap-only is corrupt. Condemning a
  // gap would DELETE the index, so a wrong guess destroys good user data.
  // Suspect therefore stops us serving semantic results without touching the
  // bytes. (Note a `coveredEnd !== sum` test would not be an independent
  // safeguard: with no overlaps, coveredEnd === firstOffset + sum + gapTotal,
  // so it is just another spelling of the gap check.)
  let cursorEnd = 0
  let sum = 0
  let gapped = false
  for (const interval of intervals) {
    if (interval.start < cursorEnd) return { verdict: "corrupt", reason: "overlapping shard intervals" }
    if (interval.start > cursorEnd) gapped = true
    cursorEnd = interval.start + interval.count
    sum += interval.count
  }
  if (gapped) return { verdict: "suspect", reason: "gap between shard intervals" }
  return { verdict: "coherent", shardCount: intervals.length, embeddingCount: sum }
}

export async function completedIndexOnDisk(workspace: string): Promise<boolean> {
  const projectDir = await colbertProjectDir(workspace)
  if (!projectDir) return false
  return validateIndexIntegrity(path.join(projectDir, "index")).verdict !== "not-built"
}

function canonicalForCompare(p: string): string {
  return process.platform === "win32"
    ? path.resolve(p).toLowerCase().replace(/\\/g, "/")
    : path.resolve(p)
}

/** Sync realpath-aware canonicalization (sibling of `realpathForCompare`,
 * for the on-a-timer inactivity probe which must be synchronous). */
function canonicalRealpathSync(p: string): string {
  try {
    return canonicalForCompare(realpathSync(p))
  } catch {
    return canonicalForCompare(p)
  }
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
export function indexDirSignature(workspace: string): string | null {
  const indicesDir = PATHS.COLBERT_INDICES_DIR
  let names: Array<string>
  try {
    names = readdirSync(indicesDir)
  } catch {
    return null
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
    let proj: { path?: string; project_path?: string }
    try {
      proj = JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8"))
    } catch {
      continue
    }
    const projPath = proj.path ?? proj.project_path
    if (!projPath || canonicalRealpathSync(projPath) !== want) continue
    const [bytes, count] = dirSizeSync(dir)
    return `${bytes}:${count}`
  }
  return null
}

/**
 * Realpath-aware canonicalization for matching a workspace against
 * colgrep's stored `project_path`. colgrep stores the OS realpath (e.g.
 * macOS `/tmp` → `/private/tmp`, Windows 8.3 short names), so a plain
 * `path.resolve` comparison misses. Falls back to `canonicalForCompare`
 * when realpath fails (path doesn't exist yet).
 */
async function realpathForCompare(p: string): Promise<string> {
  try {
    const real = await fs.realpath(p)
    return canonicalForCompare(real)
  } catch {
    return canonicalForCompare(p)
  }
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
export async function freshnessVerdict(workspace: string): Promise<{
  verdict: Freshness
  meta: ColbertMeta | null
  head?: string
  dirty?: boolean
}> {
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
  if (integrity.verdict === "suspect") return { verdict: "stale", meta }

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
    return { verdict: "stale", meta }
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
    return { verdict: "stale", meta, head: git.head, dirty: git.dirty }
  }
  return { verdict: "fresh", meta, head: git.head, dirty: git.dirty }
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
