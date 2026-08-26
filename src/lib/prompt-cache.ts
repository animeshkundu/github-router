import { createHash } from "node:crypto"

import consola from "consola"

import { parseBoolEnv } from "~/lib/exec"
import type {
  ResponsesInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

export type CacheWorkload =
  | "conversation"
  | "reusable-prefix"
  | "one-shot"
  | "passthrough"

interface OpenAIUsageDetails {
  cached_tokens?: unknown
  cache_write_tokens?: unknown
  cache_creation_tokens?: unknown
  cache_ttl_seconds?: unknown
}

export interface OpenAIUsageLike {
  prompt_tokens?: unknown
  input_tokens?: unknown
  completion_tokens?: unknown
  output_tokens?: unknown
  total_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  cache_write_tokens?: unknown
  cache_ttl_seconds?: unknown
  prompt_tokens_details?: OpenAIUsageDetails
  input_tokens_details?: OpenAIUsageDetails
}

export interface NormalizedOpenAIUsage {
  totalInput: number
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cacheTtlSeconds?: number
}

export interface ResponsesCachePolicyOptions {
  workload: CacheWorkload
  stablePrefix?: string
  scope?: string
}

export interface ClaudeCachePolicyOptions {
  workload: CacheWorkload
  /** Optional long-lived cache marker TTL; omitted keeps Copilot's default 5m TTL. */
  ttl?: "1h"
}

/**
 * Conservative eligibility floor, in UTF-8 BYTES — never `.length`, which
 * counts UTF-16 code units and undercounts anything outside the BMP (an
 * emoji is 2 code units but 4 bytes). This is a proxy for "the prefix is
 * obviously large enough that marking it as a cache breakpoint is worth one
 * of the scarce marker slots," and it deliberately does NOT claim to be a
 * token count: byte-to-token density varies by tokenizer and content — CJK
 * text carries MORE tokens per byte than ASCII prose (undercounting risk is
 * the SAFE direction: we'd skip a marker that might have qualified), while a
 * long run of a repeated character or repeated whitespace carries FEWER
 * tokens per byte than either, since BPE merges long runs into very few
 * tokens (overcounting risk: a byte count clearing the floor doesn't
 * guarantee the real token count clears Anthropic's or Copilot's per-model
 * minimum). No fixed byte threshold can bound that adversarial case; this
 * value is chosen so ordinary Claude Code system prompts and tool schemas
 * (natural-language / JSON, not deliberately repetitive) reliably qualify,
 * while genuinely small prefixes never burn a marker for no benefit.
 */
const MIN_CACHEABLE_PREFIX_BYTES = 4096
const CACHE_KEY_NAMESPACE = "ghr-cache-v1"
const CACHE_DIAGNOSTIC_LIMIT = 128
const GPT56_EXPLICIT_CACHE_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
])
const priorSignatures = new Map<string, CacheSignature>()

interface CacheSignature {
  system: string
  tools: string
  messages: string
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

/**
 * Pick the first genuinely POSITIVE numeric candidate from an ordered,
 * priority-ranked list of usage-shape fields. `??`-chaining these fields is
 * wrong: it stops at the first field that is merely PRESENT, and a provider
 * surface that always populates a nested detail object with `0` as a
 * placeholder (while the real, positive count is reported only in a
 * lower-priority field, e.g. the top-level one) would have its explicit zero
 * silently shadow that populated count. Falling through zeros to find a real
 * positive value fixes that; when every candidate is zero, absent, or
 * non-numeric, this returns `0` — a genuine all-zero reading, never
 * `undefined` — so downstream `nonNegativeInt` always has a countable value.
 */
function firstPositive(...candidates: ReadonlyArray<unknown>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c
  }
  return 0
}

function usageDetails(usage: OpenAIUsageLike): OpenAIUsageDetails {
  const input = usage.input_tokens_details ?? {}
  const prompt = usage.prompt_tokens_details ?? {}
  return {
    cached_tokens: firstPositive(
      input.cached_tokens,
      prompt.cached_tokens,
      usage.cache_read_input_tokens,
    ),
    cache_write_tokens: firstPositive(
      input.cache_write_tokens,
      input.cache_creation_tokens,
      prompt.cache_write_tokens,
      prompt.cache_creation_tokens,
      usage.cache_write_tokens,
      usage.cache_creation_input_tokens,
    ),
    cache_ttl_seconds: firstPositive(
      input.cache_ttl_seconds,
      prompt.cache_ttl_seconds,
      usage.cache_ttl_seconds,
    ),
  }
}

/**
 * OpenAI totals INCLUDE cached and cache-write tokens. Normalize them into
 * mutually exclusive buckets so Anthropic and Pi consumers do not count the
 * same input twice.
 */
