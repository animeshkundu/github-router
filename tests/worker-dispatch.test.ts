import { describe, expect, test } from "bun:test"

import {
  ALL_DISPATCHER_AGENT_NAMES,
  ALL_WORKER_DISPATCH_MODES,
  activeDispatchModes,
  buildWorkerGuardHookCommand,
  CORE_WORKER_MODES,
  decideWorkerGuard,
  dispatcherAgentName,
  dispatcherDescription,
  dispatcherPrompt,
  dispatcherTools,
  guardToolMatcher,
  parseModesCsv,
  parseWorkerToolCall,
  workerToolName,
  type WorkerDispatchMode,
} from "../src/lib/worker-dispatch"

const KEY = "workers"
const CORE = [...CORE_WORKER_MODES]
const ALL = [...ALL_WORKER_DISPATCH_MODES]

function payload(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

describe("decideWorkerGuard — the main-never-blocks invariant", () => {
  test("main agent (no agent_type) calling a worker tool is DENIED with a worker-<mode> redirect", () => {
    for (const mode of ALL) {
      const r = decideWorkerGuard({
        stdin: payload({ tool_name: workerToolName(KEY, mode) }),
        workersKey: KEY,
        modes: ALL,
      })
      expect(r.verdict).toBe("deny-main")
      expect(r.output).not.toBeNull()
      const parsed = JSON.parse(r.output as string)
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse")
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(dispatcherAgentName(mode))
    }
  })

  test("a NON-dispatcher subagent calling a worker tool is DENIED (closes the transitive-blocking hole)", () => {
    for (const at of ["general-purpose", "codex-critic", "peer-review-coordinator", "some-teammate"]) {
      const r = decideWorkerGuard({
        stdin: payload({ tool_name: workerToolName(KEY, "review"), agent_type: at }),
        workersKey: KEY,
        modes: CORE,
      })
      expect(r.verdict).toBe("deny-main")
      expect(r.output).not.toBeNull()
    }
  })

  test("the matching worker-* dispatcher subagent is ALLOWED for every mode (its call is the sanctioned path)", () => {
    for (const mode of ALL) {
      const r = decideWorkerGuard({
        stdin: payload({ tool_name: workerToolName(KEY, mode), agent_type: dispatcherAgentName(mode) }),
        workersKey: KEY,
        modes: ALL,
      })
      expect(r.verdict).toBe("allow-dispatcher")
      expect(r.output).toBeNull()
    }
  })

  test("a dispatcher for a DIFFERENT mode is DENIED (exact mode-match; read-only can't invoke write)", () => {
    // worker-explore (read-only) must NOT be able to run the write-capable
    // implement worker even though its tools: wildcard technically allows it.
    const r = decideWorkerGuard({
      stdin: payload({ tool_name: workerToolName(KEY, "implement"), agent_type: "worker-explore" }),
      workersKey: KEY,
      modes: CORE,
    })
    expect(r.verdict).toBe("deny-main")
    expect(r.output).not.toBeNull()
  })

  test("a non-worker tool under the server is ALLOWED (never deny a tool with no dispatcher)", () => {
    // e.g. a hypothetical future non-blocking mcp__workers__status
    const r = decideWorkerGuard({
      stdin: payload({ tool_name: "mcp__workers__status" }),
      workersKey: KEY,
      modes: CORE,
    })
    expect(r.verdict).toBe("allow-non-worker")
    expect(r.output).toBeNull()
  })

  test("an unrelated tool is ALLOWED", () => {
    const r = decideWorkerGuard({
      stdin: payload({ tool_name: "mcp__search__code" }),
      workersKey: KEY,
      modes: CORE,
    })
    expect(r.verdict).toBe("allow-non-worker")
    expect(r.output).toBeNull()
  })

  test("FAILS CLOSED (deny) on malformed JSON — the matcher only routes worker calls here", () => {
    for (const bad of ["", "not json", "{", "[]", "null", "42"]) {
      const r = decideWorkerGuard({ stdin: bad, workersKey: KEY, modes: CORE })
      expect(r.verdict).toBe("deny-malformed")
      expect(r.output).not.toBeNull()
      const parsed = JSON.parse(r.output as string)
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
    }
  })

  test("FAILS CLOSED when tool_name is missing / non-string", () => {
    for (const p of [{ agent_type: "worker-explore" }, { tool_name: 42 }, { tool_name: null }]) {
      const r = decideWorkerGuard({ stdin: payload(p), workersKey: KEY, modes: CORE })
      expect(r.verdict).toBe("deny-malformed")
    }
  })

  test("resolved-key isolation: a guard for gh-router-workers only guards THAT server", () => {
    const rk = "gh-router-workers"
    // Renamed key: main call to the renamed server is denied.
    const denied = decideWorkerGuard({
      stdin: payload({ tool_name: `mcp__${rk}__explore` }),
      workersKey: rk,
      modes: CORE,
    })
    expect(denied.verdict).toBe("deny-main")
    // A call to the DEFAULT `workers` server (a different, user-owned server) is
    // not recognized by this guard → allowed.
    const other = decideWorkerGuard({
      stdin: payload({ tool_name: "mcp__workers__explore" }),
      workersKey: rk,
      modes: CORE,
    })
    expect(other.verdict).toBe("allow-non-worker")
  })

  test("browse mode: guarded only when active", () => {
    const withBrowse: ReadonlyArray<WorkerDispatchMode> = [...CORE, "browse"]
    const deny = decideWorkerGuard({
      stdin: payload({ tool_name: workerToolName(KEY, "browse") }),
      workersKey: KEY,
      modes: withBrowse,
    })
    expect(deny.verdict).toBe("deny-main")
    expect(JSON.parse(deny.output as string).hookSpecificOutput.permissionDecisionReason).toContain("worker-browse")
    const allow = decideWorkerGuard({
      stdin: payload({ tool_name: workerToolName(KEY, "browse"), agent_type: "worker-browse" }),
      workersKey: KEY,
      modes: withBrowse,
    })
    expect(allow.verdict).toBe("allow-dispatcher")
    // With browse NOT active, browse is not a recognized worker tool → allowed.
    const inactive = decideWorkerGuard({
      stdin: payload({ tool_name: workerToolName(KEY, "browse") }),
      workersKey: KEY,
      modes: CORE,
    })
    expect(inactive.verdict).toBe("allow-non-worker")
  })
})

describe("decideWorkerGuard — invariant table across spawn topologies", () => {
  // The formal encoding of "the main thread never blocks": allow ONLY when the
  // caller is a worker-* dispatcher; deny for main and every other subagent.
  const topologies: Array<{ label: string; agent_type?: string; expectAllow: boolean }> = [
    { label: "main (top-level)", agent_type: undefined, expectAllow: false },
    { label: "worker-* dispatcher", agent_type: "DISPATCHER", expectAllow: true },
    { label: "general-purpose subagent", agent_type: "general-purpose", expectAllow: false },
    { label: "peer critic subagent", agent_type: "codex-critic", expectAllow: false },
    { label: "agent-teams teammate", agent_type: "teammate-researcher", expectAllow: false },
  ]
  for (const mode of CORE) {
    for (const t of topologies) {
      test(`${mode} × ${t.label} → ${t.expectAllow ? "allow" : "deny"}`, () => {
        const agent_type = t.agent_type === "DISPATCHER" ? dispatcherAgentName(mode) : t.agent_type
        const obj: Record<string, unknown> = { tool_name: workerToolName(KEY, mode) }
        if (agent_type !== undefined) obj.agent_type = agent_type
        const r = decideWorkerGuard({ stdin: payload(obj), workersKey: KEY, modes: CORE })
        if (t.expectAllow) {
          expect(r.output).toBeNull()
        } else {
          expect(r.output).not.toBeNull()
          expect(JSON.parse(r.output as string).hookSpecificOutput.permissionDecision).toBe("deny")
        }
      })
    }
  }
})

describe("guardToolMatcher", () => {
  test("matches exactly the active worker tools, anchored", () => {
    const re = new RegExp(guardToolMatcher(KEY, CORE))
    for (const mode of CORE) expect(re.test(workerToolName(KEY, mode))).toBe(true)
    expect(re.test("mcp__workers__status")).toBe(false)
    expect(re.test("mcp__workers__browse")).toBe(false) // browse not active
    expect(re.test("mcp__workersX__explore")).toBe(false)
    expect(re.test("prefix mcp__workers__explore")).toBe(false) // anchored
    expect(re.test("mcp__workers__explore suffix")).toBe(false)
  })
  test("includes browse when active and escapes the key", () => {
    const re = new RegExp(guardToolMatcher("gh-router-workers", [...CORE, "browse"]))
    expect(re.test("mcp__gh-router-workers__browse")).toBe(true)
    expect(re.test("mcp__gh-router-workers__explore")).toBe(true)
    expect(re.test("mcp__workers__explore")).toBe(false)
  })
})

describe("parseWorkerToolCall", () => {
  test("parses the mode for the resolved key; null otherwise", () => {
    expect(parseWorkerToolCall("mcp__workers__plan", KEY, CORE)).toBe("plan")
    expect(parseWorkerToolCall("mcp__workers__status", KEY, CORE)).toBeNull()
    expect(parseWorkerToolCall("mcp__other__plan", KEY, CORE)).toBeNull()
    expect(parseWorkerToolCall("mcp__workers__browse", KEY, CORE)).toBeNull()
    expect(parseWorkerToolCall("mcp__workers__browse", KEY, [...CORE, "browse"])).toBe("browse")
  })
})

describe("buildWorkerGuardHookCommand", () => {
  test("bakes key + modes; distinct key ⇒ distinct command (dedup-safe)", () => {
    const invocation = { execPath: "/usr/bin/node", scriptPath: "/app/main.js" }
    const a = buildWorkerGuardHookCommand(invocation, "workers", CORE)
    const b = buildWorkerGuardHookCommand(invocation, "gh-router-workers", CORE)
    expect(a).toBe(
      '"/usr/bin/node" "/app/main.js" internal-worker-guard --workers-key "workers" --modes "explore,implement,review,plan,test"',
    )
    expect(b).toBe(
      '"/usr/bin/node" "/app/main.js" internal-worker-guard --workers-key "gh-router-workers" --modes "explore,implement,review,plan,test"',
    )
  })
  test("omits the scriptPath arg when it equals execPath (bundled single-file)", () => {
    const cmd = buildWorkerGuardHookCommand({ execPath: "/app/gh", scriptPath: "/app/gh" }, "workers", CORE)
    expect(cmd).toBe(
      '"/app/gh" internal-worker-guard --workers-key "workers" --modes "explore,implement,review,plan,test"',
    )
  })
})

describe("parseModesCsv / activeDispatchModes", () => {
  test("parseModesCsv drops unknown tokens and defaults to core", () => {
    expect(parseModesCsv("explore,test")).toEqual(["explore", "test"])
    expect(parseModesCsv("explore,bogus,browse")).toEqual(["explore", "browse"])
    expect(parseModesCsv("")).toEqual(CORE)
    expect(parseModesCsv(undefined)).toEqual(CORE)
    expect(parseModesCsv("nonsense")).toEqual(CORE)
  })
  test("activeDispatchModes adds browse only when enabled", () => {
    expect(activeDispatchModes({ browse: false })).toEqual(CORE)
    expect(activeDispatchModes({ browse: true })).toEqual([...CORE, "browse"])
  })
})

describe("dispatcher bodies", () => {
  test("names + tool allowlist are the workers server wildcard only", () => {
    expect(dispatcherAgentName("implement")).toBe("worker-implement")
    // Server-wildcard (Claude Code tools: supports MCP at server granularity):
    // grants workers tools only, so no Agent/Read/Bash (no recursion / extra work).
    expect(dispatcherTools("implement", KEY)).toEqual(["mcp__workers__*"])
    expect(dispatcherTools("explore", "gh-router-workers")).toEqual(["mcp__gh-router-workers__*"])
    // Every possible dispatcher name is a valid Claude Code agent name.
    for (const n of ALL_DISPATCHER_AGENT_NAMES) expect(/^[a-z][a-z0-9-]*$/.test(n)).toBe(true)
    expect(ALL_WORKER_DISPATCH_MODES.length).toBe(6)
  })
  test("prompt pins the single tool + the no-recursion / relay-verbatim rules", () => {
    const p = dispatcherPrompt("implement", KEY)
    expect(p).toContain("mcp__workers__implement")
    expect(p).toContain("EXACTLY ONCE")
    expect(p).toContain("VERBATIM")
    expect(p).toMatch(/do NOT spawn/i)
    // Worktree is not a relayed flag for implement/test — they ALWAYS run in a
    // worktree (enforced at the MCP boundary), so the dispatcher prompt must
    // NOT mention it (nothing for the dispatcher to pass through). `review` is
    // the exception: its isolation IS the caller's choice, so the dispatcher
    // has to know it can relay one.
    expect(p).not.toContain("worktree")
    expect(dispatcherPrompt("explore", KEY)).not.toContain("worktree")
    expect(dispatcherPrompt("review", KEY)).toContain("`worktree` (optional)")
  })

  test("every dispatcher is told to always pass its own workspace", () => {
    // The dispatcher is the ONLY caller the PreToolUse guard admits, and it is
    // the only party that knows where it is: the proxy is a separate
    // long-lived process, and the per-connection workspace header tracks the
    // session rather than the individual sub-agent. If the dispatcher stays
    // silent, a worker can run against a checkout that never held the files
    // the lead asked about.
    for (const mode of ALL_WORKER_DISPATCH_MODES) {
      const p = dispatcherPrompt(mode, KEY)
      expect(p).toContain("`workspace`: ALWAYS pass this")
      expect(p).toContain("your own current working")
    }
  })
  test("prompt names the correct required brief field for each worker tool", () => {
    const browse = dispatcherPrompt("browse", KEY)
    expect(browse).toContain("`task`: the lead's browse task, copied verbatim")
    expect(browse).not.toContain("`prompt`:")
    expect(browse).toContain("`sessionId`")

    for (const mode of ALL_WORKER_DISPATCH_MODES.filter((m) => m !== "browse")) {
      const p = dispatcherPrompt(mode, KEY)
      expect(p).toContain("`prompt`: the lead's worker brief, copied verbatim")
      expect(p).not.toContain("`task`:")
    }
  })
  test("description uses the auto-delegation idiom and states non-blocking", () => {
    const d = dispatcherDescription("review")
    expect(d).toContain("Use proactively")
    expect(d.toLowerCase()).toContain("background")
    expect(d).not.toContain("—") // global style: no em dashes
  })
})
