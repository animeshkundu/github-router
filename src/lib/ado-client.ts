/**
 * Azure DevOps remote MCP client (`https://mcp.dev.azure.com/{organization}`).
 *
 * Same streamable-HTTP shape as Bluebird, and the same transport
 * (`./remote-mcp-client`): stateless (the server assigns no `Mcp-Session-Id`),
 * SSE-framed responses, one JSON-RPC tool call per model call.
 *
 * **What this client does NOT do: filter the tool list.** It was tempting to
 * keep a curated read-only allowlist, or to parse the `action` argument to
 * decide which operations are safe. Both would be duplication of a guarantee
 * the service already makes, and the second is not even expressible: `action`
 * is advertised as a plain `string` whose accepted values live only inside the
 * description text, so any client-side classification would be a guess against
 * prose. Verified live instead (2026-10-15, read-only): with
 * `X-MCP-Toolsets: repos,wit,pipelines,wiki` the server advertises 20 tools
 * under `X-MCP-Readonly: true` and 31 without it, and the read-only set is a
 * strict subset whose difference is exactly the 11 tools named
 * `*_write`/`*_upload`/`*_create_*`/`upsert`. Across every toolset the counts
 * are 26 and 43. So the two headers ARE the filter, the advertised list
 * already equals what the server will serve, and this client forwards
 * `tools/list` through unchanged.
 *
 * Auth: `az account get-access-token --resource <app-id>`. `ADO_MCP_TOKEN`
 * overrides for tests and manual runs. Microsoft documents the remote server as
 * Entra-OAuth for clients that support the interactive flow with a custom app
 * registration; this proxy is not such a client — it mints a bearer with the
 * already-authenticated `az` session, which was verified to work. A tenant
 * without the `Ado.Mcp.Tools` enterprise application, or without admin consent,
 * fails at the first tool call; `probeAdo` turns that into a legible launch
 * warning instead of a bare 401 surfacing through the model's tool call.
 */

import { describeAzFailure, runAzCliAccessToken } from "./azure-cli-token"
import {
  RemoteMcpClient,
  RemoteMcpError,
  isRecord,
  type RemoteMcpErrorOptions,
} from "./remote-mcp-client"

export const ADO_MCP_HOST = "https://mcp.dev.azure.com"
export const ADO_TOKEN_RESOURCE = "2a72489c-aab2-4b65-b93a-a91edccf33b8"
export const ADO_PROTOCOL_VERSION = "2025-06-18"
export const ADO_TOKEN_ENV = "ADO_MCP_TOKEN"

/**
 * Toolset names the remote server accepts in `X-MCP-Toolsets`. Microsoft's
 * documented list; `core` / `repositories` are NOT valid values (they were a
 * wrong guess in an earlier draft of this work and are rejected here so the
 * mistake cannot reach the wire).
 */
export const ADO_TOOLSET_VALUES = [
  "all",
  "repos",
  "advsec",
  "wit",
  "pipelines",
  "wiki",
  "work",
  "testplan",
  "elm",
] as const

/**
 * The curated default: pull requests and files, work items, builds, and wiki.
 * Deliberately excludes `advsec` / `work` / `testplan` / `elm`, whose tools are
 * off the main repository loop.
 */
export const ADO_DEFAULT_TOOLSETS: ReadonlyArray<string> = ["repos", "wit", "pipelines", "wiki"]

/** Whole-result cap. A tool result is context, not an export format. */
const MAX_RESULT_CHARS = 60_000

export class AdoError extends RemoteMcpError {
  constructor(message: string, opts: RemoteMcpErrorOptions = {}) {
    super(message, opts)
    this.name = "AdoError"
  }
}

/**
 * Validate an organization name. It becomes a URL path segment, so anything
 * outside the character set Azure DevOps issues is rejected rather than
 * encoded — a `.` or `/` here would silently address a different endpoint.
 */
export function normalizeAdoOrganization(org: string): string {
  const trimmed = org.trim()
  if (!trimmed) throw new AdoError("Azure DevOps organization is empty.", { retriable: false })
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(trimmed)) {
    throw new AdoError(
      "Azure DevOps organization must be 1-64 characters of letters, digits, or hyphens.",
      { retriable: false },
    )
  }
  return trimmed
}

/** Parse and validate a comma-separated toolset list. */
export function normalizeAdoToolsets(value: string | ReadonlyArray<string>): Array<string> {
  // `Array.isArray` does not narrow `ReadonlyArray<string>`, so the branch is
  // written as a typeof test rather than a ternary on the guard.
  const raw: ReadonlyArray<string> = typeof value === "string" ? value.split(",") : value
  const parts = [...raw]
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    throw new AdoError("Azure DevOps toolset list is empty.", { retriable: false })
  }
  const unknown = parts.filter((part) => !(ADO_TOOLSET_VALUES as ReadonlyArray<string>).includes(part))
  if (unknown.length > 0) {
    throw new AdoError(
      `Unknown Azure DevOps toolset(s): ${unknown.join(", ")}. Valid values: ${ADO_TOOLSET_VALUES.join(", ")}.`,
      { retriable: false },
    )
  }
  // "all" is the absence of a filter; carrying it alongside others is
  // meaningless, so it collapses the whole selection.
  if (parts.includes("all")) return ["all"]
  return [...new Set(parts)]
}

