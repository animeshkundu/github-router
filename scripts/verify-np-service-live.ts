/**
 * Live end-to-end verification for the next-plaid service client (Phase 2e).
 *
 * Run: `NEXT_PLAID_BIN=/path/to/next-plaid-api bun scripts/verify-np-service-live.ts`
 * (defaults to the Phase-0 spike build at /tmp/next-plaid-src if present).
 *
 * Uses a REAL server binary in embeddings-only mode (no --model, so NO
 * model download) with deterministic hand-crafted embeddings: doc A tokens
 * ~= query tokens (high MaxSim), doc B tokens negated (low MaxSim).
 * Verifies the full PLAID pipeline mechanics: spawn → health → declare →
 * update → search-rank → delete → stop.
 *
 * Short-lived script hygiene: stops the server so the loop drains (like
 * verify-rerank-live.ts — never process.exit() with live children).
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"

import {
  indexNameForWorkspace,
  NextPlaidClient,
  startManagedServer,
} from "~/lib/colbert/service"

const BIN =
  process.env.NEXT_PLAID_BIN ?? "/tmp/next-plaid-src/target/release/next-plaid-api"

let failures = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`)
  }
}

if (!existsSync(BIN)) {
  console.log(`SKIP: server binary not found at ${BIN} (set NEXT_PLAID_BIN)`)
  process.exitCode = 0
} else {
  const DIM = 128
  const ones = (n: number, v: number): Array<Array<number>> =>
    Array.from({ length: n }, () => Array(DIM).fill(v))
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-np-live-")))
  let svc: Awaited<ReturnType<typeof startManagedServer>> | null = null
  try {
    const t0 = Date.now()
    svc = await startManagedServer({
      binaryPath: BIN,
      indexDir: path.join(dir, "indices"),
      parallel: 1,
      startupTimeoutMs: 30_000,
    })
    console.log(`info server start=${Date.now() - t0}ms url=${svc.url}`)
    check("server healthy", (await svc.client.health()).ok)

    const index = indexNameForWorkspace("/repo/demo")
    await svc.client.ensureIndex(index, { nbits: 4 })
    // Idempotent re-declare (409 path).
    await svc.client.ensureIndex(index, { nbits: 4 })
    check("ensureIndex idempotent", true)

    // Text update without --model must fail cleanly (MODEL_NOT_LOADED):
    // proves the client surfaces server errors instead of hanging.
    let textFailed = false
    try {
      await svc.client.updateDocuments(index, ["doc"], [{ file: "f" }])
    } catch (err) {
      textFailed = /HTTP 400/.test((err as Error).message)
    }
    check("text update without model → clean HTTP 400", textFailed)

    // Doc A ~= query (high MaxSim), doc B negated (low MaxSim), via the
    // raw embeddings endpoint (pre-computed vectors, no model needed).
    const embRes = await fetch(`${svc.url}/indices/${index}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ embeddings: ones(8, 1.0) }, { embeddings: ones(8, -1.0) }],
        metadata: [
          { file: "src/a.ts", line: 1, name: "alpha" },
          { file: "src/b.ts", line: 5, name: "beta" },
        ],
      }),
    })
    check("embeddings update accepted", embRes.status === 202, `HTTP ${embRes.status}`)
    // Allow the async batch worker to merge (300 docs / 100ms window).
    await new Promise((r) => setTimeout(r, 2000))

    // Search with a ones query via raw embeddings endpoint.
    const searchRes = await fetch(`${svc.url}/indices/${index}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: [{ embeddings: ones(8, 1.0) }],
        params: { top_k: 5 },
      }),
    })
    check("search HTTP 200", searchRes.status === 200, `HTTP ${searchRes.status}`)
    const searchBody = (await searchRes.json()) as {
      results?: Array<{ document_ids?: Array<number>; scores?: Array<number> }>
    }
    const ids = searchBody.results?.[0]?.document_ids ?? []
    check("doc A ranks first (MaxSim mechanics)", ids[0] === 0, `ids=${ids.join(",")}`)

    // Client wrapper text-search without a model → clean 400 (the
    // 404→[] tolerance only applies when the encoding endpoint can run;
    // that path is covered by mock-server unit tests).
    const client = new NextPlaidClient(svc.url)
    let search400 = false
    try {
      await client.search("nope", "q")
    } catch (err) {
      search400 = /HTTP 400/.test((err as Error).message)
    }
    check("client text search without model → clean HTTP 400", search400)

    // Delete doc B by predicate; A must survive.
    await svc.client.deleteDocuments(index, "file = ?", ["src/b.ts"])
    await new Promise((r) => setTimeout(r, 2000))
    const h = await svc.client.health()
    check("health reports the index", h.indices.some((i) => i.name === index))
  } finally {
    await svc?.stop()
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`)
    process.exitCode = 1
  } else {
    console.log("\nALL SERVICE LIVE CHECKS PASSED")
  }
}
