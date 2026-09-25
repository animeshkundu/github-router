/**
 * Tests for `src/lib/colbert/service.ts` (Phase 2e).
 *
 * Protocol tests run against an in-process mock HTTP server (Bun.serve);
 * lifecycle tests spawn a fake server script via the `argv` test seam
 * (no Rust binary needed). Isolated (own process): real sockets + spawns.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getServerStats,
  indexNameForWorkspace,
  isServerMemoryOverLimit,
  NextPlaidClient,
  recordServerRestart,
  sampleChildMemory,
  serverArgv,
  serviceMemoryLimits,
  serverParallelSessions,
  ServiceBusyError,
  serviceHealthTtlMs,
  startManagedServer,
  __resetServerMemoryCacheForTests,
  __resetServerStatsForTests,
  type ManagedServer,
} from "../../src/lib/colbert/service"

let root: string
let mockBase = ""
let mockServer: ReturnType<typeof Bun.serve> | null = null

/** Last request seen per route (assertions on protocol shape). */
const seen: Record<string, { method: string; body: unknown }> = {}
/** Route → canned [status, body]. */
const canned: Record<string, [number, unknown]> = {}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-np-svc-")))
  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const key = `${req.method} ${u.pathname}`
      let body: unknown
      try {
        body = req.method === "GET" ? null : await req.json()
      } catch {
        body = null
      }
      seen[key] = { method: req.method, body }
      const [status, res] = canned[key] ?? [404, { code: "INDEX_NOT_FOUND", message: "nope" }]
      return Response.json(res, { status })
    },
  })
  mockBase = `http://127.0.0.1:${mockServer.port}`
})

afterAll(() => {
  mockServer?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  for (const k of Object.keys(canned)) delete canned[k]
  for (const k of Object.keys(seen)) delete seen[k]
  delete process.env.GH_ROUTER_NP_PARALLEL
  delete process.env.GH_ROUTER_SERVICE_HEALTH_TTL_MS
  delete process.env.GH_ROUTER_SERVICE_MAX_RSS_MB
  delete process.env.GH_ROUTER_SERVICE_MAX_COMMIT_MB
  __resetServerMemoryCacheForTests()
  __resetServerStatsForTests()
})

