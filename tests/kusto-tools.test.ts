import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"

import { KUSTO_TOKEN_ENV } from "../src/lib/kusto-client"
import { KUSTO_TOOLS, resetKustoClientForTesting } from "../src/lib/kusto-tools"
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
