import { parseBoolEnv } from "~/lib/exec"
import type { ByteTransform } from "~/lib/stream-relay"

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** The usage fields this module reasons about, in log order. */
const USAGE_KEYS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
] as const

/**
 * Cap on a single un-terminated SSE record held in the transform buffer.
 * A record that grows past this is emitted verbatim rather than buffered
 * forever, so a pathological upstream event is passed through instead of
 * being truncated or held in memory.
 */
const MAX_PENDING_RECORD_BYTES = 1 << 20

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

/**
 * True when the operator has opted out of the Anthropic usage rewrite.
 *
 * The rewrite targets an upstream that reports `input_tokens` as the TOTAL
 * prompt with the cached prefix as a DETAIL of that total (OpenAI semantics)
 * rather than as the uncached remainder (the Anthropic contract). BOTH shapes
 * have been measured in real traffic through this proxy: session `ec65e3f9`
 * was inclusive on the native Copilot path, the same path captured exclusive
 * on 2026-11-05, and the local endpoint of session `a1ab11a5` was inclusive.
 * An operator pointing `--localurl` at an upstream whose shape the
 * `input < cached` guard cannot discriminate can disable the rewrite here.
 */
export function anthropicUsageNormalizeDisabled(): boolean {
  return (
    parseBoolEnv(process.env.GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE)
    === true
  )
}

/**
 * Rewrite an Anthropic-shaped `usage` object so its three input buckets are
 * mutually exclusive, which is what Anthropic clients (and Claude Code's
 * context meter) sum.
 *
 * The problem this fixes: some upstreams report `input_tokens` INCLUSIVE of
 * `cache_read_input_tokens` — OpenAI semantics inside an Anthropic-shaped
 * usage object. Claude Code computes context size as `input_tokens +
 * cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, so
 * forwarding the inclusive figure counts the cached prefix twice. Measured on
 * a warm turn in session `ec65e3f9` (native Copilot path): turn 1 `55931/0`
 * followed by turn 2 `56423/55808` across an exchange whose entire new
 * payload was under 2 KB. Under the exclusive reading that turn would have
 * added ~56,300 tokens; inclusive predicts +492, which is what happened. The
 * local egress is inclusive too: a 2026-11-05 capture of `-m local` showed a
 * warm `message_delta` of `input_tokens=45620 cache_read_input_tokens=45440`,
 * and the client meter read 91,060 for a 45,620-token prompt. The doubled
 * meter halves the effective context window and makes autocompact thrash on
 * sessions with a large static prefix.
 *
 * NOT every upstream is inclusive, and the Copilot path is not guaranteed to
 * be: an advisor-off capture of it on 2026-11-05 reported `message_start
 * input_tokens=2 cache_creation_input_tokens=66941`, which only the exclusive
 * reading explains. Every capture so far delivered `input_tokens` and the
 * cache buckets on the SAME SSE record, so the guard below is what
 * discriminates the two shapes rather than across-frame reassembly.
 *
 * The math mirrors `normalizeOpenAIUsage` in `~/lib/prompt-cache`:
 * `uncached = total - cacheRead - cacheWrite`.
 *
 * The guard is what lets this run unconditionally. An exclusive (conformant)
 * upstream reports the uncached remainder as `input_tokens`, which on a warm
 * turn is SMALLER than the cached prefix — a shape that is impossible under
 * inclusive semantics. Such a response is left byte-for-byte alone. A cold
 * turn reports no cache at all, where both conventions agree, so it is a
 * no-op too.
 *
 * Residual ambiguity: an exclusive upstream whose uncached remainder exceeds
 * its cached prefix (`input >= cached`) is misread as inclusive and
 * under-reported by the cached total. That takes a single turn adding more
 * new tokens than the whole cached prefix, and it applies to EITHER egress,
 * since the native Copilot path has been measured exclusive. The error
 * direction is the safe one: the meter under-reads, so the client compacts
 * later rather than earlier.
 * `GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE` exists for an upstream whose
 * shape the guard cannot discriminate.
 *
 * CALL ONCE PER USAGE OBJECT. The rewrite is not idempotent: a second pass
 * over an already-corrected object subtracts the cache buckets again whenever
 * the remainder is at least the cached total. Every caller applies it exactly
 * once — one call per SSE record, one call per non-streaming response, and a
 * freshly built map per advisor `message_delta`.
 *
 * Never throws. Returns true iff `usage.input_tokens` was rewritten.
 */
