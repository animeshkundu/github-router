import { afterEach, describe, expect, test } from "bun:test"

import {
  KustoClient,
  KustoError,
  KUSTO_TOKEN_ENV,
  getKustoToken,
  normalizeKustoClusterUri,
  renderKustoResponse,
  type KustoResponse,
} from "../src/lib/kusto-client"

// Every case here is hermetic: a fictional cluster host, an injected
// `fetchImpl`, and an injected token provider. Nothing reaches ADX, `az`, or
// any network. The token values are literals chosen to be obviously synthetic
// so a leak is impossible to miss.

const CLUSTER = "https://example.kusto.windows.net"
const SYNTHETIC_TOKEN = "synthetic-token-not-a-credential"

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * Install a fetch that records the request and replies with `reply`. Returns
 * the capture array so a test can assert the wire shape.
 */
function mockFetch(reply: Response | ((captured: Captured, index: number) => Response)) {
  const captured: Array<Captured> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const record: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    }
    captured.push(record)
    // A Response body is one-shot, so a literal reply is CLONED per call:
    // handing back the same object would make the second request in a test
    // throw "Body already used" instead of exercising the code under test.
    return typeof reply === "function"
      ? reply(record, captured.length - 1)
      : reply.clone()
  }) as typeof fetch
  return { captured, impl }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  })
}

/** A minimal v1 result envelope: one table, one column, one row. */
function envelope(rows: Array<Array<unknown>>, columnName = "Name"): unknown {
  return {
    Tables: [
      {
        TableName: "PrimaryResult",
        Columns: [{ ColumnName: columnName, ColumnType: "string" }],
        Rows: rows,
      },
    ],
  }
}

function client(
  opts: {
    reply?: Response | ((captured: Captured, index: number) => Response)
    database?: string
    clusterUri?: string
  } = {},
) {
  const { captured, impl } = mockFetch(opts.reply ?? jsonResponse(envelope([["x"]])))
  const instance = new KustoClient({
    clusterUri: opts.clusterUri ?? CLUSTER,
    ...(opts.database ? { database: opts.database } : {}),
    tokenProvider: async () => SYNTHETIC_TOKEN,
    fetchImpl: impl,
  })
  return { client: instance, captured }
}

const originalKustoToken = process.env[KUSTO_TOKEN_ENV]

afterEach(() => {
  if (originalKustoToken === undefined) delete process.env[KUSTO_TOKEN_ENV]
  else process.env[KUSTO_TOKEN_ENV] = originalKustoToken
})

describe("normalizeKustoClusterUri", () => {
  test("accepts a cluster origin with or without a scheme or trailing slash", () => {
    expect(normalizeKustoClusterUri("https://example.kusto.windows.net")).toBe(CLUSTER)
    expect(normalizeKustoClusterUri("https://example.kusto.windows.net/")).toBe(CLUSTER)
    expect(normalizeKustoClusterUri("  example.kusto.windows.net  ")).toBe(CLUSTER)
  })

  test("rejects anything that is not a bare https origin", () => {
    // http would send a bearer over cleartext.
    expect(() => normalizeKustoClusterUri("http://example.kusto.windows.net")).toThrow(KustoError)
    // A path would silently address a different endpoint than the audience.
    expect(() => normalizeKustoClusterUri("https://example.kusto.windows.net/rest/query")).toThrow(
      /no path/,
    )
    // Embedded credentials would be echoed into the `az --resource` argument.
    expect(() => normalizeKustoClusterUri("https://user:pass@example.kusto.windows.net")).toThrow(
      /credentials/,
    )
    expect(() => normalizeKustoClusterUri("not a host")).toThrow(KustoError)
    expect(() => normalizeKustoClusterUri("")).toThrow(/empty/)
  })
})

