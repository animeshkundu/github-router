/**
 * Validate `model` + clamp `thinking` against the live Copilot catalog.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Model + thinking
 * parameters" section).
 *
 * Two-step resolution:
 *
 *   1. Model existence + capability check against `state.models?.data`
 *      (the live Copilot model catalog the proxy pre-fetched at boot).
 *      The model MUST exist and MUST advertise
 *      `capabilities.supports.tool_calls === true` — the worker loop is
 *      function-calling, and a model that can't emit tool_calls is a
 *      one-shot completion at best, not a worker.
 *
 *   2. Thinking-level clamping against the model's
 *      `capabilities.supports.reasoning_effort` allowlist:
 *        - `"off"` passes through unchanged (it's always "less" than
 *          any positive thinking level).
 *        - If the requested level is in the allowlist → pass through.
 *        - If the requested level is above the highest allowed → clamp
 *          to the highest allowed (the "nearest lower tier" rule).
 *        - If the requested level is below all allowed levels → clamp
 *          to the lowest allowed (we honor "thinking on" even if we
 *          can't honor "this little thinking").
 *        - If the model has NO `reasoning_effort` field at all (some
 *          gemini models, claude-opus-4-7 on the messages endpoint,
 *          etc.) → silently set thinking to `"off"` to drop the
 *          parameter entirely. The plan calls this out explicitly:
 *          "no clamp notice in output".
 */

import { state } from "~/lib/state"

import type { ThinkingLevel, WorkerThinkingLevel } from "./types"

/**
 * Canonical thinking-level order. Index is the "tier number" used by
 * the clamp logic. Lower index = less thinking. `"off"` is below
 * everything; `"xhigh"` is the cap.
 */
const THINKING_ORDER: ReadonlyArray<WorkerThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

function tier(level: WorkerThinkingLevel): number {
  const i = THINKING_ORDER.indexOf(level)
  // Unknown level → treat as "high" so a malformed input still gets
  // confined to a meaningful default rather than coming out as -1
  // (below "off"). The MCP schema should keep this branch unreachable
  // in production.
  return i < 0 ? THINKING_ORDER.indexOf("high") : i
}

export interface ResolveOk {
  ok: true
  modelId: string
  thinking: WorkerThinkingLevel
  /**
   * Catalog context window (tokens) for the resolved model, or undefined
   * when the catalog doesn't report one. The engine sizes its per-run
   * `ContextBudget` from this; undefined ⇒ the budget no-ops (no blind
   * compaction/capping).
   */
  contextWindow?: number
}
export interface ResolveErr {
  ok: false
  error: string
}
export type ResolveResult = ResolveOk | ResolveErr

export interface ResolveOpts {
  model: string
  thinking: WorkerThinkingLevel
}

/**
 * Resolve the (model, thinking) pair the engine should pass to the
 * stream function.
 *
 * Pure with respect to its arguments + `state.models?.data`. No I/O,
 * no fetches — the live catalog must already be populated (the proxy
 * fetches it at boot and refreshes it periodically).
 *
 * On error, the message is suitable for embedding verbatim in a
 * `WorkerAgentResult` (`{isError: true, text: error}`); per the plan,
 * the unknown-model error enumerates the catalog's tool_call-capable
 * model ids so the caller can correct without guessing.
 */
export function resolveModelAndThinking(opts: ResolveOpts): ResolveResult {
  const catalog = state.models?.data ?? []

  const found = catalog.find((m) => m.id === opts.model)
  if (!found) {
    const candidates = catalog
      .filter((m) => m.capabilities?.supports?.tool_calls === true)
      .map((m) => m.id)
      .sort()
    const list = candidates.length > 0 ? candidates.join(", ") : "<none>"
    return {
      ok: false,
      error: `Unknown model: ${opts.model}. Available models with tool_calls: ${list}`,
    }
  }

  if (found.capabilities?.supports?.tool_calls !== true) {
    return {
      ok: false,
      error: `Model ${opts.model} does not support tool_calls`,
    }
  }

  // Surface the catalog context window so the engine can size its per-run
  // context budget (compaction + per-result caps + request backstop). Absent
  // ⇒ undefined ⇒ the budget no-ops rather than prune against a guessed window.
  const contextWindow = found.capabilities?.limits?.max_context_window_tokens
  const mkOk = (thinking: WorkerThinkingLevel): ResolveOk => ({
    ok: true,
    modelId: found.id,
    thinking,
    contextWindow,
  })

  const allowedRaw = found.capabilities?.supports?.reasoning_effort
  if (!allowedRaw || allowedRaw.length === 0) {
    // No reasoning_effort knob → drop the param entirely. Pi reads
    // `"off"` and skips the `reasoning` field on the outbound request.
    return mkOk("off")
  }

  // Narrow the allowlist to known levels and rank them by tier.
  const allowed = allowedRaw
    .filter((l): l is ThinkingLevel =>
      (["minimal", "low", "medium", "high", "xhigh"] as const).includes(
        l as ThinkingLevel,
      ),
    )
    .sort((a, b) => tier(a) - tier(b))

  if (allowed.length === 0) {
    // Same effect as "no field at all" — catalog reported the field
    // but none of the values matched a known tier. Drop param.
    return mkOk("off")
  }

  // "off" always passes through — it's a valid "no thinking" override
  // regardless of what the model's allowlist contains.
  if (opts.thinking === "off") {
    return mkOk("off")
  }

  if (allowed.includes(opts.thinking as ThinkingLevel)) {
    return mkOk(opts.thinking)
  }

  const reqTier = tier(opts.thinking)
  // Walk the allowed list from highest to lowest, picking the highest
  // tier that is <= reqTier — the "nearest lower" rule.
  let clamp: ThinkingLevel | undefined
  for (let i = allowed.length - 1; i >= 0; i -= 1) {
    if (tier(allowed[i]!) <= reqTier) {
      clamp = allowed[i]
      break
    }
  }
  if (!clamp) {
    // Requested level is below ALL allowed — fall back to the lowest
    // allowed. We honor "thinking on" even when we can't honor "this
    // little thinking".
    clamp = allowed[0]
  }

  return mkOk(clamp as ThinkingLevel)
}
