/**
 * Outbound vision preflight.
 *
 * Converts what would otherwise be an opaque upstream `400` into a local,
 * actionable rejection — the same trade `predictedWindowOverflow` in
 * `src/routes/mcp/handler.ts` already makes for prompt tokens, and the reason
 * this file exists at all: `capabilities.limits.vision` advertises three fields
 * (`max_prompt_images`, `max_prompt_image_size`, `supported_media_types`) and
 * until now the proxy read exactly one of them, in the `models` pretty-printer.
 *
 * WHY ONE CHOKEPOINT, NOT PER-ADAPTER CHECKS
 *
 * Images reach the wire through more paths than is obvious: a top-level user
 * block, a block nested inside a `tool_result`, the synthetic follow-up user
 * message the shim emits because a tool-output item cannot carry images, images
 * already present in replayed conversation history, and peer-critic
 * attachments. Validating in each adapter means each adapter has to
 * rediscover every one of those shapes, and the ones it forgets fail silently.
 * So validation runs ONCE, on the fully assembled payload, immediately before
 * transport serialization — `createResponses` and `createChatCompletions` — and
 * is therefore total by construction.
 *
 * POLICY ON MISSING METADATA
 *
 * Deliberately NOT fail-open. "We don't know the limit" is not "there is no
 * limit"; treating it as the latter reproduces the exact opaque-400 this
 * module exists to remove. The three cases are distinguished:
 *
 *   - model absent from the catalog entirely → ALLOW. We have no basis for a
 *     judgement, upstream remains authoritative, and blocking would break
 *     custom catalogs and offline tests. This mirrors `modelSupportsEndpoint`.
 *   - model present, `supports.vision` not true → REJECT, naming the model.
 *   - model present, vision supported, limits absent → CONSERVATIVE FLOOR
 *     (`FLOOR_MAX_IMAGES` / `FLOOR_MAX_IMAGE_BYTES`), and the message says so,
 *     so the caller can tell a real limit from an assumed one.
 *
 * Error strings are returned to callers and end up in front of a model, so they
 * name the model, the numbers, and the fix — never a stack, a local path, or a
 * raw catalog object.
 */

import { decodeBase64Strict, detectImageMimeType } from "./attachments"
import { HTTPError } from "./error"
import { state } from "./state"

/**
 * Floor applied when a model advertises vision but publishes no limits. Every
 * vision-capable model in the live catalog reports at least 1 image and a
 * 3 MiB ceiling, so this is the observed minimum rather than a guess.
 */
const FLOOR_MAX_IMAGES = 1
const FLOOR_MAX_IMAGE_BYTES = 3 * 1024 * 1024

export type VisionPreflight = { ok: true } | { ok: false; message: string }

/** One image as it appears on the assembled outbound payload. */
export interface OutboundImage {
  /**
   * Base64 payload with its declared media type, when the image is inline.
   * Absent for a remote-URL image.
   */
  base64?: string
  declaredMimeType?: string
  /** Set when the image is a remote reference rather than an inline payload. */
  url?: string
}

/**
 * Split a `data:<mime>;base64,<payload>` URI. Returns `null` for any other URL
 * shape (including a plain remote `https://` reference, which the caller
 * handles separately because its bytes are not ours to inspect).
 */
export function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  return { mimeType: match[1] as string, base64: match[2] as string }
}

function reject(message: string): VisionPreflight {
  return { ok: false, message }
}

/**
 * Validate every image on an outbound request against the resolved model's
 * advertised vision capability.
 *
 * Remote-URL images are counted toward the cardinality limit but not size- or
 * type-checked: the bytes live on someone else's server, so any local claim
 * about them would be fiction. Upstream stays authoritative for those.
 */
