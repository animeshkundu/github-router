/**
 * Frozen contract for the NON-BLOCKING workers surface.
 *
 * The `workers` MCP tools (`explore`/`implement`/`review`/`plan`/`test`, and
 * `browse` when the browse agent is enabled) BLOCK the caller for up to 6h
 * (`runWorkerAgent`). The MAIN Claude Code agent must never block on one, so a
 * per-mode `worker-*` DISPATCHER SUBAGENT — which Claude Code runs in the
 * background and reports on via a completion notification — is the only
 * sanctioned way to run a worker. This module is the single source of truth for
 * three things that must never drift:
 *
 *   1. the tool → dispatcher map (`mcp__<workersKey>__<mode>` ↔ `worker-<mode>`),
 *   2. the PreToolUse GUARD decision that denies a raw worker call from the main
 *      agent (or any non-dispatcher subagent) and redirects it to the matching
 *      `worker-*` agent, allowing it only from the dispatcher itself, and
 *   3. the dispatcher subagent bodies (description / system prompt / `tools:`
 *      allowlist).
 *
 * Imported by `codex-mcp-config.ts` (dispatcher `.md` generation + the hook
 * command it bakes into settings.json) AND `internal-worker-guard.ts` (the
 * runtime PreToolUse hook). Keeping the map here means the settings matcher, the
 * redirect target, the dispatcher names, and the `tools:` allowlist are all
 * derived from one place.
 *
 * Discrimination mechanism: a Claude Code PreToolUse payload carries
 * `agent_type` (the invoking subagent's name) ONLY inside a subagent context —
 * absent for the top-level/main agent. So `agent_type === "worker-<mode>"` is
 * the reliable "this call came from the dispatcher, allow it" signal, and its
 * absence (or any other value) means "main agent or an unrelated subagent →
 * deny". This is the SAME field this repo's Stop / prompt-submit hooks already
 * key off (`isSubagentContext` in `orchestration/stop-gate-policy.ts`); the
 * guard here is the inverse (allow-only-dispatcher rather than skip-any-sub).
 */

/** The five always-available worker modes (gated by `workerToolsEnabled()`). */
export const CORE_WORKER_MODES = [
  "explore",
  "implement",
  "review",
  "plan",
  "test",
] as const

/** The browse worker mode, gated separately by `browseAgentEnabled()`. */
export const BROWSE_WORKER_MODE = "browse" as const

export type CoreWorkerMode = (typeof CORE_WORKER_MODES)[number]
export type WorkerDispatchMode = CoreWorkerMode | typeof BROWSE_WORKER_MODE

/** Every mode the surface can expose — used to build the sweep-regex allowlist
 *  and to validate `--modes`. Order is stable (core first, browse last). */
export const ALL_WORKER_DISPATCH_MODES: ReadonlyArray<WorkerDispatchMode> = [
  ...CORE_WORKER_MODES,
  BROWSE_WORKER_MODE,
]

/** The dispatcher subagent name for a mode, e.g. `implement` → `worker-implement`. */
export function dispatcherAgentName(mode: WorkerDispatchMode): string {
  return `worker-${mode}`
}

/** Every possible dispatcher subagent name (used by the stale-`.md` sweep). */
export const ALL_DISPATCHER_AGENT_NAMES: ReadonlyArray<string> =
  ALL_WORKER_DISPATCH_MODES.map(dispatcherAgentName)

/** The MCP tool name the workers server exposes for a mode under the resolved key. */
export function workerToolName(workersKey: string, mode: WorkerDispatchMode): string {
  return `mcp__${workersKey}__${mode}`
}

/** The active dispatch modes for a launch: the five core modes plus `browse`
 *  only when the browse agent is enabled. */
export function activeDispatchModes(opts: { browse: boolean }): Array<WorkerDispatchMode> {
  return opts.browse ? [...CORE_WORKER_MODES, BROWSE_WORKER_MODE] : [...CORE_WORKER_MODES]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The Claude Code PreToolUse `matcher` (a regex over the tool name) that scopes
 * the guard hook to exactly the active worker tools — nothing else invokes the
 * hook. Anchored + exact-alternation so an unrelated `mcp__<key>__status` (a
 * future non-blocking tool with no dispatcher) is never matched, hence never
 * denied.
 */
export function guardToolMatcher(workersKey: string, modes: ReadonlyArray<WorkerDispatchMode>): string {
  const alt = modes.map((m) => escapeRegex(m)).join("|")
  return `^mcp__${escapeRegex(workersKey)}__(${alt})$`
}

/** Parse the worker mode out of a tool name for the resolved key, or null if it
 *  isn't one of the recognized worker tools. */
export function parseWorkerToolCall(
  toolName: string,
  workersKey: string,
  modes: ReadonlyArray<WorkerDispatchMode>,
): WorkerDispatchMode | null {
  const prefix = `mcp__${workersKey}__`
  if (!toolName.startsWith(prefix)) return null
  const rest = toolName.slice(prefix.length)
  return (modes as ReadonlyArray<string>).includes(rest) ? (rest as WorkerDispatchMode) : null
}

/** The `permissionDecisionReason` shown to the model on a deny, steering it to
 *  the matching background dispatcher. `mode` is null when the payload was
 *  unparseable (fail-closed generic message). */
export function guardDenyReason(mode: WorkerDispatchMode | null): string {
  const target = mode
    ? `Agent(subagent_type: "${dispatcherAgentName(mode)}", prompt: <your worker brief>)`
    : `the matching background \`worker-*\` agent via the Agent tool`
  return (
    "Workers run as background subagents in this session so your turn never blocks. "
    + `Re-issue this as ${target}. `
    + "It returns immediately and delivers the worker's result as a completion notification — "
    + "do not call the raw `mcp__…__` worker tool from the main thread."
  )
}

/** The stdout JSON a PreToolUse hook prints to DENY a tool call. */
export function guardDenyOutput(mode: WorkerDispatchMode | null): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: guardDenyReason(mode),
    },
  })
}

