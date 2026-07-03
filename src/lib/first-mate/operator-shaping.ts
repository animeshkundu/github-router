/**
 * Capability shaping for github-router operator/`--agents` mode.
 *
 * When first-mate/operator mode is active the spawned Claude is the cloud-agent
 * OPERATOR, not an implementer: it must delegate ALL implementation to GitHub
 * cloud agents (and may use subagents/first-mate to orchestrate), but it must
 * not hand-code. Because the launcher spawns `claude --dangerously-skip-permissions`
 * (which ignores settings `permissions.deny`), enforcement is a PreToolUse hook
 * that fires regardless and BLOCKS the file-authoring + local-worker vectors.
 *
 * Kept available: Agent (subagents/forks), the first-mate MCP, read-only `gh`
 * via Bash, and read/search tools. Dropped: Edit/Write/NotebookEdit and
 * mcp__workers__* (local implementation agents). Gated: only in operator mode;
 * a normal session is untouched.
 */

/** Tools denied to the operator (exact names + the workers MCP prefix). */
export const OPERATOR_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const
export const OPERATOR_DENIED_MCP_PREFIXES = ["mcp__workers__"] as const

/** Tools explicitly preserved (documented; used by assertion tests). */
export const OPERATOR_KEPT_TOOLS = [
  "Agent",
  "Task",
  "Bash", // read-only gh + read-only shell
  "Read",
  "Grep",
  "Glob",
  "mcp__first-mate__",
] as const

export const OPERATOR_MODE_BANNER =
  "MODE: cloud-agent operator. You DELEGATE all implementation to GitHub cloud " +
  "agents via the first-mate MCP (and may use subagents to orchestrate/protect " +
  "context). You do NOT hand-code: Edit/Write/NotebookEdit and mcp__workers__* " +
  "are disabled. Read-only gh, Agent, first-mate, and read/search remain."

/**
 * Least-privilege note for what the cloud agents themselves may touch — the
 * operator scopes missions to specific repos and forbids irreversible actions
 * without human approval (see first-mate house rules). This constant documents
 * the intent for the launcher/README; enforcement of the cloud-agent scope is
 * the GitHub agent-token scope (repo/workflow) + the mission house_rules.
 */
export const CLOUD_AGENT_SCOPE_NOTE =
  "Cloud agents operate only within mission-listed repos; merges, releases, " +
  "Pages, and deletes require explicit human approval (first-mate merge gate)."

/**
 * Decide whether a tool call must be BLOCKED for the operator. Pure — used both
 * by the PreToolUse hook handler and by config-assertion tests. When operator
 * mode is off, nothing is blocked (normal sessions unaffected).
 */
export function shouldDenyOperatorTool(toolName: string, operatorMode: boolean): boolean {
  if (!operatorMode) return false
  if ((OPERATOR_DENIED_TOOLS as readonly string[]).includes(toolName)) return true
  return OPERATOR_DENIED_MCP_PREFIXES.some((p) => toolName.startsWith(p))
}

export interface PreToolUseDecision {
  block: boolean
  reason?: string
}

/** The PreToolUse hook decision for a given tool name in operator mode. */
export function operatorPreToolUse(
  toolName: string,
  operatorMode: boolean,
): PreToolUseDecision {
  if (shouldDenyOperatorTool(toolName, operatorMode)) {
    return {
      block: true,
      reason: `${toolName} is disabled in cloud-agent operator mode — delegate implementation to a GitHub cloud agent via the first-mate MCP instead of hand-coding.`,
    }
  }
  return { block: false }
}
