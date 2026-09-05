import consola from "consola"

import { ONE_M_TOKENS, withOneMSuffixForLead } from "./one-m-context"
import { FAST_PROFILE_MODELS } from "./fast-profile-contract"
import { MAX_PROFILE_LEAD_MODEL } from "./max-profile-contract"
import { state } from "./state"
import { isClaudeModel } from "./anthropic-translate/classifier"
import { resolveModel } from "./utils"

export const DEFAULT_PORT = 8787

/**
 * Default model for `github-router claude`. The Anthropic-published dashed
 * slug (`claude-opus-5`) — NOT the Copilot-internal slug — because
 * Claude Code's `/model` UI is backed by a hardcoded registry of Anthropic
 * slugs, and an unrecognized slug causes the menu to highlight "Opus 4"
 * with a "Newer version available" hint instead of selecting the newest
 * Opus entry.
 *
 * The proxy's `resolveModel` (`src/lib/utils.ts`) resolves this to
 * Copilot's `claude-opus-5` at request time (an exact catalog-id match —
 * opus-5 is a single-segment slug, so no dotted/dashed translation is needed).
 *
 * `DEFAULT_CLAUDE_MODEL_FALLBACKS` covers major.minor regressions only;
 * 1M↔200K downgrade is handled inside the resolver, so we don't need
 * separate `-1m` entries here.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5"
export const DEFAULT_CLAUDE_MODEL_FALLBACKS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
] as const

/**
 * Cap-aware default picker for `ANTHROPIC_MODEL` on the implicit-default
 * path. Returns `claude-opus-${family}[1m]` when the live Copilot catalog
 * shows the family is 1M-capable, else the bare `claude-opus-${family}`
 * slug. `family` defaults to `"5"` so the no-arg call selects the
 * current default; explicit values like `"4.7"` or `"4.6"` are used to
 * honor the `github-router claude -m <version>` family shorthand.
 *
 * **Dual-signal 1M detection**. The Opus families have evolved different
 * shapes in Copilot's catalog over time:
 *   1. **Sibling-slug signal** — `opus-${family}-1m` (or `opus-${family}-1m-internal`)
 *      exists as a separate catalog entry distinct from the base slug.
 *      This is how 4.6 and 4.7 ship (`claude-opus-4.6-1m`,
 *      `claude-opus-4.7-1m-internal`). Matched by the version-anchored
 *      regex below.
 *   2. **Base-slug capability signal** — the catalog entry whose id IS
 *      the base `opus-${family}` slug advertises
 *      `capabilities.limits.max_context_window_tokens >= 1_000_000`. This
 *      is how 4.8 and 5 ship — there is no `-1m` sibling; the single
 *      `claude-opus-4.8` / `claude-opus-5` id is itself the 1M variant.
 * Either signal flips on the `[1m]` decoration. Both signals together
 * also flip it on (no double-counting). The breadcrumb log names which
 * signal fired so users can spot catalog shape changes.
 *
 * The `[1m]` literal-bracket suffix is Claude Code's local 1M-context
 * unlock — cc-backup `src/utils/context.ts:35-40` matches `/\[1m\]/i`
 * to flip the context window from 200K to 1M, which drives compaction
 * triggers, the status-line context %, and token budgets. Without the
 * bracket Claude Code accounts against 200K regardless of how the
 * proxy routes the underlying request.
 *
 * Cap-awareness matters because on non-enterprise Copilot tiers there
 * is no 1M opus backend; sending `[1m]` there would either 400 at
 * Copilot or (with `resolveModel`'s graceful-degrade) silently
 * downgrade upstream while Claude Code still over-accounts context.
 * This helper detects the catalog state at launch and only opts in
 * when the backend can actually serve 1M.
 *
 * This helper answers the question only for the OPUS families, because a
 * family is what it is asked about (`-m 4.7` names no slug). Every other lead
 * slug — `-m fast`, a full slug a power user pins, the implicit budget lead —
 * goes through `withOneMSuffixForLead` (`./one-m-context`) instead, which
 * resolves the slug first and then reads the resolved entry's advertised
 * window. The two agree wherever both can be asked: a family that resolves to a
 * 1M backend is 1M by either route.
 *
 * A previous revision of this comment claimed Sonnet and Haiku were left bare
 * because "Copilot has no 1M backend for them". That was true when it was
 * written and is now false for Sonnet: the live catalog advertises
 * `max_context_window_tokens: 1_000_000` on both `claude-sonnet-5` and
 * `claude-sonnet-4.6` (Haiku 4.5 really is 200K, and is left bare by the same
 * catalog check rather than by a hardcoded family rule). Nothing here is
 * family-gated any more — the catalog decides per model, so the next family
 * that ships 1M is picked up without an edit.
 *
 * Must be called AFTER `cacheModels()` has populated `state.models`.
 * Returns the bare slug if the catalog isn't populated (resolveModel
 * can't tell the difference between "no catalog yet" and "no 1M
 * variant" — defaulting safe-side preserves the pre-change behavior).
 */
