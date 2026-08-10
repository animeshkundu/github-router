import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { detectImageMimeType, decodeBase64Strict } from "~/lib/attachments"
import { state } from "~/lib/state"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import {
  imagesInAnthropicMessages,
  imagesInChatPayload,
  imagesInResponsesPayload,
  learnedImageCeiling,
  parseDataUrl,
  parseUpstreamImageCeiling,
  planOutboundImages,
  pruneImagesFromAnthropicMessages,
  pruneImagesFromChatMessages,
  pruneImagesFromResponsesInput,
  resetLearnedImageCeilings,
} from "~/lib/vision-preflight"

/** 1x1 red PNG, colour type 2 — a genuinely valid payload, not a placeholder. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
/** Minimal but structurally valid JPEG SOI + APP0/JFIF header. */
const JPEG_HEAD = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]).toString("base64")

function visionModel(
  id: string,
  vision: boolean,
  limits?: {
    max_prompt_images?: number
    max_prompt_image_size?: number
    supported_media_types?: Array<string>
  },
): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      object: "model",
      tokenizer: "o200k",
      type: "chat",
      supports: vision ? { vision: true } : {},
      ...(limits ? { limits: { vision: limits } } : {}),
    },
  } as unknown as Model
}

let saved: ModelsResponse | undefined

beforeEach(() => {
  saved = state.models
  state.models = {
    object: "list",
    data: [
      visionModel("one-image", true, {
        max_prompt_images: 1,
        max_prompt_image_size: 3 * 1024 * 1024,
        supported_media_types: ["image/png", "image/jpeg"],
      }),
      visionModel("ten-image", true, {
        max_prompt_images: 10,
        max_prompt_image_size: 3 * 1024 * 1024,
        supported_media_types: ["image/png", "image/webp"],
      }),
      visionModel("tiny-limit", true, { max_prompt_images: 5, max_prompt_image_size: 8 }),
      visionModel("no-limits", true),
      visionModel("text-only", false),
    ],
  } as ModelsResponse
})

afterEach(() => {
  state.models = saved
})

describe("magic-byte identification", () => {
  test("recognises a real PNG and rejects a lookalike header", () => {
    const png = decodeBase64Strict(PNG_1X1)
    expect(png).not.toBeNull()
    expect(detectImageMimeType(png!)).toBe("image/png")

    // PNG signature with no valid IHDR chunk behind it: not a usable image.
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(detectImageMimeType(fake)).toBeUndefined()
  })

  test("recognises JPEG and returns undefined for text", () => {
    expect(detectImageMimeType(decodeBase64Strict(JPEG_HEAD)!)).toBe("image/jpeg")
    expect(detectImageMimeType(new TextEncoder().encode("SECRET=hunter2\n"))).toBeUndefined()
  })

  test("truncated input never throws", () => {
    expect(detectImageMimeType(new Uint8Array([0xff]))).toBeUndefined()
    expect(detectImageMimeType(new Uint8Array([]))).toBeUndefined()
  })
})

describe("base64 decoding", () => {
  test("rejects payloads Buffer.from would silently salvage", () => {
    // Buffer.from skips out-of-alphabet characters and truncates, so a lenient
    // decode under-reports size — exactly the check the size limit depends on.
    expect(decodeBase64Strict("!!!!not base64!!!!")).toBeNull()
    expect(decodeBase64Strict("TQ===")).toBeNull() // impossible padding
    expect(decodeBase64Strict("A")).toBeNull() // remainder 1: no byte sequence yields it
    expect(decodeBase64Strict("")).toBeNull()
    expect(decodeBase64Strict(PNG_1X1)).not.toBeNull()
  })

  test("accepts valid unpadded and line-wrapped input", () => {
    // RFC 4648 permits omitting `=`, and JSON payloads routinely carry wrapped
    // base64. An earlier version required exact padding and an unbroken string,
    // which rejected perfectly good images with a confident "not valid base64".
    expect(decodeBase64Strict("abc")).not.toBeNull() // 3 chars → 2 bytes, unpadded
    expect(decodeBase64Strict("TQ")).not.toBeNull()
    const wrapped = PNG_1X1.replace(/(.{20})/g, (m) => m + String.fromCharCode(10))
    expect(decodeBase64Strict(wrapped)).not.toBeNull()
  })

  test("decoded LENGTH is what the size limit sees, so a lenient decode would understate it", () => {
    const bytes = decodeBase64Strict(PNG_1X1)
    expect(bytes).not.toBeNull()
    expect(bytes!.length).toBe(Buffer.from(PNG_1X1, "base64").length)
  })
})

