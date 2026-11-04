/**
 * Work IQ MCP client: a thin subclass of the shared streamable-HTTP transport
 * pointed at `https://workiq.svc.cloud.microsoft/mcp`.
 *
 * The live server is STATELESS — `initialize` returns protocol `2025-06-18`
 * and no `mcp-session-id` — which `RemoteMcpClient` already handles: it sends
 * the header only when one was assigned. No transport change is required.
 *
 * The one thing this client adds beyond the transport is result shaping.
 * `retrieve` puts its payload in
 * `structuredContent["application/vnd.ms-workiq.retrieval"]`. The documented
 * shape there is a `markdown` answer beside `retrievalHits`; the live server
 * (measured 2026-11) instead returns `results`, each hit carrying its own
 * `markdown` snippet and an `id` that a `[^id]` marker would refer to. Both
 * shapes are rendered as text, because the unstructured fallback is raw JSON
 * that overruns the relay cap. Failure arrives two ways — `isError: true`, or a
 * successful envelope whose `stoppedReason` is `error`/`cancelled` — and both
 * must throw rather than reach the model as if they were an answer.
 */

import consola from "consola"

import {
  RemoteMcpClient,
  RemoteMcpError,
  isRecord,
  type RemoteMcpErrorOptions,
} from "../remote-mcp-client"
import {
  WORKIQ_MCP_URL,
  WORKIQ_PROTOCOL_VERSION,
  WORKIQ_RETRIEVAL_CONTENT_TYPE,
} from "./constants"
import { ensureWorkiqToken } from "./token"

export class WorkiqError extends RemoteMcpError {
  constructor(message: string, opts: RemoteMcpErrorOptions = {}) {
    super(message, opts)
    this.name = "WorkiqError"
  }
}

export interface WorkiqToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface WorkiqClientOpts {
  /** Bearer for the first request; refreshed through `tokenProvider`. */
  token: string
  /** Overrides the refresh path (tests). */
  tokenProvider?: (signal?: AbortSignal) => Promise<string>
  /**
   * Overrides the hosted URL. Automated tests must never name the live
   * endpoint, the same rule the Azure clients' `baseUrl` exists to satisfy.
   */
  baseUrl?: string
}

/** Upper bound on the sources block, so a hundred-hit answer cannot flood the model. */
const MAX_SOURCES = 25

/**
 * Per-request deadline for a Work IQ call.
 *
 * The shared transport default is 30 s, which is right for a control-plane
 * server: `initialize`, `tools/list`, and ADO's lookups all finish well inside
 * it. `ask` and `retrieve` are not lookups. They run a model over the tenant's
 * indexed content and routinely take longer than 30 s, so the first live
 * retrieval was killed at 30.004 s before it could answer. Three minutes leaves
 * room for a slow tenant while still bounding a hung call; the model can retry.
 */
const WORKIQ_REQUEST_TIMEOUT_MS = 180_000

/** Result envelope the `/mcp` handler forwards. */
export interface WorkiqToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * The single nested object under `resourceMetadata`.
 *
 * The live payload keys that object by entity kind (`email`, `file`, ...) and
 * keeps the display fields one level down, so `resourceMetadata.email.subject`
 * is where an email hit's title actually lives.
 */
function resourceMetadata(hit: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = isRecord(hit.resourceMetadata) ? hit.resourceMetadata : undefined
  if (!metadata) return undefined
  for (const value of Object.values(metadata)) {
    if (isRecord(value)) return value
  }
  return undefined
}

/**
 * A hit's display title, falling back through the fields the live payload
 * carries (`title`, `name`, `subject`) and finally its entity type.
 */
function hitTitle(hit: Record<string, unknown>, index: number): string {
  const nested = resourceMetadata(hit)
  const title =
    asString(hit.title)
    ?? asString(hit.name)
    ?? asString(hit.subject)
    ?? asString(hit.displayName)
    ?? (nested ? asString(nested.title) ?? asString(nested.name) ?? asString(nested.subject) : undefined)
  const type = asString(hit.entityType) ?? asString(hit.type)
  if (title && type) return `${title} (${type})`
  if (title) return title
  if (type) return `(${type})`
  return `Hit ${index + 1}`
}

