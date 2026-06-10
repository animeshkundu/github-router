/**
 * Tests for `mode: "browse"` in `src/lib/worker-agent/engine.ts`.
 *
 * Browse runs the SAME `runWorkerAgent` engine as explore/implement/review,
 * but with three browse-specific differences this file pins:
 *
 *   1. the default model is `BROWSE_DEFAULT_MODEL` (the Gate-B browse model),
 *      NOT the gemini worker `DEFAULT_MODEL` — and an explicit `model` arg
 *      still wins;
 *   2. the toolset is the browser-control tools (`buildBrowseTools`), NOT
 *      the filesystem worker tools (`buildWorkerTools`);
 *   3. an omitted `workspace` defaults to cwd (browse ignores the FS), and a
 *      worktree is NEVER provisioned (worktrees stay implement-only).
 *
 * Mocked at the Copilot boundary: `globalThis.fetch` returns a one-turn SSE
 * (text + stop, no tool calls), so the real Pi loop + real `buildBrowseTools`
 * run, the upstream request body is captured for assertion, and NO live model
 * or browser is touched (no browse tool is ever called, so the bridge is
 * never reached). Mirrors the pattern in `worker-agent-engine.test.ts`.
 *
 * Cross-platform: no `process.platform === "win32"` skips (CLAUDE.md
 * Windows-first CI gate).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL,
  runWorkerAgent,
} from "~/lib/worker-agent/engine"
import {
  __getInFlightForTests,
  __resetForTests as resetWorkerSemaphore,
} from "~/lib/worker-agent/semaphore"

// ---------------------------------------------------------------------
// Fixture helpers (self-contained — mirrors worker-agent-engine.test.ts)
// ---------------------------------------------------------------------

interface ModelsLikeEntry {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean
  model_picker_enabled: boolean
  object: "model"
  capabilities: {
    type: string
    family: string
    object: string
    tokenizer: string
    limits: Record<string, never>
    supports: { tool_calls?: boolean; reasoning_effort?: Array<string> }
  }
  supported_endpoints: Array<string>
}

function fakeModel(
  id: string,
  opts: { tool_calls?: boolean; reasoning_effort?: Array<string> } = {},
): ModelsLikeEntry {
  return {
    id,
    name: id,
    vendor: id.startsWith("gemini") ? "Google" : "OpenAI",
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
      supports: {
        ...(opts.tool_calls !== undefined ? { tool_calls: opts.tool_calls } : {}),
        ...(opts.reasoning_effort ? { reasoning_effort: opts.reasoning_effort } : {}),
      },
    },
    // Drive BOTH fixtures through `/chat/completions` so the chat-shaped SSE
    // below works. The engine's model SELECTION (what this file tests) is
    // orthogonal to the stream-fn's chat-vs-responses endpoint routing —
    // gpt-5.4-mini is `/responses`-only in production, but the routing is
    // covered by the stream-fn tests, not here.
    supported_endpoints: ["/v1/chat/completions"],
  }
}

/** "Model emits one text turn then stops" — chat-completions SSE shape. */
function sseFinalText(text: string): Response {
  const body =
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n` +
    "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

/**
 * "Model calls one tool then finishes (finish_reason=tool_calls)" — the shape
 * Pi's chat stream-fn parses into a tool call. The browse terminal tools
 * (`submit_answer` / `report_insufficient`) set `terminate:true`, so the loop
 * stops after this single turn with the answer living in the tool ARGS.
 */
function sseToolCall(name: string, args: Record<string, unknown>): Response {
  const body =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    })}\n\n` +
    "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

interface CapturedBody {
  model?: string
  tools?: Array<{ type: string; function: { name: string } }>
  reasoning_effort?: string
}

/**
 * A `globalThis.fetch` mock that (1) records the JSON request body of every
 * upstream call so the test can assert model + tools, and (2) returns
 * `response()` each time.
 */
function recordingFetch(response: () => Response): {
  fetchMock: typeof fetch
  bodies: Array<CapturedBody>
} {
  const bodies: Array<CapturedBody> = []
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      try {
        bodies.push(JSON.parse(init.body) as CapturedBody)
      } catch {
        /* non-JSON body — ignore for this assertion surface */
      }
    }
    return Promise.resolve(response())
  }) as unknown as typeof fetch
  return { fetchMock, bodies }
}

function toolNamesOf(body: CapturedBody | undefined): Array<string> {
  return (body?.tools ?? []).map((t) => t.function.name)
}

function tmpDir(tag: string): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `wa-browse-${tag}-`)))
}

// ---------------------------------------------------------------------
// Module-wide fixture
// ---------------------------------------------------------------------

const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      // Browse default.
      fakeModel(BROWSE_DEFAULT_MODEL, {
        tool_calls: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
      // Gemini worker default — present so a wrong-default regression
      // (browse falling back to DEFAULT_MODEL) is observable.
      fakeModel(DEFAULT_MODEL, {
        tool_calls: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
    ],
  }
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  resetWorkerSemaphore()
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.vsCodeVersion = originalVsCodeVersion
  globalThis.fetch = originalFetch
  resetWorkerSemaphore()
})

// ============================================================
// Constant
// ============================================================

describe("BROWSE_DEFAULT_MODEL", () => {
  test("pins the Gate-B browse model and is distinct from the worker default", () => {
    expect(BROWSE_DEFAULT_MODEL).toBe("gpt-5.4-mini")
    expect(BROWSE_DEFAULT_MODEL).not.toBe(DEFAULT_MODEL)
  })
})

// ============================================================
// Model selection
// ============================================================

