/**
 * Azure Data Explorer (Kusto) REST client.
 *
 * The router talks to ADX directly rather than through `@azure/mcp`'s `kusto`
 * namespace: that package ships a 122 MB platform binary and a managed .NET
 * child process for seven tools whose entire value is one authenticated POST
 * to `/v1/rest/query`. A wrong-shaped request here is a JSON body; a
 * wrong-shaped request there is a failed native spawn on the canonical Windows
 * environment.
 *
 * **Read-only is enforced by the service, not by this file.** Every request
 * carries the `x-ms-readonly: true` header AND
 * `properties.Options.request_readonly_hardline: true`. Kusto documents both as
 * unavailable to a `set` statement, so a query string cannot lift them. That is
 * the property a leading-dot/text allowlist in the client could not provide:
 * Kusto composes multiple `;`-separated statements per request, so "does this
 * text contain a mutating command" is not a question a prefix check answers.
 * The client therefore performs NO KQL inspection and relies on the service to
 * refuse a mutation.
 *
 * Auth: `az account get-access-token --resource <cluster-uri>` (ADX uses the
 * cluster URI as its audience). A process-lifetime, single-flighted cache with
 * a refresh margin is the auto-refresh path; `KUSTO_TOKEN` overrides for tests
 * and manual runs.
 */

import { AzCliAccessTokenCache, describeAzFailure } from "./azure-cli-token"
import { parseRetryAfter, sanitizeRemoteDetail, sleep } from "./remote-mcp-client"

export const KUSTO_TOKEN_ENV = "KUSTO_TOKEN"

export interface KustoErrorOptions {
  retriable?: boolean
  status?: number
  retryAfterMs?: number
}

export class KustoError extends Error {
  readonly retriable: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(message: string, opts: KustoErrorOptions = {}) {
    super(sanitizeRemoteDetail(message))
    this.name = "KustoError"
    this.retriable = opts.retriable ?? false
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

/** Wire-shape size limits. A tool result is context, not an export format. */
const MAX_CSL_CHARS = 100_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_ROW_CAP = 200
const DEFAULT_CELL_CHARS = 300
const DEFAULT_RENDER_CHARS = 60_000
const REQUEST_TIMEOUT_MS = 60_000

/**
 * Backoff for a retriable verdict (429/5xx/transport), mirroring the shared
 * remote-MCP transport's `initializeWithRecovery`: three retries at 1/2/4 s,
 * with `Retry-After` winning when the service sends one. Every request here is
 * read-only, which is what makes resending it safe.
 */
const KUSTO_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000]

/**
 * Read a response body under `MAX_RESPONSE_BYTES`, in BYTES.
 *
 * The cap is a byte budget, so it has to be measured in bytes: `text.length`
 * counts UTF-16 code units, so a body of multi-byte characters passes a
 * char-count check while occupying up to 3x the memory the cap names. A
 * `content-length` that already declares an oversized body is refused before
 * it is buffered at all; a chunked or header-less response falls back to the
 * byte count after the read, which is the only remaining signal.
 */
async function readBoundedBody(res: Response): Promise<string> {
  const declaredHeader = res.headers.get("content-length")
  const declared = declaredHeader ? Number(declaredHeader) : Number.NaN
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    // Release the socket rather than buffering what is already refused.
    await res.body?.cancel().catch(() => {})
    throw new KustoError(
      `Kusto response declared ${declared} bytes, over the 8 MiB client cap. Narrow the query.`,
      { retriable: false },
    )
  }
  const text = await res.text()
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new KustoError(
      `Kusto response exceeded the 8 MiB client cap (${bytes} bytes). Narrow the query.`,
      { retriable: false },
    )
  }
  return text
}

export interface KustoTable {
  name: string
  columns: Array<string>
  rows: Array<Array<unknown>>
}

export interface KustoResponse {
  tables: Array<KustoTable>
  /** True when the service's row cap was reached, so rows were withheld. */
  truncated: boolean
}

/**
 * Normalize an operator-supplied cluster reference into an origin.
 *
 * Accepts `https://name.region.kusto.windows.net`, with or without a trailing
 * slash, and a bare host. Rejects anything that is not https, anything with a
 * path/query/credentials, and anything that is not a syntactically valid
 * hostname — this value becomes both a request URL and an `az --resource`
 * audience, so a malformed one would otherwise reach the CLI.
 */
