// dispatch.ts — github-router-side dispatcher for browser_* tool calls.
//
// Flow per tool call (called from the per-tool handler in index.ts):
//
//   1. ensureBridgeReady() — see install-check.ts. Either auto-installs
//      the NMH manifest and returns ready, or returns install_required
//      with the exact reason + actionable next-step JSON for the model.
//   2. If install_required → return that envelope (isError: true) and
//      stop.
//   3. Open a per-call WS to the bridge with the bearer token from
//      bridge.json. Send {id, tool, args}.
//   4. Race the response against a per-tool timeout (table below).
//   5. Translate {ok: true, data} → text envelope (JSON.stringify(data));
//      {ok: false, error} → tool-error envelope.
//
// Per-call WS open is simpler than holding a session-long connection
// and adds maybe 10 ms of overhead — fine for browser tools which run
// at human-pace anyway. Phase 6 can switch to pooled connections if
// profiling shows it matters.

import { randomUUID } from "node:crypto"

import WebSocket from "ws"

import {
  ensureBridgeReady,
  installRequiredToolResult,
} from "./install-check"
import { interActionDelay } from "./humanlike"
import { preflightUrlPolicy } from "./policy"
import { state } from "~/lib/state"

/**
 * Tools whose dispatch counts as a mutating user action for pacing
 * purposes. Read-only tools (list_tabs, screenshot, read_page,
 * diagnostics, navigate-without-form-submit) skip the inter-action
 * delay because they don't look like a human clicking around.
 */
const PACED_TOOLS = new Set([
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_keyboard",
  "browser_scroll",
  "browser_mouse",
  "browser_drag",
])

let lastDispatchAt = 0
// Cached snapshot of bridge-reported humanlike-tab state. Probed at
// most once per HUMANLIKE_PROBE_INTERVAL_MS so we don't spam /health
// on every tool dispatch.
let humanlikeAutoCache: { fetchedAt: number, tabs: Set<number> } = {
  fetchedAt: 0,
  tabs: new Set(),
}
const HUMANLIKE_PROBE_INTERVAL_MS = 5_000

async function isHumanlikeAutoOn(
  tabId: number | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (state.humanlikeForce === "off") return false
  if (typeof tabId !== "number") return false
  const now = Date.now()
  if (now - humanlikeAutoCache.fetchedAt > HUMANLIKE_PROBE_INTERVAL_MS) {
    try {
      const ready = await ensureBridgeReady()
      if (ready.install_required) return false
      const res = await fetch(`http://127.0.0.1:${ready.port}/health`, {
        headers: { authorization: `Bearer ${ready.token}` },
        signal,
      })
      if (res.ok) {
        const body = await res.json() as { humanlike_tabs?: Array<{ tabId: number }> }
        const tabs = new Set<number>()
        for (const t of body.humanlike_tabs ?? []) {
          if (typeof t.tabId === "number") tabs.add(t.tabId)
        }
        humanlikeAutoCache = { fetchedAt: now, tabs }
      }
    } catch {
      // /health unreachable — keep stale cache, fail-closed-to-fast
      // (no pacing). Better to be fast on transient errors than
      // permanently slow on a flaky network.
    }
  }
  return humanlikeAutoCache.tabs.has(tabId)
}

async function maybeInjectHumanlikeDelay(
  tool: string,
  signal?: AbortSignal,
  tabId?: number,
): Promise<void> {
  if (!PACED_TOOLS.has(tool)) return
  // Force-on > auto-detected per-tab > off.
  let on = state.humanlikeForce === "on"
  if (!on && state.humanlikeForce === "auto") {
    on = await isHumanlikeAutoOn(tabId, signal)
  }
  if (!on) return
  const target = interActionDelay()
  const sinceLast = Date.now() - lastDispatchAt
  const wait = Math.max(0, target - sinceLast)
  if (wait > 0) {
    await sleepAbortable(wait, signal)
  }
  lastDispatchAt = Date.now()
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
  })
}

