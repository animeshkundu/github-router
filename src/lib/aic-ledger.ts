/**
 * Per-launch AIC (AI Credits) ledger.
 *
 * Every route handler records upstream `copilot_usage` here as a side effect
 * (bytes pass through untouched). The totals feed two consumers:
 *
 *   1. `internal-aic-status` — runs as a SEPARATE process on every status-line
 *      tick, so it cannot read in-process memory. Each `record()` therefore
 *      also persists an atomic snapshot file; the ledger path is handed to the
 *      spawned child via `GH_ROUTER_AIC_LEDGER` and baked into the statusLine
 *      command.
 *   2. The `claude` exit summary — reads the in-process snapshot.
 *
 * Keyed per proxy process (one file per PID under `<APP_DIR>/aic-ledger/`),
 * so concurrent launches never mix. Snapshot writes are best-effort and never
 * throw into the request path. Stale files (dead PID, >24h) are swept at
 * startup of the next record and on shutdown.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

import {
  extractCopilotUsage,
  formatAic,
  nanoAiuToCredits,
  type CopilotUsage,
} from "./aic-usage"

export interface AicModelEntry {
  nanoAiu: number
  requests: number
}

/** Token counts per model per upstream `token_type`, for the cost table. */
export interface AicModelTokens {
  /** Upstream `input` type: fresh (uncached) input tokens. */
  input: number
  /** Upstream `cache_read` type. */
  cache_read: number
  /** Upstream `cache_write` type. */
  cache_write: number
  /** Upstream `output` type. */
  output: number
  /** Any other/missing `token_type`: never dropped silently, priced at input. */
  other: number
}

export interface AicSnapshot {
  totalNanoAiu: number
  requests: number
  perModel: Record<string, AicModelEntry>
  /** Reconstructed nano-AIU per token_type (input/cache_read/cache_write/output). */
  perTokenType: Record<string, number>
  /** Raw token counts per model per type (exit cost table + rate math). */
  tokensByModel: Record<string, AicModelTokens>
}

function emptyModelTokens(): AicModelTokens {
  return { input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0 }
}

function emptySnapshot(): AicSnapshot {
  return {
    totalNanoAiu: 0,
    requests: 0,
    perModel: {},
    perTokenType: {},
    tokensByModel: {},
  }
}

let ledger: AicSnapshot = emptySnapshot()

/** @internal — reset module state between test cases. */
export function __resetAicLedgerForTests(): void {
  ledger = emptySnapshot()
}

function ledgerDir(): string {
  return (
    process.env.GH_ROUTER_AIC_LEDGER_DIR ?? path.join(PATHS.APP_DIR, "aic-ledger")
  )
}

/**
 * Snapshot file for this proxy process. Overridable via `GH_ROUTER_AIC_LEDGER`
 * (used by tests and by the spawned child's env).
 */
export function aicLedgerPath(): string {
  const override = process.env.GH_ROUTER_AIC_LEDGER
  if (override && override.length > 0) return override
  return path.join(ledgerDir(), `${process.pid}.json`)
}

/** Best-effort persist; never throws. */
function persistBestEffort(): void {
  try {
    const file = aicLedgerPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    // Telemetry must never break a request.
  }
}

/**
 * Record one upstream `copilot_usage` reading. No-op on undefined.
 * `model` is the resolved (Copilot-side) model id when known.
 */
export function recordAic(
  model: string | undefined,
  usage: CopilotUsage | undefined,
): void {
  if (!usage) return
  ledger.totalNanoAiu += usage.totalNanoAiu
  ledger.requests += 1
  const key = model && model.length > 0 ? model : "unknown"
  const entry = ledger.perModel[key] ?? { nanoAiu: 0, requests: 0 }
  entry.nanoAiu += usage.totalNanoAiu
  entry.requests += 1
  ledger.perModel[key] = entry
  ledger.tokensByModel[key] ??= emptyModelTokens()
  for (const detail of usage.tokenDetails) {
    const type = detail.tokenType ?? "unknown"
    // Reconstruct nano-AIU per token type from the priced detail.
    const nano = Math.round(
      (detail.tokenCount * detail.costPerBatch) / detail.batchSize,
    )
    ledger.perTokenType[type] = (ledger.perTokenType[type] ?? 0) + nano
    // Retain raw counts per model per type for the exit cost table. The
    // hook only reads them; pricing still flows exclusively through nano.
    const counts = ledger.tokensByModel[key] ?? emptyModelTokens()
    const bucket = tokenBucket(type)
    counts[bucket] += detail.tokenCount
    ledger.tokensByModel[key] = counts
  }
  persistBestEffort()
}

