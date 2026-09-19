/**
 * Service-backed semantic search orchestration (Phase 2e query path).
 *
 * Selects between the legacy colgrep CLI backend and the persistent
 * next-plaid-api server via `GH_ROUTER_SEMANTIC_BACKEND` (`colgrep` default,
 * `service` opt-in). The service path owns its own per-workspace state
 * (`svc-<hash>.json` sidecars — never touches the colgrep sidecar, so
 * flipping the flag back and forth loses nothing) and degrades to the
 * colgrep path on ANY service failure (missing binary, unhealthy server,
 * unknown index, busy queue).
 *
 * Indexing model: on-demand background populate. First query for a
 * workspace kicks `populateWorkspace` (enumerate → extractUnits →
 * batched updateDocuments) and returns `unavailable` meanwhile — the same
 * transparent-fallback contract as the CLI backend. Watcher-driven
 * proactive refresh lands separately (Phase 2d wiring).
 *
 * Binary resolution (no provisioner yet — CI artifacts pending):
 *   1. `GH_ROUTER_NEXTPLAID_BIN` explicit path
 *   2. Router-owned `<APP_DIR>/colbert/bin/next-plaid-api[.exe]`
 *   3. `next-plaid-api` on PATH
 * Model + ORT reuse the colbert provision (LateOn-Code-edge INT8 dir);
 * absent model ⇒ backend unavailable ⇒ colgrep fallback.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { resolveExecutable, runManagedExeCapture } from "../exec"
import { PATHS } from "../paths"
import { resolveRipgrep } from "../code-search"

import { canonicalWorkspace, gitDeltaFiles, gitState, serveStaleMaxFiles } from "./index-store"
import {
  canonicalColbertModelDir,
  colbertOrtDylibPath,
  nextPlaidServerBinaryPath,
  provisionNextPlaidServer,
} from "./provision"
import { nextPlaidServerPromoted, type NextPlaidServerVariant } from "./manifest"
import {
  indexNameForWorkspace,
  serverParallelSessions,
  ServiceBusyError,
  startManagedServer,
  type ManagedServer,
} from "./service"
import { buildUnitText, extractUnits } from "./units"
import { getLanguageKeyForPath } from "../tree-sitter-grammars"

export type SemanticBackend = "colgrep" | "service"

/** Backend selection. Default `colgrep`; opt in with `=service`. */
export function semanticBackend(): SemanticBackend {
  return process.env.GH_ROUTER_SEMANTIC_BACKEND === "service" ? "service" : "colgrep"
}

/** True when the service backend is selected AND actionable. */
export function serviceBackendEnabled(): boolean {
  if (semanticBackend() !== "service") return false
  // A binary on disk OR a promoted download (provisioned lazily in
  // ensureServer) makes the backend actionable; otherwise colgrep owns it.
  if (resolveServiceBinary() === null && !nextPlaidServerPromoted("cpu") && !nextPlaidServerPromoted("cuda")) {
    return false
  }
  if (!existsSync(canonicalColbertModelDir())) return false
  return true
}

/** Locate the server binary (env → router-owned → PATH). */
export function resolveServiceBinary(): string | null {
  const explicit = process.env.GH_ROUTER_NEXTPLAID_BIN
  if (explicit && explicit.length > 0 && existsSync(explicit)) return explicit
  for (const variant of ["cpu", "cuda"] as const) {
    const owned = nextPlaidServerBinaryPath(variant)
    if (existsSync(owned)) return owned
  }
  return resolveExecutable("next-plaid-api")
}

/**
 * True when an NVIDIA GPU is visible (`nvidia-smi -L` exits 0). Never
 * throws; absent tool/driver ⇒ false ⇒ cpu variant. Bounded (~8s) so a
 * wedged driver can't stall startup.
 */
export async function hasCudaGpu(): Promise<boolean> {
  try {
    const smi = resolveExecutable("nvidia-smi")
    if (!smi) return false
    const res = await runManagedExeCapture(smi, ["-L"], {
      timeoutMs: 8_000,
      maxStdoutBytes: 64 * 1024,
    })
    return res.code === 0 && !res.timedOut
  } catch {
    return false
  }
}

