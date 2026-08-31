import {
  canonicalizeAliasModel,
  isMaxModelAlias,
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
  rejectedModel?: string
}

/**
 * Apply authenticated fast-profile model and effort policy before ordinary model
 * resolution. Synthetic aliases are refused outside an authenticated fast
 * launch, so raw/BYO traffic cannot opt itself into private profile semantics.
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

  const alias = resolveModelAlias(originalModel)
  if (alias && (launch?.profileId !== "fast" || isMaxModelAlias(originalModel))) {
    return { body: rawBody, originalModel, modified: false, rejectedAlias: originalModel }
  }
  if (launch?.profileId !== "fast") {
    return { body: rawBody, originalModel, modified: false }
  }

  const { base: bare } = stripTrailingOneMSuffix(originalModel)
  let effort: FastFixedEffort | undefined
  if (alias) {
    effort = alias.absentEffortDefault
    parsed.model = canonicalizeAliasModel(originalModel)
  } else if (bare === "gpt-5.6-luna") {
    // The global gateway picker exposes bare Luna. Within an authenticated fast
    // launch that selection is the lead/driver role, fixed at max; role-specific
    // Explore/implementer traffic uses private aliases above.
    effort = "max"
  } else if (bare === "gpt-5.6-sol") {
    effort = "high"
  } else if (bare === "grok-4.6") {
    effort = "medium"
  } else if (bare === "gemini-3.7-flash") {
    effort = "high"
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