export function normalizeOpenAIUsage(
  usage: OpenAIUsageLike | undefined,
): NormalizedOpenAIUsage {
  if (!usage) {
    return {
      totalInput: 0,
      uncachedInput: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    }
  }

  const totalInput = nonNegativeInt(usage.input_tokens ?? usage.prompt_tokens)
  const output = nonNegativeInt(usage.output_tokens ?? usage.completion_tokens)
  const details = usageDetails(usage)
  const cacheRead = Math.min(totalInput, nonNegativeInt(details.cached_tokens))
  const remaining = Math.max(0, totalInput - cacheRead)
  const cacheWrite = Math.min(
    remaining,
    nonNegativeInt(
      details.cache_write_tokens ?? details.cache_creation_tokens,
    ),
  )
  const uncachedInput = Math.max(0, totalInput - cacheRead - cacheWrite)
  const reportedTotal = nonNegativeInt(usage.total_tokens)
  const cacheTtlSeconds = nonNegativeInt(details.cache_ttl_seconds)

  return {
    totalInput,
    uncachedInput,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Math.max(reportedTotal, totalInput + output),
    ...(cacheTtlSeconds > 0 ? { cacheTtlSeconds } : {}),
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function signatureFor(value: unknown): string {
  return hash(typeof value === "string" ? value : JSON.stringify(value ?? null))
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value ?? null),
  )
}

function logCacheSignature(args: {
  endpoint: string
  model: string
  workload: CacheWorkload
  system: unknown
  tools: unknown
  messages: unknown
}): void {
  if (parseBoolEnv(process.env.GH_ROUTER_LOG_CACHE) !== true) return

  const key = `${args.endpoint}:${args.model}:${args.workload}`
  const current: CacheSignature = {
    system: signatureFor(args.system),
    tools: signatureFor(args.tools),
    messages: signatureFor(args.messages),
  }
  const previous = priorSignatures.get(key)
  let changed = "cold"
  if (previous) {
    changed =
      previous.system !== current.system ? "system"
      : previous.tools !== current.tools ? "tools"
      : previous.messages !== current.messages ? "messages"
      : "none"
  }
  priorSignatures.set(key, current)
  if (priorSignatures.size > CACHE_DIAGNOSTIC_LIMIT) {
    const oldest = priorSignatures.keys().next().value
    if (oldest !== undefined) priorSignatures.delete(oldest)
  }

  consola.info(
    `cache-signature endpoint=${args.endpoint} model=${args.model} workload=${args.workload} changed=${changed}`
      + ` system_bytes=${serializedBytes(args.system ?? "")}`
      + ` tools_bytes=${serializedBytes(args.tools ?? [])}`
      + ` messages_bytes=${serializedBytes(args.messages ?? [])}`,
  )
}

function hasResponsesBreakpoint(input: ResponsesPayload["input"]): boolean {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false
    if (Array.isArray(value)) return value.some(visit)
    const record = value as Record<string, unknown>
    return (
      record.prompt_cache_breakpoint !== undefined
      || Object.values(record).some(visit)
    )
  }
  return visit(input)
}

function gpt56ExplicitCacheEnabled(model: string): boolean {
  if (
    parseBoolEnv(process.env.GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE) === true
  ) {
    return false
  }
  return GPT56_EXPLICIT_CACHE_MODELS.has(model)
}

function responsesCacheKey(
  payload: ResponsesPayload,
  opts: ResponsesCachePolicyOptions,
  stablePrefix: string,
): string {
  const digest = hash(
    JSON.stringify({
      namespace: CACHE_KEY_NAMESPACE,
      model: payload.model,
      workload: opts.workload,
      scope: opts.scope ?? "",
      stablePrefix,
      tools: payload.tools ?? [],
    }),
  )
  return `${CACHE_KEY_NAMESPACE}-${digest.slice(0, 48)}`
}

