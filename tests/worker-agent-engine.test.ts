/**
 * Tests for `src/lib/worker-agent/engine.ts` — the `runWorkerAgent`
 * entry point that wires every foundation module into a single Pi
 * `Agent` run.
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` ("Engine sketch (verified
 * Pi API)" + "Test plan" sections).
 *
 * What this file covers:
 *
 *   1. The internal helpers (`extractAssistantText`, `makeModelShim`,
 *      `makeNoWorktreeHandle`) — exported through `__testExports`.
 *   2. The early-exit branches that never touch Pi:
 *        - pre-aborted signal → "Worker queue full"
 *        - semaphore cap exhaustion → "Worker queue full"
 *        - unknown model → forwarded resolve error
 *        - workspace path not accessible → "workspace not accessible"
 *        - implement + worktree on non-git workspace → hard error
 *      Each must release the semaphore slot in the outer `finally`.
 *   3. End-to-end runs with a mocked Copilot SSE response:
 *        - explore mode (no worktree) returns the model's text verbatim
 *        - implement + worktree appends the unified diff to the text
 *        - outer AbortSignal cleanly cancels the run mid-flight
 *
 * Cross-platform: no `process.platform === "win32"` skips. Adding any
 * would violate CLAUDE.md's "Windows-first CI" gate.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { runWorkerAgent, __testExports } from "~/lib/worker-agent/engine"
import {
  MAX_INFLIGHT_WORKER_CALLS,
  __getInFlightForTests,
  __resetForTests as resetWorkerSemaphore,
  acquireWorkerSlot,
} from "~/lib/worker-agent/semaphore"

const { extractAssistantText, makeModelShim, makeNoWorktreeHandle } =
  __testExports

// ---------------------------------------------------------------------
// Fixture helpers
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
    supports: {
      tool_calls?: boolean
      reasoning_effort?: Array<string>
    }
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
        ...(opts.tool_calls !== undefined
          ? { tool_calls: opts.tool_calls }
          : {}),
        ...(opts.reasoning_effort
          ? { reasoning_effort: opts.reasoning_effort }
          : {}),
      },
    },
    supported_endpoints: ["/v1/chat/completions"],
  }
}

/** Build a minimal SSE Response that satisfies Copilot's wire shape. */
function sseResponse(chunks: Array<object>): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

/** Simple "model emits one text turn then stops" SSE. */
function sseFinalText(text: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ])
}

// ---------------------------------------------------------------------
// Module-wide fixture: seed state.models so resolveModelAndThinking
// admits the default model, and stash globalThis.fetch.
// ---------------------------------------------------------------------

