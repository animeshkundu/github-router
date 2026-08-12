// Pins the per-call `maxWallClockMs` handling in `runWorkerToolCall`
// (src/lib/peer-mcp-personas.ts): a caller-supplied override is validated as a
// positive integer, CLAMPED to the worker wall-clock ceiling (the injected MCP
// tool-call timeout minus the teardown headroom), threaded into the engine, and
// — when a larger value is clamped down — reported in the returned text so the
// caller is never silently overridden. Keeping the effective budget under the
// ceiling is what stops the harness from hard-killing a worker mid-run.
//
// Isolated because it mock.module()s the worker-agent index to stub
// runWorkerAgent (capture opts, no live model). The isolated/ directory runs
// one-process-per-file in CI so the module-scope mock can't bleed into the
// production-path suites.

import { beforeEach, describe, expect, mock, test } from "bun:test"

// Real constants (deep engine path is NOT mocked — only the index is) so the
// stubbed index re-exports the genuine values anything reading them expects.
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL_CHAIN,
} from "../../src/lib/worker-agent/engine"
import {
  MCP_TIMEOUT_HEADROOM_MS,
  resolveMcpToolTimeoutMs,
  workerWallClockCeilingMs,
} from "../../src/lib/worker-agent/budget"

interface Captured {
  mode: string
  prompt: string
  maxWallClockMs?: number
}
const runWorkerAgentCalls: Array<Captured> = []
let runWorkerAgentReturn: { text: string; isError?: boolean } = {
  text: "worker-done",
}

// Stub runWorkerAgent at the worker-agent index (what peer-mcp-personas
// imports). The clamp math lives in `worker-agent/budget` (a distinct module
// path, NOT mocked), so the real ceiling is exercised end-to-end.
mock.module("~/lib/worker-agent", () => ({
  DEFAULT_MODEL_CHAIN,
  BROWSE_DEFAULT_MODEL,
  runWorkerAgent: async (opts: Captured) => {
    runWorkerAgentCalls.push(opts)
    return runWorkerAgentReturn
  },
}))

// Dynamic import AFTER the mock is registered so the tool handlers close over
// the stubbed runWorkerAgent (static imports would hoist above mock.module).
const { NON_PERSONA_MCP_TOOLS } = await import(
  "../../src/lib/peer-mcp-personas"
)

type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>

function handlerFor(mode: string): ToolHandler {
  const tool = NON_PERSONA_MCP_TOOLS.find(
    (t) => t.group === "workers" && t.toolNameHttp === mode,
  )
  if (!tool?.handler) throw new Error(`workers/${mode} tool (or handler) missing`)
  return tool.handler as ToolHandler
}

beforeEach(() => {
  runWorkerAgentCalls.length = 0
  runWorkerAgentReturn = { text: "worker-done" }
})

describe("runWorkerToolCall maxWallClockMs clamp", () => {
  test("an override above the ceiling is clamped down and reported in the text", async () => {
    const huge = resolveMcpToolTimeoutMs() * 10
    const res = await handlerFor("explore")({ prompt: "hi", maxWallClockMs: huge })
    expect(runWorkerAgentCalls).toHaveLength(1)
    // Threaded value is the ceiling, NOT the caller's oversized request.
    expect(runWorkerAgentCalls[0]!.maxWallClockMs).toBe(workerWallClockCeilingMs())
    expect(res.isError).toBeFalsy()
    // The clamp note is prefixed to the worker's own output.
    expect(res.content[0]!.text).toContain("clamped")
    expect(res.content[0]!.text).toContain("worker-done")
  })

  test("an override at/below the ceiling is threaded through unchanged (no note)", async () => {
    const ms = 60_000
    const res = await handlerFor("implement")({ prompt: "hi", maxWallClockMs: ms })
    expect(runWorkerAgentCalls[0]!.maxWallClockMs).toBe(ms)
    expect(res.content[0]!.text).not.toContain("clamped")
    expect(res.content[0]!.text).toBe("worker-done")
  })

  test("omitting maxWallClockMs threads undefined (engine applies the default)", async () => {
    await handlerFor("explore")({ prompt: "hi" })
    expect(runWorkerAgentCalls[0]!.maxWallClockMs).toBeUndefined()
  })

  test("a non-positive-integer maxWallClockMs is rejected as isError, engine never invoked", async () => {
    const bads: Array<unknown> = [0, -5, 1.5, Number.NaN, "60000", true, null]
    for (const bad of bads) {
      runWorkerAgentCalls.length = 0
      const res = await handlerFor("test")({
        prompt: "hi",
        maxWallClockMs: bad as number,
      })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toContain("maxWallClockMs")
      expect(runWorkerAgentCalls).toHaveLength(0)
    }
  })

  test("the reported ceiling equals MCP tool-call timeout minus the teardown headroom", async () => {
    const huge = resolveMcpToolTimeoutMs() * 10
    const res = await handlerFor("explore")({ prompt: "hi", maxWallClockMs: huge })
    const ceiling = resolveMcpToolTimeoutMs() - MCP_TIMEOUT_HEADROOM_MS
    expect(res.content[0]!.text).toContain(String(ceiling))
  })
})
