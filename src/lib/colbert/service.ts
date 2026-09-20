/**
 * next-plaid-api service client + managed lifecycle (Phase 2e).
 *
 * The semantic backend moves from colgrep CLI-per-invocation (every query
 * re-loads ORT + model + index) to a persistent `next-plaid-api` server
 * (model warm, PLAID mmap'd, lock-free reads, batched async writes).
 * This module owns the HTTP protocol and the child-process lifecycle;
 * the query-path switch (runner → service) lands separately once a
 * provisioned binary exists (see the CI build workflow).
 *
 * API surface (next-plaid-api v1.7.0, verified from upstream README):
 *   GET  /health                                   → system + per-index summaries
 *   POST /indices {name, config}                   → declare index (409 taken)
 *   POST /indices/{name}/update_with_encoding      → 202 (async batch)
 *   DELETE /indices/{name}/documents {condition, parameters} → 202
 *   POST /indices/{name}/search_with_encoding      → ranked hits + metadata
 *
 * Conventions shared with the colbert sidecar: never log response bodies
 * (they embed source code), bound every request with a timeout, fail
 * closed (throw → caller falls back to lexical).
 */

import { spawn, type ChildProcess } from "node:child_process"
import * as net from "node:net"
import * as os from "node:os"
import process from "node:process"

import { trackChild, untrackChild } from "./lifecycle"

export interface ServiceSearchParams {
  top_k: number
  n_ivf_probe?: number
  n_full_scores?: number
}

export interface ServiceSearchHit {
  file: string
  line: number
  end_line?: number
  name?: string
  score: number
  metadata?: Record<string, unknown>
}

export interface ServiceHealth {
  ok: boolean
  indices: Array<{
    name: string
    num_documents: number
    num_embeddings: number
    dimension: number
  }>
  model?: string
  /**
   * Server-side batch queue (`running` → `complete`). Update batches show
   * up here; delete batches do NOT reliably (only the doc count reveals
   * a merged delete) — so deletes are gated on counts, updates on this
   * queue + count stability. Absent on servers that omit the field.
   */
  updates: Array<{
    index: string
    status: string
  }>
}

interface ApiSearchResponse {
  results?: Array<{
    query_id?: number
    document_ids?: Array<number>
    scores?: Array<number>
    metadata?: Array<Record<string, unknown>>
  }>
}