export function checkOutboundImages(
  modelId: string,
  images: ReadonlyArray<OutboundImage>,
): VisionPreflight {
  if (images.length === 0) return { ok: true }

  const model = state.models?.data.find((m) => m.id === modelId)
  if (!model) return { ok: true }

  const supports = model.capabilities?.supports
  if (supports?.vision !== true) {
    return reject(
      `Model ${modelId} does not support image input. Send text only, or select a `
        + "vision-capable model.",
    )
  }

  const limits = model.capabilities?.limits?.vision
  const maxImages = limits?.max_prompt_images ?? FLOOR_MAX_IMAGES
  const maxBytes = limits?.max_prompt_image_size ?? FLOOR_MAX_IMAGE_BYTES
  const assumed = limits?.max_prompt_images === undefined ? " (assumed; the model publishes no image limits)" : ""

  if (images.length > maxImages) {
    return reject(
      `Model ${modelId} accepts at most ${maxImages} image(s) per request${assumed}, `
        + `but this request carries ${images.length}. Send fewer images, or use a `
        + "model with a higher image limit.",
    )
  }

  const allowedTypes = limits?.supported_media_types
  for (const [index, image] of images.entries()) {
    if (image.url !== undefined && image.base64 === undefined) continue
    const position = `image ${index + 1} of ${images.length}`

    if (image.declaredMimeType === undefined || image.declaredMimeType.length === 0) {
      return reject(
        `${position} has no media type. Anthropic's \`source.media_type\` (or a `
          + "`data:<mime>;base64,` prefix) is required — it used to be defaulted, "
          + "which silently asserted a type the model may not accept.",
      )
    }
    if (image.base64 === undefined) continue

    const bytes = decodeBase64Strict(image.base64)
    if (!bytes) {
      return reject(`${position} is not valid base64 and cannot be sent.`)
    }
    if (bytes.length > maxBytes) {
      return reject(
        `${position} is ${bytes.length} bytes, over model ${modelId}'s `
          + `${maxBytes}-byte limit${assumed}. Re-capture at a smaller scale or lower quality.`,
      )
    }

    // Identify by content. A declared type is an assertion; the bytes are what
    // upstream will actually decode, so a disagreement is caught here rather
    // than becoming a confusing upstream error.
    const actual = detectImageMimeType(bytes)
    if (!actual) {
      return reject(
        `${position} is declared ${image.declaredMimeType} but its bytes are not a `
          + "supported image (jpeg, png, webp, gif, heic, heif).",
      )
    }
    if (actual !== image.declaredMimeType) {
      return reject(
        `${position} is declared ${image.declaredMimeType} but its bytes are ${actual}. `
          + "Send the correct media type.",
      )
    }
    if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(actual)) {
      return reject(
        `${position} is ${actual}, which model ${modelId} does not accept. `
          + `Supported: ${allowedTypes.join(", ")}.`,
      )
    }
  }

  return { ok: true }
}

/** Collect the images on an assembled Copilot `/responses` payload. */
export function imagesInResponsesPayload(input: unknown): Array<OutboundImage> {
  const images: Array<OutboundImage> = []
  if (!Array.isArray(input)) return images
  for (const item of input) {
    if (item === null || typeof item !== "object") continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== "object") continue
      const p = part as { type?: unknown; image_url?: unknown }
      if (p.type !== "input_image" || typeof p.image_url !== "string") continue
      images.push(fromUrl(p.image_url))
    }
  }
  return images
}

/** Collect the images on an assembled Copilot `/chat/completions` payload. */
export function imagesInChatPayload(messages: unknown): Array<OutboundImage> {
  const images: Array<OutboundImage> = []
  if (!Array.isArray(messages)) return images
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== "object") continue
      const p = part as { type?: unknown; image_url?: unknown }
      if (p.type !== "image_url") continue
      const url = (p.image_url as { url?: unknown } | undefined)?.url
      if (typeof url !== "string") continue
      images.push(fromUrl(url))
    }
  }
  return images
}

function fromUrl(url: string): OutboundImage {
  const parsed = parseDataUrl(url)
  return parsed
    ? { base64: parsed.base64, declaredMimeType: parsed.mimeType }
    : { url }
}

/**
 * Run the preflight and throw a client-visible 400 when it fails.
 *
 * Shaped as an `HTTPError` carrying a synthetic `Response` so it flows through
 * the existing `forwardError` path and reaches the client as a normal
 * Anthropic-format `invalid_request_error` — the same envelope an upstream
 * rejection would produce, except it names the actual problem and no upstream
 * request was made. Tests assert that second property: a preflight failure must
 * cost zero upstream calls.
 */
export function assertOutboundImagesOk(modelId: string, images: ReadonlyArray<OutboundImage>): void {
  const verdict = checkOutboundImages(modelId, images)
  if (verdict.ok) return
  throw new HTTPError(
    verdict.message,
    new Response(JSON.stringify({ error: { message: verdict.message } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )
}
