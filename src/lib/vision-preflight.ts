/**
 * Outbound vision handling.
 *
 * WHO DECIDES THE IMAGE LIMIT
 *
 * Copilot does, and this module no longer guesses. The catalog advertises a
 * `max_prompt_images` limit, and that field was measured against the live API
 * on 2026-08-10 across all 23 vision-capable models:
 *
 *   - gemini-3.x        catalog 10 → upstream enforces exactly 10
 *   - gpt-5.x           catalog  1 → upstream enforces 50
 *   - claude-opus-*     catalog  1 → accepted 128, no ceiling found
 *   - claude-sonnet/haiku catalog 5 → accepted 32+
 *
 * So the field is accurate for one family and understates the truth by 32x to
 * 128x everywhere else. A local cardinality reject built on it rejected at 2
 * what upstream serves at 50, and — because the count was taken over the whole
 * assembled payload including replayed history — the caller could not act on
 * the error, so every retry reproduced it and the session was finished.
 *
 * Upstream also enforces rules this module does not model at all (minimum pixel
 * dimensions on grok-4.5, per-model media-type support on gpt-4o), which is the
 * general argument: local pre-validation cannot be complete, and where it
 * guesses it is wrong.
 *
 * WHAT WE DO INSTEAD
 *
 * Send it, and recover from upstream's answer. Copilot's rejections name the
 * real number ("maximum allowed for model gemini-3.6-flash is 10, got 16",
 * "Exceeded maximum number of images (50) allowed in the request"), so
 * `parseUpstreamImageCeiling` reads it, `planOutboundImages` prunes to it, the
 * transport retries once, and `rememberImageCeiling` keeps it for the process
 * lifetime so the round trip is paid once per model per boot. The learned value
 * is an observation rather than a guess, and it self-heals if Copilot changes.
 *
 * WHY ONE CHOKEPOINT, NOT PER-ADAPTER CHECKS
 *
 * Images reach the wire through more paths than is obvious: a top-level user
 * block, a block nested inside a `tool_result`, the synthetic follow-up user
 * message the shim emits because a tool-output item cannot carry images, images
 * already present in replayed conversation history, and peer-critic
 * attachments. Handling this in each adapter means each adapter has to
 * rediscover every one of those shapes, and the ones it forgets fail silently.
 * So it runs ONCE, on the fully assembled payload, immediately before transport
 * serialization, and is therefore total by construction.
 *
 * NOTHING HERE FAILS A REQUEST
 *
 * A defect that is fatal for a whole request is fatal forever once the image is
 * in replayed history, because the caller cannot edit history. So every defect
 * this module recognises drops that one image and replaces it IN PLACE with a
 * short text note the model can read and relay. In place, never deletion: a
 * turn whose only content was a screenshot would otherwise become an empty
 * content array, which upstream does reject.
 *
 * Note text carries no ordinals and no running totals. Claude Code replays the
 * whole transcript every turn, so a note reading "image 1 of 2" would become
 * "image 1 of 3" on the next image and invalidate the prompt-cache prefix from
 * the earliest omission onward.
 */

import consola from "consola"

import { decodeBase64Strict, detectImageMimeType } from "./attachments"
import { state } from "./state"

/**
 * Applied when a model advertises vision but publishes no size limit. Every
 * vision-capable model in the live catalog reports 3 MiB, so this is the
 * observed value rather than a guess. There is deliberately no image-COUNT
 * floor: that is the number upstream turned out to own.
 */
const FLOOR_MAX_IMAGE_BYTES = 3 * 1024 * 1024

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

/** Per-image outcome. `reason` and `note` are set exactly when `keep` is false. */
export interface ImageVerdict {
  keep: boolean
  /** Diagnostic sentence, used for the warn log. */
  reason?: string
  /** Model-visible replacement text the pruner substitutes in place. */
  note?: string
}

export interface VisionPlan {
  /** One verdict per input image, index-aligned with the array passed in. */
  verdicts: Array<ImageVerdict>
  kept: number
  dropped: number
}