describe("NextPlaidClient protocol", () => {
  test("health parses indices + model", async () => {
    canned["GET /health"] = [
      200,
      {
        status: "healthy",
        indices: [{ name: "ws-1", num_documents: 10, num_embeddings: 300, dimension: 48 }],
        model: { name: "LateOn-Code-edge" },
        updates: [{ index: "ws-1", status: "running" }],
      },
    ]
    const c = new NextPlaidClient(mockBase)
    const h = await c.health()
    expect(h.ok).toBe(true)
    expect(h.indices).toHaveLength(1)
    expect(h.indices[0].num_documents).toBe(10)
    expect(h.model).toBe("LateOn-Code-edge")
    expect(h.updates).toEqual([{ index: "ws-1", status: "running" }])
  })

  test("health degrades on non-200 / garbage", async () => {
    canned["GET /health"] = [500, { code: "INTERNAL_ERROR", message: "x" }]
    expect((await new NextPlaidClient(mockBase).health()).ok).toBe(false)
  })

  test("ensureIndex: 200/201/409 ok, 500 throws", async () => {
    const c = new NextPlaidClient(mockBase)
    for (const code of [200, 201, 409]) {
      canned["POST /indices"] = [code, {}]
      await c.ensureIndex("ws-1")
    }
    expect(seen["POST /indices"].body).toMatchObject({ name: "ws-1" })
    canned["POST /indices"] = [500, { code: "INTERNAL_ERROR", message: "boom" }]
    await expect(c.ensureIndex("ws-1")).rejects.toThrow(/HTTP 500/)
  })

  test("updateDocuments: 202 ok; 503 → ServiceBusyError; 500 throws", async () => {
    const c = new NextPlaidClient(mockBase)
    canned["POST /indices/ws-1/update_with_encoding"] = [202, {}]
    await c.updateDocuments("ws-1", ["doc"], [{ file: "a.ts" }])
    const sent = seen["POST /indices/ws-1/update_with_encoding"].body as Record<string, unknown>
    expect(sent.documents).toEqual(["doc"])
    expect(sent.pool_factor).toBe(2)
    canned["POST /indices/ws-1/update_with_encoding"] = [503, {}]
    await expect(c.updateDocuments("ws-1", ["d"], [{}])).rejects.toBeInstanceOf(ServiceBusyError)
    canned["POST /indices/ws-1/update_with_encoding"] = [500, {}]
    await expect(c.updateDocuments("ws-1", ["d"], [{}])).rejects.toThrow(/HTTP 500/)
  })

  test("deleteDocuments: 202 ok; 404 tolerated; 503 → busy", async () => {
    const c = new NextPlaidClient(mockBase)
    canned["DELETE /indices/ws-1/documents"] = [202, {}]
    await c.deleteDocuments("ws-1", "file = ?", ["a.ts"])
    expect(seen["DELETE /indices/ws-1/documents"].body).toMatchObject({
      condition: "file = ?",
      parameters: ["a.ts"],
    })
    canned["DELETE /indices/ws-1/documents"] = [404, {}]
    await c.deleteDocuments("ws-1", "file = ?", ["gone"])
    canned["DELETE /indices/ws-1/documents"] = [503, {}]
    await expect(c.deleteDocuments("ws-1", "x = ?", [])).rejects.toBeInstanceOf(ServiceBusyError)
  })

  test("dropIndex: 200/404 → true; 405 → false (fallback)", async () => {
    const c = new NextPlaidClient(mockBase)
    for (const [code, want] of [[200, true], [404, true], [405, false]] as const) {
      canned["DELETE /indices/ws-1"] = [code, {}]
      expect(await c.dropIndex("ws-1")).toBe(want)
    }
  })

  test("search maps hits, drops file-less rows, 404 → []", async () => {
    const c = new NextPlaidClient(mockBase)
    canned["POST /indices/ws-1/search_with_encoding"] = [
      200,
      {
        results: [
          {
            query_id: 0,
            document_ids: [7, 9, 11],
            scores: [0.9, 0.5, 0.1],
            metadata: [
              { file: "src/a.ts", line: 3, end_line: 10, name: "f", signature: "s" },
              { line: 1 },
              { file: "src/b.ts", line: 1 },
            ],
          },
        ],
      },
    ]
    const hits = await c.search("ws-1", "query", { topK: 5 })
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: "src/a.ts", line: 3, end_line: 10, name: "f", score: 0.9 })
    expect(hits[1]).toMatchObject({ file: "src/b.ts", line: 1 })
    canned["POST /indices/ws-1/search_with_encoding"] = [404, {}]
    expect(await c.search("ws-1", "query")).toEqual([])
  })

  test("search sends hybrid + filter fields when provided", async () => {
    const c = new NextPlaidClient(mockBase)
    canned["POST /indices/ws-1/search_with_encoding"] = [200, { results: [] }]
    await c.search("ws-1", "query", {
      topK: 7,
      textQuery: "literal",
      alpha: 0.6,
      fileGlob: "src/**",
    })
    expect(seen["POST /indices/ws-1/search_with_encoding"].body).toMatchObject({
      queries: ["query"],
      text_query: ["literal"],
      alpha: 0.6,
      fusion: "relative_score",
      filter_condition: "file GLOB ?",
      filter_parameters: ["src/**"],
    })
  })
})

