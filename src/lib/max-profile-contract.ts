import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type { Effort } from "./reasoning-effort"
import { fastEndpointForModel } from "./fast-endpoint"
import { stripTrailingOneMSuffix } from "./model-suffix"
import { state } from "./state"

// Max uses the same context threshold as Claude Code's `[1m]` accounting.
export const MAX_REQUIRED_CONTEXT_TOKENS = 1_000_000

const ONE_M_TOKENS = MAX_REQUIRED_CONTEXT_TOKENS

function catalogModels(): Array<Model> {
  return state.models?.data ?? []
}

function catalogModel(id: string): Model | undefined {
  return catalogModels().find((model) => model.id === id)
}


export const MAX_PROFILE_MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  luna: "gpt-5.6-luna",
  gemini: "gemini-3.8-flash",
  grok: "grok-4.6",
  opus: "claude-opus-5",
} as const)

export const MAX_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "general-purpose",
  "implementer",
  "reviewer",
  "brainstorm",
  "peer-review-coordinator",
] as const

export type MaxProfileNativeAgentName =
  (typeof MAX_PROFILE_NATIVE_AGENT_NAMES)[number]

export const MAX_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "general-purpose": "max",
  implementer: "high",
  reviewer: "high",
  brainstorm: "medium",
  "peer-review-coordinator": "max",
} as const satisfies Record<MaxProfileNativeAgentName, Effort>)

/** Default model family behind each native role's frontmatter. The optional
 * Grok brainstorm path may fall back to Gemini, whose allowed effort ladder is
 * identical for the values accepted by the max dispatch guard. */
export const MAX_PROFILE_NATIVE_MODELS = Object.freeze({
  Explore: MAX_PROFILE_MODELS.luna,
  Plan: MAX_PROFILE_MODELS.sol,
  "general-purpose": MAX_PROFILE_MODELS.luna,
  implementer: MAX_PROFILE_MODELS.gemini,
  reviewer: MAX_PROFILE_MODELS.grok,
  brainstorm: MAX_PROFILE_MODELS.grok,
  "peer-review-coordinator": MAX_PROFILE_MODELS.luna,
} as const satisfies Record<MaxProfileNativeAgentName, string>)

export const MAX_PROFILE_LEAD_MODEL = MAX_PROFILE_MODELS.sol
export const MAX_PROFILE_ADVISOR_MODEL = MAX_PROFILE_MODELS.opus
export const MAX_PROFILE_ADVISOR_EFFORT = "high" as const
export const MAX_PROFILE_ADVISOR_INSTRUCTIONS = `# Advisor Tool

You have access to an optional, lead-only, transcript-aware Max Advisor. It offers a focused second opinion; it is not a supervisor, approver, workflow gate, or substitute for your own reasoning. You keep decision ownership.

Use it only when a consequential uncertainty remains after direct investigation and cannot be settled by repository evidence, a focused command or test, Plan, reviewer, or a fresh-context peer: conflicting evidence, a materially changed assumption, a genuinely non-converging approach, or a hard-to-reverse trade-off. State the precise unresolved question immediately before calling it.

Do not call it automatically before substantive work or completion, for routine progress, while waiting, after ordinary tool output, for directly verifiable facts, planner approval, reviewer verification, or as reassurance for a decision the evidence already supports.

Treat the result as advice, not authority. Weigh it against the user's intent and verified evidence. Consult again only when materially new evidence creates a different question or directly conflicts with the earlier advice.`

export function maxAdvisorModelFromPin(pinned: string | undefined, opusModel?: string): string {
  const trimmed = pinned?.trim()
  const base = trimmed ? stripTrailingOneMSuffix(trimmed).base : undefined
  if (base === MAX_PROFILE_MODELS.sol || base === MAX_PROFILE_MODELS.opus) {
    return base
  }
  return opusModel ?? MAX_PROFILE_MODELS.opus
}

export function maxAdvisorPinIsValid(pinned: string | undefined): boolean {
  const trimmed = pinned?.trim()
  const base = trimmed ? stripTrailingOneMSuffix(trimmed).base : trimmed
  return base === undefined
    || base === ""
    || base === MAX_PROFILE_MODELS.sol
    || base === MAX_PROFILE_MODELS.opus
}

