/**
 * In-memory browse-session registry — tab-ownership over a SHARED Chrome
 * profile, so multiple browse agents can drive the ONE real browser in
 * parallel without stepping on each other's tabs.
 *
 * v1 model (smallest-first): a session is just a set of tab ids it owns.
 * CDP browser-context isolation is NOT reachable from an MV3 per-tab
 * `chrome.debugger` attachment (confirmed), so true profile isolation is
 * out of scope; tab-ownership is the enforceable boundary. Every browse
 * tool that touches a `tabId` checks ownership (`assertSessionOwnsTab`)
 * before dispatch — that assertion is the no-mixup guarantee.
 *
 * State: a single module-level `Map<sessionId, Set<tabId>>`. No other
 * mutable module state (the signal-handler function refs are `const`).
 * Session ids come from `node:crypto` `randomUUID` — NOT `Math.random` /
 * `Date.now`, which throw in some execution contexts here.
 *
 * Lifecycle: SIGINT / SIGTERM / exit handlers (registered once at module
 * load, mirroring `worker-agent/lifecycle.ts`) best-effort close every
 * session's tabs. Tab-close is async (a WS round-trip to the bridge), so:
 *   - SIGINT/SIGTERM fire the async close (fire-and-forget) then re-raise
 *     the signal so the process still terminates with the conventional
 *     `128 + signum` code;
 *   - `exit` can only run sync code, so it just drops the in-memory map
 *     (leftover browser tabs are cosmetic — the browser outlives the proxy
 *     and the user can close them; nothing leaks inside the proxy).
 */

import { randomUUID } from "node:crypto"
import process from "node:process"

import { dispatchBrowserTool } from "./dispatch"

// ============================================================
// Types + config
// ============================================================

/**
 * Minimal dispatcher shape `closeBrowseSession` needs. Declared locally
 * (not imported from `worker-agent/browse-tools`) so the dependency edge
 * stays one-way: `browse-tools` → `session-registry` → `dispatch`.
 * `dispatchBrowserTool`'s richer signature is assignable to this.
 */
export type CloseTabDispatch = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>

const DEFAULT_MAX_SESSIONS = 6

/** Cap on concurrent browse sessions. Env override; sane default. */
function maxSessions(): number {
  const raw = process.env.GH_ROUTER_BROWSE_MAX_SESSIONS
  // Strict digits only — `"6junk"` must NOT parse to 6 (sloppy config
  // shouldn't silently widen the cap); fall back to the default instead.
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    const n = Number.parseInt(raw.trim(), 10)
    if (n > 0) return n
  }
  return DEFAULT_MAX_SESSIONS
}

// ============================================================
// Registry state
// ============================================================

/** sessionId → set of tab ids the session owns. */
const sessions = new Map<string, Set<number>>()

/**
 * tabId → owning sessionId. The authoritative reverse index that makes
 * ownership GLOBALLY EXCLUSIVE: a tab is owned by at most one session.
 * Chrome can recycle a numeric tab id after a tab closes, and a session
 * may fail to release a tab it lost (crash, close failure). Without this
 * map, a recycled id could end up in two sessions' sets at once — a silent
 * no-mixup violation. `recordSessionTab` transfers ownership (steals the
 * stale entry) so the live owner is always the last recorder.
 */
const tabOwners = new Map<number, string>()

/**
 * sessionId → number of in-flight browse runs currently driving it. A session
 * is "in use" (never evictable) while this is > 0. Ref-counted so a session
 * continued by two concurrent calls isn't freed when the first finishes.
 * Absent ⇒ 0. The cap-eviction (`lruIdleSession`) skips any session in here.
 */
const inFlight = new Map<string, number>()

/**
 * sessionId → monotonic last-use sequence (NOT a wall-clock — `Date.now`
 * throws in some contexts here). Bumped on create and on every
 * `acquireBrowseSession`, so the cap victim is the least-recently-DRIVEN idle
 * session, not merely the oldest-created.
 */
const lastUsedSeq = new Map<string, number>()
let useSeq = 0

function touchSession(sessionId: string): void {
  lastUsedSeq.set(sessionId, ++useSeq)
}

// ============================================================
// Session lifecycle
// ============================================================

/**
 * Create a new browse session and return its id. At the
 * `GH_ROUTER_BROWSE_MAX_SESSIONS` cap, evict the least-recently-used IDLE
 * session to make room (persistent-session + LRU-evict policy) rather than
 * failing the call. Only sessions with NO in-flight run are evictable, so a
 * session a parallel browse call is actively driving is never torn out. When
 * every session is in-flight there is nothing safe to evict — that is genuine
 * backpressure, so we throw (the caller surfaces it as an actionable error).
 */
