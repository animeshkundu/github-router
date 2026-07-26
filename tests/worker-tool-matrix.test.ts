import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core"
import type { TSchema } from "@earendil-works/pi-ai"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { buildBrowseTools } from "~/lib/worker-agent/browse-tools"
import { __testExports as engineInternals } from "~/lib/worker-agent/engine"
import { createCopilotStreamFn } from "~/lib/worker-agent/stream-fn"
import {
  buildWorkerTools,
  createPlanState,
  __testExports as toolInternals,
} from "~/lib/worker-agent/tools"
import { sseFinalText, sseToolCall } from "./helpers/worker-sse"

const MODEL = "worker-tool-matrix-model"
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalVsCodeVersion = state.vsCodeVersion
const originalFetch = globalThis.fetch
const scratch: Array<string> = []

function fakeModel(id: string): unknown {
  return {
    id,
    name: id,
    vendor: "OpenAI",
    version: id,
    preview: true,
    model_picker_enabled: true,
    object: "model",
    capabilities: {
      type: "chat",
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: {},
      supports: { tool_calls: true, reasoning_effort: ["low", "high"] },
    },
    supported_endpoints: ["/v1/chat/completions"],
  }
}

function tempWorkspace(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "worker-matrix-")))
  scratch.push(dir)
  writeFileSync(path.join(dir, "seed.txt"), "worker matrix needle\n")
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

interface ToolCase {
  name: string
  args: Record<string, unknown>
  assertSideEffect?: (workspace: string) => Promise<void>
}

const TOOL_CASES: Array<ToolCase> = [
  { name: "read", args: { path: "seed.txt" } },
  { name: "glob", args: { pattern: "*.txt" } },
  { name: "grep", args: { query: "matrix", mode: "literal" } },
  { name: "code_search", args: { query: "needle", mode: "lexical", summary: false } },
  { name: "web_search", args: { query: "worker smoke" } },
  { name: "fetch_url", args: { url: "https://example.test/smoke" } },
  { name: "toolbelt", args: { tool: "git", args: ["status", "--short"] } },
  { name: "advisor", args: { concern: "smoke the advisor path" } },
  {
    name: "update_plan",
    args: { steps: [{ title: "smoke", status: "in_progress" }] },
  },
  {
    name: "edit",
    args: { path: "seed.txt", old_string: "needle", new_string: "edited" },
    assertSideEffect: async (workspace) => {
      await expect(Bun.file(path.join(workspace, "seed.txt")).text()).resolves.toContain("edited")
    },
  },
  {
    name: "write",
    args: { path: "written.txt", contents: "written by matrix\n" },
    assertSideEffect: async (workspace) => {
      await expect(Bun.file(path.join(workspace, "written.txt")).exists()).resolves.toBe(true)
    },
  },
  { name: "bash", args: { cmd: "git --version" } },
  { name: "codex_review", args: { prompt: "review this smoke fixture" } },
]

function responseApiText(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_smoke",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function mcpResponse(id: number, result: unknown): Response {
  return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

async function executeThroughPi(
  tool: AgentTool<TSchema, Record<string, never>>,
  args: Record<string, unknown>,
): Promise<{ requests: Array<Record<string, unknown>>; messages: Array<AgentMessage> }> {
  let providerCalls = 0
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { /* non-JSON */ }
    }
    if (Array.isArray(body.messages)) {
      requests.push(body)
      return providerCalls++ === 0
        ? sseToolCall(tool.name, args)
        : sseFinalText("done")
    }
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "smoke-session" },
      })
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (body.method === "tools/call") {
      return mcpResponse(Number(body.id), {
        content: [{
          type: "text",
          text: JSON.stringify({
            type: "output_text",
            text: { value: "web smoke", annotations: [] },
            bing_searches: [],
          }),
        }],
      })
    }
    const url = String(_url)
    if (url.includes("example.test")) return new Response("fetched smoke body", { status: 200 })
    if (url.includes("/responses")) return responseApiText("nested model smoke result")
    throw new Error(`unexpected smoke fetch: ${url} ${JSON.stringify(body)}`)
  }) as unknown as typeof fetch

  const agent = new Agent({
    initialState: {
      systemPrompt: "Execute the requested smoke tool.",
      model: engineInternals.makeModelShim(MODEL),
      thinkingLevel: "off",
      tools: [tool],
    },
    streamFn: createCopilotStreamFn({ resolved: { modelId: MODEL, thinking: "off" } }),
    toolExecution: "parallel",
  })
  await agent.prompt("run the tool")
  await agent.waitForIdle()
  return { requests, messages: agent.state.messages }
}

