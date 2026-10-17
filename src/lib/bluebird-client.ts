/**
 * Bluebird code-search MCP client (Streamable HTTP, MCP 2025-06-18).
 *
 * The proxy keeps its own `mcp__search__code` schema; this client speaks to
 * the upstream Bluebird server (`https://mcp.bluebird-ai.net/`) and returns
 * plain rows the unified helper maps 1:1. Tool parameter shapes are resolved
 * at runtime from `tools/list` (candidate-key matching) rather than
 * hard-coded, because the server is versioned independently of this repo.
 *
 * Transport (JSON-RPC framing, SSE parsing, session handling, retry, token
 * refresh, 401/404 recovery) lives in `./remote-mcp-client`; this module owns
 * the Bluebird endpoint, its scope headers, its required tool set, and the
 * interpretation of a search result.
 *
 * Auth: `az account get-access-token`, for TWO audiences (see the constants
 * below): the Bluebird MCP endpoint (`f8efec34-…`) and, for the branch-index
 * probe alone, the Azure DevOps resource (`499b84ac-…`). `BLUEBIRD_TOKEN` env
 * overrides both for tests and manual runs. A 401 drops the cached token,
 * re-mints, and retries the request once.
 */

import consola from "consola"

import {
  AzCliAccessTokenCache,
  classifyAzFailure,
  describeAzFailure,
} from "./azure-cli-token"
import {
  checkBranchIndexStatus,
  getAzureRepoFromGit,
  getCurrentBranch,
  getDefaultBranch,
} from "./azure-repo"
import {
  RemoteMcpClient,
  RemoteMcpError,
  canonicalWorkspace,
  isRecord,
  sanitizeRemoteDetail,
  scopeFingerprint,
  waitForSignal,
  type RemoteMcpErrorOptions,
  type RemoteMcpToolSchema,
} from "./remote-mcp-client"
import { state } from "./state"
import { sanitizeTransportText } from "./upstream-retry"
import type { UnifiedResultRow } from "./unified-code-search"

export const BLUEBIRD_MCP_URL = "https://mcp.bluebird-ai.net/"

/**
 * Two resources, one flow. They are NOT interchangeable, and sending one where
 * the other belongs is the exact failure this constant pair exists to prevent:
 * `mcp.bluebird-ai.net` answers 401 to a token minted for the Azure DevOps
 * resource, and `almsearch.dev.azure.com` answers 302-sign-in to a token minted
 * for the Bluebird one. The MCP endpoint declares its audience at
 * `https://mcp.bluebird-ai.net/.well-known/oauth-protected-resource`
 * (`scopes_supported: ["f8efec34-…/.default"]`).
 */
export const BLUEBIRD_MCP_TOKEN_RESOURCE = "f8efec34-6ac0-4538-8a18-ee59319d7338"

/**
 * Azure DevOps, for the branch-index probe (`checkBranchIndexStatus` →
 * `almsearch.dev.azure.com`). Minted only when that probe actually runs.
 *
 * Deliberately a different id from `ADO_TOKEN_RESOURCE` in `ado-client.ts`
 * (`2a72489c-…`, the `mcp.dev.azure.com` audience): same vendor, different
 * audience, and neither substitutes for the other.
 */
export const ADO_CODE_SEARCH_TOKEN_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"

export const BLUEBIRD_PROTOCOL_VERSION = "2025-06-18"

