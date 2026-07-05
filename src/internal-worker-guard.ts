/**
 * The internal `internal-worker-guard` subcommand: the executable a spawned
 * Claude Code session's `PreToolUse` hook invokes for the workers tools
 * (registered into the mirrored settings.json by the launcher, with a matcher
 * scoped to `^mcp__<workersKey>__(explore|…)$`).
 *
 * It enforces the "workers are non-blocking" invariant: the MAIN agent (and any
 * non-dispatcher subagent) is DENIED a raw `mcp__<workersKey>__<mode>` call and
 * redirected to the matching background `worker-<mode>` dispatcher subagent; the
 * dispatcher's own call (identified by `agent_type` in the payload) is ALLOWED.
 * All the logic lives in the pure `decideWorkerGuard` (worker-dispatch.ts); this
 * entry is just stdin → decide → stdout.
 *
 * Output contract (Claude Code PreToolUse):
 *   - ALLOW → print nothing, exit 0 (normal permission flow proceeds).
 *   - DENY  → print the `{hookSpecificOutput:{permissionDecision:"deny",…}}`
 *             JSON to stdout, exit 0 (the JSON, not the exit code, blocks it).
 * Fail CLOSED: an unparseable payload for a matched worker tool is denied.
 */

import { defineCommand } from "citty"

import { readFileSync } from "node:fs"

import { decideWorkerGuard, parseModesCsv } from "./lib/worker-dispatch"

/**
 * Read the hook payload from stdin SYNCHRONOUSLY (`readFileSync(0)`) — same
 * rationale as `internal-prompt-submit`: an async stdin read leaves an in-flight
 * libuv FS request that races Windows process teardown. Hooks always receive
 * piped stdin (guarded against an interactive TTY; any error → "").
 */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export const internalWorkerGuard = defineCommand({
  meta: {
    name: "internal-worker-guard",
    description:
      "Internal: the workers PreToolUse guard. Denies a raw mcp__<workers>__<mode> "
      + "call from the main agent (redirecting to the worker-<mode> background subagent) "
      + "and allows it from the dispatcher subagent. Fails closed.",
  },
  args: {
    "workers-key": {
      type: "string",
      description: "Resolved workers MCP config key (bare `workers` or `gh-router-workers`).",
      required: true,
    },
    modes: {
      type: "string",
      description: "CSV of active worker modes, e.g. `explore,implement,review,plan,test`.",
      required: false,
    },
  },
  run(ctx) {
    try {
      const stdin = readStdin()
      const workersKey = String(ctx.args["workers-key"] ?? "").trim()
      // Defensive: with no resolved key we cannot recognize any worker tool, so
      // there is nothing to guard — allow (print nothing). This never happens in
      // practice (the launcher only registers the hook with a real key).
      if (workersKey.length > 0) {
        const modes = parseModesCsv(
          typeof ctx.args.modes === "string" ? ctx.args.modes : undefined,
        )
        const { output } = decideWorkerGuard({ stdin, workersKey, modes })
        if (output) process.stdout.write(output)
      }
    } catch {
      /* never throw out of a hook — a crash would surface as an opaque tool error */
    }
    // Natural exit (code 0): the permissionDecision in the JSON (not the exit
    // code) blocks a denied call. A hard process.exit() races libuv stdio
    // teardown on Windows.
    process.exitCode = 0
  },
})