// ---------------------------------------------------------------------------
// Learned per-model ceilings
// ---------------------------------------------------------------------------

/**
 * Ceilings observed from upstream rejections, keyed by model id. Process
 * lifetime only, and deliberately not persisted: a stale number on disk would
 * be exactly the catalog problem again, one indirection further away.
 */
const learnedCeilings = new Map<string, number>()

export function learnedImageCeiling(modelId: string): number | undefined {
  return learnedCeilings.get(modelId)
}

export function rememberImageCeiling(modelId: string, ceiling: number): void {
  // A ceiling of 0 is a one-way trapdoor: it would drop every image for this
  // model for the rest of the process, and because nothing is then sent,
  // upstream can never reject for images again and the entry can never be
  // re-learned. That is the failure this module exists to remove, reintroduced
  // process-wide. A cardinality ceiling below 1 is not a cardinality statement.
  if (!Number.isInteger(ceiling) || ceiling < 1) return
  learnedCeilings.set(modelId, ceiling)
}

/** True when anything has been learned at all — a cheap pre-parse gate. */
export function hasLearnedImageCeilings(): boolean {
  return learnedCeilings.size > 0
}

/** Test seam. Production never clears the map. */
export function resetLearnedImageCeilings(): void {
  learnedCeilings.clear()
}

/**
 * Both rejection shapes Copilot was observed to emit carry the real ceiling:
 *
 *   too many images: maximum allowed for model gemini-3.6-flash is 10, got 16
 *   Exceeded maximum number of images (50) allowed in the request.
 *
 * Anything else returns `undefined`, and the caller forwards upstream's error
 * untouched. A parser that guesses would reintroduce the failure this module
 * was rewritten to remove.
 */
const CEILING_PATTERNS: ReadonlyArray<RegExp> = [
  /maximum allowed for model \S+ is (\d+)/i,
  /exceeded maximum number of images \((\d+)\)/i,
]

export function parseUpstreamImageCeiling(body: string): number | undefined {
  // Both patterns are image-specific on their own, but requiring the word keeps
  // a future reworded limit for some other resource from matching by accident.
  if (!/image/i.test(body)) return undefined
  for (const pattern of CEILING_PATTERNS) {
    const match = pattern.exec(body)
    if (!match) continue
    const ceiling = Number(match[1])
    // Lower bound matters as much as the upper one: a captured 0 would become a
    // permanent all-images-dropped state for that model. Upper bound guards
    // against a malformed capture becoming a nonsense budget.
    if (Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= 10_000) {
      return ceiling
    }
  }
  return undefined
}

/**
 * Read an error body without consuming it, so the existing error path can still
 * report the same text downstream. Never throws: a body we cannot read simply
 * yields no ceiling and upstream's error is forwarded as it always was.
 */
export async function peekErrorBody(response: Response): Promise<string> {
  try {
    return await response.clone().text()
  } catch {
    return ""
  }
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

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Judge one image on its own merits. Returns `undefined` when it is fine.
 *
 * Remote-URL images are never judged here: the bytes live on someone else's
 * server, so any local claim about them would be fiction.
 */
function imageDefect(
  image: OutboundImage,
  modelId: string,
  maxBytes: number,
  assumed: string,
  allowedTypes: ReadonlyArray<string> | undefined,
): { reason: string; note: string } | undefined {
  if (image.url !== undefined && image.base64 === undefined) return undefined

  if (image.declaredMimeType === undefined || image.declaredMimeType.length === 0) {
    return {
      reason: "no media type declared",
      note: "[image removed: no media type was declared, so it could not be sent]",
    }
  }
  if (image.base64 === undefined) return undefined

  const bytes = decodeBase64Strict(image.base64)
  if (!bytes) {
    return {
      reason: "not valid base64",
      note: "[image removed: the image data was not valid base64]",
    }
  }
  if (bytes.length > maxBytes) {
    return {
      reason: `${bytes.length} bytes over model ${modelId}'s ${maxBytes}-byte limit${assumed}`,
      note:
        `[image removed: it is over this model's ${maxBytes}-byte limit; `
        + "re-capture at a smaller scale or lower quality]",
    }
  }

  // Identify by content. A declared type is an assertion; the bytes are what
  // upstream will actually decode, so a disagreement is caught here rather than
  // becoming a confusing upstream error.
  const actual = detectImageMimeType(bytes)
  if (!actual) {
    return {
      reason: `declared ${image.declaredMimeType} but the bytes are not a supported image`,
      note:
        `[image removed: it is declared ${image.declaredMimeType} but its bytes are not a `
        + "supported image (jpeg, png, webp, gif, heic, heif)]",
    }
  }
  if (actual !== image.declaredMimeType) {
    return {
      reason: `declared ${image.declaredMimeType} but the bytes are ${actual}`,
      note:
        `[image removed: it is declared ${image.declaredMimeType} but its bytes are `
        + `${actual}; send the correct media type]`,
    }
  }
  if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(actual)) {
    return {
      reason: `${actual} is not in model ${modelId}'s accepted media types`,
      note:
        `[image removed: ${actual} is not accepted by this model; `
        + `it accepts ${allowedTypes.join(", ")}]`,
    }
  }
  return undefined
}

