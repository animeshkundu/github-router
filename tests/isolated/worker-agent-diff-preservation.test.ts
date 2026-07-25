/**
 * Regression tests for the worktree diff-loss fixes in
 * `src/lib/worker-agent/engine.ts` (Fixes 1 & 2 of the diff-preservation
 * work):
 *
 *   Fix 1 — a run that ends on `stopReason: "error"` must STILL return the
 *           diff captured before `ws.remove()` (previously the error
 *           early-return threw the captured diff away).
 *
 *   Fix 2 — a throw from the Pi loop must capture the diff BEFORE
 *           `ws.remove()` deletes the worktree; otherwise partial work is
 *           destroyed before the caller can inspect it.
 *
 * Both branches live deep inside `runWorkerAgentOnce`, so we mock the Pi
 * `Agent` (to drive the two terminal shapes deterministically) and
 * `createWorktree` (so `finalize()` returns a sentinel diff and we can
 * observe the finalize→remove ordering) rather than fighting a real stream.
 *
 * `mock.module` is process-global, so this file is dedicated to the mocked
 * Agent/worktree path and must NOT also exercise a real worktree — the
 * over-cap `finalize()` durable-patch test (Fix 3) lives in its own file
 * (`tests/worker-agent-worktree-overflow.test.ts`) with the real git surface.
 *
 * Cross-platform: no `process.platform === "win32"` skips (CLAUDE.md
 * Windows-first CI gate).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// ---------------------------------------------------------------------
// Switchable fakes (module-level; the mock factories close over them so
// each test flips behavior before invoking the engine).
// ---------------------------------------------------------------------

/** Drives the mocked Agent's `prompt()` terminal shape. */
let promptBehavior: "error-stop" | "aborted-stop" | "throw" = "error-stop"
/** The sentinel diff `finalize()` returns — asserted in the result text. */
let finalizeResult = "SENTINEL_DIFF"
/** When true the mocked `finalize()` throws, to prove its failure is
 *  swallowed and the original error still stands alone. */
let finalizeThrows = false
/** Ordered record of worktree lifecycle calls for a finalize→remove assert. */
let worktreeCalls: Array<string> = []

class FakeAgent {
  state: { messages: Array<unknown> } = { messages: [] }
  private handlers: Array<(e: unknown) => void> = []
  // The engine passes a big options bag; we ignore it.
  constructor(_opts: unknown) {}
  subscribe(fn: (e: unknown) => void): () => void {
    this.handlers.push(fn)
    return () => {}
  }
  abort(): void {}
  async prompt(_p: string): Promise<void> {
    if (promptBehavior === "throw") {
      throw new Error("simulated pi loop failure")
    }
    // Emit a terminal assistant message with stopReason "error" so the
    // engine's error-branch (Fix 1) fires.
    for (const h of this.handlers) {
      h({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial-answer" }],
          stopReason: promptBehavior === "aborted-stop" ? "aborted" : "error",
        },
      })
    }
  }
  async waitForIdle(): Promise<void> {}
}

mock.module("@earendil-works/pi-agent-core", () => ({ Agent: FakeAgent }))

mock.module("../../src/lib/worker-agent/worktree", () => ({
  createWorktree: async (workspaceAbs: string) => ({
    dir: workspaceAbs,
    branch: "worker/fake",
    finalize: async () => {
      worktreeCalls.push("finalize")
      if (finalizeThrows) throw new Error("finalize blew up")
      return finalizeResult
    },
    remove: async () => {
      worktreeCalls.push("remove")
    },
  }),
}))

// Import the engine + state AFTER the mocks are installed so the engine's
// `import { createWorktree } from "./worktree"` and its Pi `Agent` import
// resolve to our fakes.
const { runWorkerAgent } = await import("../../src/lib/worker-agent/engine")
const { state } = await import("../../src/lib/state")
const {
  __resetForTests: resetWorkerSemaphore,
} = await import("../../src/lib/worker-agent/semaphore")

// ---------------------------------------------------------------------
// Model catalog fixture (resolveModelAndThinking reads state.models).
// ---------------------------------------------------------------------

function fakeModel(id: string, reasoning: Array<string>): unknown {
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
      supports: { tool_calls: true, reasoning_effort: reasoning },
    },
    supported_endpoints: ["/v1/chat/completions"],
  }
}

const originalModels = state.models
const originalCopilotToken = state.copilotToken

