/**
 * The `kusto` MCP group: five read-only tools over the in-repo Kusto client.
 *
 * Read-only is a SERVICE property here, not a promise made by this file: every
 * request carries `x-ms-readonly: true` and
 * `properties.Options.request_readonly_hardline: true`, neither of which a
 * `set` statement can lift (see `./kusto-client`). The descriptions say
 * "read-only" so the model does not spend a turn attempting a mutation, not
 * because the text is what stops one.
 *
 * The group is registered by `--kusto` (or `GH_ROUTER_ENABLE_KUSTO=1`), or by
 * repository discovery when the workspace's remote is an Azure DevOps
 * repository (see `./azure-mcp-flags`). A launch cluster (`--kusto-cluster`)
 * is the DEFAULT for calls that do not name one; it is not what turns the
 * group on, because different tables live in different clusters and a single
 * pinned cluster made a cross-cluster question unanswerable. Every tool
 * therefore takes an optional `cluster`, held to a Kusto-shaped https origin
 * (`normalizeKustoCallClusterUri`), and a call reaches whatever the current
 * Azure identity can read there. Discovery never supplies a cluster: the model
 * picks one per call, and the operator's identity bounds the reach.
 */

import type { NonPersonaMcpTool } from "./peer-mcp-personas"
import {
  renderKustoResponse,
  KustoClient,
  KustoError,
  normalizeKustoCallClusterUri,
  normalizeKustoClusterUri,
} from "./kusto-client"
import { state } from "./state"
import { relaySafeText } from "./worker-agent/relay-cap"

const KUSTO_GROUP = "kusto" as const

/**
 * One process-lifetime client per resolved cluster, keyed on the NORMALIZED
 * origin so `name`, `name/` and a full https form share one entry.
 *
 * Keyed on the cluster URI because that is also the token audience: a second
 * cluster needs a second token, and a client answering for a cluster other than
 * the one its token was minted for would silently report the wrong data.
 *
 * Deliberately UNCAPPED. A `KustoClient` is a pure value (origin plus a default
 * database name); the material per-cluster object is the access token, and that
 * already lives uncapped for the process's lifetime in the shared
 * `AzCliAccessTokenCache` in `./kusto-client`. A cap here would bound a few
 * hundred bytes while inviting a false reading that the per-cluster footprint
 * is bounded. See the docs' note on a per-session distinct-cluster budget.
 */
const clients = new Map<string, KustoClient>()

/** Test seam: drop the memoized clients so the next call rebuilds them. */
export function resetKustoClientForTesting(): void {
  clients.clear()
}

/** Test seam: how many clusters this process has built a client for. */
export function kustoClientCountForTesting(): number {
  return clients.size
}

/**
 * The cluster a call runs against: the call's own `cluster` first, else the
 * launch's `--kusto-cluster`. Resolved synchronously, before a handler awaits
 * anything, so a shape error costs no token mint and no request.
 */
function resolveCluster(args: Record<string, unknown>): string {
  const value = args.cluster
  if (value !== undefined) {
    if (typeof value !== "string" || !value.trim()) {
      throw new KustoError("`cluster` must be a non-empty string when provided.", { retriable: false })
    }
    return normalizeKustoCallClusterUri(value)
  }
  const launch = state.kustoCluster
  if (!launch) {
    throw new KustoError(
      "No Kusto cluster selected. Pass `cluster` (a host such as "
        + "<name>.<region>.kusto.windows.net, or a full https URI), or launch with "
        + "`--kusto-cluster <uri>`.",
      { retriable: false },
    )
  }
  return normalizeKustoClusterUri(launch)
}

function kustoClient(clusterUri: string): KustoClient {
  const existing = clients.get(clusterUri)
  if (existing) return existing
  const client = new KustoClient({
    clusterUri,
    ...(state.kustoDatabase ? { database: state.kustoDatabase } : {}),
  })
  clients.set(clusterUri, client)
  return client
}

/**
 * MCP result envelope for one tool answer, relay-safe.
 *
 * A grid rendered to the row/character cap, and a large schema, both exceed
 * the relay ceiling Claude Code applies to an MCP result. `relaySafeText` is
 * therefore the LAST transform: over the cap the full text is written to a
 * file and the model gets a bounded preview plus that path, instead of a
 * result the client silently clips. It sits here rather than in the Kusto
 * client because the client's own cap bounds RENDERING work, and its trailer
 * says so, while this one bounds what the model is asked to read.
 */
async function text(value: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return { content: [{ type: "text", text: await relaySafeText(value) }] }
}

