import { describe, expect, mock, test } from "bun:test"

import { type ExecFn } from "../src/lib/orchestration/gate-runner"
import {
  type BlockBudget,
  decideStopHook,
  type StopReviewContext,
} from "../src/lib/orchestration/stop-gate-hook"
import { type BaselineStore, type ReviewDebounce } from "../src/lib/orchestration/stop-gate-policy"

type StopHookInput = Parameters<typeof decideStopHook>[0]

/** An in-memory block budget for decision tests. */
function memBudget(): { counts: Map<string, number>; budget: BlockBudget } {
  const counts = new Map<string, number>()
  return {
    counts,
    budget: {
      count: async (sid) => counts.get(sid) ?? 0,
      record: async (sid) => { counts.set(sid, (counts.get(sid) ?? 0) + 1) },
      reset: async (sid) => { counts.delete(sid) },
    },
  }
}

/** An in-memory baseline store; omitted sessions return null (first eval). */
function memBaseline(initial: Record<string, string[]> = {}): { state: Map<string, string[]>; baseline: BaselineStore } {
  const state = new Map<string, string[]>(Object.entries(initial))
  return {
    state,
    baseline: {
      get: async (sid) => (state.has(sid) ? new Set(state.get(sid)!) : null),
      set: async (sid, failed) => { state.set(sid, [...failed]) },
    },
  }
}

function baselineKey(sessionId: string, cwd: string, gateId: string): string {
  return JSON.stringify([sessionId, cwd, gateId])
}

function reviewDebounceAlways(): ReviewDebounce {
  return {
    shouldReview: async () => true,
    markReviewed: async () => {},
  }
}

function memReviewDebounce(): { lastBySession: Map<string, string>; reviewDebounce: ReviewDebounce } {
  const lastBySession = new Map<string, string>()
  return {
    lastBySession,
    reviewDebounce: {
      shouldReview: async (sessionId, diffHash) => (lastBySession.get(sessionId) ?? "") !== diffHash,
      markReviewed: async (sessionId, diffHash) => { lastBySession.set(sessionId, diffHash) },
    },
  }
}

function decisionInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
  const { budget } = memBudget()
  const { baseline } = memBaseline()
  return {
    stdin: JSON.stringify({ cwd: "/w", session_id: "s1" }),
    gateId: "typecheck-only",
    exec: allPass,
    captureDiff: async () => "+ export const answer = 42\n",
    fallbackCwd: "/fallback",
    budget,
    baseline,
    isEnabledForRepo: async () => true,
    ...overrides,
  }
}

const allPass: ExecFn = async () => ({ exitCode: 0 })
const allFail: ExecFn = async () => ({ exitCode: 1 })

