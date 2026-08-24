/**
 * Pure helpers for `scripts/probe-prompt-cache.ts` (the opt-in live
 * prompt-cache measurement harness — see `docs/prompt-caching.md`).
 *
 * Split out of the script so the parsing / verdict / catalog-selection logic
 * is unit-testable (`tests/cache-probe.test.ts`) without a live Copilot
 * token, a spawned child process, or real network access. Nothing in this
 * file performs I/O.
 */

import { randomBytes } from "node:crypto"

import type { Model } from "~/services/copilot/get-models"

// ---------------------------------------------------------------------------
// Catalog target resolution
// ---------------------------------------------------------------------------

/** Exact catalog ids the probe measures unconditionally. */
export const EXACT_CACHE_PROBE_TARGETS: ReadonlyArray<string> = [
  "claude-opus-5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gemini-3.7-flash",
]

/**
 * Family prefix for the "highest-context grok-4.6*" requirement. Matched by
 * PREFIX, not exact id: the live catalog may ship `grok-4.6`, a `-mini`, a
 * `-fast` sibling, etc., and the task is to pick whichever sibling advertises
 * the largest context window, not to assume a fixed id. Grok's advertised
 * window may be smaller than the other four targets' (e.g. 500k vs 1M) —
 * `ResolvedCacheProbeTarget.contextWindow` carries the true number so the
 * harness labels it honestly instead of assuming parity.
 */
export const GROK_FAMILY_PREFIX = "grok-4.6"

export interface ResolvedCacheProbeTarget {
  /** One of `EXACT_CACHE_PROBE_TARGETS`, or the literal `"grok-4.6*"` for the
   * family wildcard. */
  requestedId: string
  /** The catalog id actually resolved. Differs from `requestedId` only for
   * the grok wildcard. Undefined when nothing in the live catalog matched. */
  catalogId?: string
  /** Advertised context window in tokens, when the catalog reports one. */
  contextWindow?: number
  found: boolean
}

export interface CacheProbeCatalogSelection {
  targets: ReadonlyArray<ResolvedCacheProbeTarget>
  /** `requestedId`s that resolved to nothing in the live catalog. */
  missing: ReadonlyArray<string>
}

function contextWindowOf(model: Model): number | undefined {
  return model.capabilities?.limits?.max_context_window_tokens
}

/**
 * Resolves the five probe targets against a live (or fixture) model
 * catalog. Exact-id match for the first four; a highest-advertised-context
 * walk over every `grok-4.6*` sibling for the fifth. Deterministic given a
 * stable catalog: ties keep whichever candidate the catalog listed first.
 */
export function selectCacheProbeTargets(
  catalog: ReadonlyArray<Model>,
): CacheProbeCatalogSelection {
  const targets: Array<ResolvedCacheProbeTarget> = []
  for (const requestedId of EXACT_CACHE_PROBE_TARGETS) {
    const model = catalog.find((m) => m.id === requestedId)
    targets.push({
      requestedId,
      catalogId: model?.id,
      contextWindow: model ? contextWindowOf(model) : undefined,
      found: model !== undefined,
    })
  }

  let bestGrok: Model | undefined
  let bestGrokWindow = -1
  for (const model of catalog) {
    if (!model.id.startsWith(GROK_FAMILY_PREFIX)) continue
    const window = contextWindowOf(model) ?? 0
    if (window > bestGrokWindow) {
      bestGrok = model
      bestGrokWindow = window
    }
  }
  targets.push({
    requestedId: `${GROK_FAMILY_PREFIX}*`,
    catalogId: bestGrok?.id,
    contextWindow: bestGrok ? contextWindowOf(bestGrok) : undefined,
    found: bestGrok !== undefined,
  })

  return {
    targets,
    missing: targets.filter((t) => !t.found).map((t) => t.requestedId),
  }
}

// ---------------------------------------------------------------------------
// Cache oracle class: which verdict rule applies to a resolved catalog id.
// ---------------------------------------------------------------------------