const DEFAULT_TIMEOUT_MS = 30_000

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error("service request timeout")), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text.length > 0 ? (JSON.parse(text) as unknown) : null
    } catch {
      body = null
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Thin HTTP client over a running next-plaid-api server. Construct with
 * the base URL (`http://127.0.0.1:PORT`); use `startManagedServer` below
 * for process lifecycle, or point at an externally managed server.
 */
export class NextPlaidClient {
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.timeoutMs = timeoutMs
  }

  async health(): Promise<ServiceHealth> {
    const { status, body } = await fetchJson(`${this.baseUrl}/health`, {}, this.timeoutMs)
    if (status !== 200 || typeof body !== "object" || body === null) {
      return { ok: false, indices: [], updates: [] }
    }
    const b = body as {
      status?: string
      indices?: Array<{
        name?: string
        num_documents?: number
        num_embeddings?: number
        dimension?: number
      }>
      model?: { name?: string }
      updates?: Array<{ index?: string; name?: string; status?: string }>
    }
    return {
      ok: b.status === "healthy",
      indices: (b.indices ?? []).map((i) => ({
        name: typeof i.name === "string" ? i.name : "",
        num_documents: typeof i.num_documents === "number" ? i.num_documents : 0,
        num_embeddings: typeof i.num_embeddings === "number" ? i.num_embeddings : 0,
        dimension: typeof i.dimension === "number" ? i.dimension : 0,
      })),
      model: b.model?.name,
      updates: (b.updates ?? []).map((u) => ({
        index: typeof u.index === "string" ? u.index : typeof u.name === "string" ? u.name : "",
        status: typeof u.status === "string" ? u.status : "",
      })),
    }
  }

  /** Declare an index (idempotent: 409 taken is success). */
  async ensureIndex(    name: string,
    config: { nbits?: number; pool_factor?: number; start_from_scratch?: number } = {},
  ): Promise<void> {
    const { status, body } = await fetchJson(
      `${this.baseUrl}/indices`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          config: {
            nbits: config.nbits ?? 4,
            ...(config.pool_factor !== undefined ? { pool_factor: config.pool_factor } : {}),
            ...(config.start_from_scratch !== undefined
              ? { start_from_scratch: config.start_from_scratch }
              : {}),
          },
        }),
      },
      this.timeoutMs,
    )
    if (status === 200 || status === 201 || status === 409) return
    throw new Error(
      `ensureIndex ${name} failed: HTTP ${status} (${describeError(body)})`,
    )
  }

  /**
   * Add/update documents (server encodes text). 202 = accepted into the
   * async batch queue (NOT yet searchable — the server merges within
   * ~100ms/300 docs). Never throws for queue-full: maps 503 to a typed
   * error the caller retries after backoff.
   */
  async updateDocuments(
    index: string,
    documents: Array<string>,
    metadata: Array<Record<string, unknown>>,
    poolFactor = 2,
  ): Promise<void> {
    const { status, body } = await fetchJson(
      `${this.baseUrl}/indices/${encodeURIComponent(index)}/update_with_encoding`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documents, metadata, pool_factor: poolFactor }),
      },
      this.timeoutMs,
    )
    if (status === 202) return
    if (status === 503) throw new ServiceBusyError(index)
    throw new Error(
      `update ${index} failed: HTTP ${status} (${describeError(body)})`,
    )
  }

  /**
   * Drop an entire index. Returns true when the index is guaranteed absent
   * afterwards (dropped, or never existed). Returns false when the server
   * does not support the operation (405/501) or reports an error — the
   * caller falls back to per-file deletes. Verified against v1.7.0:
   * `{"deleted":true}` with HTTP 200.
   */
  async dropIndex(name: string): Promise<boolean> {
    const { status } = await fetchJson(
      `${this.baseUrl}/indices/${encodeURIComponent(name)}`,
      { method: "DELETE" },
      this.timeoutMs,
    )
    if (status === 200 || status === 201 || status === 204 || status === 404) return true
    return false
  }

  /** Delete by SQL predicate (batched server-side, 202 accepted). */
  async deleteDocuments(
    index: string,
    condition: string,
    parameters: Array<unknown> = [],
  ): Promise<void> {
    const { status, body } = await fetchJson(
      `${this.baseUrl}/indices/${encodeURIComponent(index)}/documents`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ condition, parameters }),
      },
      this.timeoutMs,
    )
    if (status === 202) return
    if (status === 404) return // unknown index: nothing to delete
    if (status === 503) throw new ServiceBusyError(index)
    throw new Error(
      `delete ${index} failed: HTTP ${status} (${describeError(body)})`,
    )
  }

  /**
   * Hybrid search (semantic + FTS5 keyword, server-side RRF fusion).
   * `fileGlob` scopes via metadata filter when provided (the indexer
   * stores `file` per doc). Returns hits in ranked order.
   */
  async search(
    index: string,
    query: string,
    opts: {
      topK?: number
      textQuery?: string
      alpha?: number
      fileGlob?: string
      nIvfProbe?: number
    } = {},
  ): Promise<Array<ServiceSearchHit>> {
    const top_k = Math.max(1, Math.floor(opts.topK ?? 15))
    const body: Record<string, unknown> = {
      queries: [query],
      params: {
        top_k,
        ...(opts.nIvfProbe !== undefined ? { n_ivf_probe: opts.nIvfProbe } : {}),
      },
    }
    if (opts.textQuery) {
      body.text_query = [opts.textQuery]
      body.alpha = opts.alpha ?? 0.75
      body.fusion = "relative_score"
    }
    if (opts.fileGlob) {
      // Metadata-side scoping; the server filters before scoring.
      body.filter_condition = "file GLOB ?"
      body.filter_parameters = [opts.fileGlob]
    }
    const { status, body: res } = await fetchJson(
      `${this.baseUrl}/indices/${encodeURIComponent(index)}/search_with_encoding`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
    )
    if (status === 404) return [] // unknown index → no hits (not an error)
    if (status === 503) throw new ServiceBusyError(index)
    if (status !== 200) {
      throw new Error(`search ${index} failed: HTTP ${status} (${describeError(res)})`)
    }
    return toHits(res as ApiSearchResponse)
  }
}