describe("planOutboundImages", () => {
  const png = { base64: PNG_1X1, declaredMimeType: "image/png" }
  const keeps = (images: Array<{ base64?: string; declaredMimeType?: string; url?: string }>,
    model: string, maxImages?: number) =>
    planOutboundImages(model, images, maxImages === undefined ? undefined : { maxImages })
      .verdicts.map((v) => v.keep)

  test("no images is always fine", () => {
    expect(planOutboundImages("text-only", []).dropped).toBe(0)
  })

  test("keeps everything on an unknown model — no basis to judge, upstream decides", () => {
    expect(keeps([png, png, png], "not-in-catalog")).toEqual([true, true, true])
  })

  test("IGNORES the catalog's max_prompt_images — it was measured wrong for 20 of 23 models", () => {
    // `one-image` publishes max_prompt_images: 1. Upstream serves gpt-5.x at 50
    // and claude-opus-5 at 128+, so this field must not gate anything locally.
    const many = Array.from({ length: 32 }, () => png)
    expect(planOutboundImages("one-image", many).dropped).toBe(0)
  })

  test("drops every image for a model that does not advertise vision, naming it", () => {
    const plan = planOutboundImages("text-only", [png])
    expect(plan.kept).toBe(0)
    expect(plan.verdicts[0]?.note).toContain("text-only")
    expect(plan.verdicts[0]?.note).toMatch(/does not accept image input/i)
  })

  describe("cardinality budget (only ever a ceiling upstream stated)", () => {
    test("keeps the LAST N — the newest image is what the current turn is about", () => {
      expect(keeps([png, png, png], "ten-image", 1)).toEqual([false, false, true])
      expect(keeps([png, png, png], "ten-image", 2)).toEqual([false, true, true])
    })

    test("a ceiling of 0 drops everything rather than sailing past an equality test", () => {
      expect(keeps([png, png], "ten-image", 0)).toEqual([false, false])
    })

    test("a malformed ceiling admits nothing instead of admitting everything", () => {
      expect(keeps([png, png], "ten-image", Number.NaN)).toEqual([false, false])
    })

    test("an invalid image does not consume a slot and evict a good one", () => {
      // Under the old count-before-validity ordering this whole request 400'd.
      const bad = { base64: "!!!!", declaredMimeType: "image/png" }
      expect(keeps([bad, png], "ten-image", 1)).toEqual([false, true])
    })

    test("the budget pass never rewrites a validity drop as a cardinality eviction", () => {
      const bad = { base64: "!!!!", declaredMimeType: "image/png" }
      const plan = planOutboundImages("ten-image", [bad, png, png], { maxImages: 1 })
      expect(plan.verdicts[0]?.reason).toMatch(/base64/i)
      expect(plan.verdicts[1]?.reason).toMatch(/ceiling/i)
    })

    test("counts remote-URL images but does not claim to size them", () => {
      const remote = { url: "https://example.test/a.png" }
      expect(keeps([remote, remote], "one-image", 1)).toEqual([false, true])
      const plan = planOutboundImages("one-image", [remote], { maxImages: 1 })
      expect(plan.dropped).toBe(0)
    })
  })

  describe("per-image defects drop one image, never the request", () => {
    test("decoded size, and the note says how to fix it", () => {
      const plan = planOutboundImages("tiny-limit", [png])
      expect(plan.kept).toBe(0)
      expect(plan.verdicts[0]?.note).toMatch(/smaller scale or lower quality/i)
    })

    test("a missing media type is not defaulted", () => {
      expect(planOutboundImages("one-image", [{ base64: PNG_1X1 }]).kept).toBe(0)
    })

    test("a declared/actual media-type disagreement", () => {
      const plan = planOutboundImages("one-image", [
        { base64: PNG_1X1, declaredMimeType: "image/jpeg" },
      ])
      expect(plan.verdicts[0]?.note).toContain("image/jpeg")
      expect(plan.verdicts[0]?.note).toContain("image/png")
    })

    test("a type the model does not list, naming what it does accept", () => {
      const plan = planOutboundImages("ten-image", [
        { base64: JPEG_HEAD, declaredMimeType: "image/jpeg" },
      ])
      expect(plan.verdicts[0]?.note).toContain("image/png, image/webp")
    })

    test("malformed base64", () => {
      expect(
        planOutboundImages("one-image", [{ base64: "!!!!", declaredMimeType: "image/png" }]).kept,
      ).toBe(0)
    })

    test("a size limit the model did not publish is described as assumed", () => {
      const big = { base64: "A".repeat(8 * 1024 * 1024), declaredMimeType: "image/png" }
      const plan = planOutboundImages("no-limits", [big])
      expect(plan.kept).toBe(0)
      expect(plan.verdicts[0]?.reason).toMatch(/assumed/i)
    })
  })

  test("note bytes are stable as a session accumulates images", () => {
    // Claude Code replays the whole transcript every turn. A note carrying an
    // ordinal or a running total would be rewritten on every new image and
    // invalidate the prompt-cache prefix from the earliest omission onward.
    const two = planOutboundImages("ten-image", [png, png], { maxImages: 1 })
    const five = planOutboundImages("ten-image", [png, png, png, png, png], { maxImages: 1 })
    expect(two.verdicts[0]?.note).toBe(five.verdicts[0]?.note as string)
    expect(two.verdicts[0]?.note).not.toMatch(/\bof\s+\d+/)
  })
})

