/**
 * Pi footer statusline: Claude-shaped payload builder + launch constants.
 *
 * `github-router pi` does NOT use the community `npm:pi-statusline` bridge
 * (verified live against v0.0.2: it reads `statusLine` from the user's real
 * `~/.pi/agent/settings.json` / project `.pi/settings.json` and never sees
 * the router-owned mirror behind `PI_CODING_AGENT_DIR`, so a mirror-injected
 * block is dead config; its payload also hardcodes
 * `cost.total_lines_*` to null and derives `used_percentage` from the
 * latest turn only). Instead the mode's own `local:gh-router-pi` extension
 * (see `src/lib/pi-extension.ts`) builds this payload natively from the Pi
 * extension context and spawns the SAME `internal-aic-status` runner Claude
 * uses — one renderer, byte-identical segments.
 *
 * `buildPiStatusPayload` is intentionally dependency-free (no imports, no
 * module-scope references — every helper is nested inside): the generated
 * extension embeds its source via `Function.prototype.toString()`, and a
 * drift test pins that the embedded copy equals this function exactly.
 */

export const PI_STATUS_COMMAND_ENV = "GH_ROUTER_AIC_STATUS_COMMAND"

/** Debounce between Pi refresh events before re-spawning the runner. */
export const PI_STATUSLINE_DEBOUNCE_MS = 300
/** Hard cap for one runner invocation; a hung script must never wedge the footer. */
export const PI_STATUSLINE_TIMEOUT_MS = 5000
/** Width fallback when the footer has never rendered (mirrors default-statusline). */
export const PI_STATUSLINE_WIDTH_FALLBACK = 120

export interface PiStatusModel {
  id?: unknown
  displayName?: unknown
  name?: unknown
  contextWindow?: unknown
}

export interface PiStatusContextUsage {
  tokens?: unknown
  contextWindow?: unknown
  percent?: unknown
}

export interface PiStatusSource {
  cwd?: unknown
  sessionId?: unknown
  model?: PiStatusModel
  contextUsage?: PiStatusContextUsage | null | undefined
  /** `sessionManager.getBranch()` preferred; `getEntries()` accepted. */
  entries?: ReadonlyArray<unknown>
}

