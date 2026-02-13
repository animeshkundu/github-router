import consola from "consola"

import { state } from "~/lib/state"

import { type AnthropicResponse } from "./anthropic-types"

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}

/**
 * Normalize a client-supplied model name to a Copilot-compatible model ID.
 *
 * Handles:
 * - Exact matches (e.g. `claude-opus-4.6-1m` → already valid)
 * - Anthropic dash-notation → Copilot dot-notation (e.g. `claude-opus-4-6` → `claude-opus-4.6`)
 * - Date suffix stripping (e.g. `claude-sonnet-4-20250514` → `claude-sonnet-4`)
 * - Variant suffix stripping as fallback (e.g. `-1m`, `-fast`)
 */
export function normalizeCopilotModelName(model: string): string {
  const modelIds = state.models?.data.map((m) => m.id) ?? []
  const modelIdSet = new Set(modelIds)

  // 1. Exact match — already a valid Copilot model ID
  if (modelIdSet.has(model)) {
    return model
  }

  // 2. Convert Anthropic dash-notation to Copilot dot-notation
  //    e.g. claude-opus-4-6 → claude-opus-4.6, claude-haiku-4-5 → claude-haiku-4.5
  //    Pattern: after the model family name, replace -X-Y with -X.Y
  //    where X and Y are single digits (version numbers like 4-6, 4-5)
  const dotConverted = model.replace(
    /^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)/,
    "$1.$2",
  )
  if (dotConverted !== model && modelIdSet.has(dotConverted)) {
    consola.info(
      `Model translated: "${model}" → "${dotConverted}" (dash→dot conversion)`,
    )
    return dotConverted
  }

  // 3. Strip date suffixes (-YYYYMMDD) from the converted name
  const withoutDate = dotConverted.replace(/-\d{8}$/, "")
  if (withoutDate !== dotConverted && modelIdSet.has(withoutDate)) {
    consola.info(
      `Model translated: "${model}" → "${withoutDate}" (date suffix stripped)`,
    )
    return withoutDate
  }

  // 4. Strip known variant suffixes (-1m, -fast) as fallback
  const withoutVariant = withoutDate.replace(/-(1m|fast)$/, "")
  if (withoutVariant !== withoutDate && modelIdSet.has(withoutVariant)) {
    consola.info(
      `Model translated: "${model}" → "${withoutVariant}" (variant suffix stripped)`,
    )
    return withoutVariant
  }

  // 5. Prefix match — find the longest Copilot model ID that is a prefix
  const candidates = modelIds
    .filter((id) => withoutVariant.startsWith(id))
    .sort((a, b) => b.length - a.length)
  if (candidates.length > 0) {
    consola.info(
      `Model translated: "${model}" → "${candidates[0]}" (prefix match)`,
    )
    return candidates[0]
  }

  // 6. No match — for Claude models, fall back to claude-opus-4.6
  if (model.startsWith("claude")) {
    const fallback = "claude-opus-4.6"
    const claudeModels = modelIds
      .filter((id) => id.startsWith("claude"))
      .join(", ")
    consola.warn(
      `Model not found in Copilot models: "${model}" → falling back to "${fallback}" (available: ${claudeModels})`,
    )
    return fallback
  }

  return model
}
