/**
 * ColBERT sidecar runner: spawn `colgrep search` / `colgrep init` with
 * the isolating env + flags, parse `--json`, trim to the minimal MCP
 * shape, and drive the per-query freshness preflight.
 *
 * Contract (per the coordinator's directive — supersedes the design's
 * lexical-fallback sections): `semantic_search` NEVER runs another
 * search. It returns honest `status` + `notice` and stops:
 *   - ready       → semantic results, status:"ready", source:"semantic"
 *   - building    → status:"building" + notice, NO results, NOT isError
 *   - stale       → status:"stale" + notice, NO results, NOT isError
 *   - absent      → kick a debounced background init, isError "unavailable"
 *   - failed      → isError "unavailable" + class
 * Input-shape failures (missing/relative workspace, empty query) → isError.
 *
 * Output handling: colgrep `--json` carries the full source + 5 analysis
 * layers per hit, so we cap the child stdout buffer hard, trim to 6
 * fields, and NEVER log raw stdout/stderr (it embeds source code — a
 * telemetry-leak vector).
 */

import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { runManagedExeCapture } from "../exec"

import {
  freshnessVerdict,
  gitState,
  indexDirSignature,
  isInitInFlight,
  readColbertMeta,
  releaseInit,
  tryClaimInit,
  writeColbertMeta,
  type ColbertMeta,
} from "./index-store"
import { getColbertInstanceUuid, trackChild } from "./lifecycle"
import { MODEL_ID, MODEL_REVISION } from "./manifest"
import {
  colbertModelDir,
  colbertOrtDylibPath,
  colgrepBinaryPath,
  dropColgrepSecrets,
} from "./provision"
import { PATHS } from "../paths"

/** Caller responsiveness budget for a search. A warm search is sub-second;
 * if colgrep instead starts a foreground auto-index / reconcile (its index is
 * behind) and hasn't returned results by this point, the search DETACHES —
 * the caller gets a `building` fallback now and the colgrep child finishes
 * the index in the background (never killed mid-write — that would orphan
 * docs and desync the index). The next query is then fast. */
const SEARCH_RESPOND_MS = envIntMs(
  "GH_ROUTER_COLBERT_SEARCH_RESPOND_MS",
  20_000,
)
/** Inactivity (stall) watchdog for the background init: if the colgrep
 * index dir stops growing for this long, the build is hung → kill it. This
 * is the PRIMARY "stuck vs slow" signal — a build that keeps writing shards
 * runs as long as it needs (a 50GB repo can take hours), only a genuinely
 * hung build is killed. colgrep is silent on a non-TTY pipe during the
 * encode, so disk growth (not output) is the progress signal. */
const INIT_STALL_MS = envIntMs("GH_ROUTER_COLBERT_INIT_STALL_MS", 5 * 60 * 1000)
/** Absolute backstop on the background init — a generous ceiling so a truly
 * runaway process can't live forever, NOT the primary mechanism (the stall
 * watchdog is). Raised well above the old 30-min cap so a legitimately huge
 * repo isn't cut off mid-progress. */
const INIT_TIMEOUT_MS = envIntMs(
  "GH_ROUTER_COLBERT_INIT_TIMEOUT_MS",
  6 * 60 * 60 * 1000,
)
/** After a failed build, don't re-kick a fresh one until this long has
 * elapsed (throttles a fast-failing init; the per-workspace debounce +
 * attempt cap are the other two guards). */
const FAILED_RETRY_BACKOFF_MS = 5 * 60 * 1000
/** Consecutive failed-build attempts before the self-heal gives up and the
 * notice goes operator-actionable. Reset to 0 on a successful build. */
