/**
 * Phase I: ADVISOR proxy-side translation.
 *
 * ADVISOR is Anthropic's server-side server_tool_use mechanism — the
 * model invokes a stronger reviewer model with the full conversation
 * context. Copilot doesn't implement it (returns 400 'unsupported beta
 * header(s): advisor-tool-2026-03-01'). This module implements the
 * equivalent semantics proxy-side per gemini-critic's streaming design:
 *
 * 1. Strip the `advisor-tool-` beta header before forwarding to Copilot
 *    (Phase A already does this via EXPLICITLY_STRIPPED_BETA_PREFIXES).
 * 2. Inject a `__anthropic_advisor` tool definition into body.tools[]
 *    (with cc-backup's ADVISOR_TOOL_INSTRUCTIONS as the description so
 *    the model knows when to call it). The double-underscore prefix
 *    avoids collision with any user MCP server's `advisor` tool.
 * 3. Stream the Copilot response, watching for tool_use blocks with
 *    name `__anthropic_advisor`. When detected:
 *    a. Translate the block in-flight: emit
 *       `{type: "server_tool_use", name: "advisor"}` to the client so
 *       Claude Code's AdvisorMessage.tsx renders the "Consulting
 *       advisor..." spinner immediately (gemini: do NOT buffer the loop
 *       — the UI hangs without an indicator).
 *    b. After the current turn's `message_stop` would have arrived,
 *       suppress it and run the advisor model server-side with the
 *       conversation context up through the current assistant turn.
 *    c. Synthesize an `advisor_tool_result` block to the client with
 *       the advisor's text response.
 *    d. Append the synthetic tool_result to the conversation and
 *       re-call Copilot for the next turn — stream onto the SAME
 *       SSE connection (no new message_start; the original one is
 *       still open). Loop up to ADVISOR_MAX_TURNS times.
 * 4. Lead-aware model choice: route the advisor call to a different model
 *    family than the main loop (gpt-5.6-sol) so the user gets a true "second
 *    set of eyes" instead of Opus reviewing Opus (gemini-critic finding). When
 *    the LEAD is a lighter Claude tier the choice inverts and the advisor
 *    escalates to `ADVISOR_ESCALATION_MODEL` instead — see that constant for
 *    why trading the cross-lab property is the right call on that path.
 * 5. Effort follows the Claude Code effort picker (`resolveAdvisorEffort`)
 *    rather than a hardcoded constant, floored so a low picker cannot render
 *    the consultation useless.
 *
 * The translate-loop is bounded to a single user request — no
 * persistent state across requests is needed (unlike Phase G's
 * mcp_servers translate which had unfix-able continuation-after-TTL
 * holes). Each request evaluates ADVISOR fresh from the body.
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import { isClaudeModel } from "~/lib/anthropic-translate/classifier"
import {
  FAST_PROFILE_ADVISOR_EFFORT,
  FAST_PROFILE_ADVISOR_MODEL,
} from "~/lib/fast-profile-contract"
import { HTTPError } from "~/lib/error"
import { MAX_ADVISOR_SYSTEM_PROMPT } from "~/lib/max-profile-prompts"
import {
  fastEndpointForCatalogId,
  fastEndpointForModel,
} from "~/lib/fast-endpoint"
import { isBudgetClaudeLead } from "~/lib/port"
import {
  applyClaudeCachePolicy,
  applyResponsesCachePolicy,
} from "~/lib/prompt-cache"
import {
  EFFORT_ORDER,
  bucketEffort,
  clampEffort,
  type Effort,
} from "~/lib/reasoning-effort"
import { state } from "~/lib/state"
import { isControllerClosedError } from "~/lib/stream-relay"
import {
  formatThinkingRepairDecline,
  rememberThinkingHistoryRepair,
  repairKnownThinkingHistory,
  repairRejectedThinkingHistory,
} from "~/lib/thinking-history-repair"
import { getTokenizerFromModel, loadEncoder } from "~/lib/tokenizer"
import { resolveModel } from "~/lib/utils"
import { withTransientRetry } from "~/lib/upstream-retry"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const ENCODER = new TextEncoder()

/** The tool name we inject for Copilot. Double-underscore prefix
 *  avoids collision with any user MCP server's `advisor` tool. */
export const ADVISOR_INTERNAL_TOOL_NAME = "__anthropic_advisor"

/** The Anthropic-spec name used in the translated server_tool_use
 *  block sent to the client. cc-backup AdvisorMessage.tsx requires
 *  this exact name to render the advisor spinner. */
export const ADVISOR_CLIENT_TOOL_NAME = "advisor"

/** Hard cap on advisor calls per request to bound runaway behavior.
 *  Matches Phase G's loop bound; ADVISOR is typically called 1-3
 *  times per session per cc-backup ADVISOR_TOOL_INSTRUCTIONS. */
export const ADVISOR_MAX_TURNS = 16

/** Default advisor model + reasoning effort. Per gemini-critic + user
 *  direction: hardcode to a cross-lab model (gpt-5.6-sol — Copilot's
 *  /responses-only flagship). The cross-lab choice gives a true "second set
 *  of eyes" instead of the main model reviewing itself.
 *
 *  Effort default is `high`, not the historical `xhigh`: `resolveAdvisorEffort`
 *  no longer floors the picked effort (see that function), so `high` is both
 *  the default AND the lowest the advisor will ever think at when the picker
 *  expresses no preference — a deliberate, user-approved cost/depth trade
 *  applied uniformly across every advisor target (Sol, the Opus escalation,
 *  and the fast-profile Gemini advisor below all read this same constant). */
export const ADVISOR_DEFAULT_MODEL = "gpt-5.6-sol"
export const ADVISOR_DEFAULT_EFFORT = "xhigh"
const ADVISOR_MIN_EFFORT: Effort = "high"

/** The Anthropic frontier model the advisor escalates to when the LEAD is a
 *  lighter Claude tier (sonnet, haiku).
 *
 *  Selecting a lighter lead is a decision to work on a budget while holding
 *  quality: the lead does the legwork and escalates for direction. Without this,
 *  a budget lead has no transcript-aware path to the strongest Anthropic
 *  reasoner at all — `opus_critic` is stateless and sees one artifact, and the
 *  `plan` worker is read-only and never sees the transcript.
 *
 *  This deliberately trades the advisor's cross-lab property on that path. The
 *  advisor is not this repo's review instrument: it catches drift and momentum
 *  and inherits the lead's framing by design, while the fresh-context critics
 *  (`codex_critic`, `gemini_critic`, `codex_reviewer`, `gemini_reviewer`) are
 *  the decorrelation instrument and are untouched. `GH_ROUTER_ADVISOR_MODEL`
 *  keeps a cross-lab advisor one env var away for anyone who wants it back. */
export const ADVISOR_ESCALATION_MODEL = "claude-opus-5"

/** The Advisor model for an authenticated fast primary lead. GPT-5.6 Sol
 * is cross-lab from the Google-backed Gemini lead and is selected only when
 * its live catalog entry advertises the required Responses endpoint. Kept distinct
 * from `ADVISOR_DEFAULT_MODEL` so standard launches remain unchanged. */
export const ADVISOR_FAST_PROFILE_MODEL = FAST_PROFILE_ADVISOR_MODEL

/** True only when the live entry satisfies the fixed fast transport.
 * An ID-only presence check is insufficient: selecting a model whose catalog
 * row lost Responses support would silently degrade every fast Advisor call. */
function fastProfileAdvisorAvailable(): boolean {
  return fastEndpointForCatalogId(
    ADVISOR_FAST_PROFILE_MODEL,
    state.models?.data,
  ) === "responses"
}

/** Output cap for the Anthropic-branch advisor call when the catalog carries no
 *  limits for the resolved model. The value the branch used unconditionally
 *  before it became reachable, kept so a catalog-less path is no worse off. */
const ADVISOR_FALLBACK_MAX_OUTPUT_TOKENS = 4096

/** Catalog spellings that mean the Responses API. Copilot is inconsistent about
 *  the `/v1` prefix, so both are matched — mirroring `CHAT_ENDPOINTS` /
 *  `RESPONSES_ENDPOINTS` in `src/services/copilot/endpoint.ts`. */
const ADVISOR_RESPONSES_ENDPOINTS: ReadonlySet<string> = new Set([
  "/responses",
  "/v1/responses",
])

/**
 * Which transport the advisor dispatches on: `/responses` (with
 * `reasoning.effort`) or `/v1/messages`.
 *
 * Catalog-first, name-regex second, and BOTH tests run against the bare id as
 * well as the given one. `pickEndpoint` is deliberately not reused: it answers
 * "chat or responses" for the two tool-calling clients and would send
 * `claude-opus-5` — which advertises `/v1/messages` AND `/chat/completions` — to
 * chat. The advisor's question is narrower: does this model serve `/responses`?
 *
 * The bare-id fallback is what makes `GH_ROUTER_ADVISOR_MODEL` safe. That pin is
 * accepted verbatim, so an operator can write a vendor-namespaced value like
 * `openai/gpt-5.6-sol`. Such an id is in no catalog and fails the start-anchored
 * name regex, so a catalog-only fix still posted it to `/v1/messages` and 400'd
 * — exported and directly tested for that exact input, because an earlier
 * version of this function claimed to handle it and did not.
 */
export function advisorUsesResponses(resolvedAdvisorModel: string): boolean {
  // `openai/gpt-5.6-sol` -> `gpt-5.6-sol`. Only the last segment can be a real
  // catalog id; anything before it is a vendor namespace the catalog never uses.
  const bare = resolvedAdvisorModel.slice(
    resolvedAdvisorModel.lastIndexOf("/") + 1,
  )
  const entry = state.models?.data?.find(
    (m) => m.id === resolvedAdvisorModel || m.id === bare,
  )
  const endpoints = entry?.supported_endpoints
  if (endpoints && endpoints.length > 0) {
    return endpoints.some((e) => ADVISOR_RESPONSES_ENDPOINTS.has(e))
  }
  return /^(gpt-|o\d|.*codex)/i.test(bare)
}

