import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { FAST_PROFILE_NATIVE_AGENT_NAMES } from "./fast-profile-contract"

import { type SelfInvocation } from "./hook-launcher/self-invocation"
import { buildCodexProviderConfigFlags } from "./launch"
import { buildWorkspaceHeaderHelperCommand } from "./mcp-workspace-header"
import { oneMContextDisabled, withOneMSuffix } from "./one-m-context"
import { PATHS, writeRuntimeFileSecure } from "./paths"
import {
  buildAgentPrompt,
  personasFor,
  type PersonaSpec,
  GROUP_META,
  MCP_GROUPS,
  type McpGroup,
} from "./peer-mcp-personas"
import { type Effort as SubagentEffort } from "./reasoning-effort"
import {
  FAST_CRITIC_ALIAS_ID,
  LUNA_IMPLEMENTER_ALIAS_ID,
  LUNA_SCOUT_ALIAS_ID,
} from "./launch-profile"
import {
  activeDispatchModes,
  dispatcherAgentName,
  dispatcherDescription,
  dispatcherPrompt,
  dispatcherTools,
} from "./worker-dispatch"

/**
 * Resolved `mcpServers` config key per enabled group. Bare preferred key
 * (`peers`/`search`/…) or the `gh-router-<group>` fallback on collision;
 * a group absent from the map is either disabled (gate off at launch) or
 * skipped because BOTH its bare AND prefixed keys collided with a user
 * entry. See `resolveGroupKeysFromMirror`.
 */
export type ResolvedGroupKeys = Partial<Record<McpGroup, string>>

/** The `peers` server is always enabled, so its resolved key always exists;
 *  this convenience reads it with the bare-key fallback for safety. */
function peersKeyOf(groupKeys: ResolvedGroupKeys): string {
  return groupKeys.peers ?? GROUP_META.peers.preferredKey
}

/** The resolved `workers` server key (bare `workers`, or the `gh-router-workers`
 *  fallback on collision). Used to name the dispatcher tools and the guard
 *  matcher. Falls back to the preferred bare key when the group is absent (the
 *  caller only builds worker dispatchers when the group is enabled anyway). */
export function workersKeyOf(groupKeys: ResolvedGroupKeys): string {
  return groupKeys.workers ?? GROUP_META.workers.preferredKey
}

export type CodexMcpBackend = "http" | "cli"

interface ResolveBackendOpts {
  requested: boolean
  codexInfo: { ok: boolean; version?: string } | null
}

/**
 * Decide which MCP backend serves the codex personas.
 *
 *   - User passed `--codex-cli` AND codex 0.129+ is on PATH → "cli".
 *     The peer config registers `codex-cli` as a stdio MCP server
 *     spawning `codex mcp-server`; codex personas route there;
 *     gemini-critic stays on the HTTP backend (Codex CLI can't run
 *     Gemini).
 *   - User passed `--codex-cli` but codex is missing or < 0.129 →
 *     fallback to "http" with a warning. Never break
 *     `github-router claude` over a missing optional dep.
 *   - User did not pass `--codex-cli` → "http", read-only personas only.
 */
export function resolveCodexCliBackend(
  opts: ResolveBackendOpts,
): CodexMcpBackend {
  if (!opts.requested) return "http"
  if (!opts.codexInfo || !opts.codexInfo.ok) {
    const detail = opts.codexInfo?.version
      ? `installed version "${opts.codexInfo.version}" is too old (need 0.129+)`
      : "codex CLI not found on PATH"
    consola.warn(
      `--codex-cli requested but ${detail}; falling back to HTTP-only Codex MCP backend (codex-implementer will not be registered).`,
    )
    return "http"
  }
  return "cli"
}

interface BuildOpts {
  /** Whether the codex-cli stdio server should be added. */
  codexCli: boolean
  /** Whether a supported Gemini review model is in the live catalog. Gates both
   *  gemini-critic and gemini-reviewer. */
  geminiAvailable: boolean
  /** Preferred Gemini persona model resolved from the live catalog. */
  geminiModel?: string
  /** Resolved config key per enabled group — one `mcpServers` HTTP entry is
   *  emitted per present key, pointing at its scoped `/mcp/<group>` URL. */
  groupKeys: ResolvedGroupKeys
  /** Per-launch nonce for the HTTP /mcp Authorization header. */
  nonce: string
  /** Isolated CODEX_HOME for the stdio child (only used when codexCli). */
  codexHome: string
  /** headersHelper command emitted on each HTTP entry for per-session workspace routing. */
  workspaceHeaderCmd?: string
  /** Base proxy URL (e.g. `http://127.0.0.1:PORT`). Needed by
   *  `buildPeerAgentDefinitions` to inline each subagent's scoped HTTP MCP
   *  server config into its `.md` frontmatter (claude-code#30280 workaround).
   *  `buildPeerMcpConfig` takes it positionally, so it's optional here. */
  serverUrl?: string
  /** Whether the core worker tools are served (`workerToolsEnabled()`). When
   *  true, the `worker-explore/implement/review/plan/test` dispatcher subagents
   *  are generated. Optional (defaults false) so `buildPeerMcpConfig` callers
   *  that don't build agents need not pass it. */
  workerToolsAvailable?: boolean
  /** Whether the browse worker tool is served (`browseAgentEnabled()`). Gates
   *  the extra `worker-browse` dispatcher. Optional (defaults false). */
  browseAvailable?: boolean
  /** Model for the native subagents that want the OpenAI frontier coder
   *  (`implementer`, `reviewer`) when present in the live catalog. */
  nativeSubagentModel?: string
  /** Model for `reviewer`. Google-first and deliberately NOT `implementer`'s
   *  model, so a review is cross-lab against whoever produced the work. */
  reviewerModel?: string
  /** Model for `reviewer-fast` (the cheaper review tier). Absent → the agent is
   *  OMITTED rather than inheriting the lead's model. */
  reviewerFastModel?: string
  /** Model for `brainstorm` (a third lab, for options the lead would not
   *  generate). Absent → the agent inherits the lead's model. */
  brainstormModel?: string
  /** Model for `scout`. Absent → the agent is OMITTED rather than inheriting the
   *  lead's model, because being cheaper than the lead is its whole purpose. */
  scoutModel?: string
  /** Model for `scribe`. Absent → the agent inherits the lead's model. */
  scribeModel?: string
  /** Model for `implementer-fast` (the cheaper implementation tier). Absent →
   *  the agent is OMITTED rather than inheriting the lead's model. */
  implementerFastModel?: string
  /** Model for `general-purpose-fast` (the fast, cheapest catch-all). Absent →
   *  OMITTED. */
  generalPurposeFastModel?: string
  /** Optional hard roster restriction, by native agent key (`"implementer"`,
   *  `"scout"`, …). When present, ONLY keys in this set may be emitted —
   *  each still subject to its usual model gate — regardless of whether an
   *  excluded agent's model would otherwise resolve. Absent → unrestricted
   *  (today's full catalog-driven roster). Used by profile-restricted
   *  launches (e.g. the fast profile) so implementer/reviewer/brainstorm/
   *  scribe/general-purpose-fast/coordinator are hard-excluded rather than
   *  merely missing a model. */
  nativeRoster?: ReadonlySet<string> | ReadonlyArray<string>
  /** Optional persona allowlist (by `agentName`) forwarded to `personasFor`.
   *  Absent → unrestricted (today's full persona set). */
  personaAllowlist?: ReadonlySet<string> | ReadonlyArray<string>
  /** Whether to emit the `peer-review-coordinator` meta-subagent. Default
   *  true (today's behavior). A profile with too narrow a persona roster
   *  for fan-out coordination to make sense (e.g. the fast profile, which
   *  registers only `gemini-critic`) should pass `false`. */
  includeCoordinator?: boolean
  /** Fast-profile role assignments. When present, the explicit fast branch
   *  emits the exact `Explore`/`implementer`/`reviewer`/`Plan`/`critic` roster instead
   *  of reusing standard role bodies. Standard callers omit these fields. */
  fastProfile?: boolean
  plannerModel?: string
  /** Fixed `effort:` frontmatter overrides. Absent keeps standard picker-driven
   *  behavior. */
  scoutEffort?: SubagentEffort
  implementerEffort?: SubagentEffort
  reviewerEffort?: SubagentEffort
  plannerEffort?: SubagentEffort
  criticEffort?: SubagentEffort
  /** Resolved fast native critic model. */
  criticModel?: string
  /** Compatibility fields for the original fast-profile implementation. */
  implementerFastEffort?: SubagentEffort
  reviewerFastEffort?: SubagentEffort
}

export interface HttpMcpEntry {
  type: "http"
  url: string
  headers: Record<string, string>
  headersHelper?: string
}

interface StdioMcpEntry {
  command: string
  args: Array<string>
  env: Record<string, string>
}

export interface PeerMcpConfig {
  mcpServers: Record<string, HttpMcpEntry | StdioMcpEntry>
}

/**
 * Build one scoped HTTP `mcpServers` entry for a group: `type: http`, the
 * `/mcp/<urlSuffix>` URL, the Bearer-nonce Authorization header, and the
 * per-session workspace `headersHelper` when supplied. Shared by
 * `buildPeerMcpConfig` (the session `.claude.json` entries) AND
 * `buildPeerAgentDefinitions` (the per-subagent inline `mcpServers` frontmatter
 * that sidesteps Claude Code's Agent-tool MCP-inheritance bug, anthropics/
 * claude-code#30280 — a bare name-reference "shares the parent connection" and
 * re-triggers it, so subagents MUST inline the full HTTP config to connect
 * independently). One source of truth so the two can't drift.
 */
function httpEntryFor(
  serverUrl: string,
  group: McpGroup,
  nonce: string,
  workspaceHeaderCmd?: string,
): HttpMcpEntry {
  const entry: HttpMcpEntry = {
    type: "http",
    url: `${serverUrl}/mcp/${GROUP_META[group].urlSuffix}`,
    headers: {
      Authorization: `Bearer ${nonce}`,
    },
  }
  const ws = workspaceHeaderCmd?.trim()
  if (ws) entry.headersHelper = ws
  return entry
}

