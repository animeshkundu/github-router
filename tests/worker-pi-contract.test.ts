import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core"
import type { TSchema } from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import { __testExports as engineInternals } from "~/lib/worker-agent/engine"
import { createCopilotStreamFn } from "~/lib/worker-agent/stream-fn"
import { sseFinalText, sseResponse } from "./helpers/worker-sse"

const MODEL = "pi-runtime-contract-model"
const originalModels = state.models
const originalToken = state.copilotToken
const originalFetch = globalThis.fetch

function fakeModel(): unknown {
  return {
    id: MODEL,
    name: MODEL,
    vendor: "OpenAI",
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
  }
}

function result(text: string, terminate?: boolean) {
  return { content: [{ type: "text" as const, text }], details: {}, terminate }
}

function batch(calls: Array<{ name: string; args?: Record<string, unknown> }>): Response {
  return sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        },
        finish_reason: null,
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])
}

async function runAgent(
  tools: Array<AgentTool<TSchema, Record<string, never>>>,
  first: Response,
  hooks: Record<string, unknown> = {},
): Promise<{ agent: Agent; providerCalls: number }> {
  let providerCalls = 0
  globalThis.fetch = mock(async () => providerCalls++ === 0 ? first : sseFinalText("done")) as unknown as typeof fetch
  const agent = new Agent({
    initialState: {
      systemPrompt: "Pi runtime contract",
      model: engineInternals.makeModelShim(MODEL),
      thinkingLevel: "off",
      tools,
    },
    streamFn: createCopilotStreamFn({ resolved: { modelId: MODEL, thinking: "off" } }),
    toolExecution: "parallel",
    ...hooks,
  } as never)
  await agent.prompt("exercise the contract")
  await agent.waitForIdle()
  return { agent, providerCalls }
}

beforeEach(() => {
  state.models = { object: "list", data: [fakeModel()] } as typeof state.models
  state.copilotToken = "test-token"
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalToken
  globalThis.fetch = originalFetch
})

describe("engine to Pi constructor contract", () => {
  test("the engine call site passes the complete option bag", async () => {
    const source = await Bun.file(
      new URL("../src/lib/worker-agent/engine.ts", import.meta.url),
    ).text()
    const start = source.indexOf("const agent = new Agent({")
    const end = source.indexOf("// Publish the agent", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const callSite = source.slice(start, end)
    for (const key of [
      "initialState:",
      "systemPrompt:",
      "model:",
      "thinkingLevel:",
      "tools,",
      "streamFn:",
      'toolExecution: "parallel"',
      "transformContext:",
      "beforeToolCall:",
      "afterToolCall:",
      "prepareNextTurn:",
    ]) {
      expect(callSite, `Agent option disappeared or was renamed: ${key}`).toContain(key)
    }
  })
})

describe("vendored Pi runtime contracts", () => {
  test("executionMode sequential serializes the entire mixed batch at runtime", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const order: Array<string> = []
    const make = (name: string, sequential = false): AgentTool<TSchema, Record<string, never>> => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      ...(sequential ? { executionMode: "sequential" as const } : {}),
      execute: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        order.push(`${name}:start`)
        await Bun.sleep(20)
        order.push(`${name}:end`)
        inFlight -= 1
        return result(name)
      },
    })
    await runAgent(
      [make("read_a"), make("edit", true), make("read_b")],
      batch([{ name: "read_a" }, { name: "edit" }, { name: "read_b" }]),
    )
    expect(maxInFlight).toBe(1)
    expect(order).toEqual(["read_a:start", "read_a:end", "edit:start", "edit:end", "read_b:start", "read_b:end"])
  })

  test("terminate:true stops the loop without a second provider request", async () => {
    let executions = 0
    const terminal: AgentTool<TSchema, Record<string, never>> = {
      name: "submit_answer",
      label: "terminal",
      description: "terminal",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { executions += 1; return result("answer", true) },
    }
    const { providerCalls } = await runAgent([terminal], batch([{ name: "submit_answer" }]))
    expect(executions).toBe(1)
    expect(providerCalls).toBe(1)
  })

  test("beforeToolCall {block, reason} prevents execution and emits an error tool result", async () => {
    let executed = false
    const tool: AgentTool<TSchema, Record<string, never>> = {
      name: "blocked",
      label: "blocked",
      description: "blocked",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { executed = true; return result("wrong") },
    }
    const { agent } = await runAgent([tool], batch([{ name: "blocked" }]), {
      beforeToolCall: async () => ({ block: true, reason: "contract block reason" }),
    })
    expect(executed).toBe(false)
    const toolResult = agent.state.messages.find((message: AgentMessage) => message.role === "toolResult") as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
    expect(toolResult?.isError).toBe(true)
    expect(toolResult?.content?.[0]?.text).toContain("contract block reason")
  })

  test("afterToolCall replaces model-visible content", async () => {
    const tool: AgentTool<TSchema, Record<string, never>> = {
      name: "sized",
      label: "sized",
      description: "sized",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => result("original payload"),
    }
    const { agent } = await runAgent([tool], batch([{ name: "sized" }]), {
      afterToolCall: async () => ({ content: [{ type: "text", text: "accounted replacement" }] }),
    })
    const toolResult = agent.state.messages.find((message: AgentMessage) => message.role === "toolResult") as { content?: Array<{ text?: string }> } | undefined
    expect(toolResult?.content?.[0]?.text).toBe("accounted replacement")
  })
})
