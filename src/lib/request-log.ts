import consola from "consola"

import { isFileLoggingEnabled } from "~/lib/file-log-reporter"
import type { Model } from "~/services/copilot/get-models"

export interface RequestLogInfo {
  method: string
  path: string
  model?: string
  resolvedModel?: string
  inputTokens?: number
  outputTokens?: number
  status?: number
  streaming?: boolean
  errorBody?: string
  /** Request body size in bytes, when known (see `recordBodySize`). */
  bodyBytes?: number
  /**
   * Milliseconds to the FIRST upstream byte. Only meaningful for a stream:
   * `elapsed` on a streaming request is dominated by generation time, so TTFB
   * is the number that actually reflects proxy overhead.
   */
  ttfbMs?: number
  /**
   * Total stream duration, supplied by the caller when the stream ENDS.
   *
   * Without this, a streaming request reports `Date.now() - startTime` measured
   * at response-object construction — i.e. time-to-headers, not stream
   * duration. That made the single latency number an operator sees wrong for
   * the dominant traffic shape (every Claude Code turn streams).
   */
  streamMs?: number
}

/**
 * Rolling request-body size distribution.
 *
 * Motivation: the cost of the `/v1/messages` prologue (substring guards, JSON
 * parses, re-serialization) scales with body size, but the proxy read
 * `content-length` and never recorded it — so there was no way to tell whether
 * a prologue optimization was worth anything. Benchmarks at 4.5 MiB mean
 * nothing if the real p50 is 40 KiB.
 *
 * Bounded by construction: a fixed-size ring, not a growing array.
 */
const BODY_SIZE_RING = 512
const bodySizes = new Float64Array(BODY_SIZE_RING)
let bodySizeCount = 0
let bodySizeIdx = 0

/** Record one request body size (bytes). Cheap; safe to call per request. */
export function recordBodySize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) return
  bodySizes[bodySizeIdx] = bytes
  bodySizeIdx = (bodySizeIdx + 1) % BODY_SIZE_RING
  if (bodySizeCount < BODY_SIZE_RING) bodySizeCount++
}

/** Percentile snapshot of observed body sizes, or undefined if none seen. */
export function bodySizeStats():
  | { count: number; p50: number; p95: number; p99: number; max: number }
  | undefined {
  if (bodySizeCount === 0) return undefined
  const s = Array.from(bodySizes.slice(0, bodySizeCount)).sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]!
  return {
    count: bodySizeCount,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1]!,
  }
}

/** Test-only: reset the ring so cases don't bleed into each other. */
export function __resetBodySizeStats(): void {
  bodySizeCount = 0
  bodySizeIdx = 0
}

/** Format a byte count compactly (1.2M / 15.3K / 900B). */
function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}M`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`
  return `${n}B`
}

/**
 * Format a number with K/M suffix for compact display.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Build a context window summary: "in:1.2K out:50 ctx:1.2K/1M (0.1%)"
 */
function formatTokenInfo(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  model: Model | undefined,
): string | undefined {
  if (inputTokens === undefined) return undefined

  const parts: Array<string> = []
  const maxPrompt = model?.capabilities?.limits?.max_prompt_tokens

  if (maxPrompt) {
    const pct = ((inputTokens / maxPrompt) * 100).toFixed(1)
    parts.push(`in:${formatTokens(inputTokens)}/${formatTokens(maxPrompt)} (${pct}%)`)
  } else {
    parts.push(`in:${formatTokens(inputTokens)}`)
  }

  if (outputTokens !== undefined) {
    parts.push(`out:${formatTokens(outputTokens)}`)
  }

  return parts.join(" ")
}

/**
 * Will a per-request summary line actually reach a consumer?
 *
 * Two ways it will not:
 *   - consola's level is below `info` (3), so the line is filtered out; or
 *   - file-logging mode is active, whose reporter accepts only
 *     fatal/error/warn and drops `info` entirely.
 *
 * Callers use this to skip work that exists ONLY to populate that line — most
 * notably the BPE tokenization on the `/chat/completions` path, which is
 * synchronous, scales with prompt size, and sits ahead of the upstream call.
 *
 * Deliberately conservative: when in doubt this returns true, so the failure
 * mode is "did unnecessary work", never "silently dropped a field the operator
 * was looking at".
 */
export function requestLogVisible(): boolean {
  if (isFileLoggingEnabled()) return false
  return consola.level >= 3
}

/**
 * Print a single summary line for a completed request.
 *
 * Examples:
 *   POST /v1/messages  claude-opus-4.6-1m  in:1.2K/1M (0.1%) out:50  200  2.3s
 *   POST /v1/messages  claude-opus-4-6→claude-opus-4.6-1m  in:743/1M (0.1%)  200  198ms
 *   POST /v1/chat/completions  claude-sonnet-4  in:15 out:16  200  2.1s stream
 */