export function createBrowseSession(): string {
  const cap = maxSessions()
  if (sessions.size >= cap) {
    const victim = lruIdleSession()
    if (victim === undefined) {
      throw new Error(
        `browse session cap reached (${cap} active, all in use); retry when a `
          + "session frees, or raise GH_ROUTER_BROWSE_MAX_SESSIONS.",
      )
    }
    evictForCapacity(victim)
  }
  const id = randomUUID()
  sessions.set(id, new Set<number>())
  touchSession(id)
  return id
}

/**
 * The least-recently-used session with no in-flight run, or `undefined` when
 * every session is currently being driven. Picks the idle entry with the
 * smallest last-use sequence.
 */
function lruIdleSession(): string | undefined {
  let victim: string | undefined
  let victimSeq = Number.POSITIVE_INFINITY
  for (const id of sessions.keys()) {
    if ((inFlight.get(id) ?? 0) > 0) continue
    const seq = lastUsedSeq.get(id) ?? 0
    if (seq < victimSeq) {
      victimSeq = seq
      victim = id
    }
  }
  return victim
}

/**
 * Synchronously evict `sessionId` to free a cap slot: drop it from the
 * registry NOW (so the slot is free before the caller's `sessions.set`, with
 * no `await` in between — keeps create race-free under concurrent calls),
 * then best-effort close its tabs in the background. The victim is always
 * idle (see `lruIdleSession`), so no in-flight run can be reading its tabs.
 */
function evictForCapacity(sessionId: string): void {
  const set = sessions.get(sessionId)
  if (!set) return
  const tabIds = [...set]
  sessions.delete(sessionId)
  for (const tabId of tabIds) {
    if (tabOwners.get(tabId) === sessionId) tabOwners.delete(tabId)
  }
  inFlight.delete(sessionId)
  lastUsedSeq.delete(sessionId)
  if (tabIds.length > 0) void closeTabsBestEffort(tabIds)
}

/** Best-effort background tab close for an evicted session; never throws. */
async function closeTabsBestEffort(tabIds: Array<number>): Promise<void> {
  for (const tabId of tabIds) {
    try {
      await dispatchBrowserTool("browser_close_tab", { tabIds: [tabId] })
    } catch {
      /* best-effort: an orphaned browser tab is cosmetic; the slot is freed */
    }
  }
}

/**
 * Mark a browse session as in-flight (a run is actively driving it) so
 * cap-eviction can't reclaim it. Ref-counted. The caller MUST invoke this
 * SYNCHRONOUSLY right after resolving the session id — with no `await` between
 * resolution and acquisition — so a concurrent `createBrowseSession` can't
 * evict the just-resolved session in the gap. Pair with `releaseBrowseSession`
 * in a `finally`. A no-op-safe touch keeps the LRU order fresh.
 */
export function acquireBrowseSession(sessionId: string): void {
  // Guard against orphan tracking entries: an unknown id (misuse, or a
  // session evicted out from under a caller) must NOT seed `inFlight` /
  // `lastUsedSeq`, since `lruIdleSession`/`evictForCapacity` only walk live
  // `sessions` keys and would never reclaim those orphans.
  if (!sessions.has(sessionId)) return
  inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1)
  touchSession(sessionId)
}

/** Release one in-flight hold; the session is evictable again at 0. */
export function releaseBrowseSession(sessionId: string): void {
  const n = inFlight.get(sessionId) ?? 0
  if (n <= 1) inFlight.delete(sessionId)
  else inFlight.set(sessionId, n - 1)
}

/** True iff `sessionId` is a live session. */
export function hasBrowseSession(sessionId: string): boolean {
  return sessions.has(sessionId)
}

/** Number of live sessions. */
export function browseSessionCount(): number {
  return sessions.size
}

/** The tab ids `sessionId` currently owns (empty array if unknown session). */
export function browseSessionTabs(sessionId: string): Array<number> {
  const set = sessions.get(sessionId)
  return set ? [...set] : []
}

// ============================================================
// Tab ownership
// ============================================================

/**
 * Record `tabId` as owned by `sessionId` (called after a successful
 * `open_tab`). Throws if the session is unknown — recording a tab against
 * a session that doesn't exist is a logic error the caller must see.
 *
 * Enforces global exclusivity: if `tabId` is currently owned by a DIFFERENT
 * session (a recycled Chrome id, or a stale entry the old owner never
 * released), ownership is transferred — the stale owner loses it, because
 * its tab with that id is provably gone (Chrome ids are unique among live
 * tabs, and `reuseActive` is barred in session mode, so a fresh `open_tab`
 * can only see a recycled id).
 */
export function recordSessionTab(sessionId: string, tabId: number): void {
  const set = sessions.get(sessionId)
  if (!set) {
    throw new Error(`unknown browse session "${sessionId}"`)
  }
  const prevOwner = tabOwners.get(tabId)
  if (prevOwner !== undefined && prevOwner !== sessionId) {
    sessions.get(prevOwner)?.delete(tabId)
  }
  set.add(tabId)
  tabOwners.set(tabId, sessionId)
}