beforeEach(() => {
  state.models = {
    object: "list",
    data: [fakeModel(MODEL), fakeModel("gpt-5.6-sol"), fakeModel("gpt-5.3-codex")],
  } as typeof state.models
  state.copilotToken = "test-token"
  state.githubToken = "ghu_test"
  state.vsCodeVersion = "1.0.0"
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.vsCodeVersion = originalVsCodeVersion
  globalThis.fetch = originalFetch
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe("worker tool smoke matrix", () => {
  test("codex_review resolves the underscore toolNameHttp persona", async () => {
    globalThis.fetch = mock(async () => responseApiText("review smoke result")) as unknown as typeof fetch
    const tool = toolInternals.codexReviewTool()
    const result = await tool.execute(
      "call_regression",
      { prompt: "review the fixture" },
      new AbortController().signal,
    )
    expect((result.content[0] as { text: string }).text).toContain(
      "review smoke result",
    )
  })

  for (const tc of TOOL_CASES) {
    test(`${tc.name} executes through the real Pi loop and returns a tool result`, async () => {
      const workspace = tempWorkspace()
      const tools = buildWorkerTools({
        mode: "implement",
        workspace,
        getMessages: () => [],
        planState: createPlanState(),
      })
      const tool = tools.find((candidate) => candidate.name === tc.name)
      expect(tool, `${tc.name} disappeared from implement toolset`).toBeDefined()
      const { requests, messages } = await executeThroughPi(tool!, tc.args)
      expect(requests.length).toBe(2)
      const result = messages.find(
        (message) => message.role === "toolResult" && message.toolName === tc.name,
      ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined
      expect(result, `${tc.name} never produced a Pi toolResult`).toBeDefined()
      expect(result?.isError, `${tc.name} toolResult was an error`).toBe(false)
      expect(result?.content?.some((part) => part.type === "text" && typeof part.text === "string")).toBe(true)
      await tc.assertSideEffect?.(workspace)
    }, 30_000)
  }

  test("all filesystem modes expose exactly their promised surface and never peer_review", () => {
    const workspace = tempWorkspace()
    const readOnly = TOOL_CASES.slice(0, 9).map((entry) => entry.name).sort()
    const writable = TOOL_CASES.map((entry) => entry.name).sort()
    for (const mode of ["explore", "review", "plan"] as const) {
      const names = buildWorkerTools({ mode, workspace }).map((tool) => tool.name).sort()
      expect(names).toEqual(readOnly)
      expect(names).not.toContain("peer_review")
    }
    for (const mode of ["implement", "test"] as const) {
      const names = buildWorkerTools({ mode, workspace }).map((tool) => tool.name).sort()
      expect(names).toEqual(writable)
      expect(names).not.toContain("peer_review")
    }
  })
})

const BROWSE_ARGS: Record<string, Record<string, unknown>> = {
  navigate: { tabId: 1, action: "reload" },
  open_tab: { url: "https://example.test" },
  close_tab: { tabIds: [1] },
  read_page: { tabId: 1 },
  screenshot: { tabId: 1 },
  scroll: { tabId: 1, direction: "down" },
  wait: { tabId: 1, timeoutMs: 1 },
  eval_js: { tabId: 1, expression: "1 + 1" },
  click: { tabId: 1, selector: "button" },
  fill: { tabId: 1, selector: "input", value: "smoke" },
  locate: { tabId: 1, selector: "main" },
  find: { tabId: 1, intent: "main content" },
  submit_answer: { status: "complete", answer: "smoke", evidence: "fixture" },
  report_insufficient: { reason: "fixture intentionally has no value" },
}

describe("browse tool smoke matrix", () => {
  for (const [name, args] of Object.entries(BROWSE_ARGS)) {
    test(`${name} executes its real tool implementation`, async () => {
      const dispatched: Array<{ name: string; args: Record<string, unknown> }> = []
      const tools = buildBrowseTools({
        dispatch: async (wireName, wireArgs) => {
          dispatched.push({ name: wireName, args: wireArgs })
          return { content: [{ type: "text", text: `executed ${wireName}` }] }
        },
      })
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, `${name} disappeared from browse toolset`).toBeDefined()
      const result = await tool!.execute("call_smoke", args, new AbortController().signal)
      expect(result.content.length).toBeGreaterThan(0)
      expect((result.content[0] as { type: string }).type).toBe("text")
      if (name === "submit_answer" || name === "report_insufficient") {
        expect(result.terminate).toBe(true)
        expect(dispatched).toHaveLength(0)
      } else {
        expect(dispatched).toEqual([{ name: `browser_${name}`, args }])
      }
    })
  }
})
