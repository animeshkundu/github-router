import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { Context, Model as PiModel } from "@earendil-works/pi-ai"

import { firstText } from "~/lib/attachments"
import { loadPeerImages } from "~/lib/peer-attachments"
import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import { createCopilotStreamFn, type ResolvedModel } from "~/lib/worker-agent/stream-fn"
import { buildWorkerTools } from "~/lib/worker-agent/tools"

/** 1x1 red PNG, colour type 2. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_BYTES = Buffer.from(PNG_B64, "base64")
/** A DIFFERENT valid 1x1 PNG (blue). Distinct bytes matter: with two copies of
 *  the same image, dropping one, duplicating one, or reversing the order are
 *  all indistinguishable. */
const PNG_B64_B =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "gh-router-img-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Peer attachments — the second file-reading path must not weaken the first
// ---------------------------------------------------------------------------

describe("loadPeerImages", () => {
  test("loads a real image and base64-encodes it", async () => {
    const file = path.join(dir, "shot.png")
    writeFileSync(file, PNG_BYTES)
    const res = await loadPeerImages([file], dir)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("unreachable")
    expect(res.images).toHaveLength(1)
    expect(res.images[0]?.mimeType).toBe("image/png")
    expect(res.images[0]?.data).toBe(PNG_B64)
  })

  test("refuses a non-image even when the extension claims otherwise", async () => {
    // The load-bearing exfiltration guard: identification is by content, so a
    // secrets file renamed to .png cannot be shipped to a third-party model.
    const file = path.join(dir, "secrets.png")
    writeFileSync(file, "AWS_SECRET_ACCESS_KEY=hunter2\n")
    const res = await loadPeerImages([file], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/not a supported image/i)
    expect(res.error).toMatch(/bytes, not its extension/i)
  })

  test("applies the sensitive-file denylist", async () => {
    const file = path.join(dir, ".env")
    writeFileSync(file, "TOKEN=abc\n")
    const res = await loadPeerImages([file], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/sensitive/i)
  })

  test("confines to the workspace — an outside path is rejected", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "gh-router-out-"))
    try {
      const file = path.join(outside, "shot.png")
      writeFileSync(file, PNG_BYTES)
      const res = await loadPeerImages([file], dir)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("unreachable")
      // The confinement helper keeps its messages path-free on purpose.
      expect(res.error).not.toContain(outside)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("rejects oversize before encoding, naming the ceiling", async () => {
    const file = path.join(dir, "big.png")
    // Valid PNG header followed by padding past the 3 MiB ceiling.
    writeFileSync(file, Buffer.concat([PNG_BYTES, Buffer.alloc(3 * 1024 * 1024 + 1)]))
    const res = await loadPeerImages([file], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/exceeds the 3145728-byte limit/)
  })

  test("fails the whole call on one bad path rather than silently dropping it", async () => {
    const good = path.join(dir, "a.png")
    const bad = path.join(dir, "b.png")
    writeFileSync(good, PNG_BYTES)
    writeFileSync(bad, "not an image")
    const res = await loadPeerImages([good, bad], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("imagePaths[1]")
  })

  test("a missing file is reported, not thrown", async () => {
    const res = await loadPeerImages([path.join(dir, "nope.png")], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/not found or unreadable/i)
  })
})

describe("attachment caps and base64 tolerance (review regressions)", () => {
  test("the path count is capped at the most permissive model ceiling", async () => {
    const file = path.join(dir, "a.png")
    writeFileSync(file, PNG_BYTES)
    const res = await loadPeerImages(Array.from({ length: 11 }, () => file), dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/exceeds the 10-image ceiling/)
  })

  test("the aggregate byte total is capped, not just each file", async () => {
    // Each file is individually legal; together they are not. Without the
    // aggregate cap a caller could hold ~10 x 3 MiB in memory at once, plus a
    // third again for base64.
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2.5 * 1024 * 1024)])
    const files: Array<string> = []
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `big${i}.png`)
      writeFileSync(f, big)
      files.push(f)
    }
    const res = await loadPeerImages(files, dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/total more than/i)
  })

  test("a directory is refused with a structured error, not a throw", async () => {
    // `readFile` used to sit outside the try/catch, so anything that failed
    // after the size check threw straight out and broke the result contract.
    // A directory reaches `open()` and fails there, exercising that path.
    const sub = path.join(dir, "adir")
    mkdirSync(sub)
    const res = await loadPeerImages([sub], dir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/not a regular file|not found or unreadable/i)
  })

  test("a file larger than one read chunk is returned COMPLETE", async () => {
    // The read used to take a single `handle.read()` result as the whole file.
    // Node makes no completeness guarantee, so a short read produced a
    // TRUNCATED image that the header detector still accepted — the corruption
    // would only surface as an opaque upstream error. This asserts the full
    // payload survives, byte for byte.
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(1_500_000, 0x7a)])
    const file = path.join(dir, "big-but-legal.png")
    writeFileSync(file, big)
    const res = await loadPeerImages([file], dir)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("unreachable")
    expect(res.images[0]?.data).toBe(big.toString("base64"))
    expect(Buffer.from(res.images[0]!.data, "base64").length).toBe(big.length)
  })

  test.if(process.platform !== "win32")(
    "a symlink as the final component is refused",
    async () => {
      // O_NOFOLLOW closes the window between the confinement helper's
      // canonicalization and the open() for the common case: the final
      // component being swapped for a link to somewhere else.
      const outside = mkdtempSync(path.join(os.tmpdir(), "gh-router-target-"))
      const target = path.join(outside, "real.png")
      writeFileSync(target, PNG_BYTES)
      const link = path.join(dir, "link.png")
      try {
        symlinkSync(target, link)
      } catch {
        return // no symlink privilege in this environment
      }
      try {
        const res = await loadPeerImages([link], dir)
        expect(res.ok).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    },
  )

  test("base64 with line wrapping and without padding still decodes", async () => {
    const { decodeBase64Strict } = await import("~/lib/attachments")
    // JSON payloads routinely carry wrapped base64, and RFC 4648 permits
    // omitting `=`. Rejecting either produced a false "not valid base64" on the
    // check that decides whether an image may be sent at all.
    const wrapped = PNG_B64.replace(/(.{20})/g, (m) => m + String.fromCharCode(10))
    expect(decodeBase64Strict(wrapped)).not.toBeNull()
    expect(decodeBase64Strict("TQ")).not.toBeNull() // unpadded, valid
    expect(decodeBase64Strict("TQ==")).not.toBeNull()
    // Still rejects genuine garbage and impossible lengths.
    expect(decodeBase64Strict("!!!!")).toBeNull()
    expect(decodeBase64Strict("TQ===")).toBeNull()
    expect(decodeBase64Strict("A")).toBeNull()
  })

  test.if(process.platform === "win32")(
    "an NTFS alternate data stream is rejected",
    async () => {
      // `notes.png:secret` reads as an innocuous .png to every name-based rule,
      // but the stream inside it is arbitrary content.
      const res = await loadPeerImages([path.join(dir, "notes.png:secret")], dir)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("unreachable")
      expect(res.error).toMatch(/alternate data stream/i)
    },
  )
})