/**
 * Build the JSON payload for `claude --mcp-config <path>` (and the same
 * entries that get merged into the mirrored `.claude.json`).
 *
 * Emits one HTTP `mcpServers` entry per enabled group present in
 * `opts.groupKeys`, each pointing at its scoped `/mcp/<group>` endpoint
 * under the resolved (bare or prefixed-fallback) config key. When
 * `codexCli` is true, also registers `codex-cli` (stdio) which spawns
 * `codex mcp-server` with the proxy's provider-config flags so codex runs
 * through our Copilot-routed billing path rather than its default
 * api.openai.com.
 */
export function buildPeerMcpConfig(
  serverUrl: string,
  opts: BuildOpts,
): PeerMcpConfig {
  const mcpServers: Record<string, HttpMcpEntry | StdioMcpEntry> = {}

  const workspaceHeaderCmd = opts.workspaceHeaderCmd?.trim()
  for (const group of MCP_GROUPS) {
    const key = opts.groupKeys[group]
    if (!key) continue // group disabled at launch, or both keys collided
    mcpServers[key] = httpEntryFor(serverUrl, group, opts.nonce, workspaceHeaderCmd)
  }

  if (opts.codexCli) {
    mcpServers["codex-cli"] = {
      command: "codex",
      args: ["mcp-server", ...buildCodexProviderConfigFlags(serverUrl)],
      env: {
        OPENAI_BASE_URL: `${serverUrl}/v1`,
        OPENAI_API_KEY: "dummy",
        CODEX_HOME: opts.codexHome,
      },
    }
  }

  return { mcpServers }
}

export interface PeerAgentDefinition {
  description: string
  prompt: string
  model?: string
  /** Fixed reasoning-effort frontmatter for this subagent, overriding the
   *  Claude Code session's effort picker for this subagent only (documented
   *  Claude Code subagent frontmatter behavior). Absent → the subagent
   *  follows the session's picker, which is the standard-profile default for
   *  every native today. The fast profile fixes effort on all five of its role
   *  definitions (`Explore`, `implementer`, `reviewer`, `Plan`, `critic`). */
  effort?: SubagentEffort
  tools?: ReadonlyArray<string>
  /** Inline MCP servers scoped to this subagent, emitted into its `.md`
   *  frontmatter as the connect-independently `mcpServers` list. Required
   *  because Agent-tool-spawned subagents don't reliably inherit the session's
   *  HTTP MCP servers (anthropics/claude-code#30280); an inline entry connects
   *  when the subagent starts. Keyed by resolved server key → HTTP config. */
  mcpServers?: Record<string, HttpMcpEntry>
}

export type PeerAgentDefinitions = Record<string, PeerAgentDefinition>

/**
 * The `peer-review-coordinator` Claude Code subagent — the strongest
 * auto-invocation lever per Phase 2A of the peer-MCP plan. It is NOT a
 * peer-MCP tool; it is a regular Claude Code subagent that runs inside
 * the spawned-claude context, has tool access to the peer MCP tools
 * (codex_critic, codex_reviewer, gemini_critic), and fans out + aggregates.
 *
 * The "use proactively" phrase in the description is the documented Claude
 * Code idiom for subagents the parent (Opus) should delegate to without
 * explicit user request — at the natural checkpoints listed below.
 *
 * Empirically the polling-loop reliability for "use proactively" is ~60%
 * (claude-code-guide expert estimate); the plan calls for an acceptance
 * test (≥7/10 sessions delegate at the right checkpoints) before declaring
 * "auto-invoked". If <7/10 we flip the optional PreToolUse hook on
 * ExitPlanMode to default-on (env-disable-able).
 */
function buildCoordinatorAgent(opts: {
  codexCli: boolean
  geminiAvailable: boolean
}): { description: string; prompt: string } {
  // opus-critic is always registered (Anthropic models are always present
  // in the Copilot catalog), so no `geminiAvailable`-style guard is
  // required. Order: codex-critic first (strongest reasoning, cross-lab),
  // opus-critic second (largest context window — 1M when available),
  // gemini-critic third (third-lab triangulation, formal reasoning, only
  // when registered), codex-reviewer + gemini-reviewer last (line-level code
  // reviewers; both gemini personas gate on the gemini-3.x-pro catalog).
  const peers: Array<string> = ["codex-critic", "opus-critic"]
  if (opts.geminiAvailable) peers.push("gemini-critic")
  peers.push("codex-reviewer")
  if (opts.geminiAvailable) peers.push("gemini-reviewer")

  const description =
    "Coordinates cross-lab adversarial review across codex-critic, opus-critic, gemini-critic, codex-reviewer. Use proactively before non-trivial plans and after non-trivial commits. Always pass artifacts verbatim — peers are fresh-context."

  const personaList = peers.map((p) => `- \`${p}\``).join("\n")

  const prompt = [
    "# Subagent: peer-review-coordinator",
    "",
    "You orchestrate cross-lab adversarial review for the lead orchestrator (Opus). You have access to these peer-MCP subagents:",
    "",
    personaList,
    "",
    "## When the lead invokes you",
    "",
    "The lead's brief will include an artifact (plan, design, diff, or code) and a goal (e.g. 'review before exit-plan', 'review the commit I just made', 'cross-check codex-critic's verdict'). Pick the right peers for the artifact type:",
    "",
    "- **Plan / design / architecture choice** → fan out to `codex-critic` (gpt-5.6-sol, strongest reasoning, cross-lab)"
      + (opts.geminiAvailable ? " AND `gemini-critic` (third-lab triangulation, strong on formal reasoning) in parallel" : "")
      + ". codex-reviewer is the wrong tool for plans (it's a code-specialist, not an architecture critic).",
    "- **Concrete diff or single file** → fan out to `codex-reviewer` (gpt-5.3-codex, line-level code specialist)"
      + (opts.geminiAvailable ? " AND `gemini-reviewer` (gemini-3.1-pro, second-lab line-level review)" : "")
      + (opts.geminiAvailable ? " AND `gemini-critic` for cross-lab triangulation" : "")
      + ". For very small changes (<20 lines), one `codex-reviewer` call is enough.",
    "- **Large artifact** → the only peers that take a large artifact WHOLE are `codex-critic` (gpt-5.6-sol, ≈1M-token input window) and `opus-critic` (Opus-4.7-1M, ≈936K-token input on enterprise catalogs; ≈168K otherwise). Route the full artifact to those for cross-lab coverage. `codex-reviewer` (≈272K) and `gemini-critic` (≈136K) have small windows — see Decomposition below: never summarize or downsize the request to squeeze a large artifact into a small-window peer.",
    "- **Formal reasoning, proofs, or invariants** → prefer `gemini-critic`"
      + (opts.geminiAvailable ? " (gemini-3.1-pro, strong on math and formally-stated properties)" : " (NOT REGISTERED in this session — gemini-3.x not in catalog)")
      + ".",
    "- **Tie-breaker after codex-critic has weighed in** → call `gemini-critic`"
      + (opts.geminiAvailable ? "" : " (NOT REGISTERED in this session)")
      + " or `opus-critic` with the artifact AND codex-critic's verdict for cross-check.",
    "- **Fast sanity check** → `opus-critic` (same lab as lead but fresh context — catches confabulation and motivated reasoning).",
    "",
    "## Decomposition for large artifacts",
    "",
    "Route by the peer's real PROMPT WINDOW (input tokens): `codex-critic` gpt-5.6-sol ≈1M · `opus-critic` Opus-4.7-1M ≈936K (enterprise catalogs; ≈168K otherwise) · `codex-reviewer` gpt-5.3-codex ≈272K · `gemini-critic` gemini-3.1-pro ≈136K. The proxy REJECTS (with an actionable message) any single call whose brief exceeds the target peer's window — it will NOT silently truncate, because dropping lines from a review artifact is worse than a clear error. So: send the full artifact only to peers whose window fits it (large artifacts → `codex-critic` and/or `opus-critic`). When a peer's window is too small (commonly `gemini-critic` at ≈136K, or `codex-reviewer` at ≈272K), do NOT summarize or downsize the request to include it — either skip that peer, or split the artifact into 2-4 logical batches BY CONCERN (not by raw size — semantic batches give better per-batch reviews) that each fit, and call in parallel. Use the big-window peers for the whole and reserve a small-window peer like gemini for the concerns it can actually hold. The proxy's MCP cap allows up to 8 in-flight calls. Aggregate findings yourself before reporting back. (Separately, on the JSON transport a per-effort `predictedTooLong` byte cap still guards the ~60s tools/call timeout for non-SSE clients; Claude Code uses SSE, which streams with heartbeats and isn't subject to that cap.)",
    "",
    "## Aggregation contract",
    "",
    "When fan-out completes, return a SEVERITY-GROUPED, DEDUPLICATED finding list. Format:",
    "",
    "  ## Findings",
    "  ### HIGH",
    "  1. <one-line title> — `<file:line>` — sources: codex-critic, gemini-critic (3-lab confirmed if applicable)",
    "     - bug: <one sentence>",
    "     - mitigation: <one sentence>",
    "  ### MEDIUM",
    "  ...",
    "  ### LOW",
    "  ...",
    "",
    "Cite which peer raised each finding. If two or more peers raised the SAME finding (cross-lab confirmation), call it out — those are the highest-confidence bugs.",
    "",
    "## What NOT to do",
    "",
    "- Do not paraphrase or summarize per-peer verdicts BEFORE aggregating; aggregate from the raw verdicts.",
    "- Do not invent severity labels not present in the source verdicts.",
    "- Do not call peers serially (waste of wall-clock); always fan out in parallel.",
    "- Do not consult yourself — you are the coordinator, not a critic.",
    "",
    "Self-reminder (read before every reply):",
    "  Did I fan out in parallel to the right peers for this artifact type?",
    "  Did I aggregate findings by severity, citing which peer raised each?",
    "  If two peers agreed, did I flag the cross-lab confirmation?",
  ].join("\n")

  return { description, prompt }
}

/**
 * Claude Code's built-in subagents, which the interactive CLI provides natively
 * but the Agent SDK (used by CloudCLI under `serve`) does NOT register — so a
 * serve session shows `Agent type 'Explore' not found`. We re-register them as
 * custom subagents so the model's habitual `Agent(subagent_type:"…")` calls
 * resolve. SERVE-ONLY: never inject these for `github-router claude` (the CLI's
 * native, tuned built-ins would be shadowed by a same-name custom agent).
 *
 * No `tools:` restriction — each inherits the session's full toolset; the role
 * is steered by the prompt (matching the built-ins' behavior without the risk of
 * an over-narrow allowlist). `statusline-setup`/`output-style-setup` are omitted
 * (niche, rarely invoked).
 */