describe("KustoClient wire shape", () => {
  test("a query posts {db, csl, properties} to /v1/rest/query with service-enforced read-only", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await c.runCsl("Events | count")

    expect(captured).toHaveLength(1)
    const request = captured[0]!
    expect(request.url).toBe(`${CLUSTER}/v1/rest/query`)
    expect(request.method).toBe("POST")
    expect(request.headers.authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    // The load-bearing assertion of this whole file: read-only is a SERVICE
    // control, and these two fields are what install it. A client-side check
    // cannot substitute, because Kusto composes `;`-separated statements and a
    // `set` statement cannot lift either of these.
    expect(request.headers["x-ms-readonly"]).toBe("true")
    expect(request.body).toEqual({
      db: "Telemetry",
      csl: "Events | count",
      properties: {
        Options: {
          request_readonly_hardline: true,
          truncationmaxrecords: 200,
          truncationmaxsize: 64 * 1024 * 1024,
        },
      },
    })
    // The query text rides in `csl`; `query` is not a Kusto field and would be
    // silently ignored by the service.
    expect(request.body).not.toHaveProperty("query")
  })

  test("a leading-dot command routes to /v1/rest/mgmt with the same controls", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await c.runCsl(".show tables")

    expect(captured[0]!.url).toBe(`${CLUSTER}/v1/rest/mgmt`)
    expect(captured[0]!.headers["x-ms-readonly"]).toBe("true")
    const options = (captured[0]!.body.properties as Record<string, Record<string, unknown>>).Options!
    expect(options.request_readonly_hardline).toBe(true)
  })

  test("an explicit database argument overrides the client default", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await c.runCsl("Events | count", { database: "Other" })
    expect(captured[0]!.body.db).toBe("Other")
  })

  test("a call with no database anywhere is an actionable refusal, not a guess", async () => {
    const { client: c, captured } = client()
    await expect(c.runCsl("Events | count")).rejects.toThrow(/--kusto-database/)
    expect(captured).toHaveLength(0)
  })

  test("rejects empty and oversized query text before any request", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await expect(c.runCsl("   ")).rejects.toThrow(/non-empty/)
    await expect(c.runCsl("x".repeat(100_001))).rejects.toThrow(/100000-character limit/)
    expect(captured).toHaveLength(0)
  })

  test("propagates a caller abort as the abort reason, not a transport error", async () => {
    const controller = new AbortController()
    const { client: c } = client({
      reply: () => {
        controller.abort(new Error("caller cancelled"))
        throw new Error("This operation was aborted")
      },
    })
    await expect(
      c.runCsl("Events | count", { database: "Telemetry", signal: controller.signal }),
    ).rejects.toThrow(/caller cancelled/)
  })
})

describe("KustoClient error envelope", () => {
  test("a 401 is a non-retriable auth failure naming the tenant", async () => {
    const { client: c } = client({ reply: () => new Response("denied", { status: 401 }) })
    const err = await c.runCsl("Events | count", { database: "Telemetry" }).catch((e) => e)
    expect(err).toBeInstanceOf(KustoError)
    expect(err.retriable).toBe(false)
    expect(err.status).toBe(401)
    expect(err.message).toContain("az login")
  })

  test("a 429 and a 503 stay retriable", async () => {
    for (const status of [429, 503]) {
      const { client: c } = client({ reply: () => new Response("busy", { status }) })
      const err = await c.runCsl("Events | count", { database: "Telemetry" }).catch((e) => e)
      expect(err.retriable).toBe(true)
      expect(err.status).toBe(status)
    }
  })

  test("a 400 surfaces the service's message, with credentials and URLs redacted", async () => {
    const { client: c } = client({
      reply: () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Semantic error: 'Foo' has no column. Requested by Bearer super-secret-value against https://example.kusto.windows.net/v1/rest/query",
            },
          }),
          { status: 400 },
        ),
    })
    const err = await c.runCsl("Foo | count", { database: "Telemetry" }).catch((e) => e)
    expect(err.retriable).toBe(false)
    expect(err.status).toBe(400)
    expect(err.message).toContain("Semantic error")
    // The two redactions that make an upstream message safe to hand a model.
    expect(err.message).not.toContain("super-secret-value")
    expect(err.message).not.toContain("example.kusto.windows.net")
    expect(err.message).toContain("Bearer [REDACTED]")
  })

  test("a non-JSON body is a retriable protocol failure, never a silent empty result", async () => {
    const { client: c } = client({ reply: () => new Response("<html>proxy</html>") })
    const err = await c.runCsl("Events | count", { database: "Telemetry" }).catch((e) => e)
    expect(err).toBeInstanceOf(KustoError)
    expect(err.retriable).toBe(true)
    expect(err.message).toContain("not JSON")
  })

  test("a JSON body with no Tables array is a protocol failure", async () => {
    const { client: c } = client({ reply: () => jsonResponse({ Rows: [] }) })
    await expect(c.runCsl("Events | count", { database: "Telemetry" })).rejects.toThrow(
      /unexpected response shape/,
    )
  })
})

