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
 * (`499b84ac-1321-427f-aa17-267ca6975798/.default`, the same scope the
 * Bluebird VS Code extension requests). `BLUEBIRD_TOKEN` env overrides for
 * tests and manual runs. 401 refreshes the token once and retries.
 *
 * Retry: retriable statuses (429/500/502/503/504) and transport errors are
 * retried up to 3 attempts with exponential backoff (1s/2s/4s). Anything
 * else throws a `BluebirdError` the caller surfaces in `notice` — there is
 * deliberately NO silent fallback to the local engine under `--bluebird`.
 */

import { execFile } from "node:child_process"
import process from "node:process"

import {
  checkBranchIndexStatus,
  getAzureRepoFromAz,
  getAzureReposFromGit,
  getCurrentBranch,
  getDefaultBranch,
} from "./azure-repo"
import { state } from "./state"
import type { UnifiedResultRow } from "./unified-code-search"

export const BLUEBIRD_MCP_URL = "https://mcp.bluebird-ai.net/"
export const BLUEBIRD_TOKEN_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798/.default"
export const BLUEBIRD_PROTOCOL_VERSION = "2025-06-18"

export class BluebirdError extends Error {
  readonly retriable: boolean
  readonly status?: number
  constructor(message: string, opts: { retriable?: boolean; status?: number } = {}) {
    super(message)
    this.name = "BluebirdError"
    this.retriable = opts.retriable ?? false
    if (opts.status !== undefined) this.status = opts.status
  }
}

export interface BluebirdScope {
  organization: string
  project: string
  /** All repos in the org/project group (comma-joined into one header). */
  repositories: Array<string>
  branch?: string
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runAzToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        BLUEBIRD_TOKEN_RESOURCE,
        "--query",
        "accessToken",
        "--output",
        "tsv",
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? "").trim() || error.message
          reject(
            new BluebirdError(
              `az token acquisition failed (${detail}). Run \`az login\` and retry.`,
              { retriable: false },
            ),
          )
          return
        }
        const token = String(stdout ?? "").trim()
        if (!token) {
          reject(new BluebirdError("az returned an empty access token.", { retriable: false }))
          return
        }
        resolve(token)
      },
    )
  })
}

/** Token source: explicit env first (tests/manual), else `az` CLI. */
export async function getBluebirdToken(): Promise<string> {
  const env = process.env.BLUEBIRD_TOKEN?.trim()
  if (env) return env
  return runAzToken()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Parse an MCP Streamable-HTTP response: plain JSON or SSE `data:` frames. */
function parseJsonRpcPayload(text: string, contentType: string | null): JsonRpcResponse {
  if (contentType?.includes("text/event-stream")) {
    const frames: Array<string> = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("data:")) frames.push(trimmed.slice("data:".length).trim())
    }
    // The last data frame carrying a JSON-RPC envelope wins (earlier frames
    // may be progress notifications).
    for (let i = frames.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(frames[i]) as JsonRpcResponse
        if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed
      } catch {
        // keep scanning
      }
    }
    throw new BluebirdError("Bluebird returned an SSE stream with no JSON-RPC result.", {
      retriable: true,
    })
  }
  try {
    return JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new BluebirdError("Bluebird returned a non-JSON response.", { retriable: true })
  }
}

const QUERY_KEYS = ["query", "searchText", "search_text", "text", "q", "question"]
const LIMIT_KEYS = ["limit", "top", "maxResults", "max_results", "pageSize", "count"]
const GLOB_KEYS = ["file_glob", "fileGlob", "filePattern", "file_pattern", "glob", "pathFilter"]

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
    ?? asString(item.path) ?? asString(item.repoRelativePath)
  const line =
    asNumber(item.line) ?? asNumber(item.lineNumber) ?? asNumber(item.line_number)
    ?? asNumber(item.startLine) ?? asNumber(item.start_line) ?? 1
  const snippet =
    asString(item.snippet) ?? asString(item.content) ?? asString(item.text)
    ?? asString(item.excerpt) ?? asString(item.preview)
  if (!file || !snippet) return null
  const row: UnifiedResultRow = { file, line: Math.max(1, Math.floor(line)), snippet }
  const score = asNumber(item.score) ?? asNumber(item.relevance) ?? asNumber(item.similarity)
  if (score !== undefined) row.score = score
  const endLine = asNumber(item.endLine) ?? asNumber(item.end_line)
  if (endLine !== undefined) row.endLine = endLine
  const name = asString(item.name) ?? asString(item.symbol)
  if (name) row.name = name
  return row
}