export function normalizeKustoClusterUri(cluster: string): string {
  const raw = cluster.trim()
  if (!raw) throw new KustoError("Kusto cluster is empty.", { retriable: false })
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new KustoError("Kusto cluster is not a valid URL.", { retriable: false })
  }
  if (url.protocol !== "https:") {
    throw new KustoError("Kusto cluster must use https.", { retriable: false })
  }
  if (url.username || url.password) {
    throw new KustoError("Kusto cluster must not embed credentials.", { retriable: false })
  }
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(url.hostname)) {
    throw new KustoError("Kusto cluster host is not a valid domain name.", { retriable: false })
  }
  const path = url.pathname.replace(/\/+$/, "")
  if (path) {
    throw new KustoError("Kusto cluster must be an origin with no path.", { retriable: false })
  }
  return `${url.protocol}//${url.host}`
}

/**
 * Table/column identifiers interpolated into a generated command. Kusto's own
 * `['name']`-quoting is not used because the server accepts a strict
 * `[A-Za-z_][A-Za-z0-9_]*` name verbatim and rejecting anything else is a
 * smaller, reviewable surface than building an escaper.
 */
function assertIdentifier(value: string, what: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new KustoError(
      `${what} must be a simple identifier (letters, digits, underscore; not starting with a digit).`,
      { retriable: false },
    )
  }
  return trimmed
}

export interface KustoClientOpts {
  /** Cluster origin, e.g. `https://example.kusto.windows.net`. */
  clusterUri: string
  /** Default database for calls that do not name one. */
  database?: string
  /** Test seam: replaces the `az`-backed token cache. */
  tokenProvider?: (signal?: AbortSignal) => Promise<string>
  /** Test seam: replaces global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Test seam: replaces the retry ladder. An empty array makes every retriable
   * verdict final, which is how a suite asserts the VERDICT without paying the
   * production backoff; the ladder itself is asserted with a short one.
   */
  retryDelaysMs?: ReadonlyArray<number>
}

/** Process-lifetime token cache shared by every Kusto client in the process. */
const kustoTokenCache = new AzCliAccessTokenCache()

export class KustoClient {
  readonly clusterUri: string
  readonly database: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly tokenProvider: (signal?: AbortSignal) => Promise<string>
  private readonly retryDelaysMs: ReadonlyArray<number>

  constructor(opts: KustoClientOpts) {
    this.clusterUri = normalizeKustoClusterUri(opts.clusterUri)
    this.database = opts.database?.trim() || undefined
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.tokenProvider = opts.tokenProvider ?? ((signal) => getKustoToken(this.clusterUri, signal))
    this.retryDelaysMs = opts.retryDelaysMs ?? KUSTO_RETRY_DELAYS_MS
  }

  private resolveDatabase(database?: string): string {
    const db = database?.trim() || this.database
    if (!db) {
      throw new KustoError(
        "No Kusto database selected. Pass `database` explicitly or launch with "
          + "`--kusto-database <name>`.",
        { retriable: false },
      )
    }
    return db
  }

