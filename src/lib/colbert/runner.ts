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
  isInitInFlight,
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

/** Hard per-search timeout. The encode + incremental delta is sub-second
 * to seconds; 30s catches a pathological re-index on a huge diff. */
const SEARCH_TIMEOUT_MS = 30_000
/** Generous cap on the background init build (matches the worker-agent). */
const INIT_TIMEOUT_MS = 30 * 60 * 1000
/** Reuse code-search's stdout cap (10 MiB) for the full-CodeUnit payload. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024
const DEFAULT_LIMIT = 15

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
    case "failed": {
      return {
        status: "failed",
        isError: true,
        notice:
          "semantic index build failed for this workspace; use code_search",
      }
    }
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

  let res
  try {
    res = await runManagedExeCapture(binary, args, {
      env: colgrepEnv(),
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      onSpawn: trackChild,
    })
  } catch {
    return {
      status: "failed",
      isError: true,
      notice: "semantic search failed to launch; use code_search",
    }
  }

  if (res.timedOut) {
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
  let ok = false
  try {
    const res = await runManagedExeCapture(binary, args, {
      env: colgrepEnv(),
      timeoutMs: INIT_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      onSpawn: (child) => {
        trackChild(child)
        // Record the colgrep child PID so the boot sweep can detect a
        // crashed build (dead child PID) and reclassify to `failed`.
        if (typeof child.pid === "number") {
          void writeColbertMeta({ ...baseMeta, buildPid: child.pid }).catch(
            () => {},
          )
        }
      },
    })
    ok = !res.timedOut && res.code === 0
  } catch {
    ok = false
  } finally {
    releaseInit(workspace)
  }

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
  await writeColbertMeta(finalMeta).catch(() => {})
}
