/**
 * The internal `internal-first-mate-guard` subcommand: a PreToolUse hook that
 * keeps local worker/orchestrate MCP tools subagent-only in cloud-agent OPERATOR
 * mode. It is injected into the spawned Claude session's settings ONLY in
 * `--agents`/operator mode, with a matcher scoped to those MCP tool prefixes.
 *
 * Reads the PreToolUse payload from stdin (`{tool_name, tool_input, ...}`) and,
 * if the tool is denied in operator mode, blocks via exit code 2 with a reason
 * on stderr (the repo's hook convention). Bash and file-authoring tools are not
 * matched by this guard and are not blocked.
 */
import { defineCommand } from "citty"

import { readFileSync } from "node:fs"

import { operatorPreToolUse, type OperatorToolInput } from "./lib/first-mate/operator-shaping"
import { buildSelfCommand, type SelfInvocation } from "./lib/hook-launcher/self-invocation"

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
    let hookInput: OperatorToolInput | undefined
    let parsed: boolean
    try {
      const payload = JSON.parse(readStdinSync()) as {
        tool_name?: unknown
        tool_input?: unknown
        agent_type?: unknown
      }
      if (typeof payload.tool_name === "string") toolName = payload.tool_name
      if (typeof payload.agent_type === "string") hookInput = { agent_type: payload.agent_type }
      parsed = true
    } catch {
      parsed = false // fail-closed below for a named-but-unparseable payload
    }
    if (toolName.length === 0) {
      // Nothing to guard (empty/absent tool name) → allow. But if the payload
      // did not even parse we cannot know it was empty; the matcher only routes
      // the denied tools here, so a parse failure means one of THOSE arrived
      // unreadable → fail-closed.
      if (!parsed) {
        process.stderr.write("operator guard: unparseable PreToolUse payload — blocking (fail-closed)")
        process.exit(2)
      }
      process.exit(0)
    }
    // This hook is only injected in operator mode, so operatorMode = true.
    const decision = operatorPreToolUse(toolName, true, hookInput)
    if (decision.block) {
      process.stderr.write(decision.reason ?? `${toolName} is disabled in operator mode`)
      process.exit(2) // exit 2 blocks the tool call (Claude Code hook convention)
    }
    process.exit(0)
  },
})

/** The regex matcher scoping the guard hook to exactly the denied tools. */
export const FIRST_MATE_GUARD_MATCHER = "mcp__workers__.*|mcp__orchestrate__.*"

/** Build the hook command string that runs this subcommand. */
export function buildFirstMateGuardHookCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-first-mate-guard")
}