// ---------------------------------------------------------------------------
// Worker `read` — image-aware, and honest about other binaries
// ---------------------------------------------------------------------------

describe("worker read tool", () => {
  function readTool() {
    const tools = buildWorkerTools({ mode: "implement", workspace: dir } as never)
    const t = tools.find((x) => x.name === "read")
    if (!t) throw new Error("read tool not built")
    return t
  }

  test("returns a PNG as an image block, not mojibake", async () => {
    const file = path.join(dir, "shot.png")
    writeFileSync(file, PNG_BYTES)
    const res = await readTool().execute("id", { path: file } as never)
    const blocks = res.content as Array<{ type: string; data?: string; mimeType?: string }>
    const image = blocks.find((b) => b.type === "image")
    expect(image).toBeDefined()
    expect(image?.mimeType).toBe("image/png")
    expect(image?.data).toBe(PNG_B64)
    // Text block first, so a consumer reading content[0].text still works.
    expect(blocks[0]?.type).toBe("text")
  })

  test("refuses a non-image binary with an actionable message", async () => {
    const file = path.join(dir, "blob.bin")
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
    await expect(readTool().execute("id", { path: file } as never)).rejects.toThrow(
      /binary file.*not a supported image/is,
    )
  })

  test("ordinary text is untouched", async () => {
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "export const x = 1\n")
    const res = await readTool().execute("id", { path: file } as never)
    expect(firstText(res as never)).toContain("export const x = 1")
  })
})

// ---------------------------------------------------------------------------
// Worker tool results carry images to the model
// ---------------------------------------------------------------------------