/** Which Copilot transport `runAdvisor` dispatches an advisor call on.
 *  Generalizes the historical two-way `useResponses` branch (added when
 *  `gpt-5.6-sol` was the only advisor candidate) to three, now that
 *  `resolveAdvisorModel` can also pick a `/chat/completions`-only model
 *  (`gemini-3.8-flash`, the authenticated fast profile's advisor). */
export type AdvisorTransport = "responses" | "chat" | "messages"

/**
 * Decide `advisorTransport` for a resolved advisor model id.
 *
 * Order matters: Claude identity is checked FIRST and wins even though
 * `claude-opus-5` also advertises `/chat/completions` in the live catalog —
 * the historical branch never sent Claude to chat, and this preserves that
 * byte-for-byte (reuses the SAME classifier `classifyMessagesRoute` uses for
 * the main `/v1/messages` shim fork, so the two surfaces cannot disagree
 * about what counts as a Claude model). Responses is checked next
 * (`advisorUsesResponses`, unchanged — catalog-first, name-regex fallback,
 * still exported and directly tested on its own). Anything else defaults to
 * chat, mirroring `pickEndpoint`'s "omits supported_endpoints => chat-eligible"
 * convention — the same convention `classifyMessagesRoute` relies on for a
 * lead model, applied here to the advisor's OWN model instead.
 *
 * The authenticated fast Advisor passes `fastProfile:true`, which uses the same
 * fixed endpoint policy as its lead/agent roster. Standard calls leave this
 * false and retain the historical catalog/name behavior.
 */
export function advisorTransport(
  resolvedAdvisorModel: string,
  fastProfile = false,
): AdvisorTransport {
  const bare = resolvedAdvisorModel.slice(
    resolvedAdvisorModel.lastIndexOf("/") + 1,
  )
  const entry = state.models?.data?.find(
    (m) => m.id === resolvedAdvisorModel || m.id === bare,
  )
  if (fastProfile && entry) {
    const fixed = fastEndpointForModel(entry)
    if (fixed === "messages" || fixed === "responses" || fixed === "chat") {
      return fixed
    }
  }
  if (isClaudeModel(resolvedAdvisorModel, entry)) return "messages"
  if (advisorUsesResponses(resolvedAdvisorModel)) return "responses"
  return "chat"
}

/** True when the model advertises a usable reasoning-effort ladder. */
function advertisedEffortLadder(
  resolvedAdvisorModel: string,
): Array<string> | undefined {
  const supported = state.models?.data?.find(
    (m) => m.id === resolvedAdvisorModel,
  )?.capabilities?.supports?.reasoning_effort
  return Array.isArray(supported) && supported.length > 0 ? supported : undefined
}

/** True when the advisor should escalate to `ADVISOR_ESCALATION_MODEL` for this
 *  lead: a Claude lead that is NOT already an Opus tier, on a catalog that
 *  actually carries the escalation model.
 *
 *  The catalog probe mirrors `standInToolEnabled`'s: never name a model the
 *  account cannot reach. A non-Claude lead never gets here in practice (the
 *  advisor tool is stripped for those before the request reaches this module),
 *  but the check is explicit rather than assumed.
 *
 *  The probe compares the BARE constant rather than `resolveModel`-ing it first,
 *  which is deliberate and not an oversight: `claude-opus-5` is a single-segment
 *  slug whose dashed and dotted spellings are identical, so resolution is a
 *  no-op, and `resolveModel` WARNS on an id it cannot find — routing this probe
 *  through it would emit that warning on every advisor request for anyone whose
 *  catalog lacks opus-5, which is exactly the tier this returns false for.
 *  `standInToolEnabled` compares the same id the same way. */
function shouldEscalateAdvisor(leadModel: string): boolean {
  // `isBudgetClaudeLead` resolves the slug first, so the Anthropic dashed form,
  // Copilot's dotted form, and `pickClaudeDefault`'s `[1m]` suffix all classify
  // alike. Shared with the delegation prose and the small/fast tier so the three
  // budget-mode surfaces cannot disagree about what a budget lead is.
  if (!isBudgetClaudeLead(leadModel)) return false
  return state.models?.data?.some((m) => m.id === ADVISOR_ESCALATION_MODEL) ?? false
}

export interface AdvisorModelChoice {
  model: string
  /** True ONLY for the automatic lead-based escalation to
   *  `ADVISOR_ESCALATION_MODEL` (a lighter Claude lead reaching for the
   *  Anthropic frontier).
   *
   *  An operator pin via `GH_ROUTER_ADVISOR_MODEL` is not an escalation even
   *  when it names `ADVISOR_ESCALATION_MODEL` itself. `runAdvisor` keys the
   *  "your caller is running a lighter model" clause on this flag rather than
   *  on the resolved model id, so pinning opus on an opus lead cannot inject a
   *  sentence that is false. */
  escalated: boolean
  /** True ONLY for the automatic authenticated-fast selection of
   *  `ADVISOR_FAST_PROFILE_MODEL`. Distinct from `escalated`: launch policy,
   *  not lead family, selects this model and its fixed fast transport. The
   *  authenticated launch identity, not this result, independently controls
   *  the non-binding consultative system prompt. */
  fastProfile: boolean
}

/**
 * Pick the Advisor model for one request. Standard selection follows the
 * current lead so a `/model` switch can change budget escalation; authenticated
 * fast selection follows launch identity instead, so changing among the fixed
 * fast lead models never removes Gemini Advisor.
 *
 * Fast profile is a separate fixed contract: it requires Gemini's Chat endpoint
 * and ignores standard operator pins. Standard-profile precedence remains:
 *   1. `GH_ROUTER_ADVISOR_MODEL` (trimmed).
 *   2. A lighter Claude lead with Opus escalation available.
 *   3. The literal `ADVISOR_DEFAULT_MODEL`.
 *
 * Step 3 deliberately does not walk the OpenAI frontier chain. That would
 * silently change the standard Opus-lead path when Sol is absent.
 */
/**
 * Map an operator pin onto the id the catalog actually carries.
 *
 * `GH_ROUTER_ADVISOR_MODEL` is free-form, and the natural thing to write is a
 * vendor-namespaced id like `openai/gpt-5.6-sol`. Copilot's catalog carries the
 * bare `gpt-5.6-sol`, so forwarding the namespaced form verbatim gets a 400
 * `model_not_supported` and the advisor silently degrades to its
 * "[Advisor unavailable: ...]" fallback — measured, not theorised: choosing the
 * transport correctly was NOT sufficient, because the id itself was still
 * wrong on the wire.
 *
 * An exact catalog hit wins first, so a real id containing a slash could never
 * be mangled. Only when the pin is absent from the catalog do we try its last
 * path segment, and only when THAT is present do we rewrite. A pin that matches
 * nothing is passed through untouched: the catalog may simply not be loaded
 * yet, and inventing an id would be worse than letting upstream reject it.
 */
function normalizeAdvisorPin(pinned: string): string {
  const models = state.models?.data
  if (!models) return pinned
  if (models.some((m) => m.id === pinned)) return pinned
  const bare = pinned.slice(pinned.lastIndexOf("/") + 1)
  return bare !== pinned && models.some((m) => m.id === bare) ? bare : pinned
}

export function resolveAdvisorModel(
  leadModel: string | undefined,
  fastProfile = false,
): AdvisorModelChoice {
  if (fastProfile) {
    if (!fastProfileAdvisorAvailable()) {
      throw new Error(
        `fast Advisor invariant failed: ${ADVISOR_FAST_PROFILE_MODEL} must advertise the Responses endpoint`,
      )
    }
    return {
      model: ADVISOR_FAST_PROFILE_MODEL,
      escalated: false,
      fastProfile: true,
    }
  }
  const pinned = process.env.GH_ROUTER_ADVISOR_MODEL?.trim()
  if (pinned) {
    return { model: normalizeAdvisorPin(pinned), escalated: false, fastProfile: false }
  }
  if (leadModel && shouldEscalateAdvisor(leadModel)) {
    return { model: ADVISOR_ESCALATION_MODEL, escalated: true, fastProfile: false }
  }
  return { model: ADVISOR_DEFAULT_MODEL, escalated: false, fastProfile: false }
}

/**
 * Resolve the advisor's reasoning effort from the ORIGINAL request body, so the
 * advisor thinks at the level selected in the Claude Code effort picker instead
 * of a hardcoded constant.
 *
 * The source is the RAW pre-`resolveModelInBody` body, deliberately. By the time
 * the handler holds a parsed body, `translateThinking` has already bucketed
 * `thinking.budget_tokens` into `output_config.effort` AND clamped it to the
 * LEAD model's allowlist — so that value encodes "what the lead could do", not
 * "what the user picked". Re-clamping it against the advisor cannot recover the
 * difference: a `max` pick on a lead whose ceiling is `high` would reach an
 * xhigh-capable advisor as `high`.
 *
 * Precedence mirrors the repo-wide rule that an explicit client effort wins:
 *   1. `output_config.effort`
 *   2. `bucketEffort(thinking.budget_tokens)`
 *   3. `ADVISOR_DEFAULT_EFFORT` — a request expressing no preference behaves
 *      exactly as it did before the picker was honored at all.
 *
 * There is deliberately NO floor anymore (removed per the user-approved
 * "default high, no floor" change): the advisor follows the picker all the way
 * down as well as up, so an explicit `none`/`low` pick is honored rather than
 * clamped up to a minimum. The only remaining adjustment is the CEILING clamp
 * against the resolved advisor's own live `reasoning_effort` allowlist — a
 * model whose ladder tops out below the requested tier still needs to receive
 * something it accepts.
 */
