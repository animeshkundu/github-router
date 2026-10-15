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
 * The group is registered only when a cluster is configured. A git remote
 * supplies no cluster identity, so nothing here is auto-enabled by repository
 * discovery — the operator names the cluster or the group stays off.
 */

import type { NonPersonaMcpTool } from "./peer-mcp-personas"
import { renderKustoResponse, KustoClient, KustoError } from "./kusto-client"
import { state } from "./state"

const KUSTO_GROUP = "kusto" as const

/**
 * One process-lifetime client per resolved cluster. Keyed on the cluster URI
 * because that is also the token audience: a second cluster needs a second
 * token, and a stale client on the wrong cluster would silently answer about
 * the wrong data.
 */
let cached: { cluster: string; client: KustoClient } | null = null

/** Test seam: drop the memoized client so the next call rebuilds it. */
export function resetKustoClientForTesting(): void {
  cached = null
}

function kustoClient(): KustoClient {
  const cluster = state.kustoCluster
  if (!cluster) {
    throw new KustoError(
      "No Kusto cluster is configured. Launch with `--kusto-cluster <uri>` or set GH_ROUTER_KUSTO_CLUSTER.",
      { retriable: false },
    )
  }
  if (cached?.cluster === cluster) return cached.client
  const client = new KustoClient({
    clusterUri: cluster,
    ...(state.kustoDatabase ? { database: state.kustoDatabase } : {}),
  })
  cached = { cluster, client }
  return client
}

function text(value: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: value }] }
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

const READ_ONLY_NOTE =
  " Read-only: the request runs under service-enforced read-only mode, so a mutating command is refused by Kusto rather than by this proxy."

export const KUSTO_TOOLS: ReadonlyArray<NonPersonaMcpTool> = Object.freeze([
  {
    toolNameHttp: "databases",
    group: KUSTO_GROUP,
    capability: "kusto",
    description:
      "List the Kusto databases the current Azure identity can see. Call this first when you do not know which database to query, or before reporting that a database does not exist."
      + READ_ONLY_NOTE,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async handler(_args, signal) {
      return text(await kustoClient().databasesList(signal))
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
      properties: { ...DATABASE_PROPERTY },
    },
    async handler(args, signal) {
      const { database } = databaseArg(args)
      return text(await kustoClient().tablesList(database, signal))
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
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const { database } = databaseArg(args)
      return text(await kustoClient().tableSchema(String(args.table ?? ""), database, signal))
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
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const { database } = databaseArg(args)
      const rows = typeof args.rows === "number" ? args.rows : 10
      return text(await kustoClient().sample(String(args.table ?? ""), rows, database, signal))
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
        ...DATABASE_PROPERTY,
      },
    },
    async handler(args, signal) {
      const { database } = databaseArg(args)
      const csl = typeof args.csl === "string" ? args.csl : ""
      if (!csl.trim()) {
        throw new KustoError("`csl` must be a non-empty KQL query.", { retriable: false })
      }
      const result = await kustoClient().runCsl(csl, {
        ...(database ? { database } : {}),
        ...(signal ? { signal } : {}),
      })
      return text(renderKustoResponse(result))
    },
  },
])