export interface WorkerGuardResult {
  /** JSON to print to stdout (a deny decision), or null to ALLOW (print nothing). */
  output: string | null
  /** Machine-readable verdict for tests/telemetry. */
  verdict: "allow-dispatcher" | "allow-non-worker" | "deny-main" | "deny-malformed"
}

/**
 * Pure PreToolUse guard decision. Given the raw stdin payload, the resolved
 * workers key, and the active modes, decide whether to DENY the tool call.
 *
 * Rules (fail toward protecting the "main never blocks" invariant):
 *   - Payload unparseable / no string `tool_name`: the matcher only fires this
 *     hook for worker tools, so a payload we can't read is still a worker call
 *     → DENY (fail closed, generic redirect).
 *   - `tool_name` is not a recognized worker tool for this key: ALLOW (not a
 *     tool we guard — never deny a non-worker tool).
 *   - `agent_type` equals one of the active dispatcher names: ALLOW (the call
 *     came from the dispatcher subagent that is meant to run the worker).
 *   - Otherwise (main agent: `agent_type` absent; or a non-dispatcher subagent):
 *     DENY with a redirect to the matching `worker-<mode>` agent.
 */
export function decideWorkerGuard(input: {
  stdin: string
  workersKey: string
  modes: ReadonlyArray<WorkerDispatchMode>
}): WorkerGuardResult {
  let payload: { tool_name?: unknown; agent_type?: unknown } | null = null
  try {
    const parsed: unknown = JSON.parse(input.stdin)
    if (parsed && typeof parsed === "object") {
      payload = parsed as { tool_name?: unknown; agent_type?: unknown }
    }
  } catch {
    payload = null
  }

  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : null
  if (!toolName) {
    // Fail CLOSED: the settings matcher only routes worker-tool calls here, so
    // an unreadable payload is still a worker call we must not let through.
    return { output: guardDenyOutput(null), verdict: "deny-malformed" }
  }

  const mode = parseWorkerToolCall(toolName, input.workersKey, input.modes)
  if (mode === null) {
    // Not one of the worker tools we guard (matcher over-fired, or a future
    // non-blocking tool under the same server) → allow the normal flow.
    return { output: null, verdict: "allow-non-worker" }
  }

  const agentType = payload?.agent_type
  if (typeof agentType === "string" && agentType === dispatcherAgentName(mode)) {
    // The call originated inside the `worker-<mode>` dispatcher subagent that is
    // meant to run THIS worker. Require an exact mode match (not just "any
    // dispatcher"), so a read-only `worker-explore` can't invoke the
    // write-capable `implement` worker if it misroutes or is prompt-injected.
    // If a matching dispatcher is still denied, the payload that reached this
    // hook did not carry this exact top-level `agent_type`, or a different
    // PreToolUse hook denied the call after this guard allowed it.
    return { output: null, verdict: "allow-dispatcher" }
  }

  // Main agent (agent_type absent), a non-dispatcher subagent, or a dispatcher
  // for a DIFFERENT mode → deny + redirect. Denying non-dispatcher subagents
  // too closes the transitive-blocking hole (a foreground subagent that blocked
  // on a worker would transitively block the main agent).
  return { output: guardDenyOutput(mode), verdict: "deny-main" }
}

// ─── Dispatcher subagent bodies ──────────────────────────────────────────────

/** One-line human description shown to the lead when picking a subagent. Uses
 *  the documented "Use proactively" auto-delegation idiom. */