/**
 * The no-mixup guard. Throws unless `sessionId` owns `tabId`. Every browse
 * tool that takes a tab argument runs this BEFORE dispatch, so a session
 * can never act on another session's (or an unopened) tab.
 */
export function assertSessionOwnsTab(sessionId: string, tabId: number): void {
  const set = sessions.get(sessionId)
  if (!set) {
    throw new Error(`unknown browse session "${sessionId}"`)
  }
  if (!set.has(tabId)) {
    throw new Error(`tab ${tabId} not owned by session ${sessionId}`)
  }
}

/**
 * Drop `tabId` from `sessionId`'s ownership (called after a successful
 * `close_tab`). Best-effort: a no-op for an unknown session or an
 * already-released tab. Clears the reverse index only if this session still
 * holds the tab (so a concurrent transfer isn't clobbered).
 */
export function releaseSessionTab(sessionId: string, tabId: number): void {
  const set = sessions.get(sessionId)
  if (set?.delete(tabId) && tabOwners.get(tabId) === sessionId) {
    tabOwners.delete(tabId)
  }
}

// ============================================================
// Teardown
// ============================================================

/**
 * Close every tab `sessionId` owns, then drop the session. Best-effort:
 * tabs are closed one at a time so one dead/invalid tab can't strand the
 * rest, and per-tab errors are swallowed. The session is removed even if
 * closing fails, so the cap slot is always freed. No-op for an unknown
 * session.
 *
 * `dispatch` is injectable for tests; production uses `dispatchBrowserTool`.
 */
export async function closeBrowseSession(
  sessionId: string,
  dispatch: CloseTabDispatch = dispatchBrowserTool,
): Promise<void> {
  const set = sessions.get(sessionId)
  if (!set) return
  const tabIds = [...set]
  try {
    for (const tabId of tabIds) {
      try {
        // Wire schema is `{ tabIds: number[] }` (plural) — one tab per call
        // so a single invalid id doesn't reject the whole batch.
        await dispatch("browser_close_tab", { tabIds: [tabId] })
      } catch {
        // best-effort: swallow per-tab close errors
      }
    }
  } finally {
    for (const tabId of tabIds) {
      if (tabOwners.get(tabId) === sessionId) tabOwners.delete(tabId)
    }
    sessions.delete(sessionId)
    inFlight.delete(sessionId)
    lastUsedSeq.delete(sessionId)
  }
}

/**
 * Close every live session. Used by the shutdown handlers; `dispatch` is
 * injectable for tests.
 */
async function closeAllBrowseSessions(
  dispatch: CloseTabDispatch = dispatchBrowserTool,
): Promise<void> {
  for (const sessionId of [...sessions.keys()]) {
    await closeBrowseSession(sessionId, dispatch)
  }
}

// ============================================================
// Process-exit handlers (registered once at module load)
// ============================================================

const sigintHandler = (): void => {
  // Fire-and-forget best-effort close, then re-raise so the process still
  // terminates with the conventional exit code (attaching a listener
  // otherwise cancels Node's default-terminate behavior).
  void closeAllBrowseSessions()
  process.off("SIGINT", sigintHandler)
  process.kill(process.pid, "SIGINT")
}

const sigtermHandler = (): void => {
  void closeAllBrowseSessions()
  process.off("SIGTERM", sigtermHandler)
  process.kill(process.pid, "SIGTERM")
}

// `exit` can only run synchronous code — the async tab-close can't complete
// here, so we just drop the in-memory maps (cosmetic browser tabs aside,
// nothing leaks inside the proxy).
const exitHandler = (): void => {
  sessions.clear()
  tabOwners.clear()
  inFlight.clear()
  lastUsedSeq.clear()
}

process.on("SIGINT", sigintHandler)
process.on("SIGTERM", sigtermHandler)
process.on("exit", exitHandler)

// ============================================================
// Test-only
// ============================================================

/**
 * Test-only helpers. The public surface is the session functions above;
 * tests use these to reset state and exercise the shutdown path without
 * sending real signals or driving a live browser.
 */
export const __testExports = {
  closeAllBrowseSessions,
  /** Clear all sessions (does NOT close tabs). */
  reset(): void {
    sessions.clear()
    tabOwners.clear()
    inFlight.clear()
    lastUsedSeq.clear()
    useSeq = 0
  },
  /** Remove the process-exit handlers (so a test process doesn't accumulate them). */
  unregisterExitHandlers(): void {
    process.off("SIGINT", sigintHandler)
    process.off("SIGTERM", sigtermHandler)
    process.off("exit", exitHandler)
  },
  maxSessions,
  sigintHandler,
  sigtermHandler,
  exitHandler,
}
