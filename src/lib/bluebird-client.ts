/**
 * Minimal Bluebird MCP client (Streamable HTTP, MCP 2025-06-18).
 *
 * The proxy keeps its own `mcp__search__code` schema; this client speaks to
 * the upstream Bluebird server (`https://mcp.bluebird-ai.net/`) and returns
 * plain rows the unified helper maps 1:1. Tool parameter shapes are resolved
 * at runtime from `tools/list` (candidate-key matching) rather than
 * hard-coded, because the server is versioned independently of this repo.
 *
 * Auth: `az account get-access-token` for the Azure DevOps resource
 * (`499b84ac-1321-427f-aa17-267ca6975798`). `BLUEBIRD_TOKEN` env overrides
 * for tests and manual runs. 401 refreshes the token and recreates the session
 * once before retrying.
 *
 * Retry: retriable statuses (429/500/502/503/504) and transport errors are
 * retried up to 3 attempts with exponential backoff (1s/2s/4s). Anything
 * else throws a `BluebirdError` the caller surfaces in `notice` — there is
 * deliberately NO silent fallback to the local engine under `--bluebird`.
 */

import { resolveExecutable, runCommandCapture } from "./exec"
import {
  checkBranchIndexStatus,
  getAzureRepoFromGit,
  getCurrentBranch,
  getDefaultBranch,
} from "./azure-repo"
import { state } from "./state"
import { sanitizeTransportText } from "./upstream-retry"
import type { UnifiedResultRow } from "./unified-code-search"

export const BLUEBIRD_MCP_URL = "https://mcp.bluebird-ai.net/"
export const BLUEBIRD_TOKEN_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
export const BLUEBIRD_PROTOCOL_VERSION = "2025-06-18"

