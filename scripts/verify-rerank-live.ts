/**
 * Live verification for the JIT rerank stage (Phase 3).
 *
 * Run: `bun scripts/verify-rerank-live.ts`
 *
 * Uses REAL flashrank-js models (downloads tiny ~4MB + mini ~23MB on first
 * run, cached thereafter). NOT part of `bun test`: real ONNX sessions crash
 * `bun test` at teardown (SIGABRT after a green run) while identical `bun
 * run` scripts exit cleanly — see tests/rerank.test.ts header. This script
 * is the live-verification lane (manual + CI script step).
 *
 * Verifies:
 *   1. tiny model loads and ranks a crafted case correctly (+ timings)
 *   2. mini model loads (+ timing)
 *   3. searchCode end-to-end: NL query flips ranking.algorithm to
 *      BM25F+FlashRank; single-identifier stays BM25F
 *   4. 16-way concurrent rerank safety (production burst shape)
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { Reranker } from "flashrank-js"

import { searchCode } from "~/lib/code-search"

let failures = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`)
  }
}

// ---- 1. tiny model quality + timing ----
{
  const t0 = Date.now()
  const tiny = await Reranker.create({ model: "tiny" })
  const loadMs = Date.now() - t0
  const docs = [
    "const x = 42;",
    'export function refreshAuthToken() { return fetch("/auth/refresh"); }',
    'import React from "react";',
  ]
  const t1 = Date.now()
  const out = await tiny.rerank({ query: "auth token refresh", documents: docs, topN: 3 })
  const rerankMs = Date.now() - t1
  check("tiny ranks auth doc first", out[0]?.index === 1, `order=${out.map((r) => r.index).join(",")}`)
  check("tiny returns full permutation", out.length === 3)
  console.log(`info tiny load=${loadMs}ms rerank5docs~${rerankMs}ms`)
  await tiny.dispose()
}

// ---- 2. mini model loads ----
{
  const t0 = Date.now()
  const mini = await Reranker.create({ model: "mini" })
  console.log(`info mini load=${Date.now() - t0}ms`)
  const out = await mini.rerank({
    query: "auth token refresh",
    documents: ["const x = 42;", "export function refreshAuthToken() { return 1; }"],
    topN: 2,
  })
  check("mini ranks auth doc first", out[0]?.index === 1)
  await mini.dispose()
}

// ---- 3. searchCode end-to-end ----
{
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-rerank-live-")))
  try {
    mkdirSync(path.join(root, "src"))
    for (const name of ["aaa.ts", "bbb.ts", "ccc.ts"]) {
      writeFileSync(
        path.join(root, "src", name),
        `// retry policy around the upstream fetch\nexport const ${name[0]} = 1\n`,
      )
    }
    const t0 = Date.now()
    const nl = await searchCode({
      query: "retry policy around",
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    console.log(`info NL query elapsed=${Date.now() - t0}ms hits=${nl.results.length}`)
    check("NL query uses BM25F+FlashRank", nl.ranking.algorithm === "BM25F+FlashRank")
    check("NL query returns hits", nl.results.length >= 3)

    const ident = await searchCode({
      query: "retry",
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    check("single identifier stays BM25F", ident.ranking.algorithm === "BM25F")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 4. 16-way concurrent rerank (burst shape) ----
{
  const tiny = await Reranker.create({ model: "tiny" })
  const docs = ["export function refreshAuthToken() { return 1; }", "const x = 42;"]
  const t0 = Date.now()
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      tiny.rerank({ query: `auth token ${i}`, documents: docs, topN: 2 }),
    ),
  )
  console.log(`info 16-way concurrent rerank=${Date.now() - t0}ms`)
  check(
    "all 16 concurrent reranks return 2 rows",
    results.every((r) => r.length === 2),
  )
  await tiny.dispose()
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  // NOTE: set exitCode and drain — never process.exit() with live ONNX
  // sessions: forcing exit with native state alive crashes Bun (SIGABRT).
  // Dispose + drain lets the event loop exit safely on its own.
  process.exitCode = 1
} else {
  console.log("\nALL LIVE CHECKS PASSED")
}

// Release native resources so this short-lived script exits instead of
// hanging: ONNX sessions (event-loop handles) and tree-sitter pool workers
// (unref()-ed workers still hold Bun's loop open). The long-lived proxy
// never needs this — workers stay warm and die with the process.
const { disposeRerankers, drainRerankerLoads } = await import("~/lib/rerank")
const { shutdownTreeSitterPool } = await import("~/lib/tree-sitter-pool/pool")
console.log("cleanup: draining loads...")
await drainRerankerLoads()
console.log("cleanup: disposing sessions + pool...")
await disposeRerankers()
shutdownTreeSitterPool()
console.log("cleanup: done, draining")
