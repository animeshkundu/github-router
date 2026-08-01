import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  FIRST_MATE_GUARD_MATCHER,
  buildFirstMateGuardHookCommand,
} from "~/internal-first-mate-guard"
import { operatorPreToolUse } from "~/lib/first-mate/operator-shaping"
import { injectStopHookIntoSettingsFile } from "~/lib/orchestration/stop-gate-hook"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-guard-hook-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("operator PreToolUse hook wiring", () => {
  test("injects a PreToolUse hook scoped only to worker/orchestrate MCP tools", async () => {
    const settingsPath = path.join(dir, "settings.json")
    const command = buildFirstMateGuardHookCommand("/usr/bin/bun", "/app/main.ts")
    const merged = await injectStopHookIntoSettingsFile(
      settingsPath,
      command,
      "PreToolUse",
      undefined,
      FIRST_MATE_GUARD_MATCHER,
    )
    const serialized = JSON.stringify(merged)
    expect(serialized).toContain("PreToolUse")
    expect(serialized).toContain("internal-first-mate-guard")
    expect(FIRST_MATE_GUARD_MATCHER).toBe("mcp__workers__.*|mcp__orchestrate__.*")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("mcp__workers__")
    expect(FIRST_MATE_GUARD_MATCHER).toContain("mcp__orchestrate__")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("Bash")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("Edit")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("Write")
    expect(FIRST_MATE_GUARD_MATCHER).not.toContain("NotebookEdit")
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>
    expect(onDisk.hooks).toBeDefined()
  })
})

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const MAIN = path.join(REPO_ROOT, "src/main.ts")

async function runGuard(payload: string): Promise<number> {
  const proc = Bun.spawn(["bun", MAIN, "internal-first-mate-guard"], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(payload),
    stdout: "ignore",
    stderr: "ignore",
  })
  return proc.exited
}

describe("operator PreToolUse hook enforcement", () => {
  // Spawns SIX subprocesses. Run them concurrently, not in sequence: each guard
  // invocation is independent (its own process, no shared state), and six
  // sequential Windows process spawns under full-suite load is what pushed this
  // past a 20s budget twice. Concurrency turns six spawn latencies into roughly
  // one, which is a real fix rather than a larger number; the budget is raised
  // as well because the bound is an observation limit, not a correctness
  // assertion, and a tight one converts a busy machine into a red run.
  test("blocks direct worker/orchestrate MCP calls and allows Bash/Write", async () => {
    const [implement, review, runWorkflow, decompose, bash, write] = await Promise.all([
      runGuard(JSON.stringify({ tool_name: "mcp__workers__implement", tool_input: {} })),
      runGuard(JSON.stringify({ tool_name: "mcp__workers__review", tool_input: {} })),
      runGuard(JSON.stringify({ tool_name: "mcp__orchestrate__run_workflow", tool_input: {} })),
      runGuard(JSON.stringify({ tool_name: "mcp__orchestrate__decompose", tool_input: {} })),
      runGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo x > f" } })),
      runGuard(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x" } })),
    ])
    expect(implement).toBe(2)
    expect(review).toBe(2)
    expect(runWorkflow).toBe(2)
    expect(decompose).toBe(2)
    expect(bash).toBe(0)
    expect(write).toBe(0)
  }, 60_000)

  test("allows matching worker dispatcher agent types to call worker tools", () => {
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "worker-review" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__implement", true, { agent_type: "worker-implement" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__plan", true, { agent_type: "worker-plan" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__test", true, { agent_type: "worker-test" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__explore", true, { agent_type: "worker-explore" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__browse", true, { agent_type: "worker-browse" }).block).toBe(false)
  })

  test("blocks non-dispatcher agent types from worker tools", () => {
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "worker-plan" }).block).toBe(true)
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "general-purpose" }).block).toBe(true)
    expect(operatorPreToolUse("mcp__workers__review", true, {}).block).toBe(true)
  })

  test("fails closed on an unparseable payload routed to the guard", async () => {
    expect(await runGuard("not json{")).toBe(2)
  }, 60_000)
})