export function maxAdvisorModelFromPinStrict(pinned: string | undefined, opusModel?: string): string {
  if (!maxAdvisorPinIsValid(pinned)) return opusModel ?? MAX_PROFILE_MODELS.opus
  return maxAdvisorModelFromPin(pinned, opusModel)
}

export function maxStandInAvailable(): boolean {
  return usableSol(catalogModel(MAX_PROFILE_MODELS.sol))
    && maxOpusModel() !== undefined
    && (maxGrokHighModel() !== undefined || maxGeminiModel() !== undefined)
}
export function maxAdvisorEffortForModel(_model: string): Effort {
  return MAX_PROFILE_ADVISOR_EFFORT
}

export const MAX_PROFILE_NATIVE_MODEL_IDS = Object.freeze([
  MAX_PROFILE_MODELS.luna,
  MAX_PROFILE_MODELS.gemini,
  MAX_PROFILE_MODELS.grok,
] as const)

export const MAX_PROFILE_ALLOWED_LEAD_MODEL_IDS = Object.freeze([
  MAX_PROFILE_MODELS.sol,
  MAX_PROFILE_MODELS.luna,
  MAX_PROFILE_MODELS.gemini,
  MAX_PROFILE_MODELS.opus,
] as const)

export type MaxProfileAllowedLeadModel =
  (typeof MAX_PROFILE_ALLOWED_LEAD_MODEL_IDS)[number]

export interface MaxProfilePrerequisiteCheck {
  ok: boolean
  missing: ReadonlyArray<string>
  /** Resolved optional/third-lab assignments for the launch. */
  models: {
    sol?: Model
    luna?: Model
    gemini?: Model
    grok?: Model
    opus?: Model
    thirdLab?: "gemini" | "grok"
  }
}

function findModel(
  catalog: ModelsResponse | undefined,
  id: string,
): Model | undefined {
  return catalog?.data?.find((model) => model.id === id)
}

function hasToolCalls(model: Model | undefined): boolean {
  return model?.capabilities?.supports?.tool_calls === true
}

function hasContextAtLeast(model: Model | undefined, tokens: number): boolean {
  return (model?.capabilities?.limits?.max_context_window_tokens ?? 0) >= tokens
}

function supportsEffort(model: Model | undefined, effort: Effort): boolean {
  const ladder = model?.capabilities?.supports?.reasoning_effort
  return Array.isArray(ladder) && ladder.includes(effort)
}

function hasUsableLimits(model: Model | undefined): boolean {
  const limits = model?.capabilities?.limits
  const prompt = limits?.max_prompt_tokens
  const output = limits?.max_output_tokens
  return (
    typeof prompt === "number"
    && Number.isFinite(prompt)
    && prompt > 0
    && typeof output === "number"
    && Number.isFinite(output)
    && output > 0
    && (limits?.max_context_window_tokens ?? 0) >= prompt
  )
}

function supportsEndpoint(
  model: Model | undefined,
  endpoint: "chat" | "responses" | "messages",
): boolean {
  return model !== undefined && fastEndpointForModel(model) === endpoint
}

function validateRequiredModel(
  model: Model | undefined,
  id: string,
  requirements: ReadonlyArray<[string, boolean]>,
  missing: string[],
): void {
  if (!model) {
    missing.push(`${id}: absent from the live catalog`)
    return
  }
  for (const [message, ok] of requirements) {
    if (!ok) missing.push(`${id}: ${message}`)
  }
}

function usableSol(model: Model | undefined): boolean {
  return Boolean(
    model
    && hasToolCalls(model)
    && hasContextAtLeast(model, ONE_M_TOKENS)
    && supportsEffort(model, "high")
    && supportsEndpoint(model, "responses")
    && hasUsableLimits(model)
  )
}

function usableGemini(model: Model | undefined): boolean {
  return Boolean(
    model
    && hasToolCalls(model)
    && hasContextAtLeast(model, ONE_M_TOKENS)
    && supportsEffort(model, "high")
    && supportsEndpoint(model, "chat")
    && hasUsableLimits(model),
  )
}

function usableGrok(model: Model | undefined): boolean {
  return Boolean(
    model
    && hasToolCalls(model)
    && supportsEffort(model, "medium")
    && supportsEndpoint(model, "responses")
    && hasUsableLimits(model),
  )
}