export type CacheOracleClass = "strict" | "provider-managed"

/**
 * "strict" — native Claude (`claude-*`) and the gpt-5.6 family: these are
 * expected to report cache usage reliably through Copilot, so an absent OR
 * a present-but-zero warm `cache_read_input_tokens` is a FAIL (a regression
 * signal, not an unknown).
 *
 * "provider-managed" — Gemini, Grok, and anything else not matched above:
 * missing cache fields are INCONCLUSIVE. When fields are present, the harness
 * reports the observed reuse ratio but does not impose the 90% Claude/GPT
 * target: providers choose their own implicit-cache chunk and threshold policy,
 * so a partial read is measurable behavior rather than a router regression.
 */
export function cacheOracleClassFor(catalogId: string): CacheOracleClass {
  if (catalogId.startsWith("claude-") || catalogId.startsWith("gpt-5.6")) return "strict"
  return "provider-managed"
}

// ---------------------------------------------------------------------------
// stream-json transcript parsing
// ---------------------------------------------------------------------------

export interface CacheUsageSample {
  inputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
}

/**
 * Parses one line of a `claude --output-format stream-json` transcript and
 * returns the usage sample carried by a TOP-LEVEL `result` event, or
 * `undefined` for every other line: non-JSON launch/log noise, `system`/
 * `user`/`assistant` events, and any `result` event whose
 * `parent_tool_use_id` is set (a subagent's own transcript line — not a
 * turn this harness issued).
 *
 * CORRECTED SOURCE (was: `assistant.message.usage`). Live measurement found
 * that for a request routed through this repo's translation shim (GPT-5.6,
 * Gemini, Grok — everything except native Claude), the `assistant` event's
 * `message.usage` is a SYNTHESIZED placeholder (all zeros): Claude Code
 * builds it from its own `message_start` framing, not from the upstream
 * provider's actual usage. The real numbers only ever reach the client on
 * the per-turn `result` event's `usage` field (confirmed live for GPT-5.6:
 * `assistant.message.usage` all zero, `result.usage` reporting real
 * `input`/`cache_read`/`cache_creation` figures that also matched a
 * `stream_event` `message_delta`). Native Claude's own `result.usage` is
 * ALSO correct per turn — it is NOT the whole-session cumulative figure
 * (that lives in a separate `modelUsage`-style field this harness does not
 * read) — so `result.usage` is now the ONE primary source for every model,
 * never `assistant.message.usage`. A harness that kept reading
 * `assistant.message.usage` produced zero samples (and false FAILs) for
 * every non-Claude model; see `tests/cache-probe.test.ts` for a regression
 * test reproducing exactly that shape (an all-zero `assistant` line
 * followed by a nonzero `result` line).
 */
