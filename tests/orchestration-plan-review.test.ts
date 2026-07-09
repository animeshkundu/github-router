import { describe, expect, mock, test } from "bun:test"

import {
  buildPlanReviewHookCommand,
  decidePlanReviewHook,
  filePlanReviewDebounce,
  PLAN_REVIEW_MIN_CHARS,
  runPlanReview,
} from "../src/lib/orchestration/plan-review-hook"
import { type FindingsStore, type ReviewDebounce } from "../src/lib/orchestration/stop-gate-policy"
import { type McpToolResult } from "../src/lib/orchestration/hook-mcp-client"

function longPlan(extra = ""): string {
  return [
    "Implement the plan-review hook by mirroring the existing Stop-review architecture.",
    "Read the ExitPlanMode payload, prefer planFilePath over inline plan text, skip trivial plans, debounce by hash,",
    "spawn a detached reviewer, call a cross-lab critic with a bounded timeout, and write material findings to the shared store.",
    "Verify fail-open behavior, non-blocking exit semantics, and advisory-only delivery through the next prompt.",
    extra,
  ].join(" ")
}

function memDebounce(): { seen: Map<string, string>; debounce: ReviewDebounce } {
  const seen = new Map<string, string>()
  return {
    seen,
    debounce: {
      shouldReview: async (sessionId, hash) => (seen.get(sessionId) ?? "") !== hash,
      markReviewed: async (sessionId, hash) => { seen.set(sessionId, hash) },
    },
  }
}

function findingsStore(initial: string | null = null): {
  writes: string[]
  store: FindingsStore
} {
  let value = initial
  const writes: string[] = []
  return {
    writes,
    store: {
      read: async () => value,
      write: async (_sid, findings) => {
        value = findings
        writes.push(findings)
      },
      clear: async () => { value = null },
    },
  }
}