function hitUrl(hit: Record<string, unknown>): string | undefined {
  return (
    asString(hit.webUrl)
    ?? asString(hit.url)
    ?? asString(hit.link)
    ?? asString(hit.entityUrl)
    ?? asString(hit.path)
  )
}

/** The compact citation list appended after retrieval markdown. */
export function formatWorkiqSources(hits: ReadonlyArray<unknown>): string {
  const lines: Array<string> = []
  for (const [index, raw] of hits.entries()) {
    if (lines.length >= MAX_SOURCES) break
    if (!isRecord(raw)) continue
    const url = hitUrl(raw)
    lines.push(`${index + 1}. ${hitTitle(raw, index)}${url ? ` — ${url}` : ""}`)
  }
  if (lines.length === 0) return ""
  const more = hits.length > lines.length ? ` (${hits.length - lines.length} more)` : ""
  return `\n\nSources${more}:\n${lines.join("\n")}`
}

/** The per-hit body fields the live `retrieve` payload can carry. */
function hitBody(hit: Record<string, unknown>): string | undefined {
  return (
    asString(hit.markdown)
    ?? asString(hit.text)
    ?? asString(hit.snippet)
    ?? asString(hit.summary)
    ?? asString(hit.content)
  )
}

/**
 * Render `retrieval.results` as the grounding document.
 *
 * The documented retrieval shape puts the answer in a top-level `markdown`
 * beside a `retrievalHits` list. The live server (measured 2026-11) returns
 * neither: no `content` blocks, no top-level `markdown`, and the hits under
 * `results`, each carrying its own `markdown` snippet. Falling through to
 * `JSON.stringify` handed the model ~44 KB of raw JSON and dropped it at the
 * relay cap, so the snippets are laid out as numbered sections instead. The
 * hit's `id` (`h1`, `h2`, ...) is the label a `[^id]` marker refers to.
 */
export function formatWorkiqResults(hits: ReadonlyArray<unknown>): string {
  const sections: Array<string> = []
  for (const [index, raw] of hits.entries()) {
    if (!isRecord(raw)) continue
    const body = hitBody(raw)
    if (!body) continue
    const id = asString(raw.id) ?? String(index + 1)
    const url = hitUrl(raw)
    const heading = `[${id}] ${hitTitle(raw, index)}${url ? `\n${url}` : ""}`
    sections.push(`${heading}\n${body}`)
  }
  return sections.join("\n\n")
}

/**
 * Turn an MCP `tools/call` result into the single text block the `/mcp`
 * handler forwards.
 *
 * - A tool-level failure throws. The message keeps Entra/the service's own
 *   text and its `recoveryAction` (when present) so the model sees what the
 *   server said it should do.
 * - A `retrieve` answer renders the structured payload. A top-level `markdown`
 *   wins when the server sends one, because the generic `content[].text` copy
 *   of a large answer is what the service truncates first; otherwise the
 *   per-hit snippets in `results` are laid out as numbered sections.
 * - Everything else falls back to joining the text blocks.
 */