export function parseCacheProbeResultUsage(line: string): CacheUsageSample | undefined {
  const obj = parseTopLevelResultEvent(line)
  if (!obj) return undefined
  const usage = obj.usage
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined
  const u = usage as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
  return {
    inputTokens: num(u.input_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
  }
}

/**
 * True for a top-level `result` event, regardless of whether it carries a
 * usable `usage` field. Used to count how many per-turn `result` events the
 * transcript actually contained — if that count differs from
 * `parseCacheProbeResultUsage`'s sample count, some `result` event was seen
 * but had no extractable `usage`, which is itself diagnostic (recorded in
 * `TrialRecord.resultEventCount` by the script, never silently dropped).
 */
export function isCacheProbeResultEvent(line: string): boolean {
  return parseTopLevelResultEvent(line) !== undefined
}

/** Shared top-level-`result`-event parse + shape guard for the two functions
 * above. Returns the parsed object (so a caller can read `.usage`) or
 * `undefined` when the line isn't JSON, isn't a `result` event, or carries a
 * `parent_tool_use_id` (not top-level). */
function parseTopLevelResultEvent(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  if (obj.type !== "result") return undefined
  const parent = obj.parent_tool_use_id
  if (parent !== undefined && parent !== null) return undefined
  return obj
}

/**
 * Collects one `CacheUsageSample` per top-level `result` event with a usable
 * `usage` field, in line order, from a full transcript (or any array of
 * lines). Pure convenience wrapper around `parseCacheProbeResultUsage` for
 * tests and any caller that already has the whole transcript in memory;
 * the live script processes lines as they stream instead of buffering the
 * whole transcript, but uses the exact same per-line parser.
 */
export function collectCacheProbeSamples(lines: ReadonlyArray<string>): Array<CacheUsageSample> {
  const samples: Array<CacheUsageSample> = []
  for (const line of lines) {
    const sample = parseCacheProbeResultUsage(line)
    if (sample) samples.push(sample)
  }
  return samples
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type CacheProbeVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "AMBIGUOUS"

export interface CacheProbeVerdictResult {
  verdict: CacheProbeVerdict
  reason: string
  /** Cold turn's own total (`input + cache_creation + cache_read`), when
   * computable. Informational only — NOT the ratio denominator (see
   * `cacheCoverageRatio`). */
  coldTotalInputTokens?: number
  /** mean over warm turns of `(cache_read_input_tokens_i +
   * cache_creation_input_tokens_i) / turnTotal_i`, where `turnTotal_i` is
   * THAT turn's own `input + cache_creation + cache_read`. Per-turn, not
   * divided by the (possibly much smaller) cold
   * total, because a growing multi-turn conversation's later turns carry
   * far more input than the first: dividing by a fixed cold denominator can
   * read as near-100% coverage even when only the system prompt is cached
   * and the accumulating conversation history is reprocessed from scratch
   * every turn (the exact failure mode this ratio exists to catch). */
  cacheCoverageRatio?: number
}

/**
 * PASS requires the mean per-turn read-coverage ratio to reach this
 * fraction, not merely `cache_read_input_tokens > 0`. A provider can report
 * a nonzero read while still reprocessing nearly all of a growing
 * conversation's history from scratch (observed live: warm turns reporting
 * `cache_read≈2k` against `input≈27k`, i.e. only the static system prompt
 * was ever cached) — a bare positivity check would PASS that. 0.9 is below
 * the ~0.94-0.999 measured on a native multi-turn Claude session (where the
 * whole growing transcript is genuinely cached) and above the near-zero
 * ratio measured on the system-prompt-only failure mode, so it separates
 * the two without being so tight that ordinary per-turn token-count noise
 * flips the verdict.
 */
export const DEFAULT_CACHE_PROBE_PASS_RATIO = 0.9

/**
 * Computes the PASS/FAIL/INCONCLUSIVE/AMBIGUOUS verdict for one model's one
 * trial, from the ordered list of per-turn `result`-event usage samples that
 * `parseCacheProbeResultUsage` collected across the whole run (one `result`
 * event per user turn — never `assistant.message.usage`, which is a
 * synthesized all-zero placeholder for every translated non-Claude model).
 *
 * `expectedTurns` is the number of user turns the harness sent. A sample
 * count that doesn't match is reported as AMBIGUOUS rather than silently
 * truncated/padded into cold/warm buckets — extra `result` events usually
 * mean the model made an additional API call (e.g. a tool round-trip) that
 * this harness's per-turn accounting cannot honestly attribute.
 */
export function computeCacheProbeVerdict(
  oracleClass: CacheOracleClass,
  samples: ReadonlyArray<CacheUsageSample>,
  expectedTurns: number,
  passRatioThreshold: number = DEFAULT_CACHE_PROBE_PASS_RATIO,
): CacheProbeVerdictResult {
  if (expectedTurns < 2) {
    return { verdict: "AMBIGUOUS", reason: "expectedTurns must be >= 2 (need a cold and at least one warm turn)" }
  }
  if (samples.length !== expectedTurns) {
    return {
      verdict: "AMBIGUOUS",
      reason:
        `expected ${expectedTurns} top-level result-event usage samples, observed ${samples.length} — `
        + "the run may have made extra API calls (e.g. a tool round-trip) or fewer than requested; "
        + "not laundering this into cold/warm buckets.",
    }
  }

  const [cold, ...warm] = samples

  const metricsPresent = (s: CacheUsageSample) =>
    s.cacheReadInputTokens !== undefined && s.cacheCreationInputTokens !== undefined
  const allPresent = metricsPresent(cold) && warm.every(metricsPresent)

  const coldTotalInputTokens =
    (cold.inputTokens ?? 0) + (cold.cacheCreationInputTokens ?? 0) + (cold.cacheReadInputTokens ?? 0)

  if (!allPresent) {
    return oracleClass === "strict"
      ? {
          verdict: "FAIL",
          reason:
            "cache usage fields (cache_read_input_tokens/cache_creation_input_tokens) were absent "
            + "from a native-Claude/gpt-5.6 usage payload",
          coldTotalInputTokens,
        }
      : {
          verdict: "INCONCLUSIVE",
          reason:
            "provider did not report cache usage fields on every turn "
            + "(Gemini/Grok are not guaranteed to report them)",
          coldTotalInputTokens,
        }
  }

  // Per-turn ratio: cached input (both reused and newly written) divided by
  // this turn's own total. A provider may move a stable prefix forward by
  // writing the newest tail while reading the older prefix; both are cache-
  // optimized input, while only `input_tokens` is paid fully uncached.
  const perTurnRatios: Array<number> = []
  for (const s of warm) {
    const cacheRead = s.cacheReadInputTokens ?? 0
    const cacheWrite = s.cacheCreationInputTokens ?? 0
    const total = (s.inputTokens ?? 0) + cacheWrite + cacheRead
    if (total > 0) perTurnRatios.push((cacheRead + cacheWrite) / total)
  }
  const cacheCoverageRatio =
    perTurnRatios.length > 0
      ? perTurnRatios.reduce((sum, r) => sum + r, 0) / perTurnRatios.length
      : undefined

  if (cacheCoverageRatio === undefined) {
    return {
      verdict: "FAIL",
      reason: "every warm turn reported a zero total (input + cache_creation + cache_read); cannot compute a coverage ratio",
      coldTotalInputTokens,
    }
  }

  if (oracleClass === "provider-managed") {
    return cacheCoverageRatio > 0
      ? {
          verdict: "PASS",
          reason:
            `provider-managed cache reported ${(cacheCoverageRatio * 100).toFixed(1)}% warm-turn read coverage; `
            + "recorded without imposing the Claude/GPT cache target",
          coldTotalInputTokens,
          cacheCoverageRatio,
        }
      : {
          verdict: "FAIL",
          reason: "provider reported cache fields but no warm cache read",
          coldTotalInputTokens,
          cacheCoverageRatio,
        }
  }

  if (cacheCoverageRatio < passRatioThreshold) {
    return {
      verdict: "FAIL",
      reason:
        `mean warm-turn cache coverage ${(cacheCoverageRatio * 100).toFixed(1)}% is below the `
        + `${(passRatioThreshold * 100).toFixed(0)}% threshold — the provider read SOME cache but is `
        + "reprocessing a meaningful share of input from scratch every turn (e.g. only a static system "
        + "prompt is cached while a growing conversation history is not)",
      coldTotalInputTokens,
      cacheCoverageRatio,
    }
  }

  return {
    verdict: "PASS",
    reason:
      `mean warm-turn cache coverage ${(cacheCoverageRatio * 100).toFixed(1)}% meets the `
      + `${(passRatioThreshold * 100).toFixed(0)}% threshold`,
    coldTotalInputTokens,
    cacheCoverageRatio,
  }
}

/**
 * Growing-history-specific verdict. `computeCacheProbeVerdict`'s ratio
 * (cache_read / THIS turn's own total) is mathematically too strict here:
 * each growing-history turn appends a large NEW chunk, so even PERFECT
 * caching still leaves a turn's own total mostly made of that turn's own
 * fresh (uncached) content — a mean-0.9-of-current-turn-total bar is
 * unreachable by design on early turns, not a sign of a caching defect.
 *
 * The turn-appropriate question is "did this turn re-read (approximately)
 * everything already sent as of the PRIOR turn," which this computes as
 * `cache_read_i / priorTurnTotal_{i-1}` for every turn after the first
 * (comparing each sample to its immediate predecessor, cold included) —
 * normalizing against what SHOULD already be cached, not against a total
 * that keeps growing by design. Controlled/authentic trials keep
 * `computeCacheProbeVerdict`'s current-turn-total ratio; only the
 * growing-history trial uses this one.
 */
export function computeGrowingHistoryVerdict(
  oracleClass: CacheOracleClass,
  samples: ReadonlyArray<CacheUsageSample>,
  expectedTurns: number,
  passRatioThreshold: number = DEFAULT_CACHE_PROBE_PASS_RATIO,
): CacheProbeVerdictResult {
  if (expectedTurns < 2) {
    return { verdict: "AMBIGUOUS", reason: "expectedTurns must be >= 2 (need a cold and at least one warm turn)" }
  }
  if (samples.length !== expectedTurns) {
    return {
      verdict: "AMBIGUOUS",
      reason:
        `expected ${expectedTurns} top-level result-event usage samples, observed ${samples.length} — `
        + "the run may have made extra API calls or fewer than requested; not laundering this into a verdict.",
    }
  }

  const metricsPresent = (s: CacheUsageSample) =>
    s.cacheReadInputTokens !== undefined && s.cacheCreationInputTokens !== undefined
  const allPresent = samples.every(metricsPresent)
  const coldTotalInputTokens =
    (samples[0].inputTokens ?? 0) + (samples[0].cacheCreationInputTokens ?? 0) + (samples[0].cacheReadInputTokens ?? 0)

  if (!allPresent) {
    return oracleClass === "strict"
      ? {
          verdict: "FAIL",
          reason: "cache usage fields were absent from a native-Claude/gpt-5.6 usage payload",
          coldTotalInputTokens,
        }
      : {
          verdict: "INCONCLUSIVE",
          reason: "provider did not report cache usage fields on every turn",
          coldTotalInputTokens,
        }
  }

  // For turn j (j = 1..N-1), compare against turn j-1's OWN total — the
  // amount that SHOULD already be cache-covered by the time turn j is sent.
  const perTurnRatios: Array<number> = []
  for (let j = 1; j < samples.length; j++) {
    const prior = samples[j - 1]
    const priorTotal = (prior.inputTokens ?? 0) + (prior.cacheCreationInputTokens ?? 0) + (prior.cacheReadInputTokens ?? 0)
    if (priorTotal > 0) {
      perTurnRatios.push((samples[j].cacheReadInputTokens ?? 0) / priorTotal)
    }
  }
  const cacheCoverageRatio =
    perTurnRatios.length > 0 ? perTurnRatios.reduce((sum, r) => sum + r, 0) / perTurnRatios.length : undefined

  if (cacheCoverageRatio === undefined) {
    return {
      verdict: "FAIL",
      reason: "every prior turn reported a zero total; cannot compute a prior-turn coverage ratio",
      coldTotalInputTokens,
    }
  }

  if (cacheCoverageRatio < passRatioThreshold) {
    return {
      verdict: "FAIL",
      reason:
        `mean prior-turn cache coverage ${(cacheCoverageRatio * 100).toFixed(1)}% is below the `
        + `${(passRatioThreshold * 100).toFixed(0)}% threshold — the provider is not fully re-reading the `
        + "growing conversation history from one turn to the next",
      coldTotalInputTokens,
      cacheCoverageRatio,
    }
  }

  return {
    verdict: "PASS",
    reason:
      `mean prior-turn cache coverage ${(cacheCoverageRatio * 100).toFixed(1)}% meets the `
      + `${(passRatioThreshold * 100).toFixed(0)}% threshold`,
    coldTotalInputTokens,
    cacheCoverageRatio,
  }
}

// ---------------------------------------------------------------------------
// Rollup and exit-code decision
// ---------------------------------------------------------------------------

/**
 * Rolls up a flat list of trial verdicts (e.g. one model's controlled +
 * authentic + growing-history trials TOGETHER — never controlled trials
 * alone) into a single verdict, or `"MIXED"` when they disagree. Empty input
 * rolls up to `"AMBIGUOUS"` rather than silently defaulting to PASS.
 *
 * Callers MUST include every trial type that actually ran for the unit being
 * summarized. A per-model rollup that only looked at controlled trials
 * previously let a growing-history or authentic-trial regression disappear
 * behind a passing controlled average.
 */
export function computeCacheProbeRollup(
  verdicts: ReadonlyArray<CacheProbeVerdict>,
): CacheProbeVerdict | "MIXED" {
  const unique = new Set(verdicts)
  if (unique.size === 0) return "AMBIGUOUS"
  return unique.size === 1 ? [...unique][0] : "MIXED"
}

export interface CacheProbeExitDecision {
  exitCode: 0 | 1
  /** Set when the run is not a hard failure but still deserves visible
   * attention (currently: at least one INCONCLUSIVE trial and nothing worse). */
  warning?: string
}

/**
 * Decides the process exit code from the FLAT list of every individual
 * trial verdict executed across every model and every trial type
 * (controlled + authentic + growing-history) — never from a per-model
 * rollup alone, so a regression in one trial type of one model cannot be
 * masked by PASSes elsewhere.
 *
 * - Any `FAIL` or `AMBIGUOUS` present -> exit 1 (a regression or an
 *   unresolved run happened; the caller must not report success).
 * - No FAIL/AMBIGUOUS but at least one `INCONCLUSIVE` -> exit 0, but with a
 *   warning: the provider not reporting cache fields is not proof of
 *   correct caching, and a silent 0 would read as "everything measured
 *   passed."
 * - Every trial PASS (or the list is empty) -> exit 0, no warning.
 */
export function computeCacheProbeExitDecision(
  verdicts: ReadonlyArray<CacheProbeVerdict>,
): CacheProbeExitDecision {
  if (verdicts.length === 0) {
    // No trial verdicts at all — e.g. every target was missing from the
    // catalog, or the catalog fetch itself somehow yielded nothing to run.
    // This must NEVER read as a silent success: an empty run measured
    // nothing, which is the opposite of "everything passed."
    return {
      exitCode: 1,
      warning: "no trial verdicts were produced — nothing was measured; this is a failure, not a silent pass",
    }
  }
  if (verdicts.some((v) => v === "FAIL" || v === "AMBIGUOUS")) {
    return { exitCode: 1 }
  }
  if (verdicts.some((v) => v === "INCONCLUSIVE")) {
    return {
      exitCode: 0,
      warning:
        "at least one trial was INCONCLUSIVE (the provider did not report cache usage fields) — "
        + "this is NOT a failure, but it is also not proof that caching worked; treat it as unmeasured, not passing",
    }
  }
  return { exitCode: 0 }
}

// ---------------------------------------------------------------------------
// Deterministic text builders
// ---------------------------------------------------------------------------

const FILLER_SENTENCE =
  "The github-router prompt-cache probe writes deterministic filler text so every trial's system "
  + "prefix is byte-identical and safely above the model's minimum cacheable-prefix floor. "

/** Deterministic filler of exactly `targetChars` characters (never random —
 * the whole point is a byte-identical prefix across cold/warm turns and
 * across repeated trials). Returns `""` for a non-positive target. */
export function buildDeterministicSystemPrefix(targetChars: number): string {
  if (targetChars <= 0) return ""
  const repeats = Math.ceil(targetChars / FILLER_SENTENCE.length)
  return FILLER_SENTENCE.repeat(repeats).slice(0, targetChars)
}

/**
 * Same deterministic filler, but with `salt` PREPENDED so the resulting
 * prefix is unique per trial while staying exactly `targetChars` long
 * (the filler simply consumes fewer characters). Without this, the plain
 * deterministic prefix is byte-IDENTICAL across every trial/model, so a
 * later trial's "cold" first turn can already read a cache entry a PRIOR
 * trial's identical prefix created (prompt caches commonly persist for
 * minutes) — a false warm reading mislabelled cold. `salt` should be short
 * relative to `targetChars` (a `randomSaltHex()` value) so the filler still
 * dominates the prefix size.
 */
export function buildSaltedSystemPrefix(targetChars: number, salt: string): string {
  if (targetChars <= 0) return ""
  const fillerChars = Math.max(0, targetChars - salt.length)
  return `${salt}${buildDeterministicSystemPrefix(fillerChars)}`.slice(0, targetChars)
}

/**
 * Default deterministic system-prefix size for a controlled trial, in
 * characters. The filler is ordinary prose and measures above the cache floor
 * for Claude/GPT in the live target catalog. It also clears this repo's own
 * 4,096-byte `MIN_CACHEABLE_PREFIX_BYTES` heuristic where router-owned discrete
 * calls use it, though the controlled conversation path itself stays provider-
 * managed. Providers do not share ONE floor: live measurement found
 * Gemini 3.7 Flash caching nothing at a 6,000-char prefix but caching
 * cleanly once the prefix reached ~40,000 chars, while native Claude and
 * gpt-5.6 cached at the smaller size. Grok's floor is unmeasured; it is
 * grouped with Gemini's larger size as the conservative (over- rather than
 * under-sized) choice rather than assumed to match Claude/gpt-5.6.
 */
export const DEFAULT_SYSTEM_PREFIX_CHARS = 6_000

/** Larger prefix size for providers whose implicit-cache floor is measured
 * (Gemini) or unmeasured (Grok, grouped conservatively with Gemini). */
export const LARGE_SYSTEM_PREFIX_CHARS = 40_000

const LARGE_PREFIX_FAMILY_PREFIXES: ReadonlyArray<string> = ["gemini-", "grok-"]

/**
 * Picks the deterministic system-prefix size for `catalogId`. An explicit
 * `override` (e.g. a user-set env var) always wins; otherwise Gemini/Grok
 * get `LARGE_SYSTEM_PREFIX_CHARS` and everything else gets
 * `DEFAULT_SYSTEM_PREFIX_CHARS`.
 */
export function systemPrefixCharsFor(catalogId: string, override?: number): number {
  if (override !== undefined) return override
  return LARGE_PREFIX_FAMILY_PREFIXES.some((prefix) => catalogId.startsWith(prefix))
    ? LARGE_SYSTEM_PREFIX_CHARS
    : DEFAULT_SYSTEM_PREFIX_CHARS
}

/** Fresh random hex salt, `byteLength * 2` characters long. Used once per
 * trial's first user turn so cold turns across trials/models never collide
 * (a repeated salt could accidentally read a warm cache from a PRIOR run). */
export function randomSaltHex(byteLength = 16): string {
  return randomBytes(byteLength).toString("hex")
}

/** One `--input-format stream-json` input line: a single user turn. */
export function buildStreamJsonUserLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } })
}

