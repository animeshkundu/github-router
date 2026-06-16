/**
 * Tests for the worker no-output retry (`withNoOutputRetry`). The wrapper retries
 * a worker run EXACTLY ONCE when it returns the transient no-output sentinel (a
 * clean stop with empty text), and leaves real errors / budget caps / aborts
 * alone. `runOnce` is injected so this is deterministic and model-free.
 */

import { describe, expect, test } from "bun:test"

import { withNoOutputRetry } from "../src/lib/worker-agent/engine"
import type { WorkerAgentOpts, WorkerAgentResult } from "../src/lib/worker-agent/types"

const NO_OUTPUT: WorkerAgentResult = {
  text: "[worker exited with no output (stopReason=stop, turns=2, elapsed=10ms)]",
  isError: true,
}
const GOOD: WorkerAgentResult = { text: "the answer" }
const REAL_ERROR: WorkerAgentResult = { text: "Worker run failed before producing an answer", isError: true }

const opts = (signal?: AbortSignal): WorkerAgentOpts => ({ prompt: "x", mode: "explore", signal })

/** A fake runOnce that returns the given results in order (repeating the last). */
function seq(...results: WorkerAgentResult[]): { run: (o: WorkerAgentOpts) => Promise<WorkerAgentResult>; calls: () => number } {
  let i = 0
  let n = 0
  return {
    run: async () => {
      n += 1
      return results[Math.min(i++, results.length - 1)]!
    },
    calls: () => n,
  }
}

describe("withNoOutputRetry", () => {
  test("good output on the first try → no retry", async () => {
    const f = seq(GOOD)
    const r = await withNoOutputRetry(f.run, opts())
    expect(r).toBe(GOOD)
    expect(f.calls()).toBe(1)
  })

  test("no-output then good → retries once and returns the good result", async () => {
    const f = seq(NO_OUTPUT, GOOD)
    const r = await withNoOutputRetry(f.run, opts())
    expect(r).toBe(GOOD)
    expect(f.calls()).toBe(2)
  })

  test("no-output twice → retries once, then surfaces the original no-output", async () => {
    const f = seq(NO_OUTPUT, NO_OUTPUT)
    const r = await withNoOutputRetry(f.run, opts())
    expect(r.isError).toBe(true)
    expect(r.text).toContain("no output")
    expect(f.calls()).toBe(2) // exactly one retry, never more
  })

  test("a real (non-no-output) error is NOT retried", async () => {
    const f = seq(REAL_ERROR, GOOD)
    const r = await withNoOutputRetry(f.run, opts())
    expect(r).toBe(REAL_ERROR)
    expect(f.calls()).toBe(1)
  })

  test("an aborted signal short-circuits the retry", async () => {
    const f = seq(NO_OUTPUT, GOOD)
    const r = await withNoOutputRetry(f.run, opts(AbortSignal.abort()))
    expect(r).toBe(NO_OUTPUT)
    expect(f.calls()).toBe(1)
  })
})