describe("parseUpstreamImageCeiling", () => {
  test("reads the number out of both shapes Copilot actually emits", () => {
    expect(
      parseUpstreamImageCeiling(
        '{"error":{"message":"too many images: maximum allowed for model gemini-3.6-flash is 10, got 16"}}',
      ),
    ).toBe(10)
    expect(
      parseUpstreamImageCeiling(
        '{"error":{"message":"Exceeded maximum number of images (50) allowed in the request."}}',
      ),
    ).toBe(50)
  })

  test("returns undefined for anything else, so upstream's error is forwarded untouched", () => {
    expect(parseUpstreamImageCeiling('{"error":{"message":"prompt is too long"}}')).toBeUndefined()
    expect(parseUpstreamImageCeiling("")).toBeUndefined()
    // Mentions a maximum, but not about images — must not be mistaken for one.
    expect(
      parseUpstreamImageCeiling('{"error":{"message":"maximum allowed for model x is 4 tools"}}'),
    ).toBeUndefined()
  })
})

describe("payload extraction", () => {
  test("parseDataUrl splits a data URI and ignores a remote one", () => {
    expect(parseDataUrl(`data:image/png;base64,${PNG_1X1}`)).toEqual({
      mimeType: "image/png",
      base64: PNG_1X1,
    })
    expect(parseDataUrl("https://example.test/a.png")).toBeNull()
  })

  test("finds images across every message of a /responses payload", () => {
    const found = imagesInResponsesPayload([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` }] },
      { type: "function_call_output", call_id: "c1", output: "done" },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` }] },
    ])
    expect(found).toHaveLength(2)
    expect(found[0]?.declaredMimeType).toBe("image/png")
  })

  test("finds images across every message of a /chat/completions payload", () => {
    const found = imagesInChatPayload([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
        ],
      },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.base64).toBe(PNG_1X1)
  })

  test("counts a tool-result follow-up image the same as a top-level one", () => {
    // The shim re-emits tool_result images as a synthetic follow-up user
    // message. Because validation runs on the assembled payload, that image is
    // indistinguishable from any other — which is the whole point of putting
    // the check at the transport boundary rather than in each adapter.
    const found = imagesInChatPayload([
      { role: "tool", tool_call_id: "t1", content: "[image result below]" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } }],
      },
    ])
    expect(found).toHaveLength(1)
  })
})

