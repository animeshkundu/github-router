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

/**
 * Reasoning effort levels accepted by Copilot's /v1/responses (gpt-5.x) and
 * /v1/chat/completions endpoints. Per the proxy's existing thinking-mode
 * translator (CLAUDE.md "Thinking-mode translation"), Copilot's adaptive-
 * thinking path uses these same buckets:
 *   <2k tokens → low, <8k → medium, <24k → high, else → xhigh.
 *
 * Per-persona `allowedEfforts` and `defaultEffort` constrain which subset
 * each persona exposes — enforced in handler.ts:handleToolsCall. Empirical
 * data (probed live 2026-05-14) drove the current allowlists:
 *
 *   - codex_critic  (gpt-5.5, /v1/responses): xhigh removed — 56s baseline
 *     on a tiny prompt, busts the 60s MCP per-call ceiling on real reviews.
 *   - codex_reviewer (gpt-5.3-codex, /v1/responses): xhigh removed — same
 *     reasoning, sibling model is faster but xhigh still pushes the ceiling.
 *   - gemini_critic (gemini-3.1-pro-preview, /v1/chat/completions): all
 *     four — long-context model + Copilot may silently ignore the knob anyway.
 *   - opus_critic (claude-opus-4-7, /v1/messages): only low/medium — the
 *     thinking-budget math at high (~6k tokens × ~80 tps = ~75s) busts the
 *     ceiling on adversarial reviews where the model uses budget.
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
  When delegating to me, paste a self-contained brief. I have no access to your scrollback, CLAUDE.md, or the project tree. Always include:
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
      "Adversarial second opinion on plans, designs, code, or systems-engineering tradeoffs. Backed by gpt-5.5 (OpenAI) — different model, different training data, different blind spots than Opus. Uses a calibrated 1–5 grading rubric and is allowed to reply 'no material objection' on solid artifacts."
      + " **CALL BEFORE: ExitPlanMode for any plan involving >2 files or new architecture; finalizing a major design choice; TeamCreate when the team's task is non-trivial.** **CALL AFTER: any commit touching concurrency, security, or streaming code paths.**"
      + " If the artifact is large (>8 KB), prefer to break it into 2-4 focused batches and call this tool once per batch IN PARALLEL — each call must complete under Claude Code's ~60s MCP per-tool-call ceiling, so monolithic large-artifact calls will time out client-side. Aggregate findings yourself."
      + " Always pass: (a) the artifact verbatim, (b) the constraints/'done' criteria, (c) any prior decisions. **Effort tiers**: `low | medium | high` (default `high`). `xhigh` is NOT supported on this persona — empirical data (2026-05-14) shows xhigh routinely takes 56s+ on a tiny prompt and busts the 60s MCP ceiling on real reviews. For deeper reasoning, decompose into parallel sub-calls instead. The subagent has no access to your scrollback or CLAUDE.md.",
    baseInstructions: CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: false,
    allowedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high",
  },
  {
    agentName: "gemini-critic",
    toolNameHttp: "gemini_critic",
    model: "gemini-3.1-pro-preview",
    endpoint: "/v1/chat/completions",
    description:
      "Adversarial second opinion from a different lab. Backed by gemini-3.1-pro-preview (Google) — different training data and RLHF priors than Opus AND codex-critic, the strongest blind-spot-buster when the lead wants triangulation across three labs. Use for long-context artifacts (>50k tokens), math/proof-shaped reasoning, or as a tie-breaker after codex-critic has weighed in."
      + " **CALL BEFORE: ExitPlanMode for plans where Opus + codex-critic agree (use as triangulation); finalizing irreversible architectural choices.** **CALL AFTER: commits where you want a third-lab cross-check.**"
      + " If the artifact is large (>100 KB), prefer to break into batches and call in parallel — gemini handles long context well but each per-call MCP wait is still bounded (~60s on v2.1.138)."
      + " Always pass: (a) the artifact verbatim, (b) the constraints/'done' criteria, (c) any prior decisions. **Effort tiers**: `low | medium | high | xhigh` (default `high`). The `effort` parameter is forwarded but may be silently ignored by Copilot's gemini route — gemini-3.x reasoning is largely auto-applied. The subagent has no access to your scrollback or CLAUDE.md.",
    baseInstructions: GEMINI_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: true,
    requiresGeminiCatalog: true,
    allowedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "high",
  },
  {
    agentName: "codex-reviewer",
    toolNameHttp: "codex_reviewer",
    model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    description:
      "Line-level code review of a specific diff or file. Backed by gpt-5.3-codex (OpenAI) — the code-specialist sibling of gpt-5.5, trained heavily on code-review datasets so it catches different bugs than Opus. Prefer over codex-critic when the artifact is a concrete diff or single file (codex-critic is for plans/designs)."
      + " **CALL AFTER: any non-trivial commit (>50 lines OR touching critical paths: streaming, auth, concurrency, persistence, security).** **CALL BEFORE: opening a PR or pushing changes a peer would review.**"
      + " For diffs >12 KB, split by file-group and call once per group in parallel — each per-call wait is bounded (~60s on v2.1.138)."
      + " Always pass: (a) the diff or file verbatim, (b) the change's intent, (c) test status. **Effort tiers**: `low | medium | high` (default `high`). `xhigh` is NOT supported on this persona — same 60s MCP ceiling reasoning as codex-critic; for deeper reasoning, decompose into parallel sub-calls. The subagent has no access to your scrollback or CLAUDE.md.",
    baseInstructions: REVIEWER_BASE,
    agentPrompt: "",
    writeCapable: false,
    requiresHttp: false,
    allowedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high",
  },
  {
    agentName: "opus-critic",
    toolNameHttp: "opus_critic",
    model: "claude-opus-4-7",
    endpoint: "/v1/messages",
    description:
      "Adversarial second opinion from a fresh-context Opus 4.7 — same model AND same lab as the lead orchestrator. Useful when you suspect cognitive momentum is wrong (sunk cost on a plan, motivated reasoning toward a particular fix), or as a cheap+fast sanity check before committing to a controversial decision."
      + " **LIMITED blind-spot diversification compared to codex-critic / gemini-critic (same training, same lab) — use as inexpensive sanity check, NOT as a substitute for cross-lab triangulation.**"
      + " **CALL WHEN**: the artifact fits comfortably in one shot (<5 KB) and you want a quick same-lab gut-check; a fresh perspective on a decision you've been iterating on. **Hard cap: briefs above 6 KB at `effort:'medium'` are pre-flight rejected** — decompose into smaller sub-calls or pick a smaller artifact. **DO NOT call as the primary triangulation peer** — use codex-critic + gemini-critic for that."
      + " **Effort tiers**: `low | medium` (default `medium`). `high` and `xhigh` are NOT supported on this persona — the thinking budget required for those tiers cannot complete within Claude Code's ~60s MCP per-tool-call ceiling on claude-opus-4-7 (empirical: ~80-150 tps × ~6k+ token budget = 60s+). For deep dives, use codex-critic at `effort:'high'` (with brief <8KB) or gemini-critic. The subagent has no access to your scrollback or CLAUDE.md.",
    baseInstructions: OPUS_CRITIC_BASE,
    agentPrompt: "",
    writeCapable: false,
    // requiresHttp: true — codex-cli stdio bridge can't run claude-opus-4-7
    // (it speaks gpt-5/codex only), so opus-critic must always route via
    // HTTP. Distinct from requiresGeminiCatalog (which is false here —
    // claude-opus-4-7 is always in Copilot's catalog for our supported
    // tiers; we don't need a catalog probe to register the persona).
    requiresHttp: true,
    allowedEfforts: ["low", "medium"] as const,
    defaultEffort: "medium",
  },
])

export const PERSONAS_WRITE: ReadonlyArray<PersonaSpec> = Object.freeze([
  {
    agentName: "codex-implementer",
    toolNameHttp: "codex_implementer",
    model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    description:
      "Targeted implementation of a self-contained coding task — actual file edits via Codex's tool-use sandbox. Backed by gpt-5.3-codex with workspace-write access (only registered when --codex-cli is set). Use only when the task has a clear spec and acceptance criteria; for tasks needing iterative tool-use across many files, prefer a Claude teammate (Agent Team). Always pass: (a) the spec, (b) the files in scope, (c) the acceptance criteria. The subagent has no access to your scrollback or CLAUDE.md.",
    baseInstructions: IMPLEMENTER_BASE,
    agentPrompt: "",
    writeCapable: true,
    requiresHttp: false,
    // codex-implementer is the same model as codex-reviewer (gpt-5.3-codex)
    // — applying the same allowedEfforts subset for consistency. xhigh is
    // out for the same 60s-ceiling reasoning. Implementation tasks rarely
    // benefit from "deepest possible reasoning" anyway.
    allowedEfforts: ["low", "medium", "high"] as const,
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