export function resolveAdvisorEffort(
  rawRequestBody: string | undefined,
  advisorModel: string,
  fastProfile = false,
): string {
  let requested: Effort = fastProfile
    ? FAST_PROFILE_ADVISOR_EFFORT
    : ADVISOR_DEFAULT_EFFORT
  if (rawRequestBody) {
    try {
      const body = JSON.parse(rawRequestBody) as AnyRecord
      const oc = body.output_config
      const explicit =
        oc && typeof oc === "object" ? (oc as AnyRecord).effort : undefined
      const thinking = body.thinking
      if (
        typeof explicit === "string"
        && (EFFORT_ORDER as ReadonlyArray<string>).includes(explicit)
      ) {
        requested = explicit as Effort
      } else if (
        thinking
        && typeof thinking === "object"
        && (thinking as AnyRecord).type === "enabled"
      ) {
        // An explicit-but-unrecognized effort lands here too, and bucketing a
        // real budget beats anchoring on a value we could not parse. With no
        // thinking block either, the default below is already the repo's
        // UNKNOWN_EFFORT_ANCHOR, so the two conventions agree.
        requested = bucketEffort((thinking as AnyRecord).budget_tokens)
      }
    } catch {
      // Unparseable body: keep the default. `isAdvisorRequested` already parsed
      // this body to get here, so this is belt-and-braces rather than a path we
      // expect to take.
    }
  }

  if (fastProfile) requested = FAST_PROFILE_ADVISOR_EFFORT
  else if (EFFORT_ORDER.indexOf(requested) < EFFORT_ORDER.indexOf(ADVISOR_MIN_EFFORT)) {
    requested = ADVISOR_MIN_EFFORT
  }

  const supported = state.models?.data?.find(
    (m) => m.id === resolveModel(advisorModel),
  )?.capabilities?.supports?.reasoning_effort
  // Absent OR empty allowlist means "accepts anything" — the same reading
  // `clampOutputConfigEffortInPlace` takes. Only a non-empty list clamps.
  if (!Array.isArray(supported) || supported.length === 0) return requested
  return clampEffort(requested, supported)
}


/** ADVISOR_TOOL_INSTRUCTIONS verbatim from cc-backup
 *  src/utils/advisor.ts — describes when the model should invoke
 *  the advisor. Long-form prose; see source for justification. */
export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`

/** Fast-profile lead-only policy. Unlike the standard Claude Code instructions
 * above, this makes consultation optional and leaves decision ownership with
 * the authenticated fast primary lead. Fast Task subagents never receive an advisor tool at all. */
export const FAST_ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an optional, transcript-aware \`advisor\` tool. It takes no parameters and returns non-binding consultation. You remain responsible for every decision.

Use advisor only when a focused, consequential uncertainty remains after direct investigation: conflicting evidence, a materially changed assumption, a genuinely non-converging approach, a hard-to-reverse trade-off, or an explicit request for a fresh perspective. State the precise uncertainty in your response immediately before calling it.

Do not call advisor for routine progress, while waiting on a subagent, after ordinary tool output, for a fact that code or a command can verify, to obtain planner approval or reviewer verification, or as a ritual before implementation or completion.

Treat the result as advice, not authority. Weigh it against the user's intent, verified repository evidence, planner output, and reviewer findings. You may consult again when materially new evidence creates a different question or directly conflicts with earlier advice.`

const ADVISOR_OPT_OUT_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL"

/**
 * Detect whether the request asked for ADVISOR (incoming
 * `anthropic-beta` header contains an `advisor-tool-` prefix). Also
 * respects the `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` opt-out env var
 * (set by the user to globally disable; matches cc-backup advisor.ts
 * line 61).
 */
export function isAdvisorRequested(rawBetaHeader: string | undefined): boolean {
  if (!rawBetaHeader) return false
  if (process.env[ADVISOR_OPT_OUT_ENV]) return false
  return rawBetaHeader
    .split(",")
    .map((s) => s.trim())
    .some((v) => v.startsWith("advisor-tool-"))
}

/**
 * Inject the __anthropic_advisor tool definition into the body's tools
 * array. Returns a new body string. Idempotent — if the tool is already
 * present (e.g. the user's MCP shadowed it) we leave the existing one
 * alone and return the body unchanged.
 *
 * Also strips any tool entry with `type: "advisor_*"` (Anthropic API's
 * native server-side advisor tool — `advisor_20260301` and future
 * variants). When `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` is
 * set, Claude Code injects its own advisor tool with this type into
 * `tools[]`. Copilot 400s on the unknown tool type ("Input tag
 * 'advisor_20260301' found using 'type' does not match any of the
 * expected tags"), so the proxy must strip it before forwarding while
 * still injecting our custom `__anthropic_advisor` tool that the model
 * can invoke. The proxy's intercept on the response stream then
 * translates the model's `tool_use{__anthropic_advisor}` to the
 * client-shape `server_tool_use{name:"advisor"}` + `advisor_tool_result`
 * blocks the client expects.
 */
export function injectAdvisorTool(
  rawBody: string,
  instructions = ADVISOR_TOOL_INSTRUCTIONS,
): string {
  // Fast path: skip the full parse + re-serialize when this body provably
  // needs neither an injection nor a strip.
  //
  // This function runs on essentially EVERY request — `server-setup.ts`
  // auto-enables the advisor beta, so `isAdvisorRequested` is true by default —
  // and it was the only unguarded full parse+stringify pair in the prologue.
  // Measured on realistic Anthropic bodies, a parse is ~5.2ms and a stringify
  // ~2.5ms at 4.5 MiB, while these substring probes are ~0.00ms at every size
  // (V8 short-circuits them), so the guard is net-positive by a wide margin and
  // free when it misses.
  //
  // Correctness: both work items below are keyed on a literal that MUST appear
  // in the serialized body for that work to be needed.
  //   - a strip needs a tool with `"type":"advisor_..."` → contains `"advisor_`
  //   - an injection needs the tool absent → its serialized NAME FIELD is
  //     missing, i.e. `"name":"__anthropic_advisor"`.
  //
  // Matching the serialized NAME FIELD rather than the bare name is
  // load-bearing, and it is what makes the probe UNFORGEABLE from user input.
  //
  // The obvious objection is "a user message containing this literal would
  // trigger a false positive and silently disable the advisor." It cannot:
  // `rawBody` is always serialized JSON, and `JSON.stringify` ESCAPES the inner
  // quotes of any string value, so a user writing `"name":"__anthropic_advisor"`
  // in a message arrives on the wire as `\"name\":\"__anthropic_advisor\"` —
  // which does not match the unescaped probe. Verified against message content,
  // system blocks, and nested tool descriptions; each is a `false` probe with no
  // real tool present. The only way to produce an unescaped match is an actual
  // `{"name":"__anthropic_advisor"}` object, which is exactly the condition we
  // are testing for. `tests/advisor-inject-fastpath.test.ts` pins these cases
  // differentially against the pre-fast-path semantics.
  //
  // Directionality of a hypothetical miss is also safe: a body with exotic
  // spacing (whitespace between key and value, which no JSON serializer emits)
  // simply falls through to the full parse. A slow path, never a wrong one.
  //
  // (`ADVISOR_INTERNAL_TOOL_NAME` is `__anthropic_advisor`, which does not start
  // with `advisor_`, so the two probes cannot alias.)
  if (
    instructions === ADVISOR_TOOL_INSTRUCTIONS
    &&
    rawBody.includes(`"name":"${ADVISOR_INTERNAL_TOOL_NAME}"`)
    && !rawBody.includes('"advisor_')
  ) {
    return rawBody
  }

  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return rawBody
  }
  const rawTools = Array.isArray(parsed.tools) ? parsed.tools : []
  // Strip Anthropic-native advisor typed tools (Copilot 400s on these).
  const tools = rawTools.filter((t: AnyRecord) => {
    if (typeof t !== "object" || t === null) return true
    const type = (t as AnyRecord).type
    return typeof type !== "string" || !type.startsWith("advisor_")
  })
  const stripped = tools.length !== rawTools.length
  const alreadyInjected = tools.some(
    (t: AnyRecord) => t?.name === ADVISOR_INTERNAL_TOOL_NAME,
  )
  const needsDescriptionUpdate = alreadyInjected && tools.some(
    (t: AnyRecord) =>
      t?.name === ADVISOR_INTERNAL_TOOL_NAME
      && t.description !== instructions,
  )
  if (alreadyInjected && !stripped && !needsDescriptionUpdate) {
    return rawBody // no-op: already injected and nothing to strip
  }
  parsed.tools = alreadyInjected
    ? tools.map((tool: AnyRecord) =>
        tool?.name === ADVISOR_INTERNAL_TOOL_NAME
          ? { ...tool, description: instructions }
          : tool,
      )
    : [
        ...tools,
        {
          name: ADVISOR_INTERNAL_TOOL_NAME,
          description: instructions,
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ]
  return JSON.stringify(parsed)
}

/** Fallback CHARACTER budget for `renderConversationAsText` when called
 *  without a token `measure` (unit-agnostic default = char length). Also
 *  the conservative no-catalog floor: 720,000 chars ≈ 240,000 tokens at
 *  ~3 chars/token, which fits even the smaller `/responses` models. The
 *  live path measures EXACT o200k tokens (see `runAdvisor`) and budgets
 *  against the model's real `max_prompt_tokens`, so this constant is only
 *  a safety net, never the normal path. */
export const ADVISOR_MAX_CONVERSATION_CHARS = 720_000

/** Token budget used when the advisor model's `max_prompt_tokens` can't
 *  be resolved from the live catalog. ≈ the 720K-char fallback in tokens. */
