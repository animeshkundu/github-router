/**
 * Structured stderr audit log for worker tool calls.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Safety +
 * observability" section, "Audit log" bullet) plus the peer-review
 * HIGH (2-lab confirmed) "args-prefix arg-leak" finding the format
 * here is designed to dodge.
 *
 * One line per tool call, metadata-only. NEVER raw `args.cmd`,
 * `args.contents`, `args.new_string`, `args.old_string`, query text,
 * etc. — anything that could carry secrets the model picked up from
 * an earlier tool result.
 *
 * Format (one stderr line per call via `consola.info`):
 *   [worker-agent] mode=<mode> tool=<tool> path=<args.path|""> bytes_in=<N> worktree=<bool>
 *
 * For `bash` the path field is replaced by:
 *   cmd_hash=<sha256-12> cmd_len=<N>
 * — never the raw command. The hash lets a reviewer correlate retries
 * of the same command without ever seeing it (peer-review HIGH).
 *
 * For `write` / `edit` `bytes_in` is the size of the user-supplied
 * content (`args.contents` for write, `args.new_string` for edit). For
 * other tools `bytes_in` defaults to 0.
 *
 * The audit line is observational only — failures in this function
 * MUST NOT block the tool call; `logAudit` catches its own errors.
 */

import { createHash } from "node:crypto"

import consola from "consola"

export interface AuditCtx {
  mode: "explore" | "review" | "plan" | "implement" | "test" | "browse"
  tool: string
  /** Raw tool args object. Walked for known field names; never logged. */
  args: unknown
  /** Worker workspace dir; logged as `worktree=true` if it differs from cwd. */
  workspace: string
}

/**
 * Compute SHA-256 of `s` and return the first 12 hex chars. Same
 * truncation length as `code-search.ts`'s rg-call dedupe and `cc-
 * backup`'s session-id hashing — narrow enough to fit in one log
 * column, wide enough to dedupe across realistic command sets.
 */
function sha12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

/**
 * Extract a string field from `args` if it exists and is a string.
 * Returns `""` (empty string, not undefined) so the log line column
 * width stays predictable. We treat non-string and missing values
 * identically — both render as empty.
 */
function strField(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return ""
  const v = (args as Record<string, unknown>)[key]
  return typeof v === "string" ? v : ""
}

/**
 * Best-effort byte-length of a known content-field on `args`. The
 * input MUST be a string (typeof check); JSON-stringified objects are
 * NOT counted (avoids accidentally serializing nested args that might
 * contain secrets).
 */
function byteLen(args: unknown, key: string): number {
  if (!args || typeof args !== "object") return 0
  const v = (args as Record<string, unknown>)[key]
  return typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0
}

/**
 * Emit a single audit line on stderr via `consola.info`. Never throws
 * — wrapped in try/catch so a logger misconfig never blocks the
 * worker.
 *
 * The line format is deliberately simple key=value (no JSON) so it's
 * cheap to grep and the agent harness can read it without a
 * dependency on a structured-log consumer. If we ever want JSONL
 * we'll write a separate sidecar under `appDir()/worker-audit/`
 * (deferred per plan).
 */
export function logAudit(ctx: AuditCtx): void {
  try {
    const fields: Array<string> = []
    fields.push(`mode=${ctx.mode}`)
    fields.push(`tool=${ctx.tool}`)

    if (ctx.tool === "bash") {
      const cmd = strField(ctx.args, "cmd")
      // Hash the cmd even if empty so columns line up; an empty cmd
      // hashes to a stable digest. cmd_len is the raw byte count for
      // sanity ("did something get truncated?").
      fields.push(`cmd_hash=${sha12(cmd)}`)
      fields.push(`cmd_len=${Buffer.byteLength(cmd, "utf8")}`)
    } else {
      const p = strField(ctx.args, "path")
      // Only log the path if it's a string — never serialize args.
      fields.push(`path=${p}`)
    }

    // bytes_in: pick the right field for the tool. For `write` it's
    // `contents`; for `edit` it's `new_string`; everything else is 0.
    let bytesIn = 0
    if (ctx.tool === "write") bytesIn = byteLen(ctx.args, "contents")
    else if (ctx.tool === "edit") bytesIn = byteLen(ctx.args, "new_string")
    fields.push(`bytes_in=${bytesIn}`)

    // worktree flag: set true iff the workspace path lives under a
    // `worker-worktrees` directory. (engine.ts assembles such paths
    // when `worktree: true` is requested.) We check the substring
    // rather than threading another arg through — keeps the call site
    // lean and the worktree-detection logic in one place.
    const isWorktree =
      typeof ctx.workspace === "string" &&
      /[\\/]worker-worktrees[\\/]/.test(ctx.workspace)
    fields.push(`worktree=${isWorktree ? "true" : "false"}`)

    consola.info(`[worker-agent] ${fields.join(" ")}`)
  } catch {
    // Audit is observational — never let it block the tool call.
  }
}
