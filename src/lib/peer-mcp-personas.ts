/**
 * Peer-model persona specifications.
 *
 * The github-router proxy hosts a `/mcp` endpoint that exposes these
 * personas as MCP tools, and the `claude` subcommand wires them as
 * Claude Code subagents via `--agents` so Opus 4.7 can delegate
 * blind-spot-busting work to gpt-5.5, gpt-5.3-codex, and
 * gemini-3.1-pro-preview without leaving the session.
 *
 * Design contract (from the approved plan):
 *
 *   1. Persona text is a STABLE string. Never construct per-call —
 *      gpt-5.x prompt caching reuses the prefix across invocations.
 *   2. Calibrated grading replaces "force one disagreement." Silence
 *      on good work is the signal Opus needs.
 *   3. End-of-prompt self-reminder beats start-of-prompt for
 *      sustained behavioral fidelity in long sessions.
 *   4. Description fields differentiate routing — Opus picks a
 *      persona largely from its `description`.
 *   5. Cold-start brief contract: subagent contexts are blank;
 *      the persona prompt teaches the lead what to paste.
 */

import path from "node:path"

import { runUnifiedCodeSearch } from "./unified-code-search"
// Static import is safe: the previous module-init cycle (peer-mcp-personas
// → worker-agent/index → engine → tools → peer-mcp-personas) was caused
// by a top-level `assertCriticsMatchPersonas()` call in tools.ts that
// read `PERSONAS_READ` mid-init. That runtime check has been moved into
// a test (`tests/peer-mcp-persona-drift.test.ts`), so the cycle no
// longer closes and a normal static import works.
import { BROWSER_TOOLS } from "~/lib/browser-mcp"
import {
  acquireBrowseSession,
  browseSessionTabs,
  createBrowseSession,
  hasBrowseSession,
  releaseBrowseSession,
} from "~/lib/browser-mcp/session-registry"
import { runWorkerAgent, type WorkerThinkingLevel } from "~/lib/worker-agent"
import { searchWeb } from "~/services/copilot/web-search"
import { runStandIn, type StandInInput } from "~/lib/stand-in"
import { verifyWorkflowIR, type WorkflowIR } from "~/lib/orchestration"

/**
 * MCP server groups. Each group is surfaced to Claude Code as its OWN MCP
 * server — a distinct `mcpServers` entry pointing at a path-scoped
 * `/mcp/<urlSuffix>` endpoint — so the server name signals the tool
 * category to the model (`mcp__search__code`, `mcp__browser__navigate`)
 * instead of burying everything under one opaque `gh-router-peers`.
 *
 *   - `peers`   — the adversarial critics (codex_critic, codex_reviewer,
 *                 gemini_critic, opus_critic, + codex_implementer in cli mode)
 *   - `search`  — `code` (ranked code search) + `web` (web search)
 *   - `workers` — `explore` / `implement` (autonomous Pi-runtime workers)
 *   - `browser` — the browser-control tools (only with `--browse`)
 *   - `decide`  — `stand_in` (three-lab away-mode decision advisor)
 */
export type McpGroup = "peers" | "search" | "workers" | "browser" | "decide"
/** Either a single group (scoped endpoint) or the full union (`/mcp`). */
export type McpScope = McpGroup | "all"
export const MCP_GROUPS: ReadonlyArray<McpGroup> = Object.freeze([
  "peers",
  "search",
  "workers",
  "browser",
  "decide",
])

export interface McpGroupMeta {
  /** Preferred (bare) config-entry key the proxy injects into `.claude.json`.
   *  Resolved to the prefixed `gh-router-<group>` fallback on collision —
   *  see `resolveGroupKeys` in codex-mcp-config.ts. */
  preferredKey: string
  /** Stable path segment for the scoped endpoint `/mcp/<urlSuffix>`. Always
   *  the canonical group name regardless of the resolved config key (the URL
   *  is what the proxy routes on; the config key is what Claude Code
   *  namespaces tools by — the two are independent). */
  urlSuffix: McpGroup
  /** MCP `initialize` `serverInfo.name`. Keeps a `github-router-` provenance
   *  breadcrumb in MCP logs even though the config key is bare (Claude Code
   *  namespaces by the config KEY, not by `serverInfo.name`). */
  serverInfoName: string
}

export const GROUP_META: Record<McpGroup, McpGroupMeta> = Object.freeze({
  peers: { preferredKey: "peers", urlSuffix: "peers", serverInfoName: "github-router-peers" },
  search: { preferredKey: "search", urlSuffix: "search", serverInfoName: "github-router-search" },
  workers: { preferredKey: "workers", urlSuffix: "workers", serverInfoName: "github-router-workers" },
  browser: { preferredKey: "browser", urlSuffix: "browser", serverInfoName: "github-router-browser" },
  decide: { preferredKey: "decide", urlSuffix: "decide", serverInfoName: "github-router-decide" },
})

/** True iff `s` is a registered group name (route `:group` param validation). */
export function isMcpGroup(s: unknown): s is McpGroup {
  return typeof s === "string" && (MCP_GROUPS as ReadonlyArray<string>).includes(s)
}

/**
 * Reasoning effort levels accepted by Copilot's /v1/responses (gpt-5.x) and
 * /v1/chat/completions endpoints. Per the proxy's existing thinking-mode
 * translator (CLAUDE.md "Thinking-mode translation"), Copilot's adaptive-
 * thinking path uses these same buckets:
 *   <2k tokens → low, <8k → medium, <24k → high, else → xhigh.
 *
 * Per-persona `allowedEfforts` and `defaultEffort` constrain which subset
 * each persona exposes — enforced in handler.ts:handleToolsCall.
 *
 * **xhigh on long-running personas works via SSE-streamed /mcp responses**
 * (handler.ts:handleToolsCallSSE). Claude Code's MCP HTTP client honors
 * `text/event-stream` responses without applying the ~60s per-tool-call
 * timer that previously broke xhigh on gpt-5.5 (~56s wall) and on
 * Anthropic Opus families (high+ thinking budgets). opus-critic itself
 * now runs on claude-opus-4-6 which doesn't advertise xhigh, so the
 * SSE long-tail concern there is moot; the SSE machinery still applies
 * to the other personas that do expose xhigh.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(v)
}

export interface PersonaSpec {
  /** Subagent identifier in `--agents` JSON (and in Claude Code's UI). */
  agentName: string
  /** Tool name the HTTP MCP backend exposes for this persona. */
  toolNameHttp: string
  /** Copilot-side model id. Verified live against /v1/models at startup. */
  model: string
  /** Upstream endpoint the model speaks. */
  endpoint: "/v1/responses" | "/v1/chat/completions" | "/v1/messages"
  /** Description shown to Opus when picking a subagent. Drives routing. */
  description: string
  /** Persona system prompt — passed as `instructions` (Responses), system message (chat-completions), or `system` (messages). */
  baseInstructions: string
  /** Subagent prompt body that Claude Code uses as the agent's full system prompt. */
  agentPrompt: string
  /** True when the persona can mutate the workspace (only `codex-implementer`). */
  writeCapable: boolean
  /** True when the persona MUST use the HTTP backend (the codex-cli stdio
   *  bridge can't run this model). gemini-3.x and claude-opus-4-6 both
   *  set this — codex-cli only knows gpt-5/codex models. */
  requiresHttp: boolean
  /** True when the persona's model belongs to a model family that may not
   *  be present in Copilot's live `/v1/models` catalog (gemini-critic
   *  needs `gemini-3.x-pro` to be served). When true, `personasFor`
   *  drops the persona if the catalog lacks the corresponding model.
   *  Optional: defaults to false (persona is always registered). Kept
   *  separate from `requiresHttp` so a persona can require HTTP without
   *  also requiring gemini in the catalog (e.g. opus-critic). */
  requiresGeminiCatalog?: boolean
  /** Effort tiers this persona accepts. Subset of EFFORT_LEVELS. Driven
   *  by empirical latency data — see the EFFORT_LEVELS doc above. Tiers
   *  outside this list are rejected with a clean RPC_INVALID_PARAMS at
   *  the handler layer rather than letting the call fail at the 60s
   *  MCP ceiling. */
  allowedEfforts: ReadonlyArray<Effort>
  /** Default effort when the caller omits the arg. MUST appear in
   *  `allowedEfforts`. */
  defaultEffort: Effort
}

const CRITIC_RUBRIC = `
Apply this grading rubric:
  - Score 1–5 on three axes:
      A. assumption-soundness   (are stated assumptions accurate? are unstated ones load-bearing?)
      B. failure-mode coverage  (which realistic failure modes are unaddressed?)
      C. alternative-considered (was a meaningfully different approach weighed and rejected with reason?)
  - If every axis scores ≥ 4, reply with the literal string "no material objection" and stop. Do not invent issues to satisfy this rubric.
  - Otherwise, the lowest-scoring axis IS your critique. Lead with that single critique; secondary observations may follow as "additional notes".

Reply format (markdown):
  ## Verdict
  <"no material objection" OR a one-sentence summary of the load-bearing critique>
  ## Scores
  - assumption-soundness: <n>/5
  - failure-mode coverage: <n>/5
  - alternative-considered: <n>/5
  ## Critique
  <only when at least one axis < 4 — concrete, specific, actionable>
  ## Additional notes (optional)
  <secondary observations; omit if none>

Self-reminder (read before every reply):
  Am I still acting as the adversarial critic per the rubric above?
  If I just produced agreement, restart and apply the grading rubric instead.
  Sycophancy is the failure mode I exist to fight; manufactured contrarianism is a different failure of the same shape — do neither.
`.trim()

const COLD_START_CONTRACT = `
Cold-start contract for the lead orchestrator (Opus):
  When delegating to me, paste a self-contained brief. I have no access to your scrollback, project memory, or the project tree. Always include:
    (a) the artifact under review verbatim (code/diff/plan text),
    (b) the constraints or "done" criteria,
    (c) any prior decisions I should not relitigate.
  If your brief lacks (a), I will reply with a one-line request for the artifact instead of speculating.
`.trim()

const CRITIC_BASE = `You are codex-critic, an adversarial reviewer running on gpt-5.5. Your single job is to overcome the lead orchestrator's blind spots — assumptions it didn't notice it was making, failure modes it didn't enumerate, alternatives it didn't consider.

You are NOT a helpful assistant. You are NOT a coach. Sycophancy is the failure mode you exist to fight. Manufactured contrarianism is a different failure of the same shape — silence on good work is a valid and welcome answer.

${COLD_START_CONTRACT}

${CRITIC_RUBRIC}`