export const BUILTIN_SUBAGENT_DEFINITIONS: PeerAgentDefinitions = {
  "general-purpose": {
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when searching for a keyword or file and you are not confident you will find the right match in the first few tries.",
    prompt:
      "You are a general-purpose agent. Research the question or carry out the multi-step task you are given, using the full toolset (read, search, edit, run commands as needed). Work autonomously and return a single, complete final answer — your final message is the whole result, so include the findings, file paths, and any code the caller needs.",
  },
  Explore: {
    description:
      "Read-only search agent for broad fan-out searches — when answering means sweeping many files or directories and you only need the conclusion, not the file dumps. It locates code; it does not modify it.",
    prompt:
      "You are a read-only exploration agent. Investigate the codebase to answer the question by reading and searching (Read/Glob/Grep and semantic code search); do NOT modify any files, run mutating commands, or make commits. Cast a wide net, then return a concise conclusion with the relevant file paths and line references — your final message is the whole answer.",
  },
  Plan: {
    description:
      "Software architect agent for designing implementation plans. Use when you need to plan the implementation strategy for a task. Returns a step-by-step plan, identifies critical files, and considers architectural trade-offs.",
    prompt:
      "You are a planning agent. Read the codebase (read-only — do not modify files) to design a concrete, ordered implementation plan for the task: the approach, the specific files to change, reuse of existing utilities, risks, and how the result will be verified. Return the plan as your final message.",
  },
}

/**
 * The names of every native subagent this module can emit, current AND retired.
 *
 * This is a NAME REGISTRY for the sweep allowlist in `paths.ts` and its drift
 * test, NOT a list of agents that are guaranteed to exist in a given launch.
 * `scout`, `implementer-fast`, `reviewer-fast`, and `general-purpose-fast` are
 * conditionally emitted (see `buildPeerAgentDefinitions`) yet are listed here on purpose: the sweep must
 * recognize their filenames so a file written by a launch that DID resolve a
 * model gets reaped by a later launch that did not. Do not iterate this
 * expecting a definition back from `buildPeerAgentDefinitions` for every entry;
 * iterate `Object.keys(agents)` for that.
 *
 * Exported so the natives get the same drift protection
 * `ALL_DISPATCHER_AGENT_NAMES` gives the `worker-*` dispatchers — without it, a
 * renamed or newly added native silently escapes the sweep and its stale `.md`
 * files load forever as ghost subagents.
 */
export const ALL_NATIVE_AGENT_NAMES = [
  "implementer",
  "Plan",
  "planner",
  "reviewer",
  "reviewer-fast",
  "brainstorm",
  "scout",
  "Explore",
  "scribe",
  "implementer-fast",
  "general-purpose-fast",
  "critic",
] as const

/** Empty-string-safe read of an optional model id. */
function nonEmptyModel(id: string | undefined): string | undefined {
  return id && id.length > 0 ? id : undefined
}

/**
 * The shared "prefer the dedicated tools over shell" steer, appended to every
 * native subagent prompt. `bashUses` names the work that legitimately belongs in
 * Bash for that agent (`builds` for a coder, `repros` for an investigator), the
 * only token that ever differed across the three hand-copied variants this
 * replaces.
 *
 * Deliberately NOT merged with `FILE_TOOL_GUIDANCE` in
 * `anthropic-translate/anthropic-request.ts`: that one is injected at the shim
 * boundary and therefore only reaches shim-routed (non-Claude) models. When a
 * native falls back to the lead's Claude model the shim is bypassed entirely, so
 * this prompt-level copy is the only coverage that survives. Two layers, two
 * different reasons to exist.
 */
function fileToolSteer(bashUses: string): string {
  return (
    "Use the dedicated Edit/Write/Read tools for file changes and Grep/Glob for search; "
    + `reserve Bash for running ${bashUses}, tests, and git. `
    + "Do not shell out (sed/awk/python/here-docs) to read or edit files."
  )
}

/** The read-only half of `fileToolSteer`, for agents that never write. */
function readOnlyToolSteer(): string {
  return (
    "Use Read to read files and Grep/Glob plus the semantic code search tool to find them; "
    + "Bash is for read-only inspection such as git log, git blame, and git show. "
    + "Do not modify any file, and do not run mutating commands."
  )
}

/**
 * `tools:` allowlist for read-only natives (`scout`, fast `Explore`, `brainstorm`), modelled
 * on Claude Code's own `Explore`/`Plan` built-ins, which run with every tool
 * EXCEPT Agent / Artifact / ExitPlanMode / Edit / Write / NotebookEdit — note
 * that Anthropic's own read-only agent keeps Bash, which is what makes `git log`
 * and `git blame` reachable.
 *
 * Two deliberate deviations, both forced by the frontmatter format:
 *
 *  1. `tools:` is a POSITIVE allowlist with no "all except" form, so the
 *     complement has to be spelled out. Rather than enumerate every harness tool
 *     (which varies by Claude Code version, and would silently drop anything
 *     added later), this lists the read / search / shell core that a read-only
 *     agent actually uses. Tools added by a future release are NOT inherited by
 *     these two agents; that is the price of real enforcement over a prompt that
 *     merely asks nicely.
 *  2. The workers and orchestrate MCP groups are excluded on the same reasoning
 *     that makes `Explore` drop `Agent`: both spawn further agents, so leaving
 *     them in would reintroduce exactly the recursion that exclusion prevents.
 *
 * NOT A SANDBOX. `Bash` is retained because Anthropic's own read-only built-in
 * retains it, and without it an explorer cannot run `git log` / `git blame` /
 * `git show`, which is most of what repository archaeology needs. A shell is a
 * general write primitive, so "read-only" here means the agent has no dedicated
 * mutation tool and is instructed not to mutate, NOT that mutation is
 * impossible. Dropping Edit/Write still removes the path a model reaches for by
 * default. If a future change needs a hard guarantee, this allowlist is not
 * where it can be made.
 *
 * `searchKey` is the RESOLVED group key, not the bare literal: a user-side
 * `mcpServers` collision renames the group (`gh-router-search`, …), and a
 * hardcoded `mcp__search__*` would then grant nothing at all.
 */
function readOnlyToolAllowlist(searchKey: string): Array<string> {
  return [
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "WebFetch",
    "WebSearch",
    `mcp__${searchKey}__*`,
  ]
}

function decorateGuaranteedOneM(id: string): string {
  if (oneMContextDisabled() || /\[1m\]$/i.test(id)) return id
  return `${id}[1m]`
}

/** Build the literal `-m fast` native roster. This is intentionally separate
 * from the standard definitions: the names overlap, but their role bodies,
 * fixed model assignments, and efforts are profile contracts. */