export const ADVISOR_FALLBACK_MAX_TOKENS = 240_000

/** Tokens reserved below the model's `max_prompt_tokens` for the advisor
 *  system prompt + per-call framing + any encode/wire discrepancy between
 *  our o200k count and Copilot's full-payload count. The transcript token
 *  budget is `max_prompt_tokens - reserve`. Generous on purpose: a 400
 *  `model_max_prompt_tokens_exceeded` degrades to a silent advisor
 *  fallback, and the window given up is marginal against either advisor
 *  model's real prompt window (`claude-opus-5` 936k, `gpt-5.6-sol` ~1M off
 *  the live catalog). Sized as a fraction of the smaller of the two, not as
 *  "irrelevant next to ~1M" — that framing assumed the advisor was always
 *  the cheap side of the pair, which stopped being true once a budget lead
 *  escalates to Opus. */
const ADVISOR_PROMPT_TOKEN_RESERVE = 8_000

/**
 * Derive the TOKEN budget for the rendered transcript from the advisor
 * model's live `max_prompt_tokens` (cached in `state.models` by
 * `cacheModels()` at startup). Self-correcting: tracks the model's real
 * window instead of a hardcoded guess, and honors a SMALLER window if a
 * caller overrides `advisorModel` to a tighter model. Falls back to
 * `ADVISOR_FALLBACK_MAX_TOKENS` when the catalog or field is missing.
 */
export function resolveAdvisorMaxTokens(advisorModel: string): number {
  const id = resolveModel(advisorModel)
  const maxPromptTokens = state.models?.data?.find((m) => m.id === id)
    ?.capabilities?.limits?.max_prompt_tokens
  if (
    typeof maxPromptTokens !== "number"
    || !Number.isFinite(maxPromptTokens)
    || maxPromptTokens <= 0
  ) {
    return ADVISOR_FALLBACK_MAX_TOKENS
  }
  return Math.max(1, maxPromptTokens - ADVISOR_PROMPT_TOKEN_RESERVE)
}

/**
 * Render an Anthropic-shape conversation (messages array with
 * role/content blocks) as a single human-readable text blob. Used
 * as the input to the advisor model (gpt-5.6-sol via /v1/responses
 * doesn't have a 1:1 mapping for Anthropic's tool_use/tool_result
 * blocks; serializing to text preserves the semantics — the advisor
 * just needs to READ the conversation, not produce more of it).
 *
 * Front-truncates oldest turns when the rendered output would exceed
 * `maxUnits`. The advisor cares more about current state (latest
 * tool calls, errors, in-flight task) than the original prompt —
 * mirrors Claude Code's own context-truncation strategy. When any
 * turns are dropped, prepends a `[TRUNCATED: N earlier turn(s)
 * omitted ...]` notice so the advisor knows the transcript is
 * partial and can flag if it needs the missing context.
 *
 * Unit-agnostic via the injected `measure` function: production passes
 * an EXACT o200k token counter and a token budget (so truncation tracks
 * the model's real `max_prompt_tokens`); the default `measure` is char
 * length, so callers/tests that pass a plain numeric budget get the
 * historical character-budget behavior.
 */
export function renderConversationAsText(
  conversation: Array<AnyRecord>,
  maxUnits: number = ADVISOR_MAX_CONVERSATION_CHARS,
  measure: (s: string) => number = (s) => s.length,
): string {
  const turnBlocks: Array<string> = []
  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i]
    const role = (msg.role as string) ?? "unknown"
    const block: Array<string> = [`### Turn ${i + 1} — ${role}`]
    const content = msg.content
    if (typeof content === "string") {
      block.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue
        const b = part as AnyRecord
        if (b.type === "text" && typeof b.text === "string") {
          block.push(b.text)
        } else if (b.type === "tool_use") {
          block.push(
            `[tool_use ${b.name ?? "?"}(${b.id ?? "?"}): ${JSON.stringify(b.input ?? {})}]`,
          )
        } else if (b.type === "tool_result") {
          const c =
            typeof b.content === "string" ? b.content : JSON.stringify(b.content)
          block.push(`[tool_result ${b.tool_use_id ?? "?"}]:\n${c}`)
        } else {
          block.push(`[${b.type}: ${JSON.stringify(b).slice(0, 500)}]`)
        }
      }
    }
    block.push("")
    turnBlocks.push(block.join("\n"))
  }

  // Walk from the latest turn backward, accumulating until the next
  // turn would push us over budget. Measured in whatever unit `measure`
  // reports (tokens in prod, chars by default).
  let totalUnits = 0
  let firstKeptIdx = turnBlocks.length
  for (let i = turnBlocks.length - 1; i >= 0; i--) {
    const len = measure(turnBlocks[i]) + 1
    if (totalUnits + len > maxUnits) break
    totalUnits += len
    firstKeptIdx = i
  }

  // Edge case: even the latest turn alone exceeds the budget. Hard-
  // truncate its tail to fit (advisor still gets the most-recent
  // context, just not all of it).
  if (firstKeptIdx === turnBlocks.length && turnBlocks.length > 0) {
    const last = turnBlocks[turnBlocks.length - 1]
    const notice =
      `[TRUNCATED: conversation too long for advisor model context; `
      + `only the tail of the latest (turn ${turnBlocks.length}) is shown]\n\n`
    const budgetForTail = Math.max(0, maxUnits - measure(notice))
    return notice + truncateTailToUnits(last, budgetForTail, measure)
  }

  const kept = turnBlocks.slice(firstKeptIdx)
  if (firstKeptIdx > 0) {
    kept.unshift(
      `[TRUNCATED: ${firstKeptIdx} earlier turn(s) omitted to fit advisor `
        + `model context budget; ${turnBlocks.length - firstKeptIdx} most-recent `
        + `turn(s) shown below]\n`,
    )
  }
  return kept.join("\n")
}

/**
 * Return the longest suffix of `text` whose `measure(...)` is ≤ `maxUnits`.
 * Binary search on the cut point — unit-agnostic (works for the token
 * `measure` in prod and the char-length default), and exact rather than
 * a chars-per-token estimate. `measure` is called O(log n) times.
 */
function truncateTailToUnits(
  text: string,
  maxUnits: number,
  measure: (s: string) => number,
): string {
  if (maxUnits <= 0) return ""
  if (measure(text) <= maxUnits) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2) // candidate tail length
    if (measure(text.slice(text.length - mid)) <= maxUnits) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return text.slice(text.length - lo)
}

/**
 * Run the advisor model with the full conversation context. Returns
 * the advisor's text response.
 *
 * Routes by model family:
 *   - gpt-5.x / codex / o-series (have `/responses` in supported_endpoints):
 *     use createResponses with `reasoning.effort` set. This is the
 *     default path — gpt-5.6-sol at xhigh effort.
 *   - claude-* (no `/responses`): fall back to createMessages.
 *
 * The conversation is serialized to text via renderConversationAsText
 * so the advisor model (which may not natively understand Anthropic's
 * tool_use/tool_result block shapes) sees a flat readable transcript.
 * This loses some structural fidelity but matches the spirit of
 * Anthropic's own ADVISOR ("see the whole task + every tool call +
 * every result").
 */
export function advisorSystemPrompt(
  advisorEscalated = false,
  fastProfile = false,
  maxProfile = false,
): string {
  if (maxProfile) return MAX_ADVISOR_SYSTEM_PROMPT
  return (
    "You are an expert advisor reviewing an in-progress Claude Code session. "
    + "The transcript below is the work-in-progress (turns numbered, with "
    + "tool calls and results inlined). Read carefully and provide concrete, "
    + "actionable advice on the next step or course-correction. Be specific — "
    + "cite the parts of the transcript you're responding to. If the assistant "
    + "is on the right track, say so explicitly. If they're stuck or off-track, "
    + "name the specific assumption or step to revisit. Aim for 2-5 paragraphs "
    + "of substantive guidance."
    + (fastProfile
      ? " You are a non-binding consultant to the primary lead. Address the "
        + "focused uncertainty that prompted this call with a recommendation, "
        + "its assumptions, material risks, credible alternatives, confidence, and "
        + "any evidence gap that would change the recommendation. Do not approve, veto, dictate, "
        + "or take ownership; the lead will weigh your advice against the user's intent "
        + "and verified evidence."
      : "")
    // Only on the AUTOMATIC escalation, never on an operator pin that happens to
    // name the same model — see `AdvisorModelChoice.escalated`. The requesting
    // agent really is a lighter tier here, so it needs a decision rather than a
    // survey of options it is less equipped to choose between.
    + (advisorEscalated && !fastProfile && !maxProfile
      ? " The requesting agent is running a lighter, faster model than you. "
        + "Give a directive recommendation and commit to the decision rather "
        + "than laying out options for it to weigh."
      : "")
  )
}

