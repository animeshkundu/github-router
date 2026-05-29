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

import { searchCode } from "./code-search"
// Static import is safe: the previous module-init cycle (peer-mcp-personas
// → worker-agent/index → engine → tools → peer-mcp-personas) was caused
// by a top-level `assertCriticsMatchPersonas()` call in tools.ts that
// read `PERSONAS_READ` mid-init. That runtime check has been moved into
// a test (`tests/peer-mcp-persona-drift.test.ts`), so the cycle no
// longer closes and a normal static import works.
import { BROWSER_TOOLS } from "~/lib/browser-mcp"
import { runWorkerAgent, type WorkerThinkingLevel } from "~/lib/worker-agent"
import { searchWeb } from "~/services/copilot/web-search"
import { runStandIn, type StandInInput } from "~/lib/stand-in"

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
      "Adversarial second opinion on plans, designs, or code tradeoffs. Backed by gpt-5.5 (OpenAI) — different lab than Opus. Pass artifact verbatim.",
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
      "Adversarial second opinion. Backed by gemini-3.1-pro (Google) — third-lab triangulation, strong on long-context and formal reasoning. Pass artifact verbatim.",
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
      "Line-level review of a concrete diff or single file. Backed by gpt-5.3-codex (OpenAI) — code-specialist, narrow-scope. Pass artifact verbatim.",
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
      "Adversarial second opinion from a fresh-context Opus 4.7 — cheap same-lab sanity check. Pass artifact verbatim.",
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

/**
 * Build the awareness snippet appended to the spawned `claude` session's
 * system prompt via `--append-system-prompt`. Non-prescriptive — Claude
 * sees that the peer tools and advisor exist; *when* to invoke is left
 * to Claude's judgment.
 *
 * Trimmed to ~150 tokens by design. The per-tool descriptions are
 * already in Claude's context as MCP tool descriptions (loaded from
 * `tools/list`); the snippet's net-new value is:
 *   - the `advisor` mention (built-in, not MCP-discoverable),
 *   - the `peer-review-coordinator` fan-out hint,
 *   - the "subagents you spawn inherit these" claim (the load-bearing
 *     UX payoff of the holistic subagent-MCP-inheritance fix),
 *   - the worker-tools "offload to save your context" framing (the
 *     per-tool MCP descriptions cover capabilities; the snippet adds
 *     the strategic when-to-use signal).
 *
 * Surface contract (regression-pinned in tests/peer-mcp-personas.test.ts):
 *   - Always lists codex_critic, codex_reviewer, opus_critic, advisor,
 *     peer-review-coordinator, and the subagent-inheritance fact.
 *   - Conditionally lists gemini_critic only when `geminiAvailable`.
 *   - Mentions `codex-cli` stdio bridge only when `codexCli`.
 *
 * The snippet is the awareness layer; the auto-invocation triggers
 * (CALL BEFORE / CALL AFTER) remain in each MCP tool's own `description`.
 * The two layers are intentionally complementary — keep the snippet
 * terse and never re-encode the prescriptive triggers here.
 */
