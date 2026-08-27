import { expect, spyOn, test } from "bun:test"

import { salvageOversizedPrompt } from "../src/lib/prompt-window-salvage"
import * as tokenizer from "../src/lib/tokenizer"
import type { Model } from "../src/services/copilot/get-models"

function modelWithPromptLimit(maxPromptTokens?: number): Model {
  return {
    id: "test-model",
    model_picker_enabled: true,
    name: "Test Model",
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    capabilities: {
      family: "test",
      limits:
        maxPromptTokens === undefined
          ? {}
          : { max_prompt_tokens: maxPromptTokens },
      object: "model",
      supports: { tool_calls: true },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function markerCount(body: string): number {
  const parsed = JSON.parse(body) as {
    messages: Array<{ content?: unknown }>
  }
  let count = 0
  for (const message of parsed.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (
        block
        && typeof block === "object"
        && "type" in block
        && block.type === "text"
        && "text" in block
        && typeof block.text === "string"
        && block.text.startsWith("[github-router: elided ~")
      ) {
        count += 1
      }
    }
  }
  return count
}

test("small body is byte-identical without tokenization", async () => {
  const body = JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  })
  const countSpy = spyOn(tokenizer, "getTextTokenCount")
  countSpy.mockClear()

  const result = await salvageOversizedPrompt(
    body,
    modelWithPromptLimit(100_000),
  )

  expect(result).toEqual({ body, salvaged: false })
  expect(countSpy).not.toHaveBeenCalled()
  countSpy.mockRestore()
})

test("oversized paired tool history is stubbed without breaking pairing", async () => {
  const useIds = ["toolu_first", "toolu_second"]
  const body = JSON.stringify({
    model: "test-model",
    max_tokens: 128,
    messages: [
      { role: "user", content: [{ type: "text", text: "Run both checks." }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: useIds[0], name: "read", input: { path: "a" } },
          { type: "tool_use", id: useIds[1], name: "read", input: { path: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: useIds[0],
            content: [
              { type: "text", text: "first output A ".repeat(1_500) },
              { type: "text", text: "first output B ".repeat(1_500) },
            ],
          },
          {
            type: "tool_result",
            tool_use_id: useIds[1],
            content: "second output ".repeat(3_000),
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "I have both results." }] },
      { role: "user", content: [{ type: "text", text: "Continue with the answer." }] },
    ],
  })
  const model = modelWithPromptLimit(2_400)
  const result = await salvageOversizedPrompt(body, model)

  expect(result.salvaged).toBe(true)
  expect(result.elidedTokens).toBeGreaterThan(0)
  const parsed = JSON.parse(result.body) as {
    messages: Array<{ role: string; content: unknown }>
  }
  expect(parsed.messages).toHaveLength(5)

  const actualUseIds: Array<string> = []
  const actualResultIds: Array<string> = []
  for (const message of parsed.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue
      if ("type" in block && block.type === "tool_use" && "id" in block) {
        actualUseIds.push(block.id as string)
      }
      if (
        "type" in block
        && block.type === "tool_result"
        && "tool_use_id" in block
      ) {
        actualResultIds.push(block.tool_use_id as string)
      }
    }
  }
  expect(actualUseIds).toEqual(useIds)
  expect(actualResultIds).toEqual(useIds)

  const budget = 2_400 - 2_000
  const finalTokens = await tokenizer.getTextTokenCount(
    result.body,
    tokenizer.getTokenizerFromModel(model),
  )
  expect(finalTokens).toBeLessThanOrEqual(budget)
})

test("signed thinking blocks are unchanged while older text is salvaged", async () => {
  const thinking = {
    type: "thinking",
    thinking: "private reasoning that must stay exact",
    signature: "signed-value-0123456789",
  }
  const redactedThinking = {
    type: "redacted_thinking",
    data: "opaque-signed-data-0123456789",
  }
  const body = JSON.stringify({
    model: "test-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "old context ".repeat(4_000) }] },
      {
        role: "assistant",
        content: [thinking, redactedThinking, { type: "text", text: "old reply ".repeat(4_000) }],
      },
      { role: "user", content: [{ type: "text", text: "current turn" }] },
    ],
  })

  const result = await salvageOversizedPrompt(
    body,
    modelWithPromptLimit(2_400),
  )

  expect(result.salvaged).toBe(true)
  const parsed = JSON.parse(result.body) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>
  }
  const blocks = parsed.messages[1]!.content
  expect(JSON.stringify(blocks[0])).toBe(JSON.stringify(thinking))
  expect(JSON.stringify(blocks[1])).toBe(JSON.stringify(redactedThinking))
})