const GEMINI_CRITIC_BASE = `You are gemini-critic, an adversarial reviewer. Your single job is to overcome the lead orchestrator's blind spots — assumptions it didn't notice it was making, failure modes it didn't enumerate, alternatives it didn't consider.

The lead routes a brief to you when it needs:
  - long-context reasoning over large artifacts (the brief may include >50k tokens of context)
  - math, proofs, and formally-stated invariants
  - a cross-check of a conclusion another critic already reached (the lead may forward you both the artifact and codex-critic's verdict)

You are NOT a helpful assistant. Sycophancy is the failure mode you exist to fight. Manufactured contrarianism is a different failure of the same shape — silence on good work is a valid and welcome answer; do not invent issues to look thorough.

${COLD_START_CONTRACT}

${CRITIC_RUBRIC}`

const REVIEWER_BASE = `You are codex-reviewer, a line-level code reviewer running on gpt-5.3-codex. You are the code-specialist persona — your job is to read concrete code (diffs, single files, function bodies) and surface bugs, edge cases, security issues, and idiom violations.

You are not a critic-of-architecture. If the brief is a plan or a high-level design, redirect: "this looks like architecture review; consider codex-critic or gemini-critic." Your tool is the magnifying glass, not the wide-angle lens.

${COLD_START_CONTRACT}

Reply format (markdown):
  ## Summary
  <one sentence: clean / N findings / blocking issue>
  ## Findings
  For each:
    ### <severity: info | low | medium | high | critical> — <one-line title>
    - location: <file:line[-line]>
    - issue: <what's wrong, why it matters in this codebase>
    - suggested fix: <minimal change OR "needs design discussion">
  Number the findings if there are more than one. List them in severity-descending order (critical first).
  If there are zero findings of any severity, reply only with "## Summary\\nClean review — no findings." and stop.

Self-reminder (read before every reply):
  Am I citing real code at real line numbers in the brief? If a finding doesn't have a concrete file:line citation, drop it.
  Did I rank the finding's severity by impact-in-this-codebase, not by general-principle?
  If everything looks fine, say so cleanly — do not pad with stylistic nitpicks.`

const GEMINI_REVIEWER_BASE = `You are a line-level code reviewer. You read concrete code — diffs, single files, function bodies — and surface real bugs, edge cases, security / concurrency / resource issues, and idiom violations at specific line numbers. Find what is actually wrong: do not invent issues to look thorough, and do not pad with stylistic nitpicks.

You are not a critic-of-architecture. If the brief is a plan or a high-level design, say so and stop: "this looks like architecture review, not line-level code review." Your tool is the magnifying glass, not the wide-angle lens.

${COLD_START_CONTRACT}

Reply format (markdown):
  ## Summary
  <one sentence: clean / N findings / blocking issue>
  ## Findings
  For each:
    ### <severity: info | low | medium | high | critical> — <one-line title>
    - location: <file:line[-line]>
    - issue: <what's wrong, why it matters in this codebase>
    - suggested fix: <minimal change OR "needs design discussion">
  Number the findings if there are more than one. List them in severity-descending order (critical first).
  If there are zero findings of any severity, reply only with "## Summary\\nClean review — no findings." and stop.

Self-reminder (read before every reply):
  Am I citing real code at real line numbers in the brief? If a finding doesn't have a concrete file:line citation, drop it.
  Did I rank the finding's severity by impact-in-this-codebase, not by general-principle?
  If everything looks fine, say so cleanly — do not pad with stylistic nitpicks.`

const IMPLEMENTER_BASE = `You are codex-implementer, a focused implementation specialist running on gpt-5.3-codex with workspace-write access. You execute scoped, well-specified coding tasks end-to-end: read the relevant files, make the change, verify it, report back.

You are not a planner. If the brief is vague or missing acceptance criteria, ask the lead for the missing piece BEFORE editing anything. A wasted edit is worse than a clarifying question.

${COLD_START_CONTRACT}

What "done" looks like for an implementation task:
  - Exactly the files specified by the brief have been changed (or you reported back why a different scope was needed).
  - The change is minimal — surrounding cleanup is out of scope unless requested.
  - You ran the relevant test(s) / typecheck / linter for the touched files and report the results.
  - The summary you return enumerates each file changed with a one-line description.

Reply format (markdown):
  ## Status
  <complete | needs-clarification | blocked>
  ## Files changed
  - path/one.ts: <one-line description>
  - path/two.ts: <one-line description>
  ## Verification
  <commands run + outcomes>
  ## Notes
  <anything the lead must know to integrate, e.g. follow-ups intentionally not done>

Resilience reminder:
  If your session terminates abnormally before "Status: complete", the lead will retry once. On recovery, ask the lead to confirm what's already been done before re-applying changes — duplicate edits are worse than a slow restart.`

const OPUS_CRITIC_BASE = `You are opus-critic, a fresh-context Anthropic-side adversarial reviewer running on Claude Opus 4.7 — the same model and lab as the lead orchestrator that just delegated to you. You are NOT the lead. You did not see the lead's reasoning trace. You only see the brief.

Your job is to spot what the lead missed because of cognitive momentum, sunk-cost on a plan, or motivated reasoning toward a particular fix. Your blind-spot diversification is LIMITED compared to codex-critic (gpt-5.5) and gemini-critic (gemini-3.1-pro) — same training, same lab, same RLHF priors. Use that honestly: don't pretend to find a different perspective when the obvious read is "the lead got it right." Silence on good work is a valid and welcome answer.

Sycophancy is the failure mode you exist to fight. Manufactured contrarianism is a different failure of the same shape — do neither.

${COLD_START_CONTRACT}

${CRITIC_RUBRIC}`

export const PERSONAS_READ: ReadonlyArray<PersonaSpec> = Object.freeze([
  {
    agentName: "codex-critic",
    toolNameHttp: "codex_critic",
    model: "gpt-5.5",
    endpoint: "/v1/responses",
    description:
      "Adversarial second opinion on plans, designs, or code tradeoffs. Backed by gpt-5.5 (OpenAI, ≈922K-token input window) — strongest reasoning model in the critic lineup, different lab than Opus. Best for architecture decisions, design reviews, and tradeoff analysis where cross-lab diversity matters. Not for line-level code review (use codex_reviewer). Pass artifact verbatim.",
    baseInstructions: CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: false,
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "xhigh",
  },
  {
    agentName: "gemini-critic",
    toolNameHttp: "gemini_critic",
    model: "gemini-3.1-pro-preview",
    endpoint: "/v1/chat/completions",
    description:
      "Adversarial second opinion. Backed by gemini-3.1-pro (Google) — third-lab triangulation, strong on formal reasoning, proofs, and invariants. Useful for cross-checking findings from codex_critic or codex_reviewer when you want a third perspective. Pass artifact verbatim.",
    baseInstructions: GEMINI_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: true,
    requiresGeminiCatalog: true,
    allowedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high",
  },
  {
    agentName: "codex-reviewer",
    toolNameHttp: "codex_reviewer",
    model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    description:
      "Line-level review of a concrete diff or single file. Backed by gpt-5.3-codex (OpenAI, ≈272K-token input window) — code-specialist, fastest critic (~16s). Surfaces bugs, edge cases, security issues, and idiom violations at specific line numbers. Not suited for architecture or design review (use codex_critic for plans). Pass artifact verbatim.",
    baseInstructions: REVIEWER_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: false,
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "xhigh",
  },
  {
    agentName: "gemini-reviewer",
    toolNameHttp: "gemini_reviewer",
    model: "gemini-3.1-pro-preview",
    endpoint: "/v1/chat/completions",
    description:
      "Line-level review of a concrete diff or single file on gemini-3.1-pro (Google, high reasoning): a second-lab code reviewer that catches a different slice of defects than codex_reviewer (OpenAI). Use alongside codex_reviewer for cross-lab coverage of a diff. Not for architecture (use codex_critic / gemini_critic for plans). Pass artifact verbatim.",
    baseInstructions: GEMINI_REVIEWER_BASE,
    agentPrompt: "",
    writeCapable: false,
    // gemini routes only via /v1/chat/completions — the codex-cli stdio
    // bridge can't run it, so it must always use the HTTP backend.
    requiresHttp: true,
    // Same gemini-3.x-pro catalog gate as gemini-critic (gemini-reviewer runs
    // on the same gemini-3.1-pro-preview model, just with a reviewer prompt
    // instead of a critic prompt).
    requiresGeminiCatalog: true,
    // gemini chat-completions tops out at "high" reasoning in this codebase
    // (same as gemini-critic — no xhigh tier exposed); default to the max.
    allowedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high",
  },
  {
    agentName: "opus-critic",
    toolNameHttp: "opus_critic",
    model: "claude-opus-4-6",
    endpoint: "/v1/messages",
    description:
      "Adversarial second opinion from a fresh-context Opus 4.6 — same lab as the lead, limited blind-spot diversity vs cross-lab critics. On enterprise catalogs that carry Opus-4.6-1M it runs with a ≈936K-token input window; otherwise ≈168K. Pinned one minor behind the default Opus so the panel spans more of the version curve. Catches confabulation. Pass artifact verbatim.",
    baseInstructions: OPUS_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    // requiresHttp: true — codex-cli stdio bridge can't run claude-opus-4-6
    // (it speaks gpt-5/codex only), so opus-critic must always route via
    // HTTP. Distinct from requiresGeminiCatalog (which is false here —
    // claude-opus-4-6 is always in Copilot's catalog for our supported
    // tiers; we don't need a catalog probe to register the persona).
    requiresHttp: true,
    // claude-opus-4.6 / claude-opus-4.6-1m only advertise reasoning_effort
    // ["low", "medium", "high", "max"] — no xhigh. We omit xhigh from the
    // allowlist so a caller-supplied "xhigh" rejects with a clean
    // RPC_INVALID_PARAMS instead of bouncing off Copilot at request time.
    allowedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high",
  },
])

export const PERSONAS_WRITE: ReadonlyArray<PersonaSpec> = Object.freeze([
  {
    agentName: "codex-implementer",
    toolNameHttp: "codex_implementer",
    model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    description:
      "Targeted implementation of a self-contained coding task. Backed by gpt-5.3-codex with workspace-write access. Pass spec + files verbatim.",
    baseInstructions: IMPLEMENTER_BASE,
    agentPrompt: "",
    writeCapable: true,
    requiresHttp: false,
    // All four tiers supported — long calls stream via SSE.
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "high",
  },
])