/**
 * Add GPT-5.6 explicit caching only to router-owned REUSABLE-PREFIX payloads.
 * Public passthrough routes never call this helper, and existing caller
 * fields always win. Live shape acceptance is pinned by compatibility probe
 * `gpt56_explicit_cache_breakpoint`.
 *
 * **`"conversation"` is deliberately EXCLUDED and left untouched (a no-op),
 * same as `"passthrough"`/`"one-shot"`.** A live-verified regression: on a
 * growing multi-turn conversation (Claude Code's translated main loop and
 * the worker-agent loop, both of which pass `workload: "conversation"`),
 * marking only the stable SYSTEM block with an explicit breakpoint measured
 * substantially worse than leaving caching provider-managed and implicit.
 * Explicit mode is a distinct
 * caching strategy from Copilot's provider-managed automatic caching, not an
 * addition to it — turning it on for a request marks only the bytes an
 * explicit breakpoint names, and the REST of that request's prefix (here,
 * the entire un-marked growing message history) stops receiving automatic
 * prefix-growth caching too. Measured on `gpt-5.6-sol` with explicit mode
 * force-enabled for conversation workloads: turn 1 (cold)
 * `input_tokens=27038, cache_write=2031, cache_read=0`; turn 2
 * `input_tokens=27054, cache_read=2031`; turn 3 `input_tokens=27071,
 * cache_read=2031` — the ~2k-token system block cached once and never grew,
 * while the other ~25k tokens of accumulating history were recomputed from
 * scratch on every single turn. `"reusable-prefix"` calls (peer/advisor/
 * worker-tool/browser-compressor prefixes reused verbatim across many
 * DISCRETE calls, never a single request whose own history keeps growing)
 * do not have this failure mode and keep the explicit treatment below.
 */
export function applyResponsesCachePolicy(
  payload: ResponsesPayload,
  opts: ResponsesCachePolicyOptions,
): ResponsesPayload {
  logCacheSignature({
    endpoint: "/responses",
    model: payload.model,
    workload: opts.workload,
    system: opts.stablePrefix ?? payload.instructions,
    tools: payload.tools,
    messages: payload.input,
  })

  if (
    opts.workload !== "reusable-prefix"
    || !gpt56ExplicitCacheEnabled(payload.model)
    || payload.prompt_cache_key !== undefined
    || payload.prompt_cache_options !== undefined
    || hasResponsesBreakpoint(payload.input)
  ) {
    return payload
  }

  const stablePrefix = opts.stablePrefix ?? payload.instructions
  // True UTF-8 bytes, not `.length` (which is UTF-16 code units) — see
  // `MIN_CACHEABLE_PREFIX_BYTES`.
  const stableBytes =
    serializedBytes(stablePrefix ?? "") + serializedBytes(payload.tools ?? [])
  if (!stablePrefix || stableBytes < MIN_CACHEABLE_PREFIX_BYTES) return payload

  const input: Array<ResponsesInputItem> =
    typeof payload.input === "string"
      ? [{ role: "user", content: payload.input }]
      : [...payload.input]
  const stableContent = [{
    type: "input_text",
    text: stablePrefix,
    prompt_cache_breakpoint: { mode: "explicit" },
  }]

  let nextInput: Array<ResponsesInputItem>
  let removeInstructions = false
  if (payload.instructions === stablePrefix) {
    nextInput = [{ role: "system", content: stableContent }, ...input]
    removeInstructions = true
  } else {
    const stableSystemIndex = input.findIndex(
      (item) => item.role === "system" && item.content === stablePrefix,
    )
    if (stableSystemIndex < 0) return payload
    nextInput = [...input]
    nextInput[stableSystemIndex] = {
      ...nextInput[stableSystemIndex],
      content: stableContent,
    }
  }

  const next: ResponsesPayload = {
    ...payload,
    input: nextInput,
    prompt_cache_key: responsesCacheKey(payload, opts, stablePrefix),
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  }
  if (removeInstructions) delete next.instructions
  return next
}

type AnyRecord = Record<string, unknown>

function itemHasCacheControl(value: unknown): boolean {
  return (
    !!value
    && typeof value === "object"
    && (value as AnyRecord).cache_control !== undefined
  )
}

function hasClaudeCacheControl(body: AnyRecord): boolean {
  if (itemHasCacheControl(body.system)) return true
  if (Array.isArray(body.system) && body.system.some(itemHasCacheControl)) {
    return true
  }
  if (Array.isArray(body.tools) && body.tools.some(itemHasCacheControl)) {
    return true
  }
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!message || typeof message !== "object") return false
    const content = (message as AnyRecord).content
    return itemHasCacheControl(content)
      || (Array.isArray(content) && content.some(itemHasCacheControl))
  })
}

/**
 * UTF-8 byte length of the tools array alone — the eligibility floor for the
 * TOOL breakpoint. Marked on the last non-deferred tool, it caches only the
 * tools prefix (Claude's wire order is tools, then system, then messages), so
 * its own size — not the combined system+tools size — is what determines
 * whether that marker is worth spending. See `MIN_CACHEABLE_PREFIX_BYTES`.
 */
function claudeToolsPrefixBytes(body: AnyRecord): number {
  return serializedBytes(body.tools ?? [])
}

