import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { resetCapiHostCacheForTest, parseSessionLog } from "~/lib/agent/capi"
import { getTask } from "~/lib/agent/tasks"
import type { RepoRef } from "~/lib/agent/types"
import { state } from "~/lib/state"

const originalFetch = globalThis.fetch
const repo: RepoRef = { owner: "octo", repo: "hello" }
const CAPI_HOST = "https://api.enterprise.githubcopilot.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return { object: "chat.completion.chunk", choices: [{ delta, finish_reason: finishReason }] }
}

beforeEach(() => {
  state.githubAgentToken = "gho_test-token"
  resetCapiHostCacheForTest()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  resetCapiHostCacheForTest()
  globalThis.fetch = originalFetch
})

test("parseSessionLog extracts the report_progress plan, reasoning, tools, and finished flag", () => {
  const result = parseSessionLog(
    [
      `data: ${JSON.stringify(chunk({ reasoning_text: "Considering the deps." }))}`,
      `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { name: "run_setup" } }] }))}`,
      `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 1, function: { name: "report_progress", arguments: '{"prDescription":' } }] }))}`,
      `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 1, function: { arguments: '"Upgrade Flask to 3.x"}' } }] }))}`,
      `data: ${JSON.stringify(chunk({ content: "Opened PR." }, "stop"))}`,
      "data: [DONE]",
    ].join("\n\n"),
  )

  expect(result.finished).toBe(true)
  expect(result.tools).toEqual(["run_setup", "report_progress"])
  expect(result.excerpt).toContain("Plan:\nUpgrade Flask to 3.x")
  expect(result.excerpt).toContain("Considering the deps.")
  expect(result.excerpt).toContain("Opened PR.")
})

test("parseSessionLog tolerates an in-flight stream with incomplete tool args", () => {
  const result = parseSessionLog(
    `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { name: "report_progress", arguments: '{"prDescription":"partial' } }] }))}`,
  )
  expect(result.finished).toBe(false)
  expect(result.tools).toEqual(["report_progress"])
  // The incomplete JSON is not parseable, so no plan section is emitted.
  expect(result.excerpt).not.toContain("Plan:")
})

test("parseSessionLog hard-truncates a huge log", () => {
  const big = "x".repeat(9000)
  const result = parseSessionLog(`data: ${JSON.stringify(chunk({ content: big }))}`)
  expect(result.excerpt.length).toBeLessThanOrEqual(4000)
  // Progress is tail-kept, so the truncation marker leads the progress section.
  expect(result.excerpt).toContain("…[truncated]…")
})

test("parseSessionLog surfaces a tail <plan> block over the leading MCP boilerplate", () => {
  // Reproduces the live bug: the agent emits a large MCP-registration preamble
  // first, then the actual plan (wrapped in <plan>…</plan>) at the very end.
  // Head-truncation used to keep only the boilerplate and drop the plan.
  const boilerplate =
    "Cloned repo and checked out branch\nMCP server started successfully with 36 tools\n" +
    Array.from({ length: 40 }, (_, i) => `- github-mcp-server/tool_${i}`).join("\n")
  const planText = "### Steps\n1. Replace setup.py with pyproject.toml\n2. Drop six\n3. Add CI"
  const content = `${boilerplate}\n\n<plan>\n${planText}\n</plan>`
  const result = parseSessionLog(`data: ${JSON.stringify(chunk({ content }, "stop"))}`)

  expect(result.excerpt).toContain("Plan:")
  expect(result.excerpt).toContain("Replace setup.py with pyproject.toml")
  expect(result.excerpt).toContain("Drop six")
  // The tool-registration boilerplate is stripped out of the excerpt.
  expect(result.excerpt).not.toContain("github-mcp-server/tool_0")
  expect(result.excerpt).not.toContain("MCP server started successfully")
})

test("parseSessionLog joins multi-line SSE data events (spec-compliant)", () => {
  // A pretty-printed JSON payload spans several physical lines; per SSE, each
  // is its own `data:` line and they rejoin with `\n` into valid JSON.
  const pretty = JSON.stringify(chunk({ content: "hello world" }, "stop"), null, 2)
  const body = pretty.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n"
  const result = parseSessionLog(body)
  expect(result.finished).toBe(true)
  expect(result.excerpt).toContain("hello world")
})

test("getTask never sends the token to a non-allowlisted discovered host", async () => {
  const calls: string[] = []
  const fetchMock = mock((url: string) => {
    calls.push(url)
    if (url.endsWith("/graphql")) {
      // A tampered discovery reply pointing at an attacker host.
      return jsonResponse({ data: { viewer: { copilotEndpoints: { api: "https://evil.example.com" } } } })
    }
    if (url.endsWith("/tasks/task-3")) {
      return jsonResponse({ id: "task-3", state: "completed", sessions: [{ id: "s1" }], plan: "gh text" })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const task = await getTask(repo, "task-3")

  // Falls back to the api.github.com task text; the evil host is never hit.
  expect(task.logExcerpt).toContain("gh text")
  expect(calls.some((u) => u.includes("evil.example.com"))).toBe(false)
})

test("getTask discovers the CAPI host and folds the session log into logExcerpt", async () => {
  const calls: string[] = []
  const fetchMock = mock((url: string, init?: RequestInit) => {
    calls.push(url)
    if (url.endsWith("/graphql")) {
      return jsonResponse({ data: { viewer: { copilotEndpoints: { api: CAPI_HOST } } } })
    }
    if (url.includes("/agents/repos/") && url.endsWith("/tasks/task-9")) {
      return jsonResponse({
        id: "task-9",
        state: "in_progress",
        sessions: [{ id: "sess-old" }, { id: "sess-live" }],
        session_log: "stale api.github.com text",
      })
    }
    if (url.includes(`/agents/sessions/sess-live/logs`)) {
      // Assert the CAPI auth + integration headers are present.
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer gho_test-token")
      expect(headers.get("copilot-integration-id")).toBe("copilot-4-cli")
      return sse([chunk({ content: "Cloned the repo and drafted a plan." }, "stop")])
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const task = await getTask(repo, "task-9")

  expect(task.sessionId).toBe("sess-live")
  expect(task.logExcerpt).toContain("Cloned the repo and drafted a plan.")
  expect(task.logExcerpt).not.toContain("stale api.github.com text")
  // Uses the LAST session id, and hit both discovery + the logs endpoint.
  expect(calls.some((u) => u.includes("/agents/sessions/sess-live/logs"))).toBe(true)
})

test("getTask falls back to the api.github.com task text when the CAPI log fails", async () => {
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/graphql")) {
      return jsonResponse({ data: { viewer: { copilotEndpoints: { api: CAPI_HOST } } } })
    }
    if (url.endsWith("/tasks/task-7")) {
      return jsonResponse({
        id: "task-7",
        state: "completed",
        sessions: [{ id: "sess-x" }],
        plan: "fallback plan text",
      })
    }
    if (url.includes("/agents/sessions/")) return new Response("nope", { status: 500 })
    throw new Error(`unexpected fetch: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const task = await getTask(repo, "task-7")
  expect(task.sessionId).toBe("sess-x")
  expect(task.logExcerpt).toContain("fallback plan text")
})