describe("payload pruning", () => {
  const dataUrl = `data:image/png;base64,${PNG_1X1}`
  const drop = { keep: false, note: "[gone]" }
  const keep = { keep: true }

  test("/responses replaces in place, so an image-only turn does not become empty", () => {
    const input = [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }]
    const out = pruneImagesFromResponsesInput(input, [drop]) as Array<{
      content: Array<{ type: string; text?: string }>
    }>
    expect(out[0]?.content).toHaveLength(1)
    expect(out[0]?.content[0]).toEqual({ type: "input_text", text: "[gone]" })
  })

  test("/chat replaces in place and leaves sibling text parts alone", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look:" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ]
    const out = pruneImagesFromChatMessages(messages, [drop]) as Array<{
      role: string
      content: Array<{ type: string; text?: string }>
    }>
    expect(out[0]?.role).toBe("user")
    expect(out[0]?.content).toEqual([
      { type: "text", text: "look:" },
      { type: "text", text: "[gone]" },
    ])
  })

  test("index alignment holds across messages", () => {
    // Three distinct URLs so a traversal-order regression cannot hide behind
    // identical payloads: verdicts [drop, keep, drop] must hit exactly 1 and 3.
    const url = (n: number) => `data:image/png;base64,${PNG_1X1}#${n}`
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: url(1) } },
          { type: "image_url", image_url: { url: url(2) } },
        ],
      },
      { role: "user", content: [{ type: "image_url", image_url: { url: url(3) } }] },
    ]
    const serialized = JSON.stringify(pruneImagesFromChatMessages(messages, [drop, keep, drop]))
    expect(serialized).not.toContain("#1")
    expect(serialized).toContain("#2")
    expect(serialized).not.toContain("#3")
  })

  test("an Anthropic image nested in a tool_result is found and replaced", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "here" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
            ],
          },
        ],
      },
    ]
    expect(imagesInAnthropicMessages(messages)).toHaveLength(1)
    const out = pruneImagesFromAnthropicMessages(messages, [drop]) as Array<{
      content: Array<{ content: Array<{ type: string; text?: string }> }>
    }>
    expect(out[0]?.content[0]?.content).toEqual([
      { type: "text", text: "here" },
      { type: "text", text: "[gone]" },
    ])
  })

  test("content the pruner does not touch is returned unchanged", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "tool", tool_call_id: "t1", content: "[image result below]" },
    ]
    expect(pruneImagesFromChatMessages(messages, [])).toEqual(messages)
    expect(pruneImagesFromResponsesInput("a string", [])).toBe("a string")
  })

  test("traversal drift fails loudly rather than leaking an unjudged image", () => {
    // A fail-safe "missing verdict means keep" would turn this into a silently
    // over-sized request — the exact failure the pruning exists to prevent.
    const input = [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }]
    expect(() => pruneImagesFromResponsesInput(input, [drop, drop])).toThrow(/drift/i)
  })

  test("pruned output is a fixpoint: re-planning it drops nothing more", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: dataUrl },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ]
    const plan = planOutboundImages("ten-image", imagesInResponsesPayload(input), { maxImages: 1 })
    const pruned = pruneImagesFromResponsesInput(input, plan.verdicts)
    const remaining = imagesInResponsesPayload(pruned)
    expect(remaining).toHaveLength(1)
    expect(planOutboundImages("ten-image", remaining, { maxImages: 1 }).dropped).toBe(0)
  })
})