/**
 * The turn texts for one trial (controlled or authentic). Each turn asks for
 * an exact, short, salted reply and instructs the model not to call tools —
 * load-bearing for authenticity-mode trials, where tools remain available
 * but must not fire (a tool round-trip would add an extra, unattributed API
 * call and turn the run AMBIGUOUS per `computeCacheProbeVerdict`).
 */
export function buildCacheProbeTurns(salt: string, turnCount: number): Array<string> {
  const turns: Array<string> = []
  for (let i = 0; i < turnCount; i++) {
    turns.push(
      `Reply with exactly the text OK-${salt}-${i} and nothing else. Do not call or use any tools.`,
    )
  }
  return turns
}

/**
 * Turn texts for the "growing history" trial: each of `turnCount` turns
 * appends its OWN fresh deterministic block of `chunkChars` characters, on
 * top of Claude Code's own append-only in-session transcript (this harness
 * never re-sends earlier turns itself — the CLI's live session already
 * retains and re-submits the full prior history on every subsequent turn).
 * By turn N the request therefore carries N chunks of NEW content plus
 * everything already sent, which is exactly what surfaces the failure mode
 * a fixed-size two-turn trial cannot: a policy that caches only a static
 * system prompt, while re-processing the accumulating conversation history
 * from scratch on every turn, still passes a bare "cache_read > 0" check —
 * but its per-turn `cacheCoverageRatio` stays low as the transcript grows,
 * which `computeCacheProbeVerdict`'s ratio threshold now catches.
 */
