import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { isUnderClaudeConfigMirror, PATHS } from "./paths"

/**
 * Marker fences for each injection block. The literal text of each
 * fence is intentionally specific enough that a content collision with
 * user prose is implausible. Each block's parser only matches its own
 * marker pair, so blocks operate independently.
 *
 * Writer-side guard: the injector refuses to write a snippet that
 * itself contains its own marker literals (that would create
 * ambiguous state on the next launch where the inner literal would
 * parse as a new open or close marker).
 */
const PEER_MARKER_OPEN =
  "<!-- gh-router peer-mcp awareness — auto-injected, regenerated per launch -->"
const PEER_MARKER_CLOSE = "<!-- /gh-router peer-mcp awareness -->"

const STYLE_MARKER_OPEN =
  "<!-- gh-router style directive — auto-injected, regenerated per launch -->"
const STYLE_MARKER_CLOSE = "<!-- /gh-router style directive -->"

const OPERATING_MARKER_OPEN =
  "<!-- gh-router operating defaults — auto-injected, regenerated per launch -->"
const OPERATING_MARKER_CLOSE = "<!-- /gh-router operating defaults -->"

const TOOLBELT_MARKER_OPEN =
  "<!-- gh-router toolbelt awareness — auto-injected, regenerated per launch -->"
const TOOLBELT_MARKER_CLOSE = "<!-- /gh-router toolbelt awareness -->"

const ARTIFACT_MARKER_OPEN =
  "<!-- gh-router artifact-panel directive — auto-injected when in an ai-or-die tab -->"
const ARTIFACT_MARKER_CLOSE = "<!-- /gh-router artifact-panel directive -->"

// Default-on review in the panel: when running inside an ai-or-die tab the
// artifact_* tools reach a real review panel, so steer the agent to use it.
// Lever split: this directive is the SOFT steer for the model-judgment cases
// (show a comparison/table/diagram mid-conversation, which no hook can detect).
// The one DETERMINISTIC artifact-open is the PostToolUse(ExitPlanMode) hook
// (buildArtifactOpenHookCommand in claude.ts) that auto-opens a finalized plan.
// A Stop / UserPromptSubmit hook is deliberately NOT added: it would either
// mis-fire on ordinary turns or merely duplicate this soft steer.
//
// Scope: this block carries ONLY the trigger + the HTML-by-default steer + the
// tool entry points + a pointer. The full authoring/review-loop playbook (HTML
// conventions, design-system choice, per-type cheatsheet, the data-aod-*
// controls, honest limits) lives in the materialized `gh-artifact-review`
// skill, so it is not restated here every turn (per the injected-surface
// review: CLAUDE.md holds the steer, the skill holds the procedure).
function ARTIFACT_PANEL_DIRECTIVE(peersKey = "peers"): string {
  const toolPrefix = `mcp__${peersKey}__artifact_`
  return "## Review in the artifact panel (HTML by default)\n\n"
    + `You are running inside an ai-or-die tab, so the \`${toolPrefix}*\` tools drive a live human-review panel. `
    + "Default to opening a self-contained HTML artifact for anything the user should review before you proceed: plans, design proposals, comparisons / trade-offs, decisions that need their input, diagrams, tables, code diffs, and reports. "
    + "Plan-mode plans are auto-rendered to HTML and opened for you; skip the panel only for trivial one-line answers. "
    + `Run the \`gh-artifact-review\` skill for the full playbook: HTML + design conventions, the \`${toolPrefix}open\` / \`${toolPrefix}await\` (pass back the \`cursor\`) / \`${toolPrefix}reply\` / \`${toolPrefix}end\` loop, and the \`data-aod-*\` interactive controls.`
}

// Back-compat aliases used by existing tests. The peer block's
// markers remain the "default" pair surfaced through __testExports.
const MARKER_OPEN = PEER_MARKER_OPEN
const MARKER_CLOSE = PEER_MARKER_CLOSE

/**
 * Writing / communication style directive injected at the TOP of the
 * mirrored CLAUDE.md so every spawned agent (main, Agent-tool subagent,
 * agent-teams teammate) reads it before the user's own CLAUDE.md body.
 *
 * Self-referentially compliant: the directive itself uses no em
 * dashes and does not mention any Claude / Anthropic attribution.
 */
const STYLE_DIRECTIVE =
  "Write concisely without losing detail. "
  + "Use a natural human voice. "
  + "Avoid em dashes. "
  + "Do not attribute work to Claude, AI, LLM, or Anthropic anywhere "
  + "(commits, PRs, issues, code, comments, docs)."

/**
 * Operating-defaults directive injected at the TOP of the mirrored CLAUDE.md.
 * The main agent's system prompt (`--append-system-prompt`) gets
 * OPERATING_DEFAULTS_DIGEST instead, with this full statement available through
 * CLAUDE.md. Three defaults, each explicitly overridden by the user's own
 * direction and the domain's standards:
 *
 *   1. Orchestrate (strong default): delegate the heavy / parallel /
 *      context-heavy work to the right subagent / worker / model, keeping the
 *      main context free to reason and collaborate with the user, while still
 *      doing trivial / surgical / last-mile work directly (delegating that
 *      would only add relay-fidelity loss + latency).
 *   2. Adversarial review: WHEN a peer critic earns its keep and, equally
 *      important, when reaching for one is ritual rather than review. Same
 *      failure shape the delegation default had: "consult a critic for
 *      non-trivial changes" is unfalsifiable in advance, so it collapses into
 *      either never (four of four unprimed agents) or always (worse than
 *      never). The discriminator is whether the conclusion still turns on
 *      judgment once the direct evidence is in: a consequential recommendation
 *      cannot be run, which is exactly where confabulation hides, while a
 *      tracing question a search already proved gains nothing from a second
 *      model re-deriving it. The roster, the lens-to-artifact match, the
 *      advisor-complements-rather-than-substitutes distinction, and the
 *      do-not-anchor-the-critic rule live here; the digest carries only the
 *      trigger and the ritual exclusion.
 *   3. Excellence lens: the principles stated plainly and concretely (radical
 *      simplicity + real-user focus; whole-system first-principles thinking that
 *      anticipates scale; work back from the customer outcome). Named exemplars
 *      were dropped per the injected-surface review: a named entity is a dense,
 *      high-variance vector that pulls in persona mannerisms at top salience, and
 *      the guidance favors specific functional framing over comparison, so
 *      specificity carries the vividness instead.
 *   4. Engineering excellence: quality / robustness / maintainability over
 *      development cost; reproduce a bug end-to-end (as a real user hits it)
 *      before fixing so the fix targets the real cause; a pixel-perfect UI bar;
 *      and fix any lint error / test failure / flake on sight, whoever caused it,
 *      folded into the current work rather than derailing the user's task (the
 *      scope guardrail keeps proactive quality from becoming yak-shaving). The
 *      digest carries a one-line form; the full statement lives here so it does
 *      not cost the context window every turn.
 *
 * Self-referentially compliant with the style directive: no em dashes, no
 * Claude / Anthropic attribution.
 *
 * Availability-aware: four of the natives (`scout`, `implementer-fast`,
 * `reviewer-fast`, and `general-purpose-fast`) are DROPPED rather than
 * downgraded when no model in
 * their chain resolves, so naming them unconditionally here would tell the lead to delegate
 * to an agent that has no `.md` file and is absent from the Task
 * `subagent_type` enum. Build the directive with
 * `buildOperatingDefaultsDirective` and the same availability booleans used for
 * the `.md` generation and the awareness snippet; the exported const below is
 * the all-available form, kept for callers and tests that do not model a thin
 * catalog.
 */

