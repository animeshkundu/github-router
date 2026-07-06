/**
 * The internal `internal-first-mate-guard` subcommand: a PreToolUse hook that
 * enforces cloud-agent OPERATOR capability shaping. It is injected into the
 * spawned Claude session's settings ONLY in `--agents`/operator mode, with a
 * matcher scoped to Bash and local worker/orchestrate MCP tools.
 *
 * Reads the PreToolUse payload from stdin (`{tool_name, tool_input, ...}`) and,
 * if the tool is denied in operator mode, blocks via exit code 2 with a reason
 * on stderr (the repo's hook convention). For Bash the command is inspected for
 * file-mutation patterns. FAIL-CLOSED: a payload that names a guarded tool but
 * cannot be parsed/inspected blocks; only a truly empty tool name (nothing to
 * guard) exits 0.
 */
import { defineCommand } from "citty"

import { readFileSync } from "node:fs"

import { operatorPreToolUse, type OperatorToolInput } from "./lib/first-mate/operator-shaping"

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
    let toolInput: OperatorToolInput | undefined
    let parsed = false
    try {
      const payload = JSON.parse(readStdinSync()) as {
        tool_name?: unknown
        tool_input?: unknown
      }
      if (typeof payload.tool_name === "string") toolName = payload.tool_name
      if (typeof payload.tool_input === "object" && payload.tool_input !== null) {
        // The whole tool_input object flows through; operatorPreToolUse inspects
        // only `command` for Bash.
        toolInput = payload.tool_input as OperatorToolInput
      }
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
    const decision = operatorPreToolUse(toolName, true, toolInput)
    if (decision.block) {
      process.stderr.write(decision.reason ?? `${toolName} is disabled in operator mode`)
      process.exit(2) // exit 2 blocks the tool call (Claude Code hook convention)
    }
    if (decision.additionalContext !== undefined) {
      // ALLOW + inject steering context. Per the Claude Code PreToolUse hook
      // contract, `hookSpecificOutput.additionalContext` on an exit-0 JSON stdout
      // is added to the model's context as a system reminder next to the tool
      // result (plain stdout is NOT surfaced to the model for PreToolUse) — so an
      // allowed-but-unvettable control-flow command still carries guidance rather
      // than being silently waved through.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: decision.additionalContext,
          },
        }),
      )
    }
    process.exit(0)
  },
})

/** The regex matcher scoping the guard hook to exactly the denied tools. */
export const FIRST_MATE_GUARD_MATCHER = "Bash|mcp__workers__.*|mcp__orchestrate__.*"

/** Build the hook command string that runs this subcommand. */
export function buildFirstMateGuardHookCommand(execPath: string, entry: string): string {
  return `${JSON.stringify(execPath)} ${JSON.stringify(entry)} internal-first-mate-guard`
}