describe("decideStopHook advisory review", () => {
  test("review-never-blocks: green substantive stops spawn review, and spawn failures still allow", async () => {
    const spawnReview = mock((_: StopReviewContext) => {})
    const clean = await decideStopHook(decisionInput({
      reviewDebounce: reviewDebounceAlways(),
      spawnReview,
    }))

    expect(clean).toEqual({ exitCode: 0 })
    expect(spawnReview.mock.calls.length).toBe(1)
    expect(spawnReview.mock.calls[0]?.[0].sessionId).toBe("s1")
    expect(spawnReview.mock.calls[0]?.[0].diff).toBe("+ export const answer = 42\n")
    expect(spawnReview.mock.calls[0]?.[0].diffHash.length).toBeGreaterThan(0)

    const throwingSpawn = mock((_: StopReviewContext) => { throw new Error("review spawn failed") })
    const stillClean = await decideStopHook(decisionInput({
      reviewDebounce: reviewDebounceAlways(),
      spawnReview: throwingSpawn,
    }))

    expect(stillClean).toEqual({ exitCode: 0 })
    expect(throwingSpawn.mock.calls.length).toBe(1)
  })

  test("deterministic-regression-still-unconditional: a red regression blocks and does not spawn review", async () => {
    const { budget } = memBudget()
    const { baseline } = memBaseline()

    const firstEval = await decideStopHook(decisionInput({
      budget,
      baseline,
      exec: allPass,
      captureDiff: async () => "+ export const before = true\n",
    }))
    expect(firstEval).toEqual({ exitCode: 0 })

    const spawnReview = mock((_: StopReviewContext) => {})
    const regression = await decideStopHook(decisionInput({
      budget,
      baseline,
      exec: allFail,
      captureDiff: async () => "+ export const after = true\n",
      reviewDebounce: reviewDebounceAlways(),
      spawnReview,
    }))

    expect(regression.exitCode).toBe(2)
    expect(regression.stderr).toContain("regressed gates: typecheck")
    expect(spawnReview.mock.calls.length).toBe(0)
  })

  test("debounce: identical green diffs review once, changed diffs review again, and empty diffs never review", async () => {
    const { budget } = memBudget()
    const { baseline } = memBaseline()
    const { lastBySession, reviewDebounce } = memReviewDebounce()
    const spawnReview = mock((_: StopReviewContext) => {})

    const first = await decideStopHook(decisionInput({
      budget,
      baseline,
      captureDiff: async () => "+ const one = 1\n",
      reviewDebounce,
      spawnReview,
    }))
    const same = await decideStopHook(decisionInput({
      budget,
      baseline,
      captureDiff: async () => "+ const one = 1\n",
      reviewDebounce,
      spawnReview,
    }))
    const changed = await decideStopHook(decisionInput({
      budget,
      baseline,
      captureDiff: async () => "+ const two = 2\n",
      reviewDebounce,
      spawnReview,
    }))

    expect(first).toEqual({ exitCode: 0 })
    expect(same).toEqual({ exitCode: 0 })
    expect(changed).toEqual({ exitCode: 0 })
    expect(spawnReview.mock.calls.length).toBe(2)
    expect(lastBySession.get("s1")).toBe(spawnReview.mock.calls[1]?.[0].diffHash)
    expect(spawnReview.mock.calls.map((call) => call[0].diff)).toEqual([
      "+ const one = 1\n",
      "+ const two = 2\n",
    ])

    const emptySpawn = mock((_: StopReviewContext) => {})
    const empty = await decideStopHook(decisionInput({
      captureDiff: async () => "",
      reviewDebounce: memReviewDebounce().reviewDebounce,
      spawnReview: emptySpawn,
    }))

    expect(empty).toEqual({ exitCode: 0 })
    expect(emptySpawn.mock.calls.length).toBe(0)
  })

  test("subagent, no-session, untrusted, and timeout stand-downs never spawn review", async () => {
    const subagentSpawn = mock((_: StopReviewContext) => {})
    const subagent = await decideStopHook(decisionInput({
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", agent_type: "Explore" }),
      reviewDebounce: reviewDebounceAlways(),
      spawnReview: subagentSpawn,
    }))
    expect(subagent).toEqual({ exitCode: 0 })
    expect(subagentSpawn.mock.calls.length).toBe(0)

    const noSessionSpawn = mock((_: StopReviewContext) => {})
    const noSession = await decideStopHook(decisionInput({
      stdin: JSON.stringify({ cwd: "/w" }),
      reviewDebounce: reviewDebounceAlways(),
      spawnReview: noSessionSpawn,
    }))
    expect(noSession).toEqual({ exitCode: 0 })
    expect(noSessionSpawn.mock.calls.length).toBe(0)

    const untrustedSpawn = mock((_: StopReviewContext) => {})
    const untrusted = await decideStopHook(decisionInput({
      isEnabledForRepo: async () => false,
      reviewDebounce: reviewDebounceAlways(),
      spawnReview: untrustedSpawn,
    }))
    expect(untrusted).toEqual({ exitCode: 0 })
    expect(untrustedSpawn.mock.calls.length).toBe(0)

    const timeoutSpawn = mock((_: StopReviewContext) => {})
    const hangingExec: ExecFn = () => new Promise(() => {})
    const timeout = await decideStopHook(decisionInput({
      exec: hangingExec,
      timeoutMs: 25,
      reviewDebounce: reviewDebounceAlways(),
      spawnReview: timeoutSpawn,
    }))
    expect(timeout).toEqual({ exitCode: 0 })
    expect(timeoutSpawn.mock.calls.length).toBe(0)
  })

  test("first green eval records the empty baseline used by later regression checks", async () => {
    const { state, baseline } = memBaseline()
    const first = await decideStopHook(decisionInput({ baseline }))

    expect(first).toEqual({ exitCode: 0 })
    expect(state.get(baselineKey("s1", "/w", "typecheck-only"))).toEqual([])
  })
})
