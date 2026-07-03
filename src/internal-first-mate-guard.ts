/**
 * The internal `internal-first-mate-guard` subcommand: a PreToolUse hook that
 * enforces cloud-agent OPERATOR capability shaping. It is injected into the
 * spawned Claude session's settings ONLY in `--agents`/operator mode, with a
 * matcher scoped to the denied tools, so it fires only for file-authoring +
 * local-worker tool calls and blocks them (the operator must delegate to GitHub
 * cloud agents, not hand-code).
 *
 * Reads the PreToolUse payload from stdin (`{tool_name, ...}`) and, if the tool
 * is denied in operator mode, blocks via exit code 2 with a reason on stderr
 * (the repo's hook convention). FAIL-OPEN: any parse/uncertainty exits 0
 * (allow), so a malformed payload never wedges the session.
 */
import { defineCommand } from "citty"

import { readFileSync } from "node:fs"

import { operatorPreToolUse } from "./lib/first-mate/operator-shaping"

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export const internalFirstMateGuard = defineCommand({
  meta: {
    name: "internal-first-mate-guard",
    description: "PreToolUse guard enforcing cloud-agent operator capability shaping.",
  },
  run() {
    let toolName = ""
    try {
      const payload = JSON.parse(readStdinSync()) as { tool_name?: unknown }
      if (typeof payload.tool_name === "string") toolName = payload.tool_name
    } catch {
      toolName = "" // fail-open
    }
    if (toolName.length === 0) process.exit(0)
    // This hook is only injected in operator mode, so operatorMode = true.
    const decision = operatorPreToolUse(toolName, true)
    if (decision.block) {
      process.stderr.write(decision.reason ?? `${toolName} is disabled in operator mode`)
      process.exit(2) // exit 2 blocks the tool call (Claude Code hook convention)
    }
    process.exit(0)
  },
})

/** The regex matcher scoping the guard hook to exactly the denied tools. */
export const FIRST_MATE_GUARD_MATCHER = "Edit|Write|NotebookEdit|mcp__workers__.*"

/** Build the hook command string that runs this subcommand. */
export function buildFirstMateGuardHookCommand(execPath: string, entry: string): string {
  return `${JSON.stringify(execPath)} ${JSON.stringify(entry)} internal-first-mate-guard`
}