/**
 * UTF-8 byte length of tools + system combined — the eligibility floor for
 * the SYSTEM breakpoint. Marked on the last system text block, it caches
 * everything up to and including system (tools THEN system in wire order),
 * so the combined size is the right measure — checked SEPARATELY from the
 * tools-only floor above so a large system prompt behind tiny tools doesn't
 * smuggle a useless tools-only marker in under the combined total, and a
 * large tools array behind an empty system doesn't get double-counted as
 * "small" just because system alone is tiny.
 */
function claudeSystemPrefixBytes(body: AnyRecord): number {
  return claudeToolsPrefixBytes(body) + serializedBytes(body.system ?? "")
}

function claudeCacheControl(ttl?: "1h"): { type: "ephemeral"; ttl?: "1h" } {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" }
}

function markClaudeSystem(body: AnyRecord, ttl?: "1h"): boolean {
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = [{
      type: "text",
      text: body.system,
      cache_control: claudeCacheControl(ttl),
    }]
    return true
  }
  if (!Array.isArray(body.system)) return false
  for (let index = body.system.length - 1; index >= 0; index--) {
    const block = body.system[index]
    if (
      block
      && typeof block === "object"
      && (block as AnyRecord).type === "text"
      && typeof (block as AnyRecord).text === "string"
    ) {
      body.system[index] = {
        ...(block as AnyRecord),
        cache_control: claudeCacheControl(ttl),
      }
      return true
    }
  }
  return false
}

function markClaudeTool(body: AnyRecord, ttl?: "1h"): boolean {
  if (!Array.isArray(body.tools)) return false
  for (let index = body.tools.length - 1; index >= 0; index--) {
    const tool = body.tools[index]
    if (
      tool
      && typeof tool === "object"
      && (tool as AnyRecord).defer_loading !== true
    ) {
      body.tools[index] = {
        ...(tool as AnyRecord),
        cache_control: claudeCacheControl(ttl),
      }
      return true
    }
  }
  return false
}

/**
 * Apply the bounded Claude anchor policy to router-generated Messages bodies.
 * Caller-owned marker layouts are returned byte-for-byte unchanged.
 *
 * Marks at most TWO breakpoints — the last non-deferred tool and the stable
 * system boundary — each gated on its OWN eligibility check
 * (`claudeToolsPrefixBytes` / `claudeSystemPrefixBytes`) rather than one
 * combined check, so a large system prompt behind tiny tools doesn't also
 * mark a tools breakpoint too small to be worth a marker slot, and vice
 * versa. Anthropic's own hard ceiling is FOUR `cache_control` blocks per
 * request (probe `cache_control_marker_limit_5`); this policy only ever
 * spends up to two of them (`hasClaudeCacheControl` already refuses to run
 * at all once the caller has marked anything itself, so the two never
 * combine with a caller-owned marker to approach that ceiling).
 *
 * There used to be a third, message-level marking path gated on
 * `opts.workload === "conversation"`. It was removed as dead code: every
 * production call site of this function (`src/routes/mcp/handler.ts`,
 * `src/services/advisor/advisor.ts`) passes `workload: "reusable-prefix"`,
 * so the per-message branch never ran outside its own unit test, which gave
 * false confidence that production traffic exercised it. `CacheWorkload`
 * keeps `"conversation"` as a shared enum value — the Responses-side policy,
 * which has no per-message logic of its own, still uses it — so passing it
 * here remains type-valid; it now behaves identically to
 * `"reusable-prefix"`.
 */
export function applyClaudeCachePolicy(
  rawBody: string,
  opts: ClaudeCachePolicyOptions,
): string {
  if (
    opts.workload === "passthrough"
    || opts.workload === "one-shot"
    || parseBoolEnv(process.env.GH_ROUTER_DISABLE_CLAUDE_CACHE_POLICY) === true
  ) {
    return rawBody
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return rawBody
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody
  }
  const body = parsed as AnyRecord
  if (
    typeof body.model !== "string"
    || !body.model.startsWith("claude-")
    || hasClaudeCacheControl(body)
  ) {
    return rawBody
  }

  const toolsEligible =
    claudeToolsPrefixBytes(body) >= MIN_CACHEABLE_PREFIX_BYTES
  const systemEligible =
    claudeSystemPrefixBytes(body) >= MIN_CACHEABLE_PREFIX_BYTES
  if (!toolsEligible && !systemEligible) return rawBody

  let markers = 0
  if (toolsEligible && markClaudeTool(body, opts.ttl)) markers++
  if (systemEligible && markClaudeSystem(body, opts.ttl)) markers++

  if (markers === 0) return rawBody
  logCacheSignature({
    endpoint: "/messages",
    model: body.model,
    workload: opts.workload,
    system: body.system,
    tools: body.tools,
    messages: body.messages,
  })
  return JSON.stringify(body)
}