  private async post(
    endpoint: "query" | "mgmt",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<KustoResponse> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attemptOnce(endpoint, body, signal)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        // A 401 was already invalidated inside the attempt, so the retry mints
        // a fresh token rather than replaying the dead one. Once only: a
        // second 401 from a freshly minted token is a real auth verdict, not
        // something another `az` call would fix.
        if (err instanceof KustoError && err.status === 401 && !refreshed) {
          refreshed = true
          continue
        }
        const retriable = err instanceof KustoError ? err.retriable : true
        if (!retriable || attempt >= this.retryDelaysMs.length) throw err
        // A hint from the service wins over the ladder, which is the whole
        // point of reading `Retry-After`. `attempt < length` is established
        // above, so the indexed rung always exists.
        const hint = err instanceof KustoError ? err.retryAfterMs : undefined
        await sleep(hint ?? this.retryDelaysMs[attempt]!, signal)
      }
    }
  }

  /**
   * One attempt: mint/confirm the token, POST, classify the response. Every
   * thrown `KustoError` carries a verdict the caller in `post` acts on, so the
   * retry policy lives in exactly one place.
   */
  private async attemptOnce(
    endpoint: "query" | "mgmt",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<KustoResponse> {
    const token = await this.tokenProvider(signal)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error("Kusto request timed out")), REQUEST_TIMEOUT_MS)
    timer.unref?.()

    let res: Response
    try {
      try {
        res = await this.fetchImpl(`${this.clusterUri}/v1/rest/${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            // Service-enforced read-only. Neither of these can be overridden
            // from inside the request text.
            "x-ms-readonly": "true",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted")
        throw new KustoError(`Kusto transport failed: ${sanitizeRemoteDetail(err)}`, {
          retriable: true,
        })
      }

      if (res.status === 401) {
        // A 401 means the cached token is no longer accepted; drop it so the
        // retry (and every later call) mints a fresh one rather than replaying
        // the dead value.
        kustoTokenCache.invalidate(this.clusterUri)
        throw new KustoError(
          "Kusto rejected the access token (HTTP 401). Verify `az login` targets the tenant that owns this cluster, then retry.",
          { retriable: false, status: 401 },
        )
      }
      if (res.status === 403) {
        // Deliberately NOT the same verdict as a 401, and deliberately no
        // cache invalidation. ADX answers 403 for a valid identity with no
        // access to the cluster or database, so calling it a credential
        // failure sends the operator to re-authenticate against a token that
        // is fine, and invalidating would spawn an `az` call per attempt that
        // still 403s. The service's own text names the missing grant, so it
        // is read and reported rather than replaced by a guess.
        const detail = await readBoundedBody(res)
        throw new KustoError(
          `Kusto refused the request (HTTP 403): ${kustoErrorDetail(detail)} `
            + "The token was accepted; this is an access-permission verdict for the cluster or database.",
          { retriable: false, status: 403 },
        )
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"))
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        throw new KustoError(`Kusto responded with HTTP ${res.status}.`, {
          retriable: true,
          status: res.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        })
      }
      const text = await readBoundedBody(res)
      if (!res.ok) {
        throw new KustoError(
          `Kusto responded with HTTP ${res.status}: ${kustoErrorDetail(text)}`,
          { retriable: false, status: res.status },
        )
      }
      return parseKustoResponse(text)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  /**
   * Run `csl` against `database`. Leading-dot text is a management command and
   * is routed to `/v1/rest/mgmt`; everything else is a query. Both carry the
   * same read-only controls, so the routing is about endpoint correctness, not
   * about safety.
   */
  async runCsl(csl: string, opts: { database?: string; signal?: AbortSignal } = {}): Promise<KustoResponse> {
    const text = csl.trim()
    if (!text) throw new KustoError("`csl` must be a non-empty KQL query.", { retriable: false })
    if (text.length > MAX_CSL_CHARS) {
      throw new KustoError(`\`csl\` exceeds the ${MAX_CSL_CHARS}-character limit.`, { retriable: false })
    }
    const database = this.resolveDatabase(opts.database)
    const isMgmt = text.startsWith(".")
    return this.post(
      isMgmt ? "mgmt" : "query",
      {
        db: database,
        csl: text,
        properties: {
          Options: {
            request_readonly_hardline: true,
            truncationmaxrecords: DEFAULT_ROW_CAP,
            truncationmaxsize: 64 * 1024 * 1024,
          },
        },
      },
      opts.signal,
    )
  }

  /** `.show databases` — the databases this identity can see. */
  async databasesList(signal?: AbortSignal): Promise<string> {
    const res = await this.post("mgmt", {
      csl: ".show databases",
      properties: { Options: { request_readonly_hardline: true } },
    }, signal)
    const names = res.tables
      .flatMap((table) => table.rows)
      .map((row) => (row[0] === undefined || row[0] === null ? "" : String(row[0])))
      .filter((name) => name.length > 0)
    if (names.length === 0) return "No databases visible to this identity."
    return `${names.length} database(s):\n${names.map((n) => `  ${n}`).join("\n")}`
  }

  /** `.show tables` — entity names in the selected database. */
  async tablesList(database?: string, signal?: AbortSignal): Promise<string> {
    const db = this.resolveDatabase(database)
    const res = await this.post("mgmt", {
      db,
      csl: ".show tables",
      properties: { Options: { request_readonly_hardline: true } },
    }, signal)
    const names = res.tables
      .flatMap((table) => table.rows)
      .map((row) => (row[0] === undefined || row[0] === null ? "" : String(row[0])))
      .filter((name) => name.length > 0)
    if (names.length === 0) return `${db}: no tables.`
    return `${db}: ${names.length} table(s)/function(s):\n${names.map((n) => `  ${n}`).join("\n")}`
  }

  /** Column names and types for one table or function. */
  async tableSchema(table: string, database?: string, signal?: AbortSignal): Promise<string> {
    const name = assertIdentifier(table, "`table`")
    const res = await this.runCsl(`${name} | getschema`, { ...(database ? { database } : {}), ...(signal ? { signal } : {}) })
    return renderKustoResponse(res)
  }

  /** First `rows` rows of `table`. */
  async sample(table: string, rows = 10, database?: string, signal?: AbortSignal): Promise<string> {
    const name = assertIdentifier(table, "`table`")
    const bounded = Number.isFinite(rows) ? Math.max(1, Math.min(100, Math.floor(rows))) : 10
    const res = await this.runCsl(`${name} | take ${bounded}`, {
      ...(database ? { database } : {}),
      ...(signal ? { signal } : {}),
    })
    return renderKustoResponse(res)
  }
}