const MAX_FAILED_ATTEMPTS = 3
/** Reuse code-search's stdout cap (10 MiB) for the full-CodeUnit payload. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024
const DEFAULT_LIMIT = 15

/** Parse a positive-integer-milliseconds env override, else the default. */
function envIntMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * A progress probe for the inactivity watchdog: returns `false` (→ kill)
 * only when colgrep's index dir for `workspace` has stopped growing. colgrep
 * is SILENT on a non-TTY pipe during the encode, so disk growth — not output
 * — is the progress signal. `null` (dir not found yet) gets one window of
 * grace, then counts as no-progress (a build/search hung before it ever
 * wrote anything). Shared by BOTH the background init and the foreground
 * search so neither colgrep child is killed mid-write (which orphans docs).
 */
export function makeIndexProgressProbe(workspace: string): () => boolean {
  let lastSig: string | null | undefined
  let nullStreak = 0
  return () => {
    const sig = indexDirSignature(workspace)
    if (sig === null) {
      nullStreak += 1
      return nullStreak <= 1
    }
    nullStreak = 0
    const prev = lastSig
    lastSig = sig
    if (prev === undefined) return true // first measurement → baseline
    return sig !== prev // progressing iff the signature changed
  }
}

/** Workspaces with a DETACHED indexing search in flight. A new search for
 * such a workspace returns `building` instead of spawning a concurrent
 * colgrep that could collide on the index write — serving the same "one
 * colgrep writer per workspace" goal as the init debounce. Cleared when the
 * detached search completes. */
const _searchIndexInFlight = new Set<string>()

/** Test-only: clear the detached-search in-flight set. */
export function __resetSearchInFlightForTests(): void {
  _searchIndexInFlight.clear()
}

export type SemanticStatus =
  | "ready"
  | "building"
  | "stale"
  | "unavailable"
  | "failed"

export interface SemanticResultRow {
  file: string
  line: number
  endLine?: number
  name?: string
  score: number
  snippet: string
}

export interface SemanticSearchResult {
  status: SemanticStatus
  results?: Array<SemanticResultRow>
  source?: "semantic"
  notice?: string
  /** Set when the outcome is an MCP error envelope (unavailable/failed). */
  isError?: boolean
}

/** colgrep `--json` element shape (only the fields we read). */
interface ColgrepHit {
  unit?: {
    name?: string
    file?: string
    line?: number
    end_line?: number
    signature?: string
    code?: string
    docstring?: string | null
  }
  score?: number
}

/** Build the isolating env for any colgrep child (search or init). */
function colgrepEnv(): NodeJS.ProcessEnv {
  const ortDir = path.dirname(colbertOrtDylibPath())
  return dropColgrepSecrets({
    ...process.env,
    COLGREP_DATA_DIR: PATHS.COLBERT_INDICES_DIR,
    ORT_DYLIB_PATH: colbertOrtDylibPath(),
    COLGREP_FORCE_CPU: "1",
    // Co-locate the ORT dir on PATH so Windows resolves dependent DLLs.
    PATH: `${ortDir}${path.delimiter}${process.env.PATH ?? ""}`,
  })
}

/**
 * The high-level entry the MCP handler calls. Runs the deterministic
 * router-side preflight (freshness verdict from on-disk markers + git),
 * and ONLY spawns `colgrep search` when the verdict is `fresh`. Never
 * runs another search engine.
 *
 * The inflight slot is acquired by the MCP handler (BEFORE this call,
 * after the preflight-cheap input validation) — same ordering invariant
 * as the other tools. This function itself does NOT acquire a slot for
 * the search, but it DOES kick background `init` work without a slot
 * (provisioning, not operator traffic).
 */