/** Optional `database`, present in the schema only as a free string. */
function databaseArg(args: Record<string, unknown>): { database?: string } {
  const value = args.database
  if (value === undefined) return {}
  if (typeof value !== "string" || !value.trim()) {
    throw new KustoError("`database` must be a non-empty string when provided.", { retriable: false })
  }
  return { database: value }
}

const DATABASE_PROPERTY = {
  database: {
    type: "string",
    description:
      "Database to run against. Defaults to the launch's --kusto-database, and is required when that was not set.",
  },
}

/**
 * The outer scope, so it precedes `database` in every tool that takes both:
 * a table name means nothing without the cluster it lives in. Any cluster the
 * current Azure identity can read may be named here, so a question that spans
 * two clusters is answered by two calls with different `cluster` values.
 */
const CLUSTER_PROPERTY = {
  cluster: {
    type: "string",
    description:
      "Kusto cluster to query, e.g. https://example.kusto.windows.net. Defaults to the launch's --kusto-cluster, and is required when that was not set.",
  },
}

const READ_ONLY_NOTE =
  " Read-only: the request runs under service-enforced read-only mode, so a mutating command is refused by Kusto rather than by this proxy."

export const KUSTO_TOOLS: ReadonlyArray<NonPersonaMcpTool> = Object.freeze([
  {
    toolNameHttp: "databases",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "List the Kusto databases the current Azure identity can see in one cluster. Call this first when you do not know which database to query, or before reporting that a database does not exist. This proxy cannot list clusters, so when the cluster is not already known, ask the user which one to query."
      + READ_ONLY_NOTE,
    inputSchema: { type: "object", additionalProperties: false, properties: { ...CLUSTER_PROPERTY } },
    async handler(args, signal) {
      const cluster = resolveCluster(args)
      return text(await kustoClient(cluster).databasesList(signal))
    },
  },
  {
    toolNameHttp: "tables",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "List the tables and stored functions in a Kusto database. Use it to find the entity to query or to enumerate a schema you do not know."
      + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...CLUSTER_PROPERTY, ...DATABASE_PROPERTY },
    },
    async handler(args, signal) {
      const cluster = resolveCluster(args)
      const { database } = databaseArg(args)
      return text(await kustoClient(cluster).tablesList(database, signal))
    },
  },
  {
    toolNameHttp: "schema",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "Column names and types for one Kusto table or function. Use it before writing a query so the column names and types are real rather than guessed."
      + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      required: ["table"],
      additionalProperties: false,
      properties: {
        table: { type: "string", description: "Table or function name (a simple identifier)." },
        ...CLUSTER_PROPERTY,
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const cluster = resolveCluster(args)
      const { database } = databaseArg(args)
      return text(await kustoClient(cluster).tableSchema(String(args.table ?? ""), database, signal))
    },
  },
  {
    toolNameHttp: "sample",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "The first N rows of a Kusto table, rendered as a grid. Use it to learn the shape and flavour of the data before writing a real query, so an aggregation is built against values that exist."
      + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      required: ["table"],
      additionalProperties: false,
      properties: {
        table: { type: "string", description: "Table name (a simple identifier)." },
        rows: {
          type: "number",
          description: "How many rows to return, 1-100. Default 10.",
        },
        ...CLUSTER_PROPERTY,
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const cluster = resolveCluster(args)
      const { database } = databaseArg(args)
      const rows = typeof args.rows === "number" ? args.rows : 10
      return text(await kustoClient(cluster).sample(String(args.table ?? ""), rows, database, signal))
    },
  },
  {
    toolNameHttp: "query",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "Run KQL against a Kusto database and get a rendered grid back. The result is capped by row count and rendered size, with an explicit truncation trailer, so a broad query returns a bounded answer rather than an error."
      + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      required: ["csl"],
      additionalProperties: false,
      properties: {
        csl: {
          type: "string",
          description:
            "The KQL to run. A leading '.' makes it a management command (e.g. `.show tables`); everything else is a query.",
        },
        ...CLUSTER_PROPERTY,
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const cluster = resolveCluster(args)
      const { database } = databaseArg(args)
      const csl = typeof args.csl === "string" ? args.csl : ""
      if (!csl.trim()) {
        throw new KustoError("`csl` must be a non-empty KQL query.", { retriable: false })
      }
      const result = await kustoClient(cluster).runCsl(csl, {
        ...(database ? { database } : {}),
        ...(signal ? { signal } : {}),
      })
      return text(renderKustoResponse(result))
    },
  },
])