const DEFAULT_OPUS_FAMILY = "5"

/**
 * The lead `-m fast` selects. `gemini-3.8-flash` [1m] at high effort — a fast
 * Gemini-driven profile (see `./launch-profile`).
 */
export const FAST_LEAD_MODEL = FAST_PROFILE_MODELS.lead

/** Small/fast tier for a budget lead, in the two forms this codebase needs.
 *
 *  `SLUG` is the Anthropic-published DASHED form and is what goes into
 *  `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`: Claude Code's
 *  `/model` registry is keyed on Anthropic slugs, and seeding Copilot's dotted
 *  id there reproduces the documented `claude-opus-5` failure where the picker
 *  silently falls back to an older model. `CATALOG_ID` is Copilot's DOTTED id
 *  and is what the presence probe must test, because that is the id the catalog
 *  actually carries. `resolveModel` bridges the two at request time. */
export const BUDGET_SMALL_FAST_SLUG = "claude-haiku-4-5"
export const BUDGET_SMALL_FAST_CATALOG_ID = "claude-haiku-4.5"

/**
 * Resolve the `-m` argument to the lead slug to launch with.
 *
 *   - `fast`      → `FAST_LEAD_MODEL` (the fast Luna profile — see
 *                   `./launch-profile`, NOT the retired Sonnet budget lead)
 *   - `N.M`       → the best variant of that Opus family, via `pickClaudeDefault`
 *   - a full slug → unchanged, including Copilot slugs a power user pins
 *   - absent      → the ordinary default
 *
 * Every branch is `[1m]`-decorated against the live catalog, by
 * `pickClaudeDefault` on the two Opus-family branches and by
 * `withOneMSuffixForLead` on the other two. `gpt-5.6-luna` advertises a 1M
 * window, so `-m fast` gets local 1M accounting exactly like every other
 * branch here; the decoration is catalog-gated per model, so a genuinely
 * 200K model (`claude-haiku-4.5`) still comes back bare.
 *
 * `fast` resolves to an ordinary slug rather than setting a mode flag —
 * `resolveLaunchProfile` (`./launch-profile`) is keyed off the SAME raw
 * argument this function receives, so the two can never disagree about
 * which launches are "fast". `isBudgetClaudeLead` (below) stays
 * Claude-family-only and is UNRELATED to the fast profile: `gpt-5.6-luna`
 * is not a Claude model, so `isBudgetClaudeLead(resolveLeadSlugArg("fast"))`
 * is false — the old Sonnet "budget lead" surfaces (advisor escalation,
 * delegation prose, small/fast Haiku tier) simply don't engage for `-m
 * fast` any more; the fast profile has its own separate roster/tier
 * mechanism instead.
 *
 * Callers must keep treating any explicit `-m` as explicit: the
 * `DEFAULT_CLAUDE_MODEL_FALLBACKS` walk applies to the implicit-default path
 * only, so it cannot override a requested family (or `fast`) with an older Opus.
 */
export function resolveLeadSlugArg(modelArg: string | undefined): string {
  // Normalize before every test: `-m ""` and `-m " fast "` are things a shell
  // and a wrapper script both produce, and an untrimmed empty string would be
  // returned verbatim as a model id.
  const arg = modelArg?.trim()
  if (!arg) return pickClaudeDefault()
  if (arg.toLowerCase() === "fast") {
    return withOneMSuffixForLead(FAST_LEAD_MODEL)
  }
  if (arg.toLowerCase() === "max") {
    return withOneMSuffixForLead(MAX_PROFILE_LEAD_MODEL)
  }
  const opusFamilyShorthand = arg.match(/^(\d+\.\d+)$/)?.[1]
  if (opusFamilyShorthand) return pickClaudeDefault(opusFamilyShorthand)
  return withOneMSuffixForLead(arg)
}