type ToolName =
  | "browser_list_tabs"
  | "browser_open_tab"
  | "browser_close_tab"
  | "browser_navigate"
  | "browser_screenshot"
  | "browser_read_page"
  | "browser_click"
  | "browser_fill"
  | "browser_scroll"
  | "browser_keyboard"
  | "browser_wait"
  | "browser_eval_js"
  | "browser_download"
  | "browser_console_logs"
  | "browser_network_log"
  | "browser_mouse"
  | "browser_drag"
  | "browser_type"
  | "browser_locate"

interface PerToolTimeout {
  defaultMs: number
  maxMs: number
}

const PER_TOOL_TIMEOUTS: Record<ToolName, PerToolTimeout> = {
  browser_list_tabs: { defaultMs: 5_000, maxMs: 10_000 },
  browser_open_tab: { defaultMs: 30_000, maxMs: 60_000 },
  browser_close_tab: { defaultMs: 5_000, maxMs: 10_000 },
  browser_navigate: { defaultMs: 30_000, maxMs: 60_000 },
  browser_screenshot: { defaultMs: 15_000, maxMs: 30_000 },
  browser_read_page: { defaultMs: 10_000, maxMs: 30_000 },
  browser_click: { defaultMs: 10_000, maxMs: 30_000 },
  browser_fill: { defaultMs: 10_000, maxMs: 30_000 },
  browser_scroll: { defaultMs: 5_000, maxMs: 15_000 },
  browser_keyboard: { defaultMs: 5_000, maxMs: 10_000 },
  browser_wait: { defaultMs: 10_000, maxMs: 60_000 },
  browser_eval_js: { defaultMs: 5_000, maxMs: 30_000 },
  browser_download: { defaultMs: 60_000, maxMs: 300_000 },
  browser_console_logs: { defaultMs: 5_000, maxMs: 10_000 },
  browser_network_log: { defaultMs: 5_000, maxMs: 10_000 },
  // mouse/drag worst case: 100 steps * 50ms stepDelayMs + CDP overhead + hit-test ~= 6s.
  // Cap at 30s to leave room for slow extension SW wake-up after dormancy.
  browser_mouse: { defaultMs: 10_000, maxMs: 30_000 },
  browser_drag: { defaultMs: 15_000, maxMs: 30_000 },
  // type worst case: 4096 chars * 50ms delayMs ~= 205s. Cap default at the
  // typical-case ~50 chars limit; max accommodates the schema-allowed worst case.
  browser_type: { defaultMs: 15_000, maxMs: 210_000 },
  browser_locate: { defaultMs: 5_000, maxMs: 10_000 },
}

function pickTimeout(tool: string): PerToolTimeout {
  if (tool in PER_TOOL_TIMEOUTS) {
    return PER_TOOL_TIMEOUTS[tool as ToolName]
  }
  return { defaultMs: 10_000, maxMs: 30_000 }
}

interface BridgeOk {
  id: string
  ok: true
  data: unknown
}
interface BridgeErr {
  id: string
  ok: false
  error: string
  code?: string
}
type BridgeResponse = BridgeOk | BridgeErr

interface BridgeEndpoint {
  port: number
  token: string
}

/**
 * Send one request to the bridge over a fresh WebSocket connection.
 * Resolves to the bridge's response envelope or rejects on timeout /
 * transport failure. Honors the caller's AbortSignal — when the MCP
 * client sends notifications/cancelled, the WS is force-closed and
 * the promise rejects so the slot releases cleanly.
 */
