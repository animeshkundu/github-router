// Pins the mandatory-worktree behavior in `runWorkerToolCall`
// (src/lib/peer-mcp-personas.ts): `implement`/`test` ALWAYS run in an isolated
// git worktree — the boundary forces `worktree: true` into the engine call
// regardless of the caller's arg (a caller `worktree: false` is overridden
// with a note), while read-only modes never set it. The `worktree` schema
// field is RETAINED (not removed) so a cached/older client still sending it
// doesn't hard-fail against `additionalProperties: false`.
//
// Isolated because it mock.module()s the worker-agent index to stub
// runWorkerAgent (capture opts, no live model).

import { beforeEach, describe, expect, mock, test } from "bun:test"

import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL,
} from "../../src/lib/worker-agent/engine"

interface Captured {
  mode: string
  prompt: string
  worktree?: boolean
}
const calls: Array<Captured> = []
let ret: { text: string; isError?: boolean } = { text: "worker-done" }

mock.module("~/lib/worker-agent", () => ({
  DEFAULT_MODEL,
  BROWSE_DEFAULT_MODEL,
  runWorkerAgent: async (opts: Captured) => {
    calls.push(opts)
    return ret
  },
}))

const { NON_PERSONA_MCP_TOOLS } = await import(
  "../../src/lib/peer-mcp-personas"
)

type ToolEntry = {
  group: string
  toolNameHttp: string
  inputSchema: { properties: Record<string, unknown> }
  handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>
}

function toolFor(mode: string): ToolEntry {
  const tool = NON_PERSONA_MCP_TOOLS.find(
    (t) => t.group === "workers" && t.toolNameHttp === mode,
  )
  if (!tool?.handler) throw new Error(`workers/${mode} tool (or handler) missing`)
  return tool as unknown as ToolEntry
}

beforeEach(() => {
  calls.length = 0
  ret = { text: "worker-done" }
})

describe("runWorkerToolCall mandatory worktree (implement/test)", () => {
  for (const mode of ["implement", "test"] as const) {
    test(`${mode}: no worktree arg still forces worktree:true`, async () => {
      await toolFor(mode).handler({ prompt: "do it" })
      expect(calls[0]!.worktree).toBe(true)
    })

    test(`${mode}: worktree:false is overridden to true with a note`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it", worktree: false })
      expect(calls[0]!.worktree).toBe(true)
      expect(res.content[0]!.text).toContain("always runs in an isolated git worktree")
      expect(res.content[0]!.text).toContain("worker-done")
    })

    test(`${mode}: worktree:true passes through with no note`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it", worktree: true })
      expect(calls[0]!.worktree).toBe(true)
      expect(res.content[0]!.text).toBe("worker-done")
    })

    test(`${mode}: a non-boolean worktree is rejected, engine never invoked`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it", worktree: "yes" })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toContain("worktree")
      expect(calls).toHaveLength(0)
    })

    test(`${mode}: retains the worktree field in its input schema (removal guard)`, () => {
      expect(toolFor(mode).inputSchema.properties).toHaveProperty("worktree")
    })
  }

  test("explore never sets worktree", async () => {
    await toolFor("explore").handler({ prompt: "look" })
    expect(calls[0]!.worktree).toBeUndefined()
  })
})
