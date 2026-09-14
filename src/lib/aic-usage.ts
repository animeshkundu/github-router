/**
 * AIC (AI Credits) extraction from upstream Copilot `copilot_usage` fields.
 *
 * Verified live (2026-09-14) on all three native endpoints: `/responses`
 * (non-stream top-level + terminal `response.completed` event), `/chat/completions`
 * (non-stream top-level), and `/v1/messages` (non-stream top-level + terminal
 * `message_delta` event). No special request header is required — the field
 * arrives with the proxy's stock headers.
 *
 * Shape:
 * ```json
 * "copilot_usage": {
 *   "token_details": [
 *     {"batch_size":1000000,"cost_per_batch":20000000000,
 *      "model":"gpt-5.6-luna","token_count":11,"token_type":"input"},
 *     ...
 *   ],
 *   "total_nano_aiu": 820000
 * }
 * ```
 * Credits = `total_nano_aiu / 1e9` (SI nano prefix — the same convention the
 * Copilot SDK docs use; treat GitHub billing docs as source of truth before
 * surfacing currency equivalents). Per-type cost reconstructs as
 * `token_count × cost_per_batch / batch_size / 1e9` (verified arithmetically
 * against `total_nano_aiu` on live captures).
 *
 * All parsing is total and never throws: malformed entries are skipped, and a
 * missing/invalid field yields `undefined` so callers fall back cleanly.
 */

/** One entry of `copilot_usage.token_details`. */
export interface CopilotTokenDetail {
  model?: string
  tokenType?: string
  tokenCount: number
  batchSize: number
  costPerBatch: number
}

/** Parsed `copilot_usage` object. */
export interface CopilotUsage {
  totalNanoAiu: number
  tokenDetails: Array<CopilotTokenDetail>
}

/** Nano-AIU per AI credit (SI prefix, per Copilot SDK docs). */
export const NANO_AIU_PER_CREDIT = 1_000_000_000

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0
  }
  return value
}

function parseTokenDetail(value: unknown): CopilotTokenDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const batchSize = nonNegativeNumber(record.batch_size)
  if (batchSize <= 0) return undefined
  return {
    ...(typeof record.model === "string" && record.model.length > 0
      ? { model: record.model }
      : {}),
    ...(typeof record.token_type === "string" && record.token_type.length > 0
      ? { tokenType: record.token_type }
      : {}),
    tokenCount: Math.floor(nonNegativeNumber(record.token_count)),
    batchSize: Math.floor(batchSize),
    costPerBatch: nonNegativeNumber(record.cost_per_batch),
  }
}

/**
 * Extract a validated `CopilotUsage` from an unknown value (typically
 * `responseBody.copilot_usage` or an SSE event's `copilot_usage`).
 * Returns `undefined` when absent or invalid — never throws.
 */
export function extractCopilotUsage(value: unknown): CopilotUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.total_nano_aiu !== "number"
    || !Number.isFinite(record.total_nano_aiu)
    || record.total_nano_aiu < 0
  ) {
    return undefined
  }
  const details: Array<CopilotTokenDetail> = []
  if (Array.isArray(record.token_details)) {
    for (const entry of record.token_details) {
      const parsed = parseTokenDetail(entry)
      if (parsed) details.push(parsed)
    }
  }
  return {
    totalNanoAiu: Math.floor(record.total_nano_aiu),
    tokenDetails: details,
  }
}

/** Convert nano-AIU to AI credits. */
export function nanoAiuToCredits(nanoAiu: number): number {
  if (!Number.isFinite(nanoAiu) || nanoAiu <= 0) return 0
  return nanoAiu / NANO_AIU_PER_CREDIT
}

/** Credits for one token-detail entry. */
export function creditsForDetail(detail: CopilotTokenDetail): number {
  return nanoAiuToCredits(
    (detail.tokenCount * detail.costPerBatch) / detail.batchSize,
  )
}

/**
 * Compact display: `12.42` for totals ≥ 0.01, more precision below.
 * Always a plain number string — callers add units/context.
 */
export function formatAic(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) return "0"
  if (credits >= 100) return credits.toFixed(1)
  if (credits >= 1) return credits.toFixed(2)
  if (credits >= 0.01) return credits.toFixed(3)
  return credits.toPrecision(2)
}
