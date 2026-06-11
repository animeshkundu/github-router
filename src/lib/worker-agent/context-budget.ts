/**
 * Per-run context budget for worker agents.
 *
 * The worker drives a bare Pi `Agent` whose every turn appends full tool
 * output to the transcript. Without a budget a long/heavy run overflows the
 * model's input window → upstream 400 → `stopReason=error` → empty answer
 * (proven on Google Maps browse). This module derives ONE budget from the
 * resolved model's catalog window so the three defenses never drift:
 *
 *   - the structural compactor (`compaction.ts`, via `transformContext`) keeps
 *     the MESSAGE-transcript token sum under `pruneTargetTokens`, triggered at
 *     `compactTriggerTokens`, escalating (current-turn truncation) above
 *     `hardLimitTokens`;
 *   - the `afterToolCall` per-result cap bounds a single tool result at
 *     `perResultCapBytes` (the aggregate across a parallel batch is the
 *     compactor's job);
 *   - the request-boundary backstop (in the stream-fn) rejects an assembled
 *     payload above `inputHardLimitTokens` with a visible diagnostic.
 *
 * It is a PER-RUN value object (built in `runWorkerAgent`, threaded by
 * closure) — NOT module-level state — because parallel worker runs resolve
 * different models with different windows and would otherwise corrupt each
 * other. There is no mutable module-level state in this file.
 *
 * Token counts are estimates (the worker has no provider tokenizer). We use a
 * deliberately conservative chars/token ratio: dense DOM-JSON / HTML (what
 * `read_page` returns) tokenizes denser than prose, so a low ratio must
 * OVER-count tokens, never under-count (under-counting is what silently
 * defeats a budget). The compactor refines this with a UTF-8 byte floor; the
 * backstop is the hard correctness boundary on top.
 */

/** Conservative bytes/token for dense DOM-JSON; over-counts tokens by design. */
const BYTES_PER_TOKEN = 3

const OUTPUT_RESERVE_TOKENS = 12_000
const TOOL_SCHEMA_RESERVE_TOKENS = 6_000
const SYSTEM_RESERVE_TOKENS = 2_000
/** Fraction of the window reserved for assembly framing / separators. */
const ASSEMBLY_MARGIN_FRACTION = 0.02

/**
 * Byte-equivalent of one image for token estimation. A vision image costs the
 * model ~1.5k tokens regardless of its (base64) byte length, so counting it as
 * ~1.6k tokens (4800 bytes / 3) is right — counting the raw base64 bytes would
 * over-estimate by ~45×. Used by BOTH the compactor and the request backstop
 * so they treat images consistently.
 */
export const IMAGE_BYTES_EQUIV = 4800

const COMPACT_TRIGGER_FRACTION = 0.8
const PRUNE_TARGET_FRACTION = 0.6
const HARD_LIMIT_FRACTION = 0.92
/** Cap on the protected recent suffix so the prunable window stays non-empty. */
const MAX_PROTECTED_FRACTION = 0.5
const KEEP_RECENT_FLOOR_TOKENS = 20_000
const KEEP_RECENT_FRACTION = 0.25

const PER_RESULT_CAP_FRACTION = 0.3
const PER_RESULT_CAP_MIN_BYTES = 64 * 1024
const PER_RESULT_CAP_MAX_BYTES = 256 * 1024

export interface ContextBudget {
  /** Catalog context window, tokens. */
  readonly windowTokens: number
  /** Hard input bound for the assembled payload (window − output reserve). */
  readonly inputHardLimitTokens: number
  /** Budget for the MESSAGE transcript alone (input bound − system/tool reserves). */
  readonly promptBudgetTokens: number
  /** Compactor: prune when the structural transcript sum exceeds this. */
  readonly compactTriggerTokens: number
  /** Compactor: prune (pass 1) until the sum is at/below this. */
  readonly pruneTargetTokens: number
  /** Compactor: escalate to current-turn truncation above this. */
  readonly hardLimitTokens: number
  /** Compactor: protect a recent suffix of at least this many tokens... */
  readonly keepRecentTokens: number
  /** ...but never protect more than this (keeps the prunable window non-empty). */
  readonly maxProtectedTokens: number
  /** `afterToolCall`: per-result model-visible byte cap. */
  readonly perResultCapBytes: number
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Estimate token count from a UTF-8 byte length (over-counts by design). */
export function tokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN)
}

/**
 * Build a per-run budget from the model's catalog context window (tokens).
 *
 * Returns `undefined` when the window is unknown / non-positive — callers
 * MUST no-op (no compaction, no dynamic cap) rather than prune blindly
 * against a guessed window. This is the safe degradation on a catalog that
 * doesn't report `max_context_window_tokens`.
 */
export function makeContextBudget(
  windowTokens: number | undefined,
): ContextBudget | undefined {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return undefined
  }
  const inputHardLimitTokens = Math.max(
    0,
    Math.floor(windowTokens * (1 - ASSEMBLY_MARGIN_FRACTION)) - OUTPUT_RESERVE_TOKENS,
  )
  const promptBudgetTokens = Math.max(
    0,
    inputHardLimitTokens - TOOL_SCHEMA_RESERVE_TOKENS - SYSTEM_RESERVE_TOKENS,
  )
  return {
    windowTokens,
    inputHardLimitTokens,
    promptBudgetTokens,
    compactTriggerTokens: Math.floor(promptBudgetTokens * COMPACT_TRIGGER_FRACTION),
    pruneTargetTokens: Math.floor(promptBudgetTokens * PRUNE_TARGET_FRACTION),
    hardLimitTokens: Math.floor(promptBudgetTokens * HARD_LIMIT_FRACTION),
    keepRecentTokens: Math.max(
      KEEP_RECENT_FLOOR_TOKENS,
      Math.floor(promptBudgetTokens * KEEP_RECENT_FRACTION),
    ),
    // Never below keepRecent — else `recentCutIndex` would hit the protected
    // cap before the keep-recent / turn-boundary logic and protect a partial,
    // non-turn-aligned suffix on small windows (codex review). On the large
    // production windows 0.5·promptBudget dominates anyway.
    maxProtectedTokens: Math.max(
      Math.max(
        KEEP_RECENT_FLOOR_TOKENS,
        Math.floor(promptBudgetTokens * KEEP_RECENT_FRACTION),
      ),
      Math.floor(promptBudgetTokens * MAX_PROTECTED_FRACTION),
    ),
    perResultCapBytes: clamp(
      Math.round(windowTokens * PER_RESULT_CAP_FRACTION * BYTES_PER_TOKEN),
      PER_RESULT_CAP_MIN_BYTES,
      PER_RESULT_CAP_MAX_BYTES,
    ),
  }
}