/**
 * The `X-MCP-Toolsets` header value, or `undefined` when the selection is
 * "all" (the header is omitted so the server applies its own default).
 */
export function adoToolsetHeader(toolsets: ReadonlyArray<string>): string | undefined {
  if (toolsets.length === 0) return undefined
  if (toolsets.length === 1 && toolsets[0] === "all") return undefined
  return toolsets.join(",")
}

export interface AdoToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AdoClientOpts {
  organization: string
  /** Send `X-MCP-Readonly: true`. Default true; only `--ado-write` clears it. */
  readOnly?: boolean
  /** Toolsets to request. Default `ADO_DEFAULT_TOOLSETS`. */
  toolsets?: ReadonlyArray<string>
  /** Bearer for the first request; refreshed through `tokenProvider`. */
  token: string
  /** Overrides the refresh path (tests). */
  tokenProvider?: (signal?: AbortSignal) => Promise<string>
  /**
   * Overrides `ADO_MCP_HOST`. The production value is the only live endpoint
   * this client can reach, and automated tests must never name it — the same
   * rule `BluebirdMcpClient`'s optional `baseUrl` exists to satisfy.
   */
  baseUrl?: string
}

/** Token source: explicit env first (tests/manual), else `az` CLI. */
export async function getAdoToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env[ADO_TOKEN_ENV]?.trim()
  if (env) return env
  try {
    const { token } = await runAzCliAccessToken(ADO_TOKEN_RESOURCE, {
      ...(signal ? { signal } : {}),
    })
    return token
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new AdoError(describeAzFailure("Azure DevOps", err), { retriable: false })
  }
}

export class AdoMcpClient extends RemoteMcpClient {
  readonly organization: string
  readonly readOnly: boolean
  readonly toolsets: ReadonlyArray<string>

  constructor(opts: AdoClientOpts) {
    const organization = normalizeAdoOrganization(opts.organization)
    const readOnly = opts.readOnly !== false
    const toolsets = [...(opts.toolsets ?? ADO_DEFAULT_TOOLSETS)]
    const toolsetHeader = adoToolsetHeader(toolsets)
    super({
      label: "Azure DevOps",
      baseUrl: `${opts.baseUrl ?? ADO_MCP_HOST}/${organization}`,
      protocolVersion: ADO_PROTOCOL_VERSION,
      clientName: "github-router",
      clientVersion: "ado",
      errorClass: AdoError,
      token: opts.token,
      tokenProvider: opts.tokenProvider ?? ((signal) => getAdoToken(signal)),
      staticHeaders: () => ({
        // Read-only is a server-side control: the header is what removes the
        // mutating tools from `tools/list` and what refuses a mutation at
        // call time. Never omit it on the strength of a client-side check.
        ...(readOnly ? { "X-MCP-Readonly": "true" } : {}),
        ...(toolsetHeader ? { "X-MCP-Toolsets": toolsetHeader } : {}),
      }),
    })
    this.organization = organization
    this.readOnly = readOnly
    this.toolsets = toolsets
  }

  /** The tools the server advertised, in the order it listed them. */
  listAdoTools(): Array<AdoToolDescriptor> {
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

  /**
   * One `tools/call`, normalized to the MCP result envelope the `/mcp` handler
   * forwards. A tool-level `isError` result is passed through as such (the
   * server's refusal IS the answer); only a transport/protocol failure throws.
   */
  async callAdoTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    await this.initialize(signal)
    if (!this.hasTool(name)) {
      const known = [...this.toolSchemas.keys()].sort().join(", ")
      throw new AdoError(
        `Azure DevOps MCP does not advertise a tool named "${name}". Advertised tools: ${known}.`,
        { retriable: false },
      )
    }
    const result = await this.callTool(name, args, signal)
    if (!isRecord(result)) {
      throw new AdoError("Azure DevOps returned an empty result.", { retriable: true })
    }
    const texts: Array<string> = []
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
          texts.push(block.text)
        }
      }
    }
    const joined = texts.join("\n\n")
    const capped = joined.length > MAX_RESULT_CHARS
      ? `${joined.slice(0, MAX_RESULT_CHARS)}\n\n… result truncated at ${MAX_RESULT_CHARS} characters.`
      : joined
    const envelope: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
      content: [{ type: "text", text: capped || "Azure DevOps returned an empty result." }],
    }
    if (result.isError === true) envelope.isError = true
    return envelope
  }
}