function keepAll(count: number): VisionPlan {
  return {
    verdicts: Array.from({ length: count }, () => ({ keep: true })),
    kept: count,
    dropped: 0,
  }
}

/**
 * Decide, per image, what goes on the wire.
 *
 * `maxImages` is the CARDINALITY budget, and it comes only from a ceiling
 * upstream actually stated — never from the catalog, whose `max_prompt_images`
 * was measured wrong for 20 of 23 models. Omit it and no image is dropped for
 * being one too many.
 *
 * Validity is judged BEFORE the budget so a malformed image cannot consume a
 * slot and evict a good one, and the budget pass never rewrites a verdict the
 * validity pass already set — a malformed image must not be reported as a
 * cardinality eviction.
 */
export function planOutboundImages(
  modelId: string,
  images: ReadonlyArray<OutboundImage>,
  options?: { maxImages?: number },
): VisionPlan {
  if (images.length === 0) return { verdicts: [], kept: 0, dropped: 0 }

  const model = state.models?.data.find((m) => m.id === modelId)
  const maxImages = options?.maxImages

  // Unknown model: no basis for a judgement, upstream stays authoritative, and
  // blocking would break custom catalogs and offline tests. An explicit ceiling
  // still applies, because that one came from upstream itself.
  if (!model) {
    if (maxImages === undefined) return keepAll(images.length)
  }

  const supports = model?.capabilities?.supports
  if (model && supports?.vision !== true) {
    const note =
      `[image removed: model ${modelId} does not accept image input; `
      + "select a vision-capable model to send images]"
    return {
      verdicts: images.map(() => ({
        keep: false,
        reason: `model ${modelId} does not support image input`,
        note,
      })),
      kept: 0,
      dropped: images.length,
    }
  }

  const limits = model?.capabilities?.limits?.vision
  const maxBytes = limits?.max_prompt_image_size ?? FLOOR_MAX_IMAGE_BYTES
  const assumed =
    limits?.max_prompt_image_size === undefined ?
      " (assumed; the model publishes no image size limit)"
    : ""
  const allowedTypes = limits?.supported_media_types

  const verdicts: Array<ImageVerdict> = images.map((image) => {
    // For an unknown model we have no size limit and no accepted-type list to
    // judge against, but the model-agnostic defects (no media type, malformed
    // base64, bytes that are not an image at all) still hold — and they must be
    // judged, or a garbage image could consume a slot under an upstream-stated
    // ceiling and evict a good one.
    const defect =
      model ?
        imageDefect(image, modelId, maxBytes, assumed, allowedTypes)
      : imageDefect(image, modelId, Number.POSITIVE_INFINITY, "", undefined)
    return defect ? { keep: false, reason: defect.reason, note: defect.note } : { keep: true }
  })

  // Cardinality pass. Walk backwards so the survivors are the LAST `maxImages`
  // in payload order — the newest image is what the current turn is about.
  // `admitted < maxImages` rather than an equality test: a malformed ceiling of
  // 0 or NaN must admit nothing, not sail past a test that never fires.
  if (maxImages !== undefined) {
    const overflowNote =
      `[image removed: this model accepts at most ${maxImages} `
      + `image${maxImages === 1 ? "" : "s"} per request, so only the most recent were sent]`
    let admitted = 0
    for (let index = verdicts.length - 1; index >= 0; index--) {
      const verdict = verdicts[index] as ImageVerdict
      if (!verdict.keep) continue
      if (admitted < maxImages) {
        admitted++
        continue
      }
      verdict.keep = false
      verdict.reason = `over model ${modelId}'s ${maxImages}-image ceiling`
      verdict.note = overflowNote
    }
  }

  const kept = verdicts.filter((v) => v.keep).length
  return { verdicts, kept, dropped: verdicts.length - kept }
}