function buildFastProfileAgentDefinitions(opts: BuildOpts): PeerAgentDefinitions {
  const scoutModel = nonEmptyModel(opts.scoutModel)
  const implementerModel = nonEmptyModel(opts.nativeSubagentModel)
  const reviewerModel = nonEmptyModel(opts.reviewerModel)
  const plannerModel = nonEmptyModel(opts.plannerModel)
  const criticModel = nonEmptyModel(opts.criticModel)
  if (!scoutModel || !implementerModel || !reviewerModel || !plannerModel || !criticModel) {
    throw new Error("fast profile requires resolved Explore, implementer, reviewer, Plan, and critic models")
  }

  const searchKey = opts.groupKeys.search ?? GROUP_META.search.preferredKey
  const peersKey = peersKeyOf(opts.groupKeys)
  const searchMcp: { mcpServers?: Record<string, HttpMcpEntry> } = opts.serverUrl
    ? { mcpServers: { [searchKey]: httpEntryFor(opts.serverUrl, "search", opts.nonce, opts.workspaceHeaderCmd) } }
    : {}
  const peersMcp: { mcpServers?: Record<string, HttpMcpEntry> } = opts.serverUrl && opts.groupKeys.peers
    ? { mcpServers: { [peersKey]: httpEntryFor(opts.serverUrl, "peers", opts.nonce, opts.workspaceHeaderCmd) } }
    : {}
  const oracleTool = opts.groupKeys.peers ? `mcp__${peersKey}__oracle` : undefined
  const readSearchTools = ["Read", "Grep", "Glob", "Bash"]
  const scoutTools = [...readSearchTools, `mcp__${searchKey}__*`]
  const reviewerTools = [...scoutTools, ...(oracleTool ? [oracleTool] : [])]
  const plannerTools = [
    ...readSearchTools,
    "WebFetch",
    "WebSearch",
    `mcp__${searchKey}__*`,
    ...(oracleTool ? [oracleTool] : []),
    // Claude Code 2.1.246 exposes the native dispatcher as `Agent`; the
    // historical `Task` spelling remains accepted by the policy hook for
    // older clients but is not emitted as a frontmatter capability.
    "Agent",
  ]

  const reviewerPrompt =
    "You are the fast profile's repository-aware reviewer. Verify what is actually true by reading the code and running the relevant build, tests, or end-to-end reproduction. Find root causes rather than symptoms. Do not modify production code. Report severity-ranked findings with `file:line` evidence and a clear go/no-go. You do not have Advisor; independently reach your verdict from repository evidence. Use Oracle only as a last resort for one precise unresolved question after your own investigation. "
    + fileToolSteer("builds and reproductions")
    + " Do not spawn further agents."
  const criticPrompt =
    "You are the fast profile's fresh-context cross-lab critic. Assess the supplied plan, design, diff, or decision against its stated constraints. Look for overlooked failure modes, unsupported assumptions, and simpler safer alternatives. Do not modify files, run mutating commands, or spawn agents. Return concise severity-ranked findings with `file:line` evidence where applicable. "
    + readOnlyToolSteer()
  const out: PeerAgentDefinitions = {
    Explore: {
      description: `Read-only exploration subagent running ${scoutModel}. Use for broad repository discovery before the lead drafts a plan; return conclusions with file:line evidence, not file dumps.`,
      prompt:
        "Investigate the repository read-only. Cast a wide net, then return a concise evidence packet for the lead: conclusions, load-bearing `file:line` citations, commands checked, and explicit gaps. Do not plan, edit, or spawn agents. "
        + readOnlyToolSteer(),
      tools: scoutTools,
      model: LUNA_SCOUT_ALIAS_ID,
      effort: opts.scoutEffort ?? "high",
      ...searchMcp,
    },
    implementer: {
      description: `Implementation subagent running ${implementerModel}. Use for well-specified mechanical changes after the plan is approved; implement and verify end to end in its own context.`,
      prompt:
        "Implement the approved, well-specified change surgically. Match surrounding style, minimize unrelated churn, use dedicated file tools, and run the relevant build/tests. For verification, you may invoke only the fast-profile `reviewer` or `critic` native subagent; do not invoke any other role or redesign the plan. Report changes, verification, and unresolved risk. "
        + fileToolSteer("builds"),
      model: decorateGuaranteedOneM(LUNA_IMPLEMENTER_ALIAS_ID),
      effort: opts.implementerEffort ?? "max",
    },
    reviewer: {
      description: `Repository-aware reviewer running ${reviewerModel} at medium effort. Use after implementation or for failures that need reproduction, runtime checks, or repository context.`,
      prompt: reviewerPrompt,
      model: reviewerModel,
      effort: opts.reviewerEffort ?? "medium",
      tools: reviewerTools,
      mcpServers: {
        ...(searchMcp.mcpServers ?? {}),
        ...(peersMcp.mcpServers ?? {}),
      },
    },
    critic: {
      description: `Fresh-context cross-lab critic running ${criticModel} at medium effort. Use to challenge a plan, design, diff, or decision against its stated constraints and expose overlooked failure modes.`,
      prompt: criticPrompt,
      model: decorateGuaranteedOneM(FAST_CRITIC_ALIAS_ID),
      effort: opts.criticEffort ?? "medium",
      tools: scoutTools,
      ...searchMcp,
    },
    Plan: {
      description: `Plan consultant and approver running ${plannerModel}. Invoke only after Luna has done the repository legwork and drafted a plan; pass a handcrafted evidence packet and the complete draft. The lead must not implement until this agent returns APPROVE.`,
      prompt:
        "You are the fast profile's final plan consultant and approver, not a first-pass planner. The caller must provide the user goal, acceptance criteria, repository/domain constraints, Luna's `file:line` and command/test evidence, the complete draft plan, settled decisions, and one focused review question. Selectively verify disputed citations or narrow evidence gaps with read/search tools, but do not repeat broad discovery, edit files, or execute the plan. Return exactly one leading verdict: `APPROVE`, `REVISE`, or `NEED_MORE_CONTEXT`. APPROVE only when the plan is safe, ordered, complete, and verifiable. REVISE must give concrete corrections. NEED_MORE_CONTEXT must name the exact evidence Luna should collect. You do not have Advisor; independently reach your verdict from the evidence packet and selective verification. Use Oracle only as a last resort for one precise unresolved question after your own review. The Task/Agent capability is restricted by the fast in-session ACL: you may invoke only `reviewer`, `Explore`, or `critic`; do not invoke any other role. Bash is for evidence commands only; this is not a shell sandbox. "
        + readOnlyToolSteer(),
      tools: plannerTools,
      model: decorateGuaranteedOneM(plannerModel),
      effort: opts.plannerEffort ?? "high",
      mcpServers: {
        ...(searchMcp.mcpServers ?? {}),
        ...(peersMcp.mcpServers ?? {}),
      },
    },
  }
  const roster = opts.nativeRoster == null
    ? new Set(FAST_PROFILE_NATIVE_AGENT_NAMES)
    : opts.nativeRoster instanceof Set
      ? opts.nativeRoster
      : new Set(opts.nativeRoster)
  if (roster) {
    for (const name of Object.keys(out)) {
      if (!roster.has(name)) delete out[name]
    }
  }
  return out
}

/**
 * Build the JSON payload for `claude --agents <path>`.
 *
 * Always includes the read-only personas applicable to the mode (gemini
 * is dropped if absent from the catalog); adds `codex-implementer` only
 * when `codexCli` is true. Always appends the `peer-review-coordinator`
 * meta-subagent — the strongest "use proactively" auto-invocation lever
 * per Phase 2A of the peer-MCP plan.
 */