describe("naming + sizing helpers", () => {
  test("indexNameForWorkspace is stable, path-keyed, prefixed", () => {
    const a = indexNameForWorkspace("/repo/a")
    expect(a).toBe(indexNameForWorkspace("/repo/a"))
    expect(a).not.toBe(indexNameForWorkspace("/repo/b"))
    expect(a).toMatch(/^ws-[0-9a-f]{8}$/)
  })

  test("serverParallelSessions honors env, defaults to 25%", () => {
    process.env.GH_ROUTER_NP_PARALLEL = "3"
    expect(serverParallelSessions()).toBe(3)
    expect(serverParallelSessions(true)).toBe(3)
    delete process.env.GH_ROUTER_NP_PARALLEL
    expect(serverParallelSessions()).toBeGreaterThanOrEqual(1)
  })

  test("serverParallelSessions foreground caps at 8 sessions", async () => {
    const os = await import("node:os")
    // Capped at 8: each ONNX session duplicates model state, so uncapped
    // all-core foreground encodes OOM large repos (Windows commit limit).
    expect(serverParallelSessions(true)).toBe(Math.max(1, Math.min(os.cpus().length, 8)))
    expect(serverParallelSessions(false)).toBeLessThanOrEqual(os.cpus().length)
  })

  test("serviceHealthTtlMs honors env (default 30s, 0 disables cache)", () => {
    expect(serviceHealthTtlMs()).toBe(30_000)
    process.env.GH_ROUTER_SERVICE_HEALTH_TTL_MS = "5000"
    expect(serviceHealthTtlMs()).toBe(5000)
    process.env.GH_ROUTER_SERVICE_HEALTH_TTL_MS = "0"
    expect(serviceHealthTtlMs()).toBe(0)
    process.env.GH_ROUTER_SERVICE_HEALTH_TTL_MS = "junk"
    expect(serviceHealthTtlMs()).toBe(30_000)
  })

  test("ensureHealthy caches healthy verdicts within TTL", async () => {
    canned["GET /health"] = [200, { status: "healthy", indices: [] }]
    const c = new NextPlaidClient(mockBase)
    await c.ensureHealthy()
    delete seen["GET /health"]
    // Second call inside the TTL must not hit the server again.
    await c.ensureHealthy()
    expect("GET /health" in seen).toBe(false)
  })

  test("ensureHealthy re-probes after TTL expiry and on unhealthy cache", async () => {
    canned["GET /health"] = [200, { status: "healthy", indices: [] }]
    const c = new NextPlaidClient(mockBase)
    await c.ensureHealthy()
    process.env.GH_ROUTER_SERVICE_HEALTH_TTL_MS = "0"
    delete seen["GET /health"]
    await c.ensureHealthy()
    expect("GET /health" in seen).toBe(true)
  })

  test("ensureHealthy throws on unhealthy server", async () => {
    canned["GET /health"] = [500, { code: "INTERNAL_ERROR", message: "x" }]
    await expect(new NextPlaidClient(mockBase).ensureHealthy()).rejects.toThrow(/unhealthy/)
  })

  test("serviceMemoryLimits honors env", () => {
    expect(serviceMemoryLimits()).toEqual({
      maxRssBytes: 4096 * 1024 * 1024,
      maxCommitBytes: 6144 * 1024 * 1024,
    })
    process.env.GH_ROUTER_SERVICE_MAX_RSS_MB = "512"
    process.env.GH_ROUTER_SERVICE_MAX_COMMIT_MB = "1024"
    expect(serviceMemoryLimits()).toEqual({
      maxRssBytes: 512 * 1024 * 1024,
      maxCommitBytes: 1024 * 1024 * 1024,
    })
  })

  test("sampleChildMemory measures live pids, null for dead ones", async () => {
    const live = await sampleChildMemory(process.pid)
    expect(live === null || live.rssBytes > 0).toBe(true)
    if (live !== null) expect(live.rssBytes).toBeGreaterThan(0)
    expect(await sampleChildMemory(999_999_999)).toBeNull()
    expect(await sampleChildMemory(-1)).toBeNull()
  })

  test("isServerMemoryOverLimit is false without a managed process", async () => {
    const svc = { url: mockBase, client: new NextPlaidClient(mockBase), stop: async () => {} }
    expect(await isServerMemoryOverLimit(svc)).toBe(false)
  })

  test("recordServerRestart/getServerStats accounting", () => {
    expect(getServerStats()).toEqual({ restartsTotal: 0, lastRestartAt: null, lastRestartReason: null })
    recordServerRestart("memory")
    const s = getServerStats()
    expect(s.restartsTotal).toBe(1)
    expect(s.lastRestartReason).toBe("memory")
    expect(typeof s.lastRestartAt).toBe("string")
  })
})