/**
 * True when `slug` names a Claude model that is NOT an Opus tier — the
 * "budget lead" condition.
 *
 * Selecting sonnet or haiku as the lead is a decision to spend less while
 * holding quality as far as possible, and three surfaces key off it: the
 * advisor escalates to the Anthropic frontier (`resolveAdvisorModel`), the
 * injected delegation prose puts the cheap agent tiers first
 * (`buildNativeReachClauses`), and the small/fast tier drops to Haiku
 * (`getClaudeCodeEnvVars`). One definition here so those three cannot disagree
 * about what counts as a budget lead.
 *
 * Resolves before the family test so the Anthropic dashed form, Copilot's
 * dotted form, and `pickClaudeDefault`'s literal `[1m]` suffix all classify
 * alike. A non-Claude lead is not a budget lead: the concept is about picking a
 * lighter tier WITHIN the Claude family, and the gpt/gemini shim models have
 * their own cost profile that this switch says nothing about.
 *
 * CONTRACT: `slug` is an already-resolved LEAD SLUG, never a raw `-m` argument.
 * `"fast"` and the `N.M` shorthand are not Claude slugs and would classify
 * false here; run them through `resolveLeadSlugArg` first, which is what every
 * caller does. Resolving internally instead would drag `pickClaudeDefault`'s
 * catalog dependency into a pure predicate and make the same input answer
 * differently before and after the catalog loads.
 */
export function isBudgetClaudeLead(slug: string | undefined): boolean {
  if (!slug) return false
  if (!isClaudeModel(slug)) return false
  return !/opus/i.test(resolveModel(slug))
}

export function pickClaudeDefault(opusFamily: string = DEFAULT_OPUS_FAMILY): string {
  // Canonicalize the family to dotted form so both "4.8" and "4-8" work
  // as input, then derive the dashed Anthropic slug and a regex that
  // tolerates either separator in catalog ids (Copilot uses dotted,
  // some test fixtures use dashed).
  const dotted = opusFamily.replace(/-/g, ".")
  const dashed = dotted.replace(/\./g, "-")
  const bareSlug = `claude-opus-${dashed}`
  const versionPattern = dotted.replace(/\./g, "[.-]")
  const oneMRegex = new RegExp(`opus-${versionPattern}-1m(?:$|-)`, "i")
  const baseSlugRegex = new RegExp(`^claude-opus-${versionPattern}$`, "i")
  const familyRegex = new RegExp(`opus-${versionPattern}(?:$|[-.])`, "i")

  const models = state.models?.data ?? []
  const siblingOneM = models.some((m) => oneMRegex.test(m.id))
  // Scan ALL entries whose id matches the base slug (dotted or dashed form)
  // and take the max of their advertised context windows. Using find()
  // would be order-dependent if both dotted and dashed aliases ever coexist
  // — the live Copilot catalog only ships dotted today, but defending here
  // keeps the detector robust against future catalog shape drift.
  const baseSlugMaxContext = models.reduce(
    (max, m) =>
      baseSlugRegex.test(m.id)
        ? Math.max(max, m.capabilities?.limits?.max_context_window_tokens ?? 0)
        : max,
    0,
  )
  const baseSlugOneM = baseSlugMaxContext >= ONE_M_TOKENS
  const has1m = siblingOneM || baseSlugOneM

  // Warn when the user explicitly requested a family that's completely
  // absent from the catalog — `resolveModel`'s downstream cache-walk
  // will surface the "model not found" error, but a heads-up at this
  // layer makes it obvious why a typo'd `-m 4.0` falls through.
  if (
    opusFamily !== DEFAULT_OPUS_FAMILY
    && state.models
    && models.length > 0
    && !models.some((m) => familyRegex.test(m.id))
  ) {
    consola.warn(
      `Requested Opus family "${dotted}" not found in Copilot catalog; using "${bareSlug}" anyway (resolveModel may not find a backend for it).`,
    )
  }

  if (has1m) {
    const signal = siblingOneM
      ? baseSlugOneM
        ? "sibling-slug + base-slug 1M capability"
        : `sibling slug opus-${dotted}-1m`
      : `base slug ${bareSlug} (max_context_window_tokens=${baseSlugMaxContext})`
    // Only mention --model pin-to-200K when a real 200K variant exists in
    // the catalog (i.e., a sibling -1m slug means the bare slug is 200K).
    // For 4.8-shaped families (single slug already 1M, no sibling), the
    // bare slug is the 1M backend — there is no 200K alternative to pin.
    const pinHint = siblingOneM
      ? ` Pass --model ${bareSlug} to pin 200K.`
      : ` (No separate 200K variant of ${dotted} exists in the catalog — the bare slug IS the 1M backend.)`
    consola.info(
      `Catalog signals opus-${dotted} is 1M-capable (${signal}); defaulting ANTHROPIC_MODEL to "${bareSlug}[1m]" so Claude Code accounts for 1M context locally. Set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to opt out (HIPAA).${pinHint}`,
    )
    return `${bareSlug}[1m]`
  }
  return bareSlug
}

