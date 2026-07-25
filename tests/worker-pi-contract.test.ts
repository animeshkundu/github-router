import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core"
import type { TSchema } from "@earendil-works/pi-ai"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { __testExports as engineInternals, runWorkerAgent } from "~/lib/worker-agent/engine"
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
  engineInternals.setAgentOptionsObserver()
})

describe("engine to Pi constructor contract", () => {
  test("the runtime Agent receives the complete option bag", async () => {
    const workspace = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pi-options-")))
    let captured: Record<string, unknown> | undefined
    engineInternals.setAgentOptionsObserver((options) => {
      captured = options as unknown as Record<string, unknown>
    })
    globalThis.fetch = mock(async () => sseFinalText("done")) as unknown as typeof fetch
    try {
      const result = await runWorkerAgent({
        prompt: "capture options",
        mode: "explore",
        model: MODEL,
        workspace,
      })
      expect(result.isError).not.toBe(true)
      expect(captured).toBeDefined()
      expect(
        Object.keys(captured ?? {}).sort(),
        "Engine AgentOptions changed; update the wiring decision table in docs/pi-vendor-sync.md before accepting or rejecting the surface change",
      ).toEqual([
        "afterToolCall",
        "beforeToolCall",
        "initialState",
        "prepareNextTurn",
        "shouldStopAfterTurn",
        "streamFn",
        "toolExecution",
        "transformContext",
      ])
      expect(captured?.toolExecution).toBe("parallel")
      expect(captured?.initialState).toMatchObject({
        systemPrompt: expect.any(String),
        model: expect.any(Object),
        thinkingLevel: expect.any(String),
        tools: expect.any(Array),
      })
      for (const key of [
        "streamFn",
        "transformContext",
        "beforeToolCall",
        "afterToolCall",
        "prepareNextTurn",
      ]) {
        expect(typeof captured?.[key], `Agent option missing or wrong type: ${key}`).toBe("function")
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
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

  test("shouldStopAfterTurn reaches the Agent loop and prevents another provider request", async () => {
    let hookCalls = 0
    const tool: AgentTool<TSchema, Record<string, never>> = {
      name: "bounded",
      label: "bounded",
      description: "bounded",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => result("bounded result"),
    }
    const { providerCalls } = await runAgent([tool], batch([{ name: "bounded" }]), {
      shouldStopAfterTurn: () => {
        hookCalls += 1
        return true
      },
    })
    expect(
      hookCalls,
      "Vendored Agent did not receive shouldStopAfterTurn; restore the local patch documented in docs/pi-vendor-sync.md",
    ).toBe(1)
    expect(
      providerCalls,
      "shouldStopAfterTurn was not applied by the Agent loop; see the wiring decision table in docs/pi-vendor-sync.md",
    ).toBe(1)
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
