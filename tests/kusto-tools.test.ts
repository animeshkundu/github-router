import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"

import { KUSTO_TOKEN_ENV } from "../src/lib/kusto-client"
import {
  KUSTO_TOOLS,
  kustoClientCountForTesting,
  resetKustoClientForTesting,
} from "../src/lib/kusto-tools"
import { state } from "../src/lib/state"

// Hermetic: a fictional cluster host, an injected `fetch`, and a synthetic
// token literal. Nothing here reaches ADX, `az`, or any network.

const CLUSTER = "https://example.kusto.windows.net"
const SYNTHETIC_TOKEN = "synthetic-token-not-a-credential"

const originalFetch = globalThis.fetch
const originalToken = process.env[KUSTO_TOKEN_ENV]

/** One envelope with `rows` rows of `cellChars` characters each. */
function envelope(rows: number, cellChars: number): unknown {
  return {
    Tables: [
      {
        TableName: "PrimaryResult",
        Columns: [{ ColumnName: "Payload", ColumnType: "string" }],
        Rows: Array.from({ length: rows }, () => ["z".repeat(cellChars)]),
      },
    ],
  }
}

function installKusto(kustoJson: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(kustoJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

/**
 * Same stub, recording every requested URL. The per-call cluster tests assert
 * on the ORIGIN that was actually contacted, because that is the property under
 * test: an argument echoed into the wrong client would still render a result.
 */
function capturingFetch(kustoJson: unknown): { urls: Array<string> } {
  const urls: Array<string> = []
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify(kustoJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { urls }
}

function tool(name: string) {
  const found = KUSTO_TOOLS.find((t) => t.toolNameHttp === name)
  if (!found) throw new Error(`no kusto tool named ${name}`)
  return found
}

/** The first text block's text, asserted rather than assumed. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0]
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block")
  }
  return block.text
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env[KUSTO_TOKEN_ENV]
  else process.env[KUSTO_TOKEN_ENV] = originalToken
  resetKustoClientForTesting()
  state.kustoCluster = null
  state.kustoDatabase = null
})

describe("kusto tool boundary — relay cap", () => {
  test("a grid over the relay ceiling spills IN FULL and returns a preview plus the path", async () => {
    process.env[KUSTO_TOKEN_ENV] = SYNTHETIC_TOKEN
    state.kustoCluster = CLUSTER
    state.kustoDatabase = "Telemetry"
    // 200 rows x 300 chars is exactly the rendered worst case the client's
    // row cap allows, i.e. the largest grid a caller can provoke.
    installKusto(envelope(200, 300))

    const result = await tool("query").handler({ csl: "Events | count" })
    const text = textOf(result)
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(text).toContain("full result saved to:")
    const saved = /full result saved to: (.+)\]/u.exec(text)?.[1]
    expect(saved).toBeTruthy()
    // The file really holds what the trailer promises: the rendered grid in
    // full, not the preview the model was handed.
    expect(readFileSync(saved!, "utf8")).toContain("z".repeat(300))
    rmSync(saved!, { force: true })
  })

  test("a result under the ceiling is returned unchanged", async () => {
    process.env[KUSTO_TOKEN_ENV] = SYNTHETIC_TOKEN
    state.kustoCluster = CLUSTER
    state.kustoDatabase = "Telemetry"
    installKusto(envelope(2, 5))

    const result = await tool("query").handler({ csl: "Events | count" })
    expect(textOf(result)).not.toContain("full result saved to:")
    expect(textOf(result)).toContain("zzzzz")
  })

  test("the spill file itself says the client's render cap was hit", async () => {
    process.env[KUSTO_TOKEN_ENV] = SYNTHETIC_TOKEN
    state.kustoCluster = CLUSTER
    state.kustoDatabase = "Telemetry"
    installKusto(envelope(200, 300))

    const result = await tool("query").handler({ csl: "Events | count" })
    const saved = /full result saved to: (.+)\]/u.exec(textOf(result))?.[1]
    expect(saved).toBeTruthy()
    // The two caps compose without lying: the spill trailer promises the full
    // RELAY result, and the file carries the client's own trailer saying its
    // render cap was reached, so "full" cannot be read as "everything Kusto
    // had". The preview cannot carry that trailer (it is cut from the head).
    const spilled = readFileSync(saved!, "utf8")
    expect(spilled).toContain("… result truncated at the client's row/character cap")
    expect(spilled.length).toBeLessThanOrEqual(60_000 + 120)
    rmSync(saved!, { force: true })
  })
})

// Different tables live in different clusters, so the cluster is a per-call
// argument: `--kusto-cluster` is a default, not the whole capability.
describe("kusto tool boundary — per-call cluster", () => {
  // A second cluster on the reserved `.example.com` domain. The `kusto` label
  // is in the interior and the suffix is deliberately not an Azure domain: the
  // per-call check is a hostname shape check, not an ownership allowlist.
  const SECOND = "https://cluster.kusto.example.com"

  function configure(cluster: string | null): void {
    process.env[KUSTO_TOKEN_ENV] = SYNTHETIC_TOKEN
    state.kustoCluster = cluster
    state.kustoDatabase = "Telemetry"
  }

  test("a call's `cluster` overrides the launch default", async () => {
    configure(CLUSTER)
    const { urls } = capturingFetch(envelope(1, 3))

    await tool("query").handler({ csl: "Events | count", cluster: SECOND })

    expect(urls).toHaveLength(1)
    expect(new URL(urls[0]!).origin).toBe(SECOND)
  })

  test("with no launch cluster, a call that names one works and one that omits it says what to do", async () => {
    configure(null)
    const { urls } = capturingFetch(envelope(1, 3))

    await tool("databases").handler({ cluster: SECOND })
    expect(new URL(urls[0]!).origin).toBe(SECOND)
    expect(urls[0]).toContain("/v1/rest/mgmt")

    await expect(tool("query").handler({ csl: "Events | count" }))
      .rejects.toThrow(/Pass `cluster`/)
    // The refusal is a shape verdict: nothing was minted and nothing was sent.
    expect(urls).toHaveLength(1)
  })

  test("one client per cluster, keyed on the normalized origin", async () => {
    configure(CLUSTER)
    const { urls } = capturingFetch(envelope(1, 3))

    await tool("query").handler({ csl: "Events | count" })
    await tool("query").handler({ csl: "Events | count", cluster: SECOND })
    await tool("query").handler({ csl: "Events | count", cluster: "Cluster.KuStO.Example.com" })
    await tool("query").handler({ csl: "Events | count" })

    // Three spellings of the second cluster, two clusters, two clients.
    expect(kustoClientCountForTesting()).toBe(2)
    expect(urls.map((url) => new URL(url).origin)).toEqual([
      CLUSTER,
      SECOND,
      SECOND,
      CLUSTER,
    ])
  })

  test("a bare host and a trailing-slash URI are the same cluster", async () => {
    // The default is set in a spelling the call argument does not use. Keys
    // built from raw text would hold two clients for one cluster, and the
    // second one's token audience would come from a string, not an origin.
    configure(`${CLUSTER}/`)
    capturingFetch(envelope(1, 3))

    await tool("query").handler({ csl: "Events | count" })
    await tool("query").handler({ csl: "Events | count", cluster: "example.kusto.windows.net" })

    expect(kustoClientCountForTesting()).toBe(1)
  })

  test("a host without a standalone kusto label is refused before any request", async () => {
    configure(CLUSTER)
    const { urls } = capturingFetch(envelope(1, 3))

    for (const cluster of ["https://gateway.example.com", "https://notkusto.example.com"]) {
      await expect(tool("query").handler({ csl: "Events | count", cluster }))
        .rejects.toThrow(/standalone `kusto` DNS label/)
    }

    expect(urls).toHaveLength(0)
  })

  test("a malformed `cluster` is a shape error, not a request", async () => {
    configure(CLUSTER)
    const { urls } = capturingFetch(envelope(1, 3))

    for (const bad of [
      7,
      "",
      "   ",
      "http://example.kusto.windows.net",
      "https://example.kusto.windows.net/path",
      "https://user:pass@example.kusto.windows.net",
    ]) {
      await expect(tool("query").handler({ csl: "Events | count", cluster: bad }))
        .rejects.toThrow()
    }

    expect(urls).toHaveLength(0)
  })
})
