/**
 * stand_in: 3-lab away-mode advisor.
 *
 * Polls gpt-5.5 xhigh (OpenAI) + claude-opus-4-7 xhigh (Anthropic) +
 * gemini-3.1-pro-preview high (Google) across two structured voting
 * rounds and returns a ranked-choice verdict. Bounded to advisor:
 * recommends, never decides — irreversible actions (push, delete, drop,
 * deploy) remain gated by the user-confirmation discipline in CLAUDE.md
 * "Executing actions with care".
 *
 * Protocol: blind round 1 → informed round 2 → abstain on disagreement.
 * Blind R1 prevents sycophantic capitulation; informed R2 lets each
 * model reconsider with peer reasoning visible; abstain-on-disagreement
 * preserves the user's authority instead of manufacturing false
 * agreement.
 *
 * Code-driven protocol (not model-driven). The abstain invariant and
 * blind-round property must hold deterministically — not "if the
 * orchestrator model honors them." See docs/peer-mcp-design.md
 * "stand_in tool" for the full design rationale.
 */

import type { Effort } from "~/lib/peer-mcp-personas"
import { dispatchModelCall } from "~/routes/mcp/handler"

// ─── Public types ───────────────────────────────────────────────────

export interface StandInOption {
  /** Short stable identifier the verdict cites (e.g., "A", "lib-x"). */
  id: string
  /** One-line description of the option. */
  summary: string
  /** Optional longer context for the option. */
  detail?: string
}

export interface StandInInput {
  /** One-sentence framing of the choice the user would otherwise make. */
  decision: string
  /** 2-6 options, caller-provided (not model-generated). */
  options: ReadonlyArray<StandInOption>
  /** Task / code background that informs the decision. */
  context?: string
}

export type ModelKey =
  | "gpt-5.5"
  | "claude-opus-4-7"
  | "gemini-3.1-pro-preview"

export type Verdict =
  | "consensus"
  | "majority"
  | "no_consensus"
  | "need_more_info"

export interface Vote {
  /** option.id, or null if the model abstained. */
  choice: string | null
  /** 0-1 self-reported confidence; clamped server-side. */
  confidence: number
  /** One-sentence rationale. */
  reasoning: string
  /** Present when the model couldn't decide due to missing context. */
  needMoreInfo?: string
}

export interface VoteFailure {
  error: "parse_failure" | "upstream_error"
  message: string
  /** Raw text returned by the model when parse_failure. Truncated. */
  raw?: string
}

export type VoteResult = Vote | VoteFailure

export interface StandInResult {
  verdict: Verdict
  /** option.id for consensus/majority, null otherwise. */
  recommendation: string | null
  /** Aggregate confidence 0-1; mean of agreeing voters in the winning round. */
  confidence: number
  votes: Record<
    ModelKey,
    { round1: VoteResult; round2: VoteResult | null }
  >
  /** Brief explanation of the verdict (dissent rationale, missing gaps). */
  notes?: string
}

// ─── Model panel ────────────────────────────────────────────────────

interface ModelConfig {
  key: ModelKey
  model: string
  endpoint: "/v1/responses" | "/v1/messages" | "/v1/chat/completions"
  effort: Effort
}

/**
 * The three frontier peers. Effort is FIXED per model — not caller-tunable.
 * The tool's purpose is "give me the best 3-lab judgment available";
 * exposing effort knobs would invite the caller to cheap out and would
 * muddy the consensus signal.
 *
 * gemini-3.1-pro-preview is pinned to `high` because the model rejects
 * `xhigh` at the wire with a Copilot 400. `high` is the realistic ceiling.
 */
export const STAND_IN_MODELS: ReadonlyArray<ModelConfig> = Object.freeze([
  { key: "gpt-5.5",                model: "gpt-5.5",                endpoint: "/v1/responses",        effort: "xhigh" },
  { key: "claude-opus-4-7",        model: "claude-opus-4-7",        endpoint: "/v1/messages",         effort: "xhigh" },
  { key: "gemini-3.1-pro-preview", model: "gemini-3.1-pro-preview", endpoint: "/v1/chat/completions", effort: "high"  },
])

// ─── Prompt templates ───────────────────────────────────────────────