/**
 * Pick the server compute variant. Explicit `GH_ROUTER_NEXTPLAID_VARIANT`
 * (`cpu`|`cuda`) wins (operator/test seam); otherwise cuda iff a GPU is
 * visible. Callers still fall back across variants when the preferred
 * binary can't be provisioned — selection is a preference, not a gate.
 */
export async function selectServerVariant(): Promise<NextPlaidServerVariant> {
  const override = process.env.GH_ROUTER_NEXTPLAID_VARIANT
  if (override === "cpu" || override === "cuda") return override
  return (await hasCudaGpu()) ? "cuda" : "cpu"
}

interface ResolvedServer {
  binary: string
  /** Pass `--cuda` to this binary. */
  cuda: boolean
}

/**
 * Resolve the server binary + flags, provisioning on demand. Order:
 * explicit env (as-is; `--cuda` only via GH_ROUTER_NEXTPLAID_CUDA=1) →
 * preferred variant (provision, else on-disk) → cpu fallback (provision,
 * else on-disk) → PATH (cpu only). Null when nothing is usable.
 */
export async function resolveServerBinaryWithVariant(
  variant: NextPlaidServerVariant,
): Promise<ResolvedServer | null> {
  const explicit = process.env.GH_ROUTER_NEXTPLAID_BIN
  if (explicit && explicit.length > 0 && existsSync(explicit)) {
    return { binary: explicit, cuda: process.env.GH_ROUTER_NEXTPLAID_CUDA === "1" }
  }
  const ordered: Array<NextPlaidServerVariant> =
    variant === "cuda" ? ["cuda", "cpu"] : ["cpu"]
  for (const v of ordered) {
    const provisioned = await provisionNextPlaidServer(v)
    if (provisioned.path) return { binary: provisioned.path, cuda: v === "cuda" }
    const owned = nextPlaidServerBinaryPath(v)
    if (existsSync(owned)) return { binary: owned, cuda: v === "cuda" }
  }
  const onPath = resolveExecutable("next-plaid-api")
  if (onPath) return { binary: onPath, cuda: false }
  return null
}

// ---------------------------------------------------------------------
// Server singleton (one per process)
// ---------------------------------------------------------------------

let _server: ManagedServer | null = null
let _starting: Promise<ManagedServer> | null = null

/** Test-only: reset the singleton. */
export function __resetServiceSingletonForTests(): void {
  _server = null
  _starting = null
}