function usableGrokReviewer(model: Model | undefined): boolean {
  return Boolean(
    usableGrok(model)
    && supportsEffort(model, "high")
    && (model?.capabilities?.limits?.max_prompt_tokens ?? 0) >= 200_000,
  )
}

/**
 * Validate the fixed prerequisites for the raw `-m max` launch.
 *
 * Max is a deliberately strong, closed profile. Its lead, planning, reviewer,
 * and transcript-aware Advisor paths must all be present before any runtime
 * artifact is written: Sol, Luna, Gemini 3.8 Flash, and Opus 5 are mandatory.
 * Grok 4.6 is the only optional model. When present it supplies the preferred
 * medium-effort brainstorm/critic path, but it is never a max lead and its
 * sub-1M context must remain undecorated.
 */
export function validateMaxProfilePrerequisites(
  catalog: ModelsResponse | undefined,
): MaxProfilePrerequisiteCheck {
  const missing: string[] = []
  const sol = findModel(catalog, MAX_PROFILE_MODELS.sol)
  const luna = findModel(catalog, MAX_PROFILE_MODELS.luna)
  const gemini = findModel(catalog, MAX_PROFILE_MODELS.gemini)
  const grok = findModel(catalog, MAX_PROFILE_MODELS.grok)
  const opus = findModel(catalog, MAX_PROFILE_MODELS.opus)

  validateRequiredModel(
    sol,
    MAX_PROFILE_MODELS.sol,
    [
      ["does not advertise tool_calls", hasToolCalls(sol)],
      ["advertised context window is below 1M", hasContextAtLeast(sol, ONE_M_TOKENS)],
      ["does not advertise a high reasoning effort", supportsEffort(sol, "high")],
      ["does not advertise a supported Responses endpoint", supportsEndpoint(sol, "responses")],
      ["has no usable max_prompt_tokens/max_output_tokens limits", hasUsableLimits(sol)],
    ],
    missing,
  )
  validateRequiredModel(
    luna,
    MAX_PROFILE_MODELS.luna,
    [
      ["does not advertise tool_calls", hasToolCalls(luna)],
      ["advertised context window is below 1M", hasContextAtLeast(luna, ONE_M_TOKENS)],
      ["does not advertise a high reasoning effort", supportsEffort(luna, "high")],
      ["does not advertise a max reasoning effort", supportsEffort(luna, "max")],
      ["does not advertise a supported Responses endpoint", supportsEndpoint(luna, "responses")],
      ["has no usable max_prompt_tokens/max_output_tokens limits", hasUsableLimits(luna)],
    ],
    missing,
  )
  validateRequiredModel(
    gemini,
    MAX_PROFILE_MODELS.gemini,
    [
      ["does not advertise tool_calls", hasToolCalls(gemini)],
      ["advertised context window is below 1M", hasContextAtLeast(gemini, ONE_M_TOKENS)],
      ["does not advertise a high reasoning effort", supportsEffort(gemini, "high")],
      ["does not advertise a supported Chat Completions endpoint", supportsEndpoint(gemini, "chat")],
      ["has no usable max_prompt_tokens/max_output_tokens limits", hasUsableLimits(gemini)],
    ],
    missing,
  )
  validateRequiredModel(
    opus,
    MAX_PROFILE_MODELS.opus,
    [
      ["advertised context window is below 1M", hasContextAtLeast(opus, ONE_M_TOKENS)],
      ["does not advertise adaptive_thinking", opus?.capabilities?.supports?.adaptive_thinking === true],
      ["does not advertise a high reasoning effort", supportsEffort(opus, "high")],
      ["does not advertise a supported Messages endpoint", supportsEndpoint(opus, "messages")],
      ["has no usable max_prompt_tokens/max_output_tokens limits", hasUsableLimits(opus)],
    ],
    missing,
  )

  // Grok is intentionally optional. A malformed optional entry is simply
  // omitted from the max projection; it must never make launch fail or be
  // decorated as a 1M model.
  const geminiUsable = usableGemini(gemini)
  const grokUsable = usableGrok(grok)

  return {
    ok: missing.length === 0,
    missing,
    models: {
      sol: sol && !missing.some((entry) => entry.startsWith(`${MAX_PROFILE_MODELS.sol}:`)) ? sol : undefined,
      luna: luna && !missing.some((entry) => entry.startsWith(`${MAX_PROFILE_MODELS.luna}:`)) ? luna : undefined,
      gemini: geminiUsable ? gemini : undefined,
      grok: grokUsable ? grok : undefined,
      opus: opus && !missing.some((entry) => entry.startsWith(`${MAX_PROFILE_MODELS.opus}:`)) ? opus : undefined,
      thirdLab: grokUsable && supportsEffort(grok, "high")
        ? "grok"
        : geminiUsable
          ? "gemini"
          : undefined,
    },
  }
}