/** Queue-full signal: retry after backoff, never fatal. */
export class ServiceBusyError extends Error {
  readonly index: string
  constructor(index: string) {
    super(`next-plaid index ${index} busy (queue full); retry after backoff`)
    this.name = "ServiceBusyError"
    this.index = index
  }
}

/**
 * Server-process death during a long populate/encode. Thrown (instead of a
 * bare `fetch failed / ECONNREFUSED`) when the managed `next-plaid-api`
 * child exits while the router still has work to send it. Carries the exit
 * code, signal, and the captured stderr tail so the `index` command can
 * print an actionable diagnostic instead of a generic connection error.
 *
 * Stderr is truncated server-side (never full source — the server only ever
 * logs paths, not code) and truncated again here to the last 2 KB.
 */
export class ServerCrashedError extends Error {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderrTail: string
  constructor(opts: { exitCode?: number | null; signal?: string | null; stderrTail?: string }) {
    super(
      `next-plaid server crashed during encode` +
        (opts.exitCode !== undefined && opts.exitCode !== null ? ` (exit code ${opts.exitCode})` : "") +
        (opts.signal ? ` (signal ${opts.signal})` : ""),
    )
    this.name = "ServerCrashedError"
    this.exitCode = opts.exitCode ?? null
    this.signal = opts.signal ?? null
    this.stderrTail = (opts.stderrTail ?? "").slice(-2048)
  }
}

function describeError(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const b = body as { code?: unknown; message?: unknown }
    const code = typeof b.code === "string" ? b.code : "?"
    const message = typeof b.message === "string" ? b.message : ""
    return `${code}${message ? `: ${message.slice(0, 200)}` : ""}`
  }
  return "unparseable response"
}

/**
 * Map the API search response to file-anchored hits. Metadata carries the
 * unit fields the indexer stored (file/line/end_line/name/signature);
 * rows missing a file are dropped (never surface an unanchored hit).
 */