export function dispatcherDescription(mode: WorkerDispatchMode): string {
  const blurb: Record<WorkerDispatchMode, string> = {
    explore:
      "Non-blocking `explore` worker: dispatches a read-only autonomous worker (its own context) in the background and delivers its summary as a completion notification.",
    implement:
      "Non-blocking `implement` worker: dispatches an autonomous coding worker (read/write/bash, optional git worktree) in the background and delivers its result as a completion notification.",
    review:
      "Non-blocking `review` worker: dispatches a read-only reviewer that reads the code itself to verify a change or claim, in the background, and delivers findings as a completion notification.",
    plan:
      "Non-blocking `plan` worker: dispatches a read-only planner that returns an ordered implementation plan, in the background, and delivers it as a completion notification.",
    test:
      "Non-blocking `test` worker: dispatches an independent test author that writes tests trying to break the implementation, in the background, and delivers pass/fail as a completion notification.",
    browse:
      "Non-blocking `browse` worker: dispatches an autonomous browser agent in the background and delivers its result as a completion notification.",
  }
  return (
    `${blurb[mode]} Use proactively for any ${mode}-mode worker task so a long run never blocks your turn: `
    + "it returns immediately and notifies you when done."
  )
}

/** The dispatcher subagent's full system prompt: call the one worker tool once,
 *  relay verbatim, do nothing else. */
export function dispatcherPrompt(mode: WorkerDispatchMode, workersKey: string): string {
  const tool = workerToolName(workersKey, mode)
  const briefField = mode === "browse" ? "task" : "prompt"
  const briefDescription = mode === "browse" ? "the lead's browse task, copied verbatim" : "the lead's worker brief, copied verbatim"
  const modeSpecificPassThrough = mode === "implement" || mode === "test"
    ? "\n  - `worktree` (optional): pass `true` if the lead asked for isolated-worktree execution"
    : mode === "browse"
      ? "\n  - `sessionId` (optional): pass through if the lead specified one"
      : ""
  return [
    `# Subagent: ${dispatcherAgentName(mode)}`,
    "",
    `You are a thin DISPATCHER for the \`${mode}\` worker. You run in the background so the`,
    "lead agent's turn is never blocked while the (up-to-6-hour) worker runs.",
    "",
    "## Your only job",
    "",
    `Call the \`${tool}\` tool EXACTLY ONCE, passing through the fields from the lead's brief:`,
    `  - \`${briefField}\`: ${briefDescription}`,
    "  - `workspace` (optional): absolute path, if the lead specified one",
    "  - `model` / `thinking` (optional): only if the lead specified them",
    "  - `maxWallClockMs` (optional): per-call wall-clock budget in ms, if the lead specified one"
      + modeSpecificPassThrough,
    "",
    "When the tool returns, output its result VERBATIM as your final message. That final",
    "message is what the lead receives in the completion notification — it IS the result.",
    "",
    "## Hard rules",
    "",
    "- Call the worker tool exactly once. Do not retry on a normal (non-error) return.",
    "- Do NOT attempt the task yourself, do NOT read/edit files, do NOT run other tools.",
    "- Do NOT spawn other agents (you have no Agent tool and must not try to gain one).",
    "- Do NOT summarize, paraphrase, or add commentary — relay the worker output verbatim.",
    "- If the worker returns an error, relay that error verbatim (do not mask it).",
  ].join("\n")
}

/** The `tools:` frontmatter allowlist for a dispatcher: the workers MCP server
 *  wildcard (`mcp__<workersKey>__*`). Claude Code's `tools:` field supports
 *  MCP patterns only at SERVER granularity (`mcp__<server>__*`), not individual
 *  tool names, so this grants exactly the workers tools and NOTHING else — no
 *  Agent/Task (so it cannot spawn further agents → no recursion), no Read/Bash
 *  (so it cannot do extra work). The dispatcher's prompt narrows it to the one
 *  mode; the guard allows only the exact dispatcher for that worker mode. */
export function dispatcherTools(_mode: WorkerDispatchMode, workersKey: string): Array<string> {
  return [`mcp__${workersKey}__*`]
}

/**
 * Build the shell command Claude Code runs for the workers `PreToolUse` guard
 * hook — the running github-router via its node/bun binary so it works
 * regardless of PATH. Mirrors `buildPromptSubmitHookCommand`.
 *
 * The resolved `workersKey` and the active `modes` are baked into the command
 * ARGS (not env): `mergeStopHookIntoSettings` dedups hooks by the command
 * string only, so baking the key/modes makes a changed resolution produce a
 * DISTINCT command — no stale-matcher entry can survive from a prior launch.
 */
export function buildWorkerGuardHookCommand(
  execPath: string,
  scriptPath: string | undefined,
  workersKey: string,
  modes: ReadonlyArray<WorkerDispatchMode>,
): string {
  const q = (s: string): string => `"${s}"`
  const args = `internal-worker-guard --workers-key ${q(workersKey)} --modes ${q(modes.join(","))}`
  if (scriptPath && scriptPath !== execPath) {
    return `${q(execPath)} ${q(scriptPath)} ${args}`
  }
  return `${q(execPath)} ${args}`
}

/** Parse a `--modes` CSV back into validated modes (drops unknown tokens). */
export function parseModesCsv(csv: string | undefined): Array<WorkerDispatchMode> {
  if (!csv) return [...CORE_WORKER_MODES]
  const known = new Set<string>(ALL_WORKER_DISPATCH_MODES)
  const out = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s)) as Array<WorkerDispatchMode>
  return out.length > 0 ? out : [...CORE_WORKER_MODES]
}
