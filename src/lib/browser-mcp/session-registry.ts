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

// ============================================================
// Session lifecycle
// ============================================================

/**
 * Create a new browse session and return its id. Enforces the
 * `GH_ROUTER_BROWSE_MAX_SESSIONS` cap (throws a clear error when the cap
 * is already reached — the caller should close a session or raise the cap).
 */
export function createBrowseSession(): string {
  const cap = maxSessions()
  if (sessions.size >= cap) {
    throw new Error(
      `browse session cap reached (${cap} active); close a session or raise `
        + "GH_ROUTER_BROWSE_MAX_SESSIONS.",
    )
  }
  const id = randomUUID()
  sessions.set(id, new Set<number>())
  return id
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
