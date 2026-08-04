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
 * Per-result image budget.
 *
 * Images are cheap in TOKENS (a vision image costs ~1.5k regardless of byte
 * size) but not in BYTES: three 3 MiB captures is ~12 MiB of base64 on the wire
 * and in memory, and they accumulate across turns. The text cap does not bound
 * them — and should not, since counting base64 against a text budget would
 * evict real text to make room for an image the model reads for free.
 *
 * `MAX_IMAGES_PER_RESULT` is the ceiling of the most permissive model in the
 * live catalog (gemini's 10). `MAX_IMAGE_BYTES_PER_RESULT` is the published
 * 3 MiB per-image ceiling times a small factor, so a legitimate multi-image
 * result passes and a runaway one does not.
 */
const MAX_IMAGES_PER_RESULT = 10
const MAX_IMAGE_BYTES_PER_RESULT = 12 * 1024 * 1024

/** Decoded byte size of a base64 payload, without allocating the buffer. */
function base64Bytes(data: unknown): number {
  if (typeof data !== "string" || data.length === 0) return 0
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/**
 * Trim an image list to the budget, returning the survivors plus a note naming
 * what was dropped. Dropping silently is not an option: a model told to compare
 * five screenshots, shown three, and given no indication, will reason
 * confidently about a set it never saw.
 */
function capImages(images: Array<ContentBlock>): {
  kept: Array<ContentBlock>
  note: string | undefined
} {
  const kept: Array<ContentBlock> = []
  let bytes = 0
  let dropped = 0
  for (const img of images) {
    if (kept.length >= MAX_IMAGES_PER_RESULT) {
      dropped++
      continue
    }
    const size = base64Bytes((img as { data?: unknown }).data)
    // `continue`, not `break`: one oversized image must not also discard the
    // smaller ones behind it. Skipping the offender keeps as much of the result
    // as the budget allows.
    if (bytes + size > MAX_IMAGE_BYTES_PER_RESULT) {
      dropped++
      continue
    }
    bytes += size
    kept.push(img)
  }
  if (dropped === 0) return { kept, note: undefined }
  const note =
    NEWLINE + NEWLINE
    + `[...${dropped} of ${images.length} image(s) dropped: over the per-result budget `
    + `of ${MAX_IMAGES_PER_RESULT} images / `
    + `${Math.round(MAX_IMAGE_BYTES_PER_RESULT / (1024 * 1024))} MiB. Request fewer `
    + "images at a time, or capture at a lower quality....]"
  return { kept, note }
}

/** Literal newline, kept out of the template above for readability. */
const NEWLINE = "\n"

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
  // Anything that is neither text nor an image (audio, resource links, a future
  // block type) passes through untouched. Lumping those in with images meant
  // they consumed the image budget and could be dropped by a cap that was never
  // about them.
  const other: ContentBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text)
      textBytes += Buffer.byteLength(b.text, "utf8")
    } else if (b.type === "image") {
      images.push(block as ContentBlock)
    } else {
      other.push(block as ContentBlock)
    }
  }
  const { kept, note } = capImages(images)
  // The early return used to test `textBytes <= capBytes` alone, so an
  // ALL-IMAGE result (textBytes === 0) was never inspected and images bypassed
  // every budget in the system. Now the result is also rewritten when the
  // image budget bites.
  if (textBytes <= capBytes && note === undefined) return undefined
  const joined = texts.join(NEWLINE)
  const capped =
    textBytes > capBytes ? truncateModelText(joined, capBytes) : joined
  return [...kept, ...other, { type: "text", text: capped + (note ?? "") }] as Array<TextBlock>
}