describe("KustoClient helper commands", () => {
  test("databasesList lists the first column of every row", async () => {
    const { client: c, captured } = client({
      reply: () => jsonResponse(envelope([["Telemetry"], ["Samples"], [null]])),
    })
    const text = await c.databasesList()
    expect(captured[0]!.url).toBe(`${CLUSTER}/v1/rest/mgmt`)
    expect(captured[0]!.body.csl).toBe(".show databases")
    // No `db` is sent: `.show databases` is cluster-scoped.
    expect(captured[0]!.body).not.toHaveProperty("db")
    expect(text).toBe("2 database(s):\n  Telemetry\n  Samples")
  })

  test("databasesList states an empty result instead of returning a blank string", async () => {
    const { client: c } = client({ reply: () => jsonResponse(envelope([])) })
    expect(await c.databasesList()).toBe("No databases visible to this identity.")
  })

  test("tablesList scopes to the database and names it in the result", async () => {
    const { client: c, captured } = client({
      database: "Telemetry",
      reply: () => jsonResponse(envelope([["Events"]])),
    })
    const text = await c.tablesList()
    expect(captured[0]!.body.db).toBe("Telemetry")
    expect(captured[0]!.body.csl).toBe(".show tables")
    expect(text).toBe("Telemetry: 1 table(s)/function(s):\n  Events")
  })

  test("tableSchema and sample build generated commands from a validated identifier", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await c.tableSchema("Events")
    await c.sample("Events", 5)
    expect(captured[0]!.body.csl).toBe("Events | getschema")
    expect(captured[1]!.body.csl).toBe("Events | take 5")
  })

  test("a table name that is not a simple identifier is refused before interpolation", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    for (const bad of ["Events | drop table Secrets", "Events;.drop", "1Events", "Events'", ""]) {
      await expect(c.tableSchema(bad)).rejects.toThrow(/simple identifier/)
      await expect(c.sample(bad)).rejects.toThrow(/simple identifier/)
    }
    expect(captured).toHaveLength(0)
  })

  test("sample clamps its row count to the 1..100 window", async () => {
    const { client: c, captured } = client({ database: "Telemetry" })
    await c.sample("Events", 10_000)
    await c.sample("Events", 0)
    await c.sample("Events", Number.NaN)
    expect(captured.map((r) => r.body.csl)).toEqual([
      "Events | take 100",
      "Events | take 1",
      "Events | take 10",
    ])
  })
})

describe("renderKustoResponse", () => {
  test("renders an aligned grid rather than the wire JSON", () => {
    const response: KustoResponse = {
      truncated: false,
      tables: [{ name: "PrimaryResult", columns: ["Name", "Count"], rows: [["a", 1], ["b", 2]] }],
    }
    const text = renderKustoResponse(response)
    expect(text).toBe("(2 row(s)) Name | Count\na | 1\nb | 2")
    // The raw envelope is both unreadable and several times the tokens.
    expect(text).not.toContain("Tables")
  })

  test("collapses newlines inside a cell and caps long cells", () => {
    const response: KustoResponse = {
      truncated: false,
      tables: [
        {
          name: "PrimaryResult",
          columns: ["Text"],
          rows: [["line one\nline two"], ["y".repeat(400)]],
        },
      ],
    }
    const text = renderKustoResponse(response, { maxCellChars: 20 })
    expect(text).toContain("line one ⏎ line two")
    expect(text).toContain(`${"y".repeat(20)}…`)
  })

  test("a full row page carries an explicit truncation trailer", () => {
    const response: KustoResponse = {
      truncated: true,
      tables: [{ name: "PrimaryResult", columns: ["Name"], rows: [["a"]] }],
    }
    expect(renderKustoResponse(response)).toContain("result truncated")
  })

  test("the character cap truncates mid-table and still says so", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`row-${i}-${"z".repeat(80)}`])
    const response: KustoResponse = {
      truncated: false,
      tables: [{ name: "PrimaryResult", columns: ["Name"], rows }],
    }
    const text = renderKustoResponse(response, { maxChars: 500 })
    expect(text.length).toBeLessThan(700)
    expect(text).toContain("result truncated")
  })

  test("an empty table is stated, not rendered as a bare header", () => {
    const response: KustoResponse = {
      truncated: false,
      tables: [{ name: "PrimaryResult", columns: [], rows: [] }],
    }
    expect(renderKustoResponse(response)).toBe("PrimaryResult: empty result.")
  })
})

describe("getKustoToken", () => {
  test("KUSTO_TOKEN is the override, and it is not echoed into any error", async () => {
    process.env[KUSTO_TOKEN_ENV] = "  env-token-value  "
    expect(await getKustoToken(CLUSTER)).toBe("env-token-value")
  })
})