/** Which of the conditionally-emitted natives this launch actually wrote.
 *  `undefined` means available, matching `buildPeerAwarenessSnippet`'s
 *  `scoutAvailable` convention, so an existing caller that passes nothing keeps
 *  the previous full-roster text. */
export interface NativeAgentAvailability {
  scoutAvailable?: boolean
  implementerFastAvailable?: boolean
  reviewerFastAvailable?: boolean
  generalPurposeFastAvailable?: boolean
  /** True when this launch's LEAD is a lighter Claude tier (sonnet, haiku)
   *  rather than an Opus. Reorders the delegation clauses so the cheap tiers
   *  lead; see `buildNativeReachClauses`. Absent/false keeps the Opus-lead
   *  ordering, so existing callers are unaffected.
   *
   *  Unlike the advisor's lead-awareness, this is resolved ONCE per launch and
   *  baked into the mirrored CLAUDE.md, so it cannot follow a mid-session
   *  `/model` switch. Acceptable for prose that biases a choice; it would not
   *  be for anything that routes a request. */
  budgetLead?: boolean
  /** `"fast"` selects the fast launch profile's roster-restricted prose: a
   *  hard restriction (not a catalog-availability signal, unlike every
   *  `*Available` flag above). When set, `buildNativeReachClauses` and
   *  `buildOperatingDefaultsDirective` return a short, self-contained
   *  rendering naming only `Explore`/`implementer`/`reviewer`/`planner`/`critic`,
   *  Advisor, and Oracle — it must never name the standard-only `*-fast`/
   *  `brainstorm`/`scribe`/`general-purpose-fast`, `peer-review-coordinator`,
   *  `worker-*`/`orchestrate` tools or skills, or `stand_in`, since none of
   *  those are registered in this profile regardless of catalog state.
   *  Absent/`"standard"` is today's catalog-driven full roster. */
  profile?: "standard" | "fast" | "max"
  /** False when a fast launch disabled or failed its MCP/native runtime wiring.
   *  The fallback directive must not advertise agents/tools that do not exist. */
  fastRuntimeAvailable?: boolean
}