export async function runSemanticSearch(opts: {
  query: string
  workspace: string
  limit?: number
  pattern?: string
  signal?: AbortSignal
}): Promise<SemanticSearchResult> {
  const { query, workspace } = opts
  const limit = clampLimit(opts.limit)

  const fresh = await freshnessVerdict(workspace)

  switch (fresh.verdict) {
    case "absent": {
      // Never indexed → kick a debounced background init, tell the model
      // it's not available yet (isError per the contract's defense-in-
      // depth unavailable path — the model picks code_search itself).
      kickBackgroundInit(workspace)
      return {
        status: "unavailable",
        isError: true,
        notice:
          "no semantic index for this workspace yet — a background index was started; retry shortly or use code_search",
      }
    }
    case "failed":
      return handleFailure(workspace, fresh.meta, false)
    case "crashed":
      // A build whose PID died without recording a result (proxy kill / OOM)
      // — detected per-query by the freshness verdict, not yet persisted.
      return handleFailure(workspace, fresh.meta, true)
    case "building": {
      return {
        status: "building",
        notice:
          "semantic index is being built for this workspace; retry shortly (or use code_search now)",
      }
    }
    case "stale": {
      // HEAD moved / tree newly dirty since the index. Per the dropped-
      // fallback contract we do NOT silently re-search — we report the
      // honest stale state and let the model decide. Kick a background
      // refresh so a later retry can be fresh.
      kickBackgroundInit(workspace)
      return {
        status: "stale",
        notice:
          "semantic index predates the current HEAD / working tree; results would be outdated, so none are returned — retry shortly after the background re-index, or use code_search",
      }
    }
    case "fresh":
      break
  }

  // Fresh + completed index on disk → spawn colgrep search.
  return spawnSearch({ query, workspace, limit, pattern: opts.pattern })
}

/**
 * Decide how to respond to a failed/crashed index and SELF-HEAL when the
 * failure looks transient: re-kick a debounced background re-index when the
 * attempt count is under the per-class cap AND the backoff has elapsed,
 * else return an actionable notice (transient-throttled vs operator-action).
 *
 * A `crashed` verdict is a per-query detection of a build whose PID died
 * without recording a result (proxy kill / OOM); persist it as
 * `failed`+`crashed` (incrementing the attempt counter) before deciding so a
 * later query sees a consistent `failed` state. `stuck` (hung build killed
 * by the inactivity watchdog) retries at most once — re-running a hung build
 * usually hangs again; transient classes retry up to `MAX_FAILED_ATTEMPTS`.
 */
async function handleFailure(
  workspace: string,
  meta: ColbertMeta | null,
  crashedVerdict: boolean,
): Promise<SemanticSearchResult> {
  const cls: NonNullable<ColbertMeta["failureClass"]> = crashedVerdict
    ? "crashed"
    : (meta?.failureClass ?? "error")
  const attempts = crashedVerdict
    ? (meta?.failedAttempts ?? 0) + 1
    : (meta?.failedAttempts ?? 1)
  const lastAt = meta?.lastIndexedAt

  if (crashedVerdict) {
    // Persist the crash (was a stranded `building` entry). Keep the existing
    // lastIndexedAt (build-start) so the backoff measures from when the
    // build began, not from this detection.
    await writeColbertMeta({
      workspace,
      model: meta?.model ?? MODEL_ID,
      modelRev: meta?.modelRev ?? MODEL_REVISION,
      status: "failed",
      failureClass: "crashed",
      failedAttempts: attempts,
      lastIndexedAt: lastAt ?? new Date().toISOString(),
      lastIndexedHead: meta?.lastIndexedHead,
      lastIndexedDirty: meta?.lastIndexedDirty,
      ownerInstanceId: getColbertInstanceUuid(),
    }).catch(() => {})
  }

  const cap = cls === "stuck" ? 2 : MAX_FAILED_ATTEMPTS
  // NaN-safe: a missing/corrupt timestamp counts as "elapsed" (allow retry)
  // rather than NaN-comparing to false and blocking retries forever.
  const lastMs = lastAt ? Date.parse(lastAt) : NaN
  const backoffElapsed =
    !Number.isFinite(lastMs) || Date.now() - lastMs >= FAILED_RETRY_BACKOFF_MS

  if (attempts < cap && backoffElapsed) {
    kickBackgroundInit(workspace)
    consola.debug(
      `colbert: re-kicking index (class=${cls}, attempt=${attempts}/${cap})`,
    )
    return {
      status: "failed",
      isError: true,
      notice:
        'semantic index unavailable; a background re-index was started — retry mode:"semantic" shortly, or use code_search with specific symbol/keyword terms now',
    }
  }

  if (attempts < cap) {
    // Under the cap but inside the backoff window — a retry is pending.
    return {
      status: "failed",
      isError: true,
      notice:
        'semantic index unavailable (recent build failure); retry mode:"semantic" shortly, or use code_search with specific symbol/keyword terms now',
    }
  }

  // Capped → stop retrying; operator-actionable.
  consola.debug(`colbert: index ${cls}, giving up (attempts=${attempts})`)
  return {
    status: "failed",
    isError: true,
    notice: `semantic index keeps failing (${cls}); use code_search. See logs; for a very large repo raise GH_ROUTER_COLBERT_INIT_STALL_MS / GH_ROUTER_COLBERT_INIT_TIMEOUT_MS`,
  }
}