beforeEach(() => {
  state.models = {
    object: "list",
    data: [fakeModel("gpt-5.5", ["none", "low", "medium", "high", "xhigh"])],
  } as unknown as typeof state.models
  state.copilotToken = "test-token"
  resetWorkerSemaphore()
  promptBehavior = "error-stop"
  finalizeResult = "SENTINEL_DIFF"
  finalizeThrows = false
  worktreeCalls = []
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  resetWorkerSemaphore()
})

// ---------------------------------------------------------------------
// Fix 1: stopReason "error" still returns the captured diff.
// ---------------------------------------------------------------------

describe("engine: terminal failures preserve the captured worktree diff", () => {
  test("aborted stop is an error with partial text, diff, and cancellation marker", async () => {
    promptBehavior = "aborted-stop"
    finalizeResult = "diff --git a/x b/x\n@@ ABORTED_DIFF @@"

    const r = await runWorkerAgent({
      prompt: "do partial work then cancel",
      mode: "implement",
      workspace: process.cwd(),
      worktree: true,
      model: "gpt-5.5",
    })

    expect(r.isError).toBe(true)
    expect(r.text).toContain("partial-answer")
    expect(r.text).toContain("ABORTED_DIFF")
    expect(r.text).toContain("[halted: cancelled]")
    expect(worktreeCalls).toEqual(["finalize", "remove"])
  })

  test("stopReason error appends the captured diff instead of discarding it", async () => {
    promptBehavior = "error-stop"
    finalizeResult = "diff --git a/x b/x\n@@ FIX1_SENTINEL @@"

    const r = await runWorkerAgent({
      prompt: "do work then hit a stream error",
      mode: "implement",
      workspace: process.cwd(),
      worktree: true,
      model: "gpt-5.5",
    })

    expect(r.isError).toBe(true)
    // The captured partial diff must survive into the returned text.
    expect(r.text).toContain("FIX1_SENTINEL")
    // ...alongside the run's diagnostic text (the partial assistant answer).
    expect(r.text).toContain("partial-answer")
    // The diff was captured BEFORE the worktree was removed.
    expect(worktreeCalls).toEqual(["finalize", "remove"])
  })

  test("an empty diff leaves the diagnostic-only text unchanged (no stray separator)", async () => {
    promptBehavior = "error-stop"
    finalizeResult = "" // model touched nothing

    const r = await runWorkerAgent({
      prompt: "error with no file changes",
      mode: "implement",
      workspace: process.cwd(),
      worktree: true,
      model: "gpt-5.5",
    })

    expect(r.isError).toBe(true)
    expect(r.text).toBe("partial-answer")
  })
})

// ---------------------------------------------------------------------
// Fix 2: a non-budget-cap throw captures + returns the diff before remove.
// ---------------------------------------------------------------------

describe("engine: a thrown (non-abort) run captures the diff before removal", () => {
  test("includes the captured diff and the original error in the result text", async () => {
    promptBehavior = "throw"
    finalizeResult = "diff --git a/y b/y\n@@ FIX2_SENTINEL @@"

    const r = await runWorkerAgent({
      prompt: "throw mid-loop",
      mode: "implement",
      workspace: process.cwd(),
      worktree: true,
      model: "gpt-5.5",
    })

    expect(r.isError).toBe(true)
    // Partial work survives.
    expect(r.text).toContain("FIX2_SENTINEL")
    // Original error is still surfaced (not masked by the diff capture).
    expect(r.text).toContain("simulated pi loop failure")
    // finalize() ran BEFORE remove() — the load-bearing ordering.
    expect(worktreeCalls).toEqual(["finalize", "remove"])
  })

  test("a finalize failure does not mask the original error", async () => {
    promptBehavior = "throw"
    finalizeThrows = true // finalize() throws; its failure must be swallowed

    const r = await runWorkerAgent({
      prompt: "throw mid-loop, finalize also fails",
      mode: "implement",
      workspace: process.cwd(),
      worktree: true,
      model: "gpt-5.5",
    })

    expect(r.isError).toBe(true)
    // The original thrown error is still surfaced.
    expect(r.text).toContain("simulated pi loop failure")
    // ...and the finalize failure is signaled rather than silently dropped.
    expect(r.text).toContain("diff capture failed")
    expect(r.text).toContain("finalize blew up")
    // finalize was attempted before remove even though it threw.
    expect(worktreeCalls).toEqual(["finalize", "remove"])
  })
})