test("marker is appended exactly once and salvage is idempotent", async () => {
  const body = JSON.stringify({
    model: "test-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "old context ".repeat(5_000) }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "current turn" }] },
    ],
  })
  const model = modelWithPromptLimit(2_400)

  const first = await salvageOversizedPrompt(body, model)
  const second = await salvageOversizedPrompt(first.body, model)

  expect(first.salvaged).toBe(true)
  expect(markerCount(first.body)).toBe(1)
  expect(second).toEqual({ body: first.body, salvaged: false })
  expect(markerCount(second.body)).toBe(1)
})

test("marker-like current user text and system content are never rewritten", async () => {
  const userText = markerTextForTest(7)
  const systemToolOutput = "system-owned output ".repeat(3_000)
  const body = JSON.stringify({
    model: "test-model",
    messages: [
      {
        role: "system",
        content: [
          { type: "tool_result", tool_use_id: "system-tool", content: systemToolOutput },
        ],
      },
      { role: "user", content: [{ type: "text", text: "old context ".repeat(5_000) }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: userText }] },
    ],
  })

  const result = await salvageOversizedPrompt(
    body,
    modelWithPromptLimit(2_400),
  )

  expect(result).toEqual({ body, salvaged: false })
  const parsed = JSON.parse(result.body) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>
  }
  expect(parsed.messages[0]!.content[0]!.content).toBe(systemToolOutput)
  expect(parsed.messages.at(-1)!.content[0]!.text).toBe(userText)
})

function markerTextForTest(tokens: number): string {
  return `[github-router: elided ~${tokens} tokens of older tool output to fit this model's prompt window]`
}

test("missing and zero prompt limits return the original body", async () => {
  const body = '{ "model": "test-model", "messages": [] }'

  expect(
    await salvageOversizedPrompt(body, modelWithPromptLimit()),
  ).toEqual({ body, salvaged: false })
  expect(
    await salvageOversizedPrompt(body, modelWithPromptLimit(0)),
  ).toEqual({ body, salvaged: false })
  expect(await salvageOversizedPrompt(body, undefined)).toEqual({
    body,
    salvaged: false,
  })
})

/**
 * Salvage runs on a body that is, by definition, near a model's prompt ceiling
 * — megabytes of text. Re-counting the WHOLE body after each replacement is
 * O(replacements) full tokenizer passes over that text, which would stall the
 * very request salvage exists to rescue. The running estimate from per-fragment
 * deltas is what keeps full passes rare, so this pins that they stay rare.
 */
test("does not re-tokenize the whole body once per replacement", async () => {
  const messages: Array<Record<string, unknown>> = []
  const filler = "x".repeat(4_000)
  for (let i = 0; i < 60; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${i}`, name: "read", input: {} }],
    })
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${i}`, content: `${filler} ${i}` },
      ],
    })
  }
  messages.push({ role: "user", content: [{ type: "text", text: "go on" }] })
  const body = JSON.stringify({ model: "test-model", messages })

  const countSpy = spyOn(tokenizer, "getTextTokenCount")
  countSpy.mockClear()

  // Budget sits well under the body so several replacements are required.
  const result = await salvageOversizedPrompt(body, modelWithPromptLimit(30_000))
  expect(result.salvaged).toBe(true)

  // A "full pass" is any count over a fragment-sized input. Fragment counts are
  // cheap and expected once per candidate; full passes are the expensive ones.
  const fullPasses = countSpy.mock.calls.filter(
    ([text]) => typeof text === "string" && text.length > filler.length * 4,
  ).length
  expect(fullPasses).toBeLessThanOrEqual(4)

  countSpy.mockRestore()
})