/**
 * Emit one warn line per drop. Rewriting a request body on the hot path with no
 * record is not acceptable: the note is addressed to the model, and the model
 * may or may not relay it, so the operator needs their own channel.
 */
export function logImagePlan(modelId: string, plan: VisionPlan): void {
  if (plan.dropped === 0) return
  const reasons = [...new Set(plan.verdicts.filter((v) => !v.keep).map((v) => v.reason))]
  consola.warn(
    `Dropped ${plan.dropped} of ${plan.verdicts.length} image(s) bound for ${modelId} `
      + `(${plan.kept} kept): ${reasons.join("; ")}`,
  )
}

// ---------------------------------------------------------------------------
// Payload traversal
//
// Each shape has ONE predicate, shared by its extractor and its pruner. The
// worst bug available here is the two walks disagreeing by a single part and
// dropping the wrong image, so they cannot be allowed to drift apart.
// ---------------------------------------------------------------------------

function responsesImageUrl(part: unknown): string | undefined {
  if (part === null || typeof part !== "object") return undefined
  const p = part as { type?: unknown; image_url?: unknown }
  if (p.type !== "input_image" || typeof p.image_url !== "string") return undefined
  return p.image_url
}

function chatImageUrl(part: unknown): string | undefined {
  if (part === null || typeof part !== "object") return undefined
  const p = part as { type?: unknown; image_url?: unknown }
  if (p.type !== "image_url") return undefined
  const url = (p.image_url as { url?: unknown } | undefined)?.url
  return typeof url === "string" ? url : undefined
}

/** Anthropic-native `{type:"image", source:{type:"base64", media_type, data}}`. */
function anthropicImage(part: unknown): OutboundImage | undefined {
  if (part === null || typeof part !== "object") return undefined
  const p = part as { type?: unknown; source?: unknown }
  if (p.type !== "image") return undefined
  const source = p.source as
    | { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown }
    | undefined
  if (!source) return undefined
  if (typeof source.url === "string" && typeof source.data !== "string") {
    return { url: source.url }
  }
  return {
    base64: typeof source.data === "string" ? source.data : undefined,
    declaredMimeType: typeof source.media_type === "string" ? source.media_type : undefined,
  }
}

function fromUrl(url: string): OutboundImage {
  const parsed = parseDataUrl(url)
  return parsed ? { base64: parsed.base64, declaredMimeType: parsed.mimeType } : { url }
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
      const url = responsesImageUrl(part)
      if (url !== undefined) images.push(fromUrl(url))
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
      const url = chatImageUrl(part)
      if (url !== undefined) images.push(fromUrl(url))
    }
  }
  return images
}

/**
 * Visit every Anthropic image part in order, descending into the nested
 * `content` a `tool_result` carries.
 *
 * The extractor and the pruner BOTH drive off this one walker, so their
 * traversal orders cannot drift apart — which is the failure that would drop
 * the wrong image.
 */
function walkAnthropicParts(part: unknown, visit: (image: OutboundImage) => void): void {
  const image = anthropicImage(part)
  if (image !== undefined) {
    visit(image)
    return
  }
  if (part === null || typeof part !== "object") return
  const nested = (part as { content?: unknown }).content
  if (!Array.isArray(nested)) return
  for (const inner of nested) walkAnthropicParts(inner, visit)
}