async function spawnSearch(opts: {
  query: string
  workspace: string
  limit: number
  pattern?: string
}): Promise<SemanticSearchResult> {
  const binary = colgrepBinaryPath()
  if (!existsSync(binary)) {
    return {
      status: "unavailable",
      isError: true,
      notice: "semantic search binary missing; use code_search",
    }
  }
  // Fail closed if the ORT dylib vanished after the availability gate
  // passed (tiny TOCTOU window): an absent ORT_DYLIB_PATH makes colgrep
  // silently fall through to its own UNVERIFIED ONNX-runtime download.
  // Don't spawn — report unavailable instead.
  if (!existsSync(colbertOrtDylibPath())) {
    return {
      status: "unavailable",
      isError: true,
      notice: "semantic search runtime (ONNX) missing; use code_search",
    }
  }
  const args = [
    "search",
    "--json",
    "--color",
    "never",
    "--force-cpu",
    "--model",
    colbertModelDir(),
    "-y",
    "-k",
    String(opts.limit),
  ]
  if (opts.pattern) args.push("-e", opts.pattern)
  args.push(opts.query, opts.workspace)

  const wsKey = path.resolve(opts.workspace)
  if (_searchIndexInFlight.has(wsKey)) {
    // Conservative per-workspace guard: only ONE colgrep search runs per
    // workspace at a time. colgrep auto-indexes/reconciles during a search
    // (no read-only flag), and two concurrent searches that both reconcile
    // would be unsynchronized writers — so we serialize rather than risk it.
    // The lock is held only while the search runs (sub-second for a warm
    // read; until the background index completes for a detached one), so a
    // SEQUENTIAL search pattern never contends — only a simultaneous batch on
    // the same workspace, where the losers get an immediate lexical fallback.
    return {
      status: "building",
      notice:
        "semantic index is busy (another search is running); retry shortly",
    }
  }
  _searchIndexInFlight.add(wsKey)

  // Run colgrep under the GENEROUS (build-grade) watchdog: a search that
  // triggers a foreground auto-index / reconcile is NEVER killed mid-write
  // (that orphans docs and desyncs the index) — only a genuinely hung one is,
  // after INIT_STALL_MS of no progress (no output AND no index-dir growth).
  // INIT_TIMEOUT_MS is a pure runaway backstop. The CALLER doesn't wait this
  // long — see the responsiveness race below.
  let searchPromise: ReturnType<typeof runManagedExeCapture>
  try {
    searchPromise = runManagedExeCapture(binary, args, {
      env: colgrepEnv(),
      inactivityTimeoutMs: INIT_STALL_MS,
      onInactivityCheck: makeIndexProgressProbe(opts.workspace),
      timeoutMs: INIT_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      // Byte-cap TRUNCATES (stops capturing) instead of killing — a huge
      // result must never tree-kill colgrep, which (post-index) is a non-hang
      // kill path that could interrupt a write. The child drains to completion.
      truncateInsteadOfKill: true,
      onSpawn: trackChild,
    })
  } catch {
    // Synchronous failure before a promise existed → release the lock now
    // (the .finally below never got attached).
    _searchIndexInFlight.delete(wsKey)
    consola.debug("colbert: search failed to launch")
    return {
      status: "failed",
      isError: true,
      notice: "semantic search failed to launch; use code_search",
    }
  }
  // Release the workspace lock when the colgrep child actually exits — covers
  // a fast read (sub-second), a detached background index (much later), AND
  // every async failure path. The lock outlives the responsiveness race below.
  void searchPromise
    .catch(() => undefined)
    .finally(() => _searchIndexInFlight.delete(wsKey))

  // A warm search resolves in <1s; only a slow foreground-indexing search hits
  // the responsiveness deadline. The timer is cleared on a fast win so rapid
  // searches don't accumulate live timeouts.
  let respondTimer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<{ kind: "slow" }>((resolve) => {
    respondTimer = setTimeout(() => resolve({ kind: "slow" }), SEARCH_RESPOND_MS)
    respondTimer.unref?.()
  })
  const raced = await Promise.race([
    searchPromise.then(
      (res) => ({ kind: "done" as const, res }),
      (err) => ({ kind: "error" as const, err }),
    ),
    slow,
  ])
  if (respondTimer) clearTimeout(respondTimer)

  if (raced.kind === "slow") {
    // colgrep is foreground-indexing / reconciling. DETACH: let it finish in
    // the background (the generous watchdog reaps only a true hang, never a
    // mid-write kill; the workspace lock above stays held until it exits, so
    // no concurrent search collides), and return a fallback now so the caller
    // never hangs. The next query is fast once the index settles.
    consola.debug(`colbert: search detached (indexing) for ${opts.workspace}`)
    return {
      status: "building",
      notice:
        'semantic index is updating in the background; retry mode:"semantic" shortly',
    }
  }

  if (raced.kind === "error") {
    consola.debug("colbert: search failed to launch")
    return {
      status: "failed",
      isError: true,
      notice: "semantic search failed to launch; use code_search",
    }
  }

  const res = raced.res
  if (res.timedOut || res.stalled) {
    consola.debug(
      `colbert: search ${res.stalled ? "stalled (hung, no progress)" : "hit the runaway backstop"}`,
    )
    return {
      status: "failed",
      isError: true,
      notice: "semantic search timed out; use code_search",
    }
  }
  if (res.stdoutTruncated) {
    return {
      status: "failed",
      isError: true,
      notice:
        "semantic search produced an oversized result; narrow the query or use code_search",
    }
  }
  if (res.code !== 0) {
    // NEVER surface raw stderr (embeds source). Just a class label.
    consola.debug(`colbert: search exited ${res.code}`)
    return {
      status: "failed",
      isError: true,
      notice: "semantic search returned an error; use code_search",
    }
  }

  const rows = parseAndTrim(res.stdout, opts.workspace)
  if (rows === null) {
    return {
      status: "failed",
      isError: true,
      notice: "semantic search output was unparseable; use code_search",
    }
  }
  return { status: "ready", source: "semantic", results: rows }
}