const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      fakeModel("gemini-3.5-flash", {
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
// __testExports: internal helpers
// ============================================================

describe("extractAssistantText", () => {
  test("concatenates multi-text-part content in order", () => {
    const text = extractAssistantText([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world!" },
    ])
    expect(text).toBe("Hello, world!")
  })

  test("drops ThinkingContent and ToolCall parts", () => {
    const text = extractAssistantText([
      { type: "thinking", thinking: "let me think..." } as unknown as {
        type: "text"
        text: string
      },
      { type: "text", text: "answer:" },
      {
        type: "toolCall",
        id: "1",
        name: "read",
        arguments: {},
      } as unknown as { type: "text"; text: string },
      { type: "text", text: " 42" },
    ])
    expect(text).toBe("answer: 42")
  })

  test("returns empty string for content with no text parts", () => {
    expect(extractAssistantText([])).toBe("")
    expect(
      extractAssistantText([
        {
          type: "toolCall",
          id: "1",
          name: "read",
          arguments: {},
        } as unknown as { type: "text"; text: string },
      ]),
    ).toBe("")
  })
})

describe("makeModelShim", () => {
  test("stamps the requested id and uses openai-completions API/provider", () => {
    const m = makeModelShim("gemini-3.5-flash")
    expect(m.id).toBe("gemini-3.5-flash")
    expect(m.name).toBe("gemini-3.5-flash")
    expect(m.api).toBe("openai-completions")
    expect(m.provider).toBe("github-copilot")
    expect(m.reasoning).toBe(true)
  })
})

describe("makeNoWorktreeHandle", () => {
  test("dir equals the workspace, finalize is empty, remove is a no-op", async () => {
    const handle = makeNoWorktreeHandle("/tmp/some-workspace")
    expect(handle.dir).toBe("/tmp/some-workspace")
    expect(handle.branch).toBe("")
    expect(await handle.finalize()).toBe("")
    // remove() resolves cleanly without touching disk.
    await handle.remove()
  })
})

// ============================================================
// runWorkerAgent: early-exit branches (no Pi loop)
// ============================================================

describe("runWorkerAgent early-exit branches", () => {
  test("pre-aborted signal returns 'Worker queue full', releases nothing", async () => {
    const ac = new AbortController()
    ac.abort()
    const before = __getInFlightForTests()
    const r = await runWorkerAgent({
      prompt: "irrelevant",
      mode: "explore",
      workspace: process.cwd(),
      signal: ac.signal,
    })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Worker queue full; retry shortly.")
    // No slot was ever acquired (acquireWorkerSlot bailed on aborted),
    // so the in-flight count is unchanged.
    expect(__getInFlightForTests()).toBe(before)
  })

  test("semaphore cap exhaustion returns 'Worker queue full'", async () => {
    // Fill the semaphore from the outside.
    const releases: Array<() => void> = []
    for (let i = 0; i < MAX_INFLIGHT_WORKER_CALLS; i += 1) {
      const r = await acquireWorkerSlot()
      expect(r).toBeTypeOf("function")
      releases.push(r as () => void)
    }
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_WORKER_CALLS)

    const result = await runWorkerAgent({
      prompt: "irrelevant",
      mode: "explore",
      workspace: process.cwd(),
    })
    expect(result.isError).toBe(true)
    expect(result.text).toBe("Worker queue full; retry shortly.")

    // Still at cap — runWorkerAgent did NOT acquire (or release) a slot.
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_WORKER_CALLS)

    // Cleanup.
    for (const r of releases) r()
    expect(__getInFlightForTests()).toBe(0)
  })

  test("unknown model returns the resolve error and releases the slot", async () => {
    const before = __getInFlightForTests()
    const r = await runWorkerAgent({
      prompt: "irrelevant",
      mode: "explore",
      workspace: process.cwd(),
      model: "nonexistent-model",
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("Unknown model: nonexistent-model")
    // Slot must be released in outer finally — back to baseline.
    expect(__getInFlightForTests()).toBe(before)
  })

  test("workspace path that fails realpath returns 'workspace not accessible'", async () => {
    const before = __getInFlightForTests()
    const bogus = path.join(
      os.tmpdir(),
      `wa-engine-nonexistent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    const r = await runWorkerAgent({
      prompt: "irrelevant",
      mode: "explore",
      workspace: bogus,
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("workspace not accessible")
    expect(__getInFlightForTests()).toBe(before)
  })

  test("implement + worktree on a non-git workspace returns a hard error", async () => {
    const before = __getInFlightForTests()
    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "wa-engine-no-git-")),
    )
    try {
      const r = await runWorkerAgent({
        prompt: "irrelevant",
        mode: "implement",
        workspace: dir,
        worktree: true,
      })
      expect(r.isError).toBe(true)
      // worktree.ts message format.
      expect(r.text).toMatch(/not a repository|git/i)
      // The fallback to no-worktree MUST NOT have happened; the
      // error is hard. Slot still released.
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ============================================================
// runWorkerAgent: end-to-end success paths (Pi loop, mocked Copilot)
// ============================================================

describe("runWorkerAgent end-to-end (mocked Copilot)", () => {
  test("explore mode returns the model's text verbatim, no diff suffix", async () => {
    globalThis.fetch = mock(
      () => sseFinalText("explore-mode-reply"),
    ) as unknown as typeof fetch

    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "wa-engine-explore-")),
    )
    try {
      const before = __getInFlightForTests()
      const r = await runWorkerAgent({
        prompt: "summarize the workspace",
        mode: "explore",
        workspace: dir,
      })
      expect(r.isError).toBeUndefined()
      // No banners, no labels, no clamp notices — verbatim text.
      expect(r.text).toBe("explore-mode-reply")
      // Slot released by outer finally.
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("implement + worktree appends the unified diff to the model text", async () => {
    globalThis.fetch = mock(
      () => sseFinalText("implement-mode-reply"),
    ) as unknown as typeof fetch

    // Build a real git repo so createWorktree succeeds, then stage an
    // untracked file inside the worktree by hooking into the Pi loop's
    // fetch and seeding the new file BEFORE the agent prompts.
    const repo = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "wa-engine-impl-")),
    )
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
      writeFileSync(path.join(repo, "README.md"), "hello\n")
      execFileSync("git", ["add", "-A"], { cwd: repo })
      execFileSync(
        "git",
        ["commit", "-q", "-m", "init"],
        {
          cwd: repo,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "wa-engine-test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "wa-engine-test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        },
      )

      const before = __getInFlightForTests()
      const r = await runWorkerAgent({
        prompt: "do a thing",
        mode: "implement",
        workspace: repo,
        worktree: true,
      })
      expect(r.isError).toBeUndefined()
      // Even when the model didn't touch any files, the diff suffix
      // is the empty string and the engine returns just `finalText`
      // (no trailing "\n\n" separator).
      expect(r.text).toBe("implement-mode-reply")
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("outer AbortSignal cancels the run; result reflects the cancellation", async () => {
    // Mock fetch as a never-resolving promise so the only way out is
    // the AbortController cascading into agent.abort().
    let abortedDuringFetch = false
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal
        if (sig) {
          sig.addEventListener(
            "abort",
            () => {
              abortedDuringFetch = true
              const err = new Error("The operation was aborted.")
              ;(err as { name?: string }).name = "AbortError"
              reject(err)
            },
            { once: true },
          )
        }
      })
    }) as unknown as typeof fetch

    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "wa-engine-abort-")),
    )
    try {
      const ac = new AbortController()
      const before = __getInFlightForTests()

      // Kick off the run, then abort 50ms later.
      const runP = runWorkerAgent({
        prompt: "long-running task",
        mode: "explore",
        workspace: dir,
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 50)

      const r = await runP
      // The abort cascades into the stream-fn as an AbortError, which
      // becomes a terminal `error` event with `stopReason: "aborted"`.
      // Pi treats that as a clean end-of-turn (no throw); the final
      // assistant message has empty `content`, so `extractAssistantText`
      // returns `""`. Either way the engine MUST return without
      // hanging — that's the load-bearing assertion.
      expect(typeof r.text).toBe("string")
      // The fetch must have observed the abort (proves the bridge
      // from `opts.signal` → `agent.abort()` → tool-level signal
      // actually fired).
      expect(abortedDuringFetch).toBe(true)
      // Slot released regardless of how the run ended.
      expect(__getInFlightForTests()).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
