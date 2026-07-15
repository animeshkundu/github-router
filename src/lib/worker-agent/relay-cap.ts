/**
 * Relay-safe result capping for the worker MCP boundary.
 *
 * Claude Code hard-caps an MCP tool result at `MAX_MCP_OUTPUT_TOKENS`
 * (default 25,000 tokens ≈ 100KB); a result over that is rejected /
 * truncated before the lead ever sees it. A worker that emits a large
 * `finalText` (an explore/review/plan summary, model prose, or a diff a
 * model pasted inline) would silently lose its output at that boundary.
 *
 * `relaySafeText` is the LAST transform applied to a worker's assembled
 * result text at each MCP boundary (`runWorkerToolCall`,
 * `runBrowseToolCall`) — AFTER any `clampNote` prefix and the browse
 * `[browse session: id]` suffix are appended, so nothing can push a
 * just-capped string back over the limit. When the text exceeds the cap
 * it is written IN FULL to a durable router-owned file and the caller
 * gets a bounded head preview + the file path, so the output is
 * recoverable rather than destroyed.
 *
 * Byte cap as a proxy for the TOKEN limit: worst-case dense output
 * (base64 / hex / minified) approaches ~1 byte/token, so the clamp
 * ceiling (20480 B ≈ 20k tokens) stays safely under the 25k-token cap
 * with headroom. The env override can never widen it past that ceiling,
 * so a misconfiguration cannot reintroduce the overflow.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { PATHS } from "../paths"

/** Default relay-safe byte budget for a worker result. */
const DEFAULT_MAX_RESULT_BYTES = 16 * 1024
/** Lower clamp — below this a preview is barely useful. */
const MIN_MAX_RESULT_BYTES = 8 * 1024
/**
 * Upper clamp. 20480 B ≈ 20k tokens even at the ~1 byte/token dense
 * worst case, comfortably under Claude Code's 25k-token result cap. The
 * env override is clamped to this, so it can never reintroduce the
 * overflow the cap exists to prevent.
 */
const MAX_MAX_RESULT_BYTES = 20 * 1024

/**
 * Age at which a spilled `.patch`/`.txt` is swept. Matches the worktree
 * dir age sweep in `worktree.ts`.
 */
const AGE_SWEEP_MS = 7 * 24 * 60 * 60 * 1000

/** Min interval between throttled hot-path sweeps (see `sweepAgedWorkerDiffs`). */
const SWEEP_THROTTLE_MS = 60 * 1000
let lastThrottledSweepAt = 0

/**
 * Strict name pattern for router-written overflow files:
 * `<pid>-<8hex>.(patch|txt)`. Shared by the sweep so it NEVER removes a
 * file it didn't write (a user could drop something else under the dir).
 */
export const WORKER_DIFF_NAME_RE = /^\d+-[0-9a-f]{8}\.(?:patch|txt)$/

/** Resolve the relay-safe byte cap from env, clamped to the safe range. */
export function resolveMaxResultBytes(): number {
  const raw = process.env.GH_ROUTER_WORKER_MAX_RESULT_BYTES
  if (raw === undefined) return DEFAULT_MAX_RESULT_BYTES
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_MAX_RESULT_BYTES
  }
  return Math.min(MAX_MAX_RESULT_BYTES, Math.max(MIN_MAX_RESULT_BYTES, n))
}

/**
 * Return the longest prefix of `text` whose UTF-8 encoding is at most
 * `maxBytes` long, cut on a codepoint boundary (never mid-multibyte).
 */
