import {
  canonicalizeAliasModel,
  isMaxModelAlias,
  isRetiredFastModelAlias,
  resolveModelAlias,
} from "./launch-profile"
import { preprocessMaxRequest } from "./max-request-preprocess"
import { stripTrailingOneMSuffix } from "./model-suffix"
import type { LaunchRegistryEntry } from "./state"

export type FastFixedEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

type AnyRecord = Record<string, unknown>

export interface FastRequestPreprocessResult {
  body: string
  originalModel?: string
  modified: boolean
  rejectedAlias?: string
  retiredAlias?: string
  rejectedModel?: string
}

const cheapFamily = (profileId?: string): boolean =>
  profileId === "cheap" || profileId === "cheap1m"

/**
 * Apply authenticated fast/cheap-profile model and effort policy before
 * ordinary model resolution. Synthetic aliases are refused outside an
 * authenticated fast or cheap launch, so raw/BYO traffic cannot opt itself
 * into private profile semantics. The cheap family shares fast's effort
 * mapping (same model-to-effort rows, just bare subagent slugs at the
 * wiring layer), so this preprocess is shared. Note the reviewer differs:
 * fast reviews on Sonnet 5/xhigh while cheap reviews on Luna/max — both
 * rows exist here, so each profile's reviewer resolves to its fixed effort.
 */
export function preprocessFastRequest(
  rawBody: string,
  launch: LaunchRegistryEntry | undefined,
  subagentRequest = false,
): FastRequestPreprocessResult {
  if (launch?.profileId === "max") {
    return preprocessMaxRequest(rawBody, launch, subagentRequest)
  }
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody) as AnyRecord
  } catch {
    return { body: rawBody, modified: false }
  }
  const originalModel = typeof parsed.model === "string" ? parsed.model : undefined
  if (!originalModel) return { body: rawBody, modified: false }

  if (isRetiredFastModelAlias(originalModel)) {
    return { body: rawBody, originalModel, modified: false, retiredAlias: originalModel }
  }
  const alias = resolveModelAlias(originalModel)
  if (alias && (launch?.profileId !== "fast" && !cheapFamily(launch?.profileId) || isMaxModelAlias(originalModel))) {
    return { body: rawBody, originalModel, modified: false, rejectedAlias: originalModel }
  }
  if (launch?.profileId !== "fast" && !cheapFamily(launch?.profileId)) {
    return { body: rawBody, originalModel, modified: false }
  }

  const { base: bare } = stripTrailingOneMSuffix(originalModel)
  let effort: FastFixedEffort | undefined
  if (alias) {
    effort = alias.absentEffortDefault
    parsed.model = canonicalizeAliasModel(originalModel)
  } else if (bare === "gpt-5.6-luna") {
    effort = "max"
  } else if (bare === "gpt-5.6-sol") {
    effort = "high"
  } else if (bare === "grok-4.6") {
    effort = "medium"
  } else if (bare === "gemini-3.8-flash") {
    // The curated model picker exposes Gemini 3.8 Flash. Within an authenticated fast
    // launch that selection is the lead/driver role, fixed at high.
    effort = "high"
  } else if (bare === "claude-sonnet-5") {
    effort = "xhigh"
  } else if (bare === "claude-opus-5") {
    effort = "high"
  }
  if (!effort && !alias) {
    return {
      body: rawBody,
      originalModel,
      modified: false,
      rejectedModel: originalModel,
    }
  }

  const outputConfig = parsed.output_config && typeof parsed.output_config === "object"
    ? parsed.output_config as AnyRecord
    : {}
  parsed.output_config = { ...outputConfig, effort }
  const thinking = parsed.thinking
  if (thinking && typeof thinking === "object" && (thinking as AnyRecord).type === "enabled") {
    parsed.thinking = { type: "adaptive" }
  }
  return {
    body: JSON.stringify(parsed),
    originalModel,
    modified: true,
  }
}
