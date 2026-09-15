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
  profileId === "cheap" || profileId === "cheap1m" || profileId === "cheapest"

const pinnedProfile = (profileId?: string): boolean =>
  profileId === "fast" || cheapFamily(profileId)

/**
 * Profiles whose every selectable `/model` row must stay at Claude Code's
 * 200K DEFAULT context window (bare id, no `[1m]` accounting bracket).
 * `fast` keeps 1M on lead and subagents by design; `cheap1m` keeps 1M on
 * the lead only (its subagents are bare-by-construction).
 */
const bareEnforcedProfile = (profileId?: string): boolean =>
  profileId === "cheap" || profileId === "cheapest"

function explicitEffortOf(value: unknown): FastFixedEffort | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value as FastFixedEffort
    : undefined
}

/**
 * Apply authenticated fast/cheap-profile model and effort policy before
 * ordinary model resolution. Synthetic aliases are refused outside an
 * authenticated pinned launch, so raw/BYO traffic cannot opt itself into
 * private profile semantics. The cheap family (including cheapest) shares
 * fast's effort mapping (same model-to-effort rows, just bare subagent
 * slugs at the wiring layer), so this preprocess is shared.
 * Note the reviewer differs: fast reviews on Sonnet 5/xhigh while cheap
 * reviews on Luna/max and cheapest reviews on Gemini/high — all rows exist
 * here, so each profile's reviewer resolves to its fixed effort.
 *
 * Pinned-profile isolation (fast/cheap/cheap1m/cheapest): only
 * router-provided models are accepted (anything else is `rejectedModel`).
 * Context: cheap/cheapest traffic is stripped to the bare 200K id;
 * cheap1m subagent traffic is stripped while its lead keeps 1M; fast
 * keeps 1M on both. Effort: picker changes apply to the lead session
 * only — lead requests keep an explicit `output_config.effort` when
 * present and fall back to the fixed mapping otherwise, while subagent
 * traffic (`x-claude-code-agent-id`) always receives its fixed
 * per-model effort.
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
  const profileId = launch?.profileId
  const stripBracket = bareEnforcedProfile(profileId)
    || (profileId === "cheap1m" && subagentRequest)
  const leadCallerControlled = pinnedProfile(profileId) && !subagentRequest
  let fixedEffort: FastFixedEffort | undefined
  if (alias) {
    fixedEffort = alias.absentEffortDefault
    parsed.model = canonicalizeAliasModel(originalModel)
  } else if (bare === "gpt-5.6-luna") {
    fixedEffort = "max"
  } else if (bare === "gpt-5.6-sol") {
    fixedEffort = "high"
  } else if (bare === "grok-4.6") {
    fixedEffort = "medium"
  } else if (bare === "gemini-3.8-flash") {
    // The curated model picker exposes Gemini 3.8 Flash. Within an authenticated fast
    // launch that selection is the lead/driver role, fixed at high.
    fixedEffort = "high"
  } else if (bare === "claude-sonnet-5") {
    fixedEffort = "xhigh"
  } else if (bare === "claude-opus-5") {
    fixedEffort = "high"
  }
  if (!fixedEffort && !alias) {
    return {
      body: rawBody,
      originalModel,
      modified: false,
      rejectedModel: originalModel,
    }
  }

  // Default-context enforcement for the 200K profiles: the `[1m]`
  // bracket is Claude Code's local 1M-accounting unlock. Selecting a
  // decorated row from `/model` would otherwise hand the session (and
  // every downstream subagent) a 1M budget again, defeating the
  // profile's whole cost lever. Strip it here so the wire id — and
  // therefore client accounting and the upstream call after
  // `resolveModel` — stays at the 200K default. `fast` keeps 1M on both
  // lead and subagents; `cheap1m` keeps 1M on the lead only.
  if (stripBracket && typeof parsed.model === "string") {
    parsed.model = stripTrailingOneMSuffix(parsed.model).base
  } else if (stripBracket) {
    parsed.model = bare
  }

  const outputConfig = parsed.output_config && typeof parsed.output_config === "object"
    ? parsed.output_config as AnyRecord
    : {}
  const explicitEffort = explicitEffortOf(outputConfig.effort)
  const effort = leadCallerControlled && explicitEffort ? explicitEffort : fixedEffort
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