export function utf8HeadPreview(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  // Back off while the byte at `end` (the first EXCLUDED byte) is a UTF-8
  // continuation byte (0b10xxxxxx) — that means position `end` sits inside
  // a multibyte sequence, so [0, end) would hold a partial char.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/**
 * Best-effort age sweep of router-written overflow files under
 * `WORKER_DIFFS_DIR`. Only removes entries whose NAME matches
 * `WORKER_DIFF_NAME_RE` and whose mtime is older than 7 days — a fresh
 * file a concurrent worker just wrote (new mtime) is never touched, and
 * a locked file just skips. Errors are swallowed so a sweep never blocks
 * the write it precedes.
 *
 * `opts.throttle` (used by the write hot path) skips the readdir/stat scan
 * when a throttled sweep ran within the last minute, so concurrent overflow
 * writes don't each re-scan the directory. Direct callers (and tests) sweep
 * unconditionally.
 */
export async function sweepAgedWorkerDiffs(opts: { throttle?: boolean } = {}): Promise<void> {
  if (opts.throttle) {
    const now = Date.now()
    if (now - lastThrottledSweepAt < SWEEP_THROTTLE_MS) return
    lastThrottledSweepAt = now
  }
  let entries: Array<string>
  try {
    entries = await fs.readdir(PATHS.WORKER_DIFFS_DIR)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!WORKER_DIFF_NAME_RE.test(name)) continue
    const full = path.join(PATHS.WORKER_DIFFS_DIR, name)
    try {
      const stat = await fs.stat(full)
      if (now - stat.mtimeMs < AGE_SWEEP_MS) continue
      await fs.rm(full, { force: true }).catch(() => {})
    } catch {
      // ignore — best-effort
    }
  }
}

/**
 * Write `text` in full to a durable `.txt` under `WORKER_DIFFS_DIR` and
 * return its absolute path. Unique `<pid>-<8hex>.txt` name, `0o600`,
 * exclusive-create (`wx`) so it never clobbers a pre-existing file /
 * symlink. Retries on the (astronomically rare) name collision with a
 * fresh suffix. Sweeps aged files first (throttled, best-effort).
 */
async function saveOverflowResult(text: string): Promise<string> {
  await sweepAgedWorkerDiffs({ throttle: true })
  await fs.mkdir(PATHS.WORKER_DIFFS_DIR, { recursive: true })
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `${process.pid}-${randomBytes(4).toString("hex")}.txt`
    const outPath = path.join(PATHS.WORKER_DIFFS_DIR, name)
    try {
      await fs.writeFile(outPath, text, { mode: 0o600, flag: "wx" })
      return outPath
    } catch (err) {
      // Only a name collision is retryable; anything else (EACCES, ENOSPC)
      // is surfaced immediately.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("saveOverflowResult: exhausted unique-name retries")
}

/**
 * Cap a worker result to a relay-safe size. `reservedBytes` is the UTF-8
 * byte length of any must-survive envelope the caller will add OUTSIDE this
 * result (a `clampNote`/`worktreeNote` prefix, or the browse
 * `[browse session: id]` suffix), so the caller's final `envelope + result`
 * (or `result + envelope`) is guaranteed `<=` the configured cap.
 *
 * If the text fits under the effective cap it is returned unchanged.
 * Otherwise the FULL text is spilled to a durable file and a bounded
 * UTF-8-safe head preview + the file path is returned. On write failure the
 * preview is still returned with an explicit failure note — NEVER the
 * oversized original (that would re-trigger the overflow this guard prevents).
 */
export async function relaySafeText(text: string, reservedBytes = 0): Promise<string> {
  const cap = Math.max(0, resolveMaxResultBytes() - Math.max(0, reservedBytes))
  if (Buffer.byteLength(text, "utf8") <= cap) return text

  let savedPath: string | null = null
  let saveError: string | null = null
  try {
    savedPath = await saveOverflowResult(text)
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err)
  }

  // Reserve room for the trailer so the FINAL string is <= cap.
  const trailer =
    savedPath !== null
      ? `\n\n[result truncated to fit the relay; full result saved to: ${savedPath}]`
      : `\n\n[result truncated to fit the relay; saving the full result failed: ${saveError ?? "unknown"}]`
  const previewBudget = Math.max(0, cap - Buffer.byteLength(trailer, "utf8"))
  const out = utf8HeadPreview(text, previewBudget) + trailer
  // Belt-and-suspenders: if a pathologically long path/error made the trailer
  // alone exceed the cap, hard-clamp so the `<= cap` contract always holds.
  return Buffer.byteLength(out, "utf8") <= cap ? out : utf8HeadPreview(out, cap)
}