export function buildPeerAgentDefinitions(
  opts: BuildOpts,
): PeerAgentDefinitions {
  if (opts.fastProfile) return buildFastProfileAgentDefinitions(opts)

  const out: PeerAgentDefinitions = {}
  const personas = opts.fastProfile
    ? []
    : personasFor({
        codexCli: opts.codexCli,
        geminiAvailable: opts.geminiAvailable,
        geminiModel: opts.geminiModel,
        agentAllowlist: opts.personaAllowlist,
      })
  const peersKey = peersKeyOf(opts.groupKeys)
  // Inline the `peers` HTTP server into each peer subagent's frontmatter so it
  // connects directly on spawn — Agent-tool subagents don't reliably inherit
  // the session's HTTP MCP servers (claude-code#30280). Only when `serverUrl`
  // is supplied (the real launch path); omitted in bare unit tests that don't
  // exercise the .md wiring.
  const peersMcp: { mcpServers?: Record<string, HttpMcpEntry> } =
    opts.serverUrl
      ? { mcpServers: { [peersKey]: httpEntryFor(opts.serverUrl, "peers", opts.nonce, opts.workspaceHeaderCmd) } }
      : {}
  for (const persona of personas) {
    out[persona.agentName] = {
      description: persona.description,
      prompt: buildAgentPrompt(persona, { codexCli: opts.codexCli, peersKey }),
      ...peersMcp,
    }
  }
  if (opts.includeCoordinator !== false) {
    out["peer-review-coordinator"] = {
      ...buildCoordinatorAgent({
        codexCli: opts.codexCli,
        geminiAvailable: opts.geminiAvailable,
      }),
      ...peersMcp,
    }
  }
  // Optional hard roster restriction (e.g. the fast profile): a native key
  // absent from this set is never emitted, independent of whether its model
  // resolved. Absent `opts.nativeRoster` → unrestricted, matching every
  // existing caller.
  const rosterSet = opts.nativeRoster == null
    ? undefined
    : opts.nativeRoster instanceof Set
      ? opts.nativeRoster
      : new Set(opts.nativeRoster)
  const rosterAllows = (name: string): boolean => !rosterSet || rosterSet.has(name)
  // The native subagents are ALWAYS injected — no catalog gate. Each runs on the
  // model chosen for its job when that model is live; otherwise its `model`
  // frontmatter is OMITTED and it inherits the lead's model, so a thin catalog
  // degrades the model, never the roster.
  //
  // `scout`, `implementer-fast`, and `general-purpose-fast` are the exceptions.
  // Their entire reason to exist is being cheaper than the lead's model, so
  // silently inheriting Opus would burn exactly the cost they were added to
  // avoid — their resolvers return undefined when nothing in their chain
  // resolves and the agent is then omitted outright.
  //
  // `implementer`, `implementer-fast`, `reviewer`, `scribe`, and
  // `general-purpose-fast` inherit the full toolset (no `tools:`). `scout` and
  // `brainstorm` carry the read-only allowlist.
  const nativeModel = nonEmptyModel(opts.nativeSubagentModel)
  const reviewerModel = nonEmptyModel(opts.reviewerModel)
  const reviewerFastModel = nonEmptyModel(opts.reviewerFastModel)
  const brainstormModel = nonEmptyModel(opts.brainstormModel)
  const scoutModel = nonEmptyModel(opts.scoutModel)
  const scribeModel = nonEmptyModel(opts.scribeModel)
  const implementerFastModel = nonEmptyModel(opts.implementerFastModel)
  const generalPurposeFastModel = nonEmptyModel(opts.generalPurposeFastModel)
  // Whether the sibling escalation targets are actually in this roster — used
  // to strip a description's cross-reference to an agent a restricted profile
  // never emits (e.g. the fast profile has no `implementer`/`reviewer` to
  // "escalate" to).
  const hasImplementer = rosterAllows("implementer")
  const hasReviewer = rosterAllows("reviewer")
  // `[1m]` decorates the FRONTMATTER value only, never the description text.
  // Claude Code budgets a subagent's context off its model id, and its detector
  // (`/\[1m\]/i`) has no vendor gate — so without the suffix an `implementer` on
  // `gpt-5.6-sol` (1,050,000 tokens) runs against a 200K budget. `scout` is now
  // floor-gated to 1M across both of its entries, so every emitted scout id receives
  // the suffix; a model below the floor causes the agent to be dropped instead.
  // Descriptions keep the bare id because that string is prose the lead reads.
  const modelField: { model?: string } =
    nativeModel ? { model: withOneMSuffix(nativeModel) } : {}
  const searchKey = opts.groupKeys.search ?? GROUP_META.search.preferredKey
  // Inline the `search` server for the read-only natives, same claude-code#30280
  // workaround the peers/workers subagents use: without it the allowlisted
  // `mcp__<searchKey>__*` names resolve to nothing on spawn.
  const searchMcp: { mcpServers?: Record<string, HttpMcpEntry> } =
    opts.serverUrl
      ? { mcpServers: { [searchKey]: httpEntryFor(opts.serverUrl, "search", opts.nonce, opts.workspaceHeaderCmd) } }
      : {}
  if (rosterAllows("implementer")) {
    out.implementer = {
      description: nativeModel
        ? `Bounded implementation subagent running ${nativeModel} (strong non-Claude coder, maximum reasoning). Use proactively for coding changes that need judgment or have ambiguous scope — edits, features, fixes — to keep the lead's context focused; use implementer-fast instead for well-specified, mechanical changes. Runs in its own context. Model is overridable at spawn.`
        : `Bounded implementation subagent (native tools, runs on the lead's model in its own context). Use proactively for coding changes that need judgment or have ambiguous scope — edits, features, fixes — to keep the lead's context focused; use implementer-fast instead for well-specified, mechanical changes. Model is overridable at spawn.`,
      prompt:
        "You are a bounded implementation subagent for well-scoped coding tasks. Implement the requested change surgically, matching the surrounding code style and minimizing unrelated churn. "
        + fileToolSteer("builds")
        + " Verify with the project's build or tests where applicable. Do the work yourself — do not spawn further subagents. Report exactly what changed and any risks.",
      ...modelField,
    }
  }
  const reviewerPrompt =
    "You are a feedback subagent. Your job is to tell the caller what is actually true about the artifact you are given — code, a plan, a document, a failure report — and what is wrong with it. "
    + "Verify against the ACTUAL code by reading it; never assume. Do whatever the assessment requires: reproduce a failure end to end as close to how a real user hits it as you can, form hypotheses and test them against the code and runtime, and isolate the true root cause rather than a symptom. "
    + "Where the change warrants it, author tests that try to BREAK the implementation (edge cases, error paths, and the acceptance criteria as executable checks), run them, and report which pass and which fail; do NOT modify production code just to make tests pass. "
    + fileToolSteer("builds")
    + " Do the work yourself — do not spawn further subagents. Report severity-ranked findings with `file:line` citations, the evidence behind each, and end with a clear go/no-go."
  if (rosterAllows("reviewer")) {
    out.reviewer = {
      description: reviewerModel
        ? `Feedback subagent running ${reviewerModel}, a DIFFERENT lab from both the lead and the implementer, so its blind spots are decorrelated from whoever produced the work. Use proactively when something already exists and you want it assessed: a diff, a plan, a document, a failing test. Unlike the stateless peer critics, it reads the repo and can RUN things, so prefer it whenever the assessment needs execution or repo context (reproduce a failure, run the suite, bisect); prefer a peer critic when you already hold the artifact and want a fresh-context opinion on it. It can also REVIEW SCREENSHOTS and other images: just point it at the file and it will look at them. Model is overridable at spawn.`
        : `Feedback subagent (native tools, runs on the lead's model in its own context). Use proactively when something already exists and you want it assessed: a diff, a plan, a document, a failing test. Unlike the stateless peer critics, it reads the repo and can RUN things, so prefer it whenever the assessment needs execution or repo context; prefer a peer critic when you already hold the artifact and want a fresh-context opinion on it. Model is overridable at spawn.`,
      prompt: reviewerPrompt,
      ...(reviewerModel ? { model: withOneMSuffix(reviewerModel) } : {}),
    }
  }
  if (reviewerFastModel && rosterAllows("reviewer-fast")) {
    const isGrok = reviewerFastModel === "grok-4.6"
    const windowClause = isGrok
      ? "500K total context, 372K max prompt"
      : "1M context"
    const speedClause = isGrok ? "" : ", typically faster than the pro-tier reviewer"
    const crossLabClause = !isGrok && hasImplementer
      ? " and cross-lab from the OpenAI-backed implementer"
      : ""
    const bodyClause = hasReviewer
      ? "Use for lower-stakes assessments that still need repository access or execution; escalate higher-stakes review to reviewer."
      : "Use for lower-stakes assessments that still need repository access or execution."
    out["reviewer-fast"] = {
      description: `Cheaper feedback subagent running ${reviewerFastModel} (${windowClause}${speedClause}${crossLabClause}). ${bodyClause} Full toolset, so it can read the repo and run builds, tests, and reproductions in its own context. Model is overridable at spawn.`,
      prompt: reviewerPrompt,
      model: withOneMSuffix(reviewerFastModel),
      ...(opts.reviewerFastEffort ? { effort: opts.reviewerFastEffort } : {}),
    }
  }
  if (rosterAllows("brainstorm")) {
    out.brainstorm = {
      description: brainstormModel
        ? `Divergent-options subagent running ${brainstormModel} (third lab, for approaches the lead would not generate). Use proactively BEFORE an approach is chosen. Pass the decision, the constraints, what you have already ruled out, and the cost of being wrong; pass your current leading approach too if you have one, and it will try to beat it rather than restate it. Read-only; it proposes, then hands off to implementer. Model is overridable at spawn.`
        : `Divergent-options subagent (runs on the lead's model in its own context). Use proactively BEFORE an approach is chosen. Pass the decision, the constraints, what you have already ruled out, and the cost of being wrong; pass your current leading approach too if you have one, and it will try to beat it rather than restate it. Read-only; it proposes, then hands off to implementer. Model is overridable at spawn.`,
      prompt:
        "You are a divergent-options subagent: the lead's sounding board while an approach is still open. Your job is to surface the option the lead would not have reached on its own. "
        // Two modes, chosen by what the caller passes. A single pass cannot be
        // both independent of an incumbent and comparative against one, since the
        // model attends to the whole brief either way; so the modes are staged
        // ACROSS calls, the same shape `stand_in` uses for its blind round 1 then
        // informed round 2.
        + "If the caller states its current leading approach, your job is to try to beat it, and you close with one verdict: `replace`, `retain`, or `insufficient evidence`. "
        + "`replace` requires naming a concrete alternative that dominates it and the evidence that decides between them. `retain` is a real answer and a useful one: say it plainly when the approach survives a genuine attempt to beat it. "
        // Calibration, matching CRITIC_RUBRIC's existing stance. Reflexive dissent
        // is not skepticism; published work gets >99% disagreement from explicit
        // devil's-advocate framing, which measures compliance, not judgment.
        + "Manufactured disagreement is as useless as agreement; do neither. If the caller states no leading approach, generate independently and let the lead compare. "
        + "Return 3 to 5 approaches that differ in MECHANISM, not in phrasing. For each: how it works, what it costs, what would have to be true for it to be the right answer, and the failure mode that would kill it. "
        + "Near-duplicate options are the failure mode to avoid — if only one real approach exists, say so plainly and explain why the alternatives are dead, because one honest option beats four padded ones. "
        // The one defect that reproduced across observed runs: sound mechanism,
        // unexecutable concrete path. Screening only the winner is also
        // selection-biased, hiding candidates that should have ranked higher.
        + "Screen EVERY candidate against this repository and this environment before you rank them, then verify the one you are about to recommend can actually run here: read the code path it depends on, the guard that would refuse it, the artifact it assumes exists. "
        + "A recommendation that cannot execute is worse than no recommendation. If checking kills your front-runner, rerank and say so. "
        + "Ground every option in what the repository actually contains, and prefer reusing what is already there over inventing something new. "
        + readOnlyToolSteer()
        + " Do the work yourself — do not spawn further subagents.",
      tools: readOnlyToolAllowlist(searchKey),
      ...(brainstormModel ? { model: withOneMSuffix(brainstormModel) } : {}),
      ...searchMcp,
    }
  }
  if (scoutModel && rosterAllows("scout")) {
    out.scout = {
      description: `Read-only exploration subagent running ${scoutModel} (fast and cheap, so repository lookups do not run at the lead's model rates). Use proactively to find or understand something in the codebase: it sweeps widely and returns conclusions with file:line references rather than file dumps. Model is overridable at spawn.`,
      prompt:
        "You are a read-only exploration subagent. Answer the question by investigating the repository: cast a wide net, then narrow. "
        + "Return the conclusion, not the raw material — cite `file:line` for anything load-bearing and quote only the lines that matter. If the answer is that something does not exist, say so explicitly and describe where you looked. "
        + readOnlyToolSteer()
        + " Do the work yourself — do not spawn further subagents.",
      tools: readOnlyToolAllowlist(searchKey),
      model: withOneMSuffix(scoutModel),
      ...(opts.scoutEffort ? { effort: opts.scoutEffort } : {}),
      ...searchMcp,
    }
  }
  if (rosterAllows("scribe")) {
    out.scribe = {
      description: scribeModel
        ? `Documentation subagent running ${scribeModel} (the mid tier: documentation is verifiable prose, not frontier reasoning). Use proactively for prose that trails the code: docs, ADRs, CLAUDE.md sections, changelog entries, and README updates that have gone stale. Keeps low-glamour upkeep off the lead's context. Model is overridable at spawn.`
        : `Documentation subagent (runs on the lead's model in its own context). Use proactively for prose that trails the code: docs, ADRs, CLAUDE.md sections, changelog entries, and README updates that have gone stale. Model is overridable at spawn.`,
      prompt:
        "You are a documentation subagent. Write and maintain the prose that trails the code: docs, ADRs, CLAUDE.md sections, changelog entries, README rows. "
        + "Read the code before describing it — every claim you write must be checkable against the repository as it is now, not as a summary said it was. Match the surrounding document's voice, structure, and level of detail. "
        + "Prefer updating an existing document over adding a new one, and delete what has become false rather than layering a correction on top of it. "
        + fileToolSteer("builds")
        + " Do the work yourself — do not spawn further subagents. Report which documents changed and any claim you could not verify.",
      ...(scribeModel ? { model: withOneMSuffix(scribeModel) } : {}),
    }
  }
  // `implementer-fast` is the cheaper implementation specialist;
  // `general-purpose-fast` is the catch-all for work no specialist fits.
  //
  // Description discipline: a description may claim only what is true of EVERY
  // member of that agent's chain, because the fallback is invisible to whoever
  // reads the prose. `implementer-fast` therefore branches its model-specific
  // framing: terra may carry the speed/cost claim, luna (the fast profile's
  // single-entry pin) names the profile explicitly, while the gemini-pro
  // fallback is described neutrally and may not claim terra's `max` effort
  // tier. `general-purpose-fast` is single-entry, so it may state luna's
  // measured and catalog properties exactly.
  const genericPromptFor = (role: string): string =>
    `You are a general-purpose subagent handling ${role} the lead has delegated to keep its own context free. `
    + "Work out what the task actually requires, then do it end to end. Verify against the real repository and the real runtime rather than assuming — read the code, run the command, check the exit code. "
    + fileToolSteer("builds")
    + " Do the work yourself — do not spawn further subagents. Report what you did, what you verified, and anything you could not settle."
  if (implementerFastModel && rosterAllows("implementer-fast")) {
    const tierDescription = implementerFastModel === "gpt-5.6-terra"
      ? "the cheaper, faster implementation tier"
      : implementerFastModel === "gpt-5.6-luna"
        ? "the fast, low-cost tier for this launch profile"
        : "a non-lead implementation model"
    const escalateClause = hasImplementer
      ? "; use implementer instead when the change needs judgment or its scope is ambiguous"
      : ""
    out["implementer-fast"] = {
      description: `Implementation subagent running ${implementerFastModel} (1M context, ${tierDescription}). Use proactively for well-specified, mechanical coding changes${escalateClause}. Full toolset, so it can implement and verify the change end to end in its own context. Model is overridable at spawn.`,
      prompt: genericPromptFor("a well-specified, mechanical coding change"),
      model: withOneMSuffix(implementerFastModel),
      ...(opts.implementerFastEffort ? { effort: opts.implementerFastEffort } : {}),
    }
  }
  if (generalPurposeFastModel && rosterAllows("general-purpose-fast")) {
    out["general-purpose-fast"] = {
      description: `Catch-all subagent running ${generalPurposeFastModel} (1.05M context, the lowest-cost model in the catalog and the fastest measured catch-all candidate, with the full reasoning-effort ladder). Use proactively for work no specialist fits when a fast, economical non-lead model can finish it. Full toolset, so it can complete the work rather than only research it. Runs in its own context. Model is overridable at spawn.`,
      prompt: genericPromptFor("work no specialist fits"),
      model: withOneMSuffix(generalPurposeFastModel),
    }
  }
  // Non-blocking workers surface: one `worker-<mode>` DISPATCHER subagent per
  // active worker tool. Each is pinned by a `tools:` allowlist to the workers
  // server only (`mcp__<workersKey>__*`), so it can run the worker and relay
  // the result but has NO Agent/Read/Bash — it cannot spawn further agents
  // (no recursion) or do extra work; its prompt narrows it to the one mode.
  // The lead runs these in the background and is notified on completion, so a
  // long-running (up to 6h) worker never blocks the main turn. Gated on
  // `workerToolsAvailable`
  // (core modes) and `browseAvailable` (the extra `worker-browse`).
  if (opts.workerToolsAvailable) {
    const workersKey = workersKeyOf(opts.groupKeys)
    // Inline the `workers` HTTP server so the dispatcher connects on spawn
    // (claude-code#30280 — inherited HTTP MCP servers don't reach Agent-tool
    // subagents, which is why the raw worker tool showed "No such tool
    // available"). The `tools:` allowlist still restricts it to that one server.
    const workersMcp: { mcpServers?: Record<string, HttpMcpEntry> } =
      opts.serverUrl
        ? { mcpServers: { [workersKey]: httpEntryFor(opts.serverUrl, "workers", opts.nonce, opts.workspaceHeaderCmd) } }
        : {}
    for (const mode of activeDispatchModes({ browse: opts.browseAvailable === true })) {
      out[dispatcherAgentName(mode)] = {
        description: dispatcherDescription(mode),
        prompt: dispatcherPrompt(mode, workersKey),
        tools: dispatcherTools(mode, workersKey),
        ...workersMcp,
      }
    }
  }
  return out
}