export class BluebirdError extends Error {
  readonly retriable: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(
    message: string,
    opts: { retriable?: boolean; status?: number; retryAfterMs?: number } = {},
  ) {
    super(sanitizeBluebirdDetail(message))
    this.name = "BluebirdError"
    this.retriable = opts.retriable ?? false
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

export interface BluebirdScope {
  organization: string
  project: string
  /**
   * Bluebird scope is always exactly one checked-out repository — the one
   * `getAzureRepoFromGit` deterministically resolves from git remotes. This
   * stays an array only for wire-header compatibility with the deployed
   * Bluebird server (`x-mcp-ec-repository` is comma-joined); it must never
   * contain sibling repositories from the same Azure org/project.
   */
  repositories: Array<string>
  branch?: string
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

interface ComposedSignal {
  signal: AbortSignal
  cleanup: () => void
}

function composeRequestSignal(
  caller: AbortSignal | undefined,
  disposal: AbortSignal | undefined,
  timeoutMs = 30_000,
): ComposedSignal {
  const controller = new AbortController()
  const onCallerAbort = () => {
    controller.abort(caller?.reason ?? new Error("aborted"))
  }
  const onDisposalAbort = () => {
    controller.abort(
      disposal?.reason ?? new BluebirdError("Bluebird client has been disposed.", { retriable: false }),
    )
  }

  if (disposal?.aborted) onDisposalAbort()
  else disposal?.addEventListener("abort", onDisposalAbort, { once: true })

  if (caller?.aborted) onCallerAbort()
  else caller?.addEventListener("abort", onCallerAbort, { once: true })

  const timer = setTimeout(() => {
    controller.abort(new Error("Bluebird request timed out"))
  }, timeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener("abort", onCallerAbort)
      disposal?.removeEventListener("abort", onDisposalAbort)
    },
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (
    err.name === "AbortError"
    || err.message === "aborted"
    || err.message === "This operation was aborted"
  )
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason ?? new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

function canonicalWorkspace(workspace: string): string {
  return workspace.replace(/[\\/]+$/, "").toLowerCase() || workspace.toLowerCase()
}

function scopeFingerprint(
  workspace: string,
  scope: {
    organization: string
    project: string
    repositories: ReadonlyArray<string>
    branch?: string | null
  },
): string {
  const repos = [...scope.repositories]
    .map((repo) => repo.toLowerCase())
    .sort()
    .join(",")
  return `${canonicalWorkspace(workspace)}::${scope.organization.toLowerCase()}/${scope.project.toLowerCase()}/${repos}@${(scope.branch ?? "").toLowerCase()}`
}

function sanitizeBluebirdDetail(value: unknown): string {
  return sanitizeTransportText(
    value instanceof Error ? value.message : String(value),
  )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:https?|ssh):\/\/[^\s"'<>]+/gi, "[REDACTED URL]")
    .replace(/\bgit@[^\s:]+:[^\s]+/gi, "[REDACTED REMOTE]")
}

async function runAzToken(signal?: AbortSignal): Promise<string> {
  const executable = resolveExecutable("az")
  if (!executable) {
    throw new BluebirdError("Azure CLI executable `az` was not found on PATH.", { retriable: false })
  }
  try {
    const result = await runCommandCapture(
      [
        executable,
        "account",
        "get-access-token",
        "--resource",
        BLUEBIRD_TOKEN_RESOURCE,
        "--query",
        "accessToken",
        "--output",
        "tsv",
      ],
      {
        timeoutMs: 20_000,
        maxStdoutBytes: 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
    )
    if (result.timedOut) throw new Error("timed out")
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`exited with code ${result.code ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
    }
    const token = result.stdout.trim()
    if (!token) throw new Error("az returned an empty access token")
    return token
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new BluebirdError(
      `az token acquisition failed (${sanitizeBluebirdDetail(err)}). Run \`az login\` and retry.`,
      { retriable: false },
    )
  }
}

function sameJsonRpcId(actual: unknown, expected: unknown): boolean {
  return actual === expected || (typeof actual === "number" && typeof expected === "number" && actual === expected)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(300_000, Math.floor(seconds * 1000))
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, Math.min(300_000, timestamp - Date.now()))
}

function matchingJsonRpcResponse(
  candidate: unknown,
  expectedId: unknown,
): JsonRpcResponse | undefined {
  if (!isRecord(candidate)) return undefined
  const response = candidate as JsonRpcResponse
  if (response.result === undefined && response.error === undefined) return undefined
  return sameJsonRpcId(response.id, expectedId) ? response : undefined
}

function parseJsonResponse(text: string, expectedId: unknown): JsonRpcResponse {
  try {
    const response = matchingJsonRpcResponse(JSON.parse(text), expectedId)
    if (response) return response
  } catch {
    // Report one stable protocol error below rather than leaking parser details.
  }
  throw new BluebirdError("Bluebird returned no matching JSON-RPC response.", { retriable: true })
}

async function parseSseResponse(
  response: Response,
  expectedId: unknown,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted")
  }
  if (!response.body) {
    throw new BluebirdError("Bluebird returned an empty SSE response.", { retriable: true })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: Array<string> = []

  const inspectEvent = (): JsonRpcResponse | undefined => {
    if (dataLines.length === 0) return undefined
    const data = dataLines.join("\n")
    dataLines = []
    try {
      return matchingJsonRpcResponse(JSON.parse(data), expectedId)
    } catch {
      return undefined
    }
  }

  // Race each pending `reader.read()` against the abort signal so disposal
  // or caller cancellation can interrupt a read that would otherwise block
  // forever waiting on network bytes that never arrive.
  let abortListener: (() => void) | undefined
  const abortPromise = signal ? new Promise<never>((_, reject) => {
    abortListener = () => {
      reader.cancel().catch(() => {})
      reject(signal.reason ?? new Error("aborted"))
    }
    if (signal.aborted) abortListener()
    else signal.addEventListener("abort", abortListener, { once: true })
  }) : undefined

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted")
      }
      const readPromise = reader.read()
      readPromise.catch(() => {})
      const { value, done } = abortPromise
        ? await Promise.race([readPromise, abortPromise])
        : await readPromise

      buffer += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line === "") {
          const match = inspectEvent()
          if (match) return match
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""))
        }
      }
      if (done) {
        if (buffer) {
          const line = buffer.replace(/\r$/, "")
          if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
        }
        const match = inspectEvent()
        if (match) return match
        break
      }
    }
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener)
    }
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  throw new BluebirdError("Bluebird returned no matching JSON-RPC response.", { retriable: true })
}

/** Token source: explicit env first (tests/manual), else `az` CLI. */
export async function getBluebirdToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env.BLUEBIRD_TOKEN?.trim()
  if (env) return env
  return runAzToken(signal)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const QUERY_KEYS = [
  "query",
  "similarity_search_text",
  "searchText",
  "search_text",
  "text",
  "q",
  "question",
]
const LIMIT_KEYS = ["limit", "top", "maxResults", "max_results", "pageSize", "count"]
const GLOB_KEYS = ["file_glob", "fileGlob", "filePattern", "file_pattern", "glob", "pathFilter"]
const UNIFIED_SEARCH_TOOL = "code_search"
const LEGACY_SEMANTIC_TOOL = "do_vector_search"
const LEGACY_LEXICAL_TOOL = "search_file_content"

function pickKey(schema: unknown, candidates: ReadonlyArray<string>): string | null {
  if (!isRecord(schema)) return null
  const props = isRecord(schema.properties) ? schema.properties : null
  if (!props) return candidates[0] ?? null
  for (const key of candidates) {
    if (key in props) return key
  }
  return null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Normalize an upstream repository-relative path without allowing escapes. */
function normalizeRemotePath(value: string): string | null {
  if (!value || value.includes("\0")) return null
  const normalized = value.replaceAll("\\", "/")
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) return null
  const relative = normalized.replace(/^\/+/, "")
  if (!relative || relative.split("/").some((part) => part === "..")) return null
  const segments = relative.split("/").filter((part) => part && part !== ".")
  if (segments.length === 0) return null
  return segments.join("/")
}

