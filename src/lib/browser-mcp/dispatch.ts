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
import { preflightUrlPolicy } from "./policy"

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
  browser_scroll: { defaultMs: 5_000, maxMs: 10_000 },
  browser_keyboard: { defaultMs: 5_000, maxMs: 10_000 },
  browser_wait: { defaultMs: 10_000, maxMs: 60_000 },
  browser_eval_js: { defaultMs: 5_000, maxMs: 30_000 },
  browser_download: { defaultMs: 60_000, maxMs: 300_000 },
  browser_console_logs: { defaultMs: 5_000, maxMs: 10_000 },
  browser_network_log: { defaultMs: 5_000, maxMs: 10_000 },
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
  // re-enables a blocked URL still fails closed here.
  const policy = preflightUrlPolicy(tool, args)
  if (policy.blocked) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ blocked: true, reason: policy.reason }, null, 2),
        },
      ],
      isError: true,
    }
  }
  const ready = await ensureBridgeReady()
  if (ready.install_required) {
    return installRequiredToolResult(ready)
  }
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