export interface PeerMcpRuntimeFiles {
  mcpConfigPath: string
  agentsPath: string
  /** .md subagent files written into ~/.claude/agents/ (Phase 2.5). The
   *  `--agents` JSON path is silently ignored by Claude Code v2.1.138's
   *  Task `subagent_type` enum (the JSON's subagents are only reachable
   *  via natural-language delegation). The .md files in the canonical
   *  agents directory ARE picked up by the enum, making the
   *  peer-review-coordinator + persona subagents directly invokable. */
  agentMdPaths: Array<string>
  nonce: string
  personas: Array<PersonaSpec>
  cleanup: () => Promise<void>
}

interface WriteOpts {
  codexCli: boolean
  /** Stable invocation baked into persisted headersHelper commands. */
  selfInvocation: SelfInvocation
  geminiAvailable: boolean
  /** Preferred Gemini persona model resolved from the live catalog. */
  geminiModel?: string
  /** Resolved config keys per enabled group (from `resolveGroupKeysFromMirror`).
   *  Threaded into both the --mcp-config payload and the persona .md routing
   *  strings so every reference points at OUR server even after a collision
   *  fallback. */
  groupKeys: ResolvedGroupKeys
  /** Whether the core worker tools are served — generates the `worker-*`
   *  dispatcher subagents. */
  workerToolsAvailable?: boolean
  /** Whether the browse worker tool is served — adds the `worker-browse`
   *  dispatcher. */
  browseAvailable?: boolean
  /** Model for the native subagents that want the OpenAI frontier coder
   *  (`implementer`, `reviewer`) when present in the live catalog. */
  nativeSubagentModel?: string
  /** Model for `reviewer`. Cross-lab from `implementer` by design. */
  reviewerModel?: string
  /** Model for `reviewer-fast`. Absent → the agent is omitted entirely. */
  reviewerFastModel?: string
  /** Model for `brainstorm`. Absent → inherits the lead's model. */
  brainstormModel?: string
  /** Model for `scout`. Absent → the agent is omitted entirely. */
  scoutModel?: string
  /** Model for `scribe`. Absent → inherits the lead's model. */
  scribeModel?: string
  /** Model for `implementer-fast`. Absent → the agent is omitted entirely. */
  implementerFastModel?: string
  /** Model for `general-purpose-fast`. Absent → the agent is omitted entirely. */
  generalPurposeFastModel?: string
  /** Optional hard roster restriction, by native agent key. See the matching
   *  field on `BuildOpts`. */
  nativeRoster?: ReadonlySet<string> | ReadonlyArray<string>
  /** Optional persona allowlist, by `agentName`. See the matching field on
   *  `BuildOpts`. */
  personaAllowlist?: ReadonlySet<string> | ReadonlyArray<string>
  /** Whether to emit `peer-review-coordinator`. Default true. */
  includeCoordinator?: boolean
  /** Fixed `effort:` frontmatter overrides. See the matching fields on
   *  `BuildOpts`. */
  scoutEffort?: SubagentEffort
  implementerFastEffort?: SubagentEffort
  reviewerFastEffort?: SubagentEffort
  fastProfile?: boolean
  plannerModel?: string
  implementerEffort?: SubagentEffort
  reviewerEffort?: SubagentEffort
  plannerEffort?: SubagentEffort
  criticEffort?: SubagentEffort
  /** Resolved fast native critic model. */
  criticModel?: string
  /** Extra subagent definitions to register alongside the peer/worker agents
   *  (written as `.md` files so they appear in the Task `subagent_type` enum).
   *  Used by `serve` to inject Claude Code's built-in subagents (Explore/Plan/
   *  general-purpose) that the Agent SDK does NOT register — see
   *  BUILTIN_SUBAGENT_DEFINITIONS. Must NOT be passed for `github-router claude`,
   *  where the CLI provides those built-ins natively (same-name would shadow). */
  builtinSubagents?: PeerAgentDefinitions
  /** Override for tests. Defaults to PATHS.CODEX_HOME. */
  codexHome?: string
  /** Override for tests. Defaults to PATHS.CLAUDE_RUNTIME_DIR. */
  runtimeDir?: string
  /** Override for tests. Defaults to a fresh 32-byte hex nonce. */
  nonce?: string
  /** Override for tests. Defaults to ~/.claude/agents (where Claude Code
   *  reads subagent .md files at session start). */
  agentsDir?: string
}

/**
 * Default location Claude Code reads subagent .md files from at session
 * startup. Files placed here populate the Task `subagent_type` enum.
 *
 * We point at the router-owned `PATHS.CLAUDE_CONFIG_DIR/agents/` because
 * `getClaudeCodeEnvVars` sets `CLAUDE_CONFIG_DIR=PATHS.CLAUDE_CONFIG_DIR`
 * (the snapshot-mirror substrate fix that gives spawned teammates an
 * authenticatable on-disk credential). The user's own custom-agent .md
 * files were copied into this same dir by `ensureClaudeConfigMirror`,
 * so writing peer-* files here doesn't conflict — and the boot-time
 * sweep is scoped to peer-* names only via the persona-name allowlist.
 */
function defaultAgentsDir(): string {
  return path.join(PATHS.CLAUDE_CONFIG_DIR, "agents")
}

/**
 * YAML frontmatter string-escape — sufficient for our use case where
 * descriptions can contain colons, quotes, newlines. Wraps the value
 * in double-quotes and escapes:
 *   - `\` and `"` (canonical YAML)
 *   - `\n`, `\r`, `\t` (whitespace controls — `\r` matters on Windows-edited
 *     literals; strict YAML 1.2 parsers reject raw `\r` in double-quoted
 *     scalars)
 *   - other C0 control chars (\x00-\x08, \x0B, \x0C, \x0E-\x1F) and
 *     DEL (\x7F) — encoded as `\xNN` so the YAML stays valid even if
 *     a future description sources data from an external file
 *
 * NOT a general-purpose YAML serializer; we control the inputs.
 */
function escapeYamlString(s: string): string {
  return (
    `"${
      s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        // The point of this regex IS to match control characters so we
        // can replace them with safe `\xNN` escapes — the lint rule's
        // concern (accidental control-char in regex) doesn't apply here.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) =>
          `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
        )
    }"`
  )
}

/**
 * Strict allowlist for subagent names — controls both the YAML
 * frontmatter `name:` field AND the filename suffix. Defense-in-depth:
 * even if a future contributor wires in a dynamic agent name from
 * outside, the validator at the top of `writePeerAgentMdFiles` rejects
 * anything that wouldn't be a safe bare YAML scalar AND a safe path
 * component.
 */
const VALID_AGENT_NAME = /^[A-Za-z][A-Za-z0-9-]*$/

/**
 * Emit the subagent-frontmatter `mcpServers` block as a YAML sequence of
 * single-key maps (the INLINE form that connects on subagent start — a bare
 * name-reference would re-trigger claude-code#30280). Scalars are
 * JSON.stringify-quoted, which is valid YAML double-quoted syntax (handles the
 * Windows-path/backslash headersHelper command safely).
 *
 * ```yaml
 * mcpServers:
 *   - workers:
 *       type: http
 *       url: "http://127.0.0.1:PORT/mcp/workers"
 *       headers:
 *         Authorization: "Bearer <nonce>"
 *       headersHelper: "<cmd>"
 * ```
 */
function emitMcpServersYaml(mcpServers: Record<string, HttpMcpEntry>): Array<string> {
  const lines: Array<string> = ["mcpServers:"]
  for (const [key, entry] of Object.entries(mcpServers)) {
    lines.push(`  - ${JSON.stringify(key)}:`)
    lines.push(`      type: ${JSON.stringify(entry.type)}`)
    lines.push(`      url: ${JSON.stringify(entry.url)}`)
    lines.push(`      headers:`)
    for (const [hk, hv] of Object.entries(entry.headers)) {
      lines.push(`        ${JSON.stringify(hk)}: ${JSON.stringify(hv)}`)
    }
    if (entry.headersHelper !== undefined) {
      lines.push(`      headersHelper: ${JSON.stringify(entry.headersHelper)}`)
    }
  }
  return lines
}