function model(id: string, endpoint: string): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true, vision: true },
      limits: {
        vision: {
          max_prompt_images: 10,
          max_prompt_image_size: 3145728,
          supported_media_types: ["image/png", "image/jpeg", "image/webp"],
        },
      },
    },
    supported_endpoints: [endpoint],
  } as unknown as Model
}

describe("tool-result images reach the model", () => {
  const CHAT = "gemini-3.6-flash"
  const RESP = "gpt-5.4-mini"
  const originalFetch = globalThis.fetch
  const originalModels = state.models

  function ctxWithImageToolResult(): Context {
    return {
      messages: [
        { role: "user", content: "look at this", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
          timestamp: 0,
        },
      ],
    } as unknown as Context
  }

  async function capture(modelId: string, endpoint: string): Promise<Record<string, unknown>> {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.0.0"
    state.models = { object: "list", data: [model(modelId, endpoint)] } as never
    const terminal =
      endpoint === "/responses"
        ? `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`
        : "data: [DONE]\n\n"
    const fetchMock = mock(
      () => new Response(terminal, { headers: { "content-type": "text/event-stream" } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const resolved: ResolvedModel = { modelId, thinking: "high" }
    const stream = await createCopilotStreamFn({ resolved })(
      { id: modelId } as unknown as PiModel<"openai-completions">,
      ctxWithImageToolResult(),
      undefined,
    )
    for await (const ev of stream) {
      if (ev.type === "error") break
    }
    // `mock()` with a zero-arg factory types its calls as `[]`, so index into
    // the recorded args through `unknown` rather than the tuple type.
    const calls = fetchMock.mock.calls as unknown as Array<Array<unknown>>
    const init = calls.at(-1)?.[1] as { body?: string } | undefined
    return JSON.parse(init?.body ?? "{}") as Record<string, unknown>
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.models = originalModels
  })

  test("chat: tool output stays text, image rides a follow-up user message", async () => {
    const body = await capture(CHAT, "/chat/completions")
    const messages = body.messages as Array<Record<string, unknown>>
    const toolMsg = messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    // A tool message cannot carry an image, so it points at what follows.
    expect(toolMsg?.content).toBe("[image result below]")

    const follow = messages.at(-1) as { role?: string; content?: Array<Record<string, unknown>> }
    expect(follow?.role).toBe("user")
    const img = follow?.content?.find((c) => c.type === "image_url")
    expect(img).toBeDefined()
    expect((img?.image_url as { url?: string })?.url).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  test("responses: same fan-out into input_image", async () => {
    const body = await capture(RESP, "/responses")
    const input = body.input as Array<Record<string, unknown>>
    const output = input.find((i) => i.type === "function_call_output")
    expect(output?.output).toBe("[image result below]")

    const follow = input.at(-1) as { role?: string; content?: Array<Record<string, unknown>> }
    expect(follow?.role).toBe("user")
    const img = follow?.content?.find((c) => c.type === "input_image")
    expect(img?.image_url).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  test("the follow-up is built per request, so it is not persisted into worker state", async () => {
    // Two assemblies from the SAME context must produce the same number of
    // messages. If the follow-up were appended to state instead of synthesized
    // at assembly time, the image would accumulate and be re-sent every turn.
    const a = await capture(CHAT, "/chat/completions")
    const b = await capture(CHAT, "/chat/completions")
    expect((a.messages as Array<unknown>).length).toBe((b.messages as Array<unknown>).length)
  })
})

// ---------------------------------------------------------------------------
// The bridge dispatcher's image decision
// ---------------------------------------------------------------------------

describe("imageEnvelope", () => {
  test("turns a screenshot envelope into text + image, dropping the duplicated payload", async () => {
    const { imageEnvelope } = await import("~/lib/browser-mcp/dispatch")
    const env = imageEnvelope({ contentType: "image/png", dataBase64: PNG_B64, tabId: 7 })
    expect(env).not.toBeNull()
    const blocks = env!.content
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[1]?.type).toBe("image")

    const meta = JSON.parse(firstText(env!)) as Record<string, unknown>
    // Metadata survives, the payload does not ride twice, and the decoded size
    // is reported so a caller can reason about cost.
    expect(meta.tabId).toBe(7)
    expect(meta.bytes).toBe(PNG_BYTES.length)
    expect(meta.mimeType).toBe("image/png")
    expect(JSON.stringify(meta)).not.toContain(PNG_B64)
  })

  test("identifies by bytes, not by the declared contentType", async () => {
    const { imageEnvelope } = await import("~/lib/browser-mcp/dispatch")
    // A PNG mislabelled as jpeg is still sent as the png it actually is.
    const env = imageEnvelope({ contentType: "image/jpeg", dataBase64: PNG_B64 })
    const image = env!.content.find((b) => b.type === "image") as { mimeType?: string }
    expect(image?.mimeType).toBe("image/png")
  })

  test("returns null for anything that is not a decodable supported image", async () => {
    const { imageEnvelope } = await import("~/lib/browser-mcp/dispatch")
    expect(imageEnvelope({ ok: true })).toBeNull()
    expect(imageEnvelope("plain string")).toBeNull()
    expect(imageEnvelope({ dataBase64: "!!!!" })).toBeNull()
    // Valid base64, but the bytes are text — must not become an image block.
    expect(imageEnvelope({ dataBase64: Buffer.from("hello").toString("base64") })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Regressions found by adversarial review
// ---------------------------------------------------------------------------

describe("parallel tool calls keep their tool messages contiguous", () => {
  const CHAT = "gemini-3.6-flash"
  const RESP = "gpt-5.4-mini"
  const originalFetch = globalThis.fetch
  const originalModels = state.models
  let lastBody: Record<string, unknown> | undefined

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.models = originalModels
  })

  function parallelCtx(): Context {
    return {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "a", name: "shotA", arguments: {} },
            { type: "toolCall", id: "b", name: "shotB", arguments: {} },
          ],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "a",
          content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "b",
          content: [{ type: "image", data: PNG_B64_B, mimeType: "image/png" }],
          timestamp: 0,
        },
      ],
    } as unknown as Context
  }

  async function roles(modelId: string, endpoint: string): Promise<Array<string>> {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.0.0"
    state.models = { object: "list", data: [model(modelId, endpoint)] } as never
    const terminal =
      endpoint === "/responses"
        ? `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`
        : "data: [DONE]\n\n"
    const fetchMock = mock(
      () => new Response(terminal, { headers: { "content-type": "text/event-stream" } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const stream = await createCopilotStreamFn({
      resolved: { modelId, thinking: "high" } as ResolvedModel,
    })({ id: modelId } as unknown as PiModel<"openai-completions">, parallelCtx(), undefined)
    for await (const ev of stream) {
      if (ev.type === "error") break
    }
    const calls = fetchMock.mock.calls as unknown as Array<Array<unknown>>
    const body = JSON.parse(
      ((calls.at(-1)?.[1] as { body?: string })?.body) ?? "{}",
    ) as Record<string, unknown>
    const items = (body.messages ?? body.input) as Array<Record<string, unknown>>
    lastBody = body
    return items.map((m) => String(m.role ?? m.type))
  }

  /** Every image data URL / payload on the last captured request, in order. */
  function capturedImages(): Array<string> {
    const body = lastBody ?? {}
    const items = ((body.messages ?? body.input) ?? []) as Array<Record<string, unknown>>
    const out: Array<string> = []
    for (const item of items) {
      const content = item.content
      if (!Array.isArray(content)) continue
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "image_url") {
          out.push(String((part.image_url as { url?: string }).url))
        } else if (part.type === "input_image") {
          out.push(String(part.image_url))
        }
      }
    }
    return out
  }

  test("chat: tool messages are adjacent and the images flush once, after them", async () => {
    // Per-message fan-out produced `tool, user, tool, user` — a user message
    // between two tool messages orphans the second one and providers reject the
    // request. Images from the whole run must flush after the last tool message.
    const seq = await roles(CHAT, "/chat/completions")
    expect(seq).toEqual(["user", "assistant", "tool", "tool", "user"])
    // Both images must survive, in the order their tool results appeared —
    // role ordering alone would still pass if one were dropped or duplicated.
    expect(capturedImages()).toEqual([
      `data:image/png;base64,${PNG_B64}`,
      `data:image/png;base64,${PNG_B64_B}`,
    ])
  })

  test("responses: same grouping for function_call_output items", async () => {
    const seq = await roles(RESP, "/responses")
    expect(seq.filter((r) => r === "function_call_output")).toHaveLength(2)
    // The synthetic image message is last, not wedged between the outputs.
    expect(seq.at(-1)).toBe("user")
    const firstOutput = seq.indexOf("function_call_output")
    const lastOutput = seq.lastIndexOf("function_call_output")
    expect(lastOutput - firstOutput).toBe(1)
    expect(capturedImages()).toEqual([
      `data:image/png;base64,${PNG_B64}`,
      `data:image/png;base64,${PNG_B64_B}`,
    ])
  })
})