describe("native /v1/messages transport", () => {
  // This path takes a pre-serialized body STRING and re-parses it to prune, so
  // it fails in ways the object-taking transports cannot. It is also the path
  // Claude Code's own model runs on.
  const messagesCalls = (mockFn: { mock: { calls: Array<Array<unknown>> } }): Array<Array<unknown>> =>
    mockFn.mock.calls.filter((args) => String(args[0]).includes("/v1/messages"))
  const bodyOf = (call: Array<unknown>): string =>
    String((call[1] as { body?: unknown } | undefined)?.body ?? "")
  const imageBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
  }
  const ceilingRejection = (n: number) =>
    new Response(
      `{"error":{"message":"too many images: maximum allowed for model one-image is ${n}, got 6"}}`,
      { status: 400 },
    )

  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    resetLearnedImageCeilings()
    state.copilotToken = "test-token"
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetLearnedImageCeilings()
  })

  const bodyWith = (images: number, model = "one-image", pretty = false) => {
    const payload = {
      model,
      max_tokens: 16,
      messages: [
        { role: "user", content: Array.from({ length: images }, () => imageBlock) },
      ],
    }
    return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
  }

  test("recovers from an upstream ceiling rejection and retries once", async () => {
    let call = 0
    const fetchMock = mock(() => {
      call++
      return Promise.resolve(call === 1 ? ceilingRejection(2) : new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await createMessages(bodyWith(6))

    const calls = messagesCalls(fetchMock)
    expect(calls).toHaveLength(2)
    expect(bodyOf(calls[1] as Array<unknown>).split('"type":"image"').length - 1).toBe(2)
  })

  test("recovery is NOT gated on a string probe — a pretty-printed body still recovers", async () => {
    // The probe that gates the PROACTIVE path looks for `"type":"image"`. A
    // client that pretty-prints emits `"type": "image"`. If recovery were gated
    // on that probe, this request would die with the 400 it used to die with.
    let call = 0
    const fetchMock = mock(() => {
      call++
      return Promise.resolve(call === 1 ? ceilingRejection(1) : new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await createMessages(bodyWith(3, "one-image", true))
    expect(messagesCalls(fetchMock)).toHaveLength(2)
  })

  test("the learned ceiling prunes the next request without a round trip", async () => {
    let call = 0
    const fetchMock = mock(() => {
      call++
      return Promise.resolve(call === 1 ? ceilingRejection(2) : new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")

    await createMessages(bodyWith(6))
    expect(messagesCalls(fetchMock)).toHaveLength(2)

    // Pretty-printed so this also proves the proactive probe is whitespace-tolerant.
    await createMessages(bodyWith(6, "one-image", true))
    const calls = messagesCalls(fetchMock)
    expect(calls).toHaveLength(3)
    expect(bodyOf(calls[2] as Array<unknown>).split('"type":"image"').length - 1).toBe(2)
  })

  test("the ceiling is attributed to the request's own model, not a quoted one", async () => {
    // A replayed transcript can easily contain `"model":"..."` inside message
    // text or a tool schema BEFORE the request's own field. Keying off the
    // first match in the raw body would learn the ceiling under the wrong id,
    // and the proactive lookup would then never hit.
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: 'earlier turn said {"model":"decoy-model"} here' },
            imageBlock,
            imageBlock,
            imageBlock,
          ],
        },
      ],
      model: "one-image",
      max_tokens: 16,
    })
    let call = 0
    const fetchMock = mock(() => {
      call++
      return Promise.resolve(call === 1 ? ceilingRejection(1) : new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await createMessages(body)

    expect(learnedImageCeiling("one-image")).toBe(1)
    expect(learnedImageCeiling("decoy-model")).toBeUndefined()
  })

  test("an image nested in a tool_result is pruned like any other", async () => {
    const body = JSON.stringify({
      model: "one-image",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [imageBlock, imageBlock] },
            imageBlock,
          ],
        },
      ],
    })
    let call = 0
    const fetchMock = mock(() => {
      call++
      return Promise.resolve(call === 1 ? ceilingRejection(1) : new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await createMessages(body)

    const retry = bodyOf(messagesCalls(fetchMock)[1] as Array<unknown>)
    expect(retry.split('"type":"image"').length - 1).toBe(1)
    expect(retry).toContain("at most 1 image per request")
  })

  test("an unparseable image 400 is forwarded untouched, with no retry", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('{"error":{"message":"image exploded"}}', { status: 400 })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await expect(createMessages(bodyWith(3))).rejects.toThrow()
    expect(messagesCalls(fetchMock)).toHaveLength(1)
  })

  test("a stated ceiling of 0 is refused — it would be a permanent trapdoor", async () => {
    // Learning 0 would drop every image for this model for the rest of the
    // process, and because nothing is then sent, upstream could never reject
    // for images again and the entry could never be re-learned.
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          '{"error":{"message":"Exceeded maximum number of images (0) allowed in the request."}}',
          { status: 400 },
        ),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await expect(createMessages(bodyWith(3))).rejects.toThrow()
    expect(messagesCalls(fetchMock)).toHaveLength(1)
    expect(learnedImageCeiling("one-image")).toBeUndefined()
  })

  test("a non-image 400 never triggers a parse or a retry", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response('{"error":{"message":"prompt is too long: 1000003 tokens"}}', { status: 400 }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createMessages } = await import("~/services/copilot/create-messages")
    await expect(createMessages(bodyWith(2))).rejects.toThrow()
    expect(messagesCalls(fetchMock)).toHaveLength(1)
  })
})