function toHits(res: ApiSearchResponse): Array<ServiceSearchHit> {
  const out: Array<ServiceSearchHit> = []
  for (const r of res.results ?? []) {
    const ids = r.document_ids ?? []
    const scores = r.scores ?? []
    const metas = r.metadata ?? []
    for (let i = 0; i < ids.length; i++) {
      const meta = (metas[i] ?? {}) as Record<string, unknown>
      const file = meta.file
      if (typeof file !== "string" || file.length === 0) continue
      const line = meta.line
      out.push({
        file,
        line: typeof line === "number" ? line : 1,
        ...(typeof meta.end_line === "number" ? { end_line: meta.end_line as number } : {}),
        ...(typeof meta.name === "string" ? { name: meta.name as string } : {}),
        score: typeof scores[i] === "number" ? (scores[i] as number) : 0,
        metadata: meta,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------
// Managed lifecycle
// ---------------------------------------------------------------------

export interface ManagedServerOpts {
  /** Absolute path to the next-plaid-api binary (provisioned, SHA-pinned). */
  binaryPath: string
  /**
   * `--model` local dir (provisioned ColBERT INT8 dir). Omit for
   * embeddings-only mode (no `*_with_encoding` endpoints; callers pass
   * pre-computed vectors). Useful for testing the index machinery
   * without a model download.
   */
  modelDir?: string
  /** `--index-dir` (router-owned indices root). */
  indexDir: string
  /** `--int8` quantized inference (default true: matches colgrep edge config). */
  int8?: boolean
  /**
   * `--cuda` GPU inference (default false). Only set when the binary was
   * built with the `cuda` feature AND a GPU was detected at runtime —
   * otherwise the flag makes the server fail to start. Requires
   * `modelDir` (upstream CLI contract, same as `--int8`).
   */
  cuda?: boolean
  /** `--parallel` ONNX sessions (default 1: safe on 4-core boxes). */
  parallel?: number
  /** Extra env for the child (ORT_DYLIB_PATH etc.). */
  env?: NodeJS.ProcessEnv
  /** Port (default: probe a free loopback port). */
  port?: number
  /** Health-gated readiness budget (default 60s: first model load). */
  startupTimeoutMs?: number
  /**
   * Replace the built next-plaid-api argv (test seam: point `binaryPath`
   * at a fake server script). Production never sets this.
   */
  argv?: Array<string>
}

export interface ManagedServer {
  url: string
  client: NextPlaidClient
  /** Graceful shutdown (SIGTERM, wait, SIGKILL escalation). */
  stop: () => Promise<void>
  /**
   * Managed child process (optional for backward-compat with test fakes).
   * Callers use this to detect server death DURING a long populate — the
   * startup path already gates on health, but a 30-minute encode can
   * outlive the server (OOM / access violation / Windows commit limit).
   */
  process?: ChildProcess
  /** Last 4 KB of server stderr (paths only, never source). */
  stderrTail?: () => string
}

/** Find a free loopback port (TOCTOU-racy by nature; retry on collision). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

/**
 * Spawn the server, wait for `/health`, return a managed handle. Throws
 * when the binary is missing, the port never becomes healthy, or the
 * child exits early (stderr is captured, truncated, never logged raw —
 * it can embed paths, not source, but the discipline is cheap).
 */
/**
 * Build the next-plaid-api argv (exported for unit tests; production
 * goes through `startManagedServer`). `--int8`/`--cuda` both require
 * `--model` (upstream CLI contract) and are never passed alone.
 */
export function serverArgv(
  opts: Pick<ManagedServerOpts, "indexDir" | "modelDir" | "int8" | "cuda" | "parallel">,
  port: number,
): Array<string> {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--index-dir",
    opts.indexDir,
    ...(opts.modelDir ? ["--model", opts.modelDir] : []),
    ...(opts.modelDir && opts.int8 !== false ? ["--int8"] : []),
    ...(opts.modelDir && opts.cuda === true ? ["--cuda"] : []),
    "--parallel",
    String(Math.max(1, Math.floor(opts.parallel ?? 1))),
  ]
}

export async function startManagedServer(
  opts: ManagedServerOpts,
): Promise<ManagedServer> {
  const port = opts.port ?? (await freePort())
  const args = opts.argv ?? serverArgv(opts, port)

  let child: ChildProcess
  try {
    child = spawn(opts.binaryPath, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (err) {
    throw new Error(`next-plaid server failed to spawn: ${(err as Error).message}`, {
      cause: err,
    })
  }
  trackChild(child)
  void child.on("error", () => {
    untrackChild(child)
  })

  let stderrTail = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4096)
  })

  const url = `http://127.0.0.1:${port}`
  const client = new NextPlaidClient(url)
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 60_000)
  let exited: number | null = null
  // Failed spawns (ENOENT) emit error/close WITHOUT exit on Node AND Bun —
  // without tracking those, a dead-on-arrival child looks alive until the
  // full startup budget burns. `spawnFailed` trips fast failure instead.
  let spawnFailed = false
  child.on("exit", (code) => {
    exited = code
  })
  child.on("error", () => {
    spawnFailed = true
  })
  child.on("close", () => {
    if (exited === null) spawnFailed = true
  })

  try {
    for (;;) {
      if (exited !== null || spawnFailed) {
        throw new Error(
          `next-plaid server exited during startup${exited !== null ? ` (code ${exited})` : ""}: ${stderrTail.slice(-500)}`,
        )
      }
      try {
        const h = await client.health()
        // Any HTTP answer (even unhealthy) proves the socket is live;
        // model load completes asynchronously — readiness follows.
        void h
        if (h.ok) {
          return {
            url,
            client,
            stop: () => stopServer(child),
            process: child,
            stderrTail: () => stderrTail,
          }
        }
      } catch {
        // Not listening yet — keep polling.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `next-plaid server not healthy after startup budget: ${stderrTail.slice(-500)}`,
        )
      }
      await new Promise<void>((r) => {
        const t = setTimeout(() => r(), 250)
        t.unref?.()
      })
    }
  } catch (err) {
    await stopServer(child).catch(() => {})
    throw err
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return
    // Failed spawns (ENOENT) never get a pid AND never emit exit/close
    // handlers attached after the fact would wait on — return now instead
    // of hanging until the backstop.
    if (child.pid === undefined) return
    let finished = false
    let doneResolve: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve
    })
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(escalation)
      clearTimeout(backstop)
      doneResolve()
    }
    // Failed spawns (ENOENT) emit close WITHOUT exit on Node AND Bun —
    // waiting on exit alone hangs shutdown forever.
    child.once("exit", finish)
    child.once("close", finish)
    // Escalate: SIGTERM → SIGKILL after 5s.
    const escalation = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
    }, 5000)
    escalation.unref?.()
    // Hard backstop: shutdown must never hang, even pathologically.
    const backstop = setTimeout(finish, 15_000)
    backstop.unref?.()
    try {
      child.kill("SIGTERM")
    } catch {
      finish() // kill threw synchronously (e.g. ESRCH): already gone.
      return
    }
    if (process.platform === "win32") {
      // child.kill() is unreliable for trees on Windows; taskkill covers it.
      // Direct spawn (not the managed runner) to avoid importing the
      // heavyweight colbert runner here.
      try {
        const { spawnSync } = await import("node:child_process")
        if (child.pid) {
          spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
            stdio: "ignore",
            windowsHide: true,
          })
        }
      } catch {
        // best effort
      }
    }
    await done
  } finally {
    untrackChild(child)
  }
}

