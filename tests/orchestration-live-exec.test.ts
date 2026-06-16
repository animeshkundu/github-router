/**
 * Tests for the live gate exec (`src/lib/orchestration/live-exec.ts`). Uses real
 * `node -e` subprocesses (model-free, cross-platform, Windows-safe) so this runs
 * directly in CI — it verifies the one real-subprocess piece of the gate engine.
 */

import { describe, expect, test } from "bun:test"

import { runGateChecks } from "../src/lib/orchestration/gate-runner"
import { liveExec } from "../src/lib/orchestration/live-exec"

const CWD = process.cwd()

describe("liveExec", () => {
  test("a command that exits 0 → exitCode 0", async () => {
    const r = await liveExec({ command: "node -e process.exit(0)", cwd: CWD })
    expect(r.exitCode).toBe(0)
  })

  test("a command that exits non-zero → that exit code", async () => {
    const r = await liveExec({ command: "node -e process.exit(3)", cwd: CWD })
    expect(r.exitCode).toBe(3)
  })

  test("an empty command → exitCode 1 (does not run anything)", async () => {
    expect((await liveExec({ command: "   ", cwd: CWD })).exitCode).toBe(1)
  })

  test("a non-existent binary → exitCode 1, never throws", async () => {
    const r = await liveExec({ command: "this-binary-does-not-exist-xyz", cwd: CWD })
    expect(r.exitCode).toBe(1)
  })

  test("drives runGateChecks end-to-end with real subprocesses", async () => {
    const g = await runGateChecks(
      [
        { id: "ok", command: "node -e process.exit(0)" },
        { id: "bad", command: "node -e process.exit(1)" },
      ],
      CWD,
      liveExec,
    )
    expect(g.passed.has("ok")).toBe(true)
    expect(g.passed.has("bad")).toBe(false)
    expect([...g.ran].sort()).toEqual(["bad", "ok"])
  })
})