describe("plan-review hook decision", () => {
  test("missing runtime, malformed payload, subagent payload, and absent/trivial plans skip without debounce writes", async () => {
    for (const input of [
      { stdin: JSON.stringify({ session_id: "s", tool_input: { plan: longPlan() } }), runtimeAvailable: false },
      { stdin: "not json", runtimeAvailable: true },
      { stdin: JSON.stringify({ session_id: "s", agent_type: "Explore", tool_input: { plan: longPlan() } }), runtimeAvailable: true },
      { stdin: JSON.stringify({ session_id: "s", tool_input: {} }), runtimeAvailable: true },
      { stdin: JSON.stringify({ session_id: "s", tool_input: { plan: "too short" } }), runtimeAvailable: true },
    ]) {
      const { seen, debounce } = memDebounce()
      const decision = await decidePlanReviewHook({
        stdin: input.stdin,
        runtimeAvailable: input.runtimeAvailable,
        debounce,
        fallbackCwd: "/fallback",
      })
      expect(decision.kind).toBe("skip")
      expect(seen.size).toBe(0)
    }
  })

  test("substantive plan reads planFilePath before inline fallback and debounces by plan hash", async () => {
    const { seen, debounce } = memDebounce()
    const filePlan = longPlan("from file")
    const readFile = mock(async (_path: string) => filePlan)
    const stdin = JSON.stringify({
      session_id: "s1",
      cwd: "/repo",
      tool_input: { planFilePath: "/tmp/plan.md", plan: longPlan("inline") },
    })

    const first = await decidePlanReviewHook({ stdin, runtimeAvailable: true, debounce, fallbackCwd: "/fallback", readFile })
    const second = await decidePlanReviewHook({ stdin, runtimeAvailable: true, debounce, fallbackCwd: "/fallback", readFile })

    expect(readFile.mock.calls.length).toBe(2)
    expect(first.kind).toBe("spawn")
    if (first.kind === "spawn") {
      expect(first.sessionId).toBe("s1")
      expect(first.cwd).toBe("/repo")
      expect(first.plan).toBe(filePlan)
      expect(first.planHash.length).toBeGreaterThan(0)
    }
    expect(second.kind).toBe("skip")
    expect(seen.size).toBe(1)
  })

  test("file-backed debounce reviews a changed plan once and records the latest hash", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${process.cwd()}/.tmp-plan-review-`))
    try {
      const debounce = filePlanReviewDebounce(dir)
      const stdin = (plan: string) => JSON.stringify({ session_id: "s", tool_input: { plan } })
      const first = await decidePlanReviewHook({ stdin: stdin(longPlan("one")), runtimeAvailable: true, debounce, fallbackCwd: "/w" })
      const same = await decidePlanReviewHook({ stdin: stdin(longPlan("one")), runtimeAvailable: true, debounce, fallbackCwd: "/w" })
      const changed = await decidePlanReviewHook({ stdin: stdin(longPlan("two")), runtimeAvailable: true, debounce, fallbackCwd: "/w" })

      expect(first.kind).toBe("spawn")
      expect(same.kind).toBe("skip")
      expect(changed.kind).toBe("spawn")
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))
    }
  })
})

describe("runPlanReview", () => {
  const runtime = { serverUrl: "http://127.0.0.1:8787", nonce: "n" }

  test("writes material critic findings to the shared findings store with advisory framing", async () => {
    const { store, writes } = findingsStore()
    const callReview = mock(async (_brief: string, _signal: AbortSignal): Promise<McpToolResult> => ({
      isError: false,
      text: "Important: plan misses a Windows path case.",
    }))

    await runPlanReview({ runtime, sessionId: "s", cwd: "/repo", plan: longPlan(), findingsStore: store, callReview })

    expect(callReview.mock.calls.length).toBe(1)
    expect(callReview.mock.calls[0]?.[0]).toContain("FINALIZED PLAN")
    expect(writes.length).toBe(1)
    expect(writes[0]).toContain("PLAN REVIEW")
    expect(writes[0]).toContain("Windows path case")
  })

  test("no material objection, tool errors, thrown calls, and timeouts write no findings", async () => {
    for (const callReview of [
      async (): Promise<McpToolResult> => ({ isError: false, text: "no material objection" }),
      async (): Promise<McpToolResult> => ({ isError: true, text: "model unavailable" }),
      async (): Promise<McpToolResult> => { throw new Error("network") },
      () => new Promise<McpToolResult>((resolve) => {
        const timer = setTimeout(() => resolve({ isError: false, text: "late" }), 5_000)
        timer.unref?.()
      }),
    ]) {
      const { store, writes } = findingsStore()
      await runPlanReview({ runtime, sessionId: "s", cwd: "/repo", plan: longPlan(), findingsStore: store, timeoutMs: 25, callReview })
      expect(writes.length).toBe(0)
    }
  })

  test("appends plan findings after existing Stop-review findings instead of clobbering", async () => {
    const { store, writes } = findingsStore("STOP REVIEW: existing finding")
    await runPlanReview({
      runtime,
      sessionId: "s",
      cwd: "/repo",
      plan: longPlan(),
      findingsStore: store,
      callReview: async () => ({ isError: false, text: "Plan omits a verification step." }),
    })

    expect(writes.length).toBe(1)
    expect(writes[0]).toContain("STOP REVIEW: existing finding")
    expect(writes[0]).toContain("Plan omits a verification step")
  })
})

describe("plan review hook registration command", () => {
  test("buildPlanReviewHookCommand mirrors the internal hook command quoting", () => {
    expect(buildPlanReviewHookCommand("/usr/bin/node", "/app/main.js")).toBe(
      '"/usr/bin/node" "/app/main.js" internal-plan-review',
    )
    expect(buildPlanReviewHookCommand("/app/ghr", undefined)).toBe('"/app/ghr" internal-plan-review')
  })

  test("PLAN_REVIEW_MIN_CHARS is high enough to skip one-line trivial plans", () => {
    expect(PLAN_REVIEW_MIN_CHARS).toBeGreaterThan(100)
  })
})
