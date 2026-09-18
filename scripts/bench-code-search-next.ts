/**
 * Benchmark: lexical code search after the Phase 1 fixes + Phase 3 rerank.
 *
 * Run: `bun scripts/bench-code-search-next.ts [workspace]`
 *
 * Measures on the target repo:
 *   1. Single-query latency by mode (symbol / NL / exact) with
 *      elapsed_ms + outline_ms + rerank breakdown from the response.
 *   2. 16-way parallel ranked burst: wall time, per-query elapsed,
 *      completion (the 4-core/16-parallel goal, measured here on this
 *      machine's core count with semaphore math noted).
 *
 * Short-lived script hygiene: shuts down the tree-sitter pool so the
 * process exits (see shutdownTreeSitterPool docs).
 */

import * as os from "node:os"

import { searchCode } from "~/lib/code-search"
import { disposeRerankers, drainRerankerLoads } from "~/lib/rerank"
import { shutdownTreeSitterPool } from "~/lib/tree-sitter-pool/pool"

const workspace = process.argv[2] ?? process.cwd()

type Row = { name: string; ms: number; extra?: string }

async function single(
  name: string,
  query: string,
  mode: "ranked" | "literal" | "regex" = "ranked",
): Promise<Row> {
  const t0 = Date.now()
  const r = await searchCode({ query, workspace, mode, summary: true })
  const ms = Date.now() - t0
  const algo = r.ranking.algorithm
  console.log(
    `${name}: wall=${ms}ms elapsed=${r.elapsed_ms}ms hits=${r.results.length} algo=${algo}`,
  )
  return { name, ms, extra: algo }
}

function stats(rows: Array<Row>): void {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))]
  console.log(
    `n=${ms.length} min=${ms[0]}ms p50=${pct(50)}ms p95=${pct(95)}ms max=${ms[ms.length - 1]}ms`,
  )
}

console.log(`workspace: ${workspace} (cores: ${os.cpus().length})`)

// ---- 0. Warmup (cold model loads would otherwise dominate: first NL
// query races the ~100ms load against the 150ms rerank budget and usually
// misses, then self-heals. Warmup puts the bench in production steady
// state where singletons stay resident for the proxy's lifetime).
{
  const warm = await searchCode({
    query: "warmup retry fetch",
    workspace,
    mode: "ranked",
    summary: false,
  })
  console.log(`warmup: algo=${warm.ranking.algorithm} elapsed=${warm.elapsed_ms}ms`)
}

// ---- 1. Single queries ----
const singles: Array<Row> = []
singles.push(await single("symbol  ", "runUnifiedCodeSearch", "ranked"))
singles.push(await single("NL      ", "retry around the upstream fetch", "ranked"))
singles.push(await single("exact   ", "runUnifiedCodeSearch", "literal"))
stats(singles)

// ---- 2. 16-way parallel ranked burst ----
{
  const queries = [
    "runUnifiedCodeSearch",
    "retry around the upstream fetch",
    "validateWorkspace",
    "where is the token validated",
    "confirmDefinitionSites",
    "connection pooling logic",
    "acquireSearchSlot",
    "how does ranking work",
    "outlineFromTree",
    "error handling paths",
    "kickBackgroundInit",
    "semantic index status",
    "parseRgJsonStream",
    "who calls this function",
    "freshnessVerdict",
    "rate limit backoff",
  ]
  const t0 = Date.now()
  const results = await Promise.all(
    queries.map((q, i) =>
      searchCode({ query: q, workspace, mode: "ranked", summary: i % 2 === 0 }).then((r) => ({
        name: `q${i}`,
        ms: r.elapsed_ms,
        extra: r.ranking.algorithm,
      })),
    ),
  )
  const wall = Date.now() - t0
  console.log(`16-parallel: wall=${wall}ms`)
  stats(results)
  const reranked = results.filter((r) => r.extra === "BM25F+FlashRank").length
  console.log(`reranked: ${reranked}/16 (NL-shaped only, by design)`)
}

// Cleanup for clean exit.
await drainRerankerLoads()
await disposeRerankers()
shutdownTreeSitterPool()
console.log("done")