export function buildPiStatusPayload(
  source: PiStatusSource,
  opts: { nowMs: number; sessionStartMs?: number },
): Record<string, unknown> {
  function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return {}
  }
  function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  function nonNegativeInt(value: unknown): number | undefined {
    const n = finiteNumber(value)
    if (n === undefined || n < 0) return undefined
    return Math.floor(n)
  }
  function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  function timestampMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      // Pi message timestamps are epoch-ms; entry timestamps are ISO strings.
      return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value)
    }
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }

  const src = asRecord(source)
  const cwd = nonEmptyString(src.cwd) ?? ""
  const sessionId = nonEmptyString(src.sessionId) ?? null
  const model = asRecord(src.model)
  const modelId = nonEmptyString(model.id) ?? null
  const displayName =
    nonEmptyString(model.displayName) ?? nonEmptyString(model.name) ?? modelId
  const usage = asRecord(src.contextUsage)
  const usedPct = finiteNumber(usage.percent)
  const windowSize =
    nonNegativeInt(usage.contextWindow) ?? nonNegativeInt(model.contextWindow) ?? null

  const rawEntries = Array.isArray(src.entries) ? src.entries : []
  let totalIn = 0
  let totalOut = 0
  let seenUsage = false
  let linesAdded = 0
  let linesRemoved = 0
  let latestInput: number | null = null
  let latestOutput: number | null = null
  let latestCacheWrite: number | null = null
  let latestCacheRead: number | null = null
  let firstTs: number | undefined
  let lastTs: number | undefined

  function noteTimestamp(value: unknown): void {
    const ms = timestampMs(value)
    if (ms === undefined) return
    if (firstTs === undefined || ms < firstTs) firstTs = ms
    if (lastTs === undefined || ms > lastTs) lastTs = ms
  }
  function addLines(details: unknown): void {
    const record = asRecord(details)
    if (Object.keys(record).length === 0) return
    const added = finiteNumber(record.linesAdded)
    const removed = finiteNumber(record.linesRemoved)
    if (added !== undefined && added >= 0) linesAdded += Math.floor(added)
    if (removed !== undefined && removed >= 0) linesRemoved += Math.floor(removed)
    // One nesting level (namespaced tool details); deeper shapes are ignored
    // rather than risking double-counts.
    for (const key of ["details", "result", "data"]) {
      const nested = asRecord(record[key])
      if (Object.keys(nested).length === 0) continue
      const nestedAdded = finiteNumber(nested.linesAdded)
      const nestedRemoved = finiteNumber(nested.linesRemoved)
      const consumedParent = added !== undefined || removed !== undefined
      if (!consumedParent) {
        if (nestedAdded !== undefined && nestedAdded >= 0) {
          linesAdded += Math.floor(nestedAdded)
        }
        if (nestedRemoved !== undefined && nestedRemoved >= 0) {
          linesRemoved += Math.floor(nestedRemoved)
        }
      }
    }
  }

  for (const entry of rawEntries) {
    const record = asRecord(entry)
    if (record.type !== "message") continue
    const message = asRecord(record.message)
    noteTimestamp(record.timestamp)
    noteTimestamp(message.timestamp)
    if (message.role === "assistant") {
      if (message.stopReason === "aborted" || message.stopReason === "error") continue
      const entryUsage = asRecord(message.usage)
      const input = nonNegativeInt(entryUsage.input)
      const output = nonNegativeInt(entryUsage.output)
      if (input !== undefined) {
        totalIn += input
        seenUsage = true
      }
      if (output !== undefined) {
        totalOut += output
        seenUsage = true
      }
      latestInput = input ?? latestInput
      latestOutput = output ?? latestOutput
      const cacheWrite = nonNegativeInt(entryUsage.cacheWrite)
      const cacheRead = nonNegativeInt(entryUsage.cacheRead)
      if (cacheWrite !== undefined) latestCacheWrite = cacheWrite
      if (cacheRead !== undefined) latestCacheRead = cacheRead
    } else if (message.role === "toolResult") {
      addLines(message.details)
    }
  }

  // Duration: wall-clock from session start when the extension tracked it
  // (matches Claude's total_duration_ms, idle included); transcript-derived
  // span as the restart-proof fallback; null until either is available.
  let durationMs: number | null = null
  const startMs = finiteNumber(opts.sessionStartMs)
  if (startMs !== undefined && startMs > 0) {
    durationMs = Math.max(0, Math.floor(opts.nowMs - startMs))
  } else if (firstTs !== undefined && lastTs !== undefined) {
    durationMs = Math.max(0, lastTs - firstTs)
  }

  return {
    cwd,
    session_id: sessionId,
    transcript_path: null,
    model: { id: modelId, display_name: displayName },
    workspace: { current_dir: cwd, project_dir: cwd },
    version: null,
    output_style: { name: "default" },
    cost: {
      // List-price USD is deliberately never forwarded (same rule as the
      // Claude path: it contradicts the AIC billing unit). The runner reads
      // duration + line counts from this block.
      total_cost_usd: null,
      total_duration_ms: durationMs,
      total_api_duration_ms: null,
      total_lines_added: linesAdded,
      total_lines_removed: linesRemoved,
    },
    context_window: {
      total_input_tokens: seenUsage ? totalIn : null,
      total_output_tokens: seenUsage ? totalOut : null,
      context_window_size: windowSize,
      // Authoritative Pi percent only — never a latest-turn ratio (the
      // bridge's 3%-vs-42% failure mode). Null renders the `--%` placeholder.
      used_percentage:
        usedPct !== undefined ? Math.max(0, Math.round(usedPct)) : null,
      remaining_percentage:
        usedPct !== undefined ? Math.max(0, 100 - Math.round(usedPct)) : null,
      current_usage:
        latestInput !== null || latestOutput !== null
          ? {
              input_tokens: latestInput,
              output_tokens: latestOutput,
              cache_creation_input_tokens: latestCacheWrite,
              cache_read_input_tokens: latestCacheRead,
            }
          : null,
    },
    exceeds_200k_tokens: false,
    rate_limits: null,
    vim: null,
    agent: null,
    worktree: null,
  }
}