async function runAdvisor(
  conversation: Array<AnyRecord>,
  advisorModel: string,
  advisorEffort: string,
  signal?: AbortSignal,
  advisorEscalated = false,
  fastProfile = false,
  maxProfile = false,
): Promise<string> {
  if (signal?.aborted) {
    throw new Error("advisor call aborted before dispatch")
  }
  const advisorSystem = advisorSystemPrompt(advisorEscalated, fastProfile, maxProfile)

  const resolvedAdvisorModel = resolveModel(advisorModel)

  // Budget the rendered transcript against the advisor model's REAL
  // prompt-token window using its exact tokenizer, not a chars/token
  // approximation. Both advisor-eligible families declare o200k_base
  // (`gpt-5.6-sol` and `claude-opus-5` were each read off the live catalog when
  // the Anthropic escalation was added), so `getTokenizerFromModel` agrees with
  // the default — but the value is read per model rather than assumed, because
  // counting a transcript with the wrong tokenizer under-counts silently and
  // surfaces as an upstream 400 only on long sessions.
  // Front-truncation in renderConversationAsText then drops oldest turns until
  // the EXACT token count fits. If the tokenizer can't be loaded, degrade to the
  // char-length budget rather than fail the whole advisor turn.
  let measure: (s: string) => number
  let maxUnits: number
  try {
    const modelEntry = state.models?.data?.find(
      (m) => m.id === resolvedAdvisorModel,
    )
    const encoder = await loadEncoder(
      modelEntry ? getTokenizerFromModel(modelEntry) : "o200k_base",
    )
    measure = (s) => encoder.encode(s).length
    maxUnits = resolveAdvisorMaxTokens(advisorModel)
  } catch (err) {
    consola.debug(
      "advisor: tokenizer load failed; using char-length budget:",
      err,
    )
    measure = (s) => s.length
    maxUnits = ADVISOR_MAX_CONVERSATION_CHARS
  }
  const conversationText = renderConversationAsText(
    conversation,
    maxUnits,
    measure,
  )

  // Route by model family/catalog endpoint — see `advisorTransport` for the
  // three-way (`responses` / `chat` / `messages`) decision and its ordering
  // rationale.
  const transport = advisorTransport(resolvedAdvisorModel, fastProfile)
  if (fastProfile) {
    consola.warn(
      `fast Advisor dispatch: model=${resolvedAdvisorModel} transport=${transport} effort=${advisorEffort}`,
    )
  }

  if (transport === "responses") {
    const payload = applyResponsesCachePolicy({
      model: resolvedAdvisorModel,
      instructions: advisorSystem,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: conversationText }],
        },
      ],
      stream: false,
      // gpt-5.x reads reasoning.effort directly. xhigh is the deepest
      // reasoning bucket — appropriate for adversarial review since the
      // advisor adds most of its value on the FIRST call (per cc-backup
      // ADVISOR_TOOL_INSTRUCTIONS line 31), so don't be cheap.
      reasoning: { effort: advisorEffort },
    } satisfies ResponsesPayload, { workload: "reusable-prefix" })
    const response = (await withTransientRetry(
      () => createResponses(payload, undefined, signal),
      { signal, label: resolvedAdvisorModel },
    )) as ResponsesApiResponse
    const out: Array<string> = []
    for (const item of response.output) {
      if (typeof item !== "object" || item === null) continue
      const obj = item as Record<string, unknown>
      if (obj.type !== "message" || obj.role !== "assistant") continue
      const content = obj.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue
        const p = part as Record<string, unknown>
        if (
          (p.type === "output_text" || p.type === "text")
          && typeof p.text === "string"
        ) {
          out.push(p.text)
        }
      }
    }
    const text = out.join("")
    if (!text) {
      throw new Error(
        `Advisor model ${resolvedAdvisorModel} returned empty assistant output`,
      )
    }
    return text
  }

  // chat branch: /chat/completions with the conversation as a single user
  // message. Reachable now that `resolveAdvisorModel` can pick a
  // chat-only advisor (`gemini-3.8-flash`, the authenticated fast profile). No
  // request-shaping helper is extracted from `dispatchModelCall` here:
  // the advisor's payload (one system + one user message, no tools, no
  // caching hints) is simple enough that reuse would cost more in
  // indirection than it saves, and the two genuinely shared concerns —
  // effort clamping and error/empty-output handling — are already
  // factored into `advertisedEffortLadder` and this function's own
  // per-branch checks.
  if (transport === "chat") {
    const ladder = advertisedEffortLadder(resolvedAdvisorModel)
    const chatPayload: ChatCompletionsPayload = {
      model: resolvedAdvisorModel,
      messages: [
        { role: "system", content: advisorSystem },
        { role: "user", content: conversationText },
      ],
      stream: false,
      // Only sent when the advisor's live ladder actually advertises one —
      // same "don't forward an unverifiable knob" rule the Claude branch
      // below applies to `output_config.effort`.
      ...(ladder ? { reasoning_effort: advisorEffort } : {}),
    }
    const response = (await withTransientRetry(
      () => createChatCompletions(chatPayload, undefined, signal),
      { signal, label: resolvedAdvisorModel },
    )) as ChatCompletionResponse
    const text = response.choices?.[0]?.message?.content
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(
        `Advisor model ${resolvedAdvisorModel} returned empty response`,
      )
    }
    return text
  }

  // claude-* branch: /v1/messages with the conversation as a single user
  // message.
  //
  // This branch used to be unreachable — `ADVISOR_DEFAULT_MODEL` always matched
  // the /responses regex above — which is why it dropped the effort on the floor
  // and carried a comment saying effort did not apply. `ADVISOR_ESCALATION_MODEL`
  // makes it live, so both the effort and the output cap have to be real here or
  // the escalation advises with thinking disabled.
  const advisorEntry = state.models?.data?.find(
    (m) => m.id === resolvedAdvisorModel,
  )
  const limits = advisorEntry?.capabilities?.limits
  // `stream: false` below, so size from the NON-streaming limit (16000 on
  // claude-opus-5, against a 64000 streaming ceiling). Copilot does NOT actually
  // enforce this — probe `advisor_claude_streaming_cap_accepted` measured a 200
  // at 64000 with stream:false — so this is staying inside the advertised
  // contract by choice rather than working around a rejection. 16000 is ample
  // for the 2-5 paragraphs the system prompt asks for, and it keeps working if
  // Copilot ever starts enforcing what it advertises. The old 4096 remains the
  // floor for a catalog-less path.
  const maxTokens =
    limits?.max_non_streaming_output_tokens
    ?? limits?.max_output_tokens
    ?? ADVISOR_FALLBACK_MAX_OUTPUT_TOKENS
  const advisorBody = applyClaudeCachePolicy(JSON.stringify({
    model: resolvedAdvisorModel,
    max_tokens: maxTokens,
    system: advisorSystem,
    messages: [{ role: "user", content: conversationText }],
    stream: false,
    // Effort reaches an Anthropic model the same way `translateThinking` sends
    // it for any adaptive-thinking model. Two conditions, not one: the model
    // must advertise `adaptive_thinking` (a Claude entry without it would 400 on
    // this shape) AND advertise a non-empty effort ladder. Without the second,
    // `resolveAdvisorEffort` returns its floored value unclamped — correct as a
    // resolver, since an absent ladder means "accepts anything" everywhere else
    // in this repo — but sending an unvalidated effort here costs a whole
    // transcript upload to learn it was wrong. `thinking` alone still ships, so
    // the advisor reasons; only the unverifiable knob is dropped. Probe:
    // `advisor_claude_adaptive_thinking` in scripts/probe-copilot-compat.sh.
    ...(advisorEntry?.capabilities?.supports?.adaptive_thinking
      ? {
          thinking: { type: "adaptive" },
          ...(advertisedEffortLadder(resolvedAdvisorModel)
            ? { output_config: { effort: advisorEffort } }
            : {}),
        }
      : {}),
  }), { workload: "reusable-prefix" })
  const response = await withTransientRetry(
    () => createMessages(advisorBody, {}, signal),
    { signal, label: resolvedAdvisorModel },
  )
  const json = (await response.json()) as AnyRecord
  const blocks = Array.isArray(json.content) ? json.content : []
  const text = blocks
    .filter((b: AnyRecord) => b.type === "text" && typeof b.text === "string")
    .map((b: AnyRecord) => b.text as string)
    .join("\n\n")
  if (!text) {
    throw new Error(`Advisor model ${resolvedAdvisorModel} returned empty response`)
  }
  return text
}

interface ToolUseTracker {
  /** Block index from the SSE stream */
  index: number
  /** tool_use_id assigned by the upstream model — used in the
   *  conversation-replay path sent back to Copilot in next turns of
   *  the in-loop advisor flow (must match Anthropic `^toolu_*$`). */
  id: string
  /** Client-facing server_tool_use id derived from `id` — used in
   *  the translated server_tool_use + advisor_tool_result blocks
   *  emitted on the SSE stream to the client. Anthropic spec
   *  requires this to match `^srvtoolu_[a-zA-Z0-9_]+$` (parallel to
   *  `toolu_*` for client-fulfilled tools). Mismatched format causes
   *  Copilot to 400 the conversation history when Claude Code
   *  replays it later — the failure is delayed because the original
   *  request succeeds; the broken block only hits a validator on a
   *  much-later turn that includes it in the message history. */
  clientId: string
  /** Accumulated input_json_delta text (advisor takes no input but
   *  we accumulate defensively) */
  inputJson: string
}

/**
 * Derive a spec-compliant `srvtoolu_*` id for a client-facing
 * `server_tool_use` (and matching `advisor_tool_result.tool_use_id`)
 * from the upstream model's tool-call id.
 *
 * TOTAL — never throws. Two paths:
 *
 *   1. A real Anthropic `toolu_*` id whose suffix is already in the
 *      `^[a-zA-Z0-9_]+$` charset: `srvtoolu_<suffix>`, byte-for-byte
 *      identical to the historical (Claude-lead) behavior.
 *   2. Anything else — a Responses `call_*` id (an authenticated fast lead's
 *      lead, once its `tool_use{__anthropic_advisor}` block is synthesized
 *      by the anthropic-translate shim from a Copilot `/responses` tool
 *      call), a hyphenated or otherwise non-conforming id, an empty string,
 *      unicode, or a corrupt id — sanitize to the Anthropic charset and
 *      prefix with `fallbackIndex` (the caller's per-block synthetic stream
 *      index, unique within one `buildAdvisorStream` run) so two different
 *      raw ids that happen to sanitize to the same string can never
 *      collide. `fallbackIndex` is REQUIRED for this path's uniqueness
 *      guarantee — callers must pass a value that is unique per call within
 *      one advisor stream (every call site does: `myIndex` from the
 *      turn processor's monotonic `nextSyntheticIndex`).
 *
 * This function ONLY has to produce a valid, deterministic, collision-free
 * LABEL — the original raw id is preserved separately for Copilot replay
 * (`CapturedBlock.advisorReplay.id`), never reconstructed from the derived
 * client id. That is what makes totality safe: there is no bijective-decode
 * requirement on this function itself, only on the (id, clientId) pairing a
 * caller keeps alongside it.
 *
 * Historically this threw "advisor tool_use id is not round-trippable" for
 * any non-`toolu_` shape. That was correct for a Claude-only advisor lead —
 * Copilot's native `/v1/messages` never emits anything else — but became a
 * live defect once the advisor loop could run on a non-Claude fast lead
 * shimmed through `/responses`: `responses-egress.ts` forwards a Responses
 * `call_*` id VERBATIM as the synthesized `tool_use.id` (see
 * `makeToolUseId` — it only synthesizes a `toolu_*` id when the upstream id
 * is EMPTY), so the advisor's `tool_use{__anthropic_advisor}` block on that
 * lead legitimately carries a `call_*` id and the throw fired on every
 * single advisor call.
 */