async function bridgeCall(
  endpoint: BridgeEndpoint,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BridgeResponse> {
  return new Promise<BridgeResponse>((resolve, reject) => {
    const id = randomUUID()
    const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    })
    let settled = false
    // Must be `let` (not `const`): declared before finish() which reads
    // it via clearTimeout, but assigned by setTimeout below. Using
    // `const` caused the original TDZ crash when signal.aborted was
    // already true at call time (Bug D1).
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      try {
        ws.close()
      } catch {
        // Closing a half-open socket can throw; safe to ignore.
      }
      fn()
    }
    const onAbort = () => finish(() => reject(new Error("aborted")))
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    timer = setTimeout(
      () => finish(() => reject(new Error(`timeout after ${timeoutMs}ms`))),
      timeoutMs,
    )
    ws.on("open", () => {
      // Guard: timeout or abort may have fired between the TCP connect
      // completing and the "open" event arriving on the event loop.
      // Without this check, send() would execute the tool in the
      // browser even though the caller has already rejected the promise
      // — a "ghost execution" for side-effectful tools (click, fill,
      // navigate, download).
      if (settled) {
        try {
          ws.close()
        } catch {
          // ignore
        }
        return
      }
      ws.send(JSON.stringify({ id, tool, args }))
    })
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as BridgeResponse
        if (parsed && parsed.id === id) {
          finish(() => resolve(parsed))
        }
      } catch (err) {
        finish(() => reject(err))
      }
    })
    ws.on("error", (err) => {
      finish(() => reject(err))
    })
    ws.on("close", () => {
      finish(() =>
        reject(new Error("bridge connection closed before response")),
      )
    })
  })
}

export interface DispatchOpts {
  timeoutMs?: number
}

type ToolEnvelope = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function blockedUrlEnvelope(reason: string | undefined): ToolEnvelope {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ blocked: true, reason }, null, 2),
      },
    ],
    isError: true,
  }
}

/**
 * Pre-slot readiness gate for browser_* tools. Runs the SAME cheap,
 * fail-fast checks `dispatchBrowserTool` runs at its head (the pure
 * URL-policy block and `ensureBridgeReady()`), but is meant to be
 * invoked by the MCP route handler BEFORE it acquires a concurrency
 * slot, mirroring how persona pre-flights (`predictedWindowOverflow` /
 * `jsonPathPreflightCap`) run before `acquireInFlightSlot()`.
 *
 * Returns `{ envelope }` when the call must be rejected up front (a
 * blocked URL, or the bridge/extension isn't installed, i.e. the
 * structured `install_required` payload). The handler returns that
 * envelope WITHOUT having taken a slot, so a cold-start NMH install
 * can't park up to N slots on one shared readiness probe and lock out
 * peers / search / workers / decide. Returns `{ envelope: undefined }`
 * when the call should proceed to slot acquisition + dispatch.
 *
 * INTENTIONALLY does NOT return the resolved `BridgeReady` port/token.
 * Threading those across the (unbounded) slot-acquisition wait would be
 * a TOCTOU hazard: the bridge can roll its port/token via the
 * extension-version auto-reload path while this caller is parked waiting
 * for a slot, leaving the threaded credentials stale. The slot-side
 * `dispatchBrowserTool` re-runs `ensureBridgeReady()` to fetch fresh
 * credentials at use time. The `_inFlightReady` single-flight makes the
 * readiness probe idempotent under concurrency; the one redundant
 * happy-path `ensureBridgeReady()` (and its NMH install) is the accepted
 * cost of keeping the credentials fresh.
 */
export async function browserPreflight(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ envelope: ToolEnvelope | undefined }> {
  // Normalize to the WIRE name. The MCP route handler keys browser tools
  // by the bare `toolNameHttp` (`open_tab`, `navigate`, ...); the
  // `browser_` prefix is stripped when the tools are spread into
  // NON_PERSONA_MCP_TOOLS. But `preflightUrlPolicy` matches on the wire
  // name (`browser_open_tab` / `browser_navigate`, the literal each
  // handler dispatches to the extension), so the bare name would slip
  // past the URL block. Re-add the prefix if it's missing so a blocked
  // open_tab / navigate URL fails closed here too. Idempotent if a caller
  // already passes the wire name.
  const wireTool = tool.startsWith("browser_") ? tool : `browser_${tool}`
  // Same defense-in-depth URL block dispatchBrowserTool runs first: a
  // blocked open_tab / navigate URL must fail closed WITHOUT probing or
  // installing the bridge.
  const policy = preflightUrlPolicy(wireTool, args)
  if (policy.blocked) {
    return { envelope: blockedUrlEnvelope(policy.reason) }
  }
  const ready = await ensureBridgeReady()
  if (ready.install_required) {
    return { envelope: installRequiredToolResult(ready) }
  }
  return { envelope: undefined }
}