/** Build a single subagent .md file body (frontmatter + system prompt).
 *
 * `tools` (optional) becomes a `tools:` frontmatter allowlist RESTRICTING the
 * subagent to exactly those tools (omission inherits the parent's full toolset,
 * per Claude Code semantics). Used by the `worker-*` dispatchers to pin each to
 * its single `mcp__<workersKey>__<mode>` tool — which physically prevents them
 * from spawning other agents or doing extra work. `mcpServers` (optional) is
 * emitted as an inline `mcpServers` frontmatter list so the subagent connects
 * directly to its scoped MCP server(s) — a workaround for claude-code#30280
 * (Agent-tool subagents don't reliably inherit the session's HTTP MCP servers).
 * Names are validated by the caller (`writePeerAgentMdFiles`) / are
 * proxy-generated, so no escaping needed beyond the comma-join Claude Code's
 * frontmatter parser expects. */
export function buildAgentMd(spec: {
  name: string
  description: string
  prompt: string
  model?: string
  effort?: SubagentEffort
  tools?: ReadonlyArray<string>
  mcpServers?: Record<string, HttpMcpEntry>
}): string {
  const lines = [
    "---",
    `name: ${spec.name}`,
    `description: ${escapeYamlString(spec.description)}`,
  ]
  if (spec.model) {
    lines.push(`model: ${escapeYamlString(spec.model)}`)
  }
  if (spec.effort) {
    lines.push(`effort: ${escapeYamlString(spec.effort)}`)
  }
  if (spec.tools && spec.tools.length > 0) {
    // YAML flow array of quoted strings — matches how Claude Code's loader
    // parses `tools:` (an array), and quoting keeps the `mcp__…__*` wildcard
    // a plain string (the `*` is never mistaken for a YAML alias).
    lines.push(`tools: [${spec.tools.map((t) => JSON.stringify(t)).join(", ")}]`)
  }
  if (spec.mcpServers && Object.keys(spec.mcpServers).length > 0) {
    lines.push(...emitMcpServersYaml(spec.mcpServers))
  }
  lines.push("---", "", spec.prompt, "")
  return lines.join("\n")
}

/**
 * Write per-launch subagent .md files into the user's `~/.claude/agents/`
 * directory so they appear in Claude Code's Task `subagent_type` enum
 * (which `--agents` JSON files do NOT, per claude-code-guide expert).
 *
 * Filenames follow `peer-<pid>-<rand>-<agentName>.md` so the boot-time
 * sweep (`sweepStalePeerAgentMdFiles` in paths.ts) can drop orphans
 * from crashed prior proxy sessions without touching the user's other
 * `.claude/agents/` files. The `name:` field in the frontmatter is the
 * canonical agent identifier — matching across files would cause Claude
 * Code to (un)deterministically pick one, so concurrent proxies running
 * the same agents need different filenames but resolve to the same
 * agent name (intended — they're the same subagent, just registered
 * twice).
 *
 * Returns the file paths plus a cleanup() that unlinks them.
 */
export async function writePeerAgentMdFiles(
  agents: Record<string, PeerAgentDefinition>,
  opts: { agentsDir?: string; fileSuffix: string },
): Promise<{ paths: Array<string>; cleanup: () => Promise<void> }> {
  // Validate every agent name BEFORE touching the filesystem. Defense-
  // in-depth against a future contributor wiring in a dynamic name from
  // outside (--agent flag, MCP tool registration, etc.). Names appear
  // in BOTH the filename (path-traversal vector if unvalidated) and the
  // YAML frontmatter `name:` field (parser-confusion if it contains
  // YAML indicator chars). The strict regex matches only safe identifiers
  // made of letters, digits, and hyphens — every current persona/coordinator
  // name passes, including the capitalized fast-profile `Plan`.
  for (const name of Object.keys(agents)) {
    if (!VALID_AGENT_NAME.test(name)) {
      throw new Error(
        `writePeerAgentMdFiles: invalid agent name ${JSON.stringify(name)} — `
          + `must match ${VALID_AGENT_NAME.source}`,
      )
    }
  }
  const dir = opts.agentsDir ?? defaultAgentsDir()
  await fs.mkdir(dir, { recursive: true })
  const paths: Array<string> = []
  try {
    for (const [name, def] of Object.entries(agents)) {
      const filePath = path.join(dir, `peer-${opts.fileSuffix}-${name}.md`)
      // Same idempotency pattern as the JSON tempfiles: unlink first so
      // O_EXCL succeeds even if a same-suffix file somehow survived.
      await fs.unlink(filePath).catch(() => {})
      await writeRuntimeFileSecure(
        filePath,
        buildAgentMd({
          name,
          description: def.description,
          prompt: def.prompt,
          model: def.model,
          effort: def.effort,
          tools: def.tools,
          mcpServers: def.mcpServers,
        }),
      )
      paths.push(filePath)
    }
  } catch (err) {
    // Partial-failure cleanup: if iteration N fails (disk full, EPERM,
    // EEXIST race), the N-1 successfully-written files would otherwise
    // be orphans the caller has no handle to. Unlink the partials before
    // re-throwing so the boot sweep doesn't have to deal with them.
    await Promise.allSettled(paths.map((p) => fs.unlink(p)))
    throw err
  }
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(paths.map((p) => fs.unlink(p)))
  }
  return { paths, cleanup }
}

export type InjectPeerMcpResult =
  | { ok: true; serversAdded: ReadonlyArray<string> }
  | {
      ok: false
      reason: "user-has-conflicting-entry"
      conflictingServers: ReadonlyArray<string>
    }

interface InjectOpts {
  codexCli: boolean
  /** Stable invocation baked into persisted headersHelper commands. */
  selfInvocation: SelfInvocation
  geminiAvailable: boolean
  /** Resolved config keys per enabled group (from `resolveGroupKeysFromMirror`).
   *  Collision-free by construction, so the merge below never overwrites a
   *  user entry. */
  groupKeys: ResolvedGroupKeys
  /** Per-launch nonce — must match what writePeerMcpRuntimeFiles wrote
   *  so the proxy's /mcp Authorization check passes. */
  nonce: string
  /** Override for tests. Defaults to PATHS.CODEX_HOME. */
  codexHome?: string
  /** Override for tests. Defaults to PATHS.CLAUDE_CONFIG_DIR (per-launch). */
  claudeConfigDir?: string
}

/**
 * Read just the `mcpServers` object from a mirrored `.claude.json` (or `{}`
 * on missing / malformed). Used by `resolveGroupKeysFromMirror` to detect
 * which of our bare group keys would collide with a user-side entry.
 */
async function readMcpServersSnapshot(
  target: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const servers = (parsed as Record<string, unknown>).mcpServers
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        return servers as Record<string, unknown>
      }
    }
  } catch {
    // Missing / unparsable → treat as no existing servers (a fresh mirror).
  }
  return {}
}

/**
 * Resolve a config-entry key for each enabled group, defending against
 * collisions with the user's own `mcpServers`. Prefer the bare key
 * (`peers`/`search`/…); on collision walk the numbered fallback sequence
 * `gh-router-<group>`, `gh-router-<group>-2`, `gh-router-<group>-3`, …
 * until a free name is found. This NEVER skips and NEVER returns a name the
 * user already owns: every enabled group is guaranteed a key WE control, so
 * a capability is never silently dropped AND the model is never routed at
 * the user's same-named server (the caller threads these resolved keys into
 * both the `mcpServers` entries AND the persona `.md` routing strings). The
 * `skipped` field is retained for API stability but is always empty now.
 *
 * Reads the mirror snapshot once; the caller passes the result to BOTH
 * `writePeerMcpRuntimeFiles` and `injectPeerMcpIntoMirror`. The mirror is a
 * per-launch dir written ONLY by us (after `ensureClaudeConfigMirror`
 * snapshotted the user's config) and nothing mutates it between this read
 * and `injectPeerMcpIntoMirror`'s write, so the two reads see identical
 * state — no TOCTOU window, and the inject-side defensive conflict check
 * never fires for these resolved keys.
 */
export async function resolveGroupKeysFromMirror(
  enabledGroups: ReadonlyArray<McpGroup>,
  claudeConfigDir?: string,
): Promise<{ keys: ResolvedGroupKeys; skipped: Array<McpGroup> }> {
  const dir = claudeConfigDir ?? PATHS.CLAUDE_CONFIG_DIR
  const existing = await readMcpServersSnapshot(path.join(dir, ".claude.json"))
  const keys: ResolvedGroupKeys = {}
  for (const group of enabledGroups) {
    const bare = GROUP_META[group].preferredKey
    if (existing[bare] === undefined) {
      keys[group] = bare
      continue
    }
    // Bare key taken — walk the prefixed sequence until a free name.
    let candidate = `gh-router-${group}`
    let n = 1
    while (existing[candidate] !== undefined) {
      n += 1
      candidate = `gh-router-${group}-${n}`
    }
    keys[group] = candidate
  }
  return { keys, skipped: [] }
}

/**
 * Mutate the mirrored `<CLAUDE_CONFIG_DIR>/.claude.json` to add the
 * `gh-router-peers` entry (and `codex-cli` when enabled) under
 * `mcpServers`. This is the load-bearing fix for subagent MCP visibility.
 *
 * Subagents — Agent-tool subagents, forks, and agent-teams subprocesses
 * — discover MCP servers from persistent scopes (`.claude.json` and
 * project-scope `.mcp.json`), NOT from the parent's `--mcp-config` CLI
 * flag. Writing into the per-launch mirror's `.claude.json` makes the
 * MCP entry visible to subagents transparently: they inherit
 * `CLAUDE_CONFIG_DIR` from the parent's env, so they read the same
 * config file we just mutated.
 *
 * Safety:
 *   - Refuses to overwrite a same-named user-side entry (the snapshot
 *     copied their `.claude.json` first, so an existing entry would
 *     belong to the user). Returns `{ ok: false }` so the caller can
 *     fall back to leaving `--mcp-config` in place for the parent.
 *   - Preserves all other top-level fields and other `mcpServers`
 *     entries.
 *   - Atomic write: temp-file with `wx` (`O_CREAT | O_EXCL`) followed by
 *     `rename`, mirroring the synthetic-credentials write pattern in
 *     `ensureClaudeConfigMirror`. Mode 0o600. The per-launch
 *     `CLAUDE_CONFIG_DIR` means there are no cross-launch racers.
 */