export function buildGrowingHistoryTurns(salt: string, turnCount: number, chunkChars: number): Array<string> {
  const turns: Array<string> = []
  for (let i = 0; i < turnCount; i++) {
    const chunk = buildDeterministicSystemPrefix(chunkChars)
    turns.push(
      `Growing-history data block ${salt}-${i}:\n${chunk}\n`
      + `Reply with exactly the text OK-${salt}-${i} and nothing else. Do not call or use any tools.`,
    )
  }
  return turns
}

// ---------------------------------------------------------------------------
// Child argv (pure — no spawning here)
// ---------------------------------------------------------------------------

export interface CacheProbeArgsOptions {
  /** Catalog model id to pin via github-router's own `-m` flag. */
  modelId: string
  /** Controlled trial: `--tools ""` + `--strict-mcp-config` + a large
   * deterministic `--system-prompt`. Authentic trial: default toolset and
   * default system prompt (no `--bare`/`--safe-mode`), so this is `false`
   * and `systemPrefix` is ignored. */
  controlled: boolean
  /** Deterministic (salted) system-prompt text for a controlled trial.
   * Ignored when `controlled` is false. */
  systemPrefix?: string
  /** Authentic trial ONLY: a per-trial salt appended via
   * `--append-system-prompt`, so the trial's default system prompt is
   * still per-trial unique WITHOUT overriding Claude Code's own default
   * system prompt/toolset. Claude Code's shared built-in system-prompt
   * boilerplate is common across every session ever run and will still
   * legitimately cache-hit regardless of this salt — that is expected
   * provider-level caching, not a contamination bug; only the appended
   * salt segment is what this harness's trial isolation controls. */
  appendSystemPromptSalt?: string
  /** Optional `--max-budget-usd` safety cap, forwarded verbatim (a live-cost
   * harness benefits from a hard per-trial spend ceiling). */
  maxBudgetUsd?: string
}

/**
 * Builds the argv to follow `claude` in `bun run ./src/main.ts claude
 * <these args>`. Split from the spawn call so it is unit-testable without a
 * child process.
 */
export function buildCacheProbeClaudeArgs(opts: CacheProbeArgsOptions): Array<string> {
  const args: Array<string> = [
    "-m",
    opts.modelId,
    "--no-auto-update",
    "--no-self-update",
    "--no-update-check",
    "--no-stop-gate",
    "--",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ]
  if (opts.controlled) {
    args.push("--tools", "", "--strict-mcp-config", "--system-prompt", opts.systemPrefix ?? "")
  } else if (opts.appendSystemPromptSalt) {
    args.push("--append-system-prompt", opts.appendSystemPromptSalt)
  }
  if (opts.maxBudgetUsd) {
    args.push("--max-budget-usd", opts.maxBudgetUsd)
  }
  return args
}