/** Start (once) and health-check the server; null when unavailable. */
export async function ensureServer(): Promise<ManagedServer | null> {
  if (_server) {
    try {
      const h = await _server.client.health()
      if (h.ok) return _server
    } catch {
      // fall through to restart
    }
    try {
      await _server.stop()
    } catch {
      // best effort
    }
    _server = null
  }
  if (_starting) return _starting.catch(() => null)
  const resolved = await resolveServerBinaryWithVariant(await selectServerVariant())
  if (!resolved) return null
  _starting = (async () => {
    const ortDir = path.dirname(colbertOrtDylibPath())
    const svc = await startManagedServer({
      binaryPath: resolved.binary,
      modelDir: canonicalColbertModelDir(),
      indexDir: PATHS.COLBERT_INDICES_DIR,
      parallel: serverParallelSessions(),
      cuda: resolved.cuda,
      env: {
        ORT_DYLIB_PATH: colbertOrtDylibPath(),
        PATH: `${ortDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      startupTimeoutMs: 120_000,
    })
    _server = svc
    return svc
  })()
  try {
    return await _starting
  } catch (err) {
    consola.debug(`service-backend: server start failed: ${(err as Error).message}`)
    return null
  } finally {
    _starting = null
  }
}

// ---------------------------------------------------------------------
// Per-workspace service state (separate from the colgrep sidecar)
// ---------------------------------------------------------------------

export interface ServiceIndexMeta {
  workspace: string
  index: string
  head?: string
  dirty?: boolean
  indexedAt?: string
  docCount?: number
}

function serviceMetaPath(workspace: string): string {
  return path.join(PATHS.COLBERT_META_DIR, `svc-${metaHash(workspace)}.json`)
}

function metaHash(workspace: string): string {
  const canonical = canonicalWorkspace(workspace)
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export async function readServiceMeta(workspace: string): Promise<ServiceIndexMeta | null> {
  try {
    const raw = await fs.readFile(serviceMetaPath(workspace), "utf8")
    const parsed = JSON.parse(raw) as ServiceIndexMeta
    if (parsed && typeof parsed === "object") return parsed
    return null
  } catch {
    return null
  }
}

async function writeServiceMeta(meta: ServiceIndexMeta): Promise<void> {
  await fs.mkdir(PATHS.COLBERT_META_DIR, { recursive: true })
  const dest = serviceMetaPath(meta.workspace)
  const tmp = `${dest}.${process.pid}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2))
    await fs.rename(tmp, dest)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------
// Background populate
// ---------------------------------------------------------------------

const _populateInFlight = new Set<string>()

/** Test-only: clear populate single-flight. */
export function __resetServicePopulateForTests(): void {
  _populateInFlight.clear()
}

/** Fire-and-forget per-workspace populate (single-flight). Never throws. */
export function kickServiceIndex(workspace: string): void {
  const key = path.resolve(workspace)
  if (_populateInFlight.has(key)) return
  _populateInFlight.add(key)
  void populateWorkspace(workspace)
    .catch((err) => {
      consola.debug(`service-backend: populate failed for ${workspace}: ${(err as Error).message}`)
    })
    .finally(() => {
      _populateInFlight.delete(key)
    })
}

/** Max files enumerated per populate (whole-repo cap for v1). */
const POPULATE_MAX_FILES = 20_000
/** Units per updateDocuments batch (server batches internally too). */
const POPULATE_BATCH_UNITS = 100
/** Max concurrent file parses. */
const POPULATE_PARSE_CONCURRENCY = 4

async function enumerateSourceFiles(
  rgPath: string,
  workspace: string,
  signal: AbortSignal,
): Promise<Array<string>> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rgPath, ["--files", "--no-follow", "-0"], {
        cwd: workspace,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      resolve([])
      return
    }
    let buf = Buffer.alloc(0)
    const files: Array<string> = []
    let done = false
    const finish = (out: Array<string>): void => {
      if (done) return
      done = true
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      resolve(out)
    }
    signal.addEventListener("abort", () => finish(files), { once: true })
    child.on("error", () => finish(files))
    child.stdout?.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      let idx: number
      while ((idx = buf.indexOf(0)) >= 0 && files.length < POPULATE_MAX_FILES) {
        const rel = buf.subarray(0, idx).toString("utf8")
        buf = buf.subarray(idx + 1)
        if (rel.length > 0 && !path.isAbsolute(rel)) files.push(rel.replace(/\\/g, "/"))
      }
      if (files.length >= POPULATE_MAX_FILES) finish(files)
    })
    child.on("close", () => finish(files))
  })
}

function resolveRipgrepBin(): string {
  try {
    return resolveRipgrep().rgPath
  } catch {
    return "rg"
  }
}