function kustoErrorDetail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "no detail"
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === "string" && message.trim()) return sanitizeRemoteDetail(message).slice(0, 500)
      }
      if (typeof record["@message"] === "string") {
        return sanitizeRemoteDetail(record["@message"]).slice(0, 500)
      }
    }
  } catch {
    // Fall through to the raw (sanitized, truncated) text.
  }
  return sanitizeRemoteDetail(trimmed).slice(0, 500)
}

function parseKustoResponse(text: string): KustoResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new KustoError("Kusto returned a response that was not JSON.", { retriable: true })
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new KustoError("Kusto returned an unexpected response shape.", { retriable: true })
  }
  const rawTables = (parsed as Record<string, unknown>).Tables
  if (!Array.isArray(rawTables)) {
    throw new KustoError("Kusto returned an unexpected response shape.", { retriable: true })
  }
  const tables: Array<KustoTable> = []
  let truncated = false
  for (const raw of rawTables) {
    if (typeof raw !== "object" || raw === null) continue
    const record = raw as Record<string, unknown>
    const columns = Array.isArray(record.Columns)
      ? record.Columns.map((column) => (
        typeof column === "object" && column !== null && typeof (column as Record<string, unknown>).ColumnName === "string"
          ? String((column as Record<string, unknown>).ColumnName)
          : "?"
      ))
      : []
    const rows = Array.isArray(record.Rows)
      ? record.Rows.filter((row): row is Array<unknown> => Array.isArray(row))
      : []
    if (rows.length >= DEFAULT_ROW_CAP) truncated = true
    tables.push({
      name: typeof record.TableName === "string" ? record.TableName : "Table",
      columns,
      rows,
    })
  }
  return { tables, truncated }
}

function cellText(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  const single = text.replace(/\s*\r?\n\s*/g, " ⏎ ")
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single
}

/**
 * Render a Kusto result as a compact aligned grid. Never the raw wire JSON:
 * `{"Tables":[{"Columns":[{"ColumnName":…` is both unreadable to the model and
 * several times the tokens of the same content as columns and rows.
 */
export function renderKustoResponse(
  response: KustoResponse,
  opts: { maxCellChars?: number; maxChars?: number } = {},
): string {
  const maxCellChars = opts.maxCellChars ?? DEFAULT_CELL_CHARS
  const maxChars = opts.maxChars ?? DEFAULT_RENDER_CHARS
  const blocks: Array<string> = []
  let total = 0
  let anyTruncated = response.truncated

  for (const table of response.tables) {
    const header = `(${table.rows.length} row(s)) ${table.columns.join(" | ")}`
    const body = table.rows.map((row) =>
      row.map((cell) => cellText(cell, maxCellChars)).join(" | "))
    let block = table.rows.length === 0 && table.columns.length === 0
      ? `${table.name}: empty result.`
      : [header, ...body].join("\n")
    if (total + block.length > maxChars) {
      const room = Math.max(0, maxChars - total)
      if (room > 0) {
        block = block.slice(0, room)
        blocks.push(block)
      }
      anyTruncated = true
      break
    }
    total += block.length
    blocks.push(block)
  }

  if (blocks.length === 0) return "Kusto returned no result tables."
  const trailer = anyTruncated
    ? `\n… result truncated at the client's row/character cap; narrow the query for the full set.`
    : ""
  return `${blocks.join("\n\n")}${trailer}`
}

/** Token source: explicit env first (tests/manual), else `az` CLI. */
export async function getKustoToken(clusterUri: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env[KUSTO_TOKEN_ENV]?.trim()
  if (env) return env
  try {
    return await kustoTokenCache.get(clusterUri, signal)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new KustoError(describeAzFailure("Kusto", err), { retriable: false })
  }
}
