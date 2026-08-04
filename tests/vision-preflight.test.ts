import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { detectImageMimeType, decodeBase64Strict } from "~/lib/attachments"
import { state } from "~/lib/state"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import {
  checkOutboundImages,
  imagesInChatPayload,
  imagesInResponsesPayload,
  parseDataUrl,
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

describe("checkOutboundImages", () => {
  const png = { base64: PNG_1X1, declaredMimeType: "image/png" }

  test("no images is always fine", () => {
    expect(checkOutboundImages("text-only", []).ok).toBe(true)
  })

  test("allows an unknown model — we have no basis to judge, upstream decides", () => {
    expect(checkOutboundImages("not-in-catalog", [png]).ok).toBe(true)
  })

  test("rejects a model that does not advertise vision, naming it", () => {
    const verdict = checkOutboundImages("text-only", [png])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("text-only")
    expect(verdict.message).toMatch(/does not support image input/i)
  })

  test("accepts a single image on a 1-image model", () => {
    expect(checkOutboundImages("one-image", [png]).ok).toBe(true)
  })

  test("rejects over-count, naming both numbers", () => {
    const verdict = checkOutboundImages("one-image", [png, png])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("1")
    expect(verdict.message).toContain("2")
    expect(verdict.message).toContain("one-image")
  })

  test("counts to the model's real ceiling, not a hardcoded one", () => {
    expect(checkOutboundImages("ten-image", Array.from({ length: 10 }, () => png)).ok).toBe(true)
    expect(checkOutboundImages("ten-image", Array.from({ length: 11 }, () => png)).ok).toBe(false)
  })

  test("rejects on DECODED size, and says so", () => {
    const verdict = checkOutboundImages("tiny-limit", [png])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toMatch(/bytes/)
    expect(verdict.message).toMatch(/smaller scale or lower quality/i)
  })

  test("rejects a missing media type instead of defaulting one", () => {
    const verdict = checkOutboundImages("one-image", [{ base64: PNG_1X1 }])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toMatch(/no media type/i)
  })

  test("catches a declared/actual media-type disagreement", () => {
    const verdict = checkOutboundImages("one-image", [
      { base64: PNG_1X1, declaredMimeType: "image/jpeg" },
    ])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("image/jpeg")
    expect(verdict.message).toContain("image/png")
  })

  test("rejects a type the model does not list, and names what it does accept", () => {
    const verdict = checkOutboundImages("ten-image", [
      { base64: JPEG_HEAD, declaredMimeType: "image/jpeg" },
    ])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("image/png, image/webp")
  })

  test("rejects malformed base64", () => {
    const verdict = checkOutboundImages("one-image", [
      { base64: "!!!!", declaredMimeType: "image/png" },
    ])
    expect(verdict.ok).toBe(false)
  })

  describe("missing limit metadata", () => {
    test("applies a conservative floor rather than treating unknown as unlimited", () => {
      expect(checkOutboundImages("no-limits", [png]).ok).toBe(true)
      const verdict = checkOutboundImages("no-limits", [png, png])
      expect(verdict.ok).toBe(false)
      if (verdict.ok) throw new Error("unreachable")
      // The caller must be able to tell an assumed limit from a published one.
      expect(verdict.message).toMatch(/assumed/i)
    })
  })

  test("counts remote-URL images but does not claim to size them", () => {
    const remote = { url: "https://example.test/a.png" }
    expect(checkOutboundImages("one-image", [remote]).ok).toBe(true)
    expect(checkOutboundImages("one-image", [remote, remote]).ok).toBe(false)
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

describe("no upstream request is made when the preflight rejects", () => {
  /**
   * Asserts the property that matters: the preflight must reject BEFORE any
   * call to the Copilot API. Note this checks the endpoint rather than "fetch
   * was never called at all" — importing the service transitively triggers an
   * unrelated background VS Code version lookup, and asserting on total call
   * count would make this test pass or fail for reasons having nothing to do
   * with the preflight.
   */
  function upstreamCalls(mockFn: { mock: { calls: Array<Array<unknown>> } }): Array<string> {
    return mockFn.mock.calls
      .map((args) => String(args[0]))
      .filter((url) => url.includes("/chat/completions") || url.includes("/responses"))
  }

  test("createChatCompletions throws before calling Copilot", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotToken = "test-token"
    try {
      const { createChatCompletions } = await import("~/services/copilot/create-chat-completions")
      await expect(
        createChatCompletions({
          model: "text-only",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
              ],
            },
          ],
        } as never),
      ).rejects.toThrow(/does not support image input/i)
      expect(upstreamCalls(fetchMock)).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("createResponses throws before calling Copilot", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotToken = "test-token"
    try {
      const { createResponses } = await import("~/services/copilot/create-responses")
      await expect(
        createResponses({
          model: "one-image",
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
                { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
              ],
            },
          ],
        } as never),
      ).rejects.toThrow(/at most 1 image/i)
      expect(upstreamCalls(fetchMock)).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