describe("transport behaviour", () => {
  /**
   * Counts calls to the Copilot API specifically. Importing the service
   * transitively triggers an unrelated background VS Code version lookup, so
   * asserting on total fetch count would pass or fail for reasons having
   * nothing to do with images.
   */
  function upstreamCalls(mockFn: { mock: { calls: Array<Array<unknown>> } }): Array<Array<unknown>> {
    return mockFn.mock.calls.filter((args) => {
      const url = String(args[0])
      return url.includes("/chat/completions") || url.includes("/responses")
    })
  }
  const bodyOf = (call: Array<unknown>): string =>
    String((call[1] as { body?: unknown } | undefined)?.body ?? "")
  const headersOf = (call: Array<unknown>): Record<string, string> =>
    ((call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {})

  const imagePart = { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    resetLearnedImageCeilings()
    state.copilotToken = "test-token"
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetLearnedImageCeilings()
  })

  test("32 images on a catalog-says-1 model go out in ONE call, all of them", async () => {
    // The reported bug: this used to be a terminal 400 at 2. Upstream serves
    // gpt-5.x at 50, so the proxy must not stand in the way.
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    await createResponses({
      model: "one-image",
      input: [{ role: "user", content: Array.from({ length: 32 }, () => imagePart) }],
    } as never)
    const calls = upstreamCalls(fetchMock)
    expect(calls).toHaveLength(1)
    expect(bodyOf(calls[0] as Array<unknown>).split("input_image").length - 1).toBe(32)
  })

  test("an upstream ceiling rejection is recovered: prune to the stated number, retry once", async () => {
    let call = 0
    const fetchMock = mock(() => {
      call++
      if (call === 1) {
        return Promise.resolve(
          new Response(
            '{"error":{"code":"invalid_request_body","message":"too many images: maximum allowed for model one-image is 3, got 5"}}',
            { status: 400 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    await createResponses({
      model: "one-image",
      input: [{ role: "user", content: Array.from({ length: 5 }, () => imagePart) }],
    } as never)

    const calls = upstreamCalls(fetchMock)
    expect(calls).toHaveLength(2)
    expect(bodyOf(calls[0] as Array<unknown>).split("input_image").length - 1).toBe(5)
    const retry = bodyOf(calls[1] as Array<unknown>)
    expect(retry.split("input_image").length - 1).toBe(3)
    expect(retry).toContain("at most 3 images per request")
  })

  test("the learned ceiling prunes the NEXT request without paying a round trip", async () => {
    let call = 0
    const fetchMock = mock(() => {
      call++
      if (call === 1) {
        return Promise.resolve(
          new Response(
            '{"error":{"message":"Exceeded maximum number of images (2) allowed in the request."}}',
            { status: 400 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 200 }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    const send = () =>
      createResponses({
        model: "one-image",
        input: [{ role: "user", content: Array.from({ length: 4 }, () => imagePart) }],
      } as never)

    await send()
    const afterFirst = upstreamCalls(fetchMock).length
    await send()
    const calls = upstreamCalls(fetchMock)
    expect(afterFirst).toBe(2) // rejected, then the pruned retry
    expect(calls).toHaveLength(3) // the second request needs only one call
    expect(bodyOf(calls[2] as Array<unknown>).split("input_image").length - 1).toBe(2)
  })

  test("a second rejection is forwarded, never looped", async () => {
    const rejection = () =>
      Promise.resolve(
        new Response(
          '{"error":{"message":"too many images: maximum allowed for model one-image is 1, got 3"}}',
          { status: 400 },
        ),
      )
    const fetchMock = mock(rejection)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    await expect(
      createResponses({
        model: "one-image",
        input: [{ role: "user", content: Array.from({ length: 3 }, () => imagePart) }],
      } as never),
    ).rejects.toThrow()
    expect(upstreamCalls(fetchMock)).toHaveLength(2)
  })

  test("an image 400 we cannot parse is forwarded untouched, with no retry", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response('{"error":{"message":"image something went wrong"}}', { status: 400 }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    await expect(
      createResponses({
        model: "one-image",
        input: [{ role: "user", content: [imagePart, imagePart] }],
      } as never),
    ).rejects.toThrow()
    expect(upstreamCalls(fetchMock)).toHaveLength(1)
  })

  test("a non-vision model gets a note instead of an error, and NO vision header", async () => {
    // Sending copilot-vision-request while carrying no images would trade one
    // 400 for another.
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createChatCompletions } = await import("~/services/copilot/create-chat-completions")
    await createChatCompletions({
      model: "text-only",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } }],
        },
      ],
    } as never)
    const calls = upstreamCalls(fetchMock)
    expect(calls).toHaveLength(1)
    const body = bodyOf(calls[0] as Array<unknown>)
    expect(body).not.toContain("image_url")
    expect(body).toMatch(/does not accept image input/)
    expect(headersOf(calls[0] as Array<unknown>)["copilot-vision-request"]).toBeUndefined()
  })

  test("a compliant request is forwarded byte-identical — no gratuitous rewriting", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { createResponses } = await import("~/services/copilot/create-responses")
    const payload = {
      model: "one-image",
      input: [{ role: "user", content: [imagePart] }],
    }
    await createResponses(payload as never)
    expect(bodyOf(upstreamCalls(fetchMock)[0] as Array<unknown>)).toBe(JSON.stringify(payload))
  })
})