export function toClientServerToolUseId(
  id: string,
  fallbackIndex: number,
): string {
  if (id.startsWith("toolu_")) {
    const suffix = id.slice("toolu_".length)
    if (/^[a-zA-Z0-9_]+$/.test(suffix)) return `srvtoolu_${suffix}`
  }
  const sanitized = id.replace(/[^a-zA-Z0-9_]/g, "_")
  return `srvtoolu_gen${fallbackIndex}${sanitized.length > 0 ? `_${sanitized}` : ""}`
}


/**
 * A captured assistant content block from the upstream Copilot stream,
 * suitable for replay back to Copilot in the advisor loop's
 * continuation turn. Holds the raw `content_block` object verbatim so
 * future block types we don't recognize today (thinking, redacted_
 * thinking, image, document, citations, etc.) flow through correctly.
 *
 * Mutated in place during streaming: text_delta appends to .block.text,
 * thinking_delta to .block.thinking, signature_delta to .block.signature,
 * input_json_delta accumulates into partialJson and is parsed into
 * .block.input at content_block_stop (Anthropic spec requires
 * tool_use.input to be a parsed object on replay, not a raw JSON string).
 *
 * Special case: when the upstream block is `tool_use{__anthropic_advisor}`,
 * the proxy SYNTHESIZES a different block for client output
 * (`server_tool_use{name:"advisor"}` with the `srvtoolu_*` clientId)
 * AND tracks the original `toolu_*` id in `advisorReplay` so the
 * Copilot-replay continuation request uses the original.
 */
interface CapturedBlock {
  /** The full `content_block` object from the upstream
   *  content_block_start event (or, for advisor blocks, an internal
   *  representation we'll synthesize on emit). */
  block: AnyRecord
  /** Raw partial_json buffer for tool_use blocks. JSON.parse'd into
   *  `block.input` at content_block_stop. */
  partialJson: string
  /** Set if this block was the advisor invocation. The
   *  Copilot-replay path must emit a `tool_use{__anthropic_advisor}`
   *  with the original `toolu_*` id, NOT the client-facing
   *  `srvtoolu_*` id; the input is the parsed advisor input (defaults
   *  to {} if no input_json_delta arrived — codex round-7: don't bake
   *  "advisor takes no input" as a load-bearing invariant). */
  advisorReplay?: { id: string }
}

/**
 * Build an SSE event line in the canonical Anthropic shape:
 *   event: <type>
 *   data: <json>
 *   <blank>
 */
