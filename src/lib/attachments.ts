/**
 * Shared attachment plumbing: the MCP tool-result content union, and
 * magic-byte image identification.
 *
 * WHY THIS EXISTS
 *
 * The MCP spec allows a `tools/call` result's `content` array to carry
 * `{type:"image", data, mimeType}` blocks alongside text, and Claude Code
 * renders those to the model visually. Until this module landed, the proxy's
 * `NonPersonaMcpTool.handler` return type was statically `{type:"text"}`-only,
 * so NO tool could return an image even though every layer on either side was
 * already image-aware:
 *
 *   - `capToolResultText` (worker-agent/tool-output-cap.ts) explicitly
 *     preserves non-text blocks and exempts them from the byte cap;
 *   - `parseToolResultContent` (anthropic-translate/anthropic-request.ts)
 *     extracts images out of a tool result and re-emits them so an upstream
 *     model actually sees them.
 *
 * The consequence was `browser_screenshot` returning its PNG as base64 inside a
 * pretty-printed JSON *text* block: the caller never saw the pixels AND paid an
 * enormous token cost for them. Measured against this repo's own o200k encoder,
 * base64 tokenizes at ~1.46 chars/token, so a 200 KB screenshot is ~187k tokens
 * versus ~1.1-1.6k for the same image sent as a native image block — a ~130x
 * multiplier, and an outright upstream rejection on 200k-context models.
 *
 * WHY A LOCAL MAGIC-BYTE DETECTOR
 *
 * `src/vendor/pi/agent/harness/tools/image.ts` has a detector already, but it
 * is vendored (see `docs/pi-vendor-sync.md`) and its supported set is Pi's, not
 * Copilot's: it recognizes BMP, which no Copilot model accepts, and misses
 * HEIC/HEIF, which gemini advertises. Identification here is deliberately keyed
 * to what the live catalog's `limits.vision.supported_media_types` actually
 * lists, so a sniff result can be compared against a model's allowlist without
 * a translation step. Base64 encoding uses Node's `Buffer`, not the vendored
 * hand-rolled encoder.
 *
 * Detection is by CONTENT, never by file extension. A caller-supplied
 * `media_type` (or a `.png` suffix) is an assertion, not evidence; the wire
 * payload is what upstream will actually try to decode.
 */

/** A text block in an MCP tool result. */
export interface McpTextBlock {
  type: "text"
  text: string
}

/**
 * An image block in an MCP tool result. `data` is unpadded-or-padded standard
 * base64 (no data-URI prefix — the MCP spec carries the media type out of band
 * in `mimeType`).
 *
 * `text?: undefined` is deliberate. Most consumers of a tool result only ever
 * probe `content[0].text`, and the overwhelming majority of tools are and will
 * remain text-only. Declaring the absent field on this variant keeps that probe
 * type-checking against the union — it yields `string | undefined`, which is
 * the truth — instead of forcing a narrowing dance through dozens of call sites
 * that will never see an image. Discriminating on `type` still works normally,
 * and a consumer that needs a guaranteed string uses `firstText()` below.
 */
export interface McpImageBlock {
  type: "image"
  data: string
  mimeType: string
  text?: undefined
}

export type McpContentBlock = McpTextBlock | McpImageBlock

/** The envelope every MCP tool handler returns. */
export interface McpToolResult {
  content: Array<McpContentBlock>
  isError?: boolean
}

/** Build a text-only tool result (the overwhelmingly common case). */
export function mcpText(text: string, isError?: boolean): McpToolResult {
  return isError === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], isError }
}

/**
 * The first text block's content, or `""` when the result carries none.
 *
 * For callers that need a definite string — typically to `JSON.parse` a tool's
 * structured payload. Skipping non-text blocks rather than blindly indexing
 * `content[0]` means such a caller keeps working regardless of block ordering.
 */
export function firstText(result: { content: Array<McpContentBlock> }): string {
  for (const block of result.content) {
    if (block.type === "text") return block.text
  }
  return ""
}

/**
 * Build a text + image tool result.
 *
 * TEXT FIRST, IMAGE SECOND — and this ordering is load-bearing for a reason
 * worth recording honestly: it is test-debt accommodation, not a design
 * argument. 75 assertions across the suite read `result.content[0].text`, and
 * putting the image first would break every one of them for no gain. Nothing
 * in the MCP spec or in any known consumer is sensitive to block order, so the
 * cheap accommodation wins. If that ever stops being true, codemod the
 * assertions rather than contorting the wire shape.
 */