/** Oxford-comma join: "a", "a and b", "a, b, and c". */
function joinClauses(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? ""
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`
}

/** The "Reach for X when Y" list, omitting any agent this launch did not emit.
 *
 *  On a budget lead the coding AND review clauses swap order so the cheap tier
 *  leads and the frontier tier is named as the complexity escalation. Choosing a
 *  lighter lead is a decision to spend less while holding quality, and a roster
 *  that names the expensive `implementer` / `reviewer` first works against
 *  exactly that. This is ORDERING AND WORDING ONLY: no agent's model changes,
 *  and both frontier tiers stay named so work beyond the fast tier still has
 *  somewhere to go.
 *
 *  Review gets the same treatment as implementation because the cost gap is the
 *  same shape: `reviewer` runs the pro tier (200/1200 per 1M) against
 *  `reviewer-fast`'s flash tier (75/375), and measured 2026-08-13 the flash
 *  model was also the FASTER of the two on every axis (tool-call p50 ~1.2s vs
 *  ~2.8s, TTFT ~1.9s vs ~3.7s, decode ~326 vs ~165 tok/s). So on a budget lead
 *  there is no quality-for-cost trade being hidden by leading with the cheap
 *  tier; reserve `reviewer` for the higher-stakes assessment it is there for. */
function buildNativeReachClauses(opts: NativeAgentAvailability): string {
  if (opts.profile === "fast") {
    return joinClauses([
      "`Explore` to find or understand something in the repo",
      "`implementer` for approved mechanical coding changes",
      "`reviewer` for repository-aware verification, reproduction, and root-causing",
      "`planner` as the Sol plan consultant and approver after Luna has drafted with evidence",
      "`critic` for a fresh-context cross-lab challenge to a plan, design, diff, or decision",
    ])
  }
  const clauses: Array<string> = []
  const implementerFast = opts.implementerFastAvailable !== false
  const reviewerFast = opts.reviewerFastAvailable !== false
  // The swap requires `implementer-fast` to actually exist this launch — on a
  // catalog where it was dropped, naming it first would point the lead at an
  // agent absent from the Task `subagent_type` enum.
  if (opts.budgetLead === true && implementerFast) {
    clauses.push(
      "`implementer-fast` first for coding changes, since it is the cheaper and "
        + "faster tier and this session is running a lighter lead",
      "`implementer` when the change needs judgment, its scope is ambiguous, or "
        + "its complexity is beyond what the fast tier can carry",
    )
  } else {
    clauses.push(
      "`implementer` for coding changes that need judgment or have ambiguous scope",
    )
    if (implementerFast) {
      clauses.push("`implementer-fast` for well-specified, mechanical coding changes")
    }
  }
  // Same swap, same precondition, for the review pair.
  if (opts.budgetLead === true && reviewerFast) {
    clauses.push(
      "`reviewer-fast` first when something exists and you want it assessed, "
        + "since it is the cheaper and faster review tier",
      "`reviewer` when the assessment is higher-stakes or needs deeper "
        + "reproduction and root-causing than the fast tier can carry",
    )
  } else {
    clauses.push(
      "`reviewer` when something exists and you want it assessed (including "
        + "reproducing and root-causing a failure)",
    )
    if (reviewerFast) {
      clauses.push("`reviewer-fast` for lower-stakes assessments")
    }
  }
  clauses.push(
    "`brainstorm` when you do not yet know which approach to take",
  )
  if (opts.scoutAvailable !== false) {
    clauses.push("`scout` to find or understand something in the repo")
  }
  clauses.push("`scribe` for docs and ADRs that trail the code")
  if (opts.generalPurposeFastAvailable !== false) {
    clauses.push(
      opts.budgetLead === true
        ? "`general-purpose-fast` for work no specialist fits, in preference to "
          + "carrying it inline yourself"
        : "`general-purpose-fast` for work no specialist fits",
    )
  }
  return joinClauses(clauses)
}

/** Everything after the orchestration paragraph's agent list. Unchanged by
 *  availability, so it lives here once rather than in both branches. */
const OPERATING_DEFAULTS_TAIL =
  "context free to reason and collaborate with the user. Launch independent "
  + "agents concurrently in a single message rather than serially. Delegation "
  + "pays when the work is WIDE "
  + "(many files or sources to sweep) or SLOW, and you need only the "
  + "conclusion: the main thread is where you think with and respond to the "
  + "user, and its context window is a finite shared resource. It does NOT pay "
  + "merely because a sub-question is separable. A narrow, deep question whose "
  + "whole value is file:line fidelity loses exactly that through a "
  + "summarization layer, and a sub-question you could answer in one command is "
  + "cheaper done directly than paying a subagent's startup. Do trivial, "
  + "surgical, and last-mile work yourself. A named teammate persists after it "
  + "reports so you can send it follow-ups, and nothing reaps it for you: its idle "
  + "notice means available, not finished. Stop it once you are done with it.\n\n"
  + "Adversarial review. The peer critics (`codex_critic` and `codex_reviewer`, "
  + "`gemini_critic` and `gemini_reviewer`, `opus_critic`, and the "
  + "`peer-review-coordinator` that fans out to several of them) are "
  + "fresh-context models, so what they add is a blind spot that whoever "
  + "produced the work cannot reach by thinking harder about it; prefer a "
  + "critic from a different lab than the producer, since blind spots "
  + "correlate within a lab. The `advisor` is a complement and not a "
  + "substitute: it sees your transcript, so it catches your own drift and "
  + "momentum, but it inherits your framing, which is exactly what a "
  + "fresh-context critic does not. They earn their keep on consequential design "
  + "choices, recommendations, and hard-to-reverse decisions: the cases where "
  + "plausible alternatives remain and the conclusion rests on judgment rather "
  + "than on something you can verify directly. That is where confabulation "
  + "hides, so budget the wait even under delivery pressure. Always consult one "
  + "when the change touches auth, user input, database queries, crypto, or "
  + "serialization. They do NOT pay for read-only tracing, ordinary repository "
  + "lookup, or a conclusion that a focused test, a direct reproduction, or "
  + "unambiguous code evidence already settles. Asking a critic to re-derive a "
  + "proven fact returns a confident answer either way, which is ritual "
  + "skepticism rather than review, and skipping them there is the right call "
  + "and not a shortcut. Match the lens to the artifact: a strategic critic for "
  + "plans and trade-offs, a code reviewer for a concrete diff, the coordinator "
  + "only when the risk warrants several independent lenses. Give whichever you "
  + "pick the artifact and the constraints and not your rationale, since "
  + "justification anchors the review and dulls it.\n\n"
  + "Aim high. Default to radical simplicity and a relentless focus on the user's "
  + "real experience: design for the person and the job to be done, not the demo. "
  + "Reason about the whole system from first principles, anticipating scale and the "
  + "long arc rather than patching the surface. Work backwards from the outcome the "
  + "user actually needs. Question every assumption and prefer what you can derive, "
  + "reproduce, or test.\n\n"
  + "Engineering excellence. When making technical decisions, give little weight to "
  + "development cost; prefer quality, simplicity, robustness, scalability, and "
  + "long-term maintainability. Fix a bug by first reproducing it end to end, as "
  + "close to how a real user hits it as you can, so you solve the real problem and "
  + "not a symptom. When testing a product end to end, be picky about the UI and "
  + "obsessed with pixel perfection: if something clearly looks off, even when it is "
  + "unrelated to your task, get it fixed along the way. Hold that same bar for the "
  + "codebase itself: a lint error, a failing test, or a flaky test is worth fixing "
  + "the moment you see it, whoever introduced it. Fold it into your current work "
  + "rather than letting it derail the task the user actually asked for."

/**
 * Build the operating-defaults directive for one launch, naming only the
 * natives that launch actually emitted.
 *
 * Callers must pass the SAME availability booleans they used for the `.md`
 * generation and `buildPeerAwarenessSnippet`, so the three surfaces cannot
 * disagree about which agents exist.
 */
/**
 * Fast-profile-only operating-defaults body. Self-contained (does not share
 * text with `OPERATING_DEFAULTS_TAIL`) because that tail names
 * `codex_critic`/`codex_reviewer`/`gemini_reviewer`/`opus_critic`/
 * `peer-review-coordinator` and `worker-*` agents, none of which the fast
 * profile registers — reusing it and trying to string-surgery those names
 * out would be far more fragile than a short, purpose-written paragraph.
 * Keeps the same "why delegate" and "why adversarial review" reasoning the
 * standard tail carries, scaled to the fast profile's actual roster.
 */
const FAST_OPERATING_DEFAULTS_TAIL =
  "context free to reason and collaborate with the user. Delegate only when work is wide or slow; do trivial and surgical work directly. "
  + "Luna investigates and drafts. The lead must give `planner` a handcrafted evidence packet and must not implement until `planner` returns `APPROVE`. "
  + "Advisor is an optional, non-binding, lead-only transcript-aware sounding board for consequential unresolved uncertainty, conflicting evidence, or a genuinely stuck path; never use it for routine progress, waiting, directly verifiable facts, planner approval, reviewer verification, or completion ritual. "
  + "`oracle` is exact Opus 5 (1M/high), stateless and last resort after the normal paths remain stuck. "
  + "Before declaring work done, run the relevant build/tests and ask `reviewer` for repository-aware verification. "
  + "Verify claims, report uncertainty, and stop named teammates when finished."

export function buildOperatingDefaultsDirective(
  opts: NativeAgentAvailability = {},
): string {
  if (opts.profile === "max") {
    return (
      "## Operating defaults (apply when the user has not specified otherwise; the user's explicit direction and the domain's own standards always override)\n\n"
      + "Max launch profile. The lead owns the outcome and may use the roster as a set of complementary capabilities, not a required sequence: direct tools suit narrow facts; `Explore` broad discovery; `brainstorm` open design choices; `Plan` changes where sequencing, interfaces, or acceptance criteria benefit from a separate view; `implementer` bounded coding; `general-purpose` mixed work; and `reviewer` repository-aware verification. Independent work can run in parallel when that improves context isolation or latency. A fresh-context peer from another model family can be useful where correlated blind spots matter and deterministic evidence does not settle the issue; `peer-review-coordinator` is available when the risk justifies several lenses. Small or obvious tasks are often better handled directly, and model output remains evidence to synthesize rather than a vote. Each role's configured model is the deliberate default for role fit and diversity; overrides are most useful after a concrete mismatch. On every retained max surface, Gemini 3.1 Pro is replaced by Grok 4.6/high when available, otherwise Gemini 3.7 Flash 1M/high. Advisor is optional, non-binding counsel for one focused consequential uncertainty that the normal evidence and roles cannot settle; it has no approval or workflow authority, and a further consultation is useful only when materially new evidence changes the question."
    )
  }
  if (opts.profile === "fast") {
    if (opts.fastRuntimeAvailable === false) {
      return (
        "## Operating defaults (apply when the user has not specified otherwise; the "
        + "user's explicit direction and the domain's own standards always override)\n\n"
        + "Fast profile runtime wiring is unavailable, so no injected Task roster, search, or Oracle is available. Work directly, use only tools actually listed in this session, verify with the repository's relevant build/tests before declaring done, report uncertainty, and do not invent unavailable capabilities."
      )
    }
    return (
      "## Operating defaults (apply when the user has not specified otherwise; the "
      + "user's explicit direction and the domain's own standards always override)\n\n"
      + "Orchestrate. Delegate research, implementation, and review to the right "
      + "subagent. Reach for "
      + buildNativeReachClauses(opts)
      + "; Task subagents run in parallel. That keeps your own "
      + FAST_OPERATING_DEFAULTS_TAIL
    )
  }
  return (
    "## Operating defaults (apply when the user has not specified otherwise; the "
    + "user's explicit direction and the domain's own standards always override)\n\n"
    + "Orchestrate. Delegate research, implementation, review, and large reads to the "
    + "right subagent, worker, or model. Reach for "
    + buildNativeReachClauses(opts)
    + "; worker-* agents for background "
    + "non-blocking runs; Task subagents for parallel work; peer critics for review. "
    + "That keeps your own "
    + OPERATING_DEFAULTS_TAIL
  )
}

/** The all-available form of the directive. Prefer
 *  `buildOperatingDefaultsDirective` on any path that knows which natives
 *  resolved; this const is the default for callers and tests that do not model
 *  a thin catalog. */
export const OPERATING_DEFAULTS_DIRECTIVE = buildOperatingDefaultsDirective()

/**
 * Condensed digest of OPERATING_DEFAULTS_DIRECTIVE for the spawned session's
 * system prompt (--append-system-prompt). The FULL directive is prepended to
 * the mirrored CLAUDE.md (read by the main agent and descendants); this digest
 * keeps both behavioral directives at top salience without duplicating the full
 * ~310-token block in the context window every turn. Points to the full copy.
 *
 * The unverifiable-claim rule is here rather than in CLAUDE.md alone because it
 * fires at a moment that suppresses lookups: an agent racing to deliver a
 * recommendation is precisely the one that will not stop to consult its project
 * instructions, which is how the check got crowded out in the first place. It
 * also closes a hole in the rule above it, which only covers claims that direct
 * evidence CAN settle. The roster of critics, the lens-to-artifact match, and
 * the reasoning stay in the directive; the always-resident copy carries only
 * the trigger and the ritual exclusion.
 */
export const OPERATING_DEFAULTS_DIGEST =
  "## Operating defaults (the user's explicit direction and the domain's standards always override)\n\n"
  + "Delegate when the work is WIDE (many files or sources to sweep) or SLOW and you need only the "
  + "conclusion, to protect the main thread's finite context and keep it free for reasoning and "
  + "interacting with the user; prefer parallel delegation for independent work. Do NOT delegate "
  + "merely because a sub-question is separable: a narrow, deep question whose value is file:line "
  + "fidelity loses exactly that through a summarization layer, and one answerable in a single "
  + "command is cheaper done directly. Do trivial, surgical, and last-mile work yourself. "
  + "Stop a named teammate once you are done with it: it persists for follow-ups, its idle "
  + "notice means available rather than finished, and nothing reaps it for you.\n\n"
  + "Verify, do not assert. Run the code, read the file, check the exit code. A claim in prose is "
  + "worth nothing against state you did not check, and a check that cannot fail proves nothing. "
  + "Reproduce a bug end to end, the way a real user hits it, before fixing it. Fix a lint error, "
  + "failing test, or flake the moment you see it, whoever introduced it, without letting it "
  + "derail the task at hand. Prefer quality and long-term maintainability over development cost.\n\n"
  + "Verification has a blind spot: a consequential recommendation, a design or trade-off call, or "
  + "a hard-to-reverse decision that still turns on judgment among plausible alternatives once the "
  + "direct evidence is in. That is where confabulation hides, so put it past a peer critic before "
  + "you ship it and budget the wait even under delivery pressure. When a test, a run, a "
  + "reproduction, or a search would settle the claim, settle it that way instead; a critic asked "
  + "to re-derive what you can already prove is ritual, not review.\n\n"
  + "The agent roster, the tool surface, and the reasoning behind these defaults are in your "
  + "CLAUDE.md project instructions. Read them when choosing HOW to work; the rules above apply "
  + "without a lookup."

/**
 * Skip the helper if the user's `~/.claude/CLAUDE.md` (or, equivalently,
 * the would-be post-write file) has grown past this size.
 * Read-modify-write becomes pathological at very large sizes; CLAUDE.md
 * should never legitimately be a database. The main agent still gets
 * the awareness via `--append-system-prompt`, so skipping here only
 * loses descendant-reach.
 */
const MAX_CLAUDE_MD_BYTES = 1 * 1024 * 1024 // 1 MiB

/**
 * Bounded retry budget for the temp → rename step on Windows where
 * `fs.rename` can transiently fail with EBUSY / EPERM / EACCES when
 * CLAUDE.md is open in an editor, scanned by AV, or indexed by the
 * search service. Mirrors the verify-on-rename-fail pattern at
 * `paths.ts:795-818`. POSIX renames almost never fail this way; the
 * cost on Linux/macOS is one extra `lstat` in the unhappy path.
 */
const RENAME_RETRY_DELAYS_MS = [50, 200, 500] as const

/**
 * Grep-able error-code prefix. Every warn-and-continue path here
 * starts its message with this token so a Windows user who never sees
 * a fresh marker block in their mirror can `grep CLAUDE_MD_WRITE` in
 * the launcher output and land on the actionable line directly.
 */
const ERROR_CODE = "CLAUDE_MD_WRITE"

interface MarkerBlock {
  openLineIndex: number
  closeLineIndex: number
}

/**
 * Find every well-formed marker block matching the given `markerOpen`
 * + `markerClose` pair. A well-formed block is an exact `markerOpen`
 * line followed somewhere later (any number of intervening lines) by
 * an exact `markerClose` line, with no intervening `markerOpen`.
 * Multiple stale blocks all surface here so the caller can remove
 * all of them.
 *
 * Malformed state (open without close, or close without open) is
 * reported separately via the second return value so the caller can
 * `warn` and leave user prose untouched. We never try to "fix"
 * malformed marker state — that risks corrupting user content.
 */
export function findMarkerBlocks(
  lines: ReadonlyArray<string>,
  markerOpen: string = PEER_MARKER_OPEN,
  markerClose: string = PEER_MARKER_CLOSE,
): {
  blocks: Array<MarkerBlock>
  malformed: boolean
} {
  const blocks: Array<MarkerBlock> = []
  let pendingOpen: number | null = null
  let malformed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === markerOpen) {
      if (pendingOpen !== null) {
        // Two opens with no close between them — malformed.
        malformed = true
      }
      pendingOpen = i
    } else if (line === markerClose) {
      if (pendingOpen === null) {
        // Close with no preceding open — malformed.
        malformed = true
      } else {
        blocks.push({ openLineIndex: pendingOpen, closeLineIndex: i })
        pendingOpen = null
      }
    }
  }
  if (pendingOpen !== null) {
    // Open with no close — malformed.
    malformed = true
  }
  return { blocks, malformed }
}

/**
 * Detect line-ending style of `content`. Returns `"\r\n"` if `\r\n`
 * sequences outnumber bare `\n`; otherwise `"\n"`. Empty content
 * defaults to `\n` (POSIX-style new file).
 *
 * Preserves CRLF on Windows users' existing CLAUDE.md — flipping their
 * line endings under them would be a regression even though Claude
 * Code itself reads either style.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  if (content.length === 0) return "\n"
  // Count CRLF occurrences. Bare `\n` count is `\n total - CRLF count`.
  const crlf = (content.match(/\r\n/g) ?? []).length
  const totalLf = (content.match(/\n/g) ?? []).length
  const bareLf = totalLf - crlf
  return crlf > bareLf ? "\r\n" : "\n"
}

/**
 * Strip a leading UTF-8 BOM (`U+FEFF`) if present so the first line's
 * marker comparison is byte-exact. CLAUDE.md authored on Windows in
 * Notepad / VS Code sometimes carries a BOM; without this strip the
 * first marker line would never match (`<BOM><!--...` !== `<!--...`)
 * and successive launches would loop into malformed-state warn paths.
 */
function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/**
 * Split `content` into lines without losing the line-ending style.
 * The split is done on `\n`; trailing `\r` (from CRLF) is stripped
 * from each line for marker comparison, but the original ending is
 * reconstructed via `detectLineEnding` + `joinLines`.
 */
function splitLines(content: string): Array<string> {
  if (content.length === 0) return []
  const lines = content.split("\n").map((l) =>
    l.endsWith("\r") ? l.slice(0, -1) : l,
  )
  // If the file ends in `\n`, the trailing element is `""` — keep it
  // so we can detect "trailing newline present" when rebuilding.
  return lines
}

function joinLines(lines: ReadonlyArray<string>, eol: "\r\n" | "\n"): string {
  return lines.join(eol)
}

/**
 * Containment check that defeats symlink/junction tricks (peer-review
 * C3). `isUnderClaudeConfigMirror` is purely lexical via
 * `path.resolve()` — it does NOT dereference symlinks, so an attacker
 * (or an unfortunate `~/.claude` symlinked into Dropbox) could escape
 * the mirror while passing the lexical guard. This helper resolves
 * BOTH paths to their canonical form via `fs.realpath()` first.
 *
 * **Fail-closed semantics (advisor follow-up):**
 *
 *   - If the mirror root itself is a symlink (`lstat` reports
 *     `isSymbolicLink() === true`), refuse. A symlinked mirror root
 *     means writes flow through the link to whatever the user (or an
 *     attacker) targeted — the boundary's whole point is to never
 *     mutate real `~/.claude/`, so accepting any symlinked root
 *     undermines it.
 *   - If `realpath` fails on the mirror root OR the target parent,
 *     refuse. The mirror dir is provisioned by `ensureClaudeConfigMirror`
 *     before this helper runs (documented ordering invariant); a
 *     `realpath` failure here signals an unexpected state, and after
 *     the root check has already succeeded a missing parent means the
 *     root vanished between checks (TOCTOU race).
 */
export async function isUnderClaudeConfigMirrorRealpath(
  target: string,
): Promise<boolean> {
  // Fast lexical reject first: if even the lexical check fails the
  // path is clearly wrong and we never need to touch the filesystem.
  if (!isUnderClaudeConfigMirror(target)) return false

  const mirrorRoot = PATHS.CLAUDE_CONFIG_DIR

  // Reject a symlinked mirror root. realpath would happily follow it
  // and the resolved target would still appear "under" the resolved
  // root — masking the escape.
  try {
    const rootLink = await fs.lstat(mirrorRoot)
    if (rootLink.isSymbolicLink()) {
      consola.warn(
        `${ERROR_CODE}: mirror root is a symlink (${mirrorRoot}); refusing to write through it`,
      )
      return false
    }
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: cannot lstat mirror root ${mirrorRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  // Canonicalize the mirror root. Failure here is fail-closed — the
  // mirror should exist by the time this helper runs.
  let resolvedRoot: string
  try {
    resolvedRoot = await fs.realpath(mirrorRoot)
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: realpath failed on mirror root ${mirrorRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  // Canonicalize the target's parent. ENOENT here is fail-closed: the
  // mirror root has already been lstat'd and realpath'd successfully
  // above, so a missing parent at this point means the root vanished
  // between checks — exactly the race-window an attacker would use to
  // swap the mirror with a symlink/junction. Refuse rather than grant
  // access (peer-review codex-critic C1).
  const targetParent = path.dirname(target)
  let resolvedTargetParent: string
  try {
    resolvedTargetParent = await fs.realpath(targetParent)
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: realpath failed on target parent ${targetParent} after root check (TOCTOU?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  if (resolvedTargetParent === resolvedRoot) return true
  return resolvedTargetParent.startsWith(resolvedRoot + path.sep)
}

/**
 * Try `fs.rename(temp, target)` with bounded retry + verify-on-fail.
 * Mirrors `injectSyntheticClaudeJsonFields` in `paths.ts`. Windows
 * `fs.rename` can transiently fail with EBUSY / EPERM / EACCES when
 * the destination is held by another process (editor, AV, search
 * indexer). Returns `true` on eventual success, `false` after all
 * retries are exhausted (caller will warn-and-continue).
 *
 * On final failure we read the destination back and check whether it
 * already matches `desiredContent` — a concurrent racer may have
 * landed the same bytes (the snippet is deterministic per launch).
 * In that case treat as success.
 *
 * **No `copyFile` fallback** (peer-review codex-critic C2). `fs.copyFile`
 * follows the destination path — if `target` was replaced with a
 * symlink/junction between our earlier `lstat` and now (TOCTOU), or
 * if `target` is a hardlink to the real `~/.claude/CLAUDE.md`,
 * `copyFile` would mutate user files through the link. The boundary
 * we are defending says "never mutate the real `~/.claude/`". Rename
 * is safe because replacing a path entry doesn't follow the link; the
 * `copyFile` degradation reintroduces the escape. Fail-closed instead.
 */
export async function renameWithRetry(
  tempPath: string,
  target: string,
  desiredContent: string,
): Promise<boolean> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.rename(tempPath, target)
      return true
    } catch (err) {
      lastErr = err
      // Don't sleep after the final attempt.
      if (attempt < RENAME_RETRY_DELAYS_MS.length) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
        )
      }
    }
  }

  // All retries exhausted. Verify-on-fail: did a racer land the same
  // bytes we wanted? (Matches the paths.ts:795-818 pattern.)
  try {
    const observed = await fs.readFile(target, "utf8")
    if (observed === desiredContent) {
      await fs.unlink(tempPath).catch(() => {})
      consola.debug(
        `${ERROR_CODE}: rename failed but target already holds expected content (racer-won-race): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
      )
      return true
    }
  } catch {
    // Fall through to final cleanup + caller-side warn.
  }

  // Fail-closed: no copyFile fallback (would follow symlinks/hardlinks
  // and bypass the never-mutate-user-files boundary). Better to lose
  // descendant-reach for this launch than to risk overwriting the
  // user's real CLAUDE.md.
  await fs.unlink(tempPath).catch(() => {})
  consola.warn(
    `${ERROR_CODE}: rename failed for ${target} after ${RENAME_RETRY_DELAYS_MS.length + 1} attempts (no copyFile fallback to avoid symlink/hardlink escape; descendant-reach via CLAUDE.md disabled this launch; main agent still has --append-system-prompt). rename err: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  )
  return false
}

/**
 * Generic marker-block injection into the mirrored CLAUDE.md.
 * Parameterized on the marker pair (so independent blocks coexist
 * without colliding) and position (`"top"` = prepend, `"bottom"` =
 * append). Encapsulates all the safety invariants; the two exported
 * helpers (`appendPeerAwarenessToMirroredClaudeMd` and
 * `prependStyleDirectiveToMirroredClaudeMd`) are thin wrappers.
 */
interface InjectMarkerBlockOpts {
  snippet: string
  markerOpen: string
  markerClose: string
  position: "top" | "bottom"
  /** Logged in debug messages so the two callers are distinguishable. */
  label: string
}

async function injectMarkerBlock(opts: InjectMarkerBlockOpts): Promise<void> {
  const { snippet, markerOpen, markerClose, position, label } = opts

  // Invariant 7: writer-side guard. Refuse to inject a snippet that
  // contains either marker literal — otherwise the next launch's
  // parser would see the inner literal as a new open/close and
  // either delete user content (the I5 footgun) or trip the
  // malformed-marker path indefinitely. The snippet body should
  // never legitimately contain these strings; failing fast here
  // catches a builder bug at the source.
  if (snippet.includes(markerOpen) || snippet.includes(markerClose)) {
    consola.warn(
      `${ERROR_CODE}: refusing to inject ${label} snippet that contains marker literal; this would corrupt idempotency on the next launch`,
    )
    return
  }

  const target = path.join(PATHS.CLAUDE_CONFIG_DIR, "CLAUDE.md")

  // Invariant 1: mirror-only safety guard (symlink-resolving).
  if (!(await isUnderClaudeConfigMirrorRealpath(target))) {
    consola.warn(
      `${ERROR_CODE}: refusing to write outside resolved mirror dir (target=${target}, mirror=${PATHS.CLAUDE_CONFIG_DIR}) [${label}]`,
    )
    return
  }

  // Invariant 2: refuse to follow symlinks on the leaf. lstat tells
  // us about the link itself; fs.readFile would silently follow.
  let existingContent: string
  let targetExists: boolean
  try {
    const linkStat = await fs.lstat(target)
    if (linkStat.isSymbolicLink()) {
      consola.warn(
        `${ERROR_CODE}: refusing to write through symlinked CLAUDE.md (target=${target}) [${label}]`,
      )
      return
    }
    if (!linkStat.isFile()) {
      // Directory or other non-regular entry sitting where CLAUDE.md
      // should be. Refuse rather than try to fix.
      consola.warn(
        `${ERROR_CODE}: refusing to write non-regular target (target=${target}, mode=${linkStat.mode.toString(8)}) [${label}]`,
      )
      return
    }
    // Early size guard (peer-review codex-critic suggestion #9) — skip
    // before paying the readFile cost. The post-build size guard below
    // catches the runaway-snippet case; this catches the runaway-file
    // case. nlink > 1 also caught here: hardlinked CLAUDE.md to the
    // real user file would otherwise be a path-following escape via
    // fs.writeFile, even with the symlink-refusal above.
    if (linkStat.size > MAX_CLAUDE_MD_BYTES) {
      consola.warn(
        `${ERROR_CODE}: skipping oversized CLAUDE.md (${linkStat.size} bytes > ${MAX_CLAUDE_MD_BYTES}) [${label}]; descendant-reach disabled this launch`,
      )
      return
    }
    if (linkStat.nlink > 1) {
      consola.warn(
        `${ERROR_CODE}: refusing to write to hardlinked CLAUDE.md (nlink=${linkStat.nlink}) [${label}]; would mutate shared inode`,
      )
      return
    }
    targetExists = true
    existingContent = await fs.readFile(target, "utf8")
  } catch (err) {
    if (
      typeof err === "object"
      && err !== null
      && "code" in err
      && (err as { code: string }).code === "ENOENT"
    ) {
      // No existing CLAUDE.md — start from empty content.
      existingContent = ""
      targetExists = false
    } else {
      consola.warn(
        `${ERROR_CODE}: failed to stat/read target (${target}) [${label}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return
    }
  }

  // Invariant 4: detect line-ending style from the existing content
  // AND remember whether the file had a UTF-8 BOM so we can preserve
  // it (peer-review codex-critic I5).
  const hadBom = existingContent.charCodeAt(0) === 0xfeff
  const normalizedContent = stripLeadingBom(existingContent)
  const eol = detectLineEnding(normalizedContent)

  // Strip prior well-formed marker blocks of THIS pair only
  // (invariant 5: malformed state is warn-and-leave; we do not edit
  // through user prose). Other marker pairs in the file are untouched
  // so the peer-awareness block and the style block coexist without
  // interfering.
  const lines = splitLines(normalizedContent)
  const { blocks, malformed } = findMarkerBlocks(lines, markerOpen, markerClose)
  if (malformed) {
    consola.warn(
      `${ERROR_CODE}: malformed marker state in ${target} (open without close or vice versa) [${label}]; leaving file untouched`,
    )
    return
  }
  // Remove blocks in reverse order so earlier indices stay valid.
  // Also drop blank-line separators that were inserted around the
  // block on prior writes (loop until non-blank to handle accumulation).
  const cleanedLines = [...lines]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    cleanedLines.splice(
      block.openLineIndex,
      block.closeLineIndex - block.openLineIndex + 1,
    )
    if (position === "bottom") {
      // Drop trailing blank lines BEFORE the (removed) block.
      while (
        block.openLineIndex - 1 >= 0
        && cleanedLines[block.openLineIndex - 1] === ""
        && cleanedLines.slice(0, block.openLineIndex - 1).some((l) => l !== "")
      ) {
        cleanedLines.splice(block.openLineIndex - 1, 1)
      }
    } else {
      // position === "top": drop leading blank lines AFTER the
      // (removed) block — they were the separator we inserted last
      // time between our prepended block and user content.
      while (
        block.openLineIndex < cleanedLines.length
        && cleanedLines[block.openLineIndex] === ""
        && cleanedLines.slice(block.openLineIndex + 1).some((l) => l !== "")
      ) {
        cleanedLines.splice(block.openLineIndex, 1)
      }
    }
  }

  // Trim trailing blank lines so the bottom-append block sits with
  // exactly one separator; for top-prepend, trim leading blanks
  // analogously.
  if (position === "bottom") {
    while (
      cleanedLines.length > 0
      && cleanedLines[cleanedLines.length - 1] === ""
    ) {
      cleanedLines.pop()
    }
  } else {
    while (cleanedLines.length > 0 && cleanedLines[0] === "") {
      cleanedLines.shift()
    }
  }

  // Build the final content. Position determines whether our block
  // sits at the top or bottom, with exactly one blank-line separator
  // between user content and our block.
  const snippetLines = snippet.split("\n").map((l) =>
    l.endsWith("\r") ? l.slice(0, -1) : l,
  )
  const markerBlockLines = [markerOpen, ...snippetLines, markerClose]
  let finalLines: Array<string>
  if (cleanedLines.length === 0) {
    finalLines = [...markerBlockLines, ""]
  } else if (position === "bottom") {
    finalLines = [...cleanedLines, "", ...markerBlockLines, ""]
  } else {
    finalLines = [...markerBlockLines, "", ...cleanedLines, ""]
  }
  const bodyContent = joinLines(finalLines, eol)
  const finalContent = hadBom ? "﻿" + bodyContent : bodyContent

  // Invariant 3: size guard, measured on the post-build content so a
  // user fixture sitting just below the cap with a stale block can
  // still be cleaned up (peer-review I6).
  if (Buffer.byteLength(finalContent, "utf8") > MAX_CLAUDE_MD_BYTES) {
    consola.warn(
      `${ERROR_CODE}: post-build content exceeds ${MAX_CLAUDE_MD_BYTES} bytes [${label}]; skipping update (descendant-reach disabled this launch)`,
    )
    return
  }

  // Invariant 6: atomic temp + rename, with bounded retry + verify-
  // on-fail. No copyFile fallback (would defeat symlink boundary).
  const tempPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, finalContent, {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    consola.warn(
      `${ERROR_CODE}: temp-file write failed for ${tempPath} [${label}]: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return
  }
  const ok = await renameWithRetry(tempPath, target, finalContent)
  if (!ok) return

  consola.debug(
    `${ERROR_CODE}: ${
      targetExists ? "updated" : "created"
    } ${target} [${label}] (${finalContent.length} bytes, eol=${eol === "\r\n" ? "CRLF" : "LF"})`,
  )
}

/**
 * Append the peer-MCP awareness `snippet` to the mirrored
 * `<CLAUDE_CONFIG_DIR>/CLAUDE.md`. Idempotent across launches: prior
 * well-formed peer-marker blocks are removed before appending a fresh
 * one at the bottom. The original user content is preserved
 * byte-for-byte at the top (modulo line-ending normalization to the
 * file's detected style; leading UTF-8 BOM is preserved).
 *
 * Failures `warn` and return — this surface is the descendant-reach
 * enhancement; the main agent still gets the awareness via
 * `--append-system-prompt`. Every warn message starts with
 * `CLAUDE_MD_WRITE` so users can grep launcher output.
 */
export async function appendPeerAwarenessToMirroredClaudeMd(
  snippet: string,
): Promise<void> {
  await injectMarkerBlock({
    snippet,
    markerOpen: PEER_MARKER_OPEN,
    markerClose: PEER_MARKER_CLOSE,
    position: "bottom",
    label: "peer-mcp-awareness",
  })
}

/**
 * Prepend a writing / communication style directive to the TOP of the
 * mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md` so every spawned agent
 * reads it first. The directive itself is hard-coded to
 * `STYLE_DIRECTIVE` above; the parameter exists for tests / future
 * configurability. Idempotent across launches via the
 * style-marker fence (separate from the peer-awareness fence, so the
 * two blocks coexist without colliding).
 */
export async function prependStyleDirectiveToMirroredClaudeMd(
  directive: string = STYLE_DIRECTIVE,
): Promise<void> {
  await injectMarkerBlock({
    snippet: directive,
    markerOpen: STYLE_MARKER_OPEN,
    markerClose: STYLE_MARKER_CLOSE,
    position: "top",
    label: "style-directive",
  })
}

/**
 * Prepend the operating-defaults directive (orchestrator posture + hybrid
 * excellence lens; `OPERATING_DEFAULTS_DIRECTIVE` above) to the TOP of the
 * mirrored CLAUDE.md so the main agent and descendant agents (Agent subagents,
 * agent-teams teammates) inherit the full statement. The main agent also gets
 * OPERATING_DEFAULTS_DIGEST at higher salience via `--append-system-prompt`.
 * Separate marker fence from the style / peer blocks so all coexist;
 * best-effort (warn-and-continue) like its siblings.
 */
export async function prependOperatingDefaultsToMirroredClaudeMd(
  directive: string = OPERATING_DEFAULTS_DIRECTIVE,
): Promise<void> {
  await injectMarkerBlock({
    snippet: directive,
    markerOpen: OPERATING_MARKER_OPEN,
    markerClose: OPERATING_MARKER_CLOSE,
    position: "top",
    label: "operating-defaults",
  })
}

/**
 * Append the toolbelt awareness one-liner (which CLI tools are on PATH)
 * to the bottom of the mirrored CLAUDE.md so descendant agents (Agent
 * subagents, agent-teams teammates) and the main agent learn about the
 * provisioned tools via the mirrored CLAUDE.md. This line is not sent via
 * `--append-system-prompt`.
 * Separate marker fence from the peer-awareness / style blocks.
 */
export async function appendToolbeltAwarenessToMirroredClaudeMd(
  snippet: string,
): Promise<void> {
  await injectMarkerBlock({
    snippet,
    markerOpen: TOOLBELT_MARKER_OPEN,
    markerClose: TOOLBELT_MARKER_CLOSE,
    position: "bottom",
    label: "toolbelt-awareness",
  })
}

/**
 * Prepend the artifact-panel review directive to the TOP of the mirrored
 * CLAUDE.md so plans/artifacts are reviewed in the ai-or-die panel by default.
 * Gated by the caller on AIORDIE_SESSION_ID (only useful inside a tab). Separate
 * marker fence; best-effort like the style/peer blocks.
 */
export async function prependArtifactPanelDirectiveToMirroredClaudeMd(
  peersKey = "peers",
): Promise<void> {
  await injectMarkerBlock({
    snippet: ARTIFACT_PANEL_DIRECTIVE(peersKey),
    markerOpen: ARTIFACT_MARKER_OPEN,
    markerClose: ARTIFACT_MARKER_CLOSE,
    position: "top",
    label: "artifact-panel-directive",
  })
}

/**
 * Test-only exports — internal helpers exposed so unit tests can
 * exercise marker handling and line-ending logic without writing
 * files. NOT part of the public API.
 */
export const __testExports = {
  MARKER_OPEN,
  MARKER_CLOSE,
  PEER_MARKER_OPEN,
  PEER_MARKER_CLOSE,
  STYLE_MARKER_OPEN,
  STYLE_MARKER_CLOSE,
  STYLE_DIRECTIVE,
  ARTIFACT_MARKER_OPEN,
  ARTIFACT_MARKER_CLOSE,
  ARTIFACT_PANEL_DIRECTIVE,
  MAX_CLAUDE_MD_BYTES,
  ERROR_CODE,
  RENAME_RETRY_DELAYS_MS,
  detectLineEnding,
  stripLeadingBom,
  splitLines,
  joinLines,
  isUnderClaudeConfigMirrorRealpath,
  renameWithRetry,
}
