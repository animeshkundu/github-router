/**
 * Tree-sitter parse worker (runs INSIDE a `worker_threads` thread).
 *
 * Each worker owns its OWN web-tree-sitter WASM heap: importing the grammar
 * module here triggers a fresh `Parser.init()` + grammar load in THIS thread's
 * V8 isolate, independent of the main thread's heap and every other worker's.
 * That independence is the whole point — N workers parse in true parallel
 * because they do not share the single module-global Emscripten `Module` the
 * main thread is otherwise stuck with.
 *
 * Protocol: see `protocol.ts`. The worker reads + parses each file itself and
 * returns ONLY plain data (confirmed-definition indexes + outline entries);
 * a `Tree` never crosses `postMessage`. The tree is `.delete()`-ed per job —
 * there is no cross-job tree cache here (the main thread's `_treeCache` owns
 * in-process reuse; the worker is a pure parse+walk+discard function).
 */

import { readFileSync, statSync } from "node:fs"
import { parentPort } from "node:worker_threads"

import Parser from "web-tree-sitter"

import {
  confirmDefinitionSites,
  getGrammarBundle,
  outlineFromTree,
  STRUCTURAL_MAX_FILE_BYTES,
} from "~/lib/tree-sitter-grammars"
import type {
  MainToWorker,
  ParseJobReply,
  ParseJobRequest,
  WorkerReady,
} from "~/lib/tree-sitter-pool/protocol"

if (!parentPort) {
  throw new Error("tree-sitter worker must be spawned via worker_threads")
}
const port = parentPort

// Per-worker grammar registry + reusable parsers (one per language). Parsers
// are reusable across parses; we keep them warm for the worker's lifetime.
let grammars: Map<string, Parser.Language> = new Map()
const parsers = new Map<string, Parser>()
let cancelled = false

function handleJob(job: ParseJobRequest): ParseJobReply {
  // Test-only crash injection: when GH_ROUTER_TS_WORKER_CRASH=1, throw an
  // UNCAUGHT error on the first job so the pool's worker-crash degradation path
  // (retire + respawn, file → miss, search survives) can be exercised
  // deterministically. Throwing here escapes the message handler → the
  // worker's 'error'/'exit' events fire on the main thread. Never set in
  // production.
  if (process.env.GH_ROUTER_TS_WORKER_CRASH === "1") {
    throw new Error("injected worker crash (test)")
  }
  // Honor a pending cancel: reply with an empty (valid) result rather than
  // doing work. The main thread treats an empty confirm set / absent outline
  // as a miss and degrades that file to the heuristic — same as a budget cut.
  if (cancelled) return { id: job.id, ok: true, mtimeMs: job.mtimeMs }

  const lang = grammars.get(job.language)
  if (!lang) return { id: job.id, ok: false, error: "grammar not loaded" }

  // Re-stat: if the file changed since the main thread observed it, bail as a
  // miss (the main thread re-checks mtime too; this is belt-and-suspenders so
  // we never confirm against a stale parse).
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(job.absPath)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch (err) {
    return { id: job.id, ok: false, error: `stat failed: ${(err as Error).message}` }
  }
  if (size > STRUCTURAL_MAX_FILE_BYTES) {
    return { id: job.id, ok: false, error: "file too large" }
  }

  let source: string
  try {
    source = readFileSync(job.absPath, "utf8")
  } catch (err) {
    return { id: job.id, ok: false, error: `read failed: ${(err as Error).message}` }
  }

  let parser = parsers.get(job.language)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(lang)
    parsers.set(job.language, parser)
  }

  let tree: Parser.Tree | null = null
  try {
    tree = parser.parse(source)
  } catch (err) {
    return { id: job.id, ok: false, error: `parse failed: ${(err as Error).message}` }
  }
  if (!tree) return { id: job.id, ok: false, error: "parse returned null" }

  try {
    const reply: ParseJobReply = { id: job.id, ok: true, mtimeMs }
    if (job.want.confirmHits && job.want.confirmHits.length > 0) {
      reply.confirmedHitIndexes = confirmDefinitionSites(
        tree,
        source,
        job.language,
        job.want.confirmHits,
      )
    }
    if (job.want.outline) {
      reply.outlineEntries = outlineFromTree(tree, job.language).outline
    }
    return reply
  } catch (err) {
    return { id: job.id, ok: false, error: `walk failed: ${(err as Error).message}` }
  } finally {
    try {
      tree.delete()
    } catch {
      // already collected
    }
  }
}

port.on("message", (msg: MainToWorker) => {
  if ("type" in msg) {
    // NOTE: `cancel` is BEST-EFFORT and in practice a no-op for a job already
    // running. `handleJob` is fully synchronous (sync read + sync WASM parse +
    // sync AST walk), so it never yields to this message handler mid-job — a
    // `cancel` posted while a parse is in flight sits unread until the parse
    // finishes and the reply is posted. Cancellation therefore only affects a
    // job that has NOT yet started (the worker is between jobs). That is
    // acceptable: per-file parses are sub-50ms, and the main thread's `stopped`
    // flag discards any post-deadline result regardless. We keep the flag so a
    // cancel that lands between jobs short-circuits the next one.
    if (msg.type === "cancel") cancelled = true
    return
  }
  // A new job clears the cancel flag — the main thread only sends jobs for a
  // fresh search, and cancel applies to the in-flight search only.
  cancelled = false
  const reply = handleJob(msg)
  port.postMessage(reply)
})

// Warm up: init + load grammars in THIS isolate, then signal ready. A failed
// init yields an empty `loaded` list; the pool retires a worker that loads no
// grammars rather than dispatching to a dead heap.
void (async () => {
  try {
    grammars = await getGrammarBundle().ready
  } catch {
    grammars = new Map()
  }
  const ready: WorkerReady = { type: "ready", loaded: [...grammars.keys()] }
  port.postMessage(ready)
})()