const SYSTEM_PROMPT_R1 = `You are one of three frontier reasoning models the user has authorized to stand in for them on a bounded decision while they are unavailable. Your task: pick the best option from those provided.

Respond with ONLY a single JSON object — no prose, no markdown fences, no preamble. Schema:

{
  "choice": "<option.id>" | null,
  "confidence": <number between 0.0 and 1.0>,
  "reasoning": "<one short sentence>",
  "need_more_info": "<what context is missing, if you cannot decide>"
}

Calibration rules:
- "confidence" reflects how sure you are this is the better option (not how confident you are in your prose). 0.5 = coin flip. 0.9 = clear winner. Be honestly calibrated; the orchestrator weighs your number directly.
- If the question is genuinely under-specified — you'd need information you don't have to choose well — set "choice": null AND populate "need_more_info" with the specific gap. Do NOT guess.
- One sentence of reasoning. Not a paragraph.
- The other two models will vote independently and you will see their votes in round 2. There is no benefit to anticipating what they'll pick; vote on the merits.

Output ONLY the JSON object. No preamble, no markdown fences, no closing remarks.`

const SYSTEM_PROMPT_R2 = `You are one of three frontier reasoning models standing in for the user on a bounded decision. Round 1 voting is complete; you will now see the other models' votes and reasoning. Reconsider with their input visible.

Same JSON schema as round 1:

{
  "choice": "<option.id>" | null,
  "confidence": <number between 0.0 and 1.0>,
  "reasoning": "<one short sentence>",
  "need_more_info": "<gap, if any>"
}

Calibration rules:
- You may keep your round-1 vote OR change it. Do NOT change just to agree — agreement is not the goal, the right answer is. Capitulating to peer pressure when you still believe your original choice is better is a failure mode, not a success.
- If a peer's reasoning identifies a consideration you missed or weighed wrong, update freely. The blind round was the anti-anchor mechanism; this round is where genuine evidence can move you.
- If round 1 left you genuinely uncertain and peer reasoning hasn't resolved it, "choice": null is still the honest answer.

Output ONLY the JSON object.`

const RETRY_PROMPT_SUFFIX = `\n\nYour previous response was not valid JSON matching the schema. Respond with ONLY the JSON object — no preamble, no markdown fences, no closing remarks. Schema reminder: {"choice": "<id>" | null, "confidence": 0.0-1.0, "reasoning": "<one sentence>", "need_more_info": "<gap, if any>"}`

// ─── Orchestrator ───────────────────────────────────────────────────

/**
 * Run the two-round stand-in protocol. Returns a structured verdict
 * envelope. Throws only on systemic failure (e.g., all three upstream
 * calls failed) — model-level errors and parse failures are surfaced as
 * `VoteFailure` entries in the result.
 */
