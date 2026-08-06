/**
 * Peer-model persona specifications.
 *
 * The github-router proxy hosts a `/mcp` endpoint that exposes these
 * personas as MCP tools, and the `claude` subcommand wires them as
 * Claude Code subagents via `--agents` so Opus 4.7 can delegate
 * blind-spot-busting work to gpt-5.6-sol, gpt-5.3-codex, and
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

import { ARTIFACT_TOOLS } from "./artifact/tools"
import type { McpToolResult } from "./attachments"
import { FLEET_TOOLS } from "./fleet/tools"
import { FIRST_MATE_TOOLS } from "./first-mate/tools"
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
import {
  resolveModeDefaults,
  runWorkerAgent,
  WORKER_THINKING_LEVELS,
  type WorkerThinkingLevel,
} from "~/lib/worker-agent"
import {
  buildCatalogView,
  resolveModelAndThinking,
} from "~/lib/worker-agent/model-resolve"
import {
  resetAllWorkerSessionDefaults,
  resetWorkerSessionDefault,
  setWorkerSessionDefault,
  WORKER_MODES,
  type WorkerMode,
} from "~/lib/worker-agent/session-defaults"
// Budget helpers use a SUB-PATH import (`~/lib/worker-agent/budget`, not the
// `~/lib/worker-agent` index above) so they pull in only the leaf `budget.ts`
// (+ its type-only import) and do not reintroduce the
// personas→worker-agent→engine→tools→personas cycle the index would.
import {
  MCP_TIMEOUT_HEADROOM_MS,
  resolveMcpToolTimeoutMs,
  workerWallClockCeilingMs,
} from "~/lib/worker-agent/budget"
// Leaf sub-path import (like `budget` above) — pulls in only `relay-cap.ts`
// and avoids the worker-agent index cycle.
import { relaySafeText } from "~/lib/worker-agent/relay-cap"
import { searchWeb } from "~/services/copilot/web-search"
import { runStandIn, type StandInInput } from "~/lib/stand-in"
import { state } from "~/lib/state"
import { verifyWorkflowIR, decomposeWorkflow, attestRun, type AttestNode, type WorkflowIR } from "~/lib/orchestration"
import { buildLiveDecomposeDeps } from "~/lib/orchestration/decompose-live"
import { runWorkflowLive } from "~/lib/orchestration/run-workflow-live"

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
 *   - `orchestrate` — the workflow tools (`decompose` composes a typed IR,
 *                 `verify_workflow` statically checks it, `run_workflow` runs the
 *                 frozen kernel, `attest_step` audits a run's cross-lab lineage).
 *                 A distinct category from `workers`: these compose/verify/run a
 *                 workflow (the workers are what a workflow delegates to).
 *   - `browser` — the browser-control tools (only with `--browse`)
 *   - `decide`  — `stand_in` (three-lab away-mode decision advisor)
 *   - `fleet`   — remote ai-or-die session-control tools
 *   - `first-mate` — durable GitHub cloud-agent controller tools
 */