/**
 * Parse colgrep `--json` and trim each hit to the 6 minimal fields.
 * Returns null on parse failure (caller maps to failed). NEVER includes
 * `unit.code` verbatim — `snippet` is the signature + a few lines.
 */
function parseAndTrim(
  stdout: string,
  workspace: string,
): Array<SemanticResultRow> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  // colgrep emits OS-realpath'd file paths (macOS /tmp → /private/tmp,
  // Windows 8.3). Resolve the workspace realpath once so relativization
  // produces clean repo-relative paths instead of leaking the absolute.
  const wsReal = realpathSyncSafe(workspace)
  const out: Array<SemanticResultRow> = []
  for (const item of parsed as Array<ColgrepHit>) {
    const unit = item?.unit
    if (!unit || typeof unit.file !== "string") continue
    const rel = relativize(unit.file, workspace, wsReal)
    out.push({
      file: rel,
      line: typeof unit.line === "number" ? unit.line : 1,
      ...(typeof unit.end_line === "number" ? { endLine: unit.end_line } : {}),
      ...(typeof unit.name === "string" ? { name: unit.name } : {}),
      score: typeof item.score === "number" ? round2(item.score) : 0,
      snippet: buildSnippet(unit),
    })
  }
  return out
}

/** snippet = signature + first few representative lines (NOT full code). */
function buildSnippet(unit: NonNullable<ColgrepHit["unit"]>): string {
  const sig = typeof unit.signature === "string" ? unit.signature.trim() : ""
  const code = typeof unit.code === "string" ? unit.code : ""
  if (!code) return sig
  const lines = code.split("\n")
  // Up to 5 representative lines after the signature line. Cap total
  // length so a single oversized unit can't blow the response.
  const body = lines.slice(0, 6).join("\n")
  const snippet = sig && !body.startsWith(sig) ? `${sig}\n${body}` : body
  return snippet.length > 600 ? snippet.slice(0, 600) + "…" : snippet
}