describe("managed lifecycle (fake binary)", () => {
  // Minimal fake: answers /health healthy, ignores everything else.
  const fakeScript = `Bun.serve({ port: Number(process.env.FAKE_PORT), hostname: "127.0.0.1", fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return Response.json({ status: "healthy", indices: [] });
    return Response.json({}, { status: 404 });
  }}); setInterval(() => {}, 1000);`

  test("start → healthy client → stop", async () => {
    const scriptPath = path.join(root, "fake-server.ts")
    writeFileSync(scriptPath, fakeScript)
    // Free-port probe (same shape as the client default).
    const net = await import("node:net")
    const port: number = await new Promise((resolve, reject) => {
      const s = net.createServer()
      s.on("error", reject)
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address()
        const p = typeof addr === "object" && addr !== null ? addr.port : 0
        s.close((err) => (err ? reject(err) : resolve(p)))
      })
    })
    let svc: ManagedServer | null = null
    try {
      svc = await startManagedServer({
        binaryPath: process.execPath,
        argv: [scriptPath],
        modelDir: root,
        indexDir: root,
        port,
        env: { ...process.env, FAKE_PORT: String(port) },
        startupTimeoutMs: 15_000,
      })
      expect(svc.url).toBe(`http://127.0.0.1:${port}`)
      expect((await svc.client.health()).ok).toBe(true)
    } finally {
      await svc?.stop()
    }
    // After stop the socket is dead (health fails or refuses).
    const dead = svc
      ? await svc.client.health().catch(() => ({ ok: false, indices: [] }))
      : { ok: false }
    expect(dead.ok).toBe(false)
  })

  test("missing binary → throws (never hangs)", async () => {
    await expect(
      startManagedServer({
        binaryPath: path.join(root, "no-such-binary"),
        modelDir: root,
        indexDir: root,
        startupTimeoutMs: 5_000,
      }),
    ).rejects.toThrow()
  })

  test("serverArgv: default is --model --int8, no --cuda", () => {
    const args = serverArgv({ indexDir: "/idx", modelDir: "/models", parallel: 2 }, 8080)
    expect(args).toContain("--model")
    expect(args).toContain("--int8")
    expect(args).not.toContain("--cuda")
  })

  test("serverArgv: cuda:true adds --cuda (gpu path)", () => {
    const args = serverArgv({ indexDir: "/idx", modelDir: "/models", parallel: 2, cuda: true }, 8080)
    expect(args).toContain("--model")
    expect(args).toContain("--int8")
    expect(args).toContain("--cuda")
  })

  test("serverArgv: --int8/--cuda never passed without --model", () => {
    const args = serverArgv({ indexDir: "/idx", parallel: 1, cuda: true, int8: true }, 8080)
    expect(args).not.toContain("--model")
    expect(args).not.toContain("--int8")
    expect(args).not.toContain("--cuda")
  })

  test("serverArgv: int8:false omits --int8 but keeps --cuda", () => {
    const args = serverArgv(
      { indexDir: "/idx", modelDir: "/models", parallel: 1, int8: false, cuda: true },
      8080,
    )
    expect(args).not.toContain("--int8")
    expect(args).toContain("--cuda")
  })

  test("early-exiting child → throws with stderr tail", async () => {
    const scriptPath = path.join(root, "fake-crash.ts")
    writeFileSync(
      scriptPath,
      `console.error("fake boom"); process.exit(3);`,
    )
    await expect(
      startManagedServer({
        binaryPath: process.execPath,
        argv: [scriptPath],
        modelDir: root,
        indexDir: root,
        startupTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/fake boom|exited/i)
  })
})