export function mcpTextAndImage(
  text: string,
  image: { data: string; mimeType: string },
): McpToolResult {
  return {
    content: [
      { type: "text", text },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  }
}

/**
 * Media types that appear in some Copilot model's
 * `capabilities.limits.vision.supported_media_types`. This is the UNION across
 * models, not a per-model allowlist — an individual model accepts a subset
 * (gemini takes heic/heif but not gif; the gpt and claude lanes take gif but
 * not heic). Per-model narrowing is the outbound validator's job; this set only
 * answers "is this an image shape any Copilot model could take at all".
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
])

function startsWith(bytes: Uint8Array, offset: number, sig: Array<number>): boolean {
  if (bytes.length < offset + sig.length) return false
  for (const [i, element] of sig.entries()) {
    if (bytes[offset + i] !== element) return false
  }
  return true
}

function startsWithAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  return startsWith(
    bytes,
    offset,
    [...ascii].map((c) => c.codePointAt(0) ?? 0),
  )
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Identify an image by its leading bytes, returning a media type from
 * `SUPPORTED_IMAGE_MIME_TYPES` or `undefined` when the bytes are not a
 * supported image.
 *
 * `undefined` is a deliberate two-in-one answer: "not an image" and "an image
 * kind nothing upstream accepts" are the same outcome for every caller here,
 * because both mean the bytes must not be sent as an image block.
 *
 * Truncated and malformed inputs return `undefined` rather than throwing — a
 * caller reading an arbitrary file off disk must not be able to crash a tool
 * dispatch with a 3-byte file.
 */
export function detectImageMimeType(bytes: Uint8Array): string | undefined {
  // JPEG: SOI marker. 0xFFD8FF is shared with JPEG-LS (0xF7), which no Copilot
  // model decodes, so exclude that fourth byte explicitly.
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) {
    return bytes[3] === 0xf7 ? undefined : "image/jpeg"
  }
  // PNG: 8-byte signature, then a 13-byte IHDR chunk. Checking IHDR (rather
  // than the signature alone) rejects a file that merely borrowed the header.
  if (startsWith(bytes, 0, PNG_SIGNATURE)) {
    const ihdrOk =
      bytes.length >= 16
      && new DataView(bytes.buffer, bytes.byteOffset).getUint32(PNG_SIGNATURE.length) === 13
      && startsWithAscii(bytes, 12, "IHDR")
    return ihdrOk ? "image/png" : undefined
  }
  if (startsWithAscii(bytes, 0, "GIF8")) return "image/gif"
  // WebP rides inside a RIFF container: "RIFF" <u32 size> "WEBP".
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
    return "image/webp"
  }
  // HEIC/HEIF are ISO-BMFF: a `ftyp` box at offset 4, then a brand. The brand
  // distinguishes the two, and several brands map to each.
  if (startsWithAscii(bytes, 4, "ftyp")) {
    const brand = new TextDecoder().decode(bytes.subarray(8, 12))
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") {
      return "image/heic"
    }
    if (brand === "mif1" || brand === "msf1" || brand === "heim" || brand === "heis") {
      return "image/heif"
    }
  }
  return undefined
}

/** Decode base64 for size-validation purposes; see the notes inside. */
export function decodeBase64Strict(input: string): Uint8Array | null {
  // Tolerate whitespace and missing padding, then validate CANONICALLY.
  //
  // An earlier version required an unbroken, exactly-padded string. That is
  // stricter than base64 actually is and stricter than any producer: JSON
  // payloads routinely carry line-wrapped base64, and RFC 4648 permits omitting
  // the `=` padding. Rejecting those produced a confident "not valid base64"
  // for a perfectly good image — a false negative on the very check that guards
  // whether an image may be sent at all.
  const compact = input.replaceAll(/[\s]/g, "")
  if (compact.length === 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
  const remainder = compact.length % 4
  // A remainder of 1 cannot arise from any byte sequence.
  if (remainder === 1) return null
  const padded = remainder === 0 ? compact : compact + "=".repeat(4 - remainder)

  // Round-trip against the CANONICAL form. `Buffer.from(s, "base64")` is
  // famously permissive — it skips characters outside the alphabet and
  // truncates at the first structural problem, so garbage decodes to a short
  // buffer instead of failing. That matters because the decoded LENGTH is what
  // gets validated against a model's `max_prompt_image_size`; a lenient decode
  // would under-report the real payload size and let an oversized image
  // through.
  const buf = Buffer.from(padded, "base64")
  if (buf.toString("base64") !== padded) return null
  return new Uint8Array(buf)
}