/** Best-effort normalization of one upstream hit into a unified row. */
function toRow(item: unknown, index: number): UnifiedResultRow | null {
  if (!isRecord(item)) {
    if (typeof item === "string" && item.trim()) {
      return { file: `bluebird-hit-${index}`, line: 1, snippet: item.slice(0, 2000) }
    }
    return null
  }
  const file =
    asString(item.file) ?? asString(item.filePath) ?? asString(item.file_path)
    ?? asString(item.node_file_path) ?? asString(item.path)
    ?? asString(item.repoRelativePath)
  const line =
    asNumber(item.line) ?? asNumber(item.lineNumber) ?? asNumber(item.line_number)
    ?? asNumber(item.startLine) ?? asNumber(item.start_line)
    ?? asNumber(item.code_startRow) ?? 1
  const snippet =
    asString(item.snippet) ?? asString(item.content) ?? asString(item.text)
    ?? asString(item.page_content) ?? asString(item.excerpt)
    ?? asString(item.preview)
  if (!file || !snippet) return null
  const normalizedFile = normalizeRemotePath(file)
  if (!normalizedFile) return null
  const row: UnifiedResultRow = {
    file: normalizedFile,
    line: Math.max(1, Math.floor(line)),
    snippet,
  }
  const score = asNumber(item.score) ?? asNumber(item.relevance)
    ?? asNumber(item.similarity) ?? asNumber(item.similarity_score)
  if (score !== undefined) row.score = score
  const endLine = asNumber(item.endLine) ?? asNumber(item.end_line)
    ?? asNumber(item.code_endRow)
  if (endLine !== undefined) row.endLine = endLine
  const name = asString(item.name) ?? asString(item.symbol) ?? asString(item.node_name)
  if (name) row.name = name
  return row
}

/** Extract rows from a `tools/call` result envelope. */
function rowsFromArray(items: Array<unknown>): Array<UnifiedResultRow> {
  if (items.length === 0) return []

  const rows: Array<UnifiedResultRow> = []
  let recognized = false
  for (const item of items) {
    if (isRecord(item)) {
      const wrapperKey = "SimilaritySearchResult" in item
        ? "SimilaritySearchResult"
        : "FullTextSearchResult" in item
          ? "FullTextSearchResult"
          : undefined
      if (wrapperKey) {
        const nested = item[wrapperKey]
        if (!Array.isArray(nested)) {
          throw new BluebirdError(
            `Bluebird returned a malformed ${wrapperKey} wrapper.`,
            { retriable: false },
          )
        }
        recognized = true
        rows.push(...rowsFromArray(nested))
        continue
      }
    }
    const row = toRow(item, rows.length)
    if (row) {
      recognized = true
      rows.push(row)
    }
  }
  if (!recognized) {
    throw new BluebirdError(
      "Bluebird returned no parseable code hits (unexpected result array shape).",
      { retriable: false },
    )
  }
  return rows
}

function rowsFromCallResult(result: unknown): Array<UnifiedResultRow> {
  if (Array.isArray(result)) return rowsFromArray(result)
  if (!isRecord(result)) {
    throw new BluebirdError("Bluebird returned an empty result.", { retriable: true })
  }
  if (result.isError === true) {
    const detail = Array.isArray(result.content)
      ? result.content.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join(" ").trim()
      : ""
    throw new BluebirdError(`Bluebird tool error${detail ? `: ${sanitizeTransportText(detail)}` : ""}`, {
      retriable: false,
    })
  }
  const texts: Array<string> = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text)
      }
    }
  }
  // Structured array result (some servers return `results`/`items` alongside).
  const structured = (result as Record<string, unknown>).structuredContent
    ?? (result as Record<string, unknown>).results
    ?? (result as Record<string, unknown>).items
  if (Array.isArray(structured)) return rowsFromArray(structured)
  if (isRecord(structured)) {
    const nested = structured.results ?? structured.items
    if (Array.isArray(nested)) {
      return rowsFromArray(nested)
    }
  }
  for (const text of texts) {
    const trimmed = text.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // The deployed service may append a plain-text warning after its JSON
      // array (for example, branch-selection guidance). Parse the complete
      // leading JSON value without treating that actionable suffix as data.
      const decoder = new TextDecoder()
      const encoded = new TextEncoder().encode(trimmed)
      let parsedPrefix = false
      for (let end = encoded.length - 1; end > 0; end--) {
        const char = String.fromCharCode(encoded[end])
        if (char !== "]" && char !== "}") continue
        try {
          parsed = JSON.parse(decoder.decode(encoded.subarray(0, end + 1)))
          parsedPrefix = true
          break
        } catch {
          // Keep looking for the end of the leading JSON value.
        }
      }
      if (!parsedPrefix) continue
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.results)
        ? parsed.results
        : isRecord(parsed) && Array.isArray(parsed.items)
          ? parsed.items
          : null
    if (arr) return rowsFromArray(arr)
  }
  throw new BluebirdError(
    "Bluebird returned no parseable code hits (unexpected tool result shape).",
    { retriable: false },
  )
}

