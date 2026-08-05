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

import { randomBytes } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { runManagedExeCapture } from "../exec"

import {
  colbertProjectDir,
  completedIndexOnDisk,
  freshnessVerdict,
  gitState,
  indexDirSignature,
  isInitInFlight,
  readColbertMeta,
  releaseInit,
  tryClaimInit,
  validateIndexIntegrity,
  writeColbertMeta,
  type ColbertMeta,
} from "./index-store"
import { getColbertInstanceUuid, trackChild } from "./lifecycle"
import {
  colgrepBinAsset,
  MODEL_ID,
  MODEL_REVISION,
  ortLibAsset,
} from "./manifest"
import {
  canonicalColbertModelDir,
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
  let lastSig: string | undefined
  return () => {
    const p = indexDirSignature(workspace)
    // FAIL-SAFE. Only a signature we actually OBSERVED, twice, unchanged, is
    // evidence of a hang. `unknown` (store unreadable, probe errored) and
    // `not-created` (colgrep has not written a dir yet) are the absence of
    // evidence, and the absence of evidence must never kill a build.
    //
    // The previous version returned `string | null` and treated the second
    // consecutive `null` as no-progress. On Windows the path comparison could
    // never match colgrep's extended-length `project_path`, so the probe
    // returned null on EVERY tick — the watchdog killed healthy,
    // actively-writing builds, classified them `stuck`, and `stuck` is
    // refused forever at a cap of 2. That is the whole outage, and it was
    // reachable from any cause of null, not just the path bug.
    //
    // The absolute `INIT_TIMEOUT_MS` backstop (6h) remains the runaway guard,
    // so a genuinely wedged build that never writes anything still dies.
    if (p.kind !== "observed") return true
    const prev = lastSig
    lastSig = p.signature
    // First concrete observation starts the clock — nothing to compare yet.
    if (prev === undefined) return true
    return p.signature !== prev // progressing iff the signature changed
  }
}

/** Workspaces with a DETACHED indexing search in flight. A new search for
 * such a workspace returns `building` instead of spawning a concurrent
 * colgrep that could collide on the index write — serving the same "one
 * colgrep writer per workspace" goal as the init debounce. Cleared when the
 * detached search completes. */
const _searchIndexInFlight = new Set<string>()
const _initPromises = new Map<string, Promise<void>>()
/** In-flight quarantine deletions, drained by teardown (Windows EBUSY). */
const _quarantineRemovals = new Set<Promise<void>>()
let _runManagedExeCapture = runManagedExeCapture

/** Test-only: clear the detached-search in-flight set. */
export function __resetSearchInFlightForTests(): void {
  _searchIndexInFlight.clear()
}

/** Test-only: replace the managed executable runner and observe background init. */
export function __setInitRunnerForTests(
  runner: typeof runManagedExeCapture | undefined,
): void {
  _runManagedExeCapture = runner ?? runManagedExeCapture
}

/** Test-only: await the currently tracked background init, if any. */
export async function __waitForInitForTests(workspace: string): Promise<void> {
  await _initPromises.get(path.resolve(workspace))
}