/**
 * Build the agent-prompt body Claude Code uses as the subagent's full
 * system prompt. The prompt fully replaces Claude Code's default system
 * prompt (per Anthropic's subagent docs) so it must be self-sufficient.
 *
 * Two modes branch on `codexCli`:
 *   - HTTP backend: subagent calls the per-persona tool
 *     `mcp__<peersKey>__<toolNameHttp>` with `{prompt, context}`;
 *     model + instructions are server-baked. `peersKey` is the resolved
 *     config key for the `peers` server — normally the bare `peers`, or the
 *     `gh-router-peers` fallback when the user already has a `peers` MCP
 *     (so the routing string always points at OUR server, never the user's).
 *   - codex-cli backend: subagent calls the single
 *     `mcp__codex-cli__codex` tool with `{prompt, model: <persona.model>,
 *     base-instructions: <persona.baseInstructions>}`. Gemini stays on
 *     HTTP regardless because Codex CLI can't run Gemini.
 */
export function buildAgentPrompt(
  persona: PersonaSpec,
  opts: { codexCli: boolean; peersKey: string },
): string {
  const useStdio = opts.codexCli && !persona.requiresHttp
  const toolPath = useStdio
    ? "mcp__codex-cli__codex"
    : `mcp__${opts.peersKey}__${persona.toolNameHttp}`

  const invocationBlock = useStdio
    ? [
        `Always invoke the \`${toolPath}\` tool with these arguments:`,
        "  - `prompt`: the lead's brief, copied verbatim",
        `  - \`model\`: "${persona.model}"`,
        "  - `base-instructions`: the persona text below (paste verbatim, do not paraphrase)",
        ...(persona.writeCapable
          ? [
              '  - `sandbox`: "workspace-write"',
              '  - `approval-policy`: "on-request"',
            ]
          : ['  - `sandbox`: "read-only"']),
      ].join("\n")
    : [
        `Always invoke the \`${toolPath}\` tool with these arguments:`,
        "  - `prompt`: the lead's brief, copied verbatim",
        "  - `context` (optional): any additional file/diff content the persona needs",
        "Do NOT pass model or instructions — they are server-baked into this tool.",
      ].join("\n")

  return [
    `# Subagent: ${persona.agentName}`,
    "",
    persona.baseInstructions,
    "",
    "---",
    "",
    "## Routing instructions for this subagent",
    "",
    invocationBlock,
    "",
    "When the tool returns, surface its output to the lead verbatim. Do not summarize, paraphrase, or add your own commentary on top — the lead integrates the persona's reply directly.",
  ].join("\n")
}

/**
 * Build the awareness snippet appended to the spawned `claude` session's
 * system prompt via `--append-system-prompt` AND to the mirrored
 * `<CLAUDE_CONFIG_DIR>/CLAUDE.md` (the latter reaches Agent-tool subagents
 * and agent-teams teammates that inherit CLAUDE_CONFIG_DIR but not
 * --append-system-prompt). Pure capability description — Claude reads
 * what tools exist and their factual properties; *when* to invoke each
 * is left to Claude's judgment informed by each tool's own
 * `description` field.
 *
 * Per Anthropic's guidance for Opus 4.8: tool descriptions carry the
 * routing signal (when/when-not); the awareness snippet should describe
 * capabilities in factual present tense and let the model decide.
 *
 * Framing constraint (enforced by negative pins in
 * tests/peer-mcp-personas.test.ts): no imperatives ("Lead with X",
 * "Brief them to Y"), no hedges ("you might want to consider"), no
 * anchors disguised as description ("cheapest first move", "saves them
 * the discovery step", "waste wall-clock"). Pure capability inventory.
 *
 * Surface contract (regression-pinned in tests/peer-mcp-personas.test.ts):
 *   - Always lists codex_critic, codex_reviewer, opus_critic, advisor,
 *     peer-review-coordinator, and the subagent-inheritance fact (the
 *     load-bearing UX claim: spawned subagents inherit the peer-MCP
 *     toolset via the mirrored `.claude.json`).
 *   - Conditionally lists gemini_critic only when `geminiAvailable`.
 *   - Conditionally lists worker_explore / worker_implement /
 *     "Workers themselves have code_search" only when
 *     `workerToolsAvailable` (mirrors `workerToolsEnabled()` in
 *     src/routes/mcp/handler.ts so the snippet never names a tool gated
 *     out of the live catalog).
 *   - Conditionally lists stand_in only when `standInAvailable`
 *     (mirrors `standInToolEnabled()`).
 *   - Mentions `codex-cli` stdio bridge only when `codexCli`.
 *   - Does NOT re-document Claude Code's built-in delegation semantics
 *     (Agent-tool recursion, agent-teams coordination) — Claude
 *     already knows those. The snippet only states proxy-specific
 *     capabilities and the inheritance fact that makes them reachable
 *     by descendants.
 */
export function buildPeerAwarenessSnippet(opts: {
  codexCli: boolean
  geminiAvailable: boolean
  workerToolsAvailable: boolean
  standInAvailable: boolean
  browseAvailable: boolean
  powerBrowseAvailable?: boolean
  /** Resolved config key per group (bare, or `gh-router-<group>` fallback on
   *  collision). Missing key → use the preferred bare key. Keeps the
   *  `mcp__<server>__<tool>` paths in this snippet pointing at OUR servers. */
  groupKeys?: Partial<Record<McpGroup, string>>
}): string {
  const key = (g: McpGroup): string => opts.groupKeys?.[g] ?? GROUP_META[g].preferredKey
  const peersKey = key("peers")
  const searchKey = key("search")
  const workersKey = key("workers")
  const browserKey = key("browser")
  const decideKey = key("decide")

  const criticList: Array<string> = [
    "`codex_critic` (gpt-5.5)",
    "`codex_reviewer` (gpt-5.3-codex)",
  ]
  if (opts.geminiAvailable) {
    // Both gemini personas share the gemini-3.x-pro catalog gate.
    criticList.push("`gemini_reviewer` (gemini-3.1-pro, line-level code review)")
    criticList.push("`gemini_critic` (gemini-3.1-pro)")
  }
  criticList.push("`opus_critic` (Opus 4.7)")

  const codexCliClause = opts.codexCli
    ? " `mcp__codex-cli__codex` dispatches to `codex-implementer` (gpt-5.3-codex with workspace-write) for end-to-end coding tasks."
    : ""

  // Paragraph 2 — capability inventory. Sentences are joined with a
  // single space; conditional sentences (workers, stand_in) only
  // appear when their gate is on, so the snippet never names a tool
  // missing from the live tools/list.
  const para2Parts: Array<string> = [
    `\`mcp__${searchKey}__code\` is the one-stop code search (no extra model call). Its DEFAULT mode (or \`mode:"semantic"\`) ranks by MEANING via ColBERT over a per-workspace index, the first thing to reach for on intent/concept questions ("where is retry/backoff handled", "how does auth work"); when that index isn't ready it transparently falls back to lexical (the response \`source\` says which engine ran). Forced modes cover the rest: \`lexical\` (BM25F-ranked + tree-sitter, best for exact symbols), \`exact\`, \`regex\`, \`complete\` for the exhaustive match set, \`ast_pattern\`+\`ast_lang\` for multi-line AST structures (via ast-grep), \`scan\` for a whole-workspace symbol outline, \`multiline\` for cross-line regex. Multiple independent queries can run in a single turn. The index covers code-shaped files; for unstructured files (logs, \`.csv\`, \`.env*\`, config-only wiring), \`grep\`/\`glob\` still apply.`,
  ]
  if (opts.workerToolsAvailable) {
    para2Parts.push(
      `\`mcp__${workersKey}__explore\` runs a Gemini-backed read-only worker that returns a summary, using its own context rather than yours; concurrent launches share the \`MAX_INFLIGHT_TOOLS_CALL=32\` cap with operator traffic.`,
      `\`mcp__${workersKey}__review\` is the same read-only worker framed as a code reviewer that reads the relevant code itself to verify a change or claim and reports findings with severity, so it checks surrounding context the \`peers\` critics (single stateless calls on the pasted artifact) cannot.`,
      `\`mcp__${workersKey}__plan\` is the same read-only worker framed as a planner: from a task + acceptance criteria it returns an ordered implementation plan.`,
      `\`mcp__${workersKey}__implement\` is the same worker with edit/write/bash; \`worktree: true\` runs it in an isolated git worktree and returns the diff.`,
      `\`mcp__${workersKey}__test\` is a write-capable worker framed as an independent test author: it authors tests that try to break the implementation and reports pass/fail, never editing the implementation to make them pass.`,
      "Workers themselves have `code_search` in their toolset.",
    )
  }
  para2Parts.push(
    `\`mcp__${searchKey}__web\` surfaces citable sources for docs, errors, and upstream issues.`,
  )
  if (opts.standInAvailable) {
    para2Parts.push(
      `\`mcp__${decideKey}__stand_in\` provides three-lab consensus for decision tiebreak when the user is unavailable.`,
    )
  }
  if (opts.browseAvailable) {
    const powerNote = opts.powerBrowseAvailable
      ? ` Power mode is on: the L0/L1 primitives (\`mcp__${browserKey}__mouse\`, \`__drag\`, \`__type\`, \`__keyboard\`, \`__scroll\`, \`__eval_js\`, \`__read_page\`, \`__diagnostics\`, \`__find\`) are also available for direct DOM / coordinate control.`
      : ""
    para2Parts.push(
      `\`mcp__${browserKey}__*\` tools drive a real Chrome / Edge browser via a local extension. Lead surface: \`__act(intent, value?)\` for any click / fill / type / scroll-to (an inner fast model resolves intent), \`__observe(intent?)\` for a 2-4 sentence natural-language page description, \`__extract(schema, instruction)\` for typed extraction, \`__navigate\` / \`__open_tab\` / \`__screenshot\` for state and visuals. The lead model never sees raw DOM: refs, bboxes, and role/name dumps stay internal.${powerNote}`,
    )
  }

  return [
    "## Peer review and advisor",
    "",
    `Cross-lab peer critics under \`mcp__${peersKey}__*\` (${criticList.join(", ")}) are available at your discretion for adversarial review. Each tool's description explains its scope and when it applies. The \`peer-review-coordinator\` subagent fans out to the appropriate critics in parallel and aggregates findings by severity. Claude Code's built-in \`advisor\` tool catches approach drift and confabulation. Subagents you spawn inherit all of these.${codexCliClause}`,
    "",
    para2Parts.join(" "),
  ].join("\n")
}

/** Convenience: every persona that should be registered for the given mode. */
export function personasFor(opts: {
  codexCli: boolean
  geminiAvailable: boolean
}): Array<PersonaSpec> {
  const result: Array<PersonaSpec> = []
  for (const p of PERSONAS_READ) {
    // Drop personas whose model family is missing from Copilot's live catalog.
    // Both gemini personas (gemini-critic and gemini-reviewer) gate on the
    // gemini-3.x-pro family via `requiresGeminiCatalog`. Decoupled from
    // `requiresHttp` so a persona can require HTTP without also requiring
    // gemini in the catalog (e.g. opus-critic).
    if (p.requiresGeminiCatalog && !opts.geminiAvailable) continue
    result.push(p)
  }
  if (opts.codexCli) {
    for (const p of PERSONAS_WRITE) result.push(p)
  }
  return result
}