export async function runStandIn(
  input: StandInInput,
  signal?: AbortSignal,
): Promise<StandInResult> {
  // ── Round 1: blind parallel fan-out ──────────────────────────────
  const r1UserText = buildRound1UserText(input)
  const r1 = await Promise.all(
    STAND_IN_MODELS.map((cfg) =>
      callAndParse(cfg, SYSTEM_PROMPT_R1, r1UserText, signal),
    ),
  )

  // need_more_info short-circuit: every model that successfully parsed
  // R1 flagged a missing-context gap. Aggregate the gaps and return.
  const successfulR1 = r1.filter((r): r is { key: ModelKey; vote: Vote } => isVote(r.vote))
  const allFlaggedGap =
    successfulR1.length === STAND_IN_MODELS.length
    && successfulR1.every((r) => r.vote.needMoreInfo && r.vote.choice === null)
  if (allFlaggedGap) {
    const gaps = successfulR1.map((r) => `- ${r.key}: ${r.vote.needMoreInfo}`).join("\n")
    return {
      verdict: "need_more_info",
      recommendation: null,
      confidence: 0,
      votes: voteRecord(r1, null),
      notes: `All three models reported they need more context to decide:\n${gaps}`,
    }
  }

  // Short-circuit consensus: 3/3 same non-null choice with mean confidence ≥ 0.8.
  const r1Decision = aggregateVotes(successfulR1)
  if (
    r1Decision.verdict === "consensus"
    && r1Decision.meanConfidence >= 0.8
  ) {
    return {
      verdict: "consensus",
      recommendation: r1Decision.winner,
      confidence: round2(r1Decision.meanConfidence),
      votes: voteRecord(r1, null),
      notes: `All three models picked ${r1Decision.winner} in round 1 with high confidence (skipped round 2).`,
    }
  }

  // Insufficient signal: fewer than 2 successful R1 votes. Can't run R2
  // meaningfully — abstain.
  if (successfulR1.length < 2) {
    return {
      verdict: "no_consensus",
      recommendation: null,
      confidence: 0,
      votes: voteRecord(r1, null),
      notes: `Only ${successfulR1.length} of 3 models returned a parseable round-1 vote; insufficient signal to run round 2.`,
    }
  }

  // ── Round 2: informed parallel fan-out ───────────────────────────
  const r2UserTextBase = buildRound2UserTextBase(input, r1)
  const r2 = await Promise.all(
    STAND_IN_MODELS.map((cfg) =>
      callAndParse(
        cfg,
        SYSTEM_PROMPT_R2,
        r2UserTextBase + `\n\nYou are ${cfg.key}. Reconsider and vote.`,
        signal,
      ),
    ),
  )

  const successfulR2 = r2.filter((r): r is { key: ModelKey; vote: Vote } => isVote(r.vote))
  if (successfulR2.length < 2) {
    return {
      verdict: "no_consensus",
      recommendation: null,
      confidence: 0,
      votes: voteRecord(r1, r2),
      notes: `Only ${successfulR2.length} of 3 models returned a parseable round-2 vote; deferring to user.`,
    }
  }

  const r2Decision = aggregateVotes(successfulR2)
  if (r2Decision.verdict === "consensus") {
    return {
      verdict: "consensus",
      recommendation: r2Decision.winner,
      confidence: round2(r2Decision.meanConfidence),
      votes: voteRecord(r1, r2),
      notes: `All three models picked ${r2Decision.winner} in round 2.`,
    }
  }
  if (r2Decision.verdict === "majority") {
    const dissenters = successfulR2
      .filter((r) => r.vote.choice !== r2Decision.winner)
      .map((r) => `${r.key} picked ${r.vote.choice ?? "abstain"} (${r.vote.reasoning})`)
      .join("; ")
    return {
      verdict: "majority",
      recommendation: r2Decision.winner,
      confidence: round2(r2Decision.meanConfidence),
      votes: voteRecord(r1, r2),
      notes: `Majority (2 of 3) picked ${r2Decision.winner}. Dissent: ${dissenters}.`,
    }
  }

  // 1/1/1 split or all abstained — defer.
  return {
    verdict: "no_consensus",
    recommendation: null,
    confidence: 0,
    votes: voteRecord(r1, r2),
    notes: `Models did not converge in round 2 (votes split). Defer to user.`,
  }
}

// ─── Internals ──────────────────────────────────────────────────────

type CallResult = { key: ModelKey; vote: VoteResult }

async function callAndParse(
  cfg: ModelConfig,
  instructions: string,
  userText: string,
  signal: AbortSignal | undefined,
): Promise<CallResult> {
  let raw: string
  try {
    raw = await dispatchModelCall({
      model: cfg.model,
      endpoint: cfg.endpoint,
      instructions,
      userText,
      effort: cfg.effort,
      signal,
    })
  } catch (err) {
    return {
      key: cfg.key,
      vote: { error: "upstream_error", message: String(err) },
    }
  }

  const first = tryParseVote(raw)
  if (first.ok) return { key: cfg.key, vote: first.vote }

  // Retry once with a stricter "please return only JSON" suffix.
  let retryRaw: string
  try {
    retryRaw = await dispatchModelCall({
      model: cfg.model,
      endpoint: cfg.endpoint,
      instructions,
      userText: userText + RETRY_PROMPT_SUFFIX,
      effort: cfg.effort,
      signal,
    })
  } catch (err) {
    return {
      key: cfg.key,
      vote: { error: "upstream_error", message: `retry after parse failure: ${String(err)}` },
    }
  }
  const second = tryParseVote(retryRaw)
  if (second.ok) return { key: cfg.key, vote: second.vote }

  return {
    key: cfg.key,
    vote: {
      error: "parse_failure",
      message: `Could not parse vote JSON after one retry. Last error: ${second.error}.`,
      raw: retryRaw.slice(0, 500),
    },
  }
}