export class BluebirdError extends RemoteMcpError {
  constructor(message: string, opts: RemoteMcpErrorOptions = {}) {
    super(message, opts)
    this.name = "BluebirdError"
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

/** Scope headers every Bluebird request carries. */
function bluebirdScopeHeaders(scope: BluebirdScope): Record<string, string> {
  const headers: Record<string, string> = {
    "x-mcp-ec-organization": scope.organization,
    "x-mcp-ec-project": scope.project,
    "x-mcp-ec-repository": scope.repositories.join(","),
  }
  if (scope.branch) headers["x-mcp-ec-branch"] = scope.branch
  return headers
}

/**
 * Process-lifetime caches, one per audience. Keyed by resource inside the
 * shared cache class, but separate instances so a future `clear` on one cannot
 * silently drop the other's entry.
 */
const bluebirdTokenCache = new AzCliAccessTokenCache()
const adoCodeSearchTokenCache = new AzCliAccessTokenCache()

export interface BluebirdTokenOpts {
  /**
   * Allow one interactive `az login` if the silent mint fails for a
   * credential-shaped reason. Every path that reaches here is call-time (the
   * search a model asked for, or a 401-triggered re-mint), so the login
   * budget cannot be spent under a launch deadline.
   */
  allowInteractiveLogin?: boolean
  /** Re-mint even if a cached token is unexpired (the 401 path). */
  forceRefresh?: boolean
}

/**
 * Token source: explicit env first (tests/manual), else the `az` ladder.
 *
 * `BLUEBIRD_TOKEN` is a single override serving BOTH audiences in this file.
 * That is only safe because it exists for tests and for an operator who is
 * deliberately pinning one — a real Bluebird deployment never sets it.
 */
export async function getBluebirdToken(
  signal?: AbortSignal,
  opts: BluebirdTokenOpts = {},
): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env.BLUEBIRD_TOKEN?.trim()
  if (env) return env
  try {
    return await bluebirdTokenCache.get(BLUEBIRD_MCP_TOKEN_RESOURCE, {
      ...(signal ? { signal } : {}),
      ...(opts.allowInteractiveLogin ? { allowInteractiveLogin: true } : {}),
      ...(opts.forceRefresh ? { forceRefresh: true } : {}),
    })
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new BluebirdError(describeAzFailure("Bluebird", err), { retriable: false })
  }
}

/**
 * The ADO-audience token, for the branch-index probe only. Same env override as
 * `getBluebirdToken` (see the note there).
 */
export async function getAdoCodeSearchToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env.BLUEBIRD_TOKEN?.trim()
  if (env) return env
  try {
    return await adoCodeSearchTokenCache.get(ADO_CODE_SEARCH_TOKEN_RESOURCE, {
      ...(signal ? { signal } : {}),
      allowInteractiveLogin: true,
    })
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new BluebirdError(
      describeAzFailure("Azure DevOps code search", err),
      { retriable: false },
    )
  }
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

/**
 * The deployed `code_search` answers with human-readable reports, not JSON:
 * the lexical method replies with per-file sections of context lines, the
 * semantic method with ranked windows in fenced code blocks. Both shapes were
 * read off the live service (Bluebird 1.0.32298816); a text-only response is
 * what made every search fail with "unexpected tool result shape". The JSON
 * shapes above stay supported because the wire contract is versioned upstream
 * and older deployments did return machine-readable arrays.
 */
const KEYWORD_SECTION_RE = /^Repository:\s*(.+?),\s*Path:\s*(.+?)\s+[—–-]\s/
const KEYWORD_LINE_RE = /^Line\s+(\d+):\s?(.*)$/
const SEMANTIC_HEADER_RE =
  /^\[(\d+)\]\s+\S+\s+(\S+)\s+\(lines?\s+(\d+)(?:\s*-\s*(\d+))?\)\s+similarity=([\d.]+)\s*$/
const SEMANTIC_FILE_RE = /^File:\s*`(.+)`\s*$/
/** One displayed source line; such a line can embed a whole JSON blob. */
const REPORT_LINE_CAP = 2000
/** A semantic window is ~20 lines of source; this bounds a pathological one. */
const REPORT_WINDOW_CAP = 8000

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Lexical report: `Line 48: <code>` entries under `Repository: …, Path: …`
 * headers, with non-matching context lines interleaved and `... (13 lines
 * omitted)` elisions. The service does not mark which displayed lines matched,
 * so the query is the only signal available: a line containing it is a hit. A
 * query that cannot match textually (an `OR`/`NOT` expression, a
 * natural-language phrase) keeps the server's own context selection rather
 * than reporting nothing.
 */
function rowsFromKeywordReport(
  text: string,
  query: string,
): Array<UnifiedResultRow> | null {
  const rows: Array<UnifiedResultRow> = []
  let file: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const section = KEYWORD_SECTION_RE.exec(line)
    if (section?.[2]) {
      file = normalizeRemotePath(section[2])
      continue
    }
    const numbered = KEYWORD_LINE_RE.exec(line)
    if (!numbered || !file) continue
    const lineNumber = positiveInt(numbered[1])
    const snippet = (numbered[2] ?? "").slice(0, REPORT_LINE_CAP)
    if (lineNumber === null || !snippet.trim()) continue
    rows.push({ file, line: lineNumber, snippet })
  }
  if (rows.length === 0) return null
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  const matching = rows.filter((row) =>
    row.snippet.toLowerCase().includes(needle)
  )
  return matching.length > 0 ? matching : rows
}