/**
 * Map an upstream `token_type` to its count bucket. Unknown/missing types
 * land in `other` (priced at the model's input factor downstream) rather
 * than being dropped — the observed universe is the four known types, this
 * is the just-in-case bucket.
 */
function tokenBucket(type: string): keyof AicModelTokens {
  switch (type) {
    case "input":
      return "input"
    case "cache_read":
      return "cache_read"
    case "cache_write":
      return "cache_write"
    case "output":
      return "output"
    default:
      return "other"
  }
}

/**
 * Extract `copilot_usage` from a response object or SSE event-data object,
 * record it under `model`, and return its nano-AIU for `logRequest`.
 * Returns `undefined` when absent/invalid. Never throws.
 */
export function extractAndRecordAic(
  model: string | undefined,
  container: unknown,
): number | undefined {
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return undefined
  }
  const usage = extractCopilotUsage(
    (container as Record<string, unknown>).copilot_usage,
  )
  if (!usage) return undefined
  recordAic(model, usage)
  return usage.totalNanoAiu
}

/**
 * Streaming-tap variant of `extractAndRecordAic`: identical, except a
 * zero-nano reading is treated as "no reading yet" — it is NOT recorded
 * and `undefined` is returned so the tap keeps scanning.
 *
 * Why: Copilot's `/chat/completions` streams emit interim chunks carrying
 * `copilot_usage` with `total_nano_aiu: 0` before the terminal chunk with
 * the real value (verified live on gemini-3.8-flash). A first-wins tap
 * built on `extractAndRecordAic` latches on the zero frame and drops the
 * terminal value, under-recording the whole stream as free. Every
 * streaming tap must use this variant; non-streaming callers keep
 * `extractAndRecordAic` so a genuinely free call still counts its request.
 */
export function extractAndRecordPricedAic(
  model: string | undefined,
  container: unknown,
): number | undefined {
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return undefined
  }
  const usage = extractCopilotUsage(
    (container as Record<string, unknown>).copilot_usage,
  )
  if (!usage || usage.totalNanoAiu <= 0) return undefined
  recordAic(model, usage)
  return usage.totalNanoAiu
}

/** In-process snapshot (defensive copy). */
export function aicSnapshot(): AicSnapshot {
  return {
    totalNanoAiu: ledger.totalNanoAiu,
    requests: ledger.requests,
    perModel: Object.fromEntries(
      Object.entries(ledger.perModel).map(([k, v]) => [k, { ...v }]),
    ),
    perTokenType: { ...ledger.perTokenType },
    tokensByModel: Object.fromEntries(
      Object.entries(ledger.tokensByModel).map(([k, v]) => [k, { ...v }]),
    ),
  }
}

/**
 * Read a persisted snapshot file (the status-hook path). Returns undefined
 * when missing/unreadable — the hook then prints nothing.
 */
export function readAicSnapshotFile(file: string): AicSnapshot | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined
    }
    const record = parsed as Record<string, unknown>
    if (
      typeof record.totalNanoAiu !== "number"
      || typeof record.requests !== "number"
    ) {
      return undefined
    }
    return {
      totalNanoAiu: Math.max(0, Math.floor(record.totalNanoAiu)),
      requests: Math.max(0, Math.floor(record.requests)),
      perModel:
        record.perModel && typeof record.perModel === "object"
          ? (record.perModel as AicSnapshot["perModel"])
          : {},
      perTokenType:
        record.perTokenType && typeof record.perTokenType === "object"
          ? (record.perTokenType as AicSnapshot["perTokenType"])
          : {},
      // Pre-tokens files (written before this field existed) read as empty
      // rather than failing the hook.
      tokensByModel: sanitizeModelTokens(record.tokensByModel),
    }
  } catch {
    return undefined
  }
}