export interface BluebirdSearchOpts {
  limit?: number
  file_glob?: string
  signal?: AbortSignal
}

export class BluebirdMcpClient {
  private token: string
  private readonly scope: BluebirdScope
  private readonly baseUrl: string
  private toolSchemas = new Map<string, unknown>()
  private initialized = false
  private initialization: Promise<void> | undefined
  private refreshPromise: Promise<void> | undefined
  private sessionId: string | undefined
  private nextId = 1
  private disposed = false
  private readonly disposalController = new AbortController()
  private tokenGeneration = 0
  private sessionGeneration = 0

  constructor(scope: BluebirdScope, token: string, baseUrl: string = BLUEBIRD_MCP_URL) {
    this.scope = scope
    this.token = token
    this.baseUrl = baseUrl
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": BLUEBIRD_PROTOCOL_VERSION,
      Authorization: `Bearer ${this.token}`,
      "x-mcp-ec-organization": this.scope.organization,
      "x-mcp-ec-project": this.scope.project,
      "x-mcp-ec-repository": this.scope.repositories.join(","),
      ...extra,
    }
    if (this.scope.branch) headers["x-mcp-ec-branch"] = this.scope.branch
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    return headers
  }

  private async post(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    requestSessionGen?: number,
  ): Promise<JsonRpcResponse> {
    if (this.disposed) {
      throw new BluebirdError("Bluebird client has been disposed.", { retriable: false })
    }
    const { signal: requestSignal, cleanup } = composeRequestSignal(signal, this.disposalController.signal)
    const notification = typeof payload.method === "string"
      && payload.method.startsWith("notifications/")
    try {
      let res: Response
      try {
        res = await fetch(this.baseUrl, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: requestSignal,
        })
      } catch (err) {
        if (this.disposed) {
          throw new BluebirdError("Bluebird client has been disposed.", { retriable: false })
        }
        if (isAbortError(err) || requestSignal.aborted) {
          throw new BluebirdError(
            signal?.aborted
              ? "Bluebird request was cancelled."
              : "Bluebird request timed out.",
            { retriable: false },
          )
        }
        throw new BluebirdError(
          `Bluebird transport failed: ${sanitizeBluebirdDetail(err)}`,
          { retriable: true },
        )
      }
      if (this.disposed) {
        throw new BluebirdError("Bluebird client has been disposed.", { retriable: false })
      }
      const session = res.headers.get("mcp-session-id")
      if (session) {
        // A response can land after a 401/404 recovery already bumped the
        // session generation (or after disposal) — never let a late response
        // overwrite the newer (or torn-down) session state.
        if (requestSessionGen === undefined || requestSessionGen === this.sessionGeneration) {
          this.sessionId = session
        }
      }
      if (res.status === 401) {
        throw new BluebirdError("Bluebird rejected the access token (401).", {
          retriable: false,
          status: 401,
        })
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"))
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        throw new BluebirdError(`Bluebird responded with HTTP ${res.status}.`, {
          retriable: true,
          status: res.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        })
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        const detail = body ? sanitizeTransportText(body).slice(0, 300) : ""
        throw new BluebirdError(
          `Bluebird responded with HTTP ${res.status}${detail ? `: ${detail}` : ""}.`,
          { retriable: false, status: res.status },
        )
      }
      if (notification && (res.status === 202 || res.status === 204)) {
        return { jsonrpc: "2.0" }
      }
      const contentType = res.headers.get("content-type")
      if (contentType?.includes("text/event-stream")) {
        try {
          return await parseSseResponse(res, payload.id, requestSignal)
        } catch (err) {
          if (this.disposed) {
            throw new BluebirdError("Bluebird client has been disposed.", { retriable: false })
          }
          if (isAbortError(err) || requestSignal.aborted) {
            throw new BluebirdError(
              signal?.aborted
                ? "Bluebird request was cancelled."
                : "Bluebird request timed out.",
              { retriable: false },
            )
          }
          throw err
        }
      }
      const text = await res.text()
      if (notification && !text.trim()) return { jsonrpc: "2.0" }
      return parseJsonResponse(text, payload.id)
    } finally {
      cleanup()
    }
  }

  /** MCP `initialize`, initialized notification, then paginated `tools/list`. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw new BluebirdError("Bluebird client has been disposed.", { retriable: false })
    }
    if (this.initialized) return
    if (!this.initialization) {
      // Shared initialization is owned by this client's own lifecycle
      // (disposal), never by an individual caller's signal: several callers
      // may be waiting on the same `initialize()` call, and one caller
      // abandoning its wait below must not cancel the in-flight work for the
      // others. Each caller only cancels its own `waitForSignal` below.
      this.initialization = this.initializeWithRecovery(this.disposalController.signal)
        .catch((err) => {
          this.initialization = undefined
          this.initialized = false
          throw err
        })
    }
    return waitForSignal(this.initialization, signal)
  }

  private resetSession(): void {
    this.sessionGeneration++
    this.sessionId = undefined
    this.initialized = false
    this.toolSchemas.clear()
  }

  private async refreshToken(): Promise<void> {
    if (!this.refreshPromise) {
      const refresh = (async () => {
        this.token = await getBluebirdToken(this.disposalController.signal)
        this.tokenGeneration++
        this.resetSession()
      })()
      const tracked = refresh.finally(() => {
        if (this.refreshPromise === tracked) this.refreshPromise = undefined
      })
      this.refreshPromise = tracked
    }
    await this.refreshPromise
  }

  private async initializeWithRecovery(signal?: AbortSignal): Promise<void> {
    const delays = [1000, 2000, 4000]
    let refreshed = false
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await this.initializeOnce(signal)
        return
      } catch (err) {
        if (signal?.aborted) throw err
        this.resetSession()
        if (err instanceof BluebirdError && err.status === 401 && !refreshed) {
          refreshed = true
          await waitForSignal(this.refreshToken(), signal)
          continue
        }
        const retriable = err instanceof BluebirdError ? err.retriable : true
        if (!retriable || attempt >= delays.length) throw err
        const retryAfter = err instanceof BluebirdError ? err.retryAfterMs : undefined
        await sleep(retryAfter ?? delays[attempt], signal)
      }
    }
  }

  private async initializeOnce(signal?: AbortSignal): Promise<void> {
    const curSessionGen = this.sessionGeneration
    const init = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: BLUEBIRD_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "github-router", version: "bluebird" },
      },
    }, signal, curSessionGen)
    if (init.error) {
      throw new BluebirdError(`Bluebird initialize failed: ${init.error.message ?? "unknown error"}`, {
        retriable: false,
      })
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, curSessionGen)

    const stagedSchemas = new Map<string, unknown>()
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    do {
      const listed = await this.post({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }, signal, curSessionGen)
      if (listed.error) {
        throw new BluebirdError(`Bluebird tools/list failed: ${listed.error.message ?? "unknown error"}`, {
          retriable: false,
        })
      }
      if (!isRecord(listed.result) || !Array.isArray(listed.result.tools)) {
        throw new BluebirdError("Bluebird tools/list returned an invalid result.", { retriable: false })
      }
      for (const tool of listed.result.tools) {
        if (isRecord(tool) && typeof tool.name === "string") {
          stagedSchemas.set(tool.name, tool.inputSchema ?? null)
        }
      }
      const nextCursor = listed.result.nextCursor
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
        cursor = undefined
      } else if (typeof nextCursor !== "string") {
        throw new BluebirdError("Bluebird tools/list returned an invalid cursor.", { retriable: false })
      } else if (seenCursors.has(nextCursor)) {
        throw new BluebirdError("Bluebird tools/list repeated a pagination cursor.", { retriable: false })
      } else {
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    } while (cursor)

    const resolveFromStaged = (suffix: string): string | undefined => {
      for (const name of stagedSchemas.keys()) {
        if (name === suffix || name.endsWith(`_${suffix}`) || name.endsWith(`-${suffix}`)) return name
      }
      return undefined
    }

    const unified = resolveFromStaged(UNIFIED_SEARCH_TOOL)
    const semantic = resolveFromStaged(LEGACY_SEMANTIC_TOOL)
    const lexical = resolveFromStaged(LEGACY_LEXICAL_TOOL)
    if (!unified && (!semantic || !lexical)) {
      throw new BluebirdError(
        "Bluebird tools/list did not advertise code_search or both legacy "
          + "semantic and lexical search tools.",
        { retriable: false },
      )
    }

    if (this.disposed || curSessionGen !== this.sessionGeneration) {
      throw new BluebirdError("Bluebird client session invalidated during initialization.", { retriable: false })
    }
    // Atomic schema publication: only a fully-populated, still-current
    // schema map ever becomes visible to callers.
    this.toolSchemas = stagedSchemas
    this.initialized = true
  }

  /** Resolve an advertised tool name by suffix (server prefixes vary). */
  private resolveTool(suffix: string): string | undefined {
    for (const name of this.toolSchemas.keys()) {
      if (name === suffix || name.endsWith(`_${suffix}`) || name.endsWith(`-${suffix}`)) return name
    }
    return undefined
  }

  private shapeArgs(
    tool: string,
    query: string,
    opts: BluebirdSearchOpts,
    mode: "semantic" | "lexical",
  ): Record<string, unknown> {
    const schema = this.toolSchemas.get(tool)
    const args: Record<string, unknown> = {}
    const queryKey = pickKey(schema, QUERY_KEYS) ?? "query"
    args[queryKey] = query
    if (tool === this.resolveTool(UNIFIED_SEARCH_TOOL)) {
      args.method = mode === "semantic" ? "semantic" : "keyword"
      if (mode === "semantic" && isRecord(schema)) {
        const props = isRecord(schema.properties) ? schema.properties : undefined
        if (props && "search_index" in props) args.search_index = "General"
      }
    } else if (mode === "semantic" && isRecord(schema)) {
      const props = isRecord(schema.properties) ? schema.properties : undefined
      if (props && "search_index" in props) args.search_index = "General"
    }
    const limitKey = pickKey(schema, LIMIT_KEYS)
    if (limitKey && opts.limit !== undefined) args[limitKey] = opts.limit
    const globKey = pickKey(schema, GLOB_KEYS)
    if (globKey && opts.file_glob) args[globKey] = opts.file_glob
    return args
  }

  private searchTool(mode: "semantic" | "lexical"): string {
    const unified = this.resolveTool(UNIFIED_SEARCH_TOOL)
    if (unified) return unified
    const legacy = this.resolveTool(
      mode === "semantic" ? LEGACY_SEMANTIC_TOOL : LEGACY_LEXICAL_TOOL,
    )
    if (legacy) return legacy
    throw new BluebirdError(
      `Bluebird does not advertise a ${mode} code-search tool.`,
      { retriable: false },
    )
  }

  private async callWithRetry(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const delays = [1000, 2000, 4000]
    let observedTokenGen = this.tokenGeneration
    let observedSessionGen = this.sessionGeneration
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const curSessionGen = this.sessionGeneration
        const res = await this.post(
          {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "tools/call",
            params: { name: tool, arguments: args },
          },
          signal,
          curSessionGen,
        )
        if (res.error) {
          throw new BluebirdError(`Bluebird tool error: ${res.error.message ?? "unknown error"}`, {
            retriable: false,
          })
        }
        if (this.disposed || curSessionGen !== this.sessionGeneration) {
          throw new BluebirdError("Bluebird client session invalidated during request.", { retriable: false })
        }
        return res.result
      } catch (err) {
        if (signal?.aborted || this.disposed) throw err
        // Single-flight token refresh across concurrent 401s: if another
        // caller already bumped tokenGeneration since we started (or last
        // observed it), reuse that refresh instead of triggering a second one.
        if (err instanceof BluebirdError && err.status === 401) {
          const staleInit = this.initialization
          if (this.tokenGeneration === observedTokenGen) {
            await waitForSignal(this.refreshToken(), signal)
          }
          observedTokenGen = this.tokenGeneration
          observedSessionGen = this.sessionGeneration
          // Compare-and-swap: only null out `initialization` if it is still
          // the same (stale) reference this caller observed before the
          // refresh. Two callers can both pass the generation check above
          // (both saw the same stale generation before either refreshed);
          // without this guard, whichever of them resumes second would wipe
          // out the fresh initialization the first one already created,
          // triggering a redundant second `initialize` cycle.
          if (this.initialization === staleInit) this.initialization = undefined
          await this.initialize(signal)
          continue
        }
        // Single-flight session recreation across concurrent 404s (expired
        // MCP session): only the first caller to observe the current
        // sessionGeneration resets it; later callers just re-await the
        // in-flight re-initialize.
        if (err instanceof BluebirdError && err.status === 404) {
          if (this.sessionGeneration === observedSessionGen) {
            this.resetSession()
            this.initialization = undefined
          }
          observedSessionGen = this.sessionGeneration
          await this.initialize(signal)
          continue
        }
        const retriable = err instanceof BluebirdError ? err.retriable : true
        if (!retriable || attempt >= delays.length) throw err
        const retryAfter = err instanceof BluebirdError ? err.retryAfterMs : undefined
        await sleep(retryAfter ?? delays[attempt], signal)
      }
    }
    throw new BluebirdError("Bluebird request failed after retries.", { retriable: false })
  }

  /** Lexical path: indexed keyword search. */
  async searchFileContent(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.searchTool("lexical")
    const result = await this.callWithRetry(
      tool,
      this.shapeArgs(tool, query, opts, "lexical"),
      opts.signal,
    )
    const rows = rowsFromCallResult(result)
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows
  }

  /** Semantic path: code-aware vector search. */
  async doVectorSearch(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.searchTool("semantic")
    const result = await this.callWithRetry(
      tool,
      this.shapeArgs(tool, query, opts, "semantic"),
      opts.signal,
    )
    const rows = rowsFromCallResult(result)
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows
  }

  /** Best-effort MCP session teardown for manager-owned clients. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposalController.abort(
      new BluebirdError("Bluebird client has been disposed.", { retriable: false }),
    )
    this.sessionGeneration++
    const sessionId = this.sessionId
    this.sessionId = undefined
    this.initialized = false
    this.toolSchemas.clear()
    if (!sessionId) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    timer.unref?.()
    try {
      await fetch(this.baseUrl, {
        method: "DELETE",
        headers: {
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": BLUEBIRD_PROTOCOL_VERSION,
          Authorization: `Bearer ${this.token}`,
          "Mcp-Session-Id": sessionId,
        },
        signal: controller.signal,
      })
    } catch {
      // Teardown is best-effort and must never mask the operation's outcome.
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface ProvisionedBluebird {
  client: BluebirdMcpClient
  organization: string
  project: string
  repositories: Array<string>
  branch: string | null
}

/**
 * Detect the Azure DevOps scope for `workspace`, fetch an `az` token, and
 * build an initialized client. Local Git remotes are authoritative for scope
 * discovery. The branch header is sent only when the current branch is indexed;
 * otherwise the repo default branch is used (mirrors the VS Code extension). Throws
 * `BluebirdError` with an actionable message — never returns null — so
 * callers surface the cause instead of silently degrading.
 */