/**
 * Semantic report: `[1] repo /path (lines 54-74)  similarity=0.664`, then a
 * `File: \`/path\`` line, then the window in a fenced block. `//...` elisions
 * inside a window are the server's own, and are kept as-is.
 */
function rowsFromSemanticReport(text: string): Array<UnifiedResultRow> | null {
  const rows: Array<UnifiedResultRow> = []
  interface PendingWindow {
    file: string
    line: number
    endLine?: number
    score?: number
  }
  let pending: PendingWindow | null = null
  let window: Array<string> = []
  let inFence = false
  const flush = (): void => {
    const record = pending
    if (!record) return
    const snippet = window.join("\n").trim()
    rows.push({
      file: record.file,
      line: record.line,
      ...(record.endLine !== undefined ? { endLine: record.endLine } : {}),
      ...(record.score !== undefined ? { score: record.score } : {}),
      snippet: (snippet || `${record.file}:${record.line}`).slice(
        0,
        REPORT_WINDOW_CAP,
      ),
    })
    pending = null
    window = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (inFence) {
      if (line.trimStart().startsWith("```")) inFence = false
      else window.push(line)
      continue
    }
    const header = SEMANTIC_HEADER_RE.exec(line)
    if (header) {
      flush()
      const file = normalizeRemotePath(header[2] ?? "")
      const lineNumber = positiveInt(header[3])
      if (!file || lineNumber === null) continue
      const endLine = positiveInt(header[4])
      const score = Number.parseFloat(header[5] ?? "")
      pending = {
        file,
        line: lineNumber,
        ...(endLine !== null ? { endLine } : {}),
        ...(Number.isFinite(score) ? { score } : {}),
      }
      continue
    }
    const fileLine = SEMANTIC_FILE_RE.exec(line)
    if (fileLine && pending) {
      const named = normalizeRemotePath(fileLine[1] ?? "")
      if (named) pending.file = named
      continue
    }
    if (line.trimStart().startsWith("```")) inFence = true
  }
  flush()
  return rows.length > 0 ? rows : null
}

function rowsFromCallResult(
  result: unknown,
  query?: string,
): Array<UnifiedResultRow> {
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
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      // Not JSON: the deployed service answers with its own text report.
      const report = rowsFromKeywordReport(trimmed, query ?? "")
        ?? rowsFromSemanticReport(trimmed)
      if (report) return report
      continue
    }
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
  // A shape we do not know is diagnosable only if the reply is quoted back:
  // the deployed service changed its result shape once already, and the bare
  // message cost a debugging round trip.
  const head = sanitizeTransportText(
    (texts[0] ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
  )
  throw new BluebirdError(
    `Bluebird returned no parseable code hits (unexpected tool result shape${head ? `: ${head}` : ""}).`,
    { retriable: false },
  )
}

/**
 * Bluebird must advertise the unified `code_search` tool, or both legacy
 * search tools. Anything else means the deployment changed shape under us and
 * a search would silently degrade.
 */