/**
 * Real dispatcher for any browser_* tool. Used by the entries in
 * src/lib/browser-mcp/index.ts. Returns the standard MCP tool-result
 * envelope.
 */
export async function dispatchBrowserTool(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  opts: DispatchOpts = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}> {
  // Defense-in-depth: bridge-layer URL block runs BEFORE the install
  // check + WS round-trip. An extension regression that silently
  // re-enables a blocked URL still fails closed here. (Also runs in
  // `browserPreflight` before slot acquisition; re-run here so internal
  // compound-tool dispatches, which skip the pre-slot gate, stay
  // fail-closed.)
  const policy = preflightUrlPolicy(tool, args)
  if (policy.blocked) {
    return blockedUrlEnvelope(policy.reason)
  }
  const ready = await ensureBridgeReady()
  if (ready.install_required) {
    return installRequiredToolResult(ready)
  }
  // Humanlike pacing: when state.humanlikeForce === "on" (--humanlike
  // flag or GH_ROUTER_HUMANLIKE=1) AND this tool is a mutating action
  // (click / fill / type / keyboard / scroll / mouse / drag), inject
  // a Beta-distributed inter-action delay before the dispatch. When
  // state.humanlikeForce === "auto" (default), consult the bridge
  // /health endpoint for tabs flagged by extension-side bot-challenge
  // detection (Cloudflare / Datadome / PerimeterX / Imperva headers)
  // and inject the same delay only for those tabs. Cached probe is
  // throttled to one /health call per 5 s.
  const tabIdArg = typeof args.tabId === "number" ? args.tabId : undefined
  await maybeInjectHumanlikeDelay(tool, signal, tabIdArg)
  const { defaultMs, maxMs } = pickTimeout(tool)
  const callerTimeout =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, maxMs)
      : defaultMs
  try {
    const resp = await bridgeCall(
      { port: ready.port, token: ready.token },
      tool,
      args,
      callerTimeout,
      signal,
    )
    if (resp.ok) {
      const text =
        typeof resp.data === "string"
          ? resp.data
          : JSON.stringify(resp.data, null, 2)
      logAudit({
        tool,
        argsBytes: argsByteSize(args),
        durationMs: 0, // dispatcher boundary doesn't time the WS round-trip yet
        profile: typeof args.profile === "string" ? args.profile : "isolated",
        result: "ok",
      })
      return { content: [{ type: "text", text }] }
    }
    logAudit({
      tool,
      argsBytes: argsByteSize(args),
      durationMs: 0,
      profile: typeof args.profile === "string" ? args.profile : "isolated",
      result: "bridge_error",
      error: resp.error,
    })
    return {
      content: [
        {
          type: "text",
          text: `${tool} failed: ${resp.error}${resp.code ? ` (${resp.code})` : ""}`,
        },
      ],
      isError: true,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logAudit({
      tool,
      argsBytes: argsByteSize(args),
      durationMs: 0,
      profile: typeof args.profile === "string" ? args.profile : "isolated",
      result: "exception",
      error: message,
    })
    return {
      content: [{ type: "text", text: `${tool} failed: ${message}` }],
      isError: true,
    }
  }
}

function argsByteSize(args: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(args), "utf8")
  } catch {
    return -1
  }
}

interface AuditRecord {
  tool: string
  argsBytes: number
  durationMs: number
  profile: string
  result: "ok" | "bridge_error" | "exception"
  error?: string
}

function logAudit(record: AuditRecord): void {
  if (process.env.GH_ROUTER_LOG_BROWSER_MCP !== "1") return
  // Lazy-import fs/path to avoid pulling them into the hot path when
  // the audit log is off (the common case).
  void (async () => {
    try {
      const fs = await import("node:fs/promises")
      const path = await import("node:path")
      const { PATHS } = await import("~/lib/paths")
      const dir = path.join(PATHS.APP_DIR, "browser-mcp")
      await fs.mkdir(dir, { recursive: true })
      const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n"
      await fs.appendFile(path.join(dir, "audit.log"), line, "utf8")
    } catch {
      // Audit log is best-effort; never fail a tool call because of it.
    }
  })()
}