/** Test-only: drain all background init work before removing fixtures. */
export async function __waitForAllInitsForTests(): Promise<void> {
  await Promise.all(_initPromises.values())
  await Promise.all(_quarantineRemovals)
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
    case "corrupt":
      return repairCorruptIndex(workspace, fresh.meta)
    case "building": {
      // A `building` verdict with no live owner and nothing on disk is an
      // INTERRUPTED build, not a running one — and it used to be a silent,
      // permanent dead end: this branch returned a notice and never rebuilt,
      // nothing incremented a failure counter, and the degraded banner only
      // fires on `status:"failed"`. A workspace could sit here forever.
      //
      // Schedule ONE debounced recovery rather than kicking unconditionally:
      // `kickBackgroundInit` is single-flight per workspace, and a build that
      // keeps failing lands back in `failed` (capped + backed off), not here,
      // so this cannot become a rebuild storm.
      if (!isInitInFlight(workspace) && !(await completedIndexOnDisk(workspace))) {
        kickBackgroundInit(workspace)
        return {
          status: "building",
          notice:
            "semantic index build was interrupted; a rebuild was started — retry shortly (or use code_search now)",
        }
      }
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
async function quarantineProjectDir(projectDir: string): Promise<boolean> {
  const quarantine = `${projectDir}.corrupt-${process.pid}-${randomBytes(4).toString("hex")}`
  try {
    await fs.rename(projectDir, quarantine)
  } catch (err) {
    consola.debug("colbert: corrupt index quarantine rename failed:", err)
    return false
  }
  // The delete runs in the background — the rename already made the corrupt
  // index invisible, so the caller must not wait on a large recursive rm.
  // Track it so teardown can drain it: an in-flight rm walking this tree
  // while something removes an ancestor raises EBUSY/EPERM on Windows.
  const removal = fs
    .rm(quarantine, { recursive: true, force: true })
    .catch((err) => {
      consola.debug("colbert: corrupt index quarantine cleanup failed:", err)
    })
    .finally(() => {
      _quarantineRemovals.delete(removal)
    })
  _quarantineRemovals.add(removal)
  return true
}

async function repairCorruptIndex(
  workspace: string,
  meta: ColbertMeta | null,
): Promise<SemanticSearchResult> {
  const wsKey = path.resolve(workspace)
  const attempts = (meta?.failureClass === "corrupt" ? meta.failedAttempts ?? 0 : 0) + 1
  const failedMeta: ColbertMeta = {
    workspace,
    model: meta?.model ?? MODEL_ID,
    modelRev: meta?.modelRev ?? MODEL_REVISION,
    binarySha: colgrepBinAsset()?.sha256,
    ortSha: ortLibAsset()?.sha256,
    status: "failed",
    failureClass: "corrupt",
    failedAttempts: attempts,
    // Same reason as the other failure writes: a streak with no baseline is
    // never resettable, so a corrupt-index streak would cap permanently even
    // after an engine upgrade or a fresh corpus.
    failedAt: {
      head: meta?.lastIndexedHead,
      dirty: meta?.lastIndexedDirty,
      binarySha: colgrepBinAsset()?.sha256,
      ortSha: ortLibAsset()?.sha256,
      // CURRENT revision, not a copied one — see the note on the launch-path
      // stamp: a stale value never equals MODEL_REVISION and would reset the
      // streak on every query.
      modelRev: MODEL_REVISION,
    },
    lastIndexedAt: new Date().toISOString(),
    lastIndexedHead: meta?.lastIndexedHead,
    lastIndexedDirty: meta?.lastIndexedDirty,
    ownerInstanceId: getColbertInstanceUuid(),
  }

  if (_searchIndexInFlight.has(wsKey) || isInitInFlight(workspace)) {
    return {
      status: "building",
      notice: "semantic index was found corrupt but a writer is still active; returned results are disabled until it exits",
    }
  }

  const projectDir = await colbertProjectDir(workspace)
  if (!projectDir) {
    // No project dir means there is nothing to REPAIR — this workspace has no
    // index, which is `absent`, not corruption. Recording it as `corrupt`
    // burned that class's 2-attempt cap (stricter than the normal 3) on a
    // state that a rebuild fixes, and a stable-HEAD workspace then never
    // reset. That is exactly what a forked or unmatched project key looks
    // like, so this branch was reachable from the identity bug above.
    kickBackgroundInit(workspace)
    return {
      status: "unavailable",
      isError: true,
      notice:
        "no semantic index for this workspace yet — a background index was started; retry shortly or use code_search",
    }
  }
  if (!(await quarantineProjectDir(projectDir))) {
    await writeColbertMeta(failedMeta).catch(() => {})
    return {
      status: "failed",
      isError: true,
      notice: "semantic index is corrupt but could not be quarantined; returned lexical results — close active colgrep processes and retry",
    }
  }
  await writeColbertMeta(failedMeta).catch(() => {})

  if (attempts < 2) kickBackgroundInit(workspace)
  return {
    status: "failed",
    isError: true,
    notice:
      attempts < 2
        ? 'semantic index was found corrupt and quarantined; a clean rebuild was started — retry mode:"semantic" shortly'
        : 'semantic index repeatedly failed integrity checks; automatic rebuild is capped — do NOT retry mode:"semantic", use lexical search with specific symbol/keyword terms and see proxy logs',
  }
}

/**
 * True when the inputs that produced the recorded failure streak differ from
 * the inputs in effect now — i.e. the streak is stale evidence and must not
 * veto a fresh attempt.
 *
 * Each signal answers "could this plausibly have fixed the cause?":
 *   - engine/runtime sha: a colgrep or ONNX-runtime upgrade may fix the exact
 *     bug that failed. Precedent: `freshnessVerdict` already forces a rebuild
 *     on an engine-sha change for the same reason.
 *   - model revision: a different embedding model is a different build.
 *   - corpus identity: HEAD moved OR the working tree's dirty-state changed.
 *     BOTH are needed — HEAD-only misses the most common local recovery
 *     (fixing a malformed file without committing), and dirty-only misses a
 *     branch switch.
 *
 * A legacy entry with no `failedAt` (written before this field existed) has no
 * baseline to compare, so it does NOT reset — it keeps today's behavior until
 * its next failure stamps one. That is the conservative direction: a missing
 * baseline must not read as "everything changed".
 */
function failureInputsChanged(
  meta: ColbertMeta | null,
  git: { head?: string; dirty?: boolean },
): boolean {
  const at = meta?.failedAt
  if (!at) return false
  // Every comparison requires BOTH sides to be known. An `undefined` on either
  // side means "we cannot tell", and unknown must never read as "changed" —
  // otherwise a partially-populated baseline (or a git probe that timed out)
  // would reset the streak on every query, which is the unbounded rebuild loop
  // this whole mechanism has to avoid.
  const binarySha = colgrepBinAsset()?.sha256
  const ortSha = ortLibAsset()?.sha256
  if (
    at.binarySha !== undefined
    && binarySha !== undefined
    && at.binarySha !== binarySha
  ) {
    return true
  }
  if (at.ortSha !== undefined && ortSha !== undefined && at.ortSha !== ortSha) {
    return true
  }
  if (at.modelRev !== undefined && at.modelRev !== MODEL_REVISION) return true
  if (at.head !== undefined && git.head !== undefined && at.head !== git.head) {
    return true
  }
  if (
    at.dirty !== undefined &&
    git.dirty !== undefined &&
    at.dirty !== git.dirty
  ) {
    return true
  }
  return false
}

async function handleFailure(
  workspace: string,
  meta: ColbertMeta | null,
  crashedVerdict: boolean,
): Promise<SemanticSearchResult> {
  const cls: NonNullable<ColbertMeta["failureClass"]> = crashedVerdict
    ? "crashed"
    : (meta?.failureClass ?? "error")

  // Before consulting the cap, check whether the streak still describes the
  // current situation. A cap that only ever counts up is a permanent dead end
  // by construction — which is exactly the bug this fixes. Recovery still goes
  // through a REAL rebuild under the unchanged cap and backoff, so nothing is
  // served that the normal guards wouldn't already serve.
  //
  // The backoff is computed FIRST and applies to the reset kick too. Without
  // it the reset would remove the ceiling along with the dead end: on an
  // actively-developed repo whose build genuinely fails, every commit (head
  // moves) and every clean/dirty toggle would re-zero the counter and kick a
  // fresh full index immediately, forever. Clearing the streak is right;
  // rebuilding without a throttle is not.
  const lastAt = meta?.lastIndexedAt
  // NaN-safe: a missing/corrupt timestamp counts as "elapsed" (allow retry)
  // rather than NaN-comparing to false and blocking retries forever.
  const lastMs = lastAt ? Date.parse(lastAt) : NaN
  const backoffElapsed =
    !Number.isFinite(lastMs) || Date.now() - lastMs >= FAILED_RETRY_BACKOFF_MS

  // Only probe git when a git-derived baseline field could actually decide the
  // outcome. `gitState` runs up to three git subprocesses with 4s timeouts, and
  // this path is awaited inline before the lexical fallback — so a degraded
  // workspace would pay that on EVERY query. The engine/model comparisons need
  // no subprocess at all.
  const at = meta?.failedAt
  const needsGit = at?.head !== undefined || at?.dirty !== undefined
  const gitNow: { head?: string; dirty?: boolean } =
    needsGit ? await gitState(workspace).catch(() => ({})) : {}
  if (failureInputsChanged(meta, gitNow)) {
    consola.warn(
      `colbert: index inputs changed since the last failure (class=${cls}); ` +
        `clearing the failure streak${backoffElapsed ? " and retrying" : ""} for ${workspace}`,
    )
    await writeColbertMeta({
      workspace,
      model: meta?.model ?? MODEL_ID,
      modelRev: meta?.modelRev ?? MODEL_REVISION,
      binarySha: meta?.binarySha,
      ortSha: meta?.ortSha,
      status: "failed",
      failureClass: meta?.failureClass,
      // Persist the reset BEFORE kicking, so concurrent/back-to-back queries
      // see a cleared streak instead of each re-deciding to reset. The kick
      // itself is deduped by the per-workspace in-flight claim.
      failedAttempts: 0,
      failedAt: undefined,
      lastIndexedAt: meta?.lastIndexedAt,
      lastIndexedHead: meta?.lastIndexedHead,
      lastIndexedDirty: meta?.lastIndexedDirty,
      ownerInstanceId: getColbertInstanceUuid(),
    }).catch(() => {})
    if (backoffElapsed) kickBackgroundInit(workspace)
    return {
      status: "failed",
      isError: true,
      notice:
        backoffElapsed ?
          'semantic index unavailable; inputs changed since the last failure so a rebuild was started — retry mode:"semantic" shortly, or use code_search with specific symbol/keyword terms now'
        : 'semantic index unavailable (recent build failure); a rebuild is pending — retry mode:"semantic" shortly, or use code_search with specific symbol/keyword terms now',
    }
  }

  const attempts = crashedVerdict
    ? (meta?.failedAttempts ?? 0) + 1
    : (meta?.failedAttempts ?? 1)

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
      // Stamp the baseline so a later input change can clear this streak too
      // — otherwise a 3-crash workspace stays terminal exactly like the bug
      // this fixes.
      failedAt: {
        head: meta?.lastIndexedHead,
        dirty: meta?.lastIndexedDirty,
        binarySha: meta?.binarySha ?? colgrepBinAsset()?.sha256,
        ortSha: meta?.ortSha ?? ortLibAsset()?.sha256,
        // CURRENT revision, not a copied one (see the launch-path note).
        modelRev: MODEL_REVISION,
      },
      lastIndexedAt: lastAt ?? new Date().toISOString(),
      lastIndexedHead: meta?.lastIndexedHead,
      lastIndexedDirty: meta?.lastIndexedDirty,
      ownerInstanceId: getColbertInstanceUuid(),
    }).catch(() => {})
  }

  const cap = cls === "stuck" || cls === "corrupt" ? 2 : MAX_FAILED_ATTEMPTS

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

  // Capped → stop retrying. The env-var tuning advice that used to live in
  // this notice was addressed to the wrong audience: a spawned agent cannot
  // set env vars on the running proxy, so it burned context and could invite
  // a pointless `export`. Operator-facing guidance now lives in the launch
  // banner and the failure line in ERROR_LOG_PATH; the model just needs to
  // know semantic is unavailable and what to use instead.
  consola.warn(
    `colbert: index ${cls}, giving up (attempts=${attempts}) for ${workspace}`,
  )
  return {
    status: "failed",
    isError: true,
    notice: `semantic index unavailable (${cls}); use code_search with specific symbol/keyword terms`,
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
    canonicalColbertModelDir(),
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
    searchPromise = _runManagedExeCapture(binary, args, {
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
export function buildSnippet(unit: NonNullable<ColgrepHit["unit"]>): string {
  const sig = typeof unit.signature === "string" ? unit.signature.trim() : ""
  const code = typeof unit.code === "string" ? unit.code : ""
  if (!code) return sig
  const lines = code.split("\n")
  // Up to 5 representative lines after the signature line. Cap total
  // length so a single oversized unit can't blow the response.
  const body = lines.slice(0, 6).join("\n")
  const firstBodyLine = lines[0]?.trim() ?? ""
  const snippet = sig && firstBodyLine !== sig ? `${sig}\n${body}` : body
  return snippet.length > 600 ? snippet.slice(0, 600) + "…" : snippet
}

function stripExtendedPathPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return value.slice(4)
  return value
}

export function relativize(file: string, workspace: string, workspaceReal: string): string {
  const normalizedFile = stripExtendedPathPrefix(file)
  for (const rawBase of [workspace, workspaceReal]) {
    try {
      const base = stripExtendedPathPrefix(rawBase)
      const flavor = /^[a-z]:[\\/]/i.test(base) || base.startsWith("\\\\")
        ? path.win32
        : path
      const rel = flavor.relative(base, normalizedFile)
      if (rel && !rel.startsWith("..") && !flavor.isAbsolute(rel)) return rel
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
  const key = path.resolve(workspace)
  const promise = runInit(workspace)
    .catch(async (err) => {
      releaseInit(workspace)
      consola.error("colbert: background init failed:", err)
      const prior = await readColbertMeta(workspace)
      // Read LIVE git state for the baseline rather than copying
      // `prior.lastIndexedHead`. That field records the last SUCCESSFUL index
      // and is empty on a workspace that has never built, so copying it would
      // stamp a headless baseline — and a baseline with no head can never
      // detect a later commit, leaving this failure class unresettable.
      const g = await gitState(workspace).catch(() => ({
        head: undefined,
        dirty: undefined,
      }))
      await writeColbertMeta({
        workspace,
        model: prior?.model ?? MODEL_ID,
        modelRev: prior?.modelRev ?? MODEL_REVISION,
        binarySha: colgrepBinAsset()?.sha256,
        ortSha: ortLibAsset()?.sha256,
        status: "failed",
        failureClass: "launch",
        failedAttempts: (prior?.failedAttempts ?? 0) + 1,
        // Stamp the baseline here too. Without it a spawn failure — a missing
        // or unrunnable binary, the most likely thing an upgrade FIXES — would
        // accumulate a streak with no `failedAt`, and `failureInputsChanged`
        // treats a missing baseline as "unknown, do not reset". That would
        // leave exactly this class of failure permanently capped.
        failedAt: {
          head: g.head,
          dirty: g.dirty,
          binarySha: colgrepBinAsset()?.sha256,
          ortSha: ortLibAsset()?.sha256,
          // The CURRENT revision, not `prior.modelRev`. The baseline records
          // what was in effect for THIS attempt; copying a stale value would
          // make the comparison against MODEL_REVISION permanently unequal and
          // reset the streak on every query — an unbounded rebuild loop.
          modelRev: MODEL_REVISION,
        },
        lastIndexedAt: new Date().toISOString(),
        lastIndexedHead: prior?.lastIndexedHead,
        lastIndexedDirty: prior?.lastIndexedDirty,
        ownerInstanceId: getColbertInstanceUuid(),
      }).catch((writeErr) => {
        consola.error("colbert: failed to record background init failure:", writeErr)
      })
    })
    .finally(() => {
      _initPromises.delete(key)
    })
  _initPromises.set(key, promise)
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
  const cap = meta.failureClass === "stuck" || meta.failureClass === "corrupt"
    ? 2
    : MAX_FAILED_ATTEMPTS
  if ((meta.failedAttempts ?? 0) >= cap) return false
  if (meta.failureClass === "stuck") return false
  return true
}

/**
 * Encoding sessions colgrep may run in parallel: 25% of the machine's
 * threads, never fewer than 2.
 *
 * colgrep defaults this to the FULL CPU count, so a background index build
 * saturates the machine — the exact opposite of what a background build
 * should do during an interactive agent session (the proxy even holds a
 * keep-awake assertion so those sessions run long and unattended). The floor
 * of 2 keeps a 1- to 7-thread box from dropping to a single session and
 * taking proportionally forever.
 *
 * Override with `GH_ROUTER_COLBERT_PARALLEL` (a positive integer).
 */
export function colbertParallelSessions(): number {
  const raw = Number(process.env.GH_ROUTER_COLBERT_PARALLEL)
  if (Number.isSafeInteger(raw) && raw > 0) return raw
  const threads = os.availableParallelism?.() ?? os.cpus?.().length ?? 4
  return Math.max(2, Math.floor(threads * 0.25))
}

/**
 * Persist the parallelism cap into the router-owned colgrep config.
 *
 * `--parallel` exists only on the `settings` subcommand — there is no
 * per-run flag and no env var. It writes `parallel_sessions` to
 * `<COLGREP_DATA_DIR>/../config.json`, which for us is
 * `<APP_DIR>/colbert/config.json`: router-owned, and NOT the user's own
 * colgrep config (verified — after we write ours, a plain `colgrep
 * settings` with no COLGREP_DATA_DIR still reports `auto`).
 *
 * Best-effort: failing here means colgrep encodes at its default (all
 * threads), which is greedy but not incorrect, so it must never block a
 * build.
 */
async function applyParallelismCap(binary: string): Promise<void> {
  const sessions = colbertParallelSessions()
  try {
    await _runManagedExeCapture(
      binary,
      ["settings", "--parallel", String(sessions)],
      { env: colgrepEnv(), timeoutMs: 30_000, maxStdoutBytes: MAX_STDOUT_BYTES },
    )
  } catch (err) {
    consola.debug("colbert: could not cap colgrep parallelism:", err)
  }
}

async function runInit(workspace: string): Promise<void> {
  const binary = colgrepBinaryPath()
  if (!existsSync(binary)) {
    throw new Error("colgrep binary is missing")
  }
  // Fail closed if the ORT dylib is missing — otherwise the background
  // init would spawn colgrep, which silently downloads an UNVERIFIED ONNX
  // runtime when ORT_DYLIB_PATH can't be loaded.
  if (!existsSync(colbertOrtDylibPath())) {
    throw new Error("ColBERT ONNX runtime is missing")
  }
  // Cap parallelism before the encode starts. The setting persists in our
  // data dir, so it also governs the reconcile a later `search` may run.
  await applyParallelismCap(binary)
  // Carry the failure streak across the building→done transition so the
  // attempt cap accrues (reset to 0 only on a successful build).
  const prior = await readColbertMeta(workspace)
  const baseMeta: ColbertMeta = {
    workspace,
    model: MODEL_ID,
    modelRev: MODEL_REVISION,
    binarySha: colgrepBinAsset()?.sha256,
    ortSha: ortLibAsset()?.sha256,
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
    // Carry the BASELINE for the same reason. A meta write replaces the whole
    // record, so dropping `failedAt` here would strip the streak's baseline on
    // every build attempt — and `failureInputsChanged` would then see a
    // partially-populated (or absent) baseline and could clear the streak on
    // the next query, re-kicking forever. The counter and the baseline that
    // scopes it have to survive together or neither is meaningful.
    failedAt: prior?.failedAt,
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
    canonicalColbertModelDir(),
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
  let ok: boolean
  let failureClass: NonNullable<ColbertMeta["failureClass"]> | undefined
  try {
    const res = await _runManagedExeCapture(binary, args, {
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
    if (ok) {
      const projectDir = await colbertProjectDir(workspace)
      ok =
        projectDir !== null &&
        validateIndexIntegrity(path.join(projectDir, "index")).verdict === "coherent"
      if (!ok) {
        failureClass = "corrupt"
        if (projectDir) await quarantineProjectDir(projectDir)
      }
    } else {
      // stalled (inactivity watchdog) or timedOut (absolute backstop) both
      // mean "didn't finish, killed" → `stuck`; a clean non-zero exit is a
      // colgrep `error`. NEVER inspect res.stderr (embeds source).
      failureClass = res.stalled || res.timedOut ? "stuck" : "error"
    }
  } catch (err) {
    ok = false
    failureClass = "launch"
    consola.error("colbert: init failed to launch:", err)
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
    finalMeta.failedAt = undefined
  } else {
    finalMeta.failureClass = failureClass
    finalMeta.failedAttempts = (prior?.failedAttempts ?? 0) + 1
    // Stamp WHAT was being indexed when this failure happened, so a later
    // query can tell "the same inputs failed again" from "the inputs changed,
    // so the old streak is stale evidence". Kept apart from `lastIndexedHead`,
    // which on the success path means "what we successfully indexed" and is
    // read by the git-freshness comparison — overloading it would couple
    // failure-reset to freshness semantics.
    finalMeta.failedAt = {
      head: finalMeta.lastIndexedHead,
      dirty: finalMeta.lastIndexedDirty,
      binarySha: finalMeta.binarySha,
      ortSha: finalMeta.ortSha,
      modelRev: finalMeta.modelRev,
    }
    // WARN, not debug: `enableFileLogging()` installs a reporter that drops
    // everything below `warn` (`file-log-reporter.ts` ALLOWED_TYPES), which is
    // exactly why this diagnostic was invisible — a semantic-search outage ran
    // for weeks with zero colbert lines in a 120KB error.log. At `warn` it
    // reaches PATHS.ERROR_LOG_PATH, already credential-sanitized and capped.
    // Still no raw stderr: colgrep output can embed source, so only the class,
    // the duration and the attempt count are recorded.
    consola.warn(
      `colbert: init ${failureClass} after ${Math.round(elapsedMs / 1000)}s ` +
        `(attempt ${finalMeta.failedAttempts}) for ${workspace}`,
    )
  }
  await writeColbertMeta(finalMeta).catch(() => {})
}
