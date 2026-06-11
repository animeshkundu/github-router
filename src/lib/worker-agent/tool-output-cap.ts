/**
 * Generic, boundary-safe cap for a worker tool's model-visible TEXT output.
 *
 * Applied in the engine's `afterToolCall` hook to EVERY worker tool result
 * (browse `read_page`, fs `read`, `bash`, `grep`, …). `afterToolCall` can
 * replace the result content (`agent-loop.ts:689-696`), and each parallel
 * tool's hook caps ITS OWN result independently — no shared counter, so it is
 * race-free regardless of the concurrent batch. The per-turn AGGREGATE (N
 * parallel results) is bounded separately by the structural compactor's
 * current-turn truncation before the next request. So a single dynamic
 * per-result cap here + the compactor replace the old per-turn ledger.
 *
 * The cap is sized from the per-run `ContextBudget` (≈30% of the window), so
 * most pages/files fit in ONE read (fast + full content) and only genuinely
 * huge results are truncated — with a notice that cues continuation.
 */

const TRUNCATE_HEAD_FRACTION = 0.7

/**
 * Truncate `text` to at most `capBytes` UTF-8 bytes, keeping a head+tail
 * window (the answer is usually near the top; the tail preserves
 * footers/totals/pagination) with a continuation notice between. UTF-8 safe:
 * the head uses a streaming decode that holds back a split trailing code
 * point, and the tail skips leading continuation bytes — so no replacement
 * char (`�`) appears at either boundary.
 */
export function truncateModelText(text: string, capBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= capBytes) return text
  const notice =
    `\n\n[…truncated: result was ${Math.round(bytes.length / 1024)}KB, over the `
    + `${Math.round(capBytes / 1024)}KB cap, and was shortened to fit the model's `
    + "context. Narrow it — scroll to the relevant section, or use a more "
    + "specific query/selector/offset, then read again.…]\n\n"
  const noticeBytes = new TextEncoder().encode(notice)
  // Degenerate cap (smaller than the notice itself — unreachable with real
  // budgets, but keeps the output ≤ cap invariant total).
  if (noticeBytes.length >= capBytes) {
    return new TextDecoder().decode(noticeBytes.subarray(0, capBytes), { stream: true })
  }
  const budget = capBytes - noticeBytes.length
  const headBytes = Math.floor(budget * TRUNCATE_HEAD_FRACTION)
  const tailBytes = budget - headBytes
  const head = new TextDecoder().decode(bytes.subarray(0, headBytes), { stream: true })
  let tailStart = bytes.length - tailBytes
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) {
    tailStart++
  }
  const tail = new TextDecoder().decode(bytes.subarray(tailStart))
  return head + notice + tail
}

type TextBlock = { type: "text"; text: string }
type ContentBlock = TextBlock | { type: string; [k: string]: unknown }

/**
 * Cap a tool result's TEXT content to `capBytes`, preserving any non-text
 * (image) blocks. Returns the replacement content array, or `undefined` when
 * the result is already under the cap (caller leaves it untouched).
 *
 * Images are preserved and do NOT count toward the text cap — the model sees
 * them directly; they aren't the context-pollution vector this cap targets.
 */
export function capToolResultText(
  content: unknown,
  capBytes: number,
): Array<TextBlock> | undefined {
  if (content === null || content === undefined) return undefined

  if (typeof content === "string") {
    if (Buffer.byteLength(content, "utf8") <= capBytes) return undefined
    return [{ type: "text", text: truncateModelText(content, capBytes) }]
  }
  if (!Array.isArray(content)) return undefined

  let textBytes = 0
  const texts: string[] = []
  const images: ContentBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text)
      textBytes += Buffer.byteLength(b.text, "utf8")
    } else {
      images.push(block as ContentBlock)
    }
  }
  if (textBytes <= capBytes) return undefined
  const capped = truncateModelText(texts.join("\n"), capBytes)
  return [...images, { type: "text", text: capped }] as Array<TextBlock>
}