export interface ResolvedBluebirdProvision {
  organization: string
  project: string
  repositories: Array<string>
  branch: string | null
  token: string
}

async function resolveBluebirdProvisionFromWorkspace(
  workspace: string,
  signal?: AbortSignal,
): Promise<ResolvedBluebirdProvision> {
  let primary: Awaited<ReturnType<typeof getAzureRepoFromGit>>
  try {
    primary = await getAzureRepoFromGit(workspace, signal)
  } catch (err) {
    throw err instanceof BluebirdError
      ? err
      : new BluebirdError(
        sanitizeBluebirdDetail(err),
        { retriable: false },
      )
  }
  const repositories = [primary.repository]

  let token: string
  try {
    token = await getBluebirdToken(signal)
  } catch (err) {
    throw err instanceof BluebirdError
      ? err
      : new BluebirdError(
        `Bluebird auth failed: ${sanitizeBluebirdDetail(err)}`,
        { retriable: false },
      )
  }

  let branch: string | null
  try {
    const current = await getCurrentBranch(workspace, signal)
    if (current) {
      const status = await checkBranchIndexStatus(primary, current, token, signal)
      branch = status.isIndexed
        ? status.branch
        : await getDefaultBranch(primary, workspace, signal)
    } else {
      branch = await getDefaultBranch(primary, workspace, signal)
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw err instanceof BluebirdError
      ? err
      : new BluebirdError(sanitizeBluebirdDetail(err), { retriable: false })
  }
  return {
    organization: primary.organization,
    project: primary.project,
    repositories,
    branch,
    token,
  }
}

type ResolveBluebirdProvision = (
  workspace: string,
  signal?: AbortSignal,
) => Promise<ResolvedBluebirdProvision>
type CreateBluebirdClient = (scope: ResolvedBluebirdProvision) => BluebirdMcpClient

function clientForScope(scope: ResolvedBluebirdProvision): BluebirdMcpClient {
  return new BluebirdMcpClient(
    {
      organization: scope.organization,
      project: scope.project,
      repositories: scope.repositories,
      ...(scope.branch ? { branch: scope.branch } : {}),
    },
    scope.token,
  )
}

export async function provisionBluebird(
  workspace: string,
  signal?: AbortSignal,
): Promise<ProvisionedBluebird> {
  const scope = await resolveBluebirdProvisionFromWorkspace(workspace, signal)
  const client = clientForScope(scope)
  try {
    await client.initialize(signal)
  } catch (err) {
    await client.dispose().catch(() => {})
    throw err
  }
  return {
    client,
    organization: scope.organization,
    project: scope.project,
    repositories: scope.repositories,
    branch: scope.branch,
  }
}

/**
 * Return the shared client, provisioning on first use and caching in
 * `state` (v1: one primary scope per launch). Callers pass the query's
 * workspace so detection tracks "the repo we are working with", not the
 * launch cwd. Throws `BluebirdError` when provisioning fails.
 */
interface BluebirdManagerEntry {
  promise: Promise<BluebirdMcpClient>
  client: BluebirdMcpClient
  scope: ResolvedBluebirdProvision
}

function publishScope(entry: BluebirdManagerEntry): void {
  state.bluebirdClient = entry.client
  state.bluebirdOrganization = entry.scope.organization
  state.bluebirdProject = entry.scope.project
  state.bluebirdRepositories = [...entry.scope.repositories]
  state.bluebirdBranch = entry.scope.branch
}

/** Runtime-owned, workspace/scope-isolated Bluebird client registry. */
export class BluebirdClientManager {
  private readonly entries = new Map<string, BluebirdManagerEntry>()
  private readonly workspaces = new Map<string, BluebirdManagerEntry>()
  private readonly workspaceFlights = new Map<string, Promise<BluebirdMcpClient>>()
  private readonly activeFlights = new Set<Promise<unknown>>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly resolveProvision: ResolveBluebirdProvision
  private readonly createClient: CreateBluebirdClient
  private generation = 0

  constructor(
    resolveProvision: ResolveBluebirdProvision = resolveBluebirdProvisionFromWorkspace,
    createClient: CreateBluebirdClient = clientForScope,
  ) {
    this.resolveProvision = resolveProvision
    this.createClient = createClient
  }

  async getOrCreate(workspace: string, signal?: AbortSignal): Promise<BluebirdMcpClient> {
    const workspaceKey = canonicalWorkspace(workspace)
    const cached = this.workspaces.get(workspaceKey)
    if (cached) {
      publishScope(cached)
      return waitForSignal(cached.promise, signal)
    }
    const existingFlight = this.workspaceFlights.get(workspaceKey)
    if (existingFlight) return waitForSignal(existingFlight, signal)

    const generation = this.generation
    // Manager-owned cancellation for this provisioning flight: neutralized by
    // `disposeAll()` regardless of whether any individual caller is still
    // waiting, and independent of any one caller's own signal so one caller
    // abandoning its wait cannot cancel the shared flight for the others.
    const flightController = new AbortController()
    this.activeControllers.add(flightController)

    let createdClient: BluebirdMcpClient | undefined
    const init = (async (): Promise<BluebirdMcpClient> => {
      const scope = await this.resolveProvision(workspace, flightController.signal)
      if (generation !== this.generation || flightController.signal.aborted) {
        throw new BluebirdError("Bluebird client manager was disposed during provisioning.", {
          retriable: false,
        })
      }
      const key = scopeFingerprint(workspaceKey, scope)
      const existing = this.entries.get(key)
      if (existing) {
        this.workspaces.set(workspaceKey, existing)
        publishScope(existing)
        return existing.promise
      }

      const client = this.createClient(scope)
      createdClient = client
      const promise = client.initialize(flightController.signal)
        .then(() => {
          if (generation !== this.generation || flightController.signal.aborted) {
            throw new BluebirdError("Bluebird client manager was disposed during initialization.", {
              retriable: false,
            })
          }
          publishScope({ promise, client, scope })
          return client
        })
        .catch(async (err) => {
          await client.dispose()
          if (this.entries.get(key)?.client === client) this.entries.delete(key)
          if (this.workspaces.get(workspaceKey)?.client === client) {
            this.workspaces.delete(workspaceKey)
          }
          throw err
        })
      const entry: BluebirdManagerEntry = { promise, client, scope }
      this.entries.set(key, entry)
      this.workspaces.set(workspaceKey, entry)
      return promise
    })()

    this.activeFlights.add(init)
    this.workspaceFlights.set(workspaceKey, init)
    init.finally(() => {
      this.activeControllers.delete(flightController)
      this.activeFlights.delete(init)
      if (this.workspaceFlights.get(workspaceKey) === init) {
        this.workspaceFlights.delete(workspaceKey)
      }
      // A client created after this manager generation was invalidated (the
      // flight lost the disposeAll race) must never survive unpublished —
      // dispose it even though disposeAll's own sweep already ran.
      if (generation !== this.generation && createdClient) {
        createdClient.dispose().catch(() => {})
      }
    }).catch(() => {})
    return waitForSignal(init, signal)
  }

  async disposeAll(): Promise<void> {
    this.generation++
    for (const controller of this.activeControllers) {
      controller.abort(
        new BluebirdError("Bluebird client manager has been disposed.", { retriable: false }),
      )
    }
    this.activeControllers.clear()
    this.workspaceFlights.clear()
    this.workspaces.clear()
    const entries = [...this.entries.values()]
    this.entries.clear()
    state.bluebirdClient = null
    state.bluebirdOrganization = null
    state.bluebirdProject = null
    state.bluebirdRepositories = []
    state.bluebirdBranch = null

    // Wait for (or let error out) any flights still in progress so a
    // provisioning client created after invalidation cannot outlive
    // disposal unpublished — the flight's own `.finally()` disposes it.
    const pendingFlights = [...this.activeFlights]
    this.activeFlights.clear()

    await Promise.allSettled([
      ...entries.map((entry) => entry.client.dispose()),
      ...pendingFlights,
    ])
  }
}

const bluebirdManager = new BluebirdClientManager()
let testingClient: BluebirdMcpClient | undefined

/** Install a client without Azure discovery for focused routing tests. */
export function setBluebirdClientForTesting(client: BluebirdMcpClient | undefined): void {
  testingClient = client
}

/** Reset manager and test seams between isolated test cases. */
export async function resetBluebirdManagerForTesting(): Promise<void> {
  testingClient = undefined
  await bluebirdManager.disposeAll()
}

export async function disposeBluebirdClients(): Promise<void> {
  await bluebirdManager.disposeAll()
}

export async function ensureBluebirdClient(
  workspace: string,
  signal?: AbortSignal,
): Promise<BluebirdMcpClient> {
  if (testingClient) return waitForSignal(Promise.resolve(testingClient), signal)
  const client = await bluebirdManager.getOrCreate(workspace, signal)
  state.bluebirdClient = client
  return client
}

/** Human-readable scope line for launch logs (null when unprovisioned). */
export function bluebirdScopeSummary(): string | null {
  if (!state.bluebirdOrganization || !state.bluebirdProject) return null
  const repos = state.bluebirdRepositories.length > 0 ? state.bluebirdRepositories.join(",") : "?"
  const branch = state.bluebirdBranch ? ` @ ${state.bluebirdBranch}` : ""
  return `${state.bluebirdOrganization}/${state.bluebirdProject} [${repos}]${branch}`
}