export function buildPeerAwarenessSnippet(opts: {
  codexCli: boolean
  geminiAvailable: boolean
}): string {
  const criticList: Array<string> = [
    "`codex_critic` (gpt-5.5)",
    "`codex_reviewer` (gpt-5.3-codex)",
  ]
  if (opts.geminiAvailable) {
    criticList.push("`gemini_critic` (gemini-3.1-pro)")
  }
  criticList.push("`opus_critic` (Opus 4.7)")

  const codexCliClause = opts.codexCli
    ? " The `mcp__codex-cli__codex` stdio bridge dispatches to `codex-implementer` for end-to-end coding tasks."
    : ""

  return [
    "## Peer review and advisor",
    "",
    `Cross-lab peer critics under \`mcp__gh-router-peers__*\` — ${criticList.join(
      ", ",
    )} — plus the \`peer-review-coordinator\` fan-out subagent, and Claude Code's built-in \`advisor\` tool, are available at your discretion for second opinions and adversarial review. Subagents you spawn inherit them.${codexCliClause} Also \`mcp__gh-router-peers__code_search\` for accurate ranked code discovery (BM25F + tree-sitter) — prefer it over \`Grep\` when finding definitions or call sites. \`worker_explore\` / \`worker_implement\` delegate bounded research or scoped coding tasks (file ops, edits, bash, web fetch) to an autonomous Gemini worker — offload work that would consume your context. Use \`worktree: true\` on \`worker_implement\` for isolated runs that return a diff for review.`,
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
   * Optional capability tag the handler uses to drop the tool from
   * `tools/list` and `tools/call` when the runtime gate is off.
   *
   * - `"worker"` (worker_explore / worker_implement) requires Copilot's
   *   `gemini-3.5-flash` to be in the live catalog with `tool_calls`
   *   support AND `GH_ROUTER_DISABLE_WORKER_TOOLS=1` to be unset
   *   (see `workerToolsEnabled()` in `routes/mcp/handler.ts`).
   * - `"stand_in"` requires all three of `gpt-5.5`, `claude-opus-4-7`,
   *   and a `gemini-3.X.*pro` model to be in the live catalog (see
   *   `standInToolEnabled()` in `routes/mcp/handler.ts`).
   * - `"browser"` (browser_open_tab, browser_screenshot, browser_click,
   *   …) requires `state.browseEnabled` (set by `--browse` or
   *   `GH_ROUTER_ENABLE_BROWSE=1`) AND at least one Chromium-family
   *   browser detected on disk (see `browserToolsEnabled()` in
   *   `routes/mcp/handler.ts`).
   *
   * Absent on `web_search` / `code_search` — those are always available
   * once the proxy is in claude mode (loopback + nonce already gate
   * `/mcp` itself).
   */
  capability?: "worker" | "stand_in" | "browser"
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
      // code_search — proxy-side MCP tool exposing ripgrep + BM25F +
      // tree-sitter structural-aware ranking to all clients (Claude
      // Code, codex, gemini callers). Implementation: src/lib/code-search.ts.
      //
      // SCHEMA + RESPONSE MINIMALITY: this entry is the canonical
      // worked example for the "ruthlessly minimal MCP tool surface"
      // principle (docs/peer-mcp-design.md). The handler below trims
      // the rich internal `CodeSearchResponse` to {file, line, snippet}
      // per hit and a tiny top-level envelope. Internal diagnostics
      // (scores, field_contributions, scanned_files, elapsed_ms, the
      // ranking metadata block) are intentionally NOT forwarded — the
      // model cannot act on them, so they would only burn its context.
      // Do NOT re-export them without re-reading the principle section.
      toolNameHttp: "code_search",
      description:
        "Fast structured code search over a local workspace. Returns " +
        "ranked, deduplicated hits with snippets. Ranks with BM25F " +
        "across matched-line / file-path / surrounding-context / " +
        "symbol-context fields, then refines `symbol-context` with " +
        "tree-sitter AST analysis on the top hits so identifier " +
        "definitions outrank incidental string matches. Prefer this " +
        "over Grep/Bash+grep for ranked discovery (\"where is X " +
        "defined\", \"which files reference Y\", \"find code that does " +
        "Z\") — ranked mode surfaces the few right answers instead of " +
        "every match. Use Grep for exact-pattern enumeration when you " +
        "need every hit unranked, and Glob for file-name patterns (no " +
        "content match). `workspace` is any absolute path the proxy " +
        "process can read — typically the project root or a sub-tree " +
        "you're working in.",
      inputSchema: {
        type: "object",
        required: ["query", "workspace"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Search text. In 'ranked' (default) and 'literal' modes, " +
              "interpreted as a literal string. In 'regex' mode, " +
              "interpreted as a PCRE2 regex. In 'ranked' and 'literal' " +
              "modes, single-identifier queries are auto-expanded across " +
              "camelCase / snake_case / kebab-case / SCREAMING_SNAKE " +
              "skeletons so `getUserName` also matches `get_user_name`.",
          },
          workspace: {
            type: "string",
            description:
              "Absolute path to the project root (or sub-tree) to search.",
          },
          mode: {
            type: "string",
            enum: ["ranked", "literal", "regex"],
            description:
              "Ranking mode. 'ranked' (default): BM25F + tree-sitter " +
              "structural boost; results ordered by score with shoulder " +
              "pruning (drops results below 50% of the top score). " +
              "'literal': fixed-string search, ripgrep document order. " +
              "'regex': PCRE2 search, ripgrep document order.",
          },
          file_glob: {
            type: "string",
            description: "Optional ripgrep glob filter (e.g. 'src/**/*.ts').",
          },
          limit: {
            type: "number",
            description: "Max hits to return (default 20).",
          },
          structural: {
            type: "string",
            enum: ["full", "topN"],
            description:
              "Structural-ranking depth (ranked mode only). 'full' " +
              "(default) runs tree-sitter on the top 50 BM25F hits — " +
              "best signal, fine for typical repos. 'topN' restricts to " +
              "the top 10 for tighter latency on very large workspaces. " +
              "Both modes share a 200ms wall-clock budget; on budget " +
              "exhaustion the response includes `notice` and remaining " +
              "hits fall back to the regex symbol heuristic.",
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
          const result = await searchCode(
            {
              query: typeof args.query === "string" ? args.query : "",
              workspace:
                typeof args.workspace === "string" ? args.workspace : "",
              mode:
                args.mode === "literal" || args.mode === "regex" ||
                args.mode === "ranked"
                  ? args.mode
                  : undefined,
              file_glob:
                typeof args.file_glob === "string" ? args.file_glob : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
              structural:
                args.structural === "full" || args.structural === "topN"
                  ? args.structural
                  : undefined,
            },
            signal,
          )
          // Minimal-surface response shape. See the SCHEMA + RESPONSE
          // MINIMALITY comment above for why these fields and only
          // these fields are forwarded to the model.
          //
          // Response-size cap (256KB): MCP clients can't ingest
          // multi-megabyte tool results in one shot, so a runaway
          // `limit: 1000000` against a hit-heavy repo would produce
          // a blob the model can't actually use. We accumulate hits
          // up to a hard byte budget and surface `notice` when the
          // cap fires so the model knows to narrow its query or
          // lower `limit`. Always returns at least one hit when
          // there are any hits to return (per-hit oversize is
          // bounded separately by `max_snippet_bytes`).
          const SIZE_CAP_BYTES = 256 * 1024
          const trimmedHits: Array<{
            file: string
            line: number
            snippet: string
          }> = []
          let totalBytes = 0
          let sizeCapped = false
          for (const hit of result.results) {
            const next = {
              file: hit.file,
              line: hit.line,
              snippet: hit.snippet,
            }
            const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8")
            if (trimmedHits.length > 0 && totalBytes + nextBytes > SIZE_CAP_BYTES) {
              sizeCapped = true
              break
            }
            trimmedHits.push(next)
            totalBytes += nextBytes
          }

          const minimal: {
            results: Array<{ file: string; line: number; snippet: string }>
            truncated: boolean
            notice?: string
          } = {
            results: trimmedHits,
            truncated: result.truncated || sizeCapped,
          }
          // Notice priority: size-cap > structural-budget. Size-cap
          // means the model is missing results entirely and should
          // narrow; structural-budget just means the ranking was
          // less precise but the result set is complete. The size-
          // cap message is the more urgent action.
          if (sizeCapped) {
            minimal.notice =
              `response size limit reached at ${trimmedHits.length} hits ` +
              `(~${Math.round(totalBytes / 1024)}KB); narrow your query ` +
              `or lower 'limit' to get all relevant matches`
          } else if (typeof result.notice === "string") {
            minimal.notice = result.notice
          }
          return {
            content: [{ type: "text", text: JSON.stringify(minimal) }],
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text", text: `code_search failed: ${msg}` }],
            isError: true,
          }
        }
      },
    },
    // worker_explore / worker_implement — autonomous worker tools backed
    // by the Pi agent loop (`src/lib/worker-agent/engine.ts`), routed
    // through Copilot's `gemini-3.5-flash` by default.
    //
    // GATING (`capability: "worker"`): the MCP handler drops both entries
    // from `tools/list` and `tools/call` when `workerToolsEnabled()` is
    // false. The gate fires when (a) `gemini-3.5-flash` is missing from
    // the live Copilot catalog (or present but lacks `tool_calls`
    // support), OR (b) the operator opted out via
    // `GH_ROUTER_DISABLE_WORKER_TOOLS=1`. Defense-in-depth: the gate is
    // checked at BOTH list-time and call-time so a client that hard-
    // codes the tool name can't bypass the list-side filter.
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
      toolNameHttp: "worker_explore",
      capability: "worker",
      description:
        "Read-only investigation by an autonomous worker (Gemini via Pi). "
        + "Tools: read, glob, grep, code_search, web_search, fetch_url, "
        + "peer_review, advisor. Use it to offload bounded research "
        + "(\"find files matching X then summarize\", \"how does library "
        + "Y handle Z\", \"survey this codebase for usages of deprecated "
        + "API\") that would otherwise eat your context window. The "
        + "worker plans its own tool calls and returns a single text "
        + "answer.",
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
      toolNameHttp: "worker_implement",
      capability: "worker",
      description:
        "Delegates a scoped coding task to an autonomous worker (Gemini "
        + "via Pi). Modifies files in your workspace and can run shell "
        + "commands. With `worktree: false` (default) edits in place — "
        + "concurrent worker_implement calls and Claude's own edits to "
        + "the same files will race. With `worktree: true` runs in an "
        + "isolated git worktree and returns the diff for review. "
        + "HARD ERROR if true and the workspace is not a git repository.",
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
    // Browser-control tools (`browser_*`). Defined in a sibling module so
    // the dispatch implementation can grow without bloating this file.
    // Each entry carries `capability: "browser"` so `browserToolsEnabled()`
    // in `src/routes/mcp/handler.ts` drops them at both list-time and
    // call-time when the operator hasn't opted in via `--browse` or
    // `GH_ROUTER_ENABLE_BROWSE=1`.
    ...BROWSER_TOOLS,
  ])

