/**
 * Operator-mode steering for github-router `--agents` sessions.
 *
 * In first-mate/operator mode the spawned Claude is the cloud-agent operator, not
 * the product implementer. Product implementation is steered to GitHub cloud
 * agents by first-mate guidance and the gh-first-mate skill. This module no
 * longer hard-blocks local file writes or shell commands: Edit/Write/NotebookEdit
 * and Bash remain available as escape hatches when needed.
 *
 * The only enforced main-operator boundary is that local worker/orchestrate MCP
 * tools stay subagent-only. The main operator should invoke the worker-* Agent
 * subagents or delegate to GitHub cloud agents rather than calling
 * `mcp__workers__*` / `mcp__orchestrate__*` directly.
 */

import {
  ALL_WORKER_DISPATCH_MODES,
  dispatcherAgentName,
  type WorkerDispatchMode,
} from "../worker-dispatch"

/** Tools denied to the main operator by exact name. */
export const OPERATOR_DENIED_TOOLS = [] as const

/** MCP prefixes denied to the main operator; these remain subagent-only. */
export const OPERATOR_DENIED_MCP_PREFIXES = ["mcp__workers__", "mcp__orchestrate__"] as const

/** Tools explicitly preserved (documented; used by assertion tests). */
export const OPERATOR_KEPT_TOOLS = [
  "Agent",
  "Task",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "mcp__first-mate__",
] as const

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

export interface OperatorToolInput extends Record<string, unknown> {
  agent_type?: unknown
}

export interface PreToolUseDecision {
  block: boolean
  reason?: string
}

/**
 * Decide whether a tool call must be blocked for the main operator. Pure — used
 * both by the PreToolUse hook handler and by config-assertion tests. When
 * operator mode is off, nothing is blocked (normal sessions unaffected).
 */
function parseWorkerMode(toolName: string): WorkerDispatchMode | null {
  const workersPrefix = "mcp__workers__"
  if (!toolName.startsWith(workersPrefix)) return null
  const mode = toolName.slice(workersPrefix.length)
  return (ALL_WORKER_DISPATCH_MODES as ReadonlyArray<string>).includes(mode) ? (mode as WorkerDispatchMode) : null
}

function isMatchingWorkerDispatcher(toolName: string, input?: OperatorToolInput): boolean {
  const mode = parseWorkerMode(toolName)
  if (mode === null) return false
  return input?.agent_type === dispatcherAgentName(mode)
}

export function shouldDenyOperatorTool(
  toolName: string,
  operatorMode: boolean,
  input?: OperatorToolInput,
): boolean {
  if (!operatorMode) return false
  if (isMatchingWorkerDispatcher(toolName, input)) return false
  return OPERATOR_DENIED_MCP_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}

/**
 * M4 — fail-CLOSED. If operator/`--agents` mode is active but the reduced
 * worker/orchestrate guard could NOT be installed (e.g. settings.json unwritable),
 * the operator session must NOT start with direct main-thread worker/orchestrate
 * MCP calls available. Non-agents sessions are never affected.
 */
export function assertShapingInstalled(agentsMode: boolean, injectionSucceeded: boolean): void {
  if (agentsMode && !injectionSucceeded) {
    throw new Error(
      "cloud-agent operator mode requires the worker/orchestrate PreToolUse hook, " +
        "but it could not be installed — refusing to start an unguarded operator session.",
    )
  }
}

/**
 * The PreToolUse hook decision for a given tool name in operator mode.
 *
 * Bash and file-authoring tools are always allowed. Only direct main-operator
 * calls to local worker/orchestrate MCP tools are blocked so those backends stay
 * reachable through the worker-* Agent subagents rather than the lead context.
 */
export function operatorPreToolUse(
  toolName: string,
  operatorMode: boolean,
  input?: OperatorToolInput,
): PreToolUseDecision {
  if (!operatorMode) return { block: false }
  if (shouldDenyOperatorTool(toolName, operatorMode, input)) {
    return {
      block: true,
      reason: `${toolName} is subagent-only in cloud-agent operator mode — use the worker-* Agent subagents or delegate implementation to a GitHub cloud agent via the first-mate MCP instead of calling local worker/orchestrate MCP tools from the main operator.`,
    }
  }
  return { block: false }
}