export function normalizeAnthropicUsageInPlace(usage: unknown): boolean {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false
  const record = usage as Record<string, unknown>
  const input = nonNegativeInt(record.input_tokens)
  const cached =
    nonNegativeInt(record.cache_read_input_tokens)
    + nonNegativeInt(record.cache_creation_input_tokens)
  if (cached <= 0) return false
  // Exclusive shape: impossible under inclusive semantics, so leave verbatim.
  if (input < cached) return false
  const next = Math.max(0, input - cached)
  if (next === record.input_tokens) return false
  record.input_tokens = next
  return true
}

/**
 * Length of the SSE record terminator beginning at `index` (a `\n`), or 0 if
 * no blank-line terminator starts there. Handles both `\n\n` and `\r\n\r\n`.
 */
function terminatorLengthAt(buffer: Uint8Array, index: number): number {
  if (buffer[index + 1] === 0x0a) return 2
  if (buffer[index + 1] === 0x0d && buffer[index + 2] === 0x0a) return 3
  return 0
}

/** First complete SSE record terminator in `buffer`, if any. */
function findRecordTerminator(
  buffer: Uint8Array,
): { index: number; length: number } | undefined {
  for (let index = 0; index < buffer.byteLength - 1; index++) {
    if (buffer[index] !== 0x0a) continue
    const length = terminatorLengthAt(buffer, index)
    if (length > 0 && index + length <= buffer.byteLength) {
      return { index, length }
    }
  }
  return undefined
}

/**
 * Opt-in wire diagnostic (`GH_ROUTER_LOG_ANTHROPIC_USAGE_FRAMES=1`), matching
 * the `GH_ROUTER_LOG_FIELDS` / `GH_ROUTER_LOG_CACHE` convention.
 *
 * The rewrite rests on an upstream wire detail Copilot does not version:
 * whether `input_tokens` and the cache buckets arrive on the SAME SSE record.
 * Only a record carrying both is rewritten, so a split shape would silently
 * turn the rewrite into a no-op — and no unit test can observe the real
 * upstream shape. Logs one line per `message_start` / `message_delta` with
 * numeric usage fields only: no prompt text, no payloads, no identifiers.
 *
 * Called BEFORE normalization, so the values are exactly what upstream sent.
 * Writes to stderr directly (the `GH_ROUTER_LOG_PEER_MCP` pattern) so it is
 * visible regardless of consola level and can never interleave with a
 * JSONL-speaking client's stdout.
 *
 * Both egresses captured on 2026-11-05 (native Copilot, and `-m local` against
 * an LM Studio-backed gateway) delivered `input_tokens` and the cache buckets
 * on the same `message_delta` record, which is why the transform needs no
 * across-frame state. That is an unversioned upstream detail: if it ever
 * splits, the rewrite becomes a silent no-op and these lines are the only
 * signal, so the flag stays in the product rather than in a one-off script.
 *
 * It runs inside the rewrite transform, so it is silent when
 * `GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE` is set — that path installs no
 * transform at all.
 */
function logUsageFrame(eventType: string, usage: unknown): void {
  if (process.env.GH_ROUTER_LOG_ANTHROPIC_USAGE_FRAMES !== "1") return
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    process.stderr.write(`[anthropic-usage] ${eventType} usage=absent\n`)
    return
  }
  const record = usage as Record<string, unknown>
  const fields = USAGE_KEYS.map((key) => {
    const value = record[key]
    return `${key}=${typeof value === "number" ? value : "absent"}`
  })
  process.stderr.write(
    `[anthropic-usage] ${eventType} ${fields.join(" ")}\n`,
  )
}