function relativize(file: string, workspace: string, workspaceReal: string): string {
  for (const base of [workspace, workspaceReal]) {
    try {
      const rel = path.relative(base, file)
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel
    } catch {
      // try next base
    }
  }
  return file
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(100, Math.floor(limit)))
}

// ---------------------------------------------------------------------
// Background init (provisioning, not operator traffic — no inflight slot)
// ---------------------------------------------------------------------

/**
 * Kick a background `colgrep init` for a workspace, debounced per
 * (workspace, model). Fire-and-forget; updates the sidecar metadata to
 * `building` (with our PID + instance UUID) on start and `ready`/`failed`
 * on completion. Never throws to the caller.
 */
export function kickBackgroundInit(workspace: string): void {
  if (isInitInFlight(workspace)) return
  if (!tryClaimInit(workspace)) return
  void runInit(workspace).catch((err) => {
    consola.debug("colbert: background init failed:", err)
  })
}

/**
 * Whether the STARTUP auto-kick should fire for a workspace. Skips a build
 * that's already in a capped/persistent failure state (`failedAttempts >=
 * MAX`) or was killed as `stuck` (hung) — so a restart loop doesn't re-burn
 * a known-bad build on every launch. The per-query self-heal still gives a
 * `stuck` build its one retry and a capped one its post-backoff probe;
 * absent/stale/under-cap/ready all kick normally.
 */
export async function startupKickAllowed(workspace: string): Promise<boolean> {
  const meta = await readColbertMeta(workspace)
  if (!meta || meta.status !== "failed") return true
  if ((meta.failedAttempts ?? 0) >= MAX_FAILED_ATTEMPTS) return false
  if (meta.failureClass === "stuck") return false
  return true
}