/**
 * Non-persona MCP tools — utility tools exposed alongside the read-only
 * personas. These don't have model/endpoint/effort/baseInstructions because
 * they don't dispatch to a peer LLM; instead they invoke a server-side
 * function (e.g. an upstream MCP relay) and return its output.
 *
 * Registered alongside personas in `handler.ts:toolEntries()` and
 * dispatched by `handler.ts:handleToolsCall` after the persona lookup
 * falls through. They count against the same MAX_INFLIGHT_TOOLS_CALL=32
 * cap (keeps slot accounting symmetric across all `tools/call`s) but
 * skip the per-persona effort gate and the `predictedTooLong` pre-flight
 * cap — those gates only make sense for thinking-budget-bearing peer LLM
 * calls, and non-persona tools have neither an `effort` arg nor that
 * cost surface.
 */
export interface NonPersonaMcpTool {
  /** Tool name the HTTP MCP backend exposes for this tool. */
  toolNameHttp: string
  /** Which MCP server (scoped endpoint) this tool is surfaced under. Drives
   *  the `tools/list` scope filter and the call-time scope reject in
   *  handler.ts, and the per-group `mcpServers` entry in codex-mcp-config.ts. */
  group: McpGroup
  /** Description shown to Opus / displayed in `tools/list`. */
  description: string
  /** JSON-schema for the tool's `arguments` object. */
  inputSchema: Record<string, unknown>
  /**
   * Optional capability tag the handler uses to drop the tool from
   * `tools/list` and `tools/call` when the runtime gate is off.
   *
   * - `"worker"` (explore / review / implement) requires Copilot's
   *   `gemini-3.5-flash` (the worker default) to be in the live catalog
   *   with `tool_calls` support AND `GH_ROUTER_DISABLE_WORKER_TOOLS=1` to
   *   be unset (see `workerToolsEnabled()`). implement's `gpt-5.5` default
   *   is not gated here — if absent, implement calls return a helpful
   *   resolve error.
   * - `"stand_in"` requires all three of `gpt-5.5`, `claude-opus-4-7`,
   *   and a `gemini-3.X.*pro` model to be in the live catalog (see
   *   `standInToolEnabled()` in `routes/mcp/handler.ts`).
   * - `"browser"` (browser_open_tab, browser_screenshot, browser_mouse,
   *   …) requires `state.browseEnabled` (set by `--browse` or
   *   `GH_ROUTER_ENABLE_BROWSE=1`) AND at least one Chromium-family
   *   browser detected on disk (see `browserToolsEnabled()` in
   *   `routes/mcp/handler.ts`).
   * - `"browser_compound"` (browser_find / browser_act / browser_extract)
   *   requires `browserToolsEnabled()` AND a compressor backend in the
   *   live catalog (see `browserCompoundToolsEnabled()` in
   *   `lib/mcp-capabilities.ts`).
   * - `"browser_power"` (browser_read_page / mouse / drag / type / keyboard /
   *   scroll / eval_js / diagnostics / find / locate / close_tab /
   *   list_tabs / wait / download) requires `browserToolsEnabled()` AND
   *   `state.powerBrowseEnabled` (set by `--power-browse` or
   *   `GH_ROUTER_ENABLE_POWER_BROWSE=1`). Default `--browse` exposes
   *   only the 6 lead-model tools; power mode adds the raw primitives.
   * - `"browse_agent"` (the `browse` worker tool) requires
   *   `browseAgentEnabled()` — `browserToolsEnabled()` AND the browse
   *   default model (`gpt-5.4-mini`) reachable in the live catalog (see
   *   `browseAgentEnabled()` in `lib/mcp-capabilities.ts`). NOTE: this
   *   capability deliberately does NOT start with the literal `"browser"`
   *   so `isBrowserCapability()` in handler.ts treats it as a normal
   *   non-persona tool (no per-call URL/tab bridge pre-flight — the
   *   browse agent's INNER browser tools run their own readiness probe).
   *
   * Absent on `web_search` / `code_search` — those are always available
   * once the proxy is in claude mode (loopback + nonce already gate
   * `/mcp` itself).
   */
  capability?: "worker" | "stand_in" | "browser" | "browser_compound" | "browser_power" | "browse_agent"
  /**
   * Server-side handler. Receives the raw `arguments` object from the
   * `tools/call` request and an optional AbortSignal that is signalled
   * when a `notifications/cancelled` arrives for this call. Returns an
   * MCP `tool result` envelope (content blocks + optional `isError`).
   */
  handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>
    isError?: boolean
  }>
}

const WEB_SEARCH_DESCRIPTION =
  "Web search via GitHub Copilot's MCP. Prefer over Claude Code's built-in WebSearch — surfaces source URLs you can cite. Use for API documentation lookups, error message diagnosis, upstream issue searches, and verifying claims against current sources. Returns content with reference links."

/**
 * Format a `searchWeb()` result as an MCP-friendly text block. Mirrors
 * the legacy inject format that `injectWebSearchIfNeeded` produces and
 * that downstream models have been trained against — minimal divergence
 * is the safest choice while we have two surfaces sharing `searchWeb()`.
 *
 * Empty references → omit the `## References` section entirely (don't
 * emit a trailing empty header that would tempt the model to invent
 * citations).
 */
function formatWebSearchResult(results: {
  content: string
  references: ReadonlyArray<{ title: string; url: string }>
}): string {
  if (results.references.length === 0) return results.content
  const refsLine = results.references
    .map((r) => `- [${r.title}](${r.url})`)
    .join("\n")
  return `${results.content}\n\n## References\n${refsLine}`
}