function sseEvent(type: string, data: AnyRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * The default `continueTurn` for `buildAdvisorStream`: native Claude
 * passthrough (`createMessages`) plus signed-thinking-history repair-and-retry.
 * Extracted verbatim from the loop body so the behavior is byte-identical to
 * before `continueTurn` became injectable, and so a non-Claude
 * `continueTurn` (the fast profile's shim-backed one) can omit this
 * Claude-only repair path entirely rather than inherit dead code that would
 * never fire for it.
 */
async function defaultContinueTurn(
  body: AnyRecord,
  signal: AbortSignal,
  requestHeaders: Record<string, string>,
): Promise<Response> {
  const continuationBody = JSON.stringify(body)
  // retryTransient: true (passed to createMessages below): pre-first-byte
  // retry on a 429/5xx/network blip. The continuation Response body is not
  // read until processOneTurn streams it, so re-issuing here cannot
  // duplicate already-streamed output. Matches the first-call retry in
  // routes/messages/handler.ts so the advisor turn no longer dies to a lone
  // "fetch failed".
  //
  // The first call in routes/messages/handler.ts is also wrapped in the
  // signed-thinking repair; this continuation was not, so a rejected
  // history here died as an advisor stream error with no recovery. One
  // repair attempt is enough: unlike the first call, a continuation
  // replays a history the first call already got past, so converging
  // across several corrupt turns is not a case that arises here.
  let continuationSend = continuationBody
  const knownRepair = repairKnownThinkingHistory(continuationSend)
  if (knownRepair) continuationSend = knownRepair.body
  try {
    return await createMessages(continuationSend, requestHeaders, signal, true)
  } catch (continuationError) {
    if (!(continuationError instanceof HTTPError)) throw continuationError
    const errorBody = await continuationError.response
      .clone()
      .text()
      .catch(() => "")
    const outcome = repairRejectedThinkingHistory(continuationSend, errorBody)
    if (!outcome.ok) {
      consola.warn(
        `Advisor continuation thinking-history repair declined: ${formatThinkingRepairDecline(outcome.decline)}`,
      )
      throw continuationError
    }
    consola.warn(
      `Advisor continuation: retrying without rejected thinking blocks: message=${outcome.repair.messageIndex} removed_blocks=${outcome.repair.removedBlocks}`,
    )
    const response = await createMessages(
      outcome.repair.body,
      requestHeaders,
      signal,
      true,
    )
    // Memoize only after upstream accepted it, so the main path can
    // pre-emptively apply the same repair without paying another 400.
    rememberThinkingHistoryRepair(outcome.repair.fingerprint)
    return response
  }
}

/**
 * The streaming translate-loop. Returns a ReadableStream<Uint8Array>
 * suitable to wrap with Hono's c.body() / new Response().
 *
 * @param firstResponse The first Copilot streaming response
 * @param initialConversation The conversation messages from the
 *   incoming request (used as the starting context for advisor calls
 *   and continuation Copilot calls).
 * @param baseBody Parsed initial request body (model, max_tokens,
 *   system, etc.) — used as the template for continuation Copilot calls.
 * @param requestHeaders Extra headers (model-specific + filtered
 *   anthropic-beta) for downstream Copilot calls.
 * @param advisorModel Which model to route advisor calls to. Defaults
 *   to ADVISOR_DEFAULT_MODEL (cross-lab).
 */
export function buildAdvisorStream(opts: {
  firstResponse: Response
  initialConversation: Array<AnyRecord>
  baseBody: AnyRecord
  requestHeaders: Record<string, string>
  advisorModel?: string
  advisorEffort?: string
  /** From `resolveAdvisorModel(...).escalated`. Drives only the system-prompt
   *  clause in `runAdvisor`; never the model or transport choice. */
  advisorEscalated?: boolean
  /** True only for the authenticated fast lead. Selects the non-binding
   * consultant prompt without changing transport or loop behavior. */
  advisorFastProfile?: boolean
  /** True only for the authenticated max lead. Uses the same non-binding
   * consultant posture while retaining max's model and effort policy. */
  advisorMaxProfile?: boolean
  externalAborter?: AbortController
  /**
   * Injectable continuation dispatcher for every turn AFTER the first.
   * Defaults to `defaultContinueTurn` — the historical native `createMessages`
   * call plus its signed-thinking repair-and-retry, byte-identical to this
   * module's behavior before this parameter existed.
   *
   * A non-Claude model selected by the fast primary lead passes a shim-backed
   * continuation instead: `makeShimContinueTurn` in
   * `src/lib/anthropic-translate/index.ts` builds one that routes through the
   * SAME translation + Anthropic-SSE-synthesis machinery as the initial
   * request, so `processOneTurn` below — message-start dedup, synthetic index
   * re-assignment, abort propagation, all of it — drives both lead families
   * without a parallel, divergent continuation implementation. Claude's
   * signed-thinking repair is intentionally NOT part of the injected
   * contract: it is a Claude-only wire concept (the shim drops assistant
   * `thinking` blocks entirely), so a shim-backed `continueTurn` has nothing
   * to repair and simply omits that step.
   */
  continueTurn?: (body: AnyRecord, signal: AbortSignal) => Promise<Response>
}): ReadableStream<Uint8Array> {
  const advisorModel = opts.advisorModel ?? ADVISOR_DEFAULT_MODEL
  const advisorEffort = opts.advisorEffort ?? ADVISOR_DEFAULT_EFFORT
  const advisorEscalated = opts.advisorEscalated ?? false
  const advisorFastProfile = opts.advisorFastProfile ?? false
  const advisorMaxProfile = opts.advisorMaxProfile ?? false
  const continueTurn =
    opts.continueTurn
    ?? ((body: AnyRecord, signal: AbortSignal) =>
      defaultContinueTurn(body, signal, opts.requestHeaders))

  // Use the caller-supplied AbortController when provided, otherwise
  // create a local one. When the handler creates a shared controller
  // that also governs the initial createMessages response, consumer-
  // cancel propagates to BOTH the initial response body AND the
  // continuation/runAdvisor calls — fixing the leak where the initial
  // fetch survived cancellation for up to UPSTREAM_FETCH_TIMEOUT_MS.
  const aborter = opts.externalAborter ?? new AbortController()
  // Hoist `conversation` so cancel() can clear the reference and let
  // the accumulated tool_result text get GC'd promptly (a long
  // advisor loop accumulates hundreds of KB of upstream content).
  let conversation: Array<AnyRecord> | null = [...opts.initialConversation]

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStartForwarded = false
      let nextSyntheticIndex = 0
      let turnsRun: number
      let pendingMessageDelta: {
        stopReason: unknown
        stopSequence: unknown
        usage: Record<string, number>
      } | null = null

      const safeEnqueue = (bytes: Uint8Array): boolean => {
        try {
          controller.enqueue(bytes)
          return true
        } catch (err) {
          if (isControllerClosedError(err)) {
            // Consumer is gone — also signal the upstream abort so the
            // outer loop and any in-flight createMessages/runAdvisor
            // tear down on the next signal check (or sooner, via the
            // fetch's AbortSignal). Safe to call repeatedly — abort()
            // is idempotent.
            if (!aborter.signal.aborted) {
              aborter.abort(new Error("advisor stream consumer disconnected"))
            }
            return false
          }
          throw err
        }
      }

      const safeEnqueueEvent = (type: string, data: AnyRecord): boolean =>
        safeEnqueue(ENCODER.encode(sseEvent(type, data)))

      const captureMessageDelta = (payload: AnyRecord): void => {
        const delta =
          payload.delta && typeof payload.delta === "object"
            ? (payload.delta as AnyRecord)
            : {}
        const usage =
          payload.usage && typeof payload.usage === "object"
            ? (payload.usage as AnyRecord)
            : {}
        if (!pendingMessageDelta) {
          pendingMessageDelta = {
            stopReason: delta.stop_reason ?? null,
            stopSequence: delta.stop_sequence ?? null,
            usage: {},
          }
        } else {
          if (delta.stop_reason !== undefined) {
            pendingMessageDelta.stopReason = delta.stop_reason
          }
          if (delta.stop_sequence !== undefined) {
            pendingMessageDelta.stopSequence = delta.stop_sequence
          }
        }
        for (const [key, value] of Object.entries(usage)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            pendingMessageDelta.usage[key] =
              (pendingMessageDelta.usage[key] ?? 0) + value
          }
        }
      }

      const emitTerminal = (forcedStopReason?: string): boolean => {
        if (pendingMessageDelta || forcedStopReason) {
          const terminal = pendingMessageDelta ?? {
            stopReason: null,
            stopSequence: null,
            usage: {},
          }
          if (
            !safeEnqueueEvent("message_delta", {
              type: "message_delta",
              delta: {
                stop_reason: forcedStopReason ?? terminal.stopReason,
                stop_sequence: terminal.stopSequence,
              },
              usage: terminal.usage,
            })
          ) {
            return false
          }
        }
        return safeEnqueueEvent("message_stop", { type: "message_stop" })
      }

      // Process one Copilot streaming response. Returns the assistant
      // turn's blocks + every advisor tool_use called in that turn.
      // Forwards events to the client as it goes.
      async function processOneTurn(
        response: Response,
      ): Promise<{
        capturedBlocks: Array<CapturedBlock>
        advisorToolUses: Array<ToolUseTracker>
        clientToolUseCount: number
      }> {
        const capturedBlocks: Array<CapturedBlock> = []
        const advisorToolUses: Array<ToolUseTracker> = []
        let clientToolUseCount = 0
        // Track which upstream block index corresponds to which entry
        // in capturedBlocks (so deltas know which to update).
        const indexToBlock = new Map<number, CapturedBlock>()

        for await (const ev of events(response)) {
          if (!ev.event || !ev.data) continue
          let payload: AnyRecord
          try {
            payload = JSON.parse(ev.data) as AnyRecord
          } catch {
            // Non-JSON data — forward as-is (defensive).
            const ok = safeEnqueue(ENCODER.encode(`event: ${ev.event}\ndata: ${ev.data}\n\n`))
            if (!ok) return { capturedBlocks, advisorToolUses, clientToolUseCount }
            continue
          }

          switch (ev.event) {
            case "message_start": {
              if (!messageStartForwarded) {
                if (!safeEnqueueEvent(ev.event, payload)) {
                  return { capturedBlocks, advisorToolUses, clientToolUseCount }
                }
                messageStartForwarded = true
              }
              // Suppress duplicate message_start on continuation turns —
              // we keep one open for the entire advisor loop.
              continue
            }

            case "content_block_start": {
              const block = (payload as AnyRecord).content_block as AnyRecord | undefined
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              if (block && upstreamIndex !== undefined) {
                // Re-index to the synthetic stream's monotonic index
                // (continuation turns reset their upstream index to 0,
                // which would collide with prior turns' indices).
                const myIndex = nextSyntheticIndex++

                if (
                  block.type === "tool_use"
                  && block.name === ADVISOR_INTERNAL_TOOL_NAME
                ) {
                  // Translate to server_tool_use{advisor}
                  const id =
                    typeof block.id === "string"
                      ? block.id
                      : `toolu_advisor_${myIndex}`
                  const advisorToolUse = {
                    index: myIndex,
                    id,
                    clientId: toClientServerToolUseId(id, myIndex),
                    inputJson: "",
                  }
                  advisorToolUses.push(advisorToolUse)
                  const translated = {
                    ...payload,
                    index: myIndex,
                    content_block: {
                      type: "server_tool_use",
                      id: advisorToolUse.clientId,
                      name: ADVISOR_CLIENT_TOOL_NAME,
                      input: {},
                    },
                  }
                  if (!safeEnqueueEvent(ev.event, translated)) {
                    return { capturedBlocks, advisorToolUses, clientToolUseCount }
                  }
                  // Track for later — the Copilot-replay continuation
                  // turn needs to round-trip with the INTERNAL name +
                  // ORIGINAL toolu_* id (Copilot doesn't know
                  // server_tool_use). The advisor branch reuses the
                  // standard captured-block pipeline (deltas accumulate,
                  // input parses) so that future versions of advisor
                  // that take params would Just Work — we synthesize
                  // the actual replay shape in the content mapping.
                  const captured: CapturedBlock = {
                    block: {
                      type: "tool_use",
                      id,
                      name: ADVISOR_INTERNAL_TOOL_NAME,
                      input: {},
                    },
                    partialJson: "",
                    advisorReplay: { id },
                  }
                  capturedBlocks.push(captured)
                  indexToBlock.set(upstreamIndex, captured)
                } else {
                  if (block.type === "tool_use") clientToolUseCount++
                  // Forward as-is, with re-indexed.
                  const reindexed = { ...payload, index: myIndex }
                  if (!safeEnqueueEvent(ev.event, reindexed)) {
                    return { capturedBlocks, advisorToolUses, clientToolUseCount }
                  }
                  // Store the raw content_block verbatim — preserves
                  // every field upstream sent (including ones the proxy
                  // doesn't know about: thinking, signature, image src,
                  // document data, citations, etc.). Mutated in place
                  // by deltas; emitted verbatim on replay.
                  const captured: CapturedBlock = {
                    block: { ...block },
                    partialJson: "",
                  }
                  capturedBlocks.push(captured)
                  indexToBlock.set(upstreamIndex, captured)
                }
              }
              continue
            }

            case "content_block_delta": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const delta = (payload as AnyRecord).delta as AnyRecord | undefined
              if (upstreamIndex !== undefined) {
                const captured =
                  upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
                // Re-index for the outgoing event
                const reindexed = {
                  ...payload,
                  index: captured
                    ? capturedBlocks.indexOf(captured) >= 0
                      ? // Find the synthetic index by matching back.
                        nextSyntheticIndex - capturedBlocks.length + capturedBlocks.indexOf(captured)
                      : upstreamIndex
                    : upstreamIndex,
                }
                if (!safeEnqueueEvent(ev.event, reindexed)) {
                  return { capturedBlocks, advisorToolUses, clientToolUseCount }
                }
                // Accumulate every delta type into the right field on
                // captured.block. The block is mutated in place; on
                // replay it's emitted verbatim, so every field upstream
                // sent (text, thinking, signature, citations, image
                // src, document data, etc.) flows back correctly.
                if (captured && delta) {
                  if (delta.type === "text_delta" && typeof delta.text === "string") {
                    captured.block.text =
                      ((captured.block.text as string | undefined) ?? "") + delta.text
                  } else if (
                    delta.type === "thinking_delta"
                    && typeof delta.thinking === "string"
                  ) {
                    // Anthropic spec: thinking blocks must carry their
                    // text on replay. signature_delta carries the
                    // cryptographic signature separately.
                    captured.block.thinking =
                      ((captured.block.thinking as string | undefined) ?? "") + delta.thinking
                  } else if (
                    delta.type === "signature_delta"
                    && typeof delta.signature === "string"
                  ) {
                    // Concatenate verbatim — Anthropic verifies
                    // signatures cryptographically; mutating bytes
                    // (e.g., normalization, base64 decode/re-encode)
                    // would break verification. Pure string append.
                    captured.block.signature =
                      ((captured.block.signature as string | undefined) ?? "") + delta.signature
                  } else if (
                    delta.type === "input_json_delta"
                    && typeof delta.partial_json === "string"
                  ) {
                    captured.partialJson += delta.partial_json
                  } else if (
                    delta.type === "citations_delta"
                    && delta.citation
                  ) {
                    // Append citations array. Future-proof for the
                    // citations Anthropic feature without us needing
                    // to know its shape.
                    if (!Array.isArray(captured.block.citations)) {
                      captured.block.citations = [] as Array<unknown>
                    }
                    ;(captured.block.citations as Array<unknown>).push(delta.citation)
                  }
                  // Other delta types: leave block as-is. The
                  // content_block_start payload is preserved verbatim,
                  // so any future delta type that the proxy hasn't
                  // explicitly accumulated still has the original
                  // start-state to fall back to.
                }
              } else {
                if (!safeEnqueueEvent(ev.event, payload)) {
                  return { capturedBlocks, advisorToolUses, clientToolUseCount }
                }
              }
              continue
            }

            case "content_block_stop": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const captured = upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
              const reindexed = {
                ...payload,
                index: captured
                  ? nextSyntheticIndex - capturedBlocks.length + capturedBlocks.indexOf(captured)
                  : (upstreamIndex ?? 0),
              }
              if (!safeEnqueueEvent(ev.event, reindexed)) {
                return { capturedBlocks, advisorToolUses, clientToolUseCount }
              }

              // Finalize block state for replay:
              if (captured) {
                // (a) For tool_use blocks, parse the accumulated raw
                //     partial_json into the block's `input` field.
                //     Anthropic spec requires `tool_use.input` to be a
                //     parsed JSON object on replay, not a string.
                //     Warn-log on parse failure rather than silent
                //     fallback so corruption surfaces in production
                //     stderr (codex round-7).
                if (
                  captured.block.type === "tool_use"
                  && captured.partialJson.length > 0
                ) {
                  try {
                    captured.block.input = JSON.parse(captured.partialJson)
                  } catch (err) {
                    consola.warn(
                      `advisor: malformed input_json_delta for tool_use `
                        + `id=${(captured.block.id as string | undefined) ?? "?"} `
                        + `name=${(captured.block.name as string | undefined) ?? "?"} `
                        + `partialJson.length=${captured.partialJson.length} `
                        + `parseError=${err instanceof Error ? err.message : String(err)}`,
                    )
                    captured.block.input = {}
                  }
                }
              }
              continue
            }

            case "message_delta": {
              // One client-visible response may span several internal Copilot
              // turns. Keep intermediate stop reasons private and emit one
              // terminal delta with accumulated usage when the loop finishes.
              captureMessageDelta(payload)
              continue
            }

            case "message_stop": {
              return { capturedBlocks, advisorToolUses, clientToolUseCount }
            }

            default: {
              // Unknown event — forward as-is.
              if (!safeEnqueueEvent(ev.event, payload)) {
                return { capturedBlocks, advisorToolUses, clientToolUseCount }
              }
            }
          }
        }
        return { capturedBlocks, advisorToolUses, clientToolUseCount }
      }

      try {
        let response: Response = opts.firstResponse

        for (turnsRun = 0; turnsRun < ADVISOR_MAX_TURNS; turnsRun++) {
          // Top-of-loop abort check — bail before processing the next
          // turn if the consumer has disconnected. Without this, the
          // outer for-loop kept iterating after a mid-stream cancel,
          // burning advisor + continuation calls into a dead stream.
          if (aborter.signal.aborted) return
          if (conversation === null) return

          const {
            capturedBlocks,
            advisorToolUses,
            clientToolUseCount,
          } = await processOneTurn(response)

          if (advisorToolUses.length === 0) {
            emitTerminal()
            return
          }

          // Immediate post-turn abort check — `processOneTurn` returns
          // early on `safeEnqueue` failure (which now also aborts the
          // controller). Don't dispatch runAdvisor + continuation if
          // the consumer is already gone.
          if (aborter.signal.aborted) return
          if (conversation === null) return

          // Advisor was called this turn. Run advisor model with the
          // full conversation extended by the assistant turn.
          //
          // Replay strategy: emit captured.block VERBATIM for every
          // captured block (preserves thinking, signature, redacted_
          // thinking, image, document, citations, anything Anthropic
          // adds tomorrow). Special-case ONLY the advisor block, which
          // needs the INTERNAL `__anthropic_advisor` name + ORIGINAL
          // `toolu_*` id (Copilot doesn't know server_tool_use).
          const assistantTurn = {
            role: "assistant",
            content: capturedBlocks
              .map((c) => {
                if (c.advisorReplay) {
                  // Use the parsed input if any input_json_delta
                  // arrived; otherwise default to {}. Don't bake
                  // "advisor takes no input" as a load-bearing
                  // invariant (codex round-7).
                  const input =
                    typeof c.block.input === "object" && c.block.input !== null
                      ? (c.block.input as AnyRecord)
                      : {}
                  return {
                    type: "tool_use",
                    id: c.advisorReplay.id, // toolu_*, NOT srvtoolu_*
                    name: ADVISOR_INTERNAL_TOOL_NAME,
                    input,
                  }
                }
                return c.block // verbatim — the bug fix
              }),
          }
          conversation.push(assistantTurn)

          const advisorConversation = conversation
          const advisorTexts = await Promise.all(
            advisorToolUses.map(async () => {
              try {
                return await runAdvisor(
                  advisorConversation,
                  advisorModel,
                  advisorEffort,
                  aborter.signal,
                  advisorEscalated,
                  advisorFastProfile,
                  advisorMaxProfile,
                )
              } catch (err) {
                // If the failure was the consumer-cancel abort, let the
                // shared abort check below end the stream silently.
                if (aborter.signal.aborted) throw err
                const msg = err instanceof Error ? err.message : String(err)
                consola.warn(`Advisor model call failed: ${msg}`)
                return (
                  `[Advisor unavailable: ${msg}. Continuing without external review — `
                  + `proceed with caution and consider self-checking against your `
                  + `primary-source evidence.]`
                )
              }
            }),
          ).catch((err) => {
            if (aborter.signal.aborted) return null
            throw err
          })
          if (!advisorTexts) return

          // Synthesize one advisor_tool_result block per invocation.
          // Each tool_use_id is the client-facing srvtoolu_* id paired
          // with the server_tool_use emitted earlier; internal toolu_*
          // ids are only used in the Copilot-replay path below.
          if (aborter.signal.aborted) return
          if (conversation === null) return
          for (let index = 0; index < advisorToolUses.length; index++) {
            const advisorToolUse = advisorToolUses[index]!
            const advisorText = advisorTexts[index]!
            const resultIndex = nextSyntheticIndex++
            const startOk = safeEnqueueEvent("content_block_start", {
              type: "content_block_start",
              index: resultIndex,
              content_block: {
                type: "advisor_tool_result",
                tool_use_id: advisorToolUse.clientId,
                content: { type: "advisor_result", text: advisorText },
              },
            })
            if (!startOk) return
            const stopOk = safeEnqueueEvent("content_block_stop", {
              type: "content_block_stop",
              index: resultIndex,
            })
            if (!stopOk) return
          }

          // Anthropic permits one assistant turn to contain both client tools
          // and a server tool. The client must execute every client tool before
          // the next model continuation. Continuing here with only the advisor
          // result would orphan those tool_use ids and Copilot rejects the
          // request. End the synthetic response and let Claude Code return all
          // client results; sanitizeAnthropicBody merges those results with the
          // advisor result on the next request.
          if (clientToolUseCount > 0) {
            emitTerminal("tool_use")
            return
          }

          // Append every tool_result to conversation in one USER turn
          // for the next Copilot call. Copilot doesn't know the
          // advisor_tool_result shape, so use standard tool_result blocks.
          conversation.push({
            role: "user",
            content: advisorToolUses.map((advisorToolUse, index) => ({
              type: "tool_result",
              tool_use_id: advisorToolUse.id,
              content: advisorTexts[index]!,
            })),
          })

          // Make the next Copilot call to continue the model's response
          // post-advisor. Reuse baseBody fields (max_tokens, system,
          // tools, etc.) but with the extended conversation and
          // stream:true. Dispatched through the injectable `continueTurn`
          // (default: Claude passthrough + signed-thinking repair via
          // `defaultContinueTurn`; the fast profile injects a
          // shim-backed one — see `buildAdvisorStream`'s option doc).
          if (aborter.signal.aborted) return
          response = await continueTurn(
            { ...opts.baseBody, messages: conversation, stream: true },
            aborter.signal,
          )
        }


        // Loop exhausted. Synthesize final message_stop + an error text
        // block so the client doesn't hang.
        if (aborter.signal.aborted) return
        const finalIndex = nextSyntheticIndex++
        safeEnqueueEvent("content_block_start", {
          type: "content_block_start",
          index: finalIndex,
          content_block: { type: "text", text: "" },
        })
        safeEnqueueEvent("content_block_delta", {
          type: "content_block_delta",
          index: finalIndex,
          delta: {
            type: "text_delta",
            text: `\n\n[Advisor loop exceeded ${ADVISOR_MAX_TURNS} turns; halting]`,
          },
        })
        safeEnqueueEvent("content_block_stop", {
          type: "content_block_stop",
          index: finalIndex,
        })
        emitTerminal("end_turn")
      } catch (err) {
        // Suppress advisor-stream error path on consumer cancel —
        // emitting `event: error` would log a misleading "advisor loop
        // failed" line; the consumer is already gone.
        if (aborter.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        consola.error(`Advisor stream error: ${msg}`)
        safeEnqueueEvent("error", {
          type: "error",
          error: { type: "api_error", message: `advisor loop failed: ${msg}` },
        })
      } finally {
        // Truncate the conversation reference so the accumulated
        // tool_result text gets GC'd promptly (long advisor loops
        // accumulate hundreds of KB).
        conversation = null
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      // Consumer disconnected. Abort the upstream advisor /
      // continuation fetches so the sockets tear down immediately,
      // and clear the conversation reference for GC. The outer turn
      // loop observes `aborter.signal.aborted` at the top of every
      // iteration AND after each await point, so it exits at the
      // next checkpoint without dispatching another upstream call.
      if (!aborter.signal.aborted) {
        aborter.abort(
          new Error(
            `advisor stream cancelled: ${
              reason instanceof Error ? reason.message : String(reason ?? "no reason")
            }`,
          ),
        )
      }
      conversation = null
    },
  })
}
