/**
 * The internal `internal-session-bind` subcommand: the executable a spawned Claude
 * Code session's SessionStart / SessionEnd hooks invoke (registered into the
 * mirrored settings.json by the launcher when `AIORDIE_CLAUDE_BIND` is set —
 * i.e. when github-router runs inside an ai-or-die Terminal tab).
 *
 * It reads Claude Code's hook payload from stdin and ATOMICALLY writes a tiny
 * "sidecar" JSON file (path passed via `--out`) describing the CURRENTLY active
 * claude session: its sessionId and the absolute transcript path. ai-or-die owns
 * the sidecar path and watches it, so it can bind that browser tab's session
 * summariser to the exact transcript — surviving in-session `/resume`, `/clear`,
 * `/compact`, and exit→relaunch, without guessing from the filesystem.
 *
 * Side-effect only: writes the file and exits 0. It NEVER writes to stdout (a
 * SessionStart hook's stdout is injected into the model's context) and NEVER
 * blocks (any error is swallowed → exit 0).
 *
 * Top-level filter: a SessionStart fired by a subagent/teammate carries
 * `agent_id`/`agent_type`; those are skipped so only the tab's top-level session
 * drives the binding (mirrors the Stop / UserPromptSubmit hooks).
 */

import { defineCommand } from "citty"

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { isSubagentContext } from "./lib/orchestration/stop-gate-policy"

/**
 * Read the hook payload from stdin SYNCHRONOUSLY (`readFileSync(0)`). An async
 * stdin read leaves an in-flight libuv FS request that, on Windows, races process
 * teardown and trips a `uv_async_send` assertion; a synchronous read has no such
 * handle. Hooks always receive piped stdin (guarded against a TTY; any error -> "").
 */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

/**
 * Resolve a transcript path to its real location. The path claude reports sits
 * under the per-launch CLAUDE_CONFIG_DIR mirror, whose `projects` entry is a
 * junction/symlink back to the real `~/.claude/projects`. ai-or-die reads the
 * real dir, and the per-launch mirror is swept on github-router shutdown, so we
 * persist the REAL path. The file (and even intermediate dirs) may not exist yet
 * at SessionStart, so we realpath the DEEPEST EXISTING ancestor and rejoin the
 * not-yet-created trailing segments. Best-effort: if nothing resolves, keep raw.
 */
function realTranscriptPath(tp: string): string {
  if (!tp) return ""
  try {
    return realpathSync.native(tp)
  } catch {
    /* file doesn't exist yet — resolve the deepest existing ancestor below */
  }
  const missing: string[] = []
  let cur = tp
  for (let i = 0; i < 64; i++) {
    missing.unshift(path.basename(cur))
    const parent = path.dirname(cur)
    if (parent === cur) break // reached the root without an existing ancestor
    try {
      return path.join(realpathSync.native(parent), ...missing)
    } catch {
      cur = parent
    }
  }
  return tp
}

/**
 * Pure core: turn a raw Claude Code hook payload (stdin string) into the sidecar
 * record, or `null` when there's nothing to write. Returns null for: non-JSON
 * input, a subagent/teammate payload (agent_id/agent_type present — top-level
 * filter), or a missing session_id. Exported for unit tests.
 */
export function decodeSessionBind(stdin: string): Record<string, unknown> | null {
  let payload: {
    hook_event_name?: unknown
    session_id?: unknown
    transcript_path?: unknown
    cwd?: unknown
    source?: unknown
    reason?: unknown
    agent_id?: unknown
    agent_type?: unknown
  } = {}
  try {
    const p: unknown = JSON.parse(stdin)
    if (p && typeof p === "object") payload = p as typeof payload
    else return null
  } catch {
    return null // non-JSON stdin → tolerate, write nothing
  }

  // Top-level only: a subagent/teammate session must not steal the tab's
  // binding. Reuse the canonical fail-closed predicate (any present agent
  // marker ⇒ not the top-level session); main-session payloads omit the keys.
  if (isSubagentContext(payload)) return null

  const claudeSessionId = typeof payload.session_id === "string" ? payload.session_id : ""
  if (!claudeSessionId) return null // nothing to bind to

  const event =
    (typeof payload.hook_event_name === "string" ? payload.hook_event_name : "") === "SessionEnd"
      ? "end"
      : "start"
  const record: Record<string, unknown> = {
    schema: 1,
    claudeSessionId,
    transcriptPath: realTranscriptPath(
      typeof payload.transcript_path === "string" ? payload.transcript_path : "",
    ),
    cwd: typeof payload.cwd === "string" ? payload.cwd : "",
    event,
    at: Date.now(),
  }
  if (event === "start" && typeof payload.source === "string") record.source = payload.source
  if (event === "end" && typeof payload.reason === "string") record.reason = payload.reason
  return record
}

/** Atomically write the sidecar (temp + rename) so the reader never sees a partial file. */
function writeSidecar(out: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(out), { recursive: true })
  } catch {
    /* best-effort — ai-or-die owns and creates the dir */
  }
  const tmp = `${out}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  renameSync(tmp, out)
}

export const internalSessionBind = defineCommand({
  meta: {
    name: "internal-session-bind",
    description:
      "Internal: the SessionStart/SessionEnd hook. Reads the Claude Code hook payload on stdin "
      + "and atomically writes the active session id + transcript path to the --out sidecar file "
      + "(consumed by ai-or-die to bind a tab's sticky-note summariser). Side-effect only.",
  },
  args: {
    out: {
      type: "string",
      description: "Absolute path to the sidecar file to (atomically) write.",
      required: false,
    },
  },
  run({ args }) {
    // Never throw out of a hook: wrap the whole body and fall through to exit 0.
    try {
      const out = typeof args.out === "string" ? args.out.trim() : ""
      if (!out) return // no sidecar target → nothing to do
      const record = decodeSessionBind(readStdin())
      if (record) writeSidecar(out, record)
    } catch {
      /* a hook must never disrupt the session */
    }
    // Side-effect only: nothing on stdout (it would inject into the model's
    // context). Natural exit 0.
    process.exitCode = 0
  },
})