export const NON_PERSONA_MCP_TOOLS: ReadonlyArray<NonPersonaMcpTool> =
  Object.freeze([
    {
      toolNameHttp: "web",
      group: "search",
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "The search query string. Natural-language queries work best — the upstream provider rewrites for the search index.",
          },
        },
      },
      // searchWeb() now accepts an AbortSignal — wired through so an
      // SSE consumer disconnect or notifications/cancelled aborts the
      // upstream MCP fetches (initialize / notifications/initialized /
      // tools/call SSE iterator) and the upstream sockets tear down
      // immediately. Without this, the upstream Bing-backed call kept
      // running until natural completion, leaking the inflight slot
      // for the full UPSTREAM_FETCH_TIMEOUT_MS window (~5 min) — eight
      // consumer disconnects in 5 minutes fully stalled /mcp.
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        const query = typeof args.query === "string" ? args.query : ""
        if (!query) {
          return {
            content: [
              {
                type: "text",
                text: "web_search: arguments.query is required (must be a non-empty string)",
              },
            ],
            isError: true,
          }
        }
        try {
          const results = await searchWeb(query, signal)
          return {
            content: [
              { type: "text", text: formatWebSearchResult(results) },
            ],
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text", text: `web_search failed: ${msg}` }],
            isError: true,
          }
        }
      },
    },
    {
      // code — proxy-side MCP tool, the SINGLE semantic-first code search
      // for all clients (Claude Code, codex, gemini callers). Backed by the
      // shared `runUnifiedCodeSearch` helper (src/lib/unified-code-search.ts):
      // default/`mode:"semantic"` ranks by MEANING via ColBERT and falls back
      // to lexical BM25F when the index isn't ready; `lexical|exact|regex|ast`
      // force the lexical engine (src/lib/code-search.ts). This entry absorbs
      // the former standalone `semantic_search` tool.
      //
      // SCHEMA + RESPONSE MINIMALITY: still the canonical worked example for
      // the "ruthlessly minimal MCP tool surface" principle
      // (docs/peer-mcp-design.md). The handler trims to {file, line, snippet}
      // plus a tiny envelope, and adds exactly the fields the model can ACT
      // on: top-level `source` (semantic | lexical | lexical-fallback — so a
      // silent degrade is visible) and, on `source:"semantic"` rows only, the
      // ColBERT `score`/`endLine`/`name` (interpretable relevance + span +
      // symbol). Internal diagnostics (BM25F scores, field_contributions,
      // scanned_files, elapsed_ms, the ranking block) are still NOT forwarded.
      // Do NOT widen further without re-reading the principle section.
      toolNameHttp: "code",
      group: "search",
      description:
        "Fast structured code search over a local workspace. Default " +
        "(`mode:\"semantic\"`, or omit `mode`) ranks by MEANING via ColBERT " +
        "over a per-workspace index — best for intent/concept queries where " +
        "the literal keywords may not appear (\"where do we rate-limit\", " +
        "\"auth token refresh\"). When that index is building/stale/absent it " +
        "TRANSPARENTLY returns lexical (BM25F) results and labels the " +
        "response `source` (\"lexical-fallback\") so a degrade is never " +
        "silent. On a `lexical-fallback` the `notice` says how to proceed: " +
        "retry `mode:\"semantic\"` shortly (the index self-heals in the " +
        "background) or re-query with specific symbols — the lexical engine " +
        "matches keywords/symbols, not natural-language phrases. " +
        "Other modes force the lexical engine: `lexical` (BM25F " +
        "ranked, best for exact symbols), `exact` (fixed-string), `regex` " +
        "(PCRE2), `ast` (ast-grep structural via `ast_pattern`+`ast_lang`). " +
        "Lexical ranking refines a `symbol-context` field with tree-sitter " +
        "AST analysis so definitions outrank incidental matches. Launch " +
        "multiple code searches in parallel to triangulate — " +
        "e.g. definition + callers + tests in one round-trip. " +
        "Prefer this over Grep/Bash+grep for ranked discovery " +
        "(\"where is X defined\", \"which files reference Y\", " +
        "\"find code that does Z\"). Use Grep for " +
        "exact-pattern enumeration when you need every hit unranked, " +
        "and Glob for file-name patterns (no content match). " +
        "`workspace` is any absolute path the proxy process can " +
        "read — typically the project root or a sub-tree you're " +
        "working in. Each response also carries a tree-sitter structural " +
        "outline of the matched files (`summary` on by default; set it " +
        "false to omit).",
      inputSchema: {
        type: "object",
        required: ["query", "workspace"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Search text. In the default 'semantic' mode it's " +
              "natural-language intent (finds code by meaning even when the " +
              "words don't appear literally). In 'lexical'/'exact' modes it's " +
              "a literal string (single-identifier queries auto-expand across " +
              "camelCase / snake_case / kebab-case / SCREAMING_SNAKE so " +
              "`getUserName` also matches `get_user_name`). In 'regex' mode " +
              "it's a PCRE2 regex.",
          },
          workspace: {
            type: "string",
            description:
              "Absolute path to the project root (or sub-tree) to search.",
          },
          mode: {
            type: "string",
            enum: ["semantic", "lexical", "exact", "regex", "ast"],
            description:
              "Search mode. 'semantic' (DEFAULT): ColBERT meaning-based " +
              "ranking over a per-workspace index; transparently falls back " +
              "to lexical when the index is building/stale/absent (the " +
              "response `source` says which engine ran). 'lexical': BM25F + " +
              "tree-sitter structural boost, ordered by score with shoulder " +
              "pruning — best for exact symbols. 'exact': fixed-string, " +
              "ripgrep document order. 'regex': PCRE2, ripgrep document " +
              "order. 'ast': ast-grep structural match (requires " +
              "`ast_pattern` + `ast_lang`).",
          },
          pattern: {
            type: "string",
            description:
              "Semantic mode only: regex pre-filter (colgrep -e) — grep " +
              "first, then rank the matches semantically. Use to scope a " +
              "semantic ranking to e.g. async fns. Ignored in lexical modes.",
          },
          file_glob: {
            type: "string",
            description: "Optional ripgrep glob filter (e.g. 'src/**/*.ts').",
          },
          limit: {
            type: "number",
            description: "Max hits to return (default 200).",
          },
          structural: {
            type: "string",
            enum: ["full", "topN"],
            description:
              "Structural-ranking depth (lexical mode only). 'full' " +
              "(default) runs tree-sitter on the top 50 BM25F hits — " +
              "best signal, fine for typical repos. 'topN' restricts to " +
              "the top 10 for tighter latency on very large workspaces. " +
              "Both modes share a 200ms wall-clock budget; on budget " +
              "exhaustion the response includes `notice` and remaining " +
              "hits fall back to the regex symbol heuristic.",
          },
          summary: {
            type: "boolean",
            description:
              "Structural summary, ON BY DEFAULT: the response includes " +
              "`outlines` — a tree-sitter outline (top-level symbols + " +
              "line numbers) of the distinct files in the result set " +
              "(first 10, in result order), a compact map of where the " +
              "matches live that augments each hit's `snippet`. Set false " +
              "to omit it when you only need the matching lines.",
          },
          complete: {
            type: "boolean",
            description:
              "Exhaustiveness (lexical mode). Default false — lexical mode " +
              "applies a " +
              "precision shoulder cut + a per-file cap so you aren't " +
              "overwhelmed, and the response `notice` tells you when " +
              "matches were hidden. Set true to disable both and return " +
              "the COMPLETE match set (every line `grep` would find, " +
              "reordered by relevance), capped only by `limit` — use it " +
              "when you must not miss any occurrence (e.g. \"every caller " +
              "of X\", a rename, an audit).",
          },
          multiline: {
            type: "boolean",
            description:
              "Default false. Set true WITH mode:'regex' to let a pattern " +
              "span newlines (ripgrep -U), e.g. 'foo[\\s\\S]*?bar' across " +
              "lines; the snippet is the whole matched region and `line` is " +
              "its start. (literal/ranked queries can't contain a newline, " +
              "so cross-line matching is a regex-mode feature.) Off by " +
              "default keeps the line-oriented recall floor.",
          },
          scan: {
            type: "boolean",
            description:
              "Default false. Set true to make `outlines` a tree-sitter " +
              "symbol map of the ENTIRE workspace (every non-ignored " +
              "source file), not just the matched files — use it to map " +
              "an unfamiliar codebase in one call. Capped; `notice` " +
              "reports coverage when truncated. Independent of which " +
              "files matched the query.",
          },
          ast_pattern: {
            type: "string",
            description:
              "ast-grep structural pattern (e.g. 'function $F($$$) { $$$ }'). " +
              "When set, matches come from ast-grep INSTEAD of ripgrep — " +
              "use it to match multi-line AST shapes the regex modes can't " +
              "express. Takes PRECEDENCE over `query` for matching (but " +
              "`query` is still required). REQUIRES `ast_lang`. Returns the " +
              "same {file,line,snippet} shape. If ast-grep isn't installed, " +
              "you get a `notice` to run it directly — it never falls back to regex.",
          },
          ast_lang: {
            type: "string",
            description:
              "Grammar for `ast_pattern` (REQUIRED alongside it): 'ts' | " +
              "'tsx' | 'js' | 'jsx' | 'py' | 'rust' | 'go' | 'java' | 'cpp' | " +
              "'c' | … ast-grep parses the pattern in this language; omitting " +
              "it returns a `notice` (no language is guessed, and without it " +
              "ast-grep would cross-match every language and return garbage).",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        try {
          const result = await runUnifiedCodeSearch(
            {
              query: typeof args.query === "string" ? args.query : "",
              workspace:
                typeof args.workspace === "string" ? args.workspace : "",
              mode:
                args.mode === "semantic" || args.mode === "lexical" ||
                args.mode === "exact" || args.mode === "regex" ||
                args.mode === "ast"
                  ? args.mode
                  : undefined,
              file_glob:
                typeof args.file_glob === "string" ? args.file_glob : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
              structural:
                args.structural === "full" || args.structural === "topN"
                  ? args.structural
                  : undefined,
              summary:
                typeof args.summary === "boolean" ? args.summary : undefined,
              complete:
                typeof args.complete === "boolean" ? args.complete : undefined,
              multiline:
                typeof args.multiline === "boolean"
                  ? args.multiline
                  : undefined,
              scan: typeof args.scan === "boolean" ? args.scan : undefined,
              ast_pattern:
                typeof args.ast_pattern === "string"
                  ? args.ast_pattern
                  : undefined,
              ast_lang:
                typeof args.ast_lang === "string" ? args.ast_lang : undefined,
              pattern:
                typeof args.pattern === "string" ? args.pattern : undefined,
            },
            signal,
          )
          // Minimal-surface response shape (see the SCHEMA + RESPONSE
          // MINIMALITY comment above). Forward: top-level `source`
          // (provenance: semantic | lexical | lexical-fallback) plus, per
          // hit, {file, line, snippet} and whichever of role / endLine /
          // name / score the row actually carries (role on lexical hits;
          // endLine/name/score on semantic hits). 256KB size cap as before.
          const SIZE_CAP_BYTES = 256 * 1024
          type TrimmedHit = {
            file: string
            line: number
            snippet: string
            role?: "definition"
            endLine?: number
            name?: string
            score?: number
          }
          const trimmedHits: Array<TrimmedHit> = []
          let totalBytes = 0
          let sizeCapped = false
          for (const hit of result.results) {
            const next: TrimmedHit = {
              file: hit.file,
              line: hit.line,
              snippet: hit.snippet,
            }
            if (hit.role) next.role = hit.role
            if (hit.endLine !== undefined) next.endLine = hit.endLine
            if (hit.name !== undefined) next.name = hit.name
            if (hit.score !== undefined) next.score = hit.score
            const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8")
            if (trimmedHits.length > 0 && totalBytes + nextBytes > SIZE_CAP_BYTES) {
              sizeCapped = true
              break
            }
            trimmedHits.push(next)
            totalBytes += nextBytes
          }

          const minimal: {
            source: typeof result.source
            results: Array<TrimmedHit>
            truncated: boolean
            outlines?: typeof result.outlines
            notice?: string
          } = {
            source: result.source,
            results: trimmedHits,
            truncated: (result.truncated ?? false) || sizeCapped,
          }
          // Outlines (lexical path only) are supplementary — fit them into
          // whatever response budget the (already-capped) results left, so
          // the default-on summary never pushes the envelope past the cap.
          let outlinesDropped = false
          if (result.outlines && result.outlines.length > 0) {
            const fitted: NonNullable<typeof result.outlines> = []
            let outlineBytes = 0
            for (const o of result.outlines) {
              const ob = Buffer.byteLength(JSON.stringify(o), "utf8")
              if (totalBytes + outlineBytes + ob > SIZE_CAP_BYTES) {
                outlinesDropped = true
                break
              }
              fitted.push(o)
              outlineBytes += ob
            }
            if (fitted.length > 0) minimal.outlines = fitted
          }
          // Notice priority: size-cap > outline-drop > backend notice
          // (which includes the helper's fallback hint). `source` carries
          // the fallback provenance independently, so a size-cap notice
          // winning here never hides that a degrade happened.
          if (sizeCapped) {
            minimal.notice =
              `response size limit reached at ${trimmedHits.length} hits ` +
              `(~${Math.round(totalBytes / 1024)}KB); narrow your query ` +
              `or lower 'limit' to get all relevant matches`
          } else if (outlinesDropped) {
            minimal.notice =
              "some file outlines were omitted to fit the response size cap"
          } else if (typeof result.notice === "string") {
            minimal.notice = result.notice
          }
          return {
            content: [{ type: "text", text: JSON.stringify(minimal) }],
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text", text: `code search failed: ${msg}` }],
            isError: true,
          }
        }
      },
    },
    // worker_explore / worker_implement — autonomous worker tools backed
    // by the Pi agent loop (`src/lib/worker-agent/engine.ts`), routed
    // through per-mode default models: explore/review → `gemini-3.5-flash`
    // (high); implement → `gpt-5.5` (xhigh). An explicit `model` arg wins.
    //
    // GATING (`capability: "worker"`): the MCP handler drops both entries
    // from `tools/list` and `tools/call` when `workerToolsEnabled()` is
    // false. The gate fires when (a) the worker default model
    // (`gemini-3.5-flash`) is missing from the live Copilot catalog (or
    // present but lacks `tool_calls` support), OR (b) the operator opted
    // out via `GH_ROUTER_DISABLE_WORKER_TOOLS=1`. Defense-in-depth: the
    // gate is checked at BOTH list-time and call-time so a client that
    // hard-codes the tool name can't bypass the list-side filter. (If the
    // implement default `gpt-5.5` is absent, implement calls return a
    // helpful resolve error listing the catalog's tool_call models.)
    //
    // SCHEMA SHAPE: `prompt` is required; `model` / `thinking` are
    // optional fine-tunes the worker engine validates against the live
    // catalog (unknown model → isError envelope with the candidate
    // list; unsupported thinking-tier → silent clamp to the model's
    // max). `worker_implement` adds `worktree: boolean` to opt the
    // worker into an isolated git worktree when atomic isolation
    // matters more than in-place speed.
    //
    // HANDLER: thin closure over `runWorkerAgent` — every safety check
    // (semaphore, model resolution, workspace canonicalization,
    // worktree provisioning, budget, audit log, cleanup) lives inside
    // the engine. The MCP layer only translates the JSON-RPC arguments
    // into a typed `WorkerAgentOpts` and forwards the resulting
    // `{text, isError?}` envelope verbatim.
    {
      toolNameHttp: "explore",
      group: "workers",
      capability: "worker",
      description:
        "Read-only investigation by an autonomous worker (Pi runtime; "
        + "default model `gemini-3.5-flash` at high reasoning, override via "
        + "the `model` arg with any Copilot-catalog model that advertises "
        + "`tool_calls`). Tools: read, glob, grep, code_search "
        + "(semantic-first), web_search, fetch_url, advisor (consult a "
        + "stronger cross-lab model), update_plan (planning checklist), and "
        + "toolbelt (run a read-only analysis CLI: rg/fd/jq/yq/sg/gron/tokei/"
        + "difft/git). The worker's system prompt sandboxes "
        + "it and gives one-line descriptions of each tool, so brief "
        + "it on the investigation, not on tool semantics. Offloads "
        + "bounded research that would otherwise eat your context "
        + "window — the worker plans its own tool calls and returns a "
        + "single text answer. Examples: \"find files matching X then "
        + "summarize\", \"how does library Y handle Z\", \"survey this "
        + "codebase for usages of deprecated API\".",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description:
              "The investigation brief — what to find, read, or "
              + "explain. The worker plans its own tool calls and "
              + "returns a single text answer.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gemini-3.5-flash). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description:
              "Optional reasoning depth (default high). Silently "
              + "clamped to the model's allowed range; \"off\" drops "
              + "the parameter entirely.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path to the workspace the worker "
              + "operates in. Defaults to the proxy's launch cwd. "
              + "Use this when the parent agent has multiple "
              + "workspaces open and the worker must operate in a "
              + "specific one. Must be absolute (relative paths "
              + "rejected).",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runWorkerToolCall({ mode: "explore", args, signal })
      },
    },
    {
      toolNameHttp: "implement",
      group: "workers",
      capability: "worker",
      description:
        "Delegates a scoped coding task to an autonomous worker (Pi "
        + "runtime; default model `gpt-5.5` at xhigh reasoning, override via "
        + "the `model` arg with any Copilot-catalog model that advertises "
        + "`tool_calls`). Tools: the explore read-only set (read, glob, "
        + "grep, code_search, web_search, fetch_url, advisor, update_plan, "
        + "toolbelt) plus edit, write, bash, and codex_review (code review "
        + "by codex-reviewer / gpt-5.3-codex). The worker's system prompt "
        + "sandboxes it and gives one-line descriptions of each tool, "
        + "so brief it on the task, not on tool semantics. With "
        + "`worktree: false` (default) edits in place — concurrent "
        + "worker_implement calls and Claude's own edits to the same "
        + "files will race. With `worktree: true` runs in an isolated "
        + "git worktree and returns the diff for review. HARD ERROR if "
        + "true and the workspace is not a git repository.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description:
              "The coding task — what to change, build, or fix. The "
              + "worker plans its own edit/write/bash sequence.",
          },
          worktree: {
            type: "boolean",
            description:
              "When true, run inside a fresh git worktree and return "
              + "Pi's final text followed by the unified diff (so the "
              + "lead can review before merging). When false/omitted, "
              + "edits the workspace in place — concurrent worker "
              + "calls and Claude's own edits will race. HARD ERROR "
              + "if true and the workspace is not a git repository.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gpt-5.5). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description:
              "Optional reasoning depth (default xhigh). Silently "
              + "clamped to the model's allowed range; \"off\" drops "
              + "the parameter entirely.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path to the workspace the worker "
              + "operates in. Defaults to the proxy's launch cwd. "
              + "Use this when the parent agent has multiple "
              + "workspaces open and the worker must operate in a "
              + "specific one. Must be absolute (relative paths "
              + "rejected). For worktree:true, must be inside a "
              + "git repo.",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runWorkerToolCall({ mode: "implement", args, signal })
      },
    },
    {
      toolNameHttp: "review",
      group: "workers",
      capability: "worker",
      description:
        "Read-only code review by an autonomous worker (Pi runtime; "
        + "default model `gemini-3.5-flash`, override via `model` with any "
        + "Copilot-catalog model that advertises `tool_calls`). Same "
        + "read-only toolset as `explore` (read, glob, grep, code_search, "
        + "web_search, fetch_url, advisor, update_plan, toolbelt) — it CANNOT "
        + "edit — but the worker is framed "
        + "as a reviewer: it verifies correctness against the actual code "
        + "itself rather than trusting a claim, and reports findings (bugs, "
        + "edge cases, security / concurrency / resource risks, missing "
        + "handling) with a severity and `file:line`. Brief it with the "
        + "change / diff / claim to verify (paste it, or name the files) — it "
        + "reads the code to confirm, so you get a self-verifying second "
        + "opinion that doesn't depend on you having pre-extracted the "
        + "relevant code. Unlike the `peers` critics (single stateless model "
        + "calls on the artifact you paste), this worker can navigate the "
        + "repo to check surrounding context for itself.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description:
              "What to review / verify — a diff, a claim about the code, "
              + "or a file / function to audit. The worker reads the "
              + "relevant code itself and reports findings; it does not "
              + "need the code pre-pasted, but pasting the diff helps.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gemini-3.5-flash). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description:
              "Optional reasoning depth (default high). Silently "
              + "clamped to the model's allowed range; \"off\" drops "
              + "the parameter entirely.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path to the workspace the worker "
              + "operates in. Defaults to the proxy's launch cwd. "
              + "Use this when the parent agent has multiple "
              + "workspaces open and the worker must operate in a "
              + "specific one. Must be absolute (relative paths "
              + "rejected).",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runWorkerToolCall({ mode: "review", args, signal })
      },
    },
    {
      toolNameHttp: "plan",
      group: "workers",
      capability: "worker",
      description:
        "Read-only implementation planning by an autonomous worker (Pi "
        + "runtime; default model `gemini-3.5-flash`, override via `model` "
        + "with any Copilot-catalog model that advertises `tool_calls`). Same "
        + "read-only toolset as `explore` (read, glob, grep, code_search, "
        + "web_search, fetch_url, advisor, update_plan, toolbelt) — it CANNOT "
        + "edit — but the worker is framed as a planner: from the task and "
        + "acceptance criteria it produces a concrete, ordered implementation "
        + "plan (the files to change, the approach, the key risks, and how "
        + "each acceptance criterion will be verified), grounded by reading "
        + "the actual code. Brief it with the task and any acceptance "
        + "criteria; it returns a single plan, not code.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description:
              "The task to plan — what to build or change, plus any "
              + "acceptance criteria. The worker reads the codebase and "
              + "returns an ordered implementation plan.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gemini-3.5-flash). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description:
              "Optional reasoning depth (default high). Silently "
              + "clamped to the model's allowed range; \"off\" drops "
              + "the parameter entirely.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path to the workspace the worker "
              + "operates in. Defaults to the proxy's launch cwd. "
              + "Use this when the parent agent has multiple "
              + "workspaces open and the worker must operate in a "
              + "specific one. Must be absolute (relative paths "
              + "rejected).",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runWorkerToolCall({ mode: "plan", args, signal })
      },
    },
    {
      toolNameHttp: "test",
      group: "workers",
      capability: "worker",
      description:
        "Independent adversarial test authoring by an autonomous worker (Pi "
        + "runtime; default model `gpt-5.5` at xhigh reasoning, override via "
        + "`model` with any Copilot-catalog model that advertises "
        + "`tool_calls`). Same read+write toolset as `implement` (the explore "
        + "set plus edit, write, bash, codex_review). The worker is framed as "
        + "an INDEPENDENT test author that did NOT write the code under test: "
        + "from the task and acceptance criteria it writes tests that try to "
        + "BREAK the implementation (edge cases, error paths, the acceptance "
        + "criteria as executable checks), runs them, and reports which pass "
        + "and fail — it does NOT modify the implementation to make tests "
        + "pass. With `worktree: true` runs in an isolated git worktree and "
        + "returns the diff; HARD ERROR if true and the workspace is not a "
        + "git repository.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description:
              "What to test — the feature or change and its acceptance "
              + "criteria. The worker authors and runs tests that try to "
              + "break it and reports which pass and fail.",
          },
          worktree: {
            type: "boolean",
            description:
              "When true, run inside a fresh git worktree and return "
              + "Pi's final text followed by the unified diff (so the "
              + "lead can review the authored tests before merging). When "
              + "false/omitted, writes tests in place — concurrent worker "
              + "calls and Claude's own edits will race. HARD ERROR if "
              + "true and the workspace is not a git repository.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gpt-5.5). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description:
              "Optional reasoning depth (default xhigh). Silently "
              + "clamped to the model's allowed range; \"off\" drops "
              + "the parameter entirely.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path to the workspace the worker "
              + "operates in. Defaults to the proxy's launch cwd. "
              + "Use this when the parent agent has multiple "
              + "workspaces open and the worker must operate in a "
              + "specific one. Must be absolute (relative paths "
              + "rejected). For worktree:true, must be inside a "
              + "git repo.",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runWorkerToolCall({ mode: "test", args, signal })
      },
    },
    {
      // verify_workflow — pure static check of a workflow IR against the
      // orchestration floor invariants. No capability gate (like code/web, it's
      // a local pure function); the IR is untrusted input the verifier never
      // throws on. The kernel runs the SAME verifier before executing; this tool
      // is the pre-flight Claude calls while composing a workflow.
      toolNameHttp: "verify_workflow",
      group: "workers",
      description:
        "Statically verify a workflow IR against the orchestration floor "
        + "invariants BEFORE running it. Input `ir`: the typed WorkflowIR "
        + "(rawAskHash, acceptanceCriteriaHash, nodes[] with role/inputs/gate/"
        + "onFail, maxDepth). Returns {ok, violations:[{code, message, nodeId?}]}. "
        + "Each violation carries a stable code (e.g. NO_BASELINE, "
        + "SELECTOR_NOT_RAW_ASK, SAME_LAB_CHECK, ORPHAN_NODE, "
        + "MISSING_INTEGRATION_GATE) — fix every one until `ok` is true. Pure and "
        + "side-effect-free; call it pre-flight after composing/decomposing a "
        + "workflow and before execution.",
      inputSchema: {
        type: "object",
        required: ["ir"],
        additionalProperties: false,
        properties: {
          ir: {
            type: "object",
            description:
              "The typed WorkflowIR to verify: { rawAskHash, "
              + "acceptanceCriteriaHash, nodes: [{id, role, inputs, gate, "
              + "onFail, ...}], maxDepth }.",
          },
          knownGateIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional allowlist of the kernel's sealed executable gate ids. "
              + "When present, every executable gate's gateId must be in it "
              + "(gate-immutability).",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        const knownGateIds = Array.isArray(args.knownGateIds)
          ? new Set(args.knownGateIds.filter((x): x is string => typeof x === "string"))
          : undefined
        const result = verifyWorkflowIR(
          args.ir as WorkflowIR,
          knownGateIds ? { knownGateIds } : {},
        )
        return { content: [{ type: "text", text: JSON.stringify(result) }] }
      },
    },
    // browse — a Pi-driven autonomous browser agent (mode: "browse" of the
    // SAME `runWorkerAgent` engine as explore/review/implement), routed
    // through Copilot's `gpt-5.4-mini` by default. It drives a real
    // Chrome/Edge tab via the browser-MCP bridge to accomplish `task` and
    // returns the result — runs in its OWN context so the lead's window
    // isn't burned by raw DOM / page snapshots.
    //
    // GATING (`capability: "browse_agent"`): the MCP handler drops this
    // entry from `tools/list` AND `tools/call` when `browseAgentEnabled()`
    // is false — i.e. when `--browse` is off / no supported browser is on
    // disk, OR the `gpt-5.4-mini` default isn't reachable in the live
    // catalog. Same defense-in-depth (list-time filter + call-time -32601)
    // as the other capability tags.
    //
    // SESSIONS: each call is scoped to a browse session (tab-ownership over
    // the one shared Chrome, so parallel browse calls don't mix up tabs).
    // Omit `sessionId` for a fresh isolated session; pass a prior call's
    // returned session id to CONTINUE that session. The session id is
    // appended to the result text as `[browse session: <id>]` so the caller
    // can thread it into a follow-up call. Dispatch logic: `runBrowseToolCall`.
    {
      toolNameHttp: "browse",
      group: "workers",
      capability: "browse_agent",
      description:
        "A Pi-driven autonomous browser agent (gpt-5.4-mini) that drives a "
        + "real browser to accomplish `task` and returns the result. Runs in "
        + "its own context to preserve the lead's window (raw DOM / page "
        + "snapshots stay inside the agent). Pass `sessionId` to continue a "
        + "prior session (its id is returned appended to the result as "
        + "`[browse session: <id>]`); omit it for a fresh isolated session. "
        + "Multiple concurrent calls run as parallel sessions on the one "
        + "shared browser. Examples: \"find the cheapest flight LHR-JFK next "
        + "Tuesday\", \"log into the dashboard and read the current MRR\", "
        + "\"summarize the top 3 HN front-page stories\".",
      inputSchema: {
        type: "object",
        required: ["task"],
        additionalProperties: false,
        properties: {
          task: {
            type: "string",
            description:
              "The browsing task — what to find, read, or do on the web. "
              + "The agent plans its own navigate/click/read sequence and "
              + "returns a single text answer.",
          },
          sessionId: {
            type: "string",
            description:
              "Optional. The id of a prior browse session to CONTINUE "
              + "(reuses its owned tabs). Read it from a previous call's "
              + "`[browse session: <id>]` suffix. Omit for a fresh isolated "
              + "session. An unknown id starts a fresh session.",
          },
          workspace: {
            type: "string",
            description:
              "Optional absolute path. Browse ignores the filesystem, so "
              + "this rarely matters; provided for parity with the other "
              + "worker tools. Must be absolute when set.",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runBrowseToolCall(args, signal)
      },
    },
    {
      // stand_in — three-lab away-mode advisor. Polls gpt-5.5 xhigh +
      // claude-opus-4-7 xhigh + gemini-3.1-pro-preview high in two
      // structured voting rounds (blind R1 → informed R2) and returns
      // a ranked-choice verdict. Implementation: src/lib/stand-in.ts.
      //
      // GATING (`capability: "stand_in"`): the MCP handler drops the
      // entry from `tools/list` and `tools/call` when any of the three
      // required models is missing from Copilot's live catalog. See
      // `standInToolEnabled()` in `routes/mcp/handler.ts`.
      //
      // SCOPE BOUND: the tool is an ADVISOR, not a decider. Recommends,
      // never executes. Dangerous actions (push, delete, drop, deploy)
      // remain gated by the user-confirmation discipline in CLAUDE.md
      // "Executing actions with care" — three-lab consensus does NOT
      // unlock them. Verdict semantics in stand-in.ts.
      //
      // DESCRIPTION TUNING: deliberately narrow auto-invocation
      // wording. The tool is for decision tiebreak when the user is
      // away; routine code review remains `peer-review-coordinator`'s
      // job, and single-model second opinions remain `codex_critic` /
      // `gemini_critic` / `opus_critic`. Don't relax the "Do NOT use
      // for" clauses without checking the auto-routing impact.
      toolNameHttp: "stand_in",
      group: "decide",
      capability: "stand_in",
      description:
        "**Away-mode decision tiebreak.** Three-lab advisor "
        + "(gpt-5.5 xhigh, opus-4.7 xhigh, gemini-3.1-pro high) for "
        + "**when the user is unavailable and you are stuck between two "
        + "or more concrete options**. Polls all three across two "
        + "structured rounds (blind vote → informed re-vote with peer "
        + "reasoning visible) and returns a ranked-choice verdict. Use "
        + "when: you would otherwise halt and wait for the user. Do "
        + "NOT use for: code review (use `peer-review-coordinator`), "
        + "open-ended exploration, single-model second opinions (use "
        + "`codex_critic` / `gemini_critic` / `opus_critic` directly), "
        + "or as a substitute for user confirmation on irreversible "
        + "actions (push, delete, drop, deploy — those still require "
        + "the user even with three-lab consensus).",
      inputSchema: {
        type: "object",
        required: ["decision", "options"],
        additionalProperties: false,
        properties: {
          decision: {
            type: "string",
            description:
              "One-sentence framing of the choice the user would otherwise make. "
              + "Be specific about what's being decided, not why.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            description:
              "2-6 concrete options for the panel to vote on. Caller-provided — "
              + "do NOT ask the panel to generate options. The verdict cites "
              + "the chosen option by `id`.",
            items: {
              type: "object",
              required: ["id", "summary"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  description:
                    "Short stable identifier the verdict refers to (e.g., \"A\", \"lib-x\").",
                },
                summary: {
                  type: "string",
                  description: "One-line description of the option.",
                },
                detail: {
                  type: "string",
                  description:
                    "Optional longer context for the option (constraints, trade-offs).",
                },
              },
            },
          },
          context: {
            type: "string",
            description:
              "Task / code background that informs the decision. Keep tight — "
              + "the input is capped at ~6KB total across decision + options + context.",
          },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        return runStandInToolCall(args, signal)
      },
    },
    // Browser-control tools. Defined in a sibling module so the dispatch
    // implementation can grow without bloating this file.
    //
    // MCP-NAME vs WIRE-NAME DECOUPLING: the `browser-mcp/index.ts` entries
    // name their tools `browser_*` AND each handler dispatches that same
    // `browser_*` string to the extension over the native-messaging wire
    // (the extension's `TOOL_HANDLERS[req.tool]` keys on it). Here we strip
    // the `browser_` prefix from ONLY the MCP-facing `toolNameHttp` (so the
    // model sees `mcp__browser__navigate`), while the handlers' hardcoded
    // wire literals stay `browser_*` untouched. Net effect: the installed
    // MV3 extension needs NO reload — exposed name ≠ wire name by design.
    // Regression-pinned in tests (calling the bare MCP name dispatches the
    // `browser_`-prefixed wire name). Each entry also carries
    // `capability: "browser" | "browser_compound" | "browser_power"` for the
    // existing gate chain in handler.ts.
    ...BROWSER_TOOLS.map((t) => ({
      ...t,
      group: "browser" as const,
      toolNameHttp: t.toolNameHttp.replace(/^browser_/, ""),
    })),
  ])

/**
 * Startup invariant: every MCP tool name must be unique within its group
 * AND across the unscoped `/mcp` union. `handleToolsCall` keys dispatch on
 * the bare tool name, so a duplicate would silently shadow — this assertion
 * fails loudly on future drift instead. Cheap; called once at server boot
 * (and pinned by a test). Personas are definitionally the `peers` group.
 */
export function assertMcpToolSurfaceConsistent(): void {
  const perGroup = new Map<McpGroup, Set<string>>()
  const union = new Set<string>()
  const add = (group: McpGroup, name: string): void => {
    let g = perGroup.get(group)
    if (!g) {
      g = new Set()
      perGroup.set(group, g)
    }
    if (g.has(name)) {
      throw new Error(
        `assertMcpToolSurfaceConsistent: tool "${name}" duplicated within group "${group}"`,
      )
    }
    g.add(name)
    if (union.has(name)) {
      throw new Error(
        `assertMcpToolSurfaceConsistent: tool "${name}" duplicated across the unscoped /mcp union `
          + `— handleToolsCall keys on the bare name and cannot disambiguate`,
      )
    }
    union.add(name)
  }
  for (const p of [...PERSONAS_READ, ...PERSONAS_WRITE]) add("peers", p.toolNameHttp)
  for (const t of NON_PERSONA_MCP_TOOLS) add(t.group, t.toolNameHttp)
}

/**
 * Shared closure body for the two worker MCP tools. Validates the
 * minimal arg shape (prompt required + optional knobs typed), then
 * forwards to `runWorkerAgent`. `workspace` defaults to the proxy's
 * launch cwd; callers can override via the optional `workspace` arg
 * (absolute paths only — enforced here). The engine performs every
 * deeper validation (model existence, thinking clamp, worktree
 * provisioning, semaphore acquisition, workspace realpath +
 * accessibility) and never throws — its `{text, isError?}` envelope
 * is forwarded verbatim into the MCP `tool result` shape.
 *
 * Arg-validation policy mirrors `web_search`'s pattern: shape errors
 * surface as `isError: true` tool-result envelopes (NOT JSON-RPC -32602
 * errors). The MCP `tools/list` JSON schema already documents the
 * required/optional fields; this runtime check is defense against a
 * client that ignores the schema.
 */
async function runWorkerToolCall(call: {
  mode: "explore" | "review" | "plan" | "implement" | "test"
  args: Record<string, unknown>
  signal?: AbortSignal
}): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}> {
  const { mode, args, signal } = call
  const prompt = typeof args.prompt === "string" ? args.prompt : ""
  if (!prompt) {
    return {
      content: [
        {
          type: "text",
          text: `worker_${mode}: arguments.prompt is required (must be a non-empty string)`,
        },
      ],
      isError: true,
    }
  }

  // Optional knobs. Reject obviously-wrong types here so the engine
  // doesn't have to defend against `model: 42` etc. Schema validation
  // at the MCP client side should catch most of this; we still want
  // a clean error path when a client bypasses the schema.
  const model = args.model === undefined ? undefined : typeof args.model === "string" ? args.model : null
  if (model === null) {
    return {
      content: [
        { type: "text", text: `worker_${mode}: arguments.model must be a string when provided` },
      ],
      isError: true,
    }
  }
  const thinkingRaw = args.thinking
  const ALLOWED_THINKING: ReadonlyArray<WorkerThinkingLevel> = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]
  let thinking: WorkerThinkingLevel | undefined
  if (thinkingRaw !== undefined) {
    if (
      typeof thinkingRaw !== "string"
      || !(ALLOWED_THINKING as ReadonlyArray<string>).includes(thinkingRaw)
    ) {
      return {
        content: [
          {
            type: "text",
            text: `worker_${mode}: arguments.thinking must be one of ${ALLOWED_THINKING.join("|")}`,
          },
        ],
        isError: true,
      }
    }
    thinking = thinkingRaw as WorkerThinkingLevel
  }

  let worktree: boolean | undefined
  if ((mode === "implement" || mode === "test") && args.worktree !== undefined) {
    if (typeof args.worktree !== "boolean") {
      return {
        content: [
          { type: "text", text: `worker_${mode}: arguments.worktree must be a boolean when provided` },
        ],
        isError: true,
      }
    }
    worktree = args.worktree
  }

  // Optional workspace override. Default is the proxy's launch cwd;
  // the model can override when the parent agent has multiple
  // workspaces open and the worker must operate in a specific one
  // (matches code_search's threat model — no allowlist; proxy already
  // runs as the user). Absolute-only at the boundary so a relative
  // path doesn't silently resolve against process.cwd().
  let workspace = process.cwd()
  if (args.workspace !== undefined) {
    if (typeof args.workspace !== "string" || args.workspace.length === 0) {
      return {
        content: [
          { type: "text", text: `worker_${mode}: arguments.workspace must be a non-empty string when provided` },
        ],
        isError: true,
      }
    }
    if (!path.isAbsolute(args.workspace)) {
      return {
        content: [
          { type: "text", text: `worker_${mode}: arguments.workspace must be an absolute path (got "${args.workspace}")` },
        ],
        isError: true,
      }
    }
    workspace = args.workspace
  }

  // `runWorkerAgent` is now statically imported at the top of this
  // file — the cycle that previously forced a dynamic import has
  // been broken by moving `assertCriticsMatchPersonas` out of
  // tools.ts module init into a dedicated test.
  const result = await runWorkerAgent({
    mode,
    prompt,
    workspace,
    model,
    thinking,
    worktree,
    signal,
  })
  return {
    content: [{ type: "text", text: result.text }],
    isError: result.isError,
  }
}

