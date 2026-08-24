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
}

const MIN_CACHEABLE_PREFIX_CHARS = 4096
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

function usageDetails(usage: OpenAIUsageLike): OpenAIUsageDetails {
  const input = usage.input_tokens_details ?? {}
  const prompt = usage.prompt_tokens_details ?? {}
  return {
    cached_tokens:
      input.cached_tokens
      ?? prompt.cached_tokens
      ?? usage.cache_read_input_tokens,
    cache_write_tokens:
      input.cache_write_tokens
      ?? input.cache_creation_tokens
      ?? prompt.cache_write_tokens
      ?? prompt.cache_creation_tokens
      ?? usage.cache_write_tokens
      ?? usage.cache_creation_input_tokens,
    cache_ttl_seconds:
      input.cache_ttl_seconds
      ?? prompt.cache_ttl_seconds
      ?? usage.cache_ttl_seconds,
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
 * Add GPT-5.6 explicit caching only to router-owned payloads. Public
 * passthrough routes never call this helper, and existing caller fields always
 * win. Live shape acceptance is pinned by compatibility probe
 * `gpt56_explicit_cache_breakpoint`.
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
    opts.workload === "passthrough"
    || opts.workload === "one-shot"
    || !gpt56ExplicitCacheEnabled(payload.model)
    || payload.prompt_cache_key !== undefined
    || payload.prompt_cache_options !== undefined
    || hasResponsesBreakpoint(payload.input)
  ) {
    return payload
  }

  const stablePrefix = opts.stablePrefix ?? payload.instructions
  const stableBytes =
    (stablePrefix?.length ?? 0) + JSON.stringify(payload.tools ?? []).length
  if (!stablePrefix || stableBytes < MIN_CACHEABLE_PREFIX_CHARS) return payload

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

function stableClaudePrefixChars(body: AnyRecord): number {
  return (
    JSON.stringify(body.system ?? "").length
    + JSON.stringify(body.tools ?? []).length
  )
}

function markClaudeSystem(body: AnyRecord): boolean {
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = [{
      type: "text",
      text: body.system,
      cache_control: { type: "ephemeral" },
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
        cache_control: { type: "ephemeral" },
      }
      return true
    }
  }
  return false
}

function markClaudeTool(body: AnyRecord): boolean {
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
        cache_control: { type: "ephemeral" },
      }
      return true
    }
  }
  return false
}

function markClaudeMessage(message: AnyRecord): boolean {
  if (typeof message.content === "string" && message.content.length > 0) {
    message.content = [{
      type: "text",
      text: message.content,
      cache_control: { type: "ephemeral" },
    }]
    return true
  }
  if (!Array.isArray(message.content)) return false
  if (
    message.content.some(
      (block) =>
        block
        && typeof block === "object"
        && ((block as AnyRecord).type === "thinking"
          || (block as AnyRecord).type === "redacted_thinking"),
    )
  ) {
    return false
  }
  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index]
    if (
      block
      && typeof block === "object"
      && ((block as AnyRecord).type === "text"
        || (block as AnyRecord).type === "tool_result")
    ) {
      message.content[index] = {
        ...(block as AnyRecord),
        cache_control: { type: "ephemeral" },
      }
      return true
    }
  }
  return false
}

/**
 * Apply the bounded Claude anchor policy to router-generated Messages bodies.
 * Caller-owned marker layouts are returned byte-for-byte unchanged. The
 * upstream four-marker ceiling is pinned by
 * `cache_control_marker_limit_5`.
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

  let body: AnyRecord
  try {
    body = JSON.parse(rawBody) as AnyRecord
  } catch {
    return rawBody
  }
  if (
    typeof body.model !== "string"
    || !body.model.startsWith("claude-")
    || hasClaudeCacheControl(body)
    || stableClaudePrefixChars(body) < MIN_CACHEABLE_PREFIX_CHARS
  ) {
    return rawBody
  }

  let markers = 0
  if (markClaudeTool(body)) markers++
  if (markers < 4 && markClaudeSystem(body)) markers++

  if (opts.workload === "conversation" && Array.isArray(body.messages)) {
    for (
      let index = body.messages.length - 1;
      index >= 0 && markers < 4;
      index--
    ) {
      const message = body.messages[index]
      if (
        message
        && typeof message === "object"
        && markClaudeMessage(message as AnyRecord)
      ) {
        markers++
      }
    }
  }

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