/** CPU-aware default parallelism for the managed server. */
export function serverParallelSessions(foreground = false): number {
  const raw = Number(process.env.GH_ROUTER_NP_PARALLEL)
  if (Number.isSafeInteger(raw) && raw > 0) return raw
  let cpus = 4
  try {
    cpus = os.cpus().length
  } catch {
    // keep default
  }
  // Foreground `index` is capped at 8 sessions (not all cores): each ONNX
  // session duplicates model state (~100-200 MB) plus batch-queue buffers,
  // so 16 sessions on a 16-core box can exceed 12 GB working set and trip
  // Windows commit-charge limits / RADAR_PRE_LEAK_64 on large repos. 8 is
  // still 2x the background share and 2x the colgrep default.
  if (foreground) return Math.max(1, Math.min(cpus, 8))
  // Encode sessions duplicate model state; 25% keeps a background server
  // from saturating an interactive box (mirrors colbertParallelSessions).
  return Math.max(1, Math.floor(cpus * 0.25))
}

/** Per-workspace index name: stable hash of the canonical workspace path. */
export function indexNameForWorkspace(canonicalWorkspace: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < canonicalWorkspace.length; i++) {
    h ^= canonicalWorkspace.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `ws-${(h >>> 0).toString(16).padStart(8, "0")}`
}
