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
export const WORKER_THINKING_LEVELS: ReadonlyArray<WorkerThinkingLevel> = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

const THINKING_ORDER = WORKER_THINKING_LEVELS

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
   * when the catalog doesn't report one. The engine uses a conservative
   * fallback budget for compaction/capping when undefined, while leaving the
   * request-boundary backstop advisory because the real window is unknown.
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
  // context budget. When absent, the engine uses a fallback floor for
  // compaction/per-result caps but does not hard-reject at the request boundary.
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
      WORKER_THINKING_LEVELS.includes(l as WorkerThinkingLevel)
      && l !== "off",
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

/** Per-1M-token relative units derived from the live Copilot catalog. */
export interface CatalogTokenPrices {
  in: number
  out: number
}

const CATALOG_PRICE_SCALE = 1_000_000_000
const TOKENS_PER_MILLION = 1_000_000

/**
 * Looks up a model's live batch prices and converts them to the repository's
 * per-1M-token relative units. Missing or malformed prices stay absent so
 * callers never mistake a guess or zero for a catalog fact.
 */
export function catalogTokenPrices(modelId: string): CatalogTokenPrices | undefined {
  const prices = state.models?.data.find((model) => model.id === modelId)?.billing?.token_prices
  if (
    !prices
    || typeof prices.batch_size !== "number"
    || !Number.isSafeInteger(prices.batch_size)
    || prices.batch_size <= 0
    || typeof prices.input_price !== "number"
    || !Number.isFinite(prices.input_price)
    || prices.input_price < 0
    || typeof prices.output_price !== "number"
    || !Number.isFinite(prices.output_price)
    || prices.output_price < 0
  ) {
    return undefined
  }

  const toPerMillion = (price: number): number =>
    price / CATALOG_PRICE_SCALE * TOKENS_PER_MILLION / prices.batch_size!

  return {
    in: toPerMillion(prices.input_price),
    out: toPerMillion(prices.output_price),
  }
}

/**
 * Approximate output tokens/sec, median of n=3 per model, measured 2026-08-12
 * through this proxy. Reproduce with `bun scripts/bench-model-speed.ts` — the
 * harness is committed precisely so these numbers can be re-derived and
 * challenged instead of being trusted. Rounded coarsely on purpose: run-to-run
 * variance is large (`gpt-5.6-sol` measured 22 in an early n=1 pass and 74 at
 * n=3), so any digit beyond the leading one or two would be false precision.
 *
 * Wall clock includes time-to-first-token, which is why an early n=1 pass put
 * `gemini-3.1-pro-preview` at 9: that response emitted only 66 tokens, so TTFT
 * dominated. Reasoning tokens are timed but may not appear in `output_tokens`,
 * so heavy-reasoning models are penalised here.
 *
 * This is a deliberately hardcoded, coarse speed hint, indicative and never a
 * per-call benchmark: a recoverable speed retry is safer than a quality score
 * that silently misroutes.
 *
 * NOT the whole picture for agent work. The benchmark also measures p50 latency
 * to a trivial tool call, which is the workload an agent model actually spends
 * its turns on, and the ordering differs from raw generation: `gpt-5.6-sol`
 * generates at 75 but takes ~4.3s to reach a tool call, while `gpt-5.6-luna`
 * takes ~0.9s. That figure is deliberately NOT surfaced to the model, because a
 * second speed axis invites optimising a routing choice that policy already
 * settles (see the decorrelation note below).
 */
export const INDICATIVE_TOKENS_PER_SECOND: Readonly<Record<string, number>> = Object.freeze({
  "gpt-5.6-luna": 120,
  "gpt-5.6-terra": 100,
  "claude-opus-5": 80,
  "gpt-5.6-sol": 75,
  "gemini-3.6-flash": 45,
  "gemini-3.5-flash": 40,
  "gemini-3.1-pro-preview": 25,
})

/** Returns the approximate, indicative output speed when it was measured. */
export function indicativeTokensPerSecond(modelId: string): number | undefined {
  return INDICATIVE_TOKENS_PER_SECOND[modelId]
}

/** One catalog row as surfaced to the model. */
export interface CatalogRow {
  id: string
  vendor: string
  /** Context window in tokens. */
  ctx: number
  /** Max output tokens, omitted when the catalog doesn't advertise it. */
  maxOut?: number
  /** Reasoning efforts this worker layer can actually request. */
  efforts: Array<string>
  /** Live input price in per-1M-token relative units, omitted when malformed. */
  in?: number
  /** Live output price in per-1M-token relative units, omitted when malformed. */
  out?: number
  /** Approximate, indicative output tokens/sec when this model was measured. */
  tps?: number
}

/** Worker-usable models need a big enough window to be worth delegating to. */
const CATALOG_MIN_CONTEXT = 200_000

/**
 * Derived view of the live catalog: every model a worker could actually be
 * pointed at, with the metadata needed to choose between them.
 *
 * Derived facts only, with one explicitly-labelled exception:
 * `INDICATIVE_TOKENS_PER_SECOND` is a dated, coarse measurement whose speed
 * signal is recoverable by retrying a slow selection. A one-liner like "strong
 * reasoning, weak long-context recall" cannot be computed from catalog
 * metadata — it is editorial, it goes stale silently as vendors ship, and the
 * asymmetry is brutal: a MISSING characterization costs one suboptimal pick
 * the model recovers from, while a WRONG one misroutes invisibly at the call
 * site. So this ships facts, the recoverable speed hint, and no quality score.
 *
 * It exists because the hardcoded chains cannot discover anything. Models are
 * live in the catalog that appear nowhere in `src/` — nobody evaluated them
 * because nothing surfaced them. That is a DISCOVERABILITY gap, not a
 * capability gap, which is also why the per-mode and per-agent defaults are
 * deliberately left alone: they encode cross-lab DECORRELATION policy, not
 * just quality. `reviewerModel()` must differ from the implementer's lab so a
 * model never reviews its own output, and no capability table can express
 * "must differ from whoever produced this". `vendor` is included precisely so
 * a caller can reason about lab diversity without being handed a ranking.
 *
 * Efforts are clamped to WORKER_THINKING_LEVELS: nine live models advertise a
 * `max` tier above `xhigh` that the worker layer filters out, so showing the
 * raw array would advertise an effort no worker can request.
 */
export function buildCatalogView(): Array<CatalogRow> {
  const rows: Array<CatalogRow> = []
  for (const model of state.models?.data ?? []) {
    const supports = model.capabilities?.supports
    const limits = model.capabilities?.limits
    if (supports?.tool_calls !== true) continue
    const ctx = limits?.max_context_window_tokens ?? 0
    if (ctx < CATALOG_MIN_CONTEXT) continue
    const efforts = (supports.reasoning_effort ?? []).filter((effort) =>
      (WORKER_THINKING_LEVELS as ReadonlyArray<string>).includes(effort),
    )
    if (efforts.length === 0) continue
    const prices = catalogTokenPrices(model.id)
    const tps = indicativeTokensPerSecond(model.id)
    rows.push({
      id: model.id,
      vendor: model.vendor,
      ctx,
      ...(limits?.max_output_tokens ? { maxOut: limits.max_output_tokens } : {}),
      efforts,
      ...(prices ?? {}),
      ...(tps === undefined ? {} : { tps }),
    })
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}