/**
 * Shared closure body for the two worker MCP tools. Validates the
 * minimal arg shape (prompt required + optional knobs typed), then
 * forwards to `runWorkerAgent` with `workspace = process.cwd()`. The
 * engine performs every deeper validation (model existence, thinking
 * clamp, worktree provisioning, semaphore acquisition) and never
 * throws — its `{text, isError?}` envelope is forwarded verbatim into
 * the MCP `tool result` shape.
 *
 * Arg-validation policy mirrors `web_search`'s pattern: shape errors
 * surface as `isError: true` tool-result envelopes (NOT JSON-RPC -32602
 * errors). The MCP `tools/list` JSON schema already documents the
 * required/optional fields; this runtime check is defense against a
 * client that ignores the schema.
 */
async function runWorkerToolCall(call: {
  mode: "explore" | "implement"
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
  if (mode === "implement" && args.worktree !== undefined) {
    if (typeof args.worktree !== "boolean") {
      return {
        content: [
          { type: "text", text: `worker_implement: arguments.worktree must be a boolean when provided` },
        ],
        isError: true,
      }
    }
    worktree = args.worktree
  }

  // `runWorkerAgent` is now statically imported at the top of this
  // file — the cycle that previously forced a dynamic import has
  // been broken by moving `assertCriticsMatchPersonas` out of
  // tools.ts module init into a dedicated test.
  const result = await runWorkerAgent({
    mode,
    prompt,
    workspace: process.cwd(),
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