/**
 * Default model for `github-router codex`. `gpt-5.6-sol` is the flagship
 * `/responses` model; the fallback chain (led by `gpt-5.5`) handles older
 * Copilot tiers or a rollout-lag window where sol hasn't appeared yet.
 * `resolveCodexModel` provides a final "best available `/responses` model"
 * safety net beyond this list.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol"
export const DEFAULT_CODEX_MODEL_FALLBACKS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const

const PORT_RANGE_MIN = 11000
const PORT_RANGE_MAX = 65535

/** Generate a random port number in the range [11000, 65535]. */
export function generateRandomPort(): number {
  return (
    Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1))
    + PORT_RANGE_MIN
  )
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  // Strict integer format only: parseInt is too permissive — it would
  // silently turn `"5e3"` into 5, `"300_000"` into 300, `"60000ms"` into
  // 60000. For timeout knobs we'd rather fall back than silently
  // misconfigure (e.g. set a 5-min inactivity timer to 5 ms).
  if (!/^[0-9]+$/.test(raw.trim())) {
    consola.warn(
      `${key}=${JSON.stringify(raw)} is not a non-negative integer; using fallback ${fallback}`,
    )
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Total fetch-phase timeout (until Response object resolves) for upstream
// streaming endpoints. Default 0 = no fetch-phase timeout — body-phase
// failures are covered by UPSTREAM_INACTIVITY_TIMEOUT_MS below, and a
// fetch-lifecycle timeout would silently truncate legitimate long
// completions (e.g. xhigh-thinking responses that legitimately stream
// for 30+ minutes). Set the env var to a positive integer if you need
// a hard cap.
export const UPSTREAM_FETCH_TIMEOUT_MS = envInt(
  "UPSTREAM_FETCH_TIMEOUT_MS",
  0,
)

// Inactivity bound on body reads — if no chunk arrives within this window,
// abort the stream and emit a structured error event. 300s (5 min) sits
// well above Copilot's ~60s idle cut so the proxy still reaps stalled
// connections before the upstream RST hits us as an unhandled rejection,
// but does NOT prematurely abort reasoning-capable models (gpt-5.5,
// gpt-5.3-codex, gemini-3.1-pro-preview, claude-opus-4.7-xhigh) which
// routinely produce >75s silences between visible token bursts while
// thinking. The earlier 75s default produced live aborts at /v1/messages
// with bytes=134k–163k already streamed — proof the upstream was healthy
// and just thinking. Lower this only if you specifically want to reap
// stalled connections faster than 5 minutes.
export const UPSTREAM_INACTIVITY_TIMEOUT_MS = envInt(
  "UPSTREAM_INACTIVITY_TIMEOUT_MS",
  300_000,
)

// Whether upstream requests may negotiate HTTP/2.
//
// Default OFF. undici enables h2 by default (`lib/core/connect.js`), which the
// project never chose — it arrived as a library default. Under h2 all
// concurrency shares ONE session, so a single connection-fatal fault takes out
// every in-flight request at once; under HTTP/1.1 it costs the one request that
// was on that socket, which is the blast radius the inactivity timeout above
// was designed around.
//
// This is a MITIGATION of a correlated factor, not a fix for a known cause. The
// observed fault is a TLS `bad_record_mac` alert whose origin is still
// unexplained; h2 is the variable that separates the failing configuration from
// the two clean ones (Bun, which negotiates no ALPN at all, and Node <=24,
// whose bundled undici forces HTTP/1.1). Set to `1` to restore multiplexing —
// that is also how to run the A/B honestly rather than assuming the default.
//
// NOTE: exposure is only reachable on Node >=26. Node 24's built-in fetch reads
// `Symbol.for("undici.globalDispatcher.1")`, whose wrapper hardcodes
// `allowH2:false`; Node 26's reads `.2` and negotiates h2.
// NOTE: these are functions, not module-level consts like the timeouts above,
// because they are read once per agent construction (startup, plus once per
// distinct proxy URL) rather than per request. Resolving them at call time
// keeps the flag honest regardless of module load order, and makes the policy
// directly testable without cache-busting imports.
export function upstreamAllowH2(): boolean {
  return process.env.GH_ROUTER_UPSTREAM_ALLOW_H2 === "1"
}

export function upstreamMaxConnections(): number {
  return envInt("GH_ROUTER_UPSTREAM_MAX_CONNECTIONS", 256)
}

// Per-origin connection cap for upstream requests. undici defaults to
// unlimited; without h2 multiplexing each concurrent request needs its own
// socket, so an explicit ceiling keeps a burst of parallel agents from trading
// one failure mode for ephemeral-port exhaustion or an upstream per-IP limit.
//
// Generous on purpose: streaming responses hold a connection for the whole
// completion (minutes on a reasoning model), so a tight cap would head-of-line
// block real traffic — a worse failure than the one being fixed.


// TODO: extend timeout coverage to non-streaming paths (web-search MCP in
// src/services/copilot/web-search.ts, embeddings, models) when those
// endpoints become hot or start hanging in practice.
