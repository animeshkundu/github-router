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
  DEFAULT_MODEL_CHAIN,
} from "../../src/lib/worker-agent/engine"

interface Captured {
  mode: string
  prompt: string
  worktree?: boolean
  workspace?: string
}
const calls: Array<Captured> = []
let ret: { text: string; isError?: boolean } = { text: "worker-done" }

mock.module("~/lib/worker-agent", () => ({
  DEFAULT_MODEL_CHAIN,
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
    ctx?: { workspaceSource: "argument" | "session" | "absent" },
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

/** Every call needs a workspace: the boundary refuses to guess one. Passing it
 *  explicitly also keeps these assertions about the worktree flag alone. */
const WS = process.cwd()

describe("runWorkerToolCall mandatory worktree (implement/test)", () => {
  for (const mode of ["implement", "test"] as const) {
    test(`${mode}: no worktree arg still forces worktree:true`, async () => {
      await toolFor(mode).handler({ prompt: "do it", workspace: WS })
      expect(calls[0]!.worktree).toBe(true)
    })

    test(`${mode}: worktree:false is overridden to true with a note`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it", worktree: false, workspace: WS })
      expect(calls[0]!.worktree).toBe(true)
      expect(res.content[0]!.text).toContain("always runs in an isolated git worktree")
      expect(res.content[0]!.text).toContain("worker-done")
    })

    test(`${mode}: worktree:true passes through with no note`, async () => {
      const res = await toolFor(mode).handler(
        { prompt: "do it", worktree: true, workspace: WS },
        undefined,
        { workspaceSource: "argument" },
      )
      expect(calls[0]!.worktree).toBe(true)
      expect(res.content[0]!.text).toBe("worker-done")
    })

    test(`${mode}: a non-boolean worktree is rejected, engine never invoked`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it", worktree: "yes", workspace: WS })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toContain("worktree")
      expect(calls).toHaveLength(0)
    })

    test(`${mode}: retains the worktree field in its input schema (removal guard)`, () => {
      expect(toolFor(mode).inputSchema.properties).toHaveProperty("worktree")
    })
  }

  test("explore never sets worktree", async () => {
    await toolFor("explore").handler({ prompt: "look", workspace: WS })
    expect(calls[0]!.worktree).toBeUndefined()
  })
})

// `review` is the one mode whose isolation is the CALLER's choice. The engine
// and `buildWorkerTools` always supported an isolated review (it is what
// unlocks edit/write so the reviewer can author a probe test), but nothing ever
// set the flag, so the path was unreachable while the `worker-review` subagent
// description advertised it. These pin the flag actually arriving.
describe("runWorkerToolCall opt-in worktree (review)", () => {
  test("review defaults to NO worktree", async () => {
    await toolFor("review").handler({ prompt: "check it", workspace: WS })
    expect(calls[0]!.worktree).toBeUndefined()
  })

  test("review with worktree:true forwards the flag to the engine", async () => {
    await toolFor("review").handler({ prompt: "check it", worktree: true, workspace: WS })
    expect(calls[0]!.worktree).toBe(true)
  })

  test("review with worktree:false stays in place and emits no override note", async () => {
    const res = await toolFor("review").handler(
      { prompt: "check it", worktree: false, workspace: WS },
      undefined,
      { workspaceSource: "argument" },
    )
    expect(calls[0]!.worktree).toBeUndefined()
    expect(res.content[0]!.text).toBe("worker-done")
  })

  test("review rejects a non-boolean worktree, engine never invoked", async () => {
    const res = await toolFor("review").handler({ prompt: "check it", worktree: 1, workspace: WS })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("review advertises the worktree field in its input schema", () => {
    expect(toolFor("review").inputSchema.properties).toHaveProperty("worktree")
  })
})
