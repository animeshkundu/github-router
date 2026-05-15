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

import { searchWeb } from "~/services/copilot/web-search"

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
 * timer that previously broke xhigh on gpt-5.5 (~56s wall) and
 * claude-opus-4-7 (high+ thinking budgets). All four personas now expose
 * all four effort tiers with `high` default; SSE handles the long tail
 * transparently to the user.
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
   *  bridge can't run this model). gemini-3.x and claude-opus-4-7 both
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

const GEMINI_CRITIC_BASE = `You are gemini-critic, an adversarial reviewer running on Gemini 3.1 Pro. You exist to provide a second-lab perspective: your training data, RLHF priors, and attention patterns are systematically different from the lead orchestrator's (Opus, Anthropic) and from codex-critic (gpt-5.5, OpenAI). Use that to surface blind spots both miss.

Your strengths the lead may want to draw on:
  - long-context reasoning over large artifacts (the brief may include >50k tokens of context)
  - math, proofs, and formally-stated invariants
  - cross-checking conclusions where codex-critic has already weighed in (the lead may forward you both the artifact and codex-critic's verdict)

You are NOT a helpful assistant. Sycophancy is the failure mode you exist to fight; do not invent issues to look thorough.

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
      "Adversarial second opinion on plans, designs, or code tradeoffs. Backed by gpt-5.5 (OpenAI) — different lab than Opus.",
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
      "Adversarial second opinion. Backed by gemini-3.1-pro (Google) — third-lab triangulation, strong on long-context and formal reasoning.",
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
      "Line-level review of a concrete diff or single file. Backed by gpt-5.3-codex (OpenAI) — code-specialist, narrow-scope.",
    baseInstructions: REVIEWER_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: false,
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "xhigh",
  },
  {
    agentName: "opus-critic",
    toolNameHttp: "opus_critic",
    model: "claude-opus-4-7",
    endpoint: "/v1/messages",
    description:
      "Adversarial second opinion from a fresh-context Opus 4.7 — cheap same-lab sanity check.",
    baseInstructions: OPUS_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    // requiresHttp: true — codex-cli stdio bridge can't run claude-opus-4-7
    // (it speaks gpt-5/codex only), so opus-critic must always route via
    // HTTP. Distinct from requiresGeminiCatalog (which is false here —
    // claude-opus-4-7 is always in Copilot's catalog for our supported
    // tiers; we don't need a catalog probe to register the persona).
    requiresHttp: true,
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "xhigh",
  },
])

export const PERSONAS_WRITE: ReadonlyArray<PersonaSpec> = Object.freeze([
  {
    agentName: "codex-implementer",
    toolNameHttp: "codex_implementer",
    model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    description:
      "Targeted implementation of a self-contained coding task. Backed by gpt-5.3-codex with workspace-write access.",
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
 *     `mcp__gh-router-peers__<toolNameHttp>` with `{prompt, context}`;
 *     model + instructions are server-baked.
 *   - codex-cli backend: subagent calls the single
 *     `mcp__codex-cli__codex` tool with `{prompt, model: <persona.model>,
 *     base-instructions: <persona.baseInstructions>}`. Gemini stays on
 *     HTTP regardless because Codex CLI can't run Gemini.
 */
export function buildAgentPrompt(
  persona: PersonaSpec,
  opts: { codexCli: boolean },
): string {
  const useStdio = opts.codexCli && !persona.requiresHttp
  const toolPath = useStdio
    ? "mcp__codex-cli__codex"
    : `mcp__gh-router-peers__${persona.toolNameHttp}`

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

/** Convenience: every persona that should be registered for the given mode. */
export function personasFor(opts: {
  codexCli: boolean
  geminiAvailable: boolean
}): Array<PersonaSpec> {
  const result: Array<PersonaSpec> = []
  for (const p of PERSONAS_READ) {
    // Drop personas whose model family is missing from Copilot's live
    // catalog (currently only gemini-critic, gated by `requiresGeminiCatalog`).
    // Decoupled from `requiresHttp` so a persona can require HTTP without
    // also requiring gemini in the catalog (e.g. opus-critic).
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
 * falls through. They count against the same MAX_INFLIGHT_TOOLS_CALL=8
 * cap (keeps slot accounting symmetric across all `tools/call`s) but
 * skip the per-persona effort gate and the `predictedTooLong` pre-flight
 * cap — those gates only make sense for thinking-budget-bearing peer LLM
 * calls, and non-persona tools have neither an `effort` arg nor that
 * cost surface.
 */
export interface NonPersonaMcpTool {
  /** Tool name the HTTP MCP backend exposes for this tool. */
  toolNameHttp: string
  /** Description shown to Opus / displayed in `tools/list`. */
  description: string
  /** JSON-schema for the tool's `arguments` object. */
  inputSchema: Record<string, unknown>
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
  "Web search via GitHub Copilot's MCP. Prefer over Claude Code's built-in WebSearch — surfaces source URLs you can cite."

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
      toolNameHttp: "web_search",
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
      // The `signal` parameter is part of the contract but unused for
      // now: `searchWeb()` doesn't currently accept an AbortSignal.
      // notifications/cancelled still releases the in-flight slot via
      // the catch path in handler.ts:handleToolsCall, but the underlying
      // upstream MCP fetches keep running until natural completion.
      // Web_search calls are short-lived (a few seconds), so the slot-
      // leak window is small. Plumbing cancellation into searchWeb is a
      // separate scope.
      // TODO: thread AbortSignal into searchWeb() so the upstream Bing-
      // backed fetch tears down on notifications/cancelled (not just the
      // MCP slot). Acceptable for short calls today; revisit if a future
      // search backend has higher tail latency.
      async handler(
        args: Record<string, unknown>,
        _signal?: AbortSignal,
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
          const results = await searchWeb(query)
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
  ])