/** Collect the images on an Anthropic-native `/v1/messages` body. */
export function imagesInAnthropicMessages(messages: unknown): Array<OutboundImage> {
  const images: Array<OutboundImage> = []
  if (!Array.isArray(messages)) return images
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      walkAnthropicParts(part, (image) => images.push(image))
    }
  }
  return images
}

/**
 * Thrown when the pruner's walk does not visit exactly as many images as the
 * planner judged. Fail loudly: defaulting an unjudged image to "keep" would
 * turn a traversal-drift bug into a silently leaked image.
 */
class ImageIndexDriftError extends Error {}

function assertConsumed(imageIndex: number, verdicts: ReadonlyArray<ImageVerdict>): void {
  if (imageIndex !== verdicts.length) {
    throw new ImageIndexDriftError(
      `image traversal drift: pruner visited ${imageIndex} image(s), planner judged ${verdicts.length}`,
    )
  }
}

/**
 * Replace each dropped image with a text part IN PLACE, preserving position.
 * Untouched items and parts keep their original object identity, so nothing is
 * needlessly copied and the caller's payload is never mutated.
 */
export function pruneImagesFromResponsesInput(
  input: unknown,
  verdicts: ReadonlyArray<ImageVerdict>,
): unknown {
  if (!Array.isArray(input)) return input
  let imageIndex = 0
  const out = input.map((item) => {
    if (item === null || typeof item !== "object") return item
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) return item
    let replaced = false
    const parts = content.map((part) => {
      if (responsesImageUrl(part) === undefined) return part
      const verdict = verdicts[imageIndex++]
      if (!verdict || verdict.keep) return part
      replaced = true
      return { type: "input_text", text: verdict.note }
    })
    return replaced ? { ...(item as object), content: parts } : item
  })
  assertConsumed(imageIndex, verdicts)
  return out
}

export function pruneImagesFromChatMessages(
  messages: unknown,
  verdicts: ReadonlyArray<ImageVerdict>,
): unknown {
  if (!Array.isArray(messages)) return messages
  let imageIndex = 0
  const out = messages.map((message) => {
    if (message === null || typeof message !== "object") return message
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return message
    let replaced = false
    const parts = content.map((part) => {
      if (chatImageUrl(part) === undefined) return part
      const verdict = verdicts[imageIndex++]
      if (!verdict || verdict.keep) return part
      replaced = true
      return { type: "text", text: verdict.note }
    })
    return replaced ? { ...(message as object), content: parts } : message
  })
  assertConsumed(imageIndex, verdicts)
  return out
}

export function pruneImagesFromAnthropicMessages(
  messages: unknown,
  verdicts: ReadonlyArray<ImageVerdict>,
): unknown {
  if (!Array.isArray(messages)) return messages
  let imageIndex = 0
  const replacePart = (part: unknown): { part: unknown; replaced: boolean } => {
    if (anthropicImage(part) !== undefined) {
      const verdict = verdicts[imageIndex++]
      if (!verdict || verdict.keep) return { part, replaced: false }
      return { part: { type: "text", text: verdict.note }, replaced: true }
    }
    if (part !== null && typeof part === "object") {
      const nested = (part as { content?: unknown }).content
      if (Array.isArray(nested)) {
        let nestedReplaced = false
        const inner = nested.map((innerPart) => {
          const result = replacePart(innerPart)
          if (result.replaced) nestedReplaced = true
          return result.part
        })
        if (nestedReplaced) {
          return { part: { ...(part as object), content: inner }, replaced: true }
        }
      }
    }
    return { part, replaced: false }
  }

  const out = messages.map((message) => {
    if (message === null || typeof message !== "object") return message
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return message
    let replaced = false
    const parts = content.map((part) => {
      const result = replacePart(part)
      if (result.replaced) replaced = true
      return result.part
    })
    return replaced ? { ...(message as object), content: parts } : message
  })
  assertConsumed(imageIndex, verdicts)
  return out
}
