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

export interface AicSnapshot {
  totalNanoAiu: number
  requests: number
  perModel: Record<string, AicModelEntry>
  /** Reconstructed nano-AIU per token_type (input/cache_read/cache_write/output). */
  perTokenType: Record<string, number>
}

function emptySnapshot(): AicSnapshot {
  return {
    totalNanoAiu: 0,
    requests: 0,
    perModel: {},
    perTokenType: {},
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
  for (const detail of usage.tokenDetails) {
    const type = detail.tokenType ?? "unknown"
    // Reconstruct nano-AIU per token type from the priced detail.
    const nano = Math.round(
      (detail.tokenCount * detail.costPerBatch) / detail.batchSize,
    )
    ledger.perTokenType[type] = (ledger.perTokenType[type] ?? 0) + nano
  }
  persistBestEffort()
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

/** In-process snapshot (defensive copy). */
export function aicSnapshot(): AicSnapshot {
  return {
    totalNanoAiu: ledger.totalNanoAiu,
    requests: ledger.requests,
    perModel: Object.fromEntries(
      Object.entries(ledger.perModel).map(([k, v]) => [k, { ...v }]),
    ),
    perTokenType: { ...ledger.perTokenType },
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
    }
  } catch {
    return undefined
  }
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
