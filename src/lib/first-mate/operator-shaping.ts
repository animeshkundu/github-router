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

/**
 * B1 — detect a Bash command that MUTATES the filesystem/repo. Bash stays
 * available to the operator for read-only `gh` and inspection, but hand-coding
 * via the shell (writing files, applying patches, committing) is the exact
 * vector the Edit/Write deny-list closes, so it must be blocked here too.
 *
 * Returns a human reason when the command mutates, else undefined. Conservative
 * by design (fail-toward-blocking): output redirection to a real file, tee,
 * in-place sed, dd, patch, and mutating git subcommands all block. The only
 * redirection exceptions are pure file-descriptor duplication (`2>&1`, `>&2`)
 * and discarding to `/dev/null`, which do not write a real file — so the common
 * read-only idioms (`gh ... 2>/dev/null`) stay usable.
 */
export function bashMutationReason(command: string): string | undefined {
  // Strip redirections that do NOT write a real file before testing for `>`:
  //   - fd duplication: 2>&1, >&2, >&-
  //   - discard to /dev/null: >/dev/null, 2>/dev/null, &>/dev/null
  const benign = command
    .replace(/\d*>&\s*[\d-]+/g, " ")
    .replace(/&?\d*>{1,2}\s*\/dev\/null/g, " ")
  if (/>/.test(benign)) return "shell output redirection writes a file"
  if (/(^|[|&;(\s])tee(\s|$)/.test(command)) return "tee writes files"
  if (/\bsed\b[^|&;]*(\s-[a-z]*i|--in-place)/.test(command)) return "sed -i edits files in place"
  if (/(^|[|&;(\s])dd(\s|$)/.test(command)) return "dd writes to disk"
  if (/(^|[|&;(\s])patch(\s|$)/.test(command)) return "patch mutates files"
  if (
    /\bgit\s+(apply|commit|checkout|switch|reset|restore|rm|mv|push|stash|clean|revert|cherry-pick|merge|rebase|tag|am|format-patch)\b/.test(
      command,
    )
  ) {
    return "git subcommand mutates the repository"
  }
  return undefined
}

/**
 * M4 — fail-CLOSED. If operator/`--agents` mode is active but the capability
 * -shaping guard could NOT be installed (e.g. settings.json unwritable), the
 * operator session must NOT start unshaded. The launcher calls this after
 * attempting injection; it throws to abort the launch. Non-agents sessions are
 * never affected.
 */
export function assertShapingInstalled(agentsMode: boolean, injectionSucceeded: boolean): void {
  if (agentsMode && !injectionSucceeded) {
    throw new Error(
      "cloud-agent operator mode requires the capability-shaping PreToolUse hook, " +
        "but it could not be installed — refusing to start an unshaded operator session.",
    )
  }
}

/**
 * The PreToolUse hook decision for a given tool name in operator mode.
 *
 * For Bash the command is inspected: a file-mutating command is blocked, a
 * read-only one is allowed. FAIL-CLOSED — if operator mode is on and a Bash
 * call arrives with no inspectable command string, block it (a malformed /
 * unparseable Bash payload must not slip an unchecked shell through).
 *
 * Task propagation: this guard is a PreToolUse hook in the spawned session's
 * settings.json, which also governs subagents spawned via Task/Agent — their
 * Bash calls hit the same hook. Agent/Task themselves stay allowed (the
 * operator orchestrates), but a subagent cannot use Bash to hand-code around
 * the block. (A subagent launched with an isolated settings dir would be the
 * only residual; the launcher does not do that in operator mode.)
 */
export function operatorPreToolUse(
  toolName: string,
  operatorMode: boolean,
  input?: { command?: unknown },
): PreToolUseDecision {
  if (!operatorMode) return { block: false }
  if (shouldDenyOperatorTool(toolName, operatorMode)) {
    return {
      block: true,
      reason: `${toolName} is disabled in cloud-agent operator mode — delegate implementation to a GitHub cloud agent via the first-mate MCP instead of hand-coding.`,
    }
  }
  if (toolName === "Bash") {
    const command = input?.command
    if (typeof command !== "string" || command.length === 0) {
      // Fail-closed: a Bash call we cannot inspect is treated as unsafe.
      return {
        block: true,
        reason:
          "Bash call blocked in cloud-agent operator mode — its command could not be inspected (fail-closed).",
      }
    }
    const reason = bashMutationReason(command)
    if (reason !== undefined) {
      return {
        block: true,
        reason: `Bash file-mutation blocked in cloud-agent operator mode (${reason}) — delegate implementation to a GitHub cloud agent instead of hand-coding via the shell.`,
      }
    }
  }
  return { block: false }
}
