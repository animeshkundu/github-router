/**
 * Incremental SSE tap that extracts upstream `copilot_usage` (AIC) from a
 * `/v1/messages` byte stream without modifying it.
 *
 * Verified live: `copilot_usage` rides inside the terminal `message_delta`
 * event beside `usage`. Chunks are arbitrary byte splits, so the tap buffers
 * text, splits on blank-line event boundaries, and keeps the tail. Recording
 * fires at most once per tap instance (one terminal event per stream), and
 * only for a priced reading: a zero-nano frame is skipped so an interim
 * free frame can never latch ahead of the real terminal value (same
 * contract as `extractAndRecordPricedAic`).
 *
 * Total and never throws — a malformed frame is skipped silently. The relay
 * path additionally wraps the call in try/catch, so a tap bug can never break
 * byte delivery.
 */

import { extractCopilotUsage, type CopilotUsage } from "./aic-usage"

export interface AicSseTap {
  onBytes(bytes: Uint8Array): void
}

export function createAnthropicAicTap(
  record: (usage: CopilotUsage) => void,
): AicSseTap {
  const decoder = new TextDecoder()
  let buffer = ""
  let recorded = false

  const handleEvent = (rawEvent: string): void => {
    if (recorded) return
    const lines = rawEvent.split("\n")
    let eventName = ""
    const dataLines: Array<string> = []
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
    }
    if (eventName !== "" && eventName !== "message_delta") return
    if (dataLines.length === 0) return
    // Only JSON object payloads can carry `copilot_usage`.
    const first = dataLines[0] ?? ""
    if (!first.startsWith("{")) return
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n"))
      const usage = extractCopilotUsage(
        (parsed as Record<string, unknown>).copilot_usage,
      )
      // Priced-only latch (same contract as `extractAndRecordPricedAic`):
      // an interim zero-nano frame is "no reading yet", not a free request.
      if (usage && usage.totalNanoAiu > 0) {
        recorded = true
        try {
          record(usage)
        } catch {
          // A record failure must never break the tap (the relay guards
          // too — belt and braces, since taps may be reused elsewhere).
        }
      }
    } catch {
      // Malformed frame — skip.
    }
  }

  return {
    onBytes(bytes: Uint8Array): void {
      if (recorded || bytes.length === 0) return
      buffer += decoder.decode(bytes, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        handleEvent(rawEvent)
        if (recorded) {
          // Keep buffering cheap from here on; onBytes early-returns anyway.
          buffer = ""
          return
        }
        boundary = buffer.indexOf("\n\n")
      }
      // Bound the tail: a single event larger than 1 MiB without a boundary
      // is pathological — drop it rather than growing without end.
      if (buffer.length > 1_048_576) buffer = ""
    },
  }
}