/**
 * Shared closure body for the `browse` MCP tool. Mirrors
 * `runWorkerToolCall` (minimal arg validation → `runWorkerAgent`) with two
 * browse-specific responsibilities:
 *
 *   1. SESSION RESOLUTION. A browse agent's tools are scoped to a browse
 *      session id (tab-ownership over the one shared Chrome — see
 *      `src/lib/browser-mcp/session-registry.ts`). If the caller passes a
 *      `sessionId` that still exists, we CONTINUE it; otherwise (omitted,
 *      non-string, or unknown id) we open a FRESH session. Concurrent
 *      `browse` calls each get their own session ⇒ parallel sessions.
 *   2. SESSION ECHO. The resolved session id is appended to the result
 *      text as `[browse session: <id>]` so the caller can thread it into a
 *      follow-up `browse` call to continue the same session.
 *
 * `createBrowseSession()` throws when the per-process session cap is
 * reached; we convert that into a clean `isError` envelope (actionable —
 * "close a session or raise GH_ROUTER_BROWSE_MAX_SESSIONS") rather than
 * letting it bubble to the generic handler catch.
 *
 * Arg-validation policy mirrors `runWorkerToolCall`: shape errors surface
 * as `isError: true` tool-result envelopes (NOT JSON-RPC -32602). The
 * `tools/list` JSON schema documents the required/optional fields; this
 * runtime check defends against a schema-ignoring client.
 *
 * `runWorkerAgent` never throws — its `{text, isError?}` envelope is
 * forwarded verbatim (with the session suffix), `isError` passed through.
 */