describe("browse mode model selection", () => {
  test("defaults to BROWSE_DEFAULT_MODEL when no model is given", async () => {
    const { fetchMock, bodies } = recordingFetch(() => sseFinalText("browse-reply"))
    globalThis.fetch = fetchMock

    const dir = tmpDir("model")
    try {
      const before = __getInFlightForTests()
      const r = await runWorkerAgent({
        prompt: "find the listed price",
        mode: "browse",
        workspace: dir,
      })
      expect(r.isError).toBeUndefined()
      // Verbatim text, no diff suffix (browse never produces a diff).
      expect(r.text).toBe("browse-reply")
      expect(bodies.length).toBeGreaterThan(0)
      expect(bodies[0]!.model).toBe(BROWSE_DEFAULT_MODEL)
      // Critically NOT the gemini worker default.
      expect(bodies[0]!.model).not.toBe(DEFAULT_MODEL)
      // Slot released by the outer finally.
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an explicit model arg overrides the browse default", async () => {
    const { fetchMock, bodies } = recordingFetch(() => sseFinalText("override-reply"))
    globalThis.fetch = fetchMock

    const dir = tmpDir("override")
    try {
      const r = await runWorkerAgent({
        prompt: "x",
        mode: "browse",
        workspace: dir,
        model: DEFAULT_MODEL,
      })
      expect(r.isError).toBeUndefined()
      expect(bodies[0]!.model).toBe(DEFAULT_MODEL)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ============================================================
// Tool surface
// ============================================================

describe("browse mode builds the browser tools (not the worker tools)", () => {
  test("upstream request carries browse tools incl. the terminal tools", async () => {
    const { fetchMock, bodies } = recordingFetch(() => sseFinalText("ok"))
    globalThis.fetch = fetchMock

    const dir = tmpDir("tools")
    try {
      const r = await runWorkerAgent({
        prompt: "x",
        mode: "browse",
        workspace: dir,
      })
      expect(r.isError).toBeUndefined()
      const names = toolNamesOf(bodies[0])
      // Browse wire tools + synthetic terminals are present.
      expect(names).toContain("navigate")
      expect(names).toContain("read_page")
      expect(names).toContain("submit_answer")
      expect(names).toContain("report_insufficient")
      // The filesystem worker toolset is NOT present.
      for (const fsTool of ["read", "glob", "grep", "code_search", "web_search", "fetch_url"]) {
        expect(names).not.toContain(fsTool)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ============================================================
// Workspace defaulting + no worktree
// ============================================================

describe("browse mode workspace + worktree handling", () => {
  test("defaults workspace to cwd when omitted (no 'workspace not accessible')", async () => {
    const { fetchMock, bodies } = recordingFetch(() => sseFinalText("cwd-reply"))
    globalThis.fetch = fetchMock

    const before = __getInFlightForTests()
    const r = await runWorkerAgent({
      prompt: "x",
      mode: "browse",
      // workspace intentionally omitted
    })
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe("cwd-reply")
    // Reaching the upstream call proves canonicalization succeeded against
    // the cwd default (otherwise the run would early-exit before any fetch).
    expect(bodies.length).toBeGreaterThan(0)
    expect(__getInFlightForTests()).toBe(before)
  })

  test("does NOT provision a worktree even with worktree:true on a non-git workspace", async () => {
    const { fetchMock } = recordingFetch(() => sseFinalText("browse-done"))
    globalThis.fetch = fetchMock

    // A plain temp dir is NOT a git repo. If browse mistakenly tried to
    // provision a worktree, `createWorktree` would hard-error
    // (/not a repository/) — so a clean run proves browse skipped it.
    const nonGit = tmpDir("no-git")
    try {
      const r = await runWorkerAgent({
        prompt: "x",
        mode: "browse",
        workspace: nonGit,
        worktree: true,
      })
      expect(r.isError).toBeUndefined()
      expect(r.text).toBe("browse-done")
      expect(r.text).not.toMatch(/not a repository|worktree/i)
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })
})

// ============================================================
// Terminal-answer surfacing (regression: "[exited with no output]")
// ============================================================

describe("browse mode surfaces the terminal tool's answer", () => {
  // The browse agent finishes by CALLING `submit_answer` /
  // `report_insufficient` — its answer is the tool ARGS, not assistant text.
  // The terminal turn's assistant message is just the tool call (empty text,
  // stopReason=toolUse), so before the engine captured the args a successful
  // run returned "[worker exited with no output]". These pin the capture.
  test("submit_answer payload becomes result.text (not '[no output]')", async () => {
    const { fetchMock } = recordingFetch(() =>
      sseToolCall("submit_answer", {
        status: "complete",
        answer: "Top story: macOS Container Machines",
        evidence: "Hacker News front page, row 1",
      }),
    )
    globalThis.fetch = fetchMock

    const dir = tmpDir("terminal")
    try {
      const before = __getInFlightForTests()
      const r = await runWorkerAgent({
        prompt: "report the top story",
        mode: "browse",
        workspace: dir,
      })
      expect(r.isError).toBeUndefined()
      expect(r.text).toBe(
        "Top story: macOS Container Machines\n\nEvidence: Hacker News front page, row 1",
      )
      expect(r.text).not.toContain("exited with no output")
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("report_insufficient payload becomes result.text", async () => {
    const { fetchMock } = recordingFetch(() =>
      sseToolCall("report_insufficient", {
        reason: "no price shown in any frame on the page",
      }),
    )
    globalThis.fetch = fetchMock

    const dir = tmpDir("insufficient")
    try {
      const r = await runWorkerAgent({
        prompt: "find the price",
        mode: "browse",
        workspace: dir,
      })
      expect(r.isError).toBeUndefined()
      expect(r.text).toBe(
        "Insufficient evidence: no price shown in any frame on the page",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