function validateBluebirdTools(tools: ReadonlyMap<string, RemoteMcpToolSchema>): void {
  const resolveFromStaged = (suffix: string): string | undefined => {
    for (const name of tools.keys()) {
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
}

export interface BluebirdSearchOpts {
  limit?: number
  file_glob?: string
  signal?: AbortSignal
}

export class BluebirdMcpClient extends RemoteMcpClient {
  constructor(scope: BluebirdScope, token: string, baseUrl: string = BLUEBIRD_MCP_URL) {
    super({
      label: "Bluebird",
      baseUrl,
      protocolVersion: BLUEBIRD_PROTOCOL_VERSION,
      clientName: "github-router",
      clientVersion: "bluebird",
      errorClass: BluebirdError,
      token,
      // Reached only from the 401 arm of a request. The cached entry is
      // dropped first: a retry that re-read it would send the same rejected
      // value and report it as a dead credential.
      tokenProvider: (signal) => {
        consola.warn(
          `Bluebird rejected the access token (401). Re-minting for resource `
            + `${BLUEBIRD_MCP_TOKEN_RESOURCE} through the Azure CLI; if this is a `
            + "stale session, run `az login`.",
        )
        return getBluebirdToken(signal, { forceRefresh: true, allowInteractiveLogin: true })
      },
      staticHeaders: () => bluebirdScopeHeaders(scope),
      validateTools: validateBluebirdTools,
    })
  }

  private shapeArgs(
    tool: string,
    query: string,
    opts: BluebirdSearchOpts,
    mode: "semantic" | "lexical",
  ): Record<string, unknown> {
    const schema = this.toolSchemas.get(tool)?.inputSchema
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

  /** Lexical path: indexed keyword search. */
  async searchFileContent(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.searchTool("lexical")
    const result = await this.callTool(
      tool,
      this.shapeArgs(tool, query, opts, "lexical"),
      opts.signal,
    )
    const rows = rowsFromCallResult(result, query)
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows
  }

  /** Semantic path: code-aware vector search. */
  async doVectorSearch(query: string, opts: BluebirdSearchOpts = {}): Promise<Array<UnifiedResultRow>> {
    await this.initialize(opts.signal)
    const tool = this.searchTool("semantic")
    const result = await this.callTool(
      tool,
      this.shapeArgs(tool, query, opts, "semantic"),
      opts.signal,
    )
    const rows = rowsFromCallResult(result, query)
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
        sanitizeRemoteDetail(err),
        { retriable: false },
      )
  }
  const repositories = [primary.repository]

  let token: string
  try {
    token = await getBluebirdToken(signal, { allowInteractiveLogin: true })
  } catch (err) {
    throw err instanceof BluebirdError
      ? err
      : new BluebirdError(
        `Bluebird auth failed: ${sanitizeRemoteDetail(err)}`,
        { retriable: false },
      )
  }

  let branch: string | null
  try {
    const current = await getCurrentBranch(workspace, signal)
    if (current) {
      // ADO audience, minted here rather than up front: the two audiences are
      // not interchangeable, and this one is only ever spent on the probe.
      const indexToken = await getAdoCodeSearchToken(signal)
      const status = await checkBranchIndexStatus(primary, current, indexToken, signal)
      branch = status.isIndexed
        ? status.branch
        : await getDefaultBranch(primary, workspace, signal)
    } else {
      branch = await getDefaultBranch(primary, workspace, signal)
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    if (err instanceof BluebirdError) throw err
    // The default-branch lookup shells out to `az repos show`, which relies on
    // az's own Azure DevOps session and fails with the same credential-shaped
    // text `az login` produces. Classify it so a dead session is told to
    // re-authenticate instead of leaving a bare stderr line.
    const advice = classifyAzFailure(err) === "login-required" ? " Run `az login` and retry." : ""
    throw new BluebirdError(`${sanitizeRemoteDetail(err)}${advice}`, { retriable: false })
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
