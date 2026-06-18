/**
 * Tiny MCP-over-HTTP + inference client for the advisory-review hooks (hook V2).
 *
 * The hook subcommands (`internal-stop-review`, `internal-prompt-submit`) run as
 * SEPARATE short-lived processes spawned by Claude Code — they have no in-process
 * proxy `state`. They reach the running github-router proxy over loopback HTTP:
 *
 *   - `callMcpTool` POSTs a JSON-RPC `tools/call` to `${serverUrl}/mcp/<group>`
 *     with the per-launch `Authorization: Bearer <nonce>` (the same nonce the
 *     proxy minted in `writePeerMcpRuntimeFiles` and validates in the /mcp
 *     handler). Used for `workers/review` (the background reviewer) and
 *     `search/code` (the prompt-hook grounding search). Forces the JSON response
 *     path (`Accept: application/json`) — the SSE path's 60s-ceiling workaround
 *     is a Claude-Code-MCP-client concern; our own fetch has no such cap, so the
 *     simpler single-body JSON path is correct here.
 *
 *   - `callInference` POSTs to `${serverUrl}/v1/responses` (no nonce — the /v1/*
 *     passthrough authenticates upstream with the proxy's own Copilot token) for
 *     the single gpt-5.5 scope/goal call the prompt hook makes.
 *
 * Everything here is best-effort and caller-fail-open: a transport error,
 * non-2xx, timeout, or malformed body throws, and every caller wraps the call so
 * the hook degrades gracefully (no findings / the regex-heuristic goal) rather
 * than disrupting the session.
 */

import { setTimeout as setTimer, clearTimeout as clearTimer } from "node:timers"

/** The proxy URL + per-launch nonce, read from the child env the launcher set. */
export interface HookMcpRuntime {
  serverUrl: string
  nonce: string
}

/**
 * Read the proxy URL + nonce the launcher injected into the spawned child env
 * (`GH_ROUTER_HOOK_MCP_URL` / `GH_ROUTER_HOOK_NONCE`). Returns undefined when
 * either is absent — the hook then skips its LLM layer and falls back to its
 * deterministic / regex behavior.
 */
export function hookMcpRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): HookMcpRuntime | undefined {
  const serverUrl = (env.GH_ROUTER_HOOK_MCP_URL ?? "").trim()
  const nonce = (env.GH_ROUTER_HOOK_NONCE ?? "").trim()
  if (serverUrl.length === 0 || nonce.length === 0) return undefined
  return { serverUrl, nonce }
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: {
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  }
  error?: { code?: number; message?: string }
}

export interface McpToolResult {
  /** Concatenated text from `result.content[].text`. */
  text: string
  /** True when the tool reported a failure (`result.isError`) or a JSON-RPC error. */
  isError: boolean
}

/**
 * POST a JSON-RPC `tools/call` and return the tool's text + isError. Throws on
 * any transport/HTTP/parse failure (caller fails open). A JSON-RPC `error`
 * envelope is mapped to `{ text: message, isError: true }` (a well-formed
 * negative result, not a transport failure).
 */
export async function callMcpTool(opts: {
  runtime: HookMcpRuntime
  group: string
  tool: string
  args: Record<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
}): Promise<McpToolResult> {
  const url = `${opts.runtime.serverUrl.replace(/\/+$/, "")}/mcp/${opts.group}`
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: opts.tool, arguments: opts.args },
  }
  const body = await postJson(url, payload, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    headers: { Authorization: `Bearer ${opts.runtime.nonce}` },
  })
  const rpc = (body && typeof body === "object" ? body : {}) as JsonRpcResponse
  if (rpc.error) {
    return { text: rpc.error.message ?? "MCP error", isError: true }
  }
  const content = Array.isArray(rpc.result?.content) ? rpc.result.content : []
  const text = content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
  return { text, isError: rpc.result?.isError === true }
}

interface ResponsesApiShape {
  output?: Array<{
    type?: string
    role?: string
    content?: Array<{ type?: string; text?: string }>
  }>
}

/**
 * One non-streaming gpt-5.5 (or any model id) inference via `/v1/responses`.
 * Returns the assistant text (possibly empty). Throws on transport/HTTP/parse
 * failure. `effort` maps to the Responses `reasoning.effort` knob.
 */
export async function callInference(opts: {
  serverUrl: string
  model: string
  instructions: string
  input: string
  effort: "low" | "medium" | "high" | "xhigh"
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string> {
  const url = `${opts.serverUrl.replace(/\/+$/, "")}/v1/responses`
  const payload = {
    model: opts.model,
    instructions: opts.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: opts.input }] }],
    stream: false,
    reasoning: { effort: opts.effort },
  }
  const body = (await postJson(url, payload, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  })) as ResponsesApiShape
  const out: string[] = []
  const items = Array.isArray(body?.output) ? body.output : []
  for (const item of items) {
    if (item?.type !== "message" || item.role !== "assistant") continue
    const parts = Array.isArray(item.content) ? item.content : []
    for (const part of parts) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        out.push(part.text)
      }
    }
  }
  return out.join("")
}

/**
 * POST `payload` as JSON with a hard timeout, returning the parsed JSON body.
 * Throws on non-2xx, network error, timeout (AbortController), or non-JSON body.
 * An external `signal` is honored alongside the internal timeout.
 */
async function postJson(
  url: string,
  payload: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimer(() => controller.abort(new Error("hook MCP request timed out")), opts.timeoutMs)
  const onExternalAbort = (): void => controller.abort(new Error("hook MCP request aborted"))
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort()
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...opts.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`hook MCP request failed: HTTP ${res.status}`)
    }
    return (await res.json()) as unknown
  } finally {
    clearTimer(timer)
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort)
  }
}
