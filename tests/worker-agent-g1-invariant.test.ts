/**
 * G1 invariant guard (loud-failure on a Pi bump).
 *
 * The whole compaction design rests on `agent-loop.ts:283-289`: the
 * `transformContext` return is a SEND-TIME view bound to a local and passed
 * only to `convertToLlm` — it is NEVER written back into `_state.messages`, so
 * the full transcript survives across turns. If a future Pi bump made the loop
 * persist the hook's return, structural compaction would become silently
 * DESTRUCTIVE (stubs compounding until only a skeleton remains). This test
 * fails loudly if that happens.
 *
 * Method: drive a real bare `Agent` for 2 turns (turn 1 fires a tool call →
 * turn 2 produces text) with a `transformContext` that returns `[]`. If the
 * loop persisted that, the original user message would be gone from turn 2's
 * input. We assert it survives.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { Agent } from "@earendil-works/pi-agent-core"

import { state } from "~/lib/state"
import { __testExports as engineInternals } from "~/lib/worker-agent/engine"
import { createCopilotStreamFn } from "~/lib/worker-agent/stream-fn"

const MODEL = "g1-chat-model"
const originalModels = state.models
const originalToken = state.copilotToken
const originalFetch = globalThis.fetch

function sse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
function sseToolCall(name: string): Response {
  return sse(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`
    + "data: [DONE]\n\n",
  )
}
function sseText(text: string): Response {
  return sse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    + "data: [DONE]\n\n",
  )
}

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      {
        id: MODEL,
        name: MODEL,
        vendor: "Anthropic",
        version: MODEL,
        preview: true,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          type: "chat",
          family: MODEL,
          object: "model_capabilities",
          tokenizer: "o200k_base",
          limits: {},
          supports: { tool_calls: true },
        },
        supported_endpoints: ["/v1/chat/completions"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
  }
  state.copilotToken = "test-token"
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalToken
  globalThis.fetch = originalFetch
})

test("transformContext output is a send-time view, NOT persisted to the transcript", async () => {
  let call = 0
  globalThis.fetch = mock(() =>
    Promise.resolve(call++ === 0 ? sseToolCall("noop") : sseText("done")),
  ) as unknown as typeof fetch

  const noopTool = {
    name: "noop",
    description: "no-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }

  // Capture a SNAPSHOT (not the live reference) of every transformContext
  // input, then DELIBERATELY return [] (shrink to nothing). G1 says this must
  // not affect the persisted transcript.
  const seen: Array<{ len: number; hasUser: boolean }> = []
  const agent = new Agent({
    initialState: {
      systemPrompt: "test",
      model: engineInternals.makeModelShim(MODEL),
      thinkingLevel: "off",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [noopTool] as any,
    },
    streamFn: createCopilotStreamFn({ resolved: { modelId: MODEL, thinking: "off" } }),
    transformContext: async (msgs) => {
      const arr = msgs as Array<{ role?: string }>
      seen.push({ len: arr.length, hasUser: arr.some((m) => m.role === "user") })
      return []
    },
  })

  await agent.prompt("go")
  await agent.waitForIdle()

  // Two provider requests ⇒ transformContext ran twice.
  expect(seen.length).toBeGreaterThanOrEqual(2)
  // Turn 1 saw the user prompt...
  expect(seen[0]!.hasUser).toBe(true)
  // ...and turn 2 STILL sees it (the [] return was not persisted) plus the
  // turn-1 assistant + tool result the loop appended.
  expect(seen[1]!.hasUser).toBe(true)
  expect(seen[1]!.len).toBeGreaterThan(seen[0]!.len)
})