export function workiqResultText(result: unknown): string {
  if (!isRecord(result)) {
    throw new WorkiqError("Work IQ returned an empty result.", { retriable: true })
  }

  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined
  const retrievalRaw = structured?.[WORKIQ_RETRIEVAL_CONTENT_TYPE]
  const retrieval = isRecord(retrievalRaw) ? retrievalRaw : undefined

  const stoppedReason = asString(retrieval?.stoppedReason)
  const upstreamError = asString(result.error) ?? asString(retrieval?.error)
  const recoveryAction = asString(retrieval?.recoveryAction)
  const failed =
    result.isError === true
    || stoppedReason === "error"
    || stoppedReason === "cancelled"
  if (failed) {
    const texts: Array<string> = []
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
          texts.push(block.text.trim())
        }
      }
    }
    const detail = upstreamError ?? (texts.length > 0 ? texts.join("\n\n") : undefined)
    const reason = stoppedReason ? ` (${stoppedReason})` : ""
    const head = `Work IQ reported an error${reason}`
    const parts = [head]
    if (detail) parts.push(detail)
    if (recoveryAction) parts.push(`Suggested action: ${recoveryAction}`)
    if (parts.length === 1) parts.push("The service returned no further detail.")
    throw new WorkiqError(parts.join(": "), { retriable: false })
  }

  const resultHits = Array.isArray(retrieval?.results)
    ? retrieval.results
    : Array.isArray(retrieval?.retrievalHits)
      ? retrieval.retrievalHits
      : []
  // A citation entry carries less than a result entry; when the server sends
  // both, the documented `retrievalHits` is the citation list a markdown
  // answer's markers point at, so it wins for the sources block.
  const citationHits = Array.isArray(retrieval?.retrievalHits) ? retrieval.retrievalHits : resultHits

  const markdown = asString(retrieval?.markdown)
  if (markdown) {
    return `${markdown.trim()}${formatWorkiqSources(citationHits)}`
  }

  const rendered = formatWorkiqResults(resultHits)
  if (rendered) return rendered
  // Hits that carry no body still tell the model what was found and where.
  const sourcesOnly = formatWorkiqSources(citationHits)
  if (sourcesOnly) return sourcesOnly.trim()
  if (asNumber(retrieval?.resultCount) === 0) return "Work IQ found no results."

  const texts: Array<string> = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text)
      }
    }
  }
  const joined = texts.join("\n\n").trim()
  if (joined) return joined

  // A structured payload with no way to render it as text: surface the JSON
  // rather than an empty string, so the caller can still act on it.
  if (structured) {
    try {
      return JSON.stringify(structured)
    } catch {
      // fall through
    }
  }
  return "Work IQ returned an empty result."
}

export class WorkiqMcpClient extends RemoteMcpClient {
  constructor(opts: WorkiqClientOpts) {
    super({
      label: "Work IQ",
      baseUrl: opts.baseUrl ?? WORKIQ_MCP_URL,
      protocolVersion: WORKIQ_PROTOCOL_VERSION,
      clientName: "github-router",
      clientVersion: "workiq",
      errorClass: WorkiqError,
      token: opts.token,
      requestTimeoutMs: WORKIQ_REQUEST_TIMEOUT_MS,
      // Reached only from the 401 arm of a request. Force a refresh rather
      // than replaying the token the server just rejected.
      tokenProvider: opts.tokenProvider ?? ((signal) => {
        consola.warn(
          "Work IQ rejected the access token (401). Refreshing it; if this "
            + "persists, run `github-router workiq auth`.",
        )
        return ensureWorkiqToken({ signal, forceRefresh: true })
      }),
    })
  }

  /** The tools the server advertised, in the order it listed them. */
  listWorkiqTools(): Array<WorkiqToolDescriptor> {
    return [...this.toolSchemas.values()].map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    }))
  }

  /** True iff the server advertised `name`. Guards a call the model invented. */
  hasTool(name: string): boolean {
    return this.toolSchemas.has(name)
  }

  /** One `tools/call`, shaped through `workiqResultText`. */
  async callWorkiqTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkiqToolResult> {
    await this.initialize(signal)
    if (!this.hasTool(name)) {
      const known = [...this.toolSchemas.keys()].sort().join(", ")
      throw new WorkiqError(
        `Work IQ does not advertise a tool named "${name}". Advertised tools: ${known}.`,
        { retriable: false },
      )
    }
    const result = await this.callTool(name, args, signal)
    return { content: [{ type: "text", text: workiqResultText(result) }] }
  }
}