export type McpGroup = "peers" | "search" | "workers" | "orchestrate" | "browser" | "decide" | "fleet" | "first-mate"
/** Either a single group (scoped endpoint) or the full union (`/mcp`). */
export type McpScope = McpGroup | "all"
export const MCP_GROUPS: ReadonlyArray<McpGroup> = Object.freeze([
  "peers",
  "search",
  "workers",
  "orchestrate",
  "browser",
  "decide",
  "fleet",
  "first-mate",
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
  orchestrate: { preferredKey: "orchestrate", urlSuffix: "orchestrate", serverInfoName: "github-router-orchestrate" },
  browser: { preferredKey: "browser", urlSuffix: "browser", serverInfoName: "github-router-browser" },
  decide: { preferredKey: "decide", urlSuffix: "decide", serverInfoName: "github-router-decide" },
  fleet: { preferredKey: "fleet", urlSuffix: "fleet", serverInfoName: "github-router-fleet" },
  "first-mate": { preferredKey: "first-mate", urlSuffix: "first-mate", serverInfoName: "github-router-first-mate" },
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
 * Anthropic Opus families (high+ thinking budgets). opus-critic caps its
 * exposed effort at `high` (its effective model can fall back to
 * claude-opus-4-6, which doesn't advertise xhigh), so the SSE long-tail
 * concern there is moot; the SSE machinery still applies to the other
 * personas that do expose xhigh.
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
   *  bridge can't run this model). gemini-3.x and the Anthropic Opus critic
   *  both set this — codex-cli only knows gpt-5/codex models. */
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

const CRITIC_BASE = `You are codex-critic, an adversarial reviewer running on gpt-5.6-sol. Your single job is to overcome the lead orchestrator's blind spots — assumptions it didn't notice it was making, failure modes it didn't enumerate, alternatives it didn't consider.

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

const OPUS_CRITIC_BASE = `You are opus-critic, a fresh-context same-lab adversarial reviewer running on Opus 5. The lead orchestrator that just delegated to you runs Opus-family context too, but you are NOT the lead. You did not see the lead's reasoning trace. You only see the brief.

Your job is to spot what the lead missed because of cognitive momentum, sunk-cost on a plan, or motivated reasoning toward a particular fix. Your blind-spot diversification is LIMITED compared to codex-critic (gpt-5.6-sol) and gemini-critic (gemini-3.1-pro), same lab, adjacent model family, related priors. Use that honestly: don't pretend to find a different perspective when the obvious read is "the lead got it right." Silence on good work is a valid and welcome answer.

Sycophancy is the failure mode you exist to fight. Manufactured contrarianism is a different failure of the same shape — do neither.

${COLD_START_CONTRACT}

${CRITIC_RUBRIC}`

export const PERSONAS_READ: ReadonlyArray<PersonaSpec> = Object.freeze([
  {
    agentName: "codex-critic",
    toolNameHttp: "codex_critic",
    model: "gpt-5.6-sol",
    endpoint: "/v1/responses",
    description:
      "Adversarial architecture and design critic backed by gpt-5.6-sol (OpenAI, ~1M-token input window), the strongest cross-lab reasoning critic in this surface. It reviews plans, designs, tradeoffs, and large code-change proposals for unsound assumptions, missing failure modes, and overlooked alternatives, then returns a calibrated objection or `no material objection`. Use when a decision or design needs a different-lab strategic challenge before implementation or merge. Not for line-level bug finding in a concrete diff or file, use codex_reviewer or gemini_reviewer; pass the artifact and constraints verbatim.",
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
      "Adversarial third-lab critic backed by gemini-3.1-pro-preview (Google), strong on formal reasoning, invariants, proofs, and cross-checking another critic's conclusion. It reviews plans, designs, mathematical arguments, and large artifacts for assumption gaps or invariant failures, then returns a focused critique or no-material-objection style verdict. Use when codex_critic's result needs an independent lab check or when the artifact hinges on formal correctness. Not for line-level diff review, use gemini_reviewer or codex_reviewer; pass the artifact and constraints verbatim.",
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
      "Line-level code reviewer backed by gpt-5.3-codex (OpenAI, ≈272K-token input window), a code-specialist reviewer that is fastest around high effort (~16s at high effort). It reviews concrete diffs, files, or function bodies and returns findings with severity, file:line locations, issue impact, and a minimal suggested fix. Use when the artifact is actual code and the goal is bug, edge-case, security, concurrency, resource, or idiom review. Not for architecture or tradeoff review, use codex_critic or gemini_critic; pass the diff or file content verbatim.",
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
      "Line-level code reviewer backed by gemini-3.1-pro-preview (Google), providing second-lab coverage that catches a different slice of concrete-code defects than codex_reviewer. It reviews diffs, files, or function bodies and returns severity-ranked findings with file:line citations and suggested fixes. Use alongside codex_reviewer when a non-trivial diff benefits from cross-lab code-review coverage, especially around invariants or edge cases. Not for architecture or product-design review, use codex_critic or gemini_critic; pass the code artifact verbatim.",
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
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    description:
      "Adversarial same-lab critic backed by fresh-context Opus 5, with limited blind-spot diversity compared with cross-lab critics. It reviews plans, designs, or code tradeoffs for cognitive momentum, sunk-cost reasoning, and confabulated assumptions, then returns a calibrated objection or no material objection. Use when a same-family sanity check can catch lead-context drift or when comparing against codex_critic / gemini_critic findings. Not a substitute for cross-lab review on security-sensitive or high-risk changes; use codex_critic or gemini_critic for stronger diversity. Runs with the full 1M-context Opus 5 window (native, no -1m sibling needed). Pass artifact verbatim.",
    baseInstructions: OPUS_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    // requiresHttp: true — codex-cli stdio bridge can't run claude-opus-5
    // (it speaks gpt-5/codex only), so opus-critic must always route via
    // HTTP. Distinct from requiresGeminiCatalog (which is false here —
    // an Opus slug is always in Copilot's catalog for our supported
    // tiers; we don't need a catalog probe to register the persona).
    requiresHttp: true,
    // opus_critic's EFFECTIVE model is resolved dynamically at call time
    // (`resolveOpusCriticModel` in handler.ts): `claude-opus-5` (which
    // advertises xhigh) when the catalog carries it, else a fallback to
    // `claude-opus-4.6-1m` / `claude-opus-4-6`, which advertise only
    // ["low","medium","high","max"] — no xhigh. This STATIC base is the
    // conservative floor: `activePersonas()` widens it to include xhigh ONLY
    // when the resolved model is opus-5, so on a fallback tier a caller-supplied
    // "xhigh" rejects with a clean RPC_INVALID_PARAMS instead of bouncing off
    // Copilot (the `/v1/messages` dispatch does not clamp effort). Default stays
    // "high" on every tier.
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
      "Targeted implementation persona backed by gpt-5.3-codex with workspace-write access. It executes self-contained coding tasks from a pasted spec, reads the relevant files, edits the workspace, verifies the result, and returns changed files plus verification output. Use when the task is bounded enough for direct implementation and the caller can provide acceptance criteria and file context up front. Not for open-ended planning or broad repo exploration, use plan or explore first; not for read-only review, use codex_reviewer or gemini_reviewer. Because it can mutate the workspace, scope files and allowed changes explicitly and pass the spec verbatim.",
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
 * Wording budget (minimal sufficient guidance, NOT sentence-count parity):
 * each tool/group gets only the wording needed for correct, safe, high-value
 * use; extra wording must earn its attention cost. "Importance" shows up via
 * cost-of-misuse / ambiguity / invocation complexity, not proportional length
 * (a critical-but-simple tool can be one clause). When editing this snippet or
 * any injected guidance, re-check the whole surface for balance rather than
 * only expanding whatever was last touched.
 *
 * Surface contract (regression-pinned in tests/peer-mcp-personas.test.ts):
 *   - Always lists codex_critic, codex_reviewer, opus_critic, advisor,
 *     peer-review-coordinator, and the subagent-inheritance fact (the
 *     load-bearing UX claim: spawned subagents inherit the peer-MCP
 *     toolset via the mirrored `.claude.json`).
 *   - Conditionally lists gemini_critic only when `geminiAvailable`.
 *   - Conditionally lists the `worker-*` background dispatcher subagents
 *     (worker-explore / worker-review / worker-plan / worker-implement /
 *     worker-test), the non-blocking-guard fact, and the worker code-search
 *     affordance only when `workerToolsAvailable` (mirrors
 *     `workerToolsEnabled()` so the snippet never names a surface gated out
 *     of the live catalog). The raw `mcp__<workers>__*` tools are named only
 *     as the guarded plumbing the dispatchers call, never as a main-agent
 *     interface.
 *   - Always names the implementer/reviewer/brainstorm/scribe native subagents
 *     (they are injected unconditionally, degrading to the lead's model rather
 *     than disappearing); `scout` is named only when `scoutAvailable` is not
 *     false, because it is dropped outright when no cheap-tier model resolves.
 *     The implementer-vs-`worker-implement` contrast is added only when worker
 *     tools are available.
 *   - Conditionally lists stand_in only when `standInAvailable`
 *     (mirrors `standInToolEnabled()`).
 *   - Conditionally lists gh-first-mate only when `agentToolsAvailable`
 *     (mirrors `agentToolsEnabled()`).
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
  compoundBrowseAvailable: boolean
  powerBrowseAvailable?: boolean
  fleetAvailable?: boolean
  agentToolsAvailable?: boolean
  /** Whether `scout` resolved a cheap-tier model and was therefore emitted.
   *  Unlike the other natives it is dropped rather than downgraded to the lead's
   *  model, so naming it unconditionally here would advertise an agent that is
   *  not in the Task enum. */
  scoutAvailable?: boolean
  /** Resolved config key per group (bare, or `gh-router-<group>` fallback on
   *  collision). Missing key → use the preferred bare key. Keeps the
   *  `mcp__<server>__<tool>` paths in this snippet pointing at OUR servers. */
  groupKeys?: Partial<Record<McpGroup, string>>
}): string {
  const key = (g: McpGroup): string => opts.groupKeys?.[g] ?? GROUP_META[g].preferredKey
  const peersKey = key("peers")
  const searchKey = key("search")
  const workersKey = key("workers")
  const orchestrateKey = key("orchestrate")
  const browserKey = key("browser")
  const decideKey = key("decide")
  const fleetKey = key("fleet")

  // Keep the browse tiers monotonic when callers pass the source-of-truth gates.
  // Compound and power browser tools can only list when the base browser server is available.
  const compoundBrowseAvailable = opts.browseAvailable && opts.compoundBrowseAvailable
  const powerBrowseAvailable = opts.browseAvailable && opts.powerBrowseAvailable === true

  const criticList: Array<string> = [
    "`codex_critic` (gpt-5.6-sol)",
    "`codex_reviewer` (gpt-5.3-codex)",
  ]
  if (opts.geminiAvailable) {
    // Both gemini personas share the gemini-3.x-pro catalog gate.
    criticList.push("`gemini_reviewer` (gemini-3.1-pro, line-level code review)")
    criticList.push("`gemini_critic` (gemini-3.1-pro)")
  }
  criticList.push("`opus_critic` (Opus 5)")

  const codexCliClause = opts.codexCli
    ? " `mcp__codex-cli__codex` dispatches to `codex-implementer` (gpt-5.3-codex with workspace-write) for end-to-end coding tasks."
    : ""

  // Paragraph 2 — capability inventory. Sentences are joined with a
  // single space; conditional sentences (workers, stand_in) only
  // appear when their gate is on, so the snippet never names a tool
  // missing from the live tools/list.
  const para2Parts: Array<string> = [
    `\`mcp__${searchKey}__code\` is the one-stop code search (no extra model call). Its DEFAULT mode (or \`mode:"semantic"\`) ranks by MEANING via ColBERT over a per-workspace index, the first thing to reach for on intent/concept questions ("where is retry/backoff handled", "how does auth work"); when that index isn't ready it transparently falls back to lexical (the response \`source\` says which engine ran). Forced modes cover the rest: \`lexical\` (BM25F-ranked + tree-sitter, best for exact symbols), \`exact\`, \`regex\`, \`complete\` (exhaustive set), \`ast_pattern\`+\`ast_lang\` for multi-line AST shapes, \`scan\` for a whole-workspace symbol outline, \`multiline\` for cross-line regex. Multiple queries can run in a single turn. The index covers code-shaped files; for unstructured files (logs, \`.csv\`, \`.env*\`, config-only wiring), \`grep\`/\`glob\` still apply.`,
  ]
  if (opts.workerToolsAvailable) {
    para2Parts.push(
      `\`worker-*\` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: \`worker-explore\` (read-only research), \`worker-review\` (reads the code to verify a change or claim), \`worker-plan\` (ordered implementation plan), \`worker-implement\` (edit/write/bash; ALWAYS runs in an isolated git worktree and returns the diff via a saved patch file; for in-place edits use the \`implementer\` subagent), \`worker-test\` (independent test author; also always worktree-isolated). The raw \`mcp__${workersKey}__*\` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have \`code_search\`.`,
    )
  }
  para2Parts.push(
    `Native subagents (Task), each in its own context so heavy work never fills yours: \`implementer\` (you know what to build), \`reviewer\` (something exists and you want it assessed, including reproducing and root-causing a failure), \`brainstorm\` (you do not yet know which approach to take)${opts.scoutAvailable === false ? "" : ", `scout` (find or understand something in the repo, cheap)"}, \`scribe\` (docs and ADRs that trail the code).`,
  )
  if (opts.workerToolsAvailable) {
    para2Parts.push(
      `For a bounded, well-scoped implementation, prefer the \`implementer\` subagent over \`worker-implement\`; reach for \`worker-implement\` only when you specifically need git-worktree isolation, parallel variants, or a throwaway experiment.`,
    )
  }
  // Orchestration group. `decompose`/`run_workflow` share the worker backend gate
  // (they dispatch models / drive workers); `verify_workflow`/`attest_step` are
  // pure and always available. Gate the mentions exactly like the live
  // tools/list so the snippet never names a tool that isn't served.
  if (opts.workerToolsAvailable) {
    para2Parts.push(
      `\`mcp__${orchestrateKey}__decompose\` composes an open-ended ask into a typed, VERIFIED workflow IR (a strong driver decorrelated by a cross-lab critic, so the decompose step isn't a single point of failure), and \`mcp__${orchestrateKey}__run_workflow\` executes that IR through a frozen kernel delivering max(orchestrated, baseline) over a sealed executable gate, so it never ships worse than a plain single-model run. \`mcp__${orchestrateKey}__verify_workflow\` checks an IR's floor invariants before you run it, and \`mcp__${orchestrateKey}__attest_step\` audits that a finished run's producers were each checked by a different lab. They suit non-trivial, role-separated asks; a trivial ask does not need them.`,
    )
  } else {
    para2Parts.push(
      `\`mcp__${orchestrateKey}__verify_workflow\` statically checks a workflow IR's floor invariants and \`mcp__${orchestrateKey}__attest_step\` audits a run's cross-lab lineage (the \`decompose\`/\`run_workflow\` composer + kernel need the worker backend, unavailable here).`,
    )
  }
  if (opts.workerToolsAvailable) {
    const skillSentence = opts.agentToolsAvailable === true
      ? "Four injected skills (invoke by name): `/gh-research` saturates an ask's unknowns into a confidence-tagged, root-cause brief that grounds planning; `/gh-orchestrate` right-sizes a blind-spot-elimination pipeline whose nodes delegate to these tools; `/gh-floor-keeper` is the done-checkpoint cross-lab verification, where different-lab reviewers propose and the executable gate decides; `/gh-first-mate` drives the durable GitHub cloud-agent loop. They suit non-trivial, role-separable work. Only executable checks are deterministic; they do not catch a wrong spec, so user-blessed acceptance criteria plus the checkpoint are the defense."
      : "Three injected skills (invoke by name): `/gh-research` saturates an ask's unknowns into a confidence-tagged, root-cause brief that grounds planning; `/gh-orchestrate` right-sizes a blind-spot-elimination pipeline whose nodes delegate to these tools; `/gh-floor-keeper` is the done-checkpoint cross-lab verification, where different-lab reviewers propose and the executable gate decides. They suit non-trivial, role-separable work. Only executable checks are deterministic; they do not catch a wrong spec, so user-blessed acceptance criteria plus the checkpoint are the defense."
    para2Parts.push(skillSentence)
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
    para2Parts.push(
      `\`mcp__${browserKey}__*\` tools drive a real Chrome / Edge browser via a local extension. Lead browse surface includes \`__navigate\` / \`__open_tab\` / \`__screenshot\` for state, visuals, and navigation.`,
    )
  }
  if (compoundBrowseAvailable) {
    para2Parts.push(
      `Compound browse surface includes \`mcp__${browserKey}__act(intent, value?)\` / \`__observe(intent?)\` / \`__extract(schema, instruction)\` / \`__find\`; an inner fast model resolves intent, find/observe yield element refs act consumes, and the lead never sees raw DOM.`,
    )
  }
  if (powerBrowseAvailable) {
    para2Parts.push(
      `Power browse surface adds \`mcp__${browserKey}__mouse\`, \`__drag\`, \`__type\`, \`__keyboard\`, \`__scroll\`, \`__eval_js\`, \`__read_page\`, \`__diagnostics\`, \`__list_tabs\`, \`__close_tab\`, \`__wait\`, and \`__download\` for direct DOM and coordinate control.`,
    )
  }
  if (opts.fleetAvailable) {
    para2Parts.push(
      `\`mcp__${fleetKey}__*\` tools drive remote ai-or-die coding sessions (list / read / create / stop / await / drive, plus remote read_file / list_dir / search / git_show); they act on a REMOTE fleet instance, not the local repo.`,
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

/**
 * Compact, gated capability SUMMARY for the spawned session's system prompt
 * (`--append-system-prompt`). The FULL per-tool inventory lives once in the
 * mirrored CLAUDE.md (buildPeerAwarenessSnippet); this ~300-token summary gives
 * the main agent high-salience awareness of what is available without
 * duplicating the full snippet in the context window every turn. Gated
 * identically to the full snippet so it never names a surface the live
 * tools/list dropped. Factual present tense, no imperatives.
 */
export function buildPeerAwarenessSummary(opts: {
  workerToolsAvailable: boolean
  standInAvailable: boolean
  browseAvailable: boolean
  fleetAvailable?: boolean
  agentToolsAvailable?: boolean
  groupKeys?: Partial<Record<McpGroup, string>>
}): string {
  const key = (g: McpGroup): string => opts.groupKeys?.[g] ?? GROUP_META[g].preferredKey
  const lines: Array<string> = [
    "## Injected capabilities (summary)",
    "",
    // The native subagents come FIRST and are named here, not only in CLAUDE.md.
    // This block is the always-in-context surface; it previously named every
    // competing surface (peer critics, workers, stand_in) and none of the
    // natives, so the only agents the lead was reminded of every turn were the
    // ones the natives overlap with. The `reviewer` clause carries the explicit
    // tiebreak because that is the one pair observed to route wrong: a live
    // session picked `codex_reviewer` for an assess-this-code task, which is
    // exactly the case `reviewer` exists for.
    `Native subagents (Task), each in its own context: \`implementer\` (you know what to build), \`reviewer\` (something exists and you want it assessed, including reproducing and root-causing a failure), \`brainstorm\` (you do not yet know which approach to take), \`scout\` (find or understand something in the repo, cheap), \`scribe\` (docs and ADRs that trail the code). They read the repo and can run things; the peer critics below cannot, so reach for \`reviewer\` when an assessment needs execution or repo context and for a critic when you already hold the artifact.`,
    `A layer of MCP tools, background workers, and skills is injected into this session. Cross-lab peer critics under \`mcp__${key("peers")}__*\` (plus the \`peer-review-coordinator\` subagent) review plans and diffs adversarially, and Claude Code's built-in \`advisor\` catches approach drift. \`mcp__${key("search")}__code\` is meaning-first code search and \`mcp__${key("search")}__web\` returns citable web sources.`,
  ]
  if (opts.workerToolsAvailable) {
    lines.push(`Background \`worker-*\` agents (explore, review, plan, implement, test) run delegated work in their own context without blocking your turn, and \`mcp__${key("orchestrate")}__*\` composes, verifies, and runs floor-raising workflows.`)
  }
  if (opts.standInAvailable) {
    lines.push(`\`mcp__${key("decide")}__stand_in\` returns a three-lab consensus for a decision when the user is unavailable.`)
  }
  if (opts.browseAvailable) {
    lines.push(`\`mcp__${key("browser")}__*\` drives a real Chrome or Edge browser.`)
  }
  if (opts.fleetAvailable) {
    lines.push(`\`mcp__${key("fleet")}__*\` drives remote ai-or-die coding sessions.`)
  }
  if (opts.agentToolsAvailable === true) {
    lines.push("In `--agents` mode you are the CEO of the product: `/gh-first-mate-conduct` is the fleet conductor — one durable loop that drives one or many repos, each by its own per-repo CEO subagent — and `/gh-first-mate-operate` is your operating protocol (niche → MVP → launch → iterate) toward a verifiable greatness bar; get verified work out of the team, never a self-reported \"done\".")
  }
  lines.push("")
  lines.push(`Each tool's own description carries when to use it and when not. The full per-tool inventory (models, gating, workers, skills) is in the "Peer review and advisor" section of your CLAUDE.md project instructions.`)
  return lines.join("\n")
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
   *   `gpt-5.4-mini` (the worker default) to be in the live catalog
   *   with `tool_calls` support AND `GH_ROUTER_DISABLE_WORKER_TOOLS=1` to
   *   be unset (see `workerToolsEnabled()`). implement's `gpt-5.6-sol` default
   *   is not gated here — if absent, implement calls return a helpful
   *   resolve error.
   * - `"stand_in"` requires all three of `gpt-5.6-sol`, `claude-opus-4-7`,
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
   * - `"fleet"` (fleet session-control tools) requires `fleetToolsEnabled()`
   *   — the operator opted in via `--fleet` or `GH_ROUTER_ENABLE_FLEET=1`.
   * - `"agents"` (first-mate cloud-agent controller tools) requires
   *   `agentToolsEnabled()` — the operator opted in via `--agents` or
   *   `GH_ROUTER_ENABLE_AGENTS=1` AND a GitHub agent token is present.
   * - "artifact" (artifact_open / artifact_poll / artifact_reply) requires
   *   the ai-or-die tab-scoped env trio (`AIORDIE_BASE_URL`,
   *   `AIORDIE_TOKEN`, `AIORDIE_SESSION_ID`; see `artifactToolsEnabled()`
   *   in `lib/mcp-capabilities.ts`).
   *
   * Absent on `web` / `code`; those are always available once the proxy is
   * in claude mode (loopback + nonce already gate `/mcp` itself).
   */
  capability?: "worker" | "stand_in" | "browser" | "browser_compound" | "browser_power" | "browse_agent" | "fleet" | "agents" | "artifact"
  /**
   * Server-side handler. Receives the raw `arguments` object from the
   * `tools/call` request and an optional AbortSignal that is signalled
   * when a `notifications/cancelled` arrives for this call. Returns an
   * MCP `tool result` envelope (content blocks + optional `isError`).
   *
   * Content blocks are `text` OR `image` (see `~/lib/attachments`). The image
   * variant exists because a tool that captures pixels — `browser_screenshot`
   * above all — previously had no way to hand them back, and stringified the
   * base64 into a text block instead: the caller never saw the image and paid
   * ~130x the tokens of a native image block for the privilege. A tool that
   * returns an image MUST put a text block first; see `mcpTextAndImage`.
   */
  handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpToolResult>
}

const WEB_SEARCH_DESCRIPTION =
  "Web search via GitHub Copilot's MCP that returns answer text plus source URLs the caller can cite. It accepts a natural-language `query`; the upstream provider rewrites for the search index and the handler formats any references as markdown links. Use for current external information such as API documentation, error-message diagnosis, upstream issue searches, and claims that need web sources. Not for local repository discovery or code navigation, use code, Read, Grep, or Glob for workspace content. Prefer it over the built-in WebSearch when source URLs are needed or the built-in surface is geographically constrained."

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

/**
 * Model-override tier ladder surfaced on the read-heavy workers
 * (explore / implement / review). The caller picks a model by task weight;
 * all three tiers are 1M-context, and `high` is the recommended reasoning
 * depth for the ladder (flash tops out at high; sol/terra go higher if the
 * caller wants). Appended to those tools' `model` param description so the
 * lead has actionable override guidance instead of a bare free string.
 */
const WORKER_TIER_GUIDANCE =
  " Override by task weight: `gpt-5.6-sol` (heavy/deep), "
  + "`gpt-5.6-terra` (moderate), `gemini-3.6-flash` (light/cheap) — all "
  + "1M context; pair with thinking:'high'."

/**
 * Read-only contract, appended to the `explore` / `review` / `plan` tool
 * descriptions.
 *
 * Those three say "read-only" of their TOOLSET, which describes what the worker
 * may do but not what the caller gets back. The consequence is the part a caller
 * acts on: the returned text is the ONLY artifact. Nothing is written, nothing
 * is staged, and the transcript is not persisted — so a caller that wanted a
 * file changed has to route to `implement`, and a caller that wanted the
 * findings kept has to keep them itself.
 *
 * This is not redundant with "read-only toolset": a model reading "it has
 * read-only tools" can still reasonably expect the worker to leave something
 * behind (a report file, a scratch note). Stating the output contract closes
 * that gap in one clause.
 */
const WORKER_READ_ONLY_NOTE =
  " Strictly read-only: it changes nothing on disk, and its returned text is "
  + "the only artifact it produces — route to `implement` or `test` when a file "
  + "actually needs to change."

/**
 * Oversized-result contract, appended to EVERY `worker_*` tool description.
 *
 * `relaySafeText` (`~/lib/worker-agent/relay-cap`) is the final transform at
 * the MCP boundary for every worker mode: a result over the relay cap spills IN
 * FULL to a file and returns a bounded head preview plus that path. The
 * mechanism already worked; what was missing is that the model was never TOLD,
 * so a truncated result arrived with a path the model had to infer was real and
 * readable from the trailer alone.
 *
 * It earns its bytes under the "ruthlessly minimal tool surface" rule because
 * it is directly actionable: on truncation the next call is a `read` of that
 * path, not a re-run of the worker. That matters most on the read-only modes
 * (`explore`/`review`/`plan`), where the transcript is never persisted and a
 * long investigation summarized past the cap is otherwise unrecoverable.
 */
const WORKER_OVERSIZED_RESULT_NOTE =
  " If the result is too large to relay it is truncated to a preview and the "
  + "FULL text is written to a file, whose absolute path is in the returned "
  + "text; read that file rather than re-running the worker."

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
      // for the full UPSTREAM_FETCH_TIMEOUT_MS window (0 disables the timeout) —
      // enough concurrent disconnects could fully stall /mcp.
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
                text: "web: arguments.query is required (must be a non-empty string)",
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
            content: [{ type: "text", text: `web failed: ${msg}` }],
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
        "`workspace` is any absolute path to a DIRECTORY the proxy " +
        "process can read — typically the project root or a sub-tree " +
        "you're working in. It must be a directory, not a file; to " +
        "narrow to one file or a set of them, keep `workspace` at the " +
        "root and pass `file_glob`. Each response also carries a " +
        "tree-sitter structural " +
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
    // explore / implement / review / plan / test are autonomous worker tools
    // backed by the Pi agent loop (`src/lib/worker-agent/engine.ts`) and routed
    // through per-mode defaults: explore -> `gemini-3.6-flash` (high), review ->
    // `gemini-3.1-pro-preview` (xhigh clamped to high by the default model), plan
    // -> `claude-opus-5` (xhigh), and implement/test -> `gpt-5.6-sol` (xhigh). An
    // explicit `model` arg wins.
    //
    // GATING (`capability: "worker"`): the MCP handler drops these entries from
    // `tools/list` and `tools/call` when `workerToolsEnabled()` is false. The gate
    // fires when (a) the worker sentinel (`gpt-5.4-mini`) is missing from the live
    // Copilot catalog or lacks `tool_calls`, OR (b) the operator opted out via
    // `GH_ROUTER_DISABLE_WORKER_TOOLS=1`. Defense-in-depth: the gate is checked at
    // BOTH list-time and call-time so a client that hard-codes the tool name can't
    // bypass the list-side filter. If a per-mode default such as `gpt-5.6-sol` or
    // `gemini-3.6-flash` is absent, that mode returns a helpful resolve error.
    //
    // SCHEMA SHAPE: `prompt` is required; `model` / `thinking` are optional
    // fine-tunes the worker engine validates against the live catalog (unknown
    // model -> isError envelope with the candidate list; unsupported thinking-tier
    // -> silent clamp to the model's max). `implement` and `test` add
    // `worktree: boolean` to opt the worker into an isolated git worktree when
    // atomic isolation matters more than in-place speed.
    //
    // HANDLER: thin closure over `runWorkerAgent`; every safety check (semaphore,
    // model resolution, workspace canonicalization, worktree provisioning, budget,
    // audit log, cleanup) lives inside the engine. The MCP layer only translates
    // the JSON-RPC arguments into a typed `WorkerAgentOpts` and forwards the
    // resulting `{text, isError?}` envelope verbatim.
    {
      toolNameHttp: "worker_defaults",
      group: "workers",
      capability: "worker",
      description:
        "Sets or clears process-wide worker model/reasoning defaults and returns "
        + "the full effective table. Omit arguments to inspect current values. "
        + "Per-call worker arguments still take precedence; values are in-memory "
        + "and apply to every client served by this process.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: WORKER_MODES,
            description: "Worker mode to set or clear.",
          },
          model: {
            type: "string",
            description: "Copilot catalog model id to use by default for the mode.",
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description: "Requested default reasoning level; clamped per run for the selected model.",
          },
          clear: {
            type: "boolean",
            description: "When true, clears both overrides for the selected mode.",
          },
          clearAll: {
            type: "boolean",
            description: "When true, clears overrides for every worker mode.",
          },
        },
      },
      async handler(args: Record<string, unknown>): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        const mode = typeof args.mode === "string"
          && (WORKER_MODES as ReadonlyArray<string>).includes(args.mode)
          ? args.mode as WorkerMode
          : undefined
        const model = typeof args.model === "string" ? args.model : undefined
        const thinking = typeof args.thinking === "string"
          && (WORKER_THINKING_LEVELS as ReadonlyArray<string>).includes(args.thinking)
          ? args.thinking as WorkerThinkingLevel
          : undefined
        const clear = args.clear === true
        const clearAll = args.clearAll === true
        const invalid =
          (args.mode !== undefined && mode === undefined)
          || (args.model !== undefined && model === undefined)
          || (args.thinking !== undefined && thinking === undefined)
          || (args.clear !== undefined && typeof args.clear !== "boolean")
          || (args.clearAll !== undefined && typeof args.clearAll !== "boolean")
          || (clearAll && (mode !== undefined || model !== undefined || thinking !== undefined || args.clear !== undefined))
          || (clear && (mode === undefined || model !== undefined || thinking !== undefined))
          || (!clearAll && !clear && (model !== undefined || thinking !== undefined) && mode === undefined)
        if (invalid) {
          return {
            content: [{ type: "text", text: "worker_defaults: use mode with model/thinking or clear:true; clearAll:true must stand alone" }],
            isError: true,
          }
        }

        if (clearAll) resetAllWorkerSessionDefaults()
        else if (clear && mode) resetWorkerSessionDefault(mode)
        else if (mode && (model !== undefined || thinking !== undefined)) {
          const current = resolveModeDefaults(mode)
          const validation = resolveModelAndThinking({
            model: model ?? current.model,
            thinking: thinking ?? current.thinking,
          })
          if (!validation.ok) {
            return {
              content: [{ type: "text", text: validation.error }],
              isError: true,
            }
          }
          setWorkerSessionDefault(mode, { model, thinking })
        }

        const table = Object.fromEntries(
          WORKER_MODES.map((workerMode) => [workerMode, resolveModeDefaults(workerMode)]),
        )
        // The catalog rides along ONLY on a pure inspect (no mutation args),
        // which is the call the tool's own description invites: "Omit
        // arguments to inspect current values". A mutation response does not
        // need it, and paying ~2KB on every set/clear would be exactly the
        // always-on cost the minimal-surface rule exists to prevent.
        const body: Record<string, unknown> = { ...table }
        if (!clearAll && !clear && mode === undefined) {
          body.catalog = buildCatalogView()
        }
        return { content: [{ type: "text", text: JSON.stringify(body) }] }
      },
    },
    {
      toolNameHttp: "explore",
      group: "workers",
      capability: "worker",
      description:
        "Runs as the background `worker-explore` agent. Dispatch via the Agent tool (subagent_type: worker-explore) so the turn is never blocked; the result arrives as a completion notification. "
        + "Read-only investigation by an autonomous worker (Pi runtime; "
        + "default model `gemini-3.6-flash` at high reasoning, override via "
        + "the `model` arg with any Copilot-catalog model that advertises "
        + "`tool_calls`). It has read, glob, grep, semantic-first code search, "
        + "web search, fetch_url, advisor, update_plan, and read-only toolbelt "
        + "tools, and it returns a single text answer. Use for bounded research, "
        + "repo discovery, dependency investigation, or multi-file reading that "
        + "would otherwise consume the lead context window. Not for implementation, "
        + "test authoring, or verification of a concrete diff; use implement, test, "
        + "or review for those scopes. Brief the investigation goal and constraints, "
        + "not step-by-step tool semantics."
        + WORKER_READ_ONLY_NOTE
        + WORKER_OVERSIZED_RESULT_NOTE,
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
              + "gemini-3.6-flash). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch."
              + WORKER_TIER_GUIDANCE,
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description:
              "Optional reasoning depth. Use worker_defaults to inspect the "
              + "effective value. Silently clamped to the model's allowed range; \"off\" drops "
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
          maxWallClockMs: {
            type: "integer",
            description:
              "Optional per-call wall-clock budget in ms; default 6h "
              + "(21600000). Clamped just under the MCP tool-call "
              + "ceiling (the injected MCP tool-call timeout minus a "
              + "15-min teardown headroom) so the worker aborts "
              + "gracefully with its partial work rather than being "
              + "hard-killed; the effective value is reported in the "
              + "result when a larger value is clamped down.",
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
        "Runs as the background `worker-implement` agent. Dispatch via the Agent tool (subagent_type: worker-implement) so the turn is never blocked; the result arrives as a completion notification. "
        + "Delegates a scoped coding task to an autonomous worker (Pi runtime; "
        + "default model `gpt-5.6-sol` at xhigh reasoning, override via `model` "
        + "with any Copilot-catalog model that advertises `tool_calls`). It has "
        + "the explore read-only tools plus edit, write, bash, and codex_review, "
        + "and it returns its final text with any changed files or worktree diff. "
        + "Use for bounded implementation work that may take a while or benefits "
        + "from isolated worker context. Not for pure research, planning, review, "
        + "or independent test authoring; use explore, plan, review, or test for "
        + "those scopes. ALWAYS runs in an isolated git worktree and returns the "
        + "diff via a saved patch file (a `--stat` summary + a bounded preview + "
        + "the patch path; a small diff is inlined in full) — it never edits your "
        + "working tree, and it HARD-ERRORS if the workspace is not a git "
        + "repository. For in-place edits, use the native `implementer` subagent."
        + WORKER_OVERSIZED_RESULT_NOTE,
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
              "Ignored — worker_implement ALWAYS runs in an isolated "
              + "git worktree and returns the diff (retained for "
              + "compatibility; worktree:false is overridden with a "
              + "note). For in-place edits, use the `implementer` "
              + "subagent.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gpt-5.6-sol). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch."
              + WORKER_TIER_GUIDANCE,
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description:
              "Optional reasoning depth. Use worker_defaults to inspect the "
              + "effective value. Silently clamped to the model's allowed range; \"off\" drops "
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
              + "rejected). Must be inside a git repo (implement always "
              + "runs in a worktree).",
          },
          maxWallClockMs: {
            type: "integer",
            description:
              "Optional per-call wall-clock budget in ms; default 6h "
              + "(21600000). Clamped just under the MCP tool-call "
              + "ceiling (the injected MCP tool-call timeout minus a "
              + "15-min teardown headroom) so the worker aborts "
              + "gracefully with its partial work rather than being "
              + "hard-killed; the effective value is reported in the "
              + "result when a larger value is clamped down.",
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
        "Runs as the background `worker-review` agent. Dispatch via the Agent tool (subagent_type: worker-review) so the turn is never blocked; the result arrives as a completion notification. "
        + "Read-only code review by an autonomous worker (Pi runtime; default "
        + "model `gemini-3.1-pro-preview`, default thinking xhigh clamped to high "
        + "for that model, override via `model` with any Copilot-catalog model "
        + "that advertises `tool_calls`). It has the same read-only toolset as "
        + "explore and verifies claims against surrounding repository context before "
        + "returning severity-ranked findings with `file:line` citations. Use for "
        + "reviewing a change, diff, or correctness claim when the reviewer should "
        + "read the code itself rather than trusting a pasted artifact. Not for "
        + "architecture critique, implementation, or test authoring; use codex_critic "
        + "or gemini_critic for design review, implement for edits, and test for "
        + "independent test creation."
        + WORKER_READ_ONLY_NOTE
        + WORKER_OVERSIZED_RESULT_NOTE,
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
              + "gemini-3.1-pro-preview). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch."
              + WORKER_TIER_GUIDANCE,
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description:
              "Optional reasoning depth (defaults to xhigh, clamped to high "
              + "for the default review model). Silently clamped to the model's "
              + "allowed range; \"off\" drops the parameter entirely.",
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
          maxWallClockMs: {
            type: "integer",
            description:
              "Optional per-call wall-clock budget in ms; default 6h "
              + "(21600000). Clamped just under the MCP tool-call "
              + "ceiling (the injected MCP tool-call timeout minus a "
              + "15-min teardown headroom) so the worker aborts "
              + "gracefully with its partial work rather than being "
              + "hard-killed; the effective value is reported in the "
              + "result when a larger value is clamped down.",
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
        "Runs as the background `worker-plan` agent. Dispatch via the Agent tool (subagent_type: worker-plan) so the turn is never blocked; the result arrives as a completion notification. "
        + "Read-only implementation planning by an autonomous worker (Pi runtime; "
        + "default model `claude-opus-5` at xhigh reasoning, override via "
        + "`model` with any Copilot-catalog model that advertises `tool_calls`). "
        + "It has the same read-only toolset as explore and returns a concrete, "
        + "ordered implementation plan covering files, approach, risks, and how "
        + "acceptance criteria will be verified. Use before coding when the task "
        + "needs repo-grounded sequencing or acceptance criteria translated into "
        + "implementation steps. Not for editing files, running an implementation, "
        + "writing tests, or adversarial review; use implement, test, or review for "
        + "those scopes."
        + WORKER_READ_ONLY_NOTE
        + WORKER_OVERSIZED_RESULT_NOTE,
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
              + "claude-opus-5). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description:
              "Optional reasoning depth. Use worker_defaults to inspect the "
              + "effective value. Silently clamped to the model's allowed range; \"off\" drops "
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
          maxWallClockMs: {
            type: "integer",
            description:
              "Optional per-call wall-clock budget in ms; default 6h "
              + "(21600000). Clamped just under the MCP tool-call "
              + "ceiling (the injected MCP tool-call timeout minus a "
              + "15-min teardown headroom) so the worker aborts "
              + "gracefully with its partial work rather than being "
              + "hard-killed; the effective value is reported in the "
              + "result when a larger value is clamped down.",
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
        "Runs as the background `worker-test` agent. Dispatch via the Agent tool (subagent_type: worker-test) so the turn is never blocked; the result arrives as a completion notification. "
        + "Independent adversarial test authoring by an autonomous worker (Pi "
        + "runtime; default model `gpt-5.6-sol` at xhigh reasoning, override via "
        + "`model` with any Copilot-catalog model that advertises `tool_calls`). "
        + "It has the same read/write toolset as implement and writes tests that "
        + "try to break the implementation through edge cases, error paths, and "
        + "acceptance criteria, then runs them and reports pass/fail. Use when a "
        + "separate test author should challenge an implementation without modifying "
        + "the production code to make tests pass. Not for implementing fixes, broad "
        + "research, or code review; use implement, explore, or review for those scopes. "
        + "ALWAYS runs in an isolated git worktree and returns the test diff via a "
        + "saved patch file (a `--stat` summary + a bounded preview + the patch path; "
        + "a small diff is inlined in full) — it never edits your working tree, and it "
        + "HARD-ERRORS if the workspace is not a git repository. For in-place test "
        + "authoring, use the native `implementer` subagent."
        + WORKER_OVERSIZED_RESULT_NOTE,
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
              "Ignored — worker_test ALWAYS runs in an isolated git "
              + "worktree and returns the diff (retained for "
              + "compatibility; worktree:false is overridden with a "
              + "note). For in-place test authoring, use the "
              + "`implementer` subagent.",
          },
          model: {
            type: "string",
            description:
              "Optional Copilot catalog model id (defaults to "
              + "gpt-5.6-sol). Must advertise tool_calls "
              + "support; the engine emits an isError envelope listing "
              + "the eligible catalog models on mismatch.",
          },
          thinking: {
            type: "string",
            enum: WORKER_THINKING_LEVELS,
            description:
              "Optional reasoning depth. Use worker_defaults to inspect the "
              + "effective value. Silently clamped to the model's allowed range; \"off\" drops "
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
              + "rejected). Must be inside a git repo (test always "
              + "runs in a worktree).",
          },
          maxWallClockMs: {
            type: "integer",
            description:
              "Optional per-call wall-clock budget in ms; default 6h "
              + "(21600000). Clamped just under the MCP tool-call "
              + "ceiling (the injected MCP tool-call timeout minus a "
              + "15-min teardown headroom) so the worker aborts "
              + "gracefully with its partial work rather than being "
              + "hard-killed; the effective value is reported in the "
              + "result when a larger value is clamped down.",
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
      group: "orchestrate",
      description:
        "Statically verifies a workflow IR against the orchestration floor "
        + "invariants before the kernel runs it. It accepts the typed WorkflowIR "
        + "as `ir` and an optional `knownGateIds` allowlist, then returns "
        + "{ok, violations:[{code, message, nodeId?}]} with stable violation codes "
        + "such as NO_BASELINE, SELECTOR_NOT_RAW_ASK, SAME_LAB_CHECK, ORPHAN_NODE, "
        + "or MISSING_INTEGRATION_GATE. Use immediately after composing or receiving "
        + "a workflow IR, especially before paying for run_workflow, so structural "
        + "floor failures can be fixed while still in data form. Not a runner, model "
        + "reviewer, or proof that the user's spec is correct; use run_workflow to "
        + "execute sealed gates and use critic/review tools for advisory review.",
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
    {
      // decompose — compose a VERIFIED workflow IR from an open-ended ask. A
      // single driver model drafts the IR; the static verifier checks it; on a
      // violation the driver re-drafts with the violations as feedback; a
      // cross-lab critic reviews a clean draft (bounded). Gated `capability:
      // "worker"` (it dispatches models; the gpt-5.6-sol driver errors at call time
      // if absent, like implement).
      toolNameHttp: "decompose",
      group: "orchestrate",
      capability: "worker",
      description:
        "Composes a verified, tool-routed WorkflowIR from an open-ended software "
        + "ask. A strong driver model drafts the IR, the static verifier checks floor "
        + "invariants, the driver re-drafts on violations, and a cross-lab critic "
        + "reviews a clean draft; optional `context` supplies repo facts, constraints, "
        + "or research findings to the driver. It returns {ok, ir, rounds, concerns?} "
        + "on success, or {ok:false, violations, rounds} when it cannot converge. "
        + "Use for non-trivial, role-separated asks where blind-spot reduction and "
        + "sealed-gate structure justify orchestration. Not for trivial edits, direct "
        + "implementation, or execution; use implement for a scoped code change and "
        + "run_workflow only after the IR is verified.",
      inputSchema: {
        type: "object",
        required: ["ask"],
        additionalProperties: false,
        properties: {
          ask: {
            type: "string",
            description: "The open-ended software task to decompose into a verified workflow.",
          },
          context: {
            type: "string",
            description: "Optional extra context (repo facts, constraints) for the driver.",
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
        const ask = typeof args.ask === "string" ? args.ask.trim() : ""
        if (!ask) {
          return { content: [{ type: "text", text: "decompose: arguments.ask is required (a non-empty string)" }], isError: true }
        }
        const deps = buildLiveDecomposeDeps({
          toolCatalog:
            "roles: research, plan, implement, review, test, verify, baseline, "
            + "selector, integration. Producer workers: explore/plan/implement/"
            + "test. Cross-lab critics: codex_critic (openai), gemini_critic "
            + "(google), opus_critic (anthropic). producerLab/checkerLab MUST be a "
            + "lab id: exactly one of openai, google, anthropic. Gate kinds: "
            + "executable (gateId is exactly one of the SEALED ids default-ci | "
            + "typecheck-test | typecheck-only), cross_lab (a different-lab critic), "
            + "none.",
          critic: { model: "gemini-3.1-pro-preview", endpoint: "/v1/chat/completions", effort: "high" },
          signal,
        })
        const context = typeof args.context === "string" ? args.context : undefined
        const result = await decomposeWorkflow(ask, deps, { maxRounds: 3, context })
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok }
      },
    },
    {
      // run_workflow — execute a VERIFIED workflow IR through the frozen kernel.
      // The kernel (not the model) runs the baseline + the orchestrated DAG,
      // executes the SEALED gate the caller names by id (never a model-authored
      // command), and ships max(orchestrated, baseline) by champion-retention.
      // Gated `capability: "worker"`: it drives worker agents + worktrees + real
      // gate subprocesses, so it shares the worker availability gate.
      toolNameHttp: "run_workflow",
      group: "orchestrate",
      capability: "worker",
      description:
        "Executes a verified WorkflowIR through the frozen orchestration kernel. "
        + "The kernel runs a single-model baseline beside the orchestrated DAG, "
        + "gates producers over the sealed executable `gateId` selected by the "
        + "caller, and returns {ok, outcome:{status, winner?, artifact?, reason, "
        + "gatesPassed?}}. It uses champion retention: the orchestrated candidate "
        + "wins only when it does not regress the baseline's executable checks; "
        + "otherwise the baseline ships. Use after decompose and verify_workflow "
        + "for non-trivial asks in a git workspace with a meaningful sealed gate. "
        + "Not for composing an IR, performing advisory review, or running arbitrary "
        + "model-authored shell commands; use decompose or verify_workflow before "
        + "this tool, and use ordinary tests or review tools outside the workflow kernel.",
      inputSchema: {
        type: "object",
        required: ["ir", "ask", "workspace", "gateId"],
        additionalProperties: false,
        properties: {
          ir: { type: "object", description: "The verified WorkflowIR to execute." },
          ask: { type: "string", description: "The raw user ask (the baseline and producers run on this)." },
          workspace: { type: "string", description: "Absolute path to the git workspace the kernel runs in." },
          gateId: {
            type: "string",
            enum: ["default-ci", "typecheck-test", "typecheck-only"],
            description: "Which SEALED executable gate to run (the kernel owns the commands).",
          },
          tiePolicy: {
            type: "string",
            enum: ["strict", "superset"],
            description: "On an exact tie vs the baseline: 'strict' ships the baseline (default), 'superset' ships the orchestrated candidate.",
          },
          maxRetries: { type: "number", description: "Retries after the first attempt for a loop node / baseline infra failure." },
        },
      },
      async handler(
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        const result = await runWorkflowLive({
          ir: args.ir,
          ask: typeof args.ask === "string" ? args.ask : "",
          workspace: typeof args.workspace === "string" ? args.workspace : "",
          gateId: typeof args.gateId === "string" ? args.gateId : "",
          tiePolicy: args.tiePolicy === "superset" ? "superset" : "strict",
          maxRetries: typeof args.maxRetries === "number" ? args.maxRetries : undefined,
          signal,
        })
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok }
      },
    },
    {
      // attest_step — code-driven attestation that a run honored bias isolation:
      // every producer was checked by a DIFFERENT lab on its FINAL artifact hash.
      // No capability gate (pure logic, like verify_workflow). For workflows
      // composed OUTSIDE the kernel, where the model self-reports its lineage and
      // we want a deterministic check rather than trust.
      toolNameHttp: "attest_step",
      group: "orchestrate",
      description:
        "Audits self-reported producer lineage for bias-isolation structure. It "
        + "accepts `nodes` with each producer lab, final artifact hash, and checker "
        + "hashes, then returns {attested, recommendation:'accept'|'ship_baseline', "
        + "nodes:[{id, attested, reason}]}. The check passes only when every producer "
        + "has a different-lab check over the same final artifact hash, so missing, "
        + "same-lab, or stale checks fail closed to a baseline recommendation. Use "
        + "for workflows composed outside run_workflow, where lineage is self-reported "
        + "and needs a deterministic completeness gate. Not a security boundary, hash "
        + "authenticator, or executor; run_workflow is the kernel-owned path when the "
        + "router must control artifacts, gates, and hashes.",
      inputSchema: {
        type: "object",
        required: ["nodes"],
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            description:
              "The run's producer lineage to attest. Each: {id, producerLab, "
              + "artifactHash (the producer's final artifact hash), checks: "
              + "[{checkerLab, verifiedArtifactHash}]}.",
            items: {
              type: "object",
              required: ["id", "producerLab", "artifactHash", "checks"],
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                producerLab: { type: "string", description: "The lab that produced this node (openai/google/anthropic/...)." },
                artifactHash: { type: "string", description: "Content hash of the producer's FINAL artifact." },
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["checkerLab", "verifiedArtifactHash"],
                    additionalProperties: false,
                    properties: {
                      checkerLab: { type: "string" },
                      verifiedArtifactHash: { type: "string", description: "The hash this check actually verified (must equal artifactHash)." },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async handler(args: Record<string, unknown>): Promise<{
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }> {
        const nodes = Array.isArray(args.nodes) ? (args.nodes as AttestNode[]) : []
        const result = attestRun({ nodes })
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
        "Runs as the background `worker-browse` agent. Dispatch via the Agent tool (subagent_type: worker-browse) so the turn is never blocked; the result arrives as a completion notification. "
        + "A Pi-driven autonomous browser worker (default model `gpt-5.4-mini`) "
        + "drives a real browser to accomplish `task`, keeps raw DOM and page "
        + "snapshots inside its own context, and returns a single text result. "
        + "Use for delegated multi-step web tasks such as comparing prices, logging "
        + "into a dashboard, or summarizing pages when the lead does not need to "
        + "steer each click. Not for direct in-context browser control, screenshots, "
        + "or precise element interactions; use the `browser` MCP tools for those. "
        + "Pass `sessionId` to continue a prior browse session, or omit it for a "
        + "fresh isolated session; multiple calls run as parallel sessions on the "
        + "shared browser."
        + WORKER_OVERSIZED_RESULT_NOTE,
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
      // stand_in — three-lab away-mode advisor. Polls gpt-5.6-sol xhigh +
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
        "Three-lab away-mode decision tiebreak advisor for moments when the "
        + "user is unavailable and the agent is stuck between two or more concrete "
        + "options. It polls gpt-5.6-sol, Opus 4.7, and gemini-3.1-pro-preview across "
        + "blind and informed voting rounds, then returns a ranked-choice verdict "
        + "such as consensus, majority, no_consensus, or need_more_info. Use when "
        + "work would otherwise halt on a bounded choice the user would normally "
        + "make. If every provided option is inadequate, the panel may flag a concrete "
        + "better unlisted option in `notes` so you can re-invoke with a revised set. "
        + "The three panel models are cold-start — no repo, transcript, "
        + "or memory access — and see only your decision, options, and context, "
        + "so the `context` argument must carry all the background they need to "
        + "judge. Not for code review, open-ended exploration, single-model second "
        + "opinions, or bypassing confirmation on irreversible actions such as push, "
        + "delete, drop, or deploy; use peer-review-coordinator or the individual "
        + "critics for review and still ask the user for destructive actions.",
      inputSchema: {
        type: "object",
        required: ["decision", "options", "context"],
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
              "2-6 concrete options curated by the caller for the panel to vote on. "
              + "The panel may surface a gated unlisted alternative in `notes`, but "
              + "does not replace the caller's option set. The verdict cites the "
              + "chosen option by `id`.",
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
              "REQUIRED. The three panel models are cold-start: no access to your "
              + "repository, prior transcript, or memory — they see ONLY this "
              + "decision + options + context. Include everything needed to decide "
              + "well: the constraints that matter, the relevant code or excerpts, "
              + "prior decisions not to relitigate, and what a good outcome looks "
              + "like. Thin context yields a weak verdict. (On the JSON transport a "
              + "~32KB size guard applies; the SSE transport has no such limit.)",
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
    ...ARTIFACT_TOOLS,
    ...FLEET_TOOLS,
    ...FIRST_MATE_TOOLS,
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
 * forwards to `runWorkerAgent`. Outside serve mode, `workspace` defaults
 * to the proxy's launch cwd; serve mode requires an explicit/header-derived
 * workspace. Callers can override via the optional `workspace` arg
 * (absolute paths only — enforced here). The engine performs every
 * deeper validation (model existence, thinking clamp, worktree
 * provisioning, semaphore acquisition, workspace realpath +
 * accessibility) and never throws — its `{text, isError?}` envelope
 * is forwarded verbatim into the MCP `tool result` shape.
 *
 * Arg-validation policy mirrors `web`'s pattern: shape errors
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
  const ALLOWED_THINKING = WORKER_THINKING_LEVELS
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

  // `implement`/`test` ALWAYS run in an isolated git worktree — isolation is
  // mandatory, not caller-tunable (a flag that had to survive a free-text
  // Agent-tool round-trip silently dropped in prod, editing the real repo).
  // A caller passing `worktree: false` is overridden with a note; for in-place
  // edits the native `implementer` subagent is the right tool. We still reject
  // a non-boolean so a schema-ignoring client gets a clean error.
  let worktree: boolean | undefined
  let worktreeNote = ""
  if (mode === "implement" || mode === "test") {
    if (args.worktree !== undefined && typeof args.worktree !== "boolean") {
      return {
        content: [
          { type: "text", text: `worker_${mode}: arguments.worktree must be a boolean when provided` },
        ],
        isError: true,
      }
    }
    worktree = true
    if (args.worktree === false) {
      worktreeNote =
        `[note: worker_${mode} always runs in an isolated git worktree; the requested `
        + "worktree:false was overridden. For in-place edits, use the `implementer` subagent.]\n\n"
    }
  }

  // Optional workspace override. Outside serve mode, default is the proxy's
  // launch cwd; in serve mode this proxy is machine-wide, so the workspace
  // must come from the per-session header (injected by handler.ts as
  // args.workspace) or from an explicit tool argument. Absolute-only at the
  // boundary so a relative path doesn't silently resolve against process.cwd().
  let workspace: string
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
  } else if (state.serveMode) {
    return {
      content: [
        {
          type: "text",
          text: `worker_${mode}: a workspace is required. This is a machine-wide github-router serve; pass the absolute path of the project you are working in as \`workspace\`.`,
        },
      ],
      isError: true,
    }
  } else {
    workspace = process.cwd()
  }

  // Optional per-call wall-clock override (ms). Validate as a positive
  // integer, then CLAMP to `workerWallClockCeilingMs()` (the injected MCP
  // tool-call timeout minus the teardown headroom) so a caller can never grant
  // a worker a budget that would let the harness hard-kill it mid-run — the
  // worker must retain enough headroom to abort gracefully and deliver its
  // partial work. When we clamp a larger request down, we report the effective
  // value in the returned text so the caller isn't silently overridden.
  let maxWallClockMs: number | undefined
  let clampNote = ""
  if (args.maxWallClockMs !== undefined) {
    const raw = args.maxWallClockMs
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return {
        content: [
          {
            type: "text",
            text: `worker_${mode}: arguments.maxWallClockMs must be a positive integer (milliseconds) when provided`,
          },
        ],
        isError: true,
      }
    }
    const ceiling = workerWallClockCeilingMs()
    maxWallClockMs = Math.min(raw, ceiling)
    if (raw > ceiling) {
      clampNote =
        `[note: maxWallClockMs ${raw} exceeds the per-call ceiling; clamped to `
        + `${ceiling} ms (the MCP tool-call timeout ${resolveMcpToolTimeoutMs()} ms `
        + `minus the ${MCP_TIMEOUT_HEADROOM_MS} ms teardown headroom) so the worker `
        + "aborts gracefully rather than being hard-killed mid-run.]\n\n"
    }
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
    maxWallClockMs,
    signal,
  })
  // Notes are prefixes that MUST survive — reserve their bytes so the FINAL
  // composed string (`clampNote + worktreeNote + body`) honors the relay cap,
  // and truncate only the worker body (the last transform before returning).
  const notePrefix = `${clampNote}${worktreeNote}`
  const body = await relaySafeText(result.text, Buffer.byteLength(notePrefix, "utf8"))
  return {
    content: [{ type: "text", text: `${notePrefix}${body}` }],
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
  // on the same session. The suffix MUST survive, so reserve its bytes and cap
  // the worker body, then append the suffix — the final string honors the cap.
  const sessionSuffix = `\n\n[browse session: ${sessionId}]`
  const body = await relaySafeText(result.text, Buffer.byteLength(sessionSuffix, "utf8"))
  return {
    content: [
      {
        type: "text",
        text: `${body}${sessionSuffix}`,
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
 * Arg-validation policy mirrors `runWorkerToolCall` and `web`:
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
export async function runStandInToolCall(
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

  const context = typeof args.context === "string" ? args.context : ""
  if (!context.trim()) {
    return {
      content: [
        {
          type: "text",
          text:
            "stand_in: arguments.context is required (non-empty string). The panel "
            + "is cold-start and sees only decision + options + context; include the "
            + "constraints, relevant code, and success criteria needed to decide.",
        },
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

/**
 * Every exact `mcp__<key>__<tool>` name github-router injects, for the given
 * resolved group keys (`peers`/`search`/… → their collision-resolved mcpServers
 * key). A SUPERSET — it ignores per-tool capability gates because an allow-list
 * entry for a tool that isn't actually served is inert, which keeps it correct
 * as gates change and as tools are added.
 *
 * Used to seed CloudCLI's `localStorage['claude-settings'].allowedTools` so its
 * Agent-SDK `canUseTool` auto-approves our MCP tools in PLAN mode. `canUseTool`
 * does EXACT tool-name matching (no `mcp__<server>` wildcard — see
 * `matchesToolPermission` in CloudCLI's `claude-sdk.js`), so bare `mcp__peers`
 * would NOT cover `mcp__peers__gemini_critic`; the exact names are required.
 * This is the ONLY lever for plan mode: bypass mode skips `canUseTool`, and the
 * mirror `settings.json permissions.allow` is NOT consulted by `canUseTool`
 * (which reads `sdkOptions.allowedTools`, seeded from this localStorage key).
 */
export function enumerateInjectedMcpToolNames(
  groupKeys: Partial<Record<McpGroup, string>>,
  opts: { codexCli?: boolean } = {},
): string[] {
  const names: string[] = []
  const peersKey = groupKeys.peers
  if (peersKey) {
    for (const p of [...PERSONAS_READ, ...PERSONAS_WRITE]) {
      names.push(`mcp__${peersKey}__${p.toolNameHttp}`)
    }
  }
  for (const t of NON_PERSONA_MCP_TOOLS) {
    const key = groupKeys[t.group]
    if (key) names.push(`mcp__${key}__${t.toolNameHttp}`)
  }
  if (opts.codexCli) names.push("mcp__codex-cli__codex")
  return [...new Set(names)]
}
