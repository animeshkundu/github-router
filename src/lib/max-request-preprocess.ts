import {
  MAX_LUNA_HIGH_ALIAS_ID,
  MAX_LUNA_MAX_ALIAS_ID,
  maxAliasEffort,
  maxAliasModel,
} from "./launch-profile"
import { MAX_PROFILE_ALLOWED_LEAD_MODEL_IDS } from "./max-profile-contract"
import { stripTrailingOneMSuffix } from "./model-suffix"
import type { LaunchRegistryEntry } from "./state"
import type { Effort } from "./reasoning-effort"

interface AnyRecord {
  [key: string]: unknown
}

export interface MaxRequestPreprocessResult {
  body: string
  originalModel?: string
  modified: boolean
  rejectedModel?: string
  rejectedAlias?: string
}

export function maxRequestError(result: MaxRequestPreprocessResult): string | undefined {
  if (result.rejectedAlias) {
    return `Router-owned model alias ${JSON.stringify(result.rejectedAlias)} is valid only for an authenticated -m max launch.`
  }
  if (result.rejectedModel) {
    return `Model ${JSON.stringify(result.rejectedModel)} is outside the fixed -m max model set (Sol, Luna, Gemini 3.8 Flash, or Opus 5).`
  }
  return undefined
}

const MAX_MODEL_EFFORTS: Readonly<Record<string, Effort>> = Object.freeze({
  "gpt-5.6-sol": "high",
  "gpt-5.6-luna": "high",
  "gemini-3.8-flash": "high",
  "claude-opus-5": "high",
})

function allowedModel(base: string): boolean {
  return (MAX_PROFILE_ALLOWED_LEAD_MODEL_IDS as ReadonlyArray<string>).includes(base)
}

function setEffort(body: AnyRecord, effort: Effort): void {
  const outputConfig = body.output_config && typeof body.output_config === "object"
    ? body.output_config as AnyRecord
    : {}
  if (outputConfig.effort === undefined) {
    body.output_config = { ...outputConfig, effort }
  }
}

/**
 * Apply the bound max profile's lead-model projection. Max is intentionally
 * separate from the fast preprocessor: fast aliases and fixed fast role rules
 * must not become active for max, while arbitrary old/unknown model selections
 * must fail closed rather than silently escape the max surface.
 */
export function preprocessMaxRequest(
  rawBody: string,
  launch: LaunchRegistryEntry | undefined,
  subagentRequest = false,
): MaxRequestPreprocessResult {
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody) as AnyRecord
  } catch {
    return { body: rawBody, modified: false }
  }

  const originalModel = typeof parsed.model === "string" ? parsed.model : undefined
  if (!originalModel) return { body: rawBody, modified: false }
  if (launch?.profileId !== "max") return { body: rawBody, originalModel, modified: false }

  const { base, hadSuffix } = stripTrailingOneMSuffix(originalModel)
  const aliasEffort = maxAliasEffort(originalModel)
  const canonical = maxAliasModel(originalModel)
  if (canonical) {
    const effort = aliasEffort ?? "high"
    parsed.model = hadSuffix ? `${canonical}[1m]` : canonical
    setEffort(parsed, effort)
    if (parsed.thinking && typeof parsed.thinking === "object") {
      const thinking = parsed.thinking as AnyRecord
      if (thinking.type === "enabled") parsed.thinking = { type: "adaptive" }
    }
    return { body: JSON.stringify(parsed), originalModel, modified: true }
  }

  // Grok is never a max lead because its catalog window is below 1M, while
  // Luna, Sonnet, and Grok serve as bound native-subagents. Bound
  // native-subagent traffic receives role-specific defaults (Sonnet xhigh,
  // Grok high, Luna max); lead traffic remains caller-controlled with a high default.
  const allowedSubagentModel = subagentRequest
    && (base === "grok-4.6" || base === "gpt-5.6-luna" || base === "claude-sonnet-5")
  if (!allowedModel(base) && !allowedSubagentModel) {
    return {
      body: rawBody,
      originalModel,
      modified: false,
      rejectedModel: originalModel,
    }
  }

  const effort = allowedSubagentModel
    ? base === "claude-sonnet-5" ? "xhigh" : base === "gpt-5.6-luna" ? "max" : "high"
    : MAX_MODEL_EFFORTS[base]
  if (!effort) {
    return {
      body: rawBody,
      originalModel,
      modified: false,
      rejectedModel: originalModel,
    }
  }

  // The lead's effort picker remains caller-controlled. Only supply the max
  // profile's high default when the request did not express one. A legacy
  // enabled-thinking body is normalized for adaptive-thinking models.
  setEffort(parsed, effort)
  if (parsed.thinking && typeof parsed.thinking === "object") {
    const thinking = parsed.thinking as AnyRecord
    if (thinking.type === "enabled") parsed.thinking = { type: "adaptive" }
  }
  return {
    body: JSON.stringify(parsed),
    originalModel,
    modified: true,
  }
}

export const MAX_PROFILE_ALIAS_IDS = Object.freeze([
  MAX_LUNA_HIGH_ALIAS_ID,
  MAX_LUNA_MAX_ALIAS_ID,
] as const)