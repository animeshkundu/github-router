/**
 * Unit tests for the executable-gate runner
 * (`src/lib/orchestration/gate-runner.ts`). The exec is mocked; a wrong outcome
 * here would feed the selector a false gate result and break the floor.
 */

import { describe, expect, test } from "bun:test"

import { runGateChecks, type CheckSpec, type ExecFn } from "../src/lib/orchestration/gate-runner"

const checks: CheckSpec[] = [
  { id: "tests", command: "bun test" },
  { id: "types", command: "tsc" },
  { id: "lint", command: "eslint ." },
]

const execFrom = (codes: Record<string, number>): ExecFn => async ({ command }) => {
  if (!(command in codes)) throw new Error(`unexpected command ${command}`)
  return { exitCode: codes[command]! }
}

describe("runGateChecks", () => {
  test("all checks exit 0 → passed equals ran", async () => {
    const g = await runGateChecks(checks, "/ws", execFrom({ "bun test": 0, "tsc": 0, "eslint .": 0 }))
    expect([...g.passed].sort()).toEqual(["lint", "tests", "types"])
    expect([...g.ran].sort()).toEqual(["lint", "tests", "types"])
  })

  test("a non-zero check is in ran but not passed", async () => {
    const g = await runGateChecks(checks, "/ws", execFrom({ "bun test": 1, "tsc": 0, "eslint .": 0 }))
    expect(g.passed.has("tests")).toBe(false)
    expect(g.ran.has("tests")).toBe(true)
    expect(g.passed.has("types")).toBe(true)
  })

  test("an exec that throws → that check fails (ran, not passed), never crashes", async () => {
    const exec: ExecFn = async ({ command }) => {
      if (command === "tsc") throw new Error("spawn failed")
      return { exitCode: 0 }
    }
    const g = await runGateChecks(checks, "/ws", exec)
    expect(g.passed.has("types")).toBe(false)
    expect(g.ran.has("types")).toBe(true)
    expect(g.passed.has("tests")).toBe(true)
  })

  test("empty check set → empty outcome", async () => {
    const g = await runGateChecks([], "/ws", execFrom({}))
    expect(g.passed.size).toBe(0)
    expect(g.ran.size).toBe(0)
  })

  test("the cwd is threaded to every exec call", async () => {
    const seen: string[] = []
    const exec: ExecFn = async ({ cwd }) => { seen.push(cwd); return { exitCode: 0 } }
    await runGateChecks(checks, "/work/tree", exec)
    expect(seen.every((c) => c === "/work/tree")).toBe(true)
    expect(seen.length).toBe(3)
  })
})