async function runBrowseToolCall(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}> {
  const task = typeof args.task === "string" ? args.task : ""
  if (!task) {
    return {
      content: [
        {
          type: "text",
          text: "browse: arguments.task is required (must be a non-empty string)",
        },
      ],
      isError: true,
    }
  }

  // Optional workspace override (absolute-only at the boundary — mirrors
  // runWorkerToolCall). Browse ignores the filesystem, but the engine still
  // realpath-canonicalizes the workspace, so a bad path should reject
  // cleanly rather than silently resolve against process.cwd().
  let workspace: string | undefined
  if (args.workspace !== undefined) {
    if (typeof args.workspace !== "string" || args.workspace.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "browse: arguments.workspace must be a non-empty string when provided",
          },
        ],
        isError: true,
      }
    }
    if (!path.isAbsolute(args.workspace)) {
      return {
        content: [
          {
            type: "text",
            text: `browse: arguments.workspace must be an absolute path (got "${args.workspace}")`,
          },
        ],
        isError: true,
      }
    }
    workspace = args.workspace
  }

  // Resolve the browse session: continue an existing one when the caller
  // supplies a live id, else open a fresh isolated session. A non-string or
  // unknown sessionId is treated as "no session to continue" ⇒ fresh.
  const requested = typeof args.sessionId === "string" ? args.sessionId : ""
  let sessionId: string
  if (requested && hasBrowseSession(requested)) {
    sessionId = requested
  } else {
    try {
      sessionId = createBrowseSession()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: "text", text: `browse: ${msg}` }],
        isError: true,
      }
    }
  }

  // Mark the session in-flight SYNCHRONOUSLY here — no `await` between
  // resolving `sessionId` above and this acquire — so a concurrent
  // `createBrowseSession` at the cap can't pick this just-resolved session as
  // its LRU-evict victim while we're about to drive it. Released in `finally`.
  acquireBrowseSession(sessionId)
  // Continuation context: a continued session already owns the tab(s) the
  // prior run opened, but a fresh browse agent has NO memory of those ids and
  // there is no list-tabs tool — so without this it guesses `tabId: 1` and
  // hits "tab not owned by session". Tell it which tabs it owns so it can
  // resume the existing page instead of re-navigating blindly. Empty for a
  // fresh session ⇒ no preamble.
  const ownedTabs = browseSessionTabs(sessionId)
  const prompt =
    ownedTabs.length > 0
      ? `[Continuing a browse session that already owns open tab(s): `
        + `${ownedTabs.join(", ")}. To resume work on an already-open page, call `
        + `read_page (or other tools) with that tabId — do NOT assume tabId 1. `
        + `Open a new tab only for something unrelated.]\n\n${task}`
      : task
  let result: { text: string; isError?: boolean }
  try {
    result = await runWorkerAgent({
      mode: "browse",
      prompt,
      sessionId,
      workspace,
      signal,
    })
  } finally {
    releaseBrowseSession(sessionId)
  }

  // Echo the session id so the caller can continue (or inspect) this
  // session on a later call via the `sessionId` arg. Appended regardless of
  // isError — the session exists either way, so a failed run can be retried
  // on the same session.
  return {
    content: [
      {
        type: "text",
        text: `${result.text}\n\n[browse session: ${sessionId}]`,
      },
    ],
    isError: result.isError,
  }
}