async function runInit(workspace: string): Promise<void> {
  const binary = colgrepBinaryPath()
  if (!existsSync(binary)) {
    releaseInit(workspace)
    return
  }
  // Fail closed if the ORT dylib is missing — otherwise the background
  // init would spawn colgrep, which silently downloads an UNVERIFIED ONNX
  // runtime when ORT_DYLIB_PATH can't be loaded.
  if (!existsSync(colbertOrtDylibPath())) {
    releaseInit(workspace)
    return
  }
  // Carry the failure streak across the building→done transition so the
  // attempt cap accrues (reset to 0 only on a successful build).
  const prior = await readColbertMeta(workspace)
  const baseMeta: ColbertMeta = {
    workspace,
    model: MODEL_ID,
    modelRev: MODEL_REVISION,
    status: "building",
    // Placeholder until the colgrep child PID is known (set in onSpawn).
    // The boot sweep reclassifies a `building` entry whose buildPid is
    // DEAD → failed; it MUST be the colgrep CHILD pid, not the proxy
    // pid, or a crashed build with a still-live proxy would stay
    // `building` forever (advisor finding).
    buildPid: undefined,
    ownerInstanceId: getColbertInstanceUuid(),
    lastIndexedAt: new Date().toISOString(),
    // Carry the streak INTO the `building` write so it survives even an
    // ABRUPT crash (OOM / proxy kill) that skips the final write — otherwise
    // the per-query `crashed` reclassification would read a missing counter,
    // reset the streak to 1 every time, and never hit the cap (retry storm).
    failedAttempts: prior?.failedAttempts ?? 0,
  }
  // Capture git state at index start so the freshness verdict has a
  // baseline (best-effort; non-git workspaces leave these undefined).
  try {
    const g = await gitState(workspace)
    if (g.isRepo) {
      baseMeta.lastIndexedHead = g.head
      baseMeta.lastIndexedDirty = g.dirty
    }
  } catch {
    // ignore
  }
  await writeColbertMeta(baseMeta).catch(() => {})

  const args = [
    "init",
    "-y",
    "--color",
    "never",
    "--force-cpu",
    "--model",
    colbertModelDir(),
    workspace,
  ]

  // Disk-growth progress probe. colgrep is SILENT on a non-TTY pipe during
  // the (possibly multi-hour) encode phase, so output can't signal progress
  // — but it writes index shards incrementally. The probe re-arms the
  // inactivity watchdog while the index dir keeps growing; a frozen
  // signature ⇒ hung ⇒ killed (stalled). `null` (dir not found yet) is
  // inconclusive → don't kill (the absolute timeout backstop covers a build
  // that never writes anything).
  // Disk-growth progress probe (shared with the search path): colgrep is
  // SILENT on a non-TTY pipe during the (possibly multi-hour) encode, so
  // output can't signal progress — but it writes index shards incrementally.
  // The probe re-arms the inactivity watchdog while the index dir grows; a
  // frozen signature ⇒ hung ⇒ killed (stalled).
  const onInactivityCheck = makeIndexProgressProbe(workspace)

  const startMs = Date.now()
  let ok = false
  let failureClass: NonNullable<ColbertMeta["failureClass"]> | undefined
  try {
    const res = await runManagedExeCapture(binary, args, {
      env: colgrepEnv(),
      timeoutMs: INIT_TIMEOUT_MS,
      inactivityTimeoutMs: INIT_STALL_MS,
      onInactivityCheck,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      onSpawn: (child) => {
        trackChild(child)
        // Record the colgrep child PID so the boot sweep AND the per-query
        // freshness verdict can detect a crashed build (dead child PID) and
        // reclassify to `failed`.
        if (typeof child.pid === "number") {
          void writeColbertMeta({ ...baseMeta, buildPid: child.pid }).catch(
            () => {},
          )
        }
      },
    })
    ok = !res.stalled && !res.timedOut && res.code === 0
    if (!ok) {
      // stalled (inactivity watchdog) or timedOut (absolute backstop) both
      // mean "didn't finish, killed" → `stuck`; a clean non-zero exit is a
      // colgrep `error`. NEVER inspect res.stderr (embeds source).
      failureClass = res.stalled || res.timedOut ? "stuck" : "error"
    }
  } catch {
    ok = false
    failureClass = "launch"
  } finally {
    releaseInit(workspace)
  }
  const elapsedMs = Date.now() - startMs

  // Re-read git state at completion so lastIndexedHead reflects the tree
  // we actually indexed.
  const finalMeta: ColbertMeta = { ...baseMeta, buildPid: undefined }
  try {
    const g = await gitState(workspace)
    if (g.isRepo) {
      finalMeta.lastIndexedHead = g.head
      finalMeta.lastIndexedDirty = g.dirty
    }
  } catch {
    // ignore
  }
  finalMeta.status = ok ? "ready" : "failed"
  finalMeta.lastIndexedAt = new Date().toISOString()
  if (ok) {
    finalMeta.failedAttempts = 0
    finalMeta.failureClass = undefined
  } else {
    finalMeta.failureClass = failureClass
    finalMeta.failedAttempts = (prior?.failedAttempts ?? 0) + 1
    consola.debug(
      `colbert: init ${failureClass} after ${Math.round(elapsedMs / 1000)}s ` +
        `(attempt ${finalMeta.failedAttempts}) for ${workspace}`,
    )
  }
  await writeColbertMeta(finalMeta).catch(() => {})
}
