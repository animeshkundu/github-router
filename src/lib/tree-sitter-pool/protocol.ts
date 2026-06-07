/**
 * Frozen wire protocol between the main thread and the tree-sitter parse
 * workers. ONLY plain, structured-clonable data crosses `postMessage` — never a
 * tree-sitter `Tree` (a native handle into one worker's WASM heap that cannot
 * cross the thread boundary). The worker reads + parses the file ITSELF and
 * returns confirmed-definition indices and/or outline entries; the file bytes
 * never travel over the wire (the source string is the larger payload).
 *
 * Both the structural-confirm walk and the outline walk for ONE file are
 * COALESCED into a single job so a file needed by both rounds is parsed exactly
 * once worker-side — the threaded equivalent of Lever 1's in-process tree reuse.
 */

import type { FileOutlineEntry, StructuralHit } from "~/lib/tree-sitter-grammars"

/** main → worker: parse `absPath` as `language` and extract `want`. */
export interface ParseJobRequest {
  /** Monotonic id; echoed back so the pool can match reply→job. */
  id: number
  /** Absolute path the worker reads. */
  absPath: string
  /** Grammar key (e.g. "typescript") — already resolved main-side. */
  language: string
  /** mtimeMs the main thread observed; echoed back so the pool can detect a
   *  between-dispatch edit and treat the result as stale (skip it). */
  mtimeMs: number
  want: {
    /** Hits to AST-confirm. Indexes in the reply's `confirmedHitIndexes` are
     *  positions INTO this array. Omit/empty → no confirm work. */
    confirmHits?: Array<StructuralHit>
    /** When true, also return the file's structural outline. */
    outline?: boolean
  }
}

/** worker → main: success carries only the extracted plain data. */
export interface ParseJobOk {
  id: number
  ok: true
  /** Echoed so the pool can re-check mtime against the live stat. */
  mtimeMs: number
  /** Subset of the request's `confirmHits` indexes that AST-confirmed as
   *  definition sites. Order-independent (the pool merges into a Set). */
  confirmedHitIndexes?: Array<number>
  /** Plain outline entries (only when `want.outline`). */
  outlineEntries?: Array<FileOutlineEntry>
}

/** worker → main: failure. The pool treats the file as a structural/outline
 *  MISS — the file keeps the regex heuristic / falls back to `outlineFile`. */
export interface ParseJobErr {
  id: number
  ok: false
  error: string
}

export type ParseJobReply = ParseJobOk | ParseJobErr

/** worker → main, once, after `Parser.init()` + grammar load completes. */
export interface WorkerReady {
  type: "ready"
  /** Grammar keys the worker successfully loaded. If empty, the worker is
   *  useless (init/grammar failure) and the pool retires it. */
  loaded: Array<string>
}

/** main → worker: cancel any in-flight work and stop consuming jobs. The
 *  worker checks the flag between hits/files and replies with whatever it has
 *  (an empty/partial result is still valid — same semantics as a budget
 *  truncation). */
export interface CancelMessage {
  type: "cancel"
}

export type MainToWorker = ParseJobRequest | CancelMessage
export type WorkerToMain = ParseJobReply | WorkerReady