export function formatMaxPrerequisiteFailure(
  missing: ReadonlyArray<string>,
): string {
  return (
    "github-router claude -m max requires the following live-catalog capabilities, "
    + "which this account's catalog does not fully provide:\n"
    + missing.map((entry) => `  - ${entry}`).join("\n")
    + "\n\nMax launches do not fall back to arbitrary older models. "
    + "Use plain `github-router claude` for the standard profile."
  )
}

export function maxModelIsOneM(
  model: Model | undefined,
): boolean {
  return (
    (model?.capabilities?.limits?.max_context_window_tokens ?? 0) >= ONE_M_TOKENS
  )
}

export function maxModelSupportsEffort(
  model: Model | undefined,
  effort: Effort,
): boolean {
  return supportsEffort(model, effort)
}

export function maxModelHasUsableLimits(model: Model | undefined): boolean {
  return hasUsableLimits(model)
}

export function maxThirdLabModel(): string | undefined {
  const gemini = catalogModel(MAX_PROFILE_MODELS.gemini)
  if (usableGemini(gemini)) return MAX_PROFILE_MODELS.gemini
  const grok = catalogModel(MAX_PROFILE_MODELS.grok)
  return usableGrok(grok) ? MAX_PROFILE_MODELS.grok : undefined
}

export function maxGeminiModel(): string | undefined {
  const model = catalogModel(MAX_PROFILE_MODELS.gemini)
  return model && usableGemini(model) ? model.id : undefined
}

export function maxGrokModel(): string | undefined {
  const model = catalogModel(MAX_PROFILE_MODELS.grok)
  return model && usableGrok(model) ? model.id : undefined
}

/** Grok replacement for max-profile surfaces that require high effort. */
export function maxGrokHighModel(): string | undefined {
  const model = catalogModel(MAX_PROFILE_MODELS.grok)
  return model && usableGrokReviewer(model) ? model.id : undefined
}

/** Max-only replacement for any standard Gemini Pro assignment. */
export function maxProReplacementModel():
  | typeof MAX_PROFILE_MODELS.grok
  | typeof MAX_PROFILE_MODELS.gemini
  | undefined {
  if (maxGrokHighModel()) return MAX_PROFILE_MODELS.grok
  if (maxGeminiModel()) return MAX_PROFILE_MODELS.gemini
  return undefined
}

export function maxOpusModel(): string | undefined {
  const model = catalogModel(MAX_PROFILE_MODELS.opus)
  return model && hasContextAtLeast(model, ONE_M_TOKENS)
    && model.capabilities?.supports?.adaptive_thinking === true
    && supportsEffort(model, "high")
    && supportsEndpoint(model, "messages")
    && hasUsableLimits(model)
    ? model.id
    : undefined
}

export function maxLunaMaxModel(): string | undefined {
  const model = catalogModel(MAX_PROFILE_MODELS.luna)
  return model
    && hasToolCalls(model)
    && hasContextAtLeast(model, ONE_M_TOKENS)
    && supportsEffort(model, "max")
    && supportsEndpoint(model, "responses")
    && hasUsableLimits(model)
    ? model.id
    : undefined
}

export function maxReviewerModel(): string | undefined {
  const grok = maxGrokHighModel()
  if (grok) return grok
  return maxLunaMaxModel()
}

export function maxCatalogModel(id: string): Model | undefined {
  return catalogModel(id)
}

export function maxCatalogModels(): ReadonlyArray<Model> {
  return catalogModels()
}