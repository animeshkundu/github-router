/**
 * Unit tests for the Phase-0 structural-gate decision
 * (`src/lib/orchestration/stop-gate.ts`). It composes the gate runner + the
 * gate-immutability detector; a miss here would let broken or gate-gamed code be
 * marked "done" — the floor failure Phase 0 exists to prevent.
 */

import { describe, expect, test } from "bun:test"

import { type CheckSpec, type ExecFn } from "../src/lib/orchestration/gate-runner"
import { evaluateStopGate } from "../src/lib/orchestration/stop-gate"

const checks: CheckSpec[] = [
  { id: "tests", command: "bun test" },
  { id: "types", command: "tsc" },
]
const exec = (codes: Record<string, number>): ExecFn => async ({ command }) => ({ exitCode: codes[command] ?? 0 })
const cleanDiff = "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+export const y = 1"

describe("evaluateStopGate", () => {
  test("all gates pass + clean diff → do not block", async () => {
    const r = await evaluateStopGate({ checks, cwd: "/ws", exec: exec({ "bun test": 0, "tsc": 0 }), diff: cleanDiff })
    expect(r.block).toBe(false)
    expect(r.failedChecks).toEqual([])
    expect(r.weakening).toEqual([])
  })

  test("a failing gate → block, names the failed check", async () => {
    const r = await evaluateStopGate({ checks, cwd: "/ws", exec: exec({ "bun test": 1, "tsc": 0 }), diff: cleanDiff })
    expect(r.block).toBe(true)
    expect(r.failedChecks).toContain("tests")
    expect(r.reason).toContain("failing gates")
  })

  test("gate-weakening in the diff → block even when all gates pass", async () => {
    const diff = "diff --git a/tests/a.test.ts b/tests/a.test.ts\n+++ b/tests/a.test.ts\n+  test.skip(\"x\", () => {})"
    const r = await evaluateStopGate({ checks, cwd: "/ws", exec: exec({ "bun test": 0, "tsc": 0 }), diff })
    expect(r.block).toBe(true)
    expect(r.weakening.length).toBeGreaterThan(0)
    expect(r.reason).toContain("gate-weakening")
  })

  test("both a failing gate AND weakening → block, reason mentions both", async () => {
    const diff = "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+const z = foo as any"
    const r = await evaluateStopGate({ checks, cwd: "/ws", exec: exec({ "bun test": 1, "tsc": 0 }), diff })
    expect(r.block).toBe(true)
    expect(r.reason).toContain("failing gates")
    expect(r.reason).toContain("gate-weakening")
  })
})
