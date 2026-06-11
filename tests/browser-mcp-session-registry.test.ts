/**
 * Tests for `src/lib/browser-mcp/session-registry.ts` plus the
 * session-enforcement path in `buildBrowseTools`.
 *
 * NO live browser: `closeBrowseSession` / `closeAllBrowseSessions` take an
 * injected dispatch, and `buildBrowseTools` takes a mock dispatch. Covers:
 *   - create / record / assert (incl. the foreign-tab + unknown-session throws)
 *   - release, browseSessionTabs, hasBrowseSession, browseSessionCount
 *   - the session cap (env-configurable) and its clear error
 *   - closeBrowseSession closing each owned tab via {tabIds:[id]} then dropping
 *   - process-exit handlers are registered, and the shutdown path closes all
 *   - buildBrowseTools WITHOUT sessionId is unchanged (no enforcement)
 *   - buildBrowseTools WITH sessionId: open_tab records, tab tools assert,
 *     close_tab releases, cross-session access is rejected before dispatch
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __testExports as registry,
  assertSessionOwnsTab,
  browseSessionCount,
  browseSessionTabs,
  acquireBrowseSession,
  closeBrowseSession,
  createBrowseSession,
  hasBrowseSession,
  recordSessionTab,
  releaseBrowseSession,
  releaseSessionTab,
  type CloseTabDispatch,
} from "../src/lib/browser-mcp/session-registry"
import {
  buildBrowseTools,
  type BrowserDispatch,
  type BrowserToolEnvelope,
} from "../src/lib/worker-agent/browse-tools"
import type { AgentTool } from "@earendil-works/pi-agent-core"

// ============================================================
// Fixtures
// ============================================================

const SAVED_MAX = process.env.GH_ROUTER_BROWSE_MAX_SESSIONS

beforeEach(() => {
  registry.reset()
  delete process.env.GH_ROUTER_BROWSE_MAX_SESSIONS
})

afterEach(() => {
  registry.reset()
  if (SAVED_MAX === undefined) delete process.env.GH_ROUTER_BROWSE_MAX_SESSIONS
  else process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = SAVED_MAX
})

interface DispatchCall {
  tool: string
  args: Record<string, unknown>
}

/** Recording mock for the browse-tools `BrowserDispatch`. */
function recordingDispatch(
  reply: (call: DispatchCall) => BrowserToolEnvelope,
): { dispatch: BrowserDispatch; calls: Array<DispatchCall> } {
  const calls: Array<DispatchCall> = []
  const dispatch: BrowserDispatch = async (tool, args) => {
    calls.push({ tool, args })
    return reply({ tool, args })
  }
  return { dispatch, calls }
}