function tryParseVote(raw: string):
  | { ok: true; vote: Vote }
  | { ok: false; error: string } {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "empty response" }
  }

  // Try strict JSON parse first, then JSON-from-markdown-fence fallback.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(raw)
    if (!fence) return { ok: false, error: "not valid JSON and no code fence found" }
    try {
      parsed = JSON.parse(fence[1])
    } catch {
      return { ok: false, error: "code fence content was not valid JSON" }
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "parsed value is not an object" }
  }
  const obj = parsed as Record<string, unknown>

  const choice =
    obj.choice === null ? null
    : typeof obj.choice === "string" && obj.choice.length > 0 ? obj.choice
    : undefined
  if (choice === undefined) {
    return { ok: false, error: "missing or invalid 'choice' field (string or null required)" }
  }

  const confidenceRaw = obj.confidence
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : undefined
  if (confidence === undefined) {
    return { ok: false, error: "missing or invalid 'confidence' field (number 0-1 required)" }
  }

  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : ""
  if (!reasoning) {
    return { ok: false, error: "missing or empty 'reasoning' field" }
  }

  const needMoreInfo =
    typeof obj.need_more_info === "string" && obj.need_more_info.length > 0
      ? obj.need_more_info
      : undefined

  return { ok: true, vote: { choice, confidence, reasoning, needMoreInfo } }
}

interface VoteAggregation {
  verdict: "consensus" | "majority" | "split"
  winner: string | null
  meanConfidence: number
}

function aggregateVotes(
  results: ReadonlyArray<{ key: ModelKey; vote: Vote }>,
): VoteAggregation {
  // Tally non-null choices; null votes (abstain / need_more_info) are
  // not counted toward any option but DO count as "not in the majority"
  // — they make consensus harder, not easier.
  const tally = new Map<string, { count: number; sumConfidence: number }>()
  for (const r of results) {
    if (r.vote.choice === null) continue
    const entry = tally.get(r.vote.choice) ?? { count: 0, sumConfidence: 0 }
    entry.count++
    entry.sumConfidence += r.vote.confidence
    tally.set(r.vote.choice, entry)
  }

  let topChoice: string | null = null
  let topCount = 0
  let topSumConfidence = 0
  for (const [choice, { count, sumConfidence }] of tally) {
    if (count > topCount) {
      topChoice = choice
      topCount = count
      topSumConfidence = sumConfidence
    }
  }

  const total = STAND_IN_MODELS.length // always 3
  if (topChoice && topCount === total) {
    return {
      verdict: "consensus",
      winner: topChoice,
      meanConfidence: topSumConfidence / topCount,
    }
  }
  if (topChoice && topCount >= 2) {
    return {
      verdict: "majority",
      winner: topChoice,
      meanConfidence: topSumConfidence / topCount,
    }
  }
  return { verdict: "split", winner: null, meanConfidence: 0 }
}

function buildRound1UserText(input: StandInInput): string {
  const lines: Array<string> = []
  lines.push(`Decision: ${input.decision}`)
  lines.push("")
  lines.push("Options:")
  for (const opt of input.options) {
    const suffix = opt.detail ? ` — ${opt.detail}` : ""
    lines.push(`- ${opt.id}: ${opt.summary}${suffix}`)
  }
  if (input.context) {
    lines.push("")
    lines.push("Context:")
    lines.push(input.context)
  }
  return lines.join("\n")
}

function buildRound2UserTextBase(
  input: StandInInput,
  r1: ReadonlyArray<CallResult>,
): string {
  const base = buildRound1UserText(input)
  const summaries: Array<string> = ["", "Round 1 votes:"]
  for (const r of r1) {
    if (isVote(r.vote)) {
      const choiceText = r.vote.choice === null ? "abstain" : r.vote.choice
      const gapText = r.vote.needMoreInfo ? ` (needs: ${r.vote.needMoreInfo})` : ""
      summaries.push(
        `- ${r.key} picked ${choiceText}, confidence ${r.vote.confidence.toFixed(2)}, reasoning: ${r.vote.reasoning}${gapText}`,
      )
    } else {
      summaries.push(`- ${r.key} did not return a valid round-1 vote (${r.vote.error}).`)
    }
  }
  return base + "\n" + summaries.join("\n")
}

function isVote(v: VoteResult): v is Vote {
  return !("error" in v)
}

function voteRecord(
  r1: ReadonlyArray<CallResult>,
  r2: ReadonlyArray<CallResult> | null,
): StandInResult["votes"] {
  const record = {} as StandInResult["votes"]
  for (const cfg of STAND_IN_MODELS) {
    const r1Entry = r1.find((r) => r.key === cfg.key)
    const r2Entry = r2?.find((r) => r.key === cfg.key) ?? null
    record[cfg.key] = {
      round1: r1Entry?.vote ?? {
        error: "upstream_error",
        message: "no round-1 result recorded",
      },
      round2: r2Entry ? r2Entry.vote : null,
    }
  }
  return record
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