/** Best-effort sanitize of persisted per-model token counts; `{}` when absent. */
function sanitizeModelTokens(value: unknown): Record<string, AicModelTokens> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, AicModelTokens> = {}
  for (const [model, counts] of Object.entries(value as Record<string, unknown>)) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) continue
    const entry = counts as Record<string, unknown>
    const clean = emptyModelTokens()
    let ok = true
    for (const field of ["input", "cache_read", "cache_write", "output", "other"] as const) {
      const n = entry[field]
      if (n === undefined) continue
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        ok = false
        break
      }
      clean[field] = Math.floor(n)
    }
    if (ok) out[model] = clean
  }
  return out
}

/** Total credits for a snapshot. */
export function aicTotalCredits(snapshot: AicSnapshot): number {
  return nanoAiuToCredits(snapshot.totalNanoAiu)
}

/** One-line status fragment: `[AIC 12.42]`. Empty string when nothing recorded. */
export function formatAicStatus(snapshot: AicSnapshot): string {
  if (snapshot.requests === 0 || snapshot.totalNanoAiu <= 0) return ""
  return `[AIC ${formatAic(aicTotalCredits(snapshot))}]`
}

/**
 * Multi-line exit summary. `verbose` adds per-model and per-type breakdowns
 * (only from upstream-measured values — never estimates).
 */
export function formatAicExitSummary(
  snapshot: AicSnapshot,
  opts: { verbose?: boolean } = {},
): string {
  const total = aicTotalCredits(snapshot)
  const reqWord = snapshot.requests === 1 ? "request" : "requests"
  const lines = [
    `AIC consumed this session: ${formatAic(total)} credits (~$${(total / 100).toFixed(2)}) across ${snapshot.requests} ${reqWord}`,
  ]
  if (opts.verbose) {
    const models = Object.entries(snapshot.perModel).sort(
      (a, b) => b[1].nanoAiu - a[1].nanoAiu,
    )
    for (const [model, entry] of models) {
      const rWord = entry.requests === 1 ? "request" : "requests"
      lines.push(
        `  ${model}: ${formatAic(nanoAiuToCredits(entry.nanoAiu))} credits across ${entry.requests} ${rWord}`,
      )
    }
    const types = Object.entries(snapshot.perTokenType).sort(
      (a, b) => b[1] - a[1],
    )
    if (types.length > 0) {
      lines.push(
        `  by type: ${types.map(([t, n]) => `${t}=${formatAic(nanoAiuToCredits(n))}`).join(" ")}`,
      )
    }
  }
  return lines.join("\n")
}

/** Remove this process's snapshot file; never throws. */
export async function removeAicLedgerFile(): Promise<void> {
  try {
    await fsp.rm(aicLedgerPath(), { force: true })
  } catch {
    // Best-effort cleanup.
  }
}

/** Sweep stale ledger files (dead PID or >24h old); never throws. */
export async function sweepStaleAicLedgerFiles(): Promise<void> {
  try {
    const dir = ledgerDir()
    const entries = await fsp.readdir(dir).catch(() => [] as Array<string>)
    const now = Date.now()
    await Promise.all(
      entries.map(async (entry) => {
        if (!/^\d+\.json$/.test(entry)) return
        const file = path.join(dir, entry)
        try {
          const stat = await fsp.stat(file)
          const pid = Number(entry.slice(0, -".json".length))
          const alive = await isPidAlive(pid)
          if (!alive || now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            await fsp.rm(file, { force: true })
          }
        } catch {
          // Best-effort per file.
        }
      }),
    )
  } catch {
    // Best-effort sweep.
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