function toolByName(tools: Array<AgentTool>, name: string): AgentTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool "${name}" not found`)
  return t
}

function okEnvelope(data: unknown): BrowserToolEnvelope {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

// ============================================================
// Registry core
// ============================================================

describe("session registry core", () => {
  test("create → unique id, registered, empty tab set", () => {
    const a = createBrowseSession()
    const b = createBrowseSession()
    expect(a).not.toBe(b)
    expect(hasBrowseSession(a)).toBe(true)
    expect(hasBrowseSession(b)).toBe(true)
    expect(browseSessionCount()).toBe(2)
    expect(browseSessionTabs(a)).toEqual([])
  })

  test("record + browseSessionTabs reflect ownership", () => {
    const s = createBrowseSession()
    recordSessionTab(s, 11)
    recordSessionTab(s, 22)
    recordSessionTab(s, 11) // idempotent (Set)
    expect(browseSessionTabs(s).sort((x, y) => x - y)).toEqual([11, 22])
  })

  test("assertSessionOwnsTab passes for owned, throws for foreign tab", () => {
    const s = createBrowseSession()
    recordSessionTab(s, 5)
    expect(() => assertSessionOwnsTab(s, 5)).not.toThrow()
    expect(() => assertSessionOwnsTab(s, 99)).toThrow("tab 99 not owned by session")
  })

  test("foreign tab from ANOTHER session is rejected (no-mixup)", () => {
    const s1 = createBrowseSession()
    const s2 = createBrowseSession()
    recordSessionTab(s1, 7)
    // s2 must not be able to touch s1's tab.
    expect(() => assertSessionOwnsTab(s2, 7)).toThrow("tab 7 not owned by session")
  })

  test("record / assert throw on unknown session", () => {
    expect(() => recordSessionTab("nope", 1)).toThrow('unknown browse session "nope"')
    expect(() => assertSessionOwnsTab("nope", 1)).toThrow('unknown browse session "nope"')
  })

  test("release drops the tab; releasing unknown session/tab is a no-op", () => {
    const s = createBrowseSession()
    recordSessionTab(s, 3)
    releaseSessionTab(s, 3)
    expect(browseSessionTabs(s)).toEqual([])
    expect(() => releaseSessionTab("nope", 1)).not.toThrow()
    expect(() => releaseSessionTab(s, 12345)).not.toThrow()
  })
})

// ============================================================
// Session cap
// ============================================================

describe("session cap", () => {
  test("at the cap, a new create evicts the LRU idle session (no throw)", () => {
    const first = createBrowseSession()
    for (let i = 0; i < 5; i++) createBrowseSession()
    expect(browseSessionCount()).toBe(6)
    // 7th create: oldest idle (`first`) is evicted to make room; count holds.
    const seventh = createBrowseSession()
    expect(browseSessionCount()).toBe(6)
    expect(hasBrowseSession(first)).toBe(false)
    expect(hasBrowseSession(seventh)).toBe(true)
  })

  test("evicts the LEAST-RECENTLY-USED idle session, not just the oldest", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "2"
    const a = createBrowseSession()
    const b = createBrowseSession()
    // Touch `a` so it's more recently used than `b` despite being older.
    acquireBrowseSession(a)
    releaseBrowseSession(a)
    const c = createBrowseSession()
    expect(hasBrowseSession(a)).toBe(true) // recently used → survives
    expect(hasBrowseSession(b)).toBe(false) // LRU → evicted
    expect(hasBrowseSession(c)).toBe(true)
  })

  test("never evicts an in-flight session; throws when all are in use", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "2"
    const a = createBrowseSession()
    const b = createBrowseSession()
    acquireBrowseSession(a)
    acquireBrowseSession(b)
    // Both in-flight → no idle victim → genuine backpressure.
    expect(() => createBrowseSession()).toThrow(
      "browse session cap reached (2 active, all in use)",
    )
    // Releasing one makes it evictable again.
    releaseBrowseSession(a)
    const c = createBrowseSession()
    expect(hasBrowseSession(a)).toBe(false) // released → evicted
    expect(hasBrowseSession(b)).toBe(true) // still in-flight → kept
    expect(hasBrowseSession(c)).toBe(true)
  })

  test("a ref-counted session stays in-flight until the last release", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "1"
    const a = createBrowseSession()
    acquireBrowseSession(a)
    acquireBrowseSession(a) // two concurrent drivers
    releaseBrowseSession(a) // one finishes; still in-flight
    expect(() => createBrowseSession()).toThrow("all in use")
    releaseBrowseSession(a) // last finishes; now idle
    expect(() => createBrowseSession()).not.toThrow()
    expect(hasBrowseSession(a)).toBe(false)
  })

  test("GH_ROUTER_BROWSE_MAX_SESSIONS sizes the cap", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "2"
    createBrowseSession()
    createBrowseSession()
    createBrowseSession() // evicts LRU idle rather than growing past 2
    expect(browseSessionCount()).toBe(2)
  })

  test("invalid env value falls back to the default", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "garbage"
    expect(registry.maxSessions()).toBe(6)
  })

  test("closing a session frees a cap slot", () => {
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "1"
    const s = createBrowseSession()
    acquireBrowseSession(s) // in-flight → next create can't evict it
    expect(() => createBrowseSession()).toThrow("all in use")
    return closeBrowseSession(s, async () => okEnvelope({ closed: 1 })).then(() => {
      expect(browseSessionCount()).toBe(0)
      expect(() => createBrowseSession()).not.toThrow()
    })
  })

  test("acquire/release on an unknown session id is a safe no-op (no orphan tracking)", () => {
    acquireBrowseSession("ghost")
    releaseBrowseSession("ghost")
    expect(hasBrowseSession("ghost")).toBe(false)
    expect(browseSessionCount()).toBe(0)
    // The ghost id never occupies or protects a slot: at the cap the next
    // create still evicts a REAL idle session, unaffected by the ghost.
    process.env.GH_ROUTER_BROWSE_MAX_SESSIONS = "1"
    const a = createBrowseSession()
    acquireBrowseSession("ghost") // still a no-op
    const b = createBrowseSession() // evicts the only idle real session (a)
    expect(hasBrowseSession(a)).toBe(false)
    expect(hasBrowseSession(b)).toBe(true)
    expect(browseSessionCount()).toBe(1)
  })
})

// ============================================================
// closeBrowseSession
// ============================================================

describe("closeBrowseSession", () => {
  test("closes each owned tab via {tabIds:[id]} then drops the session", async () => {
    const s = createBrowseSession()
    recordSessionTab(s, 1)
    recordSessionTab(s, 2)
    const calls: Array<Record<string, unknown>> = []
    const dispatch: CloseTabDispatch = async (tool, args) => {
      calls.push({ tool, ...args })
      return okEnvelope({ closed: 1 })
    }
    await closeBrowseSession(s, dispatch)
    expect(calls).toEqual([
      { tool: "browser_close_tab", tabIds: [1] },
      { tool: "browser_close_tab", tabIds: [2] },
    ])
    expect(hasBrowseSession(s)).toBe(false)
  })

  test("swallows per-tab close errors and still drops the session", async () => {
    const s = createBrowseSession()
    recordSessionTab(s, 1)
    recordSessionTab(s, 2)
    let n = 0
    const dispatch: CloseTabDispatch = async () => {
      n++
      throw new Error("tab already gone")
    }
    await closeBrowseSession(s, dispatch)
    expect(n).toBe(2) // attempted both despite the first throwing
    expect(hasBrowseSession(s)).toBe(false)
  })

  test("unknown session is a no-op", async () => {
    let called = false
    await closeBrowseSession("nope", async () => {
      called = true
      return okEnvelope({})
    })
    expect(called).toBe(false)
  })
})

// ============================================================
// Shutdown handlers
// ============================================================

describe("process-exit handlers", () => {
  test("SIGINT/SIGTERM/exit handlers are registered", () => {
    expect(process.listeners("SIGINT")).toContain(registry.sigintHandler)
    expect(process.listeners("SIGTERM")).toContain(registry.sigtermHandler)
    expect(process.listeners("exit")).toContain(registry.exitHandler)
  })

  test("closeAllBrowseSessions closes every session's tabs", async () => {
    const s1 = createBrowseSession()
    const s2 = createBrowseSession()
    recordSessionTab(s1, 10)
    recordSessionTab(s2, 20)
    const closed: Array<number> = []
    const dispatch: CloseTabDispatch = async (_tool, args) => {
      for (const id of args.tabIds as Array<number>) closed.push(id)
      return okEnvelope({ closed: 1 })
    }
    await registry.closeAllBrowseSessions(dispatch)
    expect(closed.sort((a, b) => a - b)).toEqual([10, 20])
    expect(browseSessionCount()).toBe(0)
  })

  test("exit handler clears the in-memory map (sync)", () => {
    createBrowseSession()
    expect(browseSessionCount()).toBe(1)
    registry.exitHandler()
    expect(browseSessionCount()).toBe(0)
  })
})

// ============================================================
// buildBrowseTools WITHOUT sessionId — unchanged
// ============================================================

describe("buildBrowseTools without sessionId (backward-compatible)", () => {
  test("no enforcement: any tabId dispatches, no session touched", async () => {
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ ok: true }))
    const tools = buildBrowseTools({ dispatch })
    // A tabId never recorded anywhere still dispatches fine.
    await toolByName(tools, "read_page").execute("c", { tabId: 4242 }, undefined)
    expect(calls[0]!.tool).toBe("browser_read_page")
    expect(calls[0]!.args).toEqual({ tabId: 4242 })
    expect(browseSessionCount()).toBe(0)
  })

  test("open_tab does NOT record a session when sessionId is absent", async () => {
    const { dispatch } = recordingDispatch(() => okEnvelope({ tabId: 9, finalUrl: "x" }))
    const tools = buildBrowseTools({ dispatch })
    await toolByName(tools, "open_tab").execute("c", { url: "http://x" }, undefined)
    expect(browseSessionCount()).toBe(0)
  })
})

// ============================================================
// buildBrowseTools WITH sessionId — enforcement
// ============================================================

describe("buildBrowseTools with sessionId (enforcement)", () => {
  test("open_tab records the returned tabId on success", async () => {
    const sessionId = createBrowseSession()
    const { dispatch } = recordingDispatch(() =>
      okEnvelope({ tabId: 31, finalUrl: "http://x", statusCode: 200 }),
    )
    const tools = buildBrowseTools({ dispatch, sessionId })
    await toolByName(tools, "open_tab").execute("c", { url: "http://x" }, undefined)
    expect(browseSessionTabs(sessionId)).toEqual([31])
  })

  test("a tab tool asserts ownership BEFORE dispatch (foreign tab rejected, no call)", async () => {
    const sessionId = createBrowseSession()
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ ok: true }))
    const tools = buildBrowseTools({ dispatch, sessionId })
    // Tab 77 was never opened by this session.
    await expect(
      toolByName(tools, "click").execute("c", { tabId: 77, ref: "e1" }, undefined),
    ).rejects.toThrow("tab 77 not owned by session")
    expect(calls).toHaveLength(0) // rejected before any browser side effect
  })

  test("end-to-end: open then use the owned tab is allowed", async () => {
    const sessionId = createBrowseSession()
    const { dispatch, calls } = recordingDispatch((call) =>
      call.tool === "browser_open_tab"
        ? okEnvelope({ tabId: 50, finalUrl: "http://x", statusCode: 200 })
        : okEnvelope({ ok: true }),
    )
    const tools = buildBrowseTools({ dispatch, sessionId })
    await toolByName(tools, "open_tab").execute("c", { url: "http://x" }, undefined)
    // Now reading tab 50 is permitted.
    await toolByName(tools, "read_page").execute("c", { tabId: 50 }, undefined)
    expect(calls.map((c) => c.tool)).toEqual(["browser_open_tab", "browser_read_page"])
  })

  test("cross-session isolation: session B cannot drive session A's tab", async () => {
    const a = createBrowseSession()
    const b = createBrowseSession()
    const { dispatch } = recordingDispatch((call) =>
      call.tool === "browser_open_tab"
        ? okEnvelope({ tabId: 60, finalUrl: "http://x", statusCode: 200 })
        : okEnvelope({ ok: true }),
    )
    const toolsA = buildBrowseTools({ dispatch, sessionId: a })
    const toolsB = buildBrowseTools({ dispatch, sessionId: b })
    await toolByName(toolsA, "open_tab").execute("c", { url: "http://x" }, undefined)
    // A owns 60; B must be rejected.
    await expect(
      toolByName(toolsB, "navigate").execute("c", { tabId: 60, action: "reload" }, undefined),
    ).rejects.toThrow("tab 60 not owned by session")
    // A is fine.
    await expect(
      toolByName(toolsA, "navigate").execute("c", { tabId: 60, action: "reload" }, undefined),
    ).resolves.toBeDefined()
  })

  test("close_tab asserts ownership of each tabId, then releases them", async () => {
    const sessionId = createBrowseSession()
    recordSessionTab(sessionId, 70)
    recordSessionTab(sessionId, 71)
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ closed: 2 }))
    const tools = buildBrowseTools({ dispatch, sessionId })
    await toolByName(tools, "close_tab").execute("c", { tabIds: [70, 71] }, undefined)
    expect(calls[0]!.tool).toBe("browser_close_tab")
    expect(browseSessionTabs(sessionId)).toEqual([])
  })

  test("close_tab rejects (before dispatch) if any tabId isn't owned", async () => {
    const sessionId = createBrowseSession()
    recordSessionTab(sessionId, 70)
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ closed: 1 }))
    const tools = buildBrowseTools({ dispatch, sessionId })
    await expect(
      toolByName(tools, "close_tab").execute("c", { tabIds: [70, 999] }, undefined),
    ).rejects.toThrow("tab 999 not owned by session")
    expect(calls).toHaveLength(0)
    // 70 is still owned — the rejected call had no side effect.
    expect(browseSessionTabs(sessionId)).toEqual([70])
  })

  test("open_tab does NOT record when dispatch returns an error envelope", async () => {
    const sessionId = createBrowseSession()
    const { dispatch } = recordingDispatch(() => ({
      content: [{ type: "text", text: JSON.stringify({ blocked: true }) }],
      isError: true,
    }))
    const tools = buildBrowseTools({ dispatch, sessionId })
    await expect(
      toolByName(tools, "open_tab").execute("c", { url: "chrome://settings" }, undefined),
    ).rejects.toThrow()
    expect(browseSessionTabs(sessionId)).toEqual([])
  })

  test("open_tab with reuseActive is rejected in session mode (before dispatch)", async () => {
    const sessionId = createBrowseSession()
    const { dispatch, calls } = recordingDispatch(() =>
      okEnvelope({ tabId: 80, finalUrl: "http://x", statusCode: 200 }),
    )
    const tools = buildBrowseTools({ dispatch, sessionId })
    await expect(
      toolByName(tools, "open_tab").execute(
        "c",
        { url: "http://x", reuseActive: true },
        undefined,
      ),
    ).rejects.toThrow("reuseActive is disabled")
    expect(calls).toHaveLength(0)
    expect(browseSessionTabs(sessionId)).toEqual([])
  })

  test("reuseActive IS allowed when no sessionId (Gate B unchanged)", async () => {
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ tabId: 1 }))
    const tools = buildBrowseTools({ dispatch })
    await toolByName(tools, "open_tab").execute(
      "c",
      { url: "http://x", reuseActive: true },
      undefined,
    )
    expect(calls).toHaveLength(1)
  })

  test("uses-tool fails CLOSED when tabId is missing/non-numeric in session mode", async () => {
    const sessionId = createBrowseSession()
    const { dispatch, calls } = recordingDispatch(() => okEnvelope({ ok: true }))
    const tools = buildBrowseTools({ dispatch, sessionId })
    await expect(
      toolByName(tools, "read_page").execute("c", {}, undefined),
    ).rejects.toThrow("a valid tabId is required")
    expect(calls).toHaveLength(0)
  })
})

// ============================================================
// Global exclusivity (reverse ownership index)
// ============================================================

describe("global exclusivity", () => {
  test("re-recording a recycled tabId transfers ownership away from the stale session", () => {
    const a = createBrowseSession()
    const b = createBrowseSession()
    recordSessionTab(a, 100)
    expect(browseSessionTabs(a)).toEqual([100])
    // Chrome recycles id 100 for B's new tab.
    recordSessionTab(b, 100)
    expect(browseSessionTabs(b)).toEqual([100])
    // A no longer owns it — no duplicate ownership.
    expect(browseSessionTabs(a)).toEqual([])
    expect(() => assertSessionOwnsTab(a, 100)).toThrow("not owned by session")
    expect(() => assertSessionOwnsTab(b, 100)).not.toThrow()
  })

  test("releasing a transferred tab does not clobber the new owner", () => {
    const a = createBrowseSession()
    const b = createBrowseSession()
    recordSessionTab(a, 100)
    recordSessionTab(b, 100) // transfer A→B
    releaseSessionTab(a, 100) // stale release from A must be a no-op for B
    expect(() => assertSessionOwnsTab(b, 100)).not.toThrow()
  })

  test("end-to-end: open in session B after A's tab id is recycled keeps B exclusive", async () => {
    const a = createBrowseSession()
    const b = createBrowseSession()
    recordSessionTab(a, 200)
    const { dispatch } = recordingDispatch(() =>
      okEnvelope({ tabId: 200, finalUrl: "http://x", statusCode: 200 }),
    )
    const toolsB = buildBrowseTools({ dispatch, sessionId: b })
    await toolByName(toolsB, "open_tab").execute("c", { url: "http://x" }, undefined)
    expect(browseSessionTabs(b)).toEqual([200])
    expect(browseSessionTabs(a)).toEqual([])
  })
})