export async function injectPeerMcpIntoMirror(
  serverUrl: string,
  opts: InjectOpts,
): Promise<InjectPeerMcpResult> {
  const dir = opts.claudeConfigDir ?? PATHS.CLAUDE_CONFIG_DIR
  const target = path.join(dir, ".claude.json")

  // 1. Read existing snapshot (or {} if missing / malformed). We do NOT
  //    fail loudly on parse error — start fresh and let the proxy
  //    session run. Logging the warn surfaces the underlying corruption
  //    for the user to investigate.
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(target, "utf8")
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      } else {
        consola.warn(
          `injectPeerMcpIntoMirror: ${target} parsed to non-object `
            + `(typeof=${typeof parsed}); discarding contents and starting fresh.`,
        )
      }
    } catch (err) {
      consola.warn(
        `injectPeerMcpIntoMirror: cannot parse ${target} as JSON; `
          + `starting fresh (existing contents will be overwritten):`,
        err,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug(
        `injectPeerMcpIntoMirror: cannot read ${target}:`,
        err,
      )
    }
    // Either ENOENT (first-ever launch, no user .claude.json) or some
    // other read error. Either way, start fresh.
  }

  // 2. Normalize `mcpServers` to an object (clobber if user had it set
  //    to a non-object value — that's already broken; our overwrite
  //    won't make it worse and the warn flags it).
  let mcpServers: Record<string, unknown>
  const rawServers = existing.mcpServers
  if (
    rawServers !== undefined
    && rawServers !== null
    && typeof rawServers === "object"
    && !Array.isArray(rawServers)
  ) {
    mcpServers = rawServers as Record<string, unknown>
  } else {
    if (rawServers !== undefined && rawServers !== null) {
      consola.warn(
        `injectPeerMcpIntoMirror: mcpServers field in ${target} is not an `
          + `object (typeof=${typeof rawServers}); replacing with our entry.`,
      )
    }
    mcpServers = {}
  }

  // 3. Build our desired entries from the SAME builder used for
  //    --mcp-config so the two channels never drift. Keys are pre-resolved
  //    (collision-free) by `resolveGroupKeysFromMirror`.
  const peerConfig = buildPeerMcpConfig(serverUrl, {
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    groupKeys: opts.groupKeys,
    nonce: opts.nonce,
    codexHome: opts.codexHome ?? PATHS.CODEX_HOME,
    workspaceHeaderCmd: buildWorkspaceHeaderHelperCommand(opts.selfInvocation),
  })

  // 4. Defensive: the resolved keys are collision-free by construction, so
  //    this should never fire. If it somehow does (a racing mutation of the
  //    mirror between resolution and now), refuse to overwrite the user's
  //    entry and let the caller fall back to --mcp-config (parent-only).
  const conflicts: Array<string> = []
  for (const name of Object.keys(peerConfig.mcpServers)) {
    if (mcpServers[name] !== undefined) conflicts.push(name)
  }
  if (conflicts.length > 0) {
    consola.warn(
      `injectPeerMcpIntoMirror: your ~/.claude/.claude.json already has `
        + `mcpServers entries named [${conflicts.join(", ")}]; refusing to `
        + `overwrite. Subagents will not see those tools — only the parent `
        + `session via --mcp-config fallback. To resolve, rename the `
        + `user-side server(s) (e.g. via \`claude mcp remove\`) and relaunch.`,
    )
    return {
      ok: false,
      reason: "user-has-conflicting-entry",
      conflictingServers: conflicts,
    }
  }

  // 5. Merge our entries; preserve everything else.
  for (const [name, entry] of Object.entries(peerConfig.mcpServers)) {
    mcpServers[name] = entry
  }
  existing.mcpServers = mcpServers

  // 6. Atomic temp+rename. Same pattern as the synthetic .credentials.json
  //    write in ensureClaudeConfigMirror. Per-launch dir means there are
  //    no cross-launch racers; EEXIST on the tempfile is essentially
  //    impossible (per-pid + 8-hex random). Mode 0o600 to match the
  //    upstream Claude Code file perms.
  const desiredJson = JSON.stringify(existing, null, 2) + "\n"
  await fs.mkdir(dir, { recursive: true })
  const tempPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, desiredJson, { mode: 0o600, flag: "wx" })
    await fs.rename(tempPath, target)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }

  return { ok: true, serversAdded: Object.keys(peerConfig.mcpServers) }
}

/**
 * Generate a per-launch nonce, write the MCP config + agents JSON
 * tempfiles under `CLAUDE_RUNTIME_DIR` with mode 0o600 and `O_EXCL`,
 * and return a `cleanup()` to unlink them on shutdown.
 *
 * Filenames are `peer-mcp-<pid>-<rand>.json` and `peer-agents-<pid>-<rand>.json`.
 * The PID prefix is what the boot-time sweep (`sweepStaleRuntimeFiles` in
 * paths.ts) keys off to drop orphans from crashed prior sessions; the
 * random suffix prevents two concurrent calls within the same process
 * from clobbering each other's files (e.g., a proxy that internally
 * relaunches its spawned child without restarting itself).
 */
export async function writePeerMcpRuntimeFiles(
  serverUrl: string,
  opts: WriteOpts,
): Promise<PeerMcpRuntimeFiles> {
  const nonce = opts.nonce ?? randomBytes(32).toString("hex")
  const runtimeDir = opts.runtimeDir ?? PATHS.CLAUDE_RUNTIME_DIR
  const codexHome = opts.codexHome ?? PATHS.CODEX_HOME
  // Defensive mkdir — `ensurePaths` already creates this in the normal
  // setupAndServe path, but if we're called from a context that didn't
  // run it (tests, future callers), don't fail with ENOENT.
  await fs.mkdir(runtimeDir, { recursive: true })
  if (process.platform !== "win32") {
    await fs.chmod(runtimeDir, 0o700).catch(() => {})
  }
  // 4-byte random suffix gives 2^32 distinct names per PID — collision-free
  // for any realistic count of in-process re-invocations.
  const fileSuffix = `${process.pid}-${randomBytes(4).toString("hex")}`
  const mcpConfigPath = path.join(runtimeDir, `peer-mcp-${fileSuffix}.json`)
  const agentsPath = path.join(runtimeDir, `peer-agents-${fileSuffix}.json`)

  const mcpConfig = buildPeerMcpConfig(serverUrl, {
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    geminiModel: opts.geminiModel,
    groupKeys: opts.groupKeys,
    nonce,
    codexHome,
    workspaceHeaderCmd: buildWorkspaceHeaderHelperCommand(opts.selfInvocation),
  })
  const agents = buildPeerAgentDefinitions({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    geminiModel: opts.geminiModel,
    groupKeys: opts.groupKeys,
    workerToolsAvailable: opts.workerToolsAvailable,
    browseAvailable: opts.browseAvailable,
    nativeSubagentModel: opts.nativeSubagentModel,
    reviewerModel: opts.reviewerModel,
    reviewerFastModel: opts.reviewerFastModel,
    brainstormModel: opts.brainstormModel,
    scoutModel: opts.scoutModel,
    scribeModel: opts.scribeModel,
    implementerFastModel: opts.implementerFastModel,
    generalPurposeFastModel: opts.generalPurposeFastModel,
    nativeRoster: opts.nativeRoster,
    personaAllowlist: opts.personaAllowlist,
    includeCoordinator: opts.includeCoordinator,
    scoutEffort: opts.scoutEffort,
    implementerFastEffort: opts.implementerFastEffort,
    reviewerFastEffort: opts.reviewerFastEffort,
    fastProfile: opts.fastProfile,
    plannerModel: opts.plannerModel,
    implementerEffort: opts.implementerEffort,
    reviewerEffort: opts.reviewerEffort,
    plannerEffort: opts.plannerEffort,
    criticModel: opts.criticModel,
    criticEffort: opts.criticEffort,
    nonce,
    codexHome,
    serverUrl,
    workspaceHeaderCmd: buildWorkspaceHeaderHelperCommand(opts.selfInvocation),
  })

  // If a prior same-PID file survived (boot sweep didn't run, or this
  // function is called twice in one lifecycle), unlink first so wx
  // succeeds. Letting wx fail loudly is correct from a security
  // standpoint, but here we're the same PID — there's no race window
  // a different process could exploit.
  await fs.unlink(mcpConfigPath).catch(() => {})
  await fs.unlink(agentsPath).catch(() => {})

  let mdResult: Awaited<ReturnType<typeof writePeerAgentMdFiles>> | undefined
  try {
    await writeRuntimeFileSecure(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))
    await writeRuntimeFileSecure(agentsPath, JSON.stringify(agents, null, 2))

    // Phase 2.5: also write the same agents as .md files into
    // ~/.claude/agents/ — this is the registry Claude Code's Task
    // `subagent_type` enum reads from at session start. The `--agents`
    // JSON path above is kept for inspection / future-proofing but the
    // .md files are what makes the subagents actually invokable from
    // Opus's tool surface.
    //
    // `builtinSubagents` (serve only) adds Claude Code's built-in Explore/Plan/
    // general-purpose, which the Agent SDK does NOT register — so the model's
    // habitual `Agent(subagent_type:"Explore")` calls resolve instead of 404ing.
    const agentsToWrite = opts.builtinSubagents
      ? { ...agents, ...opts.builtinSubagents }
      : agents
    mdResult = await writePeerAgentMdFiles(agentsToWrite, {
      agentsDir: opts.agentsDir,
      fileSuffix,
    })
  } catch (err) {
    if (mdResult) await mdResult.cleanup().catch(() => {})
    await Promise.allSettled([fs.unlink(mcpConfigPath), fs.unlink(agentsPath)])
    throw err
  }

  const completeMdResult = mdResult
  if (!completeMdResult) throw new Error("peer MCP agent files were not generated")

  const personas = opts.fastProfile
    ? []
    : personasFor({
        codexCli: opts.codexCli,
        geminiAvailable: opts.geminiAvailable,
        geminiModel: opts.geminiModel,
        agentAllowlist: opts.personaAllowlist,
      })

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      fs.unlink(mcpConfigPath),
      fs.unlink(agentsPath),
      completeMdResult.cleanup(),
    ])
  }

  return {
    mcpConfigPath,
    agentsPath,
    agentMdPaths: completeMdResult.paths,
    nonce,
    personas,
    cleanup,
  }
}
