/**
 * Shared streamable-HTTP MCP transport (protocol 2025-06-18).
 *
 * Extracted from the Bluebird client so the Azure DevOps MCP group can reuse
 * the same JSON-RPC framing, JSON-or-SSE response parsing, stateless-or-session
 * handling, single-flight token refresh, and 401/404 recovery without a second
 * implementation of any of it.
 *
 * What deliberately stays OUT of this file: the endpoint and its auth (a
 * `tokenProvider` closure), any static scope headers, the tool set the server
 * is expected to advertise, and everything about interpreting a `tools/call`
 * result. The transport knows nothing about code search, and a caller that
 * wants a filtered tool listing does the filtering itself.
 *
 * Retry: retriable statuses (429/500/502/503/504) and transport errors are
 * retried up to 3 attempts with exponential backoff (1s/2s/4s); a 401 refreshes
 * the token and re-initializes once; a 404 recreates the session. Anything else
 * throws an instance of the configured `errorClass` for the caller to surface.
 */

import { sanitizeTransportText } from "./upstream-retry"

export interface RemoteMcpToolSchema {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface RemoteMcpErrorOptions {
  retriable?: boolean
  status?: number
  retryAfterMs?: number
}

export type RemoteMcpErrorCtor = new (
  message: string,
  opts?: RemoteMcpErrorOptions,
) => RemoteMcpError

/**
 * Base error for a remote MCP client. Subclasses exist so a caller can catch
 * exactly one service's failures (`BluebirdError`, `AdoError`) while every
 * client shares this class's `retriable`/`status`/`retryAfterMs` contract,
 * which is what the retry and recovery paths actually read.
 */
export class RemoteMcpError extends Error {
  readonly retriable: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(message: string, opts: RemoteMcpErrorOptions = {}) {
    super(sanitizeRemoteDetail(message))
    this.name = "RemoteMcpError"
    this.retriable = opts.retriable ?? false
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

export interface RemoteMcpClientConfig {
  /** Human-readable server name used in every message (e.g. "Bluebird"). */
  label: string
  baseUrl: string
  protocolVersion: string
  /** `clientInfo.name` sent in `initialize`. */
  clientName: string
  /** `clientInfo.version` sent in `initialize`. */
  clientVersion: string
  /** Concrete error class every failure is constructed from. */
  errorClass: RemoteMcpErrorCtor
  /** Bearer token for the first request. */
  token: string
  /** Mints a replacement token on a 401. */
  tokenProvider: (signal?: AbortSignal) => Promise<string>
  /** Headers merged into every request (scope headers, toolset controls). */
  staticHeaders?: () => Record<string, string>
  /**
   * Called with the fully-paginated tool map before it is published. Throwing
   * rejects initialization, which is how a client pins the tool set it needs.
   */
  validateTools?: (tools: ReadonlyMap<string, RemoteMcpToolSchema>) => void
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface ComposedSignal {
  signal: AbortSignal
  cleanup: () => void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Strip credentials and infrastructure detail from anything that may reach a
 * log or a tool result. Bearer tokens, absolute URLs, and `git@` remotes are
 * replaced wholesale: a sanitizer that tries to keep the "useful" part of a
 * secret is one regex bug away from leaking it.
 */
export function sanitizeRemoteDetail(value: unknown): string {
  return sanitizeTransportText(
    value instanceof Error ? value.message : String(value),
  )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:https?|ssh):\/\/[^\s"'<>]+/gi, "[REDACTED URL]")
    .replace(/\bgit@[^\s:]+:[^\s]+/gi, "[REDACTED REMOTE]")
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (
    err.name === "AbortError"
    || err.message === "aborted"
    || err.message === "This operation was aborted"
  )
}

export function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

export function canonicalWorkspace(workspace: string): string {
  return workspace.replace(/[\\/]+$/, "").toLowerCase() || workspace.toLowerCase()
}

export function scopeFingerprint(
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

function parseJsonResponse(
  text: string,
  expectedId: unknown,
  errorClass: RemoteMcpErrorCtor,
  label: string,
): JsonRpcResponse {
  try {
    const response = matchingJsonRpcResponse(JSON.parse(text), expectedId)
    if (response) return response
  } catch {
    // Report one stable protocol error below rather than leaking parser details.
  }
  throw new errorClass(`${label} returned no matching JSON-RPC response.`, { retriable: true })
}

async function parseSseResponse(
  response: Response,
  expectedId: unknown,
  errorClass: RemoteMcpErrorCtor,
  label: string,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted")
  }
  if (!response.body) {
    throw new errorClass(`${label} returned an empty SSE response.`, { retriable: true })
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
  throw new errorClass(`${label} returned no matching JSON-RPC response.`, { retriable: true })
}

/**
 * One streamable-HTTP MCP session: `initialize` → `notifications/initialized`
 * → paginated `tools/list` → `tools/call`, with JSON or SSE responses and
 * optional server-assigned session ids.
 */
export class RemoteMcpClient {
  protected readonly config: RemoteMcpClientConfig
  protected readonly baseUrl: string
  protected toolSchemas = new Map<string, RemoteMcpToolSchema>()
  private token: string
  private initialized = false
  private initialization: Promise<void> | undefined
  private refreshPromise: Promise<void> | undefined
  private sessionId: string | undefined
  private nextId = 1
  private disposed = false
  private readonly disposalController = new AbortController()
  private tokenGeneration = 0
  private sessionGeneration = 0

  constructor(config: RemoteMcpClientConfig) {
    this.config = config
    this.baseUrl = config.baseUrl
    this.token = config.token
  }

  protected error(message: string, opts: RemoteMcpErrorOptions = {}): RemoteMcpError {
    return new this.config.errorClass(message, opts)
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.config.protocolVersion,
      Authorization: `Bearer ${this.token}`,
      ...(this.config.staticHeaders?.() ?? {}),
      ...extra,
    }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    return headers
  }

  private composeRequestSignal(
    caller: AbortSignal | undefined,
    timeoutMs = 30_000,
  ): ComposedSignal {
    const disposal = this.disposalController.signal
    const controller = new AbortController()
    const onCallerAbort = () => {
      controller.abort(caller?.reason ?? new Error("aborted"))
    }
    const onDisposalAbort = () => {
      controller.abort(
        disposal?.reason ?? this.error(`${this.config.label} client has been disposed.`, { retriable: false }),
      )
    }

    if (disposal?.aborted) onDisposalAbort()
    else disposal?.addEventListener("abort", onDisposalAbort, { once: true })

    if (caller?.aborted) onCallerAbort()
    else caller?.addEventListener("abort", onCallerAbort, { once: true })

    const timer = setTimeout(() => {
      controller.abort(new Error(`${this.config.label} request timed out`))
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

  private disposedError(): RemoteMcpError {
    return this.error(`${this.config.label} client has been disposed.`, { retriable: false })
  }

  private async post(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    requestSessionGen?: number,
  ): Promise<JsonRpcResponse> {
    const label = this.config.label
    if (this.disposed) throw this.disposedError()
    const { signal: requestSignal, cleanup } = this.composeRequestSignal(signal)
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
        if (this.disposed) throw this.disposedError()
        if (isAbortError(err) || requestSignal.aborted) {
          throw this.error(
            signal?.aborted
              ? `${label} request was cancelled.`
              : `${label} request timed out.`,
            { retriable: false },
          )
        }
        throw this.error(
          `${label} transport failed: ${sanitizeRemoteDetail(err)}`,
          { retriable: true },
        )
      }
      if (this.disposed) throw this.disposedError()
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
        throw this.error(`${label} rejected the access token (401).`, {
          retriable: false,
          status: 401,
        })
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"))
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        throw this.error(`${label} responded with HTTP ${res.status}.`, {
          retriable: true,
          status: res.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        })
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        const detail = body ? sanitizeTransportText(body).slice(0, 300) : ""
        throw this.error(
          `${label} responded with HTTP ${res.status}${detail ? `: ${detail}` : ""}.`,
          { retriable: false, status: res.status },
        )
      }
      if (notification && (res.status === 202 || res.status === 204)) {
        return { jsonrpc: "2.0" }
      }
      const contentType = res.headers.get("content-type")
      if (contentType?.includes("text/event-stream")) {
        try {
          return await parseSseResponse(res, payload.id, this.config.errorClass, label, requestSignal)
        } catch (err) {
          if (this.disposed) throw this.disposedError()
          if (isAbortError(err) || requestSignal.aborted) {
            throw this.error(
              signal?.aborted
                ? `${label} request was cancelled.`
                : `${label} request timed out.`,
              { retriable: false },
            )
          }
          throw err
        }
      }
      const text = await res.text()
      if (notification && !text.trim()) return { jsonrpc: "2.0" }
      return parseJsonResponse(text, payload.id, this.config.errorClass, label)
    } finally {
      cleanup()
    }
  }

  /** MCP `initialize`, initialized notification, then paginated `tools/list`. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw this.disposedError()
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
        this.token = await this.config.tokenProvider(this.disposalController.signal)
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
        if (err instanceof RemoteMcpError && err.status === 401 && !refreshed) {
          refreshed = true
          await waitForSignal(this.refreshToken(), signal)
          continue
        }
        const retriable = err instanceof RemoteMcpError ? err.retriable : true
        if (!retriable || attempt >= delays.length) throw err
        const retryAfter = err instanceof RemoteMcpError ? err.retryAfterMs : undefined
        await sleep(retryAfter ?? delays[attempt], signal)
      }
    }
  }

  private async initializeOnce(signal?: AbortSignal): Promise<void> {
    const label = this.config.label
    const curSessionGen = this.sessionGeneration
    const init = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: this.config.protocolVersion,
        capabilities: {},
        clientInfo: { name: this.config.clientName, version: this.config.clientVersion },
      },
    }, signal, curSessionGen)
    if (init.error) {
      throw this.error(`${label} initialize failed: ${init.error.message ?? "unknown error"}`, {
        retriable: false,
      })
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, curSessionGen)

    const stagedSchemas = new Map<string, RemoteMcpToolSchema>()
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
        throw this.error(`${label} tools/list failed: ${listed.error.message ?? "unknown error"}`, {
          retriable: false,
        })
      }
      if (!isRecord(listed.result) || !Array.isArray(listed.result.tools)) {
        throw this.error(`${label} tools/list returned an invalid result.`, { retriable: false })
      }
      for (const tool of listed.result.tools) {
        if (isRecord(tool) && typeof tool.name === "string") {
          const entry: RemoteMcpToolSchema = { name: tool.name, inputSchema: tool.inputSchema ?? null }
          if (typeof tool.description === "string") entry.description = tool.description
          stagedSchemas.set(tool.name, entry)
        }
      }
      const nextCursor = listed.result.nextCursor
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
        cursor = undefined
      } else if (typeof nextCursor !== "string") {
        throw this.error(`${label} tools/list returned an invalid cursor.`, { retriable: false })
      } else if (seenCursors.has(nextCursor)) {
        throw this.error(`${label} tools/list repeated a pagination cursor.`, { retriable: false })
      } else {
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    } while (cursor)

    this.config.validateTools?.(stagedSchemas)

    if (this.disposed || curSessionGen !== this.sessionGeneration) {
      throw this.error(`${label} client session invalidated during initialization.`, { retriable: false })
    }
    // Atomic schema publication: only a fully-populated, still-current
    // schema map ever becomes visible to callers.
    this.toolSchemas = stagedSchemas
    this.initialized = true
  }

  /** Resolve an advertised tool name by suffix (server prefixes vary). */
  protected resolveTool(suffix: string): string | undefined {
    for (const name of this.toolSchemas.keys()) {
      if (name === suffix || name.endsWith(`_${suffix}`) || name.endsWith(`-${suffix}`)) return name
    }
    return undefined
  }

  /** Advertised tools, keyed by name. Empty until `initialize` succeeds. */
  listTools(): ReadonlyMap<string, RemoteMcpToolSchema> {
    return this.toolSchemas
  }

  /** One `tools/call` with 401-refresh / 404-session-recovery / backoff retry. */
  protected async callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const label = this.config.label
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
          throw this.error(`${label} tool error: ${res.error.message ?? "unknown error"}`, {
            retriable: false,
          })
        }
        if (this.disposed || curSessionGen !== this.sessionGeneration) {
          throw this.error(`${label} client session invalidated during request.`, { retriable: false })
        }
        return res.result
      } catch (err) {
        if (signal?.aborted || this.disposed) throw err
        // Single-flight token refresh across concurrent 401s: if another
        // caller already bumped tokenGeneration since we started (or last
        // observed it), reuse that refresh instead of triggering a second one.
        if (err instanceof RemoteMcpError && err.status === 401) {
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
        if (err instanceof RemoteMcpError && err.status === 404) {
          if (this.sessionGeneration === observedSessionGen) {
            this.resetSession()
            this.initialization = undefined
          }
          observedSessionGen = this.sessionGeneration
          await this.initialize(signal)
          continue
        }
        const retriable = err instanceof RemoteMcpError ? err.retriable : true
        if (!retriable || attempt >= delays.length) throw err
        const retryAfter = err instanceof RemoteMcpError ? err.retryAfterMs : undefined
        await sleep(retryAfter ?? delays[attempt], signal)
      }
    }
    throw this.error(`${label} request failed after retries.`, { retriable: false })
  }

  /** Best-effort MCP session teardown for manager-owned clients. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposalController.abort(
      this.error(`${this.config.label} client has been disposed.`, { retriable: false }),
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
          "MCP-Protocol-Version": this.config.protocolVersion,
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

/**
 * Extract the text blocks of a `tools/call` result. The `isError` envelope is
 * raised as the client's own error class so a service-level failure is never
 * mistaken for an empty success.
 */
export function mcpResultTexts(
  result: unknown,
  errorClass: RemoteMcpErrorCtor,
  label: string,
): Array<string> {
  if (!isRecord(result)) {
    throw new errorClass(`${label} returned an empty result.`, { retriable: true })
  }
  const texts: Array<string> = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text)
      }
    }
  }
  if (result.isError === true) {
    const detail = texts.join(" ").trim()
    throw new errorClass(`${label} tool error${detail ? `: ${sanitizeTransportText(detail)}` : ""}`, {
      retriable: false,
    })
  }
  return texts
}