/** Extract rows from a `tools/call` result envelope. */
function rowsFromCallResult(result: unknown): Array<UnifiedResultRow> {
  if (!isRecord(result)) throw new BluebirdError("Bluebird returned an empty result.", { retriable: true })
  if (result.isError === true) {
    const detail = Array.isArray(result.content)
      ? result.content.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join(" ").trim()
      : ""
    throw new BluebirdError(`Bluebird tool error${detail ? `: ${detail.slice(0, 500)}` : ""}`, {
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
  const structured = (result as Record<string, unknown>).results
    ?? (result as Record<string, unknown>).items
  if (Array.isArray(structured)) {
    const rows = structured
      .map((item, i) => toRow(item, i))
      .filter((r): r is UnifiedResultRow => r !== null)
    if (rows.length > 0) return rows
  }
  for (const text of texts) {
    const trimmed = text.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const arr = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.results)
          ? parsed.results
          : isRecord(parsed) && Array.isArray(parsed.items)
            ? parsed.items
            : null
      if (arr) {
        const rows = arr
          .map((item, i) => toRow(item, i))
          .filter((r): r is UnifiedResultRow => r !== null)
        if (rows.length > 0) return rows
      }
    } catch {
      // Not JSON — keep scanning other blocks.
    }
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
  private nextId = 1

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
    return headers
  }

  private async post(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    if (res.status === 401) {
      throw new BluebirdError("Bluebird rejected the access token (401).", {
        retriable: false,
        status: 401,
      })
    }
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      throw new BluebirdError(`Bluebird responded with HTTP ${res.status}.`, {
        retriable: true,
        status: res.status,
      })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BluebirdError(
        `Bluebird responded with HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}.`,
        { retriable: false, status: res.status },
      )
    }
    const text = await res.text()
    return parseJsonRpcPayload(text, res.headers.get("content-type"))
  }

  /** MCP `initialize` + `tools/list`. Caches input schemas for arg shaping. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return
    const init = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: BLUEBIRD_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "github-router", version: "bluebird" },
        },
      },
      signal,
    )
    if (init.error) {
      throw new BluebirdError(`Bluebird initialize failed: ${init.error.message ?? "unknown error"}`, {
        retriable: false,
      })
    }
    const listed = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} },
      signal,
    )
    if (listed.error) {
      throw new BluebirdError(`Bluebird tools/list failed: ${listed.error.message ?? "unknown error"}`, {
        retriable: false,
      })
    }
    const tools = isRecord(listed.result) && Array.isArray(listed.result.tools)
      ? (listed.result.tools as Array<unknown>)
      : []
    for (const tool of tools) {
      if (isRecord(tool) && typeof tool.name === "string") {
        this.toolSchemas.set(tool.name, tool.inputSchema ?? null)
      }
    }
    // Best-effort initialized notification; failures are non-fatal.
    try {
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal)
    } catch {
      // ignore
    }
    this.initialized = true
  }

  /** Resolve the server's tool name by suffix (server prefixes vary). */
  private resolveTool(suffix: string): string {
    for (const name of this.toolSchemas.keys()) {
      if (name === suffix || name.endsWith(`_${suffix}`) || name.endsWith(`-${suffix}`)) return name
    }
    // Fall back to the bare suffix when tools/list was unreachable or the
    // server uses an unseen prefix — the call error will surface cleanly.
    return suffix
  }

  private shapeArgs(
    tool: string,
    query: string,
    opts: BluebirdSearchOpts,
  ): Record<string, unknown> {
    const schema = this.toolSchemas.get(tool)
    const args: Record<string, unknown> = {}
    const queryKey = pickKey(schema, QUERY_KEYS) ?? "query"
    args[queryKey] = query
    const limitKey = pickKey(schema, LIMIT_KEYS)
    if (limitKey && opts.limit !== undefined) args[limitKey] = opts.limit
    const globKey = pickKey(schema, GLOB_KEYS)
    if (globKey && opts.file_glob) args[globKey] = opts.file_glob
    return args
  }

  private async callWithRetry(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const delays = [1000, 2000, 4000]
    let refreshed = false
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await this.post(
          {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "tools/call",
            params: { name: tool, arguments: args },
          },
          signal,
        )
        if (res.error) {
          throw new BluebirdError(`Bluebird tool error: ${res.error.message ?? "unknown error"}`, {
            retriable: false,
          })
        }
        return res.result
      } catch (err) {
        if (signal?.aborted) throw err
        // Single token refresh on 401, outside the retriable budget.
        if (err instanceof BluebirdError && err.status === 401 && !refreshed) {
          refreshed = true
          this.token = await getBluebirdToken()
          continue
        }
        const retriable = err instanceof BluebirdError ? err.retriable : true
        if (!retriable || attempt >= delays.length) throw err
        await sleep(delays[attempt])
      }
    }
    throw new BluebirdError("Bluebird request failed after retries.", { retriable: false })
  }

  /** Lexical path: indexed keyword search. */
  async searchFileContent(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.resolveTool("search_file_content")
    const result = await this.callWithRetry(tool, this.shapeArgs(tool, query, opts), opts.signal)
    const rows = rowsFromCallResult(result)
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows
  }

  /** Semantic path: code-aware vector search. */
  async doVectorSearch(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.resolveTool("do_vector_search")
    const result = await this.callWithRetry(tool, this.shapeArgs(tool, query, opts), opts.signal)
    const rows = rowsFromCallResult(result)
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows
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
 * build an initialized client. Detection order: local git remotes first
 * (instant, offline), `az repos show --detect` as fallback. The branch
 * header is sent only when the current branch is indexed; otherwise the
 * repo default branch is used (mirrors the VS Code extension). Throws
 * `BluebirdError` with an actionable message — never returns null — so
 * callers surface the cause instead of silently degrading.
 */
export async function provisionBluebird(
  workspace: string,
  signal?: AbortSignal,
): Promise<ProvisionedBluebird> {
  let repos = await getAzureReposFromGit(workspace)
  if (repos.length === 0) {
    const azRepo = await getAzureRepoFromAz(workspace)
    if (azRepo) repos = [azRepo]
  }
  if (repos.length === 0) {
    throw new BluebirdError(
      "No Azure DevOps repository detected for this workspace "
      + "(git remotes contain no dev.azure.com/visualstudio.com URL and `az repos show --detect` found nothing). "
      + "Bluebird search needs an Azure DevOps checkout; exact/regex/ast modes still use the local engine.",
      { retriable: false },
    )
  }
  // V1 scope: the first org/project group wins; every repo in that group is
  // sent comma-separated in `x-mcp-ec-repository` (the extension's own
  // grouping). Cross-org workspaces reuse this primary scope.
  const primary = repos[0]
  const group = repos.filter(
    (r) =>
      r.organization.toLowerCase() === primary.organization.toLowerCase()
      && r.project.toLowerCase() === primary.project.toLowerCase(),
  )
  const repositories = [...new Set(group.map((r) => r.repository))]

  let token: string
  try {
    token = await getBluebirdToken()
  } catch (err) {
    throw err instanceof BluebirdError
      ? err
      : new BluebirdError(
        `Bluebird auth failed: ${err instanceof Error ? err.message : String(err)}`,
        { retriable: false },
      )
  }

  // Branch awareness: prefer the working branch when indexed, else the
  // repo default branch, else no branch header (server default scope).
  let branch: string | null
  const current = await getCurrentBranch(workspace)
  if (current) {
    const status = await checkBranchIndexStatus(primary, current, token)
    if (signal?.aborted) throw new BluebirdError("Bluebird provision aborted.", { retriable: false })
    if (status.isIndexed) {
      branch = status.branch
    } else {
      branch = await getDefaultBranch(primary, workspace)
    }
  } else {
    branch = await getDefaultBranch(primary, workspace)
  }

  const client = new BluebirdMcpClient(
    {
      organization: primary.organization,
      project: primary.project,
      repositories,
      ...(branch ? { branch } : {}),
    },
    token,
  )
  await client.initialize(signal)
  return {
    client,
    organization: primary.organization,
    project: primary.project,
    repositories,
    branch,
  }
}

/**
 * Return the shared client, provisioning on first use and caching in
 * `state` (v1: one primary scope per launch). Callers pass the query's
 * workspace so detection tracks "the repo we are working with", not the
 * launch cwd. Throws `BluebirdError` when provisioning fails.
 */
export async function ensureBluebirdClient(
  workspace: string,
  signal?: AbortSignal,
): Promise<BluebirdMcpClient> {
  if (state.bluebirdClient) return state.bluebirdClient
  const provisioned = await provisionBluebird(workspace, signal)
  state.bluebirdClient = provisioned.client
  state.bluebirdOrganization = provisioned.organization
  state.bluebirdProject = provisioned.project
  state.bluebirdRepositories = provisioned.repositories
  state.bluebirdBranch = provisioned.branch
  return provisioned.client
}

/** Human-readable scope line for launch logs (null when unprovisioned). */
export function bluebirdScopeSummary(): string | null {
  if (!state.bluebirdOrganization || !state.bluebirdProject) return null
  const repos = state.bluebirdRepositories.length > 0 ? state.bluebirdRepositories.join(",") : "?"
  const branch = state.bluebirdBranch ? ` @ ${state.bluebirdBranch}` : ""
  return `${state.bluebirdOrganization}/${state.bluebirdProject} [${repos}]${branch}`
}