/**
 * Rewrite one complete SSE record if it carries usage. Records that need no
 * correction — every event type other than `message_start` / `message_delta`,
 * unparseable payloads, and already-disjoint usage — are returned as the
 * exact bytes they arrived as.
 */
function rewriteRecord(record: Uint8Array): Uint8Array {
  const text = DECODER.decode(record)
  const dataMatch = /(?:^|\n)data:/.exec(text)
  if (!dataMatch) return record
  const dataStart = dataMatch.index + (dataMatch[0].length - "data:".length)

  // SSE allows an event to spread its payload across several `data:` lines;
  // Anthropic emits one. Reassemble the contiguous run the same way a
  // conformant parser would.
  const dataLines: Array<string> = []
  for (const line of text.slice(dataStart).split("\n")) {
    if (!line.startsWith("data:")) break
    dataLines.push(line.slice("data:".length).replace(/^ /, ""))
  }
  if (dataLines.length === 0) return record

  let payload: unknown
  try {
    payload = JSON.parse(dataLines.join("\n"))
  } catch {
    return record
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return record
  }

  const event = payload as Record<string, unknown>
  let changed = false
  if (event.type === "message_start") {
    const message = event.message
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const usage = (message as Record<string, unknown>).usage
      logUsageFrame("message_start", usage)
      changed = normalizeAnthropicUsageInPlace(usage) || changed
    }
  } else if (event.type === "message_delta") {
    logUsageFrame("message_delta", event.usage)
    changed = normalizeAnthropicUsageInPlace(event.usage) || changed
  }
  if (!changed) return record

  // Rebuild only the data lines. Everything before the first `data:` line
  // (Anthropic's `event:` line) is preserved verbatim; the terminator is
  // normalized to `\n\n`, which SSE parsers treat identically to `\r\n\r\n`.
  // Only records whose usage actually changed reach this point.
  const prefix = text.slice(0, dataStart)
  return ENCODER.encode(`${prefix}data: ${JSON.stringify(event)}\n\n`)
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right
  if (right.byteLength === 0) return left
  const out = new Uint8Array(left.byteLength + right.byteLength)
  out.set(left, 0)
  out.set(right, left.byteLength)
  return out
}

/**
 * Streaming counterpart of `normalizeAnthropicUsageInPlace`, shaped for
 * `relayAnthropicStream`'s `transform` hook.
 *
 * Buffers across arbitrary chunk boundaries and only ever emits COMPLETE SSE
 * records, so an event split mid-record is never corrupted. `flush()` releases
 * a trailing partial record at upstream EOF; a stream that ends without its
 * terminator must not lose bytes.
 */
export function createAnthropicUsageRewriteTransform(): ByteTransform {
  let pending: Uint8Array = new Uint8Array(0)

  return {
    push(bytes: Uint8Array): Uint8Array | undefined {
      pending = concat(pending, bytes)
      let emitted: Uint8Array | undefined
      for (;;) {
        const terminator = findRecordTerminator(pending)
        if (!terminator) break
        const end = terminator.index + terminator.length
        const record = pending.subarray(0, end)
        pending = pending.subarray(end)
        const rewritten = rewriteRecord(record)
        emitted = emitted ? concat(emitted, rewritten) : rewritten
      }
      if (pending.byteLength > MAX_PENDING_RECORD_BYTES) {
        emitted = emitted ? concat(emitted, pending) : pending
        pending = new Uint8Array(0)
      }
      return emitted
    },
    flush(): Uint8Array | undefined {
      if (pending.byteLength === 0) return undefined
      const tail = pending
      pending = new Uint8Array(0)
      return tail
    },
  }
}