export function logRequest(
  info: RequestLogInfo,
  model: Model | undefined,
  startTime: number,
): void {
  const parts: Array<string> = []

  parts.push(`${info.method} ${info.path}`)

  // Model (show resolution arrow if remapped)
  if (info.resolvedModel && info.resolvedModel !== info.model) {
    parts.push(`${info.model}→${info.resolvedModel}`)
  } else if (info.resolvedModel ?? info.model) {
    parts.push((info.resolvedModel ?? info.model)!)
  }

  // Token info with context window fill
  const tokenInfo = formatTokenInfo(info.inputTokens, info.outputTokens, model)
  if (tokenInfo) {
    parts.push(tokenInfo)
  }

  // Body size, when the caller recorded one.
  if (info.bodyBytes !== undefined) {
    parts.push(`body:${formatBytes(info.bodyBytes)}`)
  }

  // Status
  if (info.status !== undefined) {
    parts.push(String(info.status))
  }

  // Duration + streaming flag.
  //
  // For a stream, `Date.now() - startTime` at this call site is
  // time-to-RESPONSE-OBJECT (headers), not stream duration — the body is still
  // being produced when this runs. Prefer an explicit `streamMs` supplied at
  // stream END, and surface TTFB separately, because on a stream the elapsed
  // total is dominated by model generation while TTFB is the part the proxy
  // actually influences.
  const elapsed = info.streamMs ?? Date.now() - startTime
  const fmt = (ms: number) =>
    ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
  if (info.ttfbMs !== undefined) {
    parts.push(`ttfb:${fmt(info.ttfbMs)}`)
  }
  parts.push(info.streaming ? `${fmt(elapsed)} stream` : fmt(elapsed))

  const line = parts.join("  ")

  if (detectCapabilityMismatch(info, model)) {
    consola.error(`[MISMATCH] ${line}`)
  } else {
    consola.info(line)
  }
}

/**
 * Detect when the API rejects a request for token/context reasons
 * that contradict what the /models endpoint reported.
 */
function detectCapabilityMismatch(
  info: RequestLogInfo,
  model: Model | undefined,
): boolean {
  if (!info.errorBody || !model) return false
  if (!info.status || info.status < 400) return false

  const err = info.errorBody.toLowerCase()
  return (
    err.includes("token") ||
    err.includes("context") ||
    err.includes("too long") ||
    err.includes("max_tokens") ||
    err.includes("prompt is too long")
  )
}

/**
 * Opt-in instrumentation for the discovery loop (Phase 0.5 of the
 * long-horizon plan). When `GH_ROUTER_LOG_FIELDS=1` is set in the
 * environment, emits a single structured `[fields]` log line per request
 * recording the top-level body keys, per-tool field keys, and
 * anthropic-beta header values seen.
 *
 * Default-off (zero overhead). The companion
 * `scripts/discover-new-fields.sh` greps these lines, aggregates unique
 * field names per request shape, and diffs against the known-fields
 * list in `docs/copilot-compat-matrix.md` — surfacing anything new
 * that should get a probe row added.
 *
 * Format (single line, deterministic-ish key order):
 *   [fields] path=<P> body_keys=<csv> tool_field_keys=<csv> beta_values=<csv> agent=<id|->
 *
 * Where:
 *   - `body_keys` is the alphabetical union of top-level keys in the
 *     request body
 *   - `tool_field_keys` is the alphabetical union of all keys appearing
 *     across every entry of `body.tools[]` (or empty)
 *   - `beta_values` is the comma-split anthropic-beta header value as
 *     received (NOT filtered) — captures what the client sends, not
 *     what we forward
 *   - `agent` is Claude Code's `x-claude-code-agent-id` header, or `-` for
 *     main-loop traffic. Without it a capture cannot tell a subagent request
 *     from a main-loop one, which is exactly the question you need answered
 *     when reasoning about per-agent request shape (does a subagent send a
 *     `thinking` block?). The header value is opaque to us and is logged
 *     verbatim.
 */
export function logRequestFields(opts: {
  path: string
  body: unknown
  betaHeader?: string
  agentId?: string
}): void {
  if (process.env.GH_ROUTER_LOG_FIELDS !== "1") return
  const bodyKeys = collectTopLevelKeys(opts.body)
  const toolFieldKeys = collectToolFieldKeys(opts.body)
  const betaValues = (opts.betaHeader ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
  consola.info(
    `[fields] path=${opts.path}`
    + ` body_keys=${bodyKeys.join(",")}`
    + ` tool_field_keys=${toolFieldKeys.join(",")}`
    + ` beta_values=${betaValues.join(",")}`
    + ` agent=${opts.agentId && opts.agentId.length > 0 ? opts.agentId : "-"}`,
  )
}

function collectTopLevelKeys(body: unknown): Array<string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>).sort()
}

function collectToolFieldKeys(body: unknown): Array<string> {
  if (!body || typeof body !== "object") return []
  const tools = (body as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (tool && typeof tool === "object" && !Array.isArray(tool)) {
      for (const k of Object.keys(tool as Record<string, unknown>)) {
        seen.add(k)
      }
    }
  }
  return [...seen].sort()
}