async function populateWorkspace(workspace: string): Promise<void> {
  const svc = await ensureServer()
  if (!svc) return
  const canonical = canonicalWorkspace(workspace)
  const index = indexNameForWorkspace(canonical)
  await svc.client.ensureIndex(index, { nbits: 4 })
  const rgPath = resolveRipgrepBin()
  const ac = new AbortController()
  // Bounded whole operation: populate must not run forever on giant trees.
  const timeout = setTimeout(() => ac.abort(), 30 * 60 * 1000)
  timeout.unref?.()
  try {
    const files = await enumerateSourceFiles(rgPath, canonical, ac.signal)
    const parseable = files.filter((f) => getLanguageKeyForPath(f) !== null)
    let units: Array<{ text: string; metadata: Record<string, unknown> }> = []
    let unitTotal = 0
    const flush = async (): Promise<void> => {
      if (units.length === 0) return
      const batch = units
      units = []
      await svc.client.updateDocuments(
        index,
        batch.map((u) => u.text),
        batch.map((u) => u.metadata),
      )
      unitTotal += batch.length
    }
    // Bounded concurrent parses over the file list.
    let next = 0
    const workers = Array.from(
      { length: Math.min(POPULATE_PARSE_CONCURRENCY, parseable.length) },
      async () => {
        while (!ac.signal.aborted) {
          const i = next
          next += 1
          if (i >= parseable.length) break
          const rel = parseable[i]
          try {
            const r = await extractUnits(path.join(canonical, rel), rel, ac.signal)
            for (const u of r.units) {
              units.push({
                text: buildUnitText(u, rel),
                metadata: {
                  file: u.file,
                  line: u.line,
                  end_line: u.end_line,
                  name: u.name,
                  signature: u.signature,
                  kind: u.kind,
                  unit_id: u.unit_id,
                },
              })
              if (units.length >= POPULATE_BATCH_UNITS) await flush()
            }
          } catch {
            // per-file failure: skip, keep going
          }
        }
      },
    )
    await Promise.all(workers)
    await flush()
    const g = await gitState(canonical).catch(() => ({ isRepo: false as const }))
    await writeServiceMeta({
      workspace: canonical,
      index,
      ...(g.isRepo ? { head: g.head, dirty: g.dirty ?? false } : {}),
      indexedAt: new Date().toISOString(),
      docCount: unitTotal,
    })
    consola.debug(`service-backend: indexed ${unitTotal} units in ${canonical}`)
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------
// Search entry (unified-layer facing)
// ---------------------------------------------------------------------

export interface ServiceSearchResult {
  status: "ready" | "unavailable" | "failed"
  results?: Array<{
    file: string
    line: number
    snippet: string
    endLine?: number
    name?: string
    score?: number
  }>
  freshness?: "fresh" | "stale"
  stale_files?: number
  notice?: string
}

/**
 * Search via the service backend. Returns `unavailable` (caller falls back
 * to colgrep/lexical) when the server, model, or index isn't ready; `failed`
 * only on unexpected errors. Served rows carry freshness labels per the
 * serve-while-stale policy.
 */
export async function runServiceSearch(opts: {
  query: string
  workspace: string
  limit?: number
  signal?: AbortSignal
}): Promise<ServiceSearchResult> {
  const { query, workspace } = opts
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 15)))
  const canonical = canonicalWorkspace(workspace)

  // Meta first: no index → kick populate and report unavailable WITHOUT
  // spawning a server just to learn that (populate brings one up itself).
  const meta = await readServiceMeta(canonical)
  if (!meta) {
    kickServiceIndex(canonical)
    return { status: "unavailable" }
  }
  const svc = await ensureServer()
  if (!svc) return { status: "unavailable" }
  const index = indexNameForWorkspace(canonical)

  // Freshness vs git state (mirrors the colbert newly-dirty rule), computed
  // against THIS backend's sidecar — never the colgrep verdict, which
  // describes a different index.
  const g = await gitState(canonical).catch(() => ({ isRepo: false as const }))
  let freshness: "fresh" | "stale" = "fresh"
  let staleFiles = 0
  if (g.isRepo) {
    const headMoved = meta.head !== undefined && g.head !== meta.head
    const newlyDirty = g.dirty === true && meta.dirty !== true
    if (headMoved || newlyDirty) {
      freshness = "stale"
      kickServiceIndex(canonical)
      try {
        const delta = await gitDeltaFiles(
          canonical,
          headMoved ? meta.head : undefined,
          headMoved ? g.head : undefined,
        )
        if (delta.truncated || delta.files.length > serveStaleMaxFiles()) {
          return { status: "unavailable" }
        }
        staleFiles = delta.files.length
      } catch {
        return { status: "unavailable" }
      }
    }
  }

  try {
    const hits = await svc.client.search(index, query, {
      topK: limit,
      textQuery: query,
      alpha: 0.75,
    })
    return {
      status: "ready",
      results: hits.map((h) => ({
        file: h.file,
        line: h.line,
        snippet: buildSnippet(h),
        ...(h.end_line !== undefined ? { endLine: h.end_line } : {}),
        ...(h.name !== undefined ? { name: h.name } : {}),
        score: h.score,
      })),
      freshness,
      ...(freshness === "stale" ? { stale_files: staleFiles } : {}),
    }
  } catch (err) {
    if (err instanceof ServiceBusyError) return { status: "unavailable" }
    consola.debug(`service-backend: search failed: ${(err as Error).message}`)
    return { status: "failed" }
  }
}

function buildSnippet(h: {
  metadata?: Record<string, unknown>
  file: string
  line: number
}): string {
  const meta = h.metadata ?? {}
  const sig = typeof meta.signature === "string" ? meta.signature : ""
  return sig.length > 0 ? `${sig}\n${h.file}:${h.line}` : `${h.file}:${h.line}`
}