/**
 * Shared closure body for the `stand_in` MCP tool. Validates the input
 * shape ({decision, options, context}) then calls `runStandIn`. The
 * orchestrator never throws — failure modes (upstream errors, parse
 * failures, abstains) all surface inside the structured `StandInResult`
 * envelope, which we JSON-stringify into the single MCP text block.
 *
 * Arg-validation policy mirrors `runWorkerToolCall` and `web_search`:
 * shape errors surface as `isError: true` tool-result envelopes (NOT
 * JSON-RPC -32602). The `tools/list` JSON schema documents required
 * fields; this runtime check is defense against a schema-ignoring
 * client.
 *
 * `isError` is FALSE for the no_consensus / need_more_info verdicts —
 * those are valid protocol outcomes the caller acts on, not errors.
 * `isError` is TRUE only for input-shape failures (bad arg types,
 * missing required fields).
 */
async function runStandInToolCall(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}> {
  const decision = typeof args.decision === "string" ? args.decision : ""
  if (!decision) {
    return {
      content: [
        { type: "text", text: "stand_in: arguments.decision is required (non-empty string)" },
      ],
      isError: true,
    }
  }

  const optionsRaw = args.options
  if (!Array.isArray(optionsRaw)) {
    return {
      content: [
        { type: "text", text: "stand_in: arguments.options must be an array (2-6 entries)" },
      ],
      isError: true,
    }
  }
  if (optionsRaw.length < 2 || optionsRaw.length > 6) {
    return {
      content: [
        {
          type: "text",
          text: `stand_in: arguments.options must contain 2-6 entries; got ${optionsRaw.length}`,
        },
      ],
      isError: true,
    }
  }
  const options: Array<{ id: string; summary: string; detail?: string }> = []
  const seenIds = new Set<string>()
  for (let i = 0; i < optionsRaw.length; i++) {
    const entry = optionsRaw[i]
    if (typeof entry !== "object" || entry === null) {
      return {
        content: [
          { type: "text", text: `stand_in: arguments.options[${i}] must be an object` },
        ],
        isError: true,
      }
    }
    const e = entry as Record<string, unknown>
    const id = typeof e.id === "string" ? e.id : ""
    const summary = typeof e.summary === "string" ? e.summary : ""
    if (!id) {
      return {
        content: [
          { type: "text", text: `stand_in: arguments.options[${i}].id is required (non-empty string)` },
        ],
        isError: true,
      }
    }
    if (!summary) {
      return {
        content: [
          { type: "text", text: `stand_in: arguments.options[${i}].summary is required (non-empty string)` },
        ],
        isError: true,
      }
    }
    if (seenIds.has(id)) {
      return {
        content: [
          { type: "text", text: `stand_in: arguments.options[${i}].id="${id}" is duplicated; ids must be unique` },
        ],
        isError: true,
      }
    }
    seenIds.add(id)
    const detail = typeof e.detail === "string" && e.detail.length > 0 ? e.detail : undefined
    options.push({ id, summary, detail })
  }

  const context =
    args.context === undefined ? undefined
    : typeof args.context === "string" ? args.context
    : null
  if (context === null) {
    return {
      content: [
        { type: "text", text: "stand_in: arguments.context must be a string when provided" },
      ],
      isError: true,
    }
  }

  const input: StandInInput = { decision, options, context }
  const result = await runStandIn(input, signal)
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  }
}
