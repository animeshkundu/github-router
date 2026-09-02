#!/usr/bin/env bun
/**
 * Additive prompt-cache family validation tool.
 *
 * Measures provider-reported prompt cache reuse and within-model indicative cost
 * comparing shipped cache policies vs no-policy control across official billing families:
 *   - OpenAI (GPT-5.6 Luna via /responses)
 *   - Anthropic (Claude Haiku 4.5 via /v1/messages)
 *   - Google (Gemini 3.6/3.7 Flash via /chat/completions; provider-managed implicit)
 *   - xAI (Grok 4.5/4.6 via the catalog-selected endpoint; provider-managed implicit)
 *
 * Safety & Invariants:
 *   - Dry-run by default: prints candidate table, official rates, planned calls, and plan hash.
 *   - Live execution requires BOTH `--live` AND `GH_ROUTER_RUN_CACHE_PROBE=1`.
 *   - Execution aborts if the plan hash drifts from the expected plan hash.
 *   - Bounded by explicit call, token, and wall-clock caps.
 *   - Uses existing in-process service clients directly (no secondary proxy server).
 *   - Strict short output contract (max 64 output tokens, exact OK instruction, no tools).
 *   - Redacted artifacts: no prompt text, auth tokens, cache-key values, raw stderr, local paths, or session IDs.
 *   - All calculated costs are labeled INDICATIVE_UNVERIFIED; actual billing is not observed.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import consola from "consola"

import { systemPrefixCharsFor } from "~/lib/cache-probe"
import { parseBoolEnv } from "~/lib/exec"
import { PATHS } from "~/lib/paths"
import {
  applyClaudeCachePolicy,
  applyResponsesCachePolicy,
  normalizeOpenAIUsage,
  type NormalizedOpenAIUsage,
  type OpenAIUsageLike,
} from "~/lib/prompt-cache"
import { setupCopilotToken, setupGitHubToken } from "~/lib/token"
import { getModels, type Model } from "~/services/copilot/get-models"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses, type ResponsesPayload } from "~/services/copilot/create-responses"

import {
  CACHE_VALIDATION_MANIFEST,
  calculateDocumentedCost,
  classifyPairedTrialVerdict,
  computePlanHash,
  normalizeBillingFamily,
  OFFICIAL_BILLING_FAMILIES,
  OFFICIAL_COPILOT_BILLING_URL,
  sanitizeCatalogForPlan,
  sanitizeSelectionsForPlan,
  selectCheapestPerFamily,
  type CostCalculationResult,
  type DocumentedModelRate,
  type EvaluatedCandidate,
  type OfficialBillingFamily,
  type SanitizedSelectCheapestResult,
} from "./cache-validation"

// ---------------------------------------------------------------------------
// Configuration & Caps
// ---------------------------------------------------------------------------

export interface ProbeFamilyConfig {
  readonly isLive: boolean
  readonly explicitLiveCaps: boolean
  readonly parseError?: string
  readonly families: ReadonlyArray<OfficialBillingFamily>
  readonly includeTies: boolean
  readonly includeAuditCandidates: boolean
  readonly reps: number
  readonly runEdges: boolean
  readonly expectedPlanHash?: string
  readonly outputPath?: string
  readonly maxCalls: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxWallclockMs: number
  readonly callTimeoutMs: number
}

const DEFAULT_MAX_CALLS = 64
const DEFAULT_MAX_INPUT_TOKENS = 500_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const DEFAULT_MAX_WALLCLOCK_MS = 300_000 // 5 minutes
const DEFAULT_CALL_TIMEOUT_MS = 60_000 // 60 seconds
const DEFAULT_REPS = 3
const FIXED_OUTPUT_TOKENS = 64
const MIN_STABLE_PREFIX_BYTES = 4_600

/**
 * Strict integer parser: returns undefined if val is not a strictly valid positive integer.
 */
function parseStrictPositiveInt(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) return val
  if (typeof val === "string") {
    const trimmed = val.trim()
    if (/^[1-9]\d*$/.test(trimmed)) {
      const num = Number(trimmed)
      if (Number.isSafeInteger(num) && num > 0) return num
    }
  }
  return undefined
}

/**
 * Estimate input tokens for a given candidate using its provider-aware system prefix size.
 */
export function estimateCandidateInputTokens(candidateId: string): number {
  const chars = systemPrefixCharsFor(candidateId)
  // Assume ~4 chars per token, with a 1,500 token minimum floor
  return Math.max(1_500, Math.ceil(chars / 4))
}

/**
 * Parse CLI arguments and environment variables into structured configuration.
 * Validates strict positive integers and strictly recognized families.
 */
export function parseProbeArgs(
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env,
): ProbeFamilyConfig {
  let isLive = false
  let includeTies = false
  let includeAuditCandidates = false
  let runEdges = false
  let reps: number | undefined
  let families: Array<OfficialBillingFamily> = [...OFFICIAL_BILLING_FAMILIES]
  let expectedPlanHash: string | undefined =
    env.GH_ROUTER_CACHE_VALIDATION_PLAN_SHA256?.trim() || undefined
  let outputPath: string | undefined = env.GH_ROUTER_CACHE_VALIDATION_OUTPUT
  let parseError: string | undefined

  let explicitMaxCalls = false
  let explicitMaxInputTokens = false
  let explicitMaxOutputTokens = false
  let explicitMaxWallclockMs = false

  // Env parsing
  let maxCalls: number | undefined
  if (env.GH_ROUTER_CACHE_VALIDATION_MAX_CALLS !== undefined) {
    maxCalls = parseStrictPositiveInt(env.GH_ROUTER_CACHE_VALIDATION_MAX_CALLS)
    if (maxCalls === undefined) {
      parseError = `Invalid positive integer for GH_ROUTER_CACHE_VALIDATION_MAX_CALLS: "${env.GH_ROUTER_CACHE_VALIDATION_MAX_CALLS}"`
    } else {
      explicitMaxCalls = true
    }
  }

  let maxInputTokens: number | undefined
  if (env.GH_ROUTER_CACHE_VALIDATION_MAX_INPUT_TOKENS !== undefined) {
    maxInputTokens = parseStrictPositiveInt(env.GH_ROUTER_CACHE_VALIDATION_MAX_INPUT_TOKENS)
    if (maxInputTokens === undefined) {
      parseError = parseError ?? `Invalid positive integer for GH_ROUTER_CACHE_VALIDATION_MAX_INPUT_TOKENS: "${env.GH_ROUTER_CACHE_VALIDATION_MAX_INPUT_TOKENS}"`
    } else {
      explicitMaxInputTokens = true
    }
  }

  let maxOutputTokens: number | undefined
  if (env.GH_ROUTER_CACHE_VALIDATION_MAX_OUTPUT_TOKENS !== undefined) {
    maxOutputTokens = parseStrictPositiveInt(env.GH_ROUTER_CACHE_VALIDATION_MAX_OUTPUT_TOKENS)
    if (maxOutputTokens === undefined) {
      parseError = parseError ?? `Invalid positive integer for GH_ROUTER_CACHE_VALIDATION_MAX_OUTPUT_TOKENS: "${env.GH_ROUTER_CACHE_VALIDATION_MAX_OUTPUT_TOKENS}"`
    } else {
      explicitMaxOutputTokens = true
    }
  }

  let maxWallclockMs: number | undefined
  if (env.GH_ROUTER_CACHE_VALIDATION_MAX_WALLCLOCK_MS !== undefined) {
    maxWallclockMs = parseStrictPositiveInt(env.GH_ROUTER_CACHE_VALIDATION_MAX_WALLCLOCK_MS)
    if (maxWallclockMs === undefined) {
      parseError = parseError ?? `Invalid positive integer for GH_ROUTER_CACHE_VALIDATION_MAX_WALLCLOCK_MS: "${env.GH_ROUTER_CACHE_VALIDATION_MAX_WALLCLOCK_MS}"`
    } else {
      explicitMaxWallclockMs = true
    }
  }

  let callTimeoutMs: number | undefined
  if (env.GH_ROUTER_CACHE_VALIDATION_CALL_TIMEOUT_MS !== undefined) {
    callTimeoutMs = parseStrictPositiveInt(env.GH_ROUTER_CACHE_VALIDATION_CALL_TIMEOUT_MS)
    if (callTimeoutMs === undefined) {
      parseError = parseError ?? `Invalid positive integer for GH_ROUTER_CACHE_VALIDATION_CALL_TIMEOUT_MS: "${env.GH_ROUTER_CACHE_VALIDATION_CALL_TIMEOUT_MS}"`
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--live") {
      isLive = true
    } else if (arg === "--dry-run") {
      isLive = false
    } else if (arg === "--include-ties") {
      includeTies = true
    } else if (arg === "--include-audit-candidates") {
      includeAuditCandidates = true
    } else if (arg === "--edges") {
      runEdges = true
    } else if (arg === "--reps") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --reps: "${val}"`
        } else {
          reps = parsed
        }
      } else {
        parseError = parseError ?? "Missing argument for --reps"
      }
    } else if (arg === "--families") {
      if (i + 1 < argv.length) {
        const rawList = argv[++i].split(",").map((s) => s.trim())
        const parsedList: Array<OfficialBillingFamily> = []
        for (const raw of rawList) {
          const fam = normalizeBillingFamily(raw)
          if (!fam) {
            parseError = parseError ?? `Unrecognized billing family: "${raw}"`
          } else {
            parsedList.push(fam)
          }
        }
        if (parsedList.length > 0) {
          families = parsedList
        }
      } else {
        parseError = parseError ?? "Missing argument for --families"
      }
    } else if (arg === "--plan-hash") {
      if (i + 1 < argv.length) {
        const h = argv[++i]?.trim()
        expectedPlanHash = h || undefined
      } else {
        parseError = parseError ?? "Missing argument for --plan-hash"
      }
    } else if (arg === "--output") {
      if (i + 1 < argv.length) {
        outputPath = argv[++i]
      } else {
        parseError = parseError ?? "Missing argument for --output"
      }
    } else if (arg === "--max-calls") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --max-calls: "${val}"`
        } else {
          maxCalls = parsed
          explicitMaxCalls = true
        }
      } else {
        parseError = parseError ?? "Missing argument for --max-calls"
      }
    } else if (arg === "--max-input-tokens") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --max-input-tokens: "${val}"`
        } else {
          maxInputTokens = parsed
          explicitMaxInputTokens = true
        }
      } else {
        parseError = parseError ?? "Missing argument for --max-input-tokens"
      }
    } else if (arg === "--max-output-tokens") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --max-output-tokens: "${val}"`
        } else {
          maxOutputTokens = parsed
          explicitMaxOutputTokens = true
        }
      } else {
        parseError = parseError ?? "Missing argument for --max-output-tokens"
      }
    } else if (arg === "--max-wallclock-ms") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --max-wallclock-ms: "${val}"`
        } else {
          maxWallclockMs = parsed
          explicitMaxWallclockMs = true
        }
      } else {
        parseError = parseError ?? "Missing argument for --max-wallclock-ms"
      }
    } else if (arg === "--call-timeout-ms") {
      if (i + 1 < argv.length) {
        const val = argv[++i]
        const parsed = parseStrictPositiveInt(val)
        if (parsed === undefined) {
          parseError = parseError ?? `Invalid positive integer for --call-timeout-ms: "${val}"`
        } else {
          callTimeoutMs = parsed
        }
      } else {
        parseError = parseError ?? "Missing argument for --call-timeout-ms"
      }
    }
  }

  const explicitLiveCaps =
    explicitMaxCalls &&
    explicitMaxInputTokens &&
    explicitMaxOutputTokens &&
    explicitMaxWallclockMs

  return {
    isLive,
    explicitLiveCaps,
    parseError,
    families,
    includeTies,
    includeAuditCandidates,
    reps: reps ?? DEFAULT_REPS,
    runEdges,
    expectedPlanHash,
    outputPath,
    maxCalls: maxCalls ?? DEFAULT_MAX_CALLS,
    maxInputTokens: maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    maxWallclockMs: maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS,
    callTimeoutMs: callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// Deterministic Request & Prefix Construction
// ---------------------------------------------------------------------------

const STABLE_REFERENCE_BLOCK = `
# SECTION 1: SYSTEM PROTOCOL SPECIFICATION
This reference dataset contains canonical protocol definitions for distributed proxy execution.
Each transaction payload must conform to the schema specifications detailed herein.
Field definitions, type constraints, serialization requirements, and validation boundaries apply.
All endpoints adhere to deterministic idempotent request parsing and state reconciliation.
Security considerations: do not expose private keys, credential fragments, or bearer tokens.
Operational monitoring: track error rates, latency percentiles, throughput counters, and cache hits.
Network boundaries: enforce strictly authenticated channels and fail-closed security invariants.
`

/**
 * Build a deterministic stable prefix that exceeds the cache threshold (provider-aware).
 * Shared across cold and warm turns within the same arm and repetition.
 * NOTE: Omits ARM from the prefix header so that policy and control prefixes are 100% byte-identical.
 */
export function buildTrialStablePrefix(
  family: string,
  candidateId: string,
  _arm: string,
  rep: number,
  nonce: string,
  targetMinBytes?: number,
): string {
  const providerTargetChars = systemPrefixCharsFor(candidateId)
  const minBytes = targetMinBytes ?? Math.max(MIN_STABLE_PREFIX_BYTES, providerTargetChars)
  const header = `[PROMPT-CACHE-FAMILY-PROBE | FAMILY:${family} | MODEL:${candidateId} | REP:${rep} | NONCE:${nonce}]\n`
  let body = header
  while (Buffer.byteLength(body, "utf8") < minBytes) {
    body += STABLE_REFERENCE_BLOCK
  }
  return body
}

/**
 * Build deterministic user prompts for cold and warm calls.
 * Cold and warm queries share the exact same byte/character length.
 */
export function buildTrialUserPrompt(
  turnType: "cold" | "warm",
  rep: number,
): string {
  const code = turnType === "cold" ? `COLD_REP_${rep}_A100` : `WARM_REP_${rep}_B200`
  return `Request label: ${code}. The label is metadata, not a question. Output exactly OK and nothing else. Do not explain, summarize, quote, or add punctuation.`
}

// ---------------------------------------------------------------------------
// Cache Field Paths Inspection (Redacted, Path Only)
// ---------------------------------------------------------------------------

/**
 * Extracts cache-related field paths from a request body without logging values.
 */
export function findCacheFieldPaths(
  obj: unknown,
  prefix = "",
): Array<string> {
  const paths: Array<string> = []
  if (!obj || typeof obj !== "object") return paths

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const arrayPrefix = prefix.endsWith(".")
        ? `${prefix.slice(0, -1)}[${i}].`
        : `${prefix}[${i}].`
      paths.push(...findCacheFieldPaths(obj[i], arrayPrefix))
    }
    return paths
  }

  const record = obj as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const fullPath = `${prefix}${key}`
    if (
      key === "prompt_cache_breakpoint" ||
      key === "prompt_cache_key" ||
      key === "prompt_cache_options" ||
      key === "cache_control"
    ) {
      paths.push(fullPath)
    }
    if (record[key] && typeof record[key] === "object") {
      paths.push(...findCacheFieldPaths(record[key], `${fullPath}.`))
    }
  }

  return paths
}

// ---------------------------------------------------------------------------
// Fetch Instrumentation & Metadata Capture
// ---------------------------------------------------------------------------

export interface FetchCaptureMetadata {
  attemptCount: number
  paths: Array<string>
  bodySha256s: Array<string>
  bodyByteLengths: Array<number>
  cacheFieldPaths: Array<string>
  is401Refreshed: boolean
}

/**
 * Execute an asynchronous function while intercepting global fetch to capture attempt counts,
 * request SHA-256 hashes, byte lengths, and cache field paths without leaking request values.
 */
export async function executeInstrumentedCall<T>(
  fn: () => Promise<T>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ result?: T; metadata: FetchCaptureMetadata; error?: string }> {
  const originalFetch = globalThis.fetch
  const metadata: FetchCaptureMetadata = {
    attemptCount: 0,
    paths: [],
    bodySha256s: [],
    bodyByteLengths: [],
    cacheFieldPaths: [],
    is401Refreshed: false,
  }
  let saw401 = false

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const attemptIndex = metadata.attemptCount++

    let urlPath = ""
    try {
      if (typeof input === "string") {
        urlPath = new URL(input).pathname
      } else if (input instanceof URL) {
        urlPath = input.pathname
      } else if (input && typeof input === "object" && "url" in input) {
        urlPath = new URL((input as Request).url).pathname
      }
    } catch {
      urlPath = "unknown"
    }
    metadata.paths.push(urlPath)

    let bodyString = ""
    if (typeof init?.body === "string") {
      bodyString = init.body
    } else if (init?.body instanceof Uint8Array) {
      bodyString = new TextDecoder().decode(init.body)
    } else if (input instanceof Request) {
      bodyString = await input.clone().text()
    }
    if (bodyString) {
      metadata.bodyByteLengths.push(Buffer.byteLength(bodyString, "utf8"))
      metadata.bodySha256s.push(
        createHash("sha256").update(bodyString).digest("hex"),
      )
      try {
        const parsed = JSON.parse(bodyString)
        metadata.cacheFieldPaths.push(...findCacheFieldPaths(parsed))
      } catch {
        // Non-JSON body
      }
    }

    if (saw401 && attemptIndex > 0) metadata.is401Refreshed = true
    const response = await fetchImpl(input, init)
    if (response.status === 401) saw401 = true
    return response
  }) as typeof fetch

  try {
    const result = await fn()
    return { result, metadata }
  } catch (err: unknown) {
    const errName =
      err instanceof Error ? err.name || "Error" : "UnknownError"
    return { metadata, error: errName }
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// Request Construction by Endpoint
// ---------------------------------------------------------------------------

export interface ConstructedRequest {
  readonly endpointType: "messages" | "responses" | "chat"
  readonly modelId: string
  readonly payload: unknown
  readonly rawBodyString?: string
  readonly cacheFieldPaths: ReadonlyArray<string>
  readonly bodySha256: string
  readonly bodyBytes: number
}

/**
 * Constructs request payloads according to candidate endpoint and policy vs control arm.
 */
export function constructModelRequestPayload(
  candidate: EvaluatedCandidate,
  arm: "policy" | "control" | "provider-managed",
  stablePrefix: string,
  userPrompt: string,
): ConstructedRequest {
  const modelId = candidate.catalogId ?? candidate.manifestEntry.id
  const endpointType = candidate.endpoint ?? "chat"

  if (endpointType === "messages") {
    // Native Claude / Messages
    const rawObject = {
      model: modelId,
      max_tokens: FIXED_OUTPUT_TOKENS,
      system: stablePrefix,
      messages: [{ role: "user", content: userPrompt }],
    }
    let bodyString = JSON.stringify(rawObject)
    if (arm === "policy") {
      bodyString = applyClaudeCachePolicy(bodyString, {
        workload: "reusable-prefix",
      })
    }
    const parsed = JSON.parse(bodyString)
    return {
      endpointType: "messages",
      modelId,
      payload: parsed,
      rawBodyString: bodyString,
      cacheFieldPaths: findCacheFieldPaths(parsed),
      bodySha256: createHash("sha256").update(bodyString).digest("hex"),
      bodyBytes: Buffer.byteLength(bodyString, "utf8"),
    }
  }

  if (endpointType === "responses") {
    // OpenAI GPT-5.6 / Responses
    const initialPayload: ResponsesPayload = {
      model: modelId,
      instructions: stablePrefix,
      input: userPrompt,
      max_output_tokens: FIXED_OUTPUT_TOKENS,
    }
    let finalPayload = initialPayload
    if (arm === "policy") {
      finalPayload = applyResponsesCachePolicy(initialPayload, {
        workload: "reusable-prefix",
        stablePrefix,
      })
    }
    const serialized = JSON.stringify(finalPayload)
    return {
      endpointType: "responses",
      modelId,
      payload: finalPayload,
      rawBodyString: serialized,
      cacheFieldPaths: findCacheFieldPaths(finalPayload),
      bodySha256: createHash("sha256").update(serialized).digest("hex"),
      bodyBytes: Buffer.byteLength(serialized, "utf8"),
    }
  }

  // Chat completions (Gemini, Grok)
  const chatPayload = {
    model: modelId,
    messages: [
      { role: "system", content: stablePrefix },
      { role: "user", content: userPrompt },
    ],
    max_tokens: FIXED_OUTPUT_TOKENS,
  }
  const serialized = JSON.stringify(chatPayload)
  return {
    endpointType: "chat",
    modelId,
    payload: chatPayload,
    rawBodyString: serialized,
    cacheFieldPaths: findCacheFieldPaths(chatPayload),
    bodySha256: createHash("sha256").update(serialized).digest("hex"),
    bodyBytes: Buffer.byteLength(serialized, "utf8"),
  }
}

// ---------------------------------------------------------------------------
// Usage Extraction & Normalization
// ---------------------------------------------------------------------------

export interface ExtractedTurnUsage {
  readonly totalInput?: number
  readonly uncachedInput?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
  readonly reportedTotal?: number
  readonly inclusiveReconciled:
    | boolean
    | "UNAVAILABLE_OPENAI"
    | "INVALID_OPENAI"
    | "UNAVAILABLE_ANTHROPIC"
    | "INVALID_ANTHROPIC"
  readonly validMetrics: boolean
  readonly cacheMetricsPresent: boolean
  readonly cacheReadMetricsPresent: boolean
  readonly cacheWriteMetricsPresent: boolean
  readonly rawNumericUsage: Record<string, number>
}

export interface ExtractedTurnResponse {
  readonly ok: boolean
  readonly outputTextSha256: string
  readonly outputTextLength: number
  readonly outputMatchesOk: boolean
  readonly usage?: ExtractedTurnUsage
  readonly error?: string
}

type CompleteExtractedTurnUsage = ExtractedTurnUsage & {
  readonly totalInput: number
  readonly uncachedInput: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly reportedTotal?: number
  readonly inclusiveReconciled:
    | true
    | "UNAVAILABLE_ANTHROPIC"
}

function isCompleteExtractedTurnUsage(
  usage: ExtractedTurnUsage | undefined,
): usage is CompleteExtractedTurnUsage {
  return (
    usage?.validMetrics === true &&
    (usage.inclusiveReconciled === true ||
      usage.inclusiveReconciled === "UNAVAILABLE_ANTHROPIC") &&
    isValidTokenCount(usage.totalInput) &&
    isValidTokenCount(usage.uncachedInput) &&
    isValidTokenCount(usage.output) &&
    isValidTokenCount(usage.cacheRead) &&
    isValidTokenCount(usage.cacheWrite) &&
    isValidTokenCount(usage.totalTokens) &&
    (usage.reportedTotal === undefined ||
      isValidTokenCount(usage.reportedTotal))
  )
}

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

interface ReportedTokenCount {
  readonly value?: number
  readonly supplied: boolean
  readonly valid: boolean
}

/**
 * Inspect aliases for one usage counter without turning malformed input into
 * zero. A supplied invalid alias makes the metric invalid, even when another
 * alias is valid, so the probe cannot silently choose a favorable field.
 */
function inspectReportedTokenCount(
  values: ReadonlyArray<unknown>,
): ReportedTokenCount {
  let supplied = false
  let valid = true
  let zeroReported = false
  let positiveValue: number | undefined

  for (const value of values) {
    if (value === undefined) continue
    supplied = true
    if (!isValidTokenCount(value)) {
      valid = false
      continue
    }
    if (value > 0 && positiveValue === undefined) positiveValue = value
    if (value === 0) zeroReported = true
  }

  return {
    value: positiveValue ?? (zeroReported ? 0 : undefined),
    supplied,
    valid,
  }
}

/**
 * Extract response text and usage from API response JSON.
 */
export function extractUsageFromResponse(
  endpointType: "messages" | "responses" | "chat",
  responseJson: Record<string, unknown>,
): ExtractedTurnResponse {
  let outputText = ""
  const rawNumericUsage: Record<string, number> = {}

  if (endpointType === "messages") {
    // Anthropic Messages format
    if (Array.isArray(responseJson.content)) {
      for (const block of responseJson.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          outputText += (block as Record<string, unknown>).text
        }
      }
    }
    const usage = responseJson.usage as Record<string, unknown> | undefined
    const outputTextSha256 = createHash("sha256").update(outputText).digest("hex")
    const outputTextLength = outputText.length
    const outputMatchesOk = outputText.trim().toUpperCase() === "OK"

    if (!usage || typeof usage !== "object") {
      return {
        ok: true,
        outputTextSha256,
        outputTextLength,
        outputMatchesOk,
      }
    }

    const hasInput = isValidTokenCount(usage.input_tokens)
    const hasOutput = isValidTokenCount(usage.output_tokens)
    const hasCacheRead = isValidTokenCount(usage.cache_read_input_tokens)
    const hasCacheWrite = isValidTokenCount(usage.cache_creation_input_tokens)

    const cacheReadMetricsPresent = hasCacheRead
    const cacheWriteMetricsPresent = hasCacheWrite
    const cacheMetricsPresent = cacheReadMetricsPresent && cacheWriteMetricsPresent

    // Anthropic requires both input/output and both cache read & creation fields to be numeric.
    const validMetrics = hasInput && hasOutput && cacheMetricsPresent

    const inputTokens = hasInput ? (usage.input_tokens as number) : 0
    const outputTokens = hasOutput ? (usage.output_tokens as number) : 0
    const cacheRead = hasCacheRead
      ? (usage.cache_read_input_tokens as number)
      : 0
    const cacheWrite = hasCacheWrite
      ? (usage.cache_creation_input_tokens as number)
      : 0

    if (hasInput) rawNumericUsage.input_tokens = inputTokens
    if (hasOutput) rawNumericUsage.output_tokens = outputTokens
    if (hasCacheRead) rawNumericUsage.cache_read_input_tokens = cacheRead
    if (hasCacheWrite) rawNumericUsage.cache_creation_input_tokens = cacheWrite

    const totalInput = inputTokens + cacheRead + cacheWrite
    const totalTokens = totalInput + outputTokens

    return {
      ok: true,
      outputTextSha256,
      outputTextLength,
      outputMatchesOk,
      usage: {
        totalInput,
        uncachedInput: inputTokens,
        output: outputTokens,
        cacheRead: hasCacheRead ? cacheRead : undefined,
        cacheWrite: hasCacheWrite ? cacheWrite : undefined,
        totalTokens,
        inclusiveReconciled: validMetrics
          ? "UNAVAILABLE_ANTHROPIC"
          : "INVALID_ANTHROPIC",
        validMetrics,
        cacheMetricsPresent,
        cacheReadMetricsPresent,
        cacheWriteMetricsPresent,
        rawNumericUsage,
      },
    }
  }

  // Responses or Chat format
  if (endpointType === "responses") {
    if (typeof responseJson.output_text === "string") {
      outputText = responseJson.output_text
    } else if (Array.isArray(responseJson.output)) {
      for (const item of responseJson.output) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>
          if (typeof rec.text === "string") {
            outputText += rec.text
          } else if (Array.isArray(rec.content)) {
            for (const c of rec.content) {
              if (
                c &&
                typeof c === "object" &&
                (c as Record<string, unknown>).type === "output_text" &&
                typeof (c as Record<string, unknown>).text === "string"
              ) {
                outputText += (c as Record<string, unknown>).text
              } else if (
                c &&
                typeof c === "object" &&
                typeof (c as Record<string, unknown>).text === "string"
              ) {
                outputText += (c as Record<string, unknown>).text
              }
            }
          }
        }
      }
    }
  } else if (endpointType === "chat") {
    if (
      Array.isArray(responseJson.choices) &&
      responseJson.choices.length > 0 &&
      responseJson.choices[0]?.message?.content
    ) {
      outputText = String(responseJson.choices[0].message.content)
    }
  }

  const outputTextSha256 = createHash("sha256").update(outputText).digest("hex")
  const outputTextLength = outputText.length
  const outputMatchesOk = outputText.trim().toUpperCase() === "OK"

  const rawUsage = responseJson.usage as OpenAIUsageLike | undefined
  if (!rawUsage) {
    return {
      ok: true,
      outputTextSha256,
      outputTextLength,
      outputMatchesOk,
    }
  }

  // Record only finite, non-negative integer usage values.
  const whitelistedFields: ReadonlyArray<readonly [string, unknown]> = [
    ["prompt_tokens", rawUsage.prompt_tokens],
    ["input_tokens", rawUsage.input_tokens],
    ["completion_tokens", rawUsage.completion_tokens],
    ["output_tokens", rawUsage.output_tokens],
    ["total_tokens", rawUsage.total_tokens],
    ["prompt_tokens_details.cached_tokens", rawUsage.prompt_tokens_details?.cached_tokens],
    ["prompt_tokens_details.cache_write_tokens", rawUsage.prompt_tokens_details?.cache_write_tokens],
    ["input_tokens_details.cached_tokens", rawUsage.input_tokens_details?.cached_tokens],
    ["input_tokens_details.cache_write_tokens", rawUsage.input_tokens_details?.cache_write_tokens],
  ]
  for (const [field, value] of whitelistedFields) {
    if (isValidTokenCount(value)) rawNumericUsage[field] = value
  }

  const cacheRead = inspectReportedTokenCount([
    rawUsage.prompt_tokens_details?.cached_tokens,
    rawUsage.input_tokens_details?.cached_tokens,
    rawUsage.cache_read_input_tokens,
  ])
  const cacheWrite = inspectReportedTokenCount([
    rawUsage.prompt_tokens_details?.cache_write_tokens,
    rawUsage.input_tokens_details?.cache_write_tokens,
    rawUsage.cache_write_tokens,
    rawUsage.cache_creation_input_tokens,
  ])
  const input = inspectReportedTokenCount([
    rawUsage.input_tokens,
    rawUsage.prompt_tokens,
  ])
  const output = inspectReportedTokenCount([
    rawUsage.output_tokens,
    rawUsage.completion_tokens,
  ])
  const reportedTotalMetric = inspectReportedTokenCount([rawUsage.total_tokens])

  const cacheReadMetricsPresent = cacheRead.supplied && cacheRead.valid
  const cacheWriteMetricsPresent = cacheWrite.supplied && cacheWrite.valid
  const cacheMetricsPresent = cacheReadMetricsPresent && cacheWriteMetricsPresent

  const hasTotal =
    reportedTotalMetric.supplied &&
    reportedTotalMetric.valid &&
    reportedTotalMetric.value !== undefined &&
    reportedTotalMetric.value > 0
  const hasInput =
    input.supplied && input.valid && input.value !== undefined && input.value > 0
  const hasOutput =
    output.supplied && output.valid && output.value !== undefined
  const normalized: NormalizedOpenAIUsage = normalizeOpenAIUsage({
    input_tokens: input.value,
    output_tokens: output.value,
    total_tokens: reportedTotalMetric.value,
    cache_read_input_tokens: cacheRead.value,
    cache_write_tokens: cacheWrite.value,
  })
  const reportedTotal = hasTotal ? reportedTotalMetric.value : undefined
  const requiredMetrics = [
    input,
    output,
    cacheRead,
    cacheWrite,
    reportedTotalMetric,
  ]
  const hasInvalidMetric = requiredMetrics.some(
    (metric) => metric.supplied && !metric.valid,
  )
  const hasMissingMetric = requiredMetrics.some((metric) => !metric.supplied)
  const hasInvalidRequiredValue =
    (input.supplied && input.valid && !hasInput) ||
    (reportedTotalMetric.supplied && reportedTotalMetric.valid && !hasTotal)
  const normalizedForOutput = {
    ...normalized,
    cacheRead: cacheRead.value === undefined ? undefined : normalized.cacheRead,
    cacheWrite: cacheWrite.value === undefined ? undefined : normalized.cacheWrite,
  }

  // Missing provider buckets are unavailable; only malformed supplied values or
  // a complete tuple whose total diverges are invalid.
  let inclusiveReconciled: boolean | "UNAVAILABLE_OPENAI" | "INVALID_OPENAI" =
    "UNAVAILABLE_OPENAI"
  const completeUsageMetrics = hasInput && hasOutput && cacheMetricsPresent
  if (hasInvalidMetric || hasInvalidRequiredValue) {
    inclusiveReconciled = "INVALID_OPENAI"
  } else if (!hasMissingMetric && completeUsageMetrics && reportedTotal !== undefined) {
    const calculatedSum = normalized.totalInput + normalized.output
    const diff = Math.abs(reportedTotal - calculatedSum)
    inclusiveReconciled =
      diff / Math.max(1, reportedTotal) <= 0.01
        ? true
        : "INVALID_OPENAI"
  }

  const validMetrics =
    completeUsageMetrics && inclusiveReconciled === true

  // A missing cache bucket is unknown, never a measured zero.

  return {
    ok: true,
    outputTextSha256,
    outputTextLength,
    outputMatchesOk,
    usage: {
      totalInput: normalized.totalInput,
      uncachedInput: normalized.uncachedInput,
      output: normalized.output,
      cacheRead: normalizedForOutput.cacheRead,
      cacheWrite: normalizedForOutput.cacheWrite,
      totalTokens: normalized.totalTokens,
      reportedTotal,
      inclusiveReconciled,
      validMetrics,
      cacheMetricsPresent,
      cacheReadMetricsPresent,
      cacheWriteMetricsPresent,
      rawNumericUsage,
    },
  }
}

// ---------------------------------------------------------------------------
// Trial & Arm Execution Models
// ---------------------------------------------------------------------------

export interface SingleTurnResult {
  readonly turnType: "cold" | "warm"
  readonly success: boolean
  readonly attempts: number
  readonly contaminated: boolean
  readonly requestSha256: string
  readonly requestBytes: number
  readonly cacheFieldPaths: ReadonlyArray<string>
  readonly response?: ExtractedTurnResponse
  readonly cost?: CostCalculationResult
  readonly error?: string
}

export interface PairedArmResult {
  readonly arm: "policy" | "control" | "provider-managed"
  readonly cold: SingleTurnResult
  readonly warm: SingleTurnResult
  readonly valid: boolean
  readonly outputEquivalent: boolean
  readonly readHitRatio: number
  readonly coldContaminationRatio: number
  readonly pairedVerdict: "cached" | "uncached" | "inconclusive" | "regression"
  readonly indicativeCostColdUsd?: number
  readonly indicativeCostWarmUsd?: number
  readonly indicativeSavingsUsd?: number
  readonly reason: string
}

export interface CandidateRepetitionResult {
  readonly repIndex: number
  readonly arms: Record<string, PairedArmResult>
  readonly valid: boolean
  readonly policyImprovementVerdict:
    | "POLICY_IMPROVEMENT_SUPPORTED"
    | "REUSE_PROVEN_POLICY_INCONCLUSIVE"
    | "INCONCLUSIVE_BY_POLICY"
    | "NO_CACHE_REUSE"
    | "INCONCLUSIVE_DATA"
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Trial Runner
// ---------------------------------------------------------------------------

/**
 * Execute a single turn model call with instrumentation and timeout.
 */
export async function executeSingleTurn(
  candidate: EvaluatedCandidate,
  arm: "policy" | "control" | "provider-managed",
  turnType: "cold" | "warm",
  stablePrefix: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<SingleTurnResult> {
  const constructed = constructModelRequestPayload(
    candidate,
    arm,
    stablePrefix,
    userPrompt,
  )

  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)

  const { result, metadata, error } = await executeInstrumentedCall(async () => {
    if (constructed.endpointType === "messages") {
      const response = await createMessages(
        constructed.rawBodyString ?? JSON.stringify(constructed.payload),
        undefined,
        controller.signal,
        false, // No retry transient
      )
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`)
      }
      return (await response.json()) as Record<string, unknown>
    }
    if (constructed.endpointType === "responses") {
      const resp = await createResponses(
        constructed.payload as ResponsesPayload,
        undefined,
        controller.signal,
        false, // No retry transient
      )
      return resp as unknown as Record<string, unknown>
    }
    const chatResp = await createChatCompletions(
      constructed.payload as Parameters<typeof createChatCompletions>[0],
      undefined,
      controller.signal,
      false, // No retry transient
    )
    return chatResp as unknown as Record<string, unknown>
  })

  clearTimeout(timeoutTimer)

  const contaminated = metadata.attemptCount > 1 || metadata.is401Refreshed
  if (error || !result) {
    return {
      turnType,
      success: false,
      attempts: metadata.attemptCount,
      contaminated,
      requestSha256: constructed.bodySha256,
      requestBytes: constructed.bodyBytes,
      cacheFieldPaths: constructed.cacheFieldPaths,
      error: error || "NO_RESPONSE",
    }
  }

  const json = result
  const response = extractUsageFromResponse(constructed.endpointType, json)

  let cost: CostCalculationResult | undefined
  if (isCompleteExtractedTurnUsage(response.usage)) {
    cost = calculateDocumentedCost(
      {
        uncachedInputTokens: response.usage.uncachedInput,
        cachedReadTokens: response.usage.cacheRead,
        cacheWriteTokens: response.usage.cacheWrite,
        outputTokens: response.usage.output,
      },
      candidate.manifestEntry,
    )
  }

  return {
    turnType,
    success: true,
    attempts: metadata.attemptCount,
    contaminated,
    requestSha256: constructed.bodySha256,
    requestBytes: constructed.bodyBytes,
    cacheFieldPaths: constructed.cacheFieldPaths,
    response,
    cost,
  }
}

/**
 * Classify a cold + warm paired arm result.
 * Validates usage validity, output hash/length equivalence, and cold contamination ratio <= 5%.
 */
export function classifyArmTrial(
  arm: "policy" | "control" | "provider-managed",
  cold: SingleTurnResult,
  warm: SingleTurnResult,
  manifestEntry: DocumentedModelRate,
): PairedArmResult {
  const outputsEquivalent =
    cold.response?.outputMatchesOk === true &&
    warm.response?.outputMatchesOk === true &&
    cold.response?.outputTextLength === warm.response?.outputTextLength &&
    cold.response?.outputTextSha256 === warm.response?.outputTextSha256 &&
    (cold.response?.outputTextSha256.length ?? 0) > 0

  if (
    !cold.success ||
    !warm.success ||
    !cold.response?.usage ||
    !warm.response?.usage ||
    !isCompleteExtractedTurnUsage(cold.response.usage) ||
    !isCompleteExtractedTurnUsage(warm.response.usage)
  ) {
    return {
      arm,
      cold,
      warm,
      valid: false,
      outputEquivalent: outputsEquivalent,
      readHitRatio: 0,
      coldContaminationRatio: 1,
      pairedVerdict: "inconclusive",
      reason: "One or both turns failed or reported invalid/missing usage metrics",
    }
  }

  if (cold.contaminated || warm.contaminated) {
    return {
      arm,
      cold,
      warm,
      valid: false,
      outputEquivalent: false,
      readHitRatio: 0,
      coldContaminationRatio: 1,
      pairedVerdict: "inconclusive",
      reason: "Attempt contamination (>1 attempt or 401 token refresh observed)",
    }
  }

  const coldUsage = cold.response.usage
  const warmUsage = warm.response.usage

  const coldContaminationRatio =
    coldUsage.totalInput > 0
      ? coldUsage.cacheRead / coldUsage.totalInput
      : 0

  if (coldContaminationRatio > 0.05) {
    return {
      arm,
      cold,
      warm,
      valid: false,
      outputEquivalent: false,
      readHitRatio: 0,
      coldContaminationRatio,
      pairedVerdict: "inconclusive",
      reason: `Cold turn contaminated with ${(coldContaminationRatio * 100).toFixed(1)}% cache read (>5% threshold)`,
    }
  }

  const outputEquivalent =
    cold.response.outputMatchesOk &&
    warm.response.outputMatchesOk &&
    cold.response.outputTextLength === warm.response.outputTextLength &&
    cold.response.outputTextSha256 === warm.response.outputTextSha256 &&
    cold.response.outputTextSha256.length > 0

  if (!outputEquivalent) {
    return {
      arm,
      cold,
      warm,
      valid: false,
      outputEquivalent: false,
      readHitRatio: 0,
      coldContaminationRatio,
      pairedVerdict: "inconclusive",
      reason: "Cold and warm outputs failed exact OK match, length, or SHA-256 hash equivalence",
    }
  }

  const pairedVerdictRes = classifyPairedTrialVerdict(
    {
      inputTokens: coldUsage.totalInput,
      outputTokens: coldUsage.output,
      cachedReadTokens: coldUsage.cacheRead,
      cacheWriteTokens: coldUsage.cacheWrite,
    },
    {
      inputTokens: warmUsage.totalInput,
      outputTokens: warmUsage.output,
      cachedReadTokens: warmUsage.cacheRead,
      cacheWriteTokens: warmUsage.cacheWrite,
    },
    manifestEntry,
  )

  let indicativeCostColdUsd = cold.cost?.costUsd
  let indicativeCostWarmUsd = warm.cost?.costUsd

  if (indicativeCostColdUsd === undefined && isCompleteExtractedTurnUsage(cold.response?.usage)) {
    const cost = calculateDocumentedCost(
      {
        uncachedInputTokens: cold.response.usage.uncachedInput,
        cachedReadTokens: cold.response.usage.cacheRead,
        cacheWriteTokens: cold.response.usage.cacheWrite,
        outputTokens: cold.response.usage.output,
      },
      manifestEntry,
    )
    indicativeCostColdUsd = cost.costUsd
  }

  if (indicativeCostWarmUsd === undefined && isCompleteExtractedTurnUsage(warm.response?.usage)) {
    const cost = calculateDocumentedCost(
      {
        uncachedInputTokens: warm.response.usage.uncachedInput,
        cachedReadTokens: warm.response.usage.cacheRead,
        cacheWriteTokens: warm.response.usage.cacheWrite,
        outputTokens: warm.response.usage.output,
      },
      manifestEntry,
    )
    indicativeCostWarmUsd = cost.costUsd
  }

  let indicativeSavingsUsd: number | undefined
  if (
    indicativeCostColdUsd !== undefined &&
    indicativeCostWarmUsd !== undefined
  ) {
    indicativeSavingsUsd = Math.max(
      0,
      indicativeCostColdUsd - indicativeCostWarmUsd,
    )
  }

  return {
    arm,
    cold,
    warm,
    valid: true,
    outputEquivalent,
    readHitRatio: pairedVerdictRes.readHitRatio,
    coldContaminationRatio,
    pairedVerdict: pairedVerdictRes.verdict,
    indicativeCostColdUsd,
    indicativeCostWarmUsd,
    indicativeSavingsUsd,
    reason: pairedVerdictRes.reason,
  }
}

/**
 * Classifies a repetition comparing policy vs control arms.
 */
export function classifyCandidateRepetition(
  repIndex: number,
  arms: Record<string, PairedArmResult>,
  isProviderManagedOnly: boolean,
): CandidateRepetitionResult {
  if (isProviderManagedOnly) {
    const pmArm = arms["provider-managed"]
    if (!pmArm || !pmArm.valid) {
      return {
        repIndex,
        arms,
        valid: false,
        policyImprovementVerdict: "INCONCLUSIVE_DATA",
        reason: pmArm?.reason ?? "Invalid provider-managed trial",
      }
    }
    return {
      repIndex,
      arms,
      valid: true,
      policyImprovementVerdict: "INCONCLUSIVE_BY_POLICY",
      reason: `Provider-managed implicit cache observed (${(pmArm.readHitRatio * 100).toFixed(1)}% hit ratio); policy attribution is inconclusive.`,
    }
  }

  const policyArm = arms.policy
  const controlArm = arms.control

  if (!policyArm || !controlArm || !policyArm.valid || !controlArm.valid) {
    return {
      repIndex,
      arms,
      valid: false,
      policyImprovementVerdict: "INCONCLUSIVE_DATA",
      reason: "One or both arms produced invalid trials",
    }
  }

  if (policyArm.readHitRatio >= 0.8 && controlArm.readHitRatio < 0.2) {
    return {
      repIndex,
      arms,
      valid: true,
      policyImprovementVerdict: "POLICY_IMPROVEMENT_SUPPORTED",
      reason: `Policy achieved ${(policyArm.readHitRatio * 100).toFixed(1)}% cache hit vs control ${(controlArm.readHitRatio * 100).toFixed(1)}%`,
    }
  }

  if (policyArm.readHitRatio >= 0.8 && controlArm.readHitRatio >= 0.8) {
    return {
      repIndex,
      arms,
      valid: true,
      policyImprovementVerdict: "REUSE_PROVEN_POLICY_INCONCLUSIVE",
      reason: `Both policy (${(policyArm.readHitRatio * 100).toFixed(1)}%) and control (${(controlArm.readHitRatio * 100).toFixed(1)}%) achieved high reuse`,
    }
  }

  if (policyArm.readHitRatio < 0.2 && controlArm.readHitRatio < 0.2) {
    return {
      repIndex,
      arms,
      valid: true,
      policyImprovementVerdict: "NO_CACHE_REUSE",
      reason: `Neither policy nor control achieved effective cache reuse (<20%)`,
    }
  }

  return {
    repIndex,
    arms,
    valid: true,
    policyImprovementVerdict: "INCONCLUSIVE_DATA",
    reason: `Intermediate reuse ratio: policy ${(policyArm.readHitRatio * 100).toFixed(1)}% vs control ${(controlArm.readHitRatio * 100).toFixed(1)}%`,
  }
}

// ---------------------------------------------------------------------------
// Plan Artifact & Redaction
// ---------------------------------------------------------------------------

export interface SanitizedPlannedReservations {
  readonly families: ReadonlyArray<OfficialBillingFamily>
  readonly models: ReadonlyArray<string>
  readonly totalPlannedCalls: number
  readonly estimatedTotalInputTokens: number
  readonly maxOutputTokensPerCall: number
  readonly estimatedTotalOutputTokens: number
  readonly caps: {
    readonly maxCalls: number
    readonly maxInputTokens: number
    readonly maxOutputTokens: number
    readonly maxWallclockMs: number
    readonly callTimeoutMs: number
  }
}

export interface SanitizedValidationPlanArtifact {
  readonly planVersion: string
  readonly officialDocsUrl: string
  readonly officialBillingFamilies: ReadonlyArray<OfficialBillingFamily>
  readonly manifest: ReadonlyArray<DocumentedModelRate>
  readonly sanitizedCatalog: ReturnType<typeof sanitizeCatalogForPlan>
  readonly selections: SanitizedSelectCheapestResult
  readonly plannedReservations: SanitizedPlannedReservations
  readonly planHash: string
}

export function buildSanitizedPlanArtifact(
  catalog: ReadonlyArray<Model>,
  config: ProbeFamilyConfig,
): SanitizedValidationPlanArtifact {
  const selections = selectCheapestPerFamily(catalog, {
    families: config.families,
    includeTies: config.includeTies,
    includeAuditCandidates: config.includeAuditCandidates,
    validateLivePrices: true,
  })

  const sanitizedSelections = sanitizeSelectionsForPlan(selections)

  const sanitizedCatalog = sanitizeCatalogForPlan(catalog, {
    families: config.families,
  })

  const modelsToRun = selections.allSelected.map(
    (c) => c.catalogId ?? c.manifestEntry.id,
  )

  let totalPlannedCalls = 0
  let estimatedTotalInputTokens = 0

  for (const c of selections.allSelected) {
    const isExplicitPolicy =
      c.manifestEntry.family === "OpenAI" ||
      c.manifestEntry.family === "Anthropic"
    const callsPerRep = isExplicitPolicy ? 4 : 2
    let candCalls = callsPerRep * config.reps
    if (config.runEdges) {
      candCalls += 8
    }
    totalPlannedCalls += candCalls
    const estInputPerCall = estimateCandidateInputTokens(c.catalogId ?? c.manifestEntry.id)
    estimatedTotalInputTokens += candCalls * estInputPerCall
  }

  const estimatedTotalOutputTokens = totalPlannedCalls * FIXED_OUTPUT_TOKENS

  const plannedReservations: SanitizedPlannedReservations = {
    families: config.families,
    models: modelsToRun,
    totalPlannedCalls,
    estimatedTotalInputTokens,
    maxOutputTokensPerCall: FIXED_OUTPUT_TOKENS,
    estimatedTotalOutputTokens,
    caps: {
      maxCalls: config.maxCalls,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      maxWallclockMs: config.maxWallclockMs,
      callTimeoutMs: config.callTimeoutMs,
    },
  }

  const baseArtifact = {
    planVersion: "1.0",
    officialDocsUrl: OFFICIAL_COPILOT_BILLING_URL,
    officialBillingFamilies: OFFICIAL_BILLING_FAMILIES,
    manifest: CACHE_VALIDATION_MANIFEST,
    sanitizedCatalog,
    selections: sanitizedSelections,
    plannedReservations,
  }

  const planHash = computePlanHash(baseArtifact)

  return {
    ...baseArtifact,
    planHash,
  }
}

// ---------------------------------------------------------------------------
// Execution Tracker & Hard Caps Guard
// ---------------------------------------------------------------------------

export class ExecutionCapTracker {
  callCount: number = 0
  totalInputTokens: number = 0
  totalOutputTokens: number = 0
  usageUnknown: boolean = false
  capViolationReason?: string
  startTime: number = Date.now()
  config: ProbeFamilyConfig

  constructor(config: ProbeFamilyConfig) {
    this.config = config
  }

  checkBeforeCall(
    estimatedCalls = 1,
    estimatedInput = 1_500,
    estimatedOutput = 16,
  ): {
    canProceed: boolean
    reason?: string
  } {
    const reject = (reason: string) => {
      this.capViolationReason = reason
      return { canProceed: false, reason }
    }

    if (this.callCount + estimatedCalls > this.config.maxCalls) {
      return reject(`Exceeded max calls cap (${this.config.maxCalls})`)
    }
    if (
      this.totalInputTokens + estimatedInput >
      this.config.maxInputTokens
    ) {
      return reject(
        `Exceeded max input tokens cap (${this.config.maxInputTokens})`,
      )
    }
    if (
      this.totalOutputTokens + estimatedOutput >
      this.config.maxOutputTokens
    ) {
      return reject(
        `Exceeded max output tokens cap (${this.config.maxOutputTokens})`,
      )
    }
    const elapsedMs = Date.now() - this.startTime
    if (elapsedMs > this.config.maxWallclockMs) {
      return reject(
        `Exceeded max wallclock budget (${this.config.maxWallclockMs}ms)`,
      )
    }
    return { canProceed: true }
  }

  reserveEstimatedCall(
    estimatedInput: number,
    estimatedOutput: number,
  ): { hasOverrun: boolean; reason?: string } {
    this.totalInputTokens += estimatedInput
    this.totalOutputTokens += estimatedOutput
    const elapsedMs = Date.now() - this.startTime
    let reason: string | undefined
    if (this.callCount > this.config.maxCalls) {
      reason = `Estimated calls exceeded cap (${this.callCount} > ${this.config.maxCalls})`
    } else if (this.totalInputTokens > this.config.maxInputTokens) {
      reason =
        `Estimated input tokens exceeded cap (${this.totalInputTokens} > ${this.config.maxInputTokens})`
    } else if (this.totalOutputTokens > this.config.maxOutputTokens) {
      reason =
        `Estimated output tokens exceeded cap (${this.totalOutputTokens} > ${this.config.maxOutputTokens})`
    } else if (elapsedMs > this.config.maxWallclockMs) {
      reason =
        `Estimated wallclock exceeded budget (${elapsedMs}ms > ${this.config.maxWallclockMs}ms)`
    }
    if (reason !== undefined) {
      this.capViolationReason = reason
      return { hasOverrun: true, reason }
    }
    return { hasOverrun: false }
  }

  recordCall(inputTokens?: number, outputTokens?: number): { hasOverrun: boolean; reason?: string } {
    this.callCount++
    if (!isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens)) {
      this.usageUnknown = true
      return { hasOverrun: false, reason: "Usage telemetry unavailable; cap accounting remains conservative" }
    }
    this.totalInputTokens += inputTokens
    this.totalOutputTokens += outputTokens

    let reason: string | undefined
    if (this.callCount > this.config.maxCalls) {
      reason = `Actual calls exceeded cap (${this.callCount} > ${this.config.maxCalls})`
    } else if (this.totalInputTokens > this.config.maxInputTokens) {
      reason = `Actual input tokens exceeded cap (${this.totalInputTokens} > ${this.config.maxInputTokens})`
    } else if (this.totalOutputTokens > this.config.maxOutputTokens) {
      reason = `Actual output tokens exceeded cap (${this.totalOutputTokens} > ${this.config.maxOutputTokens})`
    } else {
      const elapsedMs = Date.now() - this.startTime
      if (elapsedMs > this.config.maxWallclockMs) {
        reason = `Actual wallclock exceeded budget (${elapsedMs}ms > ${this.config.maxWallclockMs}ms)`
      }
    }
    if (reason !== undefined) {
      this.capViolationReason = reason
      return { hasOverrun: true, reason }
    }
    return { hasOverrun: false }
  }

  recordTurn(
    result: SingleTurnResult,
    estimatedInput: number,
  ): { hasOverrun: boolean; reason?: string } {
    const usage = result.response?.usage
    if (isCompleteExtractedTurnUsage(usage)) {
      return this.recordCall(usage.totalInput, usage.output)
    }

    const observed = this.recordCall()
    const estimated = this.reserveEstimatedCall(
      estimatedInput,
      FIXED_OUTPUT_TOKENS,
    )
    if (estimated.hasOverrun) {
      this.capViolationReason = estimated.reason
      return estimated
    }
    return observed
  }

  get stats() {
    return {
      callCount: this.callCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      usageUnknown: this.usageUnknown,
      elapsedMs: Date.now() - this.startTime,
    }
  }
}

export interface ExecutedArmPair {
  readonly arm?: PairedArmResult
  readonly capViolationReason?: string
}

/**
 * Execute one cold/warm arm pair while enforcing caps after every turn.
 * A post-call cap overrun returns without issuing the sibling arm or any
 * further call in the current candidate run.
 */
export async function executeArmPair(
  candidate: EvaluatedCandidate,
  arm: "policy" | "control" | "provider-managed",
  rep: number,
  nonce: string,
  config: ProbeFamilyConfig,
  tracker: ExecutionCapTracker,
  executeTurn: typeof executeSingleTurn = executeSingleTurn,
): Promise<ExecutedArmPair> {
  const candidateId = candidate.catalogId ?? candidate.manifestEntry.id
  const estimatedInput = estimateCandidateInputTokens(candidateId)
  const capReason = (reason?: string): string =>
    reason ?? tracker.capViolationReason ?? "Execution cap exceeded"

  const coldCap = tracker.checkBeforeCall(
    1,
    estimatedInput,
    FIXED_OUTPUT_TOKENS,
  )
  if (!coldCap.canProceed) {
    return { capViolationReason: capReason(coldCap.reason) }
  }

  const stablePrefix = buildTrialStablePrefix(
    candidate.manifestEntry.family,
    candidateId,
    arm,
    rep,
    nonce,
  )
  const cold = await executeTurn(
    candidate,
    arm,
    "cold",
    stablePrefix,
    buildTrialUserPrompt("cold", rep),
    config.callTimeoutMs,
  )
  const coldOverrun = tracker.recordTurn(cold, estimatedInput)
  if (coldOverrun.hasOverrun) {
    return { capViolationReason: capReason(coldOverrun.reason) }
  }

  const warmCap = tracker.checkBeforeCall(
    1,
    estimatedInput,
    FIXED_OUTPUT_TOKENS,
  )
  if (!warmCap.canProceed) {
    return { capViolationReason: capReason(warmCap.reason) }
  }

  const warm = await executeTurn(
    candidate,
    arm,
    "warm",
    stablePrefix,
    buildTrialUserPrompt("warm", rep),
    config.callTimeoutMs,
  )
  const warmOverrun = tracker.recordTurn(warm, estimatedInput)
  if (warmOverrun.hasOverrun) {
    return { capViolationReason: capReason(warmOverrun.reason) }
  }

  return {
    arm: classifyArmTrial(arm, cold, warm, candidate.manifestEntry),
  }
}

// ---------------------------------------------------------------------------
// Edge Cases Execution Phase
// ---------------------------------------------------------------------------

export type EdgeCaseReasonCode =
  | "EXPECTED_SUB_THRESHOLD_GUARD"
  | "UNEXPECTED_SUB_THRESHOLD_MARKING"
  | "EXPECTED_CONVERSATION_NOOP"
  | "UNEXPECTED_CONVERSATION_MARKING"
  | "CAP_EXCEEDED"
  | "MISSING_TELEMETRY"
  | "EXPECTED_PREFIX_INVALIDATION"
  | "UNEXPECTED_PREFIX_REUSE"
  | "EXPECTED_SUFFIX_REUSE"
  | "INCONCLUSIVE_SUFFIX_REUSE"

export interface EdgeCaseTrialResult {
  readonly name:
    | "suffix-only-change"
    | "early-prefix-perturbation"
    | "sub-threshold-guard"
    | "growing-history-conversation"
  readonly success: boolean
  readonly readHitRatio?: number
  readonly verdict: "EXPECTED" | "UNEXPECTED" | "INCONCLUSIVE"
  readonly reasonCode: EdgeCaseReasonCode
  /** Free-form detail is kept in memory only and omitted from artifacts. */
  readonly note: string
}

export async function runEdgeCasesForCandidate(
  candidate: EvaluatedCandidate,
  config: ProbeFamilyConfig,
  tracker: ExecutionCapTracker,
  executeTurn: typeof executeSingleTurn = executeSingleTurn,
): Promise<Array<EdgeCaseTrialResult>> {
  const edgeResults: Array<EdgeCaseTrialResult> = []
  const modelId = candidate.catalogId ?? candidate.manifestEntry.id
  const nonce = randomBytes(4).toString("hex")
  const estInput = estimateCandidateInputTokens(modelId)

  const pushInconclusive = (
    name: EdgeCaseTrialResult["name"],
    reasonCode: EdgeCaseReasonCode,
    note: string,
  ): void => {
    edgeResults.push({
      name,
      success: false,
      verdict: "INCONCLUSIVE",
      reasonCode,
      note,
    })
  }

  const recordEdgeTurn = (
    name: EdgeCaseTrialResult["name"],
    result: SingleTurnResult,
  ): boolean => {
    const overrun = tracker.recordTurn(result, estInput)
    if (!overrun.hasOverrun) return true
    pushInconclusive(
      name,
      "CAP_EXCEEDED",
      overrun.reason ?? "Execution cap exceeded after edge-case call",
    )
    return false
  }

  // Edge 1: Sub-threshold guard (< 4096 bytes)
  {
    const subThresholdPrefix = "Short system instruction [NONCE:" + nonce + "]"
    const userPrompt = "Hello"
    const req = constructModelRequestPayload(
      candidate,
      "policy",
      subThresholdPrefix,
      userPrompt,
    )
    const hasBreakpoint = req.cacheFieldPaths.length > 0
    edgeResults.push({
      name: "sub-threshold-guard",
      success: true,
      verdict: !hasBreakpoint ? "EXPECTED" : "UNEXPECTED",
      reasonCode: !hasBreakpoint
        ? "EXPECTED_SUB_THRESHOLD_GUARD"
        : "UNEXPECTED_SUB_THRESHOLD_MARKING",
      note: !hasBreakpoint
        ? "Sub-threshold prefix correctly bypassed explicit cache marking"
        : "Sub-threshold prefix unexpectedly received cache marking",
    })
  }

  // Edge 2: Growing history conversation workload
  {
    if (candidate.endpoint === "responses") {
      const payload: ResponsesPayload = {
        model: modelId,
        instructions: "System prompt",
        input: "User query",
        max_output_tokens: FIXED_OUTPUT_TOKENS,
      }
      const policyApplied = applyResponsesCachePolicy(payload, {
        workload: "conversation",
      })
      const isUntouched =
        policyApplied.prompt_cache_key === undefined &&
        policyApplied.prompt_cache_options === undefined
      edgeResults.push({
        name: "growing-history-conversation",
        success: true,
        readHitRatio: 0,
        verdict: isUntouched ? "EXPECTED" : "UNEXPECTED",
        reasonCode: isUntouched
          ? "EXPECTED_CONVERSATION_NOOP"
          : "UNEXPECTED_CONVERSATION_MARKING",
        note: isUntouched
          ? "Conversation workload correctly bypassed explicit marking (no-op as expected)"
          : "Conversation workload unexpectedly marked with explicit breakpoint",
      })
    } else {
      edgeResults.push({
        name: "growing-history-conversation",
        success: true,
        readHitRatio: 0,
        verdict: "EXPECTED",
        reasonCode: "EXPECTED_CONVERSATION_NOOP",
        note: "Non-Responses model conversation policy verified",
      })
    }
  }

  // Edge 3: Early-prefix perturbation (Cold with Prefix A, Warm with Prefix A')
  {
    const coldCheck = tracker.checkBeforeCall(1, estInput, FIXED_OUTPUT_TOKENS)
    if (!coldCheck.canProceed) {
      pushInconclusive(
        "early-prefix-perturbation",
        "CAP_EXCEEDED",
        coldCheck.reason ?? "Cap exceeded before cold call",
      )
      return edgeResults
    } else {
      const stablePrefixA = buildTrialStablePrefix(
        candidate.manifestEntry.family,
        modelId,
        "edge-prefix-a",
        0,
        nonce,
      )
      const userPrompt = buildTrialUserPrompt("cold", 99)
      const cold = await executeTurn(
        candidate,
        "policy",
        "cold",
        stablePrefixA,
        userPrompt,
        config.callTimeoutMs,
      )
      if (!recordEdgeTurn("early-prefix-perturbation", cold)) {
        return edgeResults
      }

      const warmCheck = tracker.checkBeforeCall(1, estInput, FIXED_OUTPUT_TOKENS)
      if (!warmCheck.canProceed) {
        pushInconclusive(
          "early-prefix-perturbation",
          "CAP_EXCEEDED",
          warmCheck.reason ?? "Cap exceeded before warm call",
        )
        return edgeResults
      } else {
        const stablePrefixB =
          "MODIFIED_START_" +
          buildTrialStablePrefix(
            candidate.manifestEntry.family,
            modelId,
            "edge-prefix-b",
            0,
            nonce,
          ).slice(15)

        const warm = await executeTurn(
          candidate,
          "policy",
          "warm",
          stablePrefixB,
          userPrompt,
          config.callTimeoutMs,
        )
        if (!recordEdgeTurn("early-prefix-perturbation", warm)) {
          return edgeResults
        }

        const coldUsage = cold.response?.usage
        const warmUsage = warm.response?.usage
        const bothTurnsHaveValidMetrics =
          cold.success &&
          warm.success &&
          isCompleteExtractedTurnUsage(coldUsage) &&
          isCompleteExtractedTurnUsage(warmUsage)
        const hitRatio = bothTurnsHaveValidMetrics
          ? warmUsage.cacheRead / warmUsage.totalInput
          : undefined
        const expectedInvalidation =
          bothTurnsHaveValidMetrics && hitRatio !== undefined && hitRatio < 0.2

        edgeResults.push({
          name: "early-prefix-perturbation",
          success: bothTurnsHaveValidMetrics,
          readHitRatio: hitRatio,
          verdict: !bothTurnsHaveValidMetrics
            ? "INCONCLUSIVE"
            : expectedInvalidation
              ? "EXPECTED"
              : "UNEXPECTED",
          reasonCode: !bothTurnsHaveValidMetrics
            ? "MISSING_TELEMETRY"
            : expectedInvalidation
              ? "EXPECTED_PREFIX_INVALIDATION"
              : "UNEXPECTED_PREFIX_REUSE",
          note: !bothTurnsHaveValidMetrics
            ? "Cold or warm turn omitted valid cache telemetry; invalidation is inconclusive"
            : expectedInvalidation
              ? `Early-prefix perturbation broke cache as expected (hit ratio ${((hitRatio ?? 0) * 100).toFixed(1)}%)`
              : `Early-prefix perturbation still matched cache (${((hitRatio ?? 0) * 100).toFixed(1)}%)`,
        })
      }
    }
  }

  // Edge 4: Suffix-only change (Cold with User Prompt 1, Warm with User Prompt 2)
  {
    const coldCheck = tracker.checkBeforeCall(1, estInput, FIXED_OUTPUT_TOKENS)
    if (!coldCheck.canProceed) {
      pushInconclusive(
        "suffix-only-change",
        "CAP_EXCEEDED",
        coldCheck.reason ?? "Cap exceeded before cold call",
      )
    } else {
      const stablePrefix = buildTrialStablePrefix(
        candidate.manifestEntry.family,
        modelId,
        "edge-suffix",
        0,
        nonce,
      )
      const userPrompt1 = buildTrialUserPrompt("cold", 101)
      const cold = await executeTurn(
        candidate,
        "policy",
        "cold",
        stablePrefix,
        userPrompt1,
        config.callTimeoutMs,
      )
      if (!recordEdgeTurn("suffix-only-change", cold)) {
        return edgeResults
      }

      const warmCheck = tracker.checkBeforeCall(1, estInput, FIXED_OUTPUT_TOKENS)
      if (!warmCheck.canProceed) {
        pushInconclusive(
          "suffix-only-change",
          "CAP_EXCEEDED",
          warmCheck.reason ?? "Cap exceeded before warm call",
        )
      } else {
        const userPrompt2 = buildTrialUserPrompt("warm", 101)
        const warm = await executeTurn(
          candidate,
          "policy",
          "warm",
          stablePrefix,
          userPrompt2,
          config.callTimeoutMs,
        )
        if (!recordEdgeTurn("suffix-only-change", warm)) {
          return edgeResults
        }

        const coldUsage = cold.response?.usage
        const warmUsage = warm.response?.usage
        const bothTurnsHaveValidMetrics =
          cold.success &&
          warm.success &&
          isCompleteExtractedTurnUsage(coldUsage) &&
          isCompleteExtractedTurnUsage(warmUsage)
        const hitRatio = bothTurnsHaveValidMetrics
          ? warmUsage.cacheRead / warmUsage.totalInput
          : undefined

        edgeResults.push({
          name: "suffix-only-change",
          success: bothTurnsHaveValidMetrics,
          readHitRatio: hitRatio,
          verdict: !bothTurnsHaveValidMetrics
            ? "INCONCLUSIVE"
            : hitRatio !== undefined && hitRatio >= 0.5
              ? "EXPECTED"
              : "INCONCLUSIVE",
          reasonCode: !bothTurnsHaveValidMetrics
            ? "MISSING_TELEMETRY"
            : hitRatio !== undefined && hitRatio >= 0.5
              ? "EXPECTED_SUFFIX_REUSE"
              : "INCONCLUSIVE_SUFFIX_REUSE",
          note: !bothTurnsHaveValidMetrics
            ? "Cold or warm turn omitted valid cache telemetry; suffix reuse is inconclusive"
            : `Suffix-only modification achieved ${((hitRatio ?? 0) * 100).toFixed(1)}% cache hit ratio`,
        })
      }
    }
  }

  return edgeResults
}

// ---------------------------------------------------------------------------
// Artifact Redaction
// ---------------------------------------------------------------------------

interface SanitizedCostCalculation {
  readonly costUsd?: number
  readonly uncachedInputCostUsd?: number
  readonly cachedReadCostUsd?: number
  readonly cacheWriteCostUsd?: number
  readonly outputCostUsd?: number
  readonly inconclusive: boolean
  readonly reasonCode?: string
}

interface SanitizedTurnUsage {
  readonly totalInput?: number
  readonly uncachedInput?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
  readonly reportedTotal?: number
  readonly inclusiveReconciled: ExtractedTurnUsage["inclusiveReconciled"]
  readonly validMetrics: boolean
  readonly cacheMetricsPresent: boolean
  readonly cacheReadMetricsPresent: boolean
  readonly cacheWriteMetricsPresent: boolean
  readonly rawNumericUsage: Record<string, number>
}

interface SanitizedTurnResponse {
  readonly ok: boolean
  readonly outputTextSha256: string
  readonly outputTextLength: number
  readonly outputMatchesOk: boolean
  readonly usage?: SanitizedTurnUsage
}

interface SanitizedSingleTurnResult {
  readonly turnType: "cold" | "warm"
  readonly success: boolean
  readonly attempts?: number
  readonly contaminated: boolean
  readonly requestSha256: string
  readonly requestBytes?: number
  readonly cacheFieldPaths: ReadonlyArray<string>
  readonly response?: SanitizedTurnResponse
  readonly cost?: SanitizedCostCalculation
}

interface SanitizedPairedArmResult {
  readonly arm: PairedArmResult["arm"]
  readonly cold: SanitizedSingleTurnResult
  readonly warm: SanitizedSingleTurnResult
  readonly valid: boolean
  readonly outputEquivalent: boolean
  readonly readHitRatio?: number
  readonly coldContaminationRatio?: number
  readonly pairedVerdict: PairedArmResult["pairedVerdict"]
  readonly indicativeCostColdUsd?: number
  readonly indicativeCostWarmUsd?: number
  readonly indicativeSavingsUsd?: number
  readonly reason: string
}

interface SanitizedCandidateRepetitionResult {
  readonly repIndex: number
  readonly arms: Record<string, SanitizedPairedArmResult>
  readonly valid: boolean
  readonly policyImprovementVerdict: CandidateRepetitionResult["policyImprovementVerdict"]
  readonly reason: string
}

interface SanitizedEdgeCaseTrialResult {
  readonly name: EdgeCaseTrialResult["name"]
  readonly success: boolean
  readonly readHitRatio?: number
  readonly verdict: EdgeCaseTrialResult["verdict"]
  readonly reasonCode: EdgeCaseReasonCode
}

interface SanitizedCandidateValidationSummary {
  readonly modelId: string
  readonly status: CandidateValidationSummary["status"]
  readonly validRepetitions: number
  readonly totalRepetitions: number
  readonly meanPolicyHitRatio?: number
  readonly meanControlHitRatio?: number
  readonly meanIndicativeSavingsUsd?: number
  readonly repetitions: ReadonlyArray<SanitizedCandidateRepetitionResult>
  readonly edgeCases?: ReadonlyArray<SanitizedEdgeCaseTrialResult>
  readonly reason: string
}

interface SanitizedFamilyValidationSummary {
  readonly family: FamilyValidationSummary["family"]
  readonly modelId?: string
  readonly status: FamilyValidationSummary["status"]
  readonly validRepetitions: number
  readonly totalRepetitions: number
  readonly meanPolicyHitRatio?: number
  readonly meanControlHitRatio?: number
  readonly meanIndicativeSavingsUsd?: number
  readonly candidates?: Record<string, SanitizedCandidateValidationSummary>
  readonly repetitions: ReadonlyArray<SanitizedCandidateRepetitionResult>
  readonly edgeCases?: ReadonlyArray<SanitizedEdgeCaseTrialResult>
  readonly reason: FamilyValidationSummary["status"]
}

const SAFE_USAGE_FIELD_NAMES = new Set([
  "prompt_tokens",
  "input_tokens",
  "completion_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_write_tokens",
  "input_tokens_details.cached_tokens",
  "input_tokens_details.cache_write_tokens",
])

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function safeInteger(value: unknown): number | undefined {
  return isValidTokenCount(value) ? value : undefined
}

function sanitizeCost(
  cost: CostCalculationResult | undefined,
): SanitizedCostCalculation | undefined {
  if (!cost) return undefined
  const sanitized: SanitizedCostCalculation = {
    inconclusive: cost.inconclusive,
    ...(typeof cost.reasonCode === "string"
      ? { reasonCode: cost.reasonCode }
      : {}),
  }
  const fields: ReadonlyArray<
    readonly [keyof Omit<SanitizedCostCalculation, "inconclusive" | "reasonCode">, unknown]
  > = [
    ["costUsd", cost.costUsd],
    ["uncachedInputCostUsd", cost.uncachedInputCostUsd],
    ["cachedReadCostUsd", cost.cachedReadCostUsd],
    ["cacheWriteCostUsd", cost.cacheWriteCostUsd],
    ["outputCostUsd", cost.outputCostUsd],
  ]
  for (const [field, value] of fields) {
    const numberValue = finiteNumber(value)
    if (numberValue !== undefined) {
      Object.assign(sanitized, { [field]: numberValue })
    }
  }
  return sanitized
}

function sanitizeUsage(
  usage: ExtractedTurnUsage,
): SanitizedTurnUsage {
  const rawNumericUsage: Record<string, number> = {}
  for (const [field, value] of Object.entries(usage.rawNumericUsage)) {
    if (SAFE_USAGE_FIELD_NAMES.has(field) && isValidTokenCount(value)) {
      rawNumericUsage[field] = value
    }
  }
  const sanitized: SanitizedTurnUsage = {
    inclusiveReconciled: usage.inclusiveReconciled,
    validMetrics: usage.validMetrics,
    cacheMetricsPresent: usage.cacheMetricsPresent,
    cacheReadMetricsPresent: usage.cacheReadMetricsPresent,
    cacheWriteMetricsPresent: usage.cacheWriteMetricsPresent,
    rawNumericUsage,
  }
  const fields: ReadonlyArray<
    readonly [keyof Omit<SanitizedTurnUsage, "inclusiveReconciled" | "validMetrics" | "cacheMetricsPresent" | "cacheReadMetricsPresent" | "cacheWriteMetricsPresent" | "rawNumericUsage">, unknown]
  > = [
    ["totalInput", usage.totalInput],
    ["uncachedInput", usage.uncachedInput],
    ["output", usage.output],
    ["cacheRead", usage.cacheRead],
    ["cacheWrite", usage.cacheWrite],
    ["totalTokens", usage.totalTokens],
    ["reportedTotal", usage.reportedTotal],
  ]
  for (const [field, value] of fields) {
    const integerValue = safeInteger(value)
    if (integerValue !== undefined) {
      Object.assign(sanitized, { [field]: integerValue })
    }
  }
  return sanitized
}

function sanitizeTurnResponse(
  response: ExtractedTurnResponse,
): SanitizedTurnResponse {
  return {
    ok: response.ok,
    outputTextSha256: response.outputTextSha256,
    outputTextLength: safeInteger(response.outputTextLength) ?? 0,
    outputMatchesOk: response.outputMatchesOk,
    ...(response.usage ? { usage: sanitizeUsage(response.usage) } : {}),
  }
}

function sanitizeSingleTurn(
  result: SingleTurnResult,
): SanitizedSingleTurnResult {
  return {
    turnType: result.turnType,
    success: result.success,
    ...(safeInteger(result.attempts) !== undefined
      ? { attempts: safeInteger(result.attempts) }
      : {}),
    contaminated: result.contaminated,
    requestSha256: result.requestSha256,
    ...(safeInteger(result.requestBytes) !== undefined
      ? { requestBytes: safeInteger(result.requestBytes) }
      : {}),
    cacheFieldPaths: [...result.cacheFieldPaths],
    ...(result.response ? { response: sanitizeTurnResponse(result.response) } : {}),
    ...(result.cost ? { cost: sanitizeCost(result.cost) } : {}),
  }
}

function sanitizeArm(
  arm: PairedArmResult,
): SanitizedPairedArmResult {
  return {
    arm: arm.arm,
    cold: sanitizeSingleTurn(arm.cold),
    warm: sanitizeSingleTurn(arm.warm),
    valid: arm.valid,
    outputEquivalent: arm.outputEquivalent,
    ...(finiteNumber(arm.readHitRatio) !== undefined
      ? { readHitRatio: finiteNumber(arm.readHitRatio) }
      : {}),
    ...(finiteNumber(arm.coldContaminationRatio) !== undefined
      ? { coldContaminationRatio: finiteNumber(arm.coldContaminationRatio) }
      : {}),
    pairedVerdict: arm.pairedVerdict,
    ...(finiteNumber(arm.indicativeCostColdUsd) !== undefined
      ? { indicativeCostColdUsd: finiteNumber(arm.indicativeCostColdUsd) }
      : {}),
    ...(finiteNumber(arm.indicativeCostWarmUsd) !== undefined
      ? { indicativeCostWarmUsd: finiteNumber(arm.indicativeCostWarmUsd) }
      : {}),
    ...(finiteNumber(arm.indicativeSavingsUsd) !== undefined
      ? { indicativeSavingsUsd: finiteNumber(arm.indicativeSavingsUsd) }
      : {}),
    // Never relay free-form diagnostic text. The verdict is the stable reason code.
    reason: arm.pairedVerdict,
  }
}

function sanitizeRepetition(
  repetition: CandidateRepetitionResult,
): SanitizedCandidateRepetitionResult {
  const arms: Record<string, SanitizedPairedArmResult> = {}
  for (const [name, arm] of Object.entries(repetition.arms)) {
    if (
      name === "policy" ||
      name === "control" ||
      name === "provider-managed"
    ) {
      arms[name] = sanitizeArm(arm)
    }
  }
  return {
    repIndex: safeInteger(repetition.repIndex) ?? 0,
    arms,
    valid: repetition.valid,
    policyImprovementVerdict: repetition.policyImprovementVerdict,
    reason: repetition.policyImprovementVerdict,
  }
}

function sanitizeEdgeCase(
  edgeCase: EdgeCaseTrialResult,
): SanitizedEdgeCaseTrialResult {
  return {
    name: edgeCase.name,
    success: edgeCase.success,
    ...(edgeCase.success && finiteNumber(edgeCase.readHitRatio) !== undefined
      ? { readHitRatio: finiteNumber(edgeCase.readHitRatio) }
      : {}),
    verdict: edgeCase.verdict,
    reasonCode: edgeCase.reasonCode,
  }
}

function sanitizeCandidateSummary(
  summary: CandidateValidationSummary,
): SanitizedCandidateValidationSummary {
  return {
    modelId: summary.modelId,
    status: summary.status,
    validRepetitions: summary.validRepetitions,
    totalRepetitions: summary.totalRepetitions,
    ...(finiteNumber(summary.meanPolicyHitRatio) !== undefined
      ? { meanPolicyHitRatio: finiteNumber(summary.meanPolicyHitRatio) }
      : {}),
    ...(finiteNumber(summary.meanControlHitRatio) !== undefined
      ? { meanControlHitRatio: finiteNumber(summary.meanControlHitRatio) }
      : {}),
    ...(finiteNumber(summary.meanIndicativeSavingsUsd) !== undefined
      ? { meanIndicativeSavingsUsd: finiteNumber(summary.meanIndicativeSavingsUsd) }
      : {}),
    repetitions: summary.repetitions.map(sanitizeRepetition),
    ...(summary.edgeCases
      ? { edgeCases: summary.edgeCases.map(sanitizeEdgeCase) }
      : {}),
    reason: summary.status,
  }
}

function sanitizeFamilySummary(
  summary: FamilyValidationSummary,
): SanitizedFamilyValidationSummary {
  const candidates: Record<string, SanitizedCandidateValidationSummary> = {}
  if (summary.candidates) {
    for (const [modelId, candidate] of Object.entries(summary.candidates)) {
      candidates[modelId] = sanitizeCandidateSummary(candidate)
    }
  }
  return {
    family: summary.family,
    ...(summary.modelId ? { modelId: summary.modelId } : {}),
    status: summary.status,
    validRepetitions: summary.validRepetitions,
    totalRepetitions: summary.totalRepetitions,
    ...(finiteNumber(summary.meanPolicyHitRatio) !== undefined
      ? { meanPolicyHitRatio: finiteNumber(summary.meanPolicyHitRatio) }
      : {}),
    ...(finiteNumber(summary.meanControlHitRatio) !== undefined
      ? { meanControlHitRatio: finiteNumber(summary.meanControlHitRatio) }
      : {}),
    ...(finiteNumber(summary.meanIndicativeSavingsUsd) !== undefined
      ? { meanIndicativeSavingsUsd: finiteNumber(summary.meanIndicativeSavingsUsd) }
      : {}),
    ...(summary.candidates ? { candidates } : {}),
    repetitions: summary.repetitions.map(sanitizeRepetition),
    ...(summary.edgeCases
      ? { edgeCases: summary.edgeCases.map(sanitizeEdgeCase) }
      : {}),
    reason: summary.status,
  }
}

/**
 * Keep the final validation artifact an allowlisted evidence record. In
 * particular, never copy free-form errors, prompt text, request headers, or
 * future fields from the live turn objects into a durable artifact.
 */
export function sanitizeFamilyRollups(
  rollups: Record<string, FamilyValidationSummary>,
): Record<string, SanitizedFamilyValidationSummary> {
  const sanitized: Record<string, SanitizedFamilyValidationSummary> = {}
  for (const [family, summary] of Object.entries(rollups)) {
    if (OFFICIAL_BILLING_FAMILIES.includes(summary.family)) {
      sanitized[family] = sanitizeFamilySummary(summary)
    }
  }
  return sanitized
}

// ---------------------------------------------------------------------------
// Candidate Rollup & Main Execution
// ---------------------------------------------------------------------------

export interface CandidateValidationSummary {
  readonly modelId: string
  readonly status:
    | "VALIDATED_POLICY_IMPROVEMENT"
    | "VALIDATED_REUSE_POLICY_INCONCLUSIVE"
    | "VALIDATED_PROVIDER_MANAGED"
    | "NO_REUSE_OBSERVED"
    | "INCONCLUSIVE"
  readonly validRepetitions: number
  readonly totalRepetitions: number
  readonly meanPolicyHitRatio?: number
  readonly meanControlHitRatio?: number
  readonly meanIndicativeSavingsUsd?: number
  readonly repetitions: ReadonlyArray<CandidateRepetitionResult>
  readonly edgeCases?: ReadonlyArray<EdgeCaseTrialResult>
  readonly reason: string
}

export interface FamilyValidationSummary {
  readonly family: OfficialBillingFamily
  readonly modelId?: string
  readonly status:
    | "VALIDATED_POLICY_IMPROVEMENT"
    | "VALIDATED_REUSE_POLICY_INCONCLUSIVE"
    | "VALIDATED_PROVIDER_MANAGED"
    | "NO_REUSE_OBSERVED"
    | "SKIPPED_TIE_UNRESOLVED"
    | "SKIPPED_NO_CANDIDATE"
    | "INCONCLUSIVE"
  readonly validRepetitions: number
  readonly totalRepetitions: number
  readonly meanPolicyHitRatio?: number
  readonly meanControlHitRatio?: number
  readonly meanIndicativeSavingsUsd?: number
  readonly candidates?: Record<string, CandidateValidationSummary>
  readonly repetitions: ReadonlyArray<CandidateRepetitionResult>
  readonly edgeCases?: ReadonlyArray<EdgeCaseTrialResult>
  readonly reason: string
}

export function summarizeCandidateRollup(
  family: OfficialBillingFamily,
  modelId: string,
  repetitions: ReadonlyArray<CandidateRepetitionResult>,
  edgeCases?: ReadonlyArray<EdgeCaseTrialResult>,
): CandidateValidationSummary {
  const validReps = repetitions.filter((r) => r.valid)
  if (validReps.length === 0) {
    return {
      modelId,
      status: "INCONCLUSIVE",
      validRepetitions: 0,
      totalRepetitions: repetitions.length,
      repetitions,
      edgeCases,
      reason: "No valid repetitions completed",
    }
  }

  const isProviderManagedOnly = family === "Google" || family === "xAI"

  if (isProviderManagedOnly) {
    const providerArms = validReps
      .map((r) => r.arms["provider-managed"])
      .filter(
        (arm): arm is PairedArmResult =>
          arm !== undefined &&
          arm.valid &&
          Number.isFinite(arm.readHitRatio),
      )
    if (providerArms.length !== validReps.length) {
      return {
        modelId,
        status: "INCONCLUSIVE",
        validRepetitions: providerArms.length,
        totalRepetitions: repetitions.length,
        repetitions,
        edgeCases,
        reason: "One or more provider-managed repetitions lacked a valid cache-read metric",
      }
    }
    const hitRatios = providerArms.map((arm) => arm.readHitRatio)
    const meanHitRatio =
      hitRatios.reduce((a, b) => a + b, 0) / hitRatios.length
    const status =
      meanHitRatio >= 0.5
        ? "VALIDATED_PROVIDER_MANAGED"
        : meanHitRatio === 0
          ? "NO_REUSE_OBSERVED"
          : "INCONCLUSIVE"

    return {
      modelId,
      status,
      validRepetitions: validReps.length,
      totalRepetitions: repetitions.length,
      meanPolicyHitRatio: meanHitRatio,
      repetitions,
      edgeCases,
      reason: `Provider-managed implicit caching evaluated with ${(meanHitRatio * 100).toFixed(1)}% mean reuse`,
    }
  }

  const policyArms = validReps
    .map((r) => r.arms.policy)
    .filter(
      (arm): arm is PairedArmResult =>
        arm !== undefined &&
        arm.valid &&
        Number.isFinite(arm.readHitRatio),
    )
  const controlArms = validReps
    .map((r) => r.arms.control)
    .filter(
      (arm): arm is PairedArmResult =>
        arm !== undefined &&
        arm.valid &&
        Number.isFinite(arm.readHitRatio),
    )
  if (
    policyArms.length !== validReps.length ||
    controlArms.length !== validReps.length
  ) {
    return {
      modelId,
      status: "INCONCLUSIVE",
      validRepetitions: Math.min(policyArms.length, controlArms.length),
      totalRepetitions: repetitions.length,
      repetitions,
      edgeCases,
      reason: "One or more policy/control repetitions lacked a valid cache-read metric",
    }
  }
  const policyHitRatios = policyArms.map((arm) => arm.readHitRatio)
  const controlHitRatios = controlArms.map((arm) => arm.readHitRatio)
  const savings = validReps.map(
    (r) => r.arms.policy?.indicativeSavingsUsd,
  )
  const completeSavings = savings.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  )

  const meanPolicyHitRatio =
    policyHitRatios.reduce((a, b) => a + b, 0) / policyHitRatios.length
  const meanControlHitRatio =
    controlHitRatios.reduce((a, b) => a + b, 0) / controlHitRatios.length
  const meanIndicativeSavingsUsd =
    completeSavings.length === savings.length && completeSavings.length > 0
      ? completeSavings.reduce((a, b) => a + b, 0) / completeSavings.length
      : undefined

  const policySupportedCount = validReps.filter(
    (r) => r.policyImprovementVerdict === "POLICY_IMPROVEMENT_SUPPORTED",
  ).length
  const reuseInconclusiveCount = validReps.filter(
    (r) => r.policyImprovementVerdict === "REUSE_PROVEN_POLICY_INCONCLUSIVE",
  ).length

  let status: CandidateValidationSummary["status"] = "INCONCLUSIVE"
  if (policySupportedCount >= Math.ceil(validReps.length * (2 / 3))) {
    status = "VALIDATED_POLICY_IMPROVEMENT"
  } else if (reuseInconclusiveCount >= Math.ceil(validReps.length * (2 / 3))) {
    status = "VALIDATED_REUSE_POLICY_INCONCLUSIVE"
  } else if (meanPolicyHitRatio === 0 && meanControlHitRatio === 0) {
    status = "NO_REUSE_OBSERVED"
  }

  return {
    modelId,
    status,
    validRepetitions: validReps.length,
    totalRepetitions: repetitions.length,
    meanPolicyHitRatio,
    meanControlHitRatio,
    meanIndicativeSavingsUsd,
    repetitions,
    edgeCases,
    reason: `Evaluated across ${validReps.length}/${repetitions.length} valid repetitions: policy hit ${(meanPolicyHitRatio * 100).toFixed(1)}%, control hit ${(meanControlHitRatio * 100).toFixed(1)}%`,
  }
}

export function summarizeFamilyRollup(
  family: OfficialBillingFamily,
  selection: EvaluatedCandidate | undefined,
  repetitions: ReadonlyArray<CandidateRepetitionResult>,
  edgeCases?: ReadonlyArray<EdgeCaseTrialResult>,
  candidateSummaries?: Record<string, CandidateValidationSummary>,
): FamilyValidationSummary {
  if (!selection) {
    return {
      family,
      status: "SKIPPED_NO_CANDIDATE",
      validRepetitions: 0,
      totalRepetitions: 0,
      repetitions: [],
      reason: "No eligible candidate selected for this family",
    }
  }

  const modelId = selection.catalogId ?? selection.manifestEntry.id
  const singleCandSummary = summarizeCandidateRollup(family, modelId, repetitions, edgeCases)

  return {
    family,
    modelId,
    status: singleCandSummary.status,
    validRepetitions: singleCandSummary.validRepetitions,
    totalRepetitions: singleCandSummary.totalRepetitions,
    meanPolicyHitRatio: singleCandSummary.meanPolicyHitRatio,
    meanControlHitRatio: singleCandSummary.meanControlHitRatio,
    meanIndicativeSavingsUsd: singleCandSummary.meanIndicativeSavingsUsd,
    candidates: candidateSummaries,
    repetitions,
    edgeCases,
    reason: singleCandSummary.reason,
  }
}

// ---------------------------------------------------------------------------
// Main Orchestration Function
// ---------------------------------------------------------------------------

export async function runFamilyProbe(
  config: ProbeFamilyConfig,
): Promise<{ success: boolean; artifactPath?: string; planHash: string }> {
  // 1. Fail fast on configuration parse errors before any auth, network, or disk operations
  if (config.parseError) {
    consola.error(`[cache-family-probe] Configuration error: ${config.parseError}`)
    return { success: false, planHash: "" }
  }

  // 2. Live execution requirements before any auth, network, or disk operations
  if (config.isLive) {
    if (parseBoolEnv(process.env.GH_ROUTER_RUN_CACHE_PROBE) !== true) {
      consola.error(
        "[cache-family-probe] Live execution blocked: GH_ROUTER_RUN_CACHE_PROBE=1 must be set in environment.",
      )
      return { success: false, planHash: "" }
    }
    if (!config.explicitLiveCaps) {
      consola.error(
        "[cache-family-probe] Live execution blocked: explicit caps (--max-calls, --max-input-tokens, --max-output-tokens, --max-wallclock-ms) must all be provided.",
      )
      return { success: false, planHash: "" }
    }
    if (!config.expectedPlanHash || config.expectedPlanHash.trim().length === 0) {
      consola.error(
        "[cache-family-probe] Live execution blocked: non-empty expected plan hash (--plan-hash or GH_ROUTER_CACHE_VALIDATION_PLAN_SHA256) is required before live execution.",
      )
      return { success: false, planHash: "" }
    }
  }

  consola.info(
    `[cache-family-probe] Starting probe (mode: ${config.isLive ? "LIVE" : "DRY-RUN"})...`,
  )

  let stopRefresh: (() => void) | undefined
  let catalog: Array<Model>

  try {
    // 3. Setup tokens & fetch catalog
    try {
      await setupGitHubToken()
      stopRefresh = await setupCopilotToken()
      const modelsResponse = await getModels()
      catalog = modelsResponse.data
    } catch (err) {
      consola.error(
        `[cache-family-probe] Failed to authenticate or fetch live catalog: ${String(err)}`,
      )
      return { success: false, planHash: "" }
    }

    // 4. Build runtime selections and sanitized plan & hash
    const rawSelections = selectCheapestPerFamily(catalog, {
      families: config.families,
      includeTies: config.includeTies,
      includeAuditCandidates: config.includeAuditCandidates,
      validateLivePrices: true,
    })

    const planArtifact = buildSanitizedPlanArtifact(catalog, config)
    const computedHash = planArtifact.planHash

    consola.info(`[cache-family-probe] Computed Plan Hash: ${computedHash}`)
    consola.info(
      `[cache-family-probe] Official Documentation URL: ${OFFICIAL_COPILOT_BILLING_URL}`,
    )

    // Determine artifact output path
    const defaultDir = path.join(PATHS.APP_DIR, "cache-probe")
    if (!existsSync(defaultDir)) {
      mkdirSync(defaultDir, { recursive: true })
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const artifactPath =
      config.outputPath ??
      path.join(defaultDir, `cache-family-validation-${timestamp}.json`)

    // 5. Dry-run Mode Exit
    if (!config.isLive) {
      const dryRunOutput = {
        ...planArtifact,
        timestamp: new Date().toISOString(),
        runStatus: "DRY_RUN",
        actualBillingObserved: false,
        costClassification: "INDICATIVE_UNVERIFIED",
        limitations: [
          "Dry run only: no live API requests were issued.",
          "The nominal $100 budget is an operator safety ceiling and is not verified against live upstream billing accounts.",
          "All rates are from official documented default-tier pricing.",
        ],
      }

      try {
        writeFileSync(artifactPath, JSON.stringify(dryRunOutput, null, 2), "utf8")
        consola.success(
          `[cache-family-probe] Dry-run plan artifact written to: ${artifactPath}`,
        )
      } catch (writeErr) {
        consola.warn(
          `[cache-family-probe] Could not write plan artifact: ${String(writeErr)}`,
        )
      }

      printPlanSummary(planArtifact)
      return { success: true, artifactPath, planHash: computedHash }
    }

    // 6. Live Mode Plan Hash Drift Guard
    if (config.expectedPlanHash !== computedHash) {
      consola.error(
        `[cache-family-probe] Plan hash drift detected! Expected ${config.expectedPlanHash}, but computed ${computedHash}. Aborting before live inference.`,
      )
      return { success: false, planHash: computedHash }
    }

    // 7. Execute Live Trials across all selected candidates (including ties)
    const tracker = new ExecutionCapTracker(config)
    const familyRollups: Record<string, FamilyValidationSummary> = {}
    let hasCapViolation = false
    let terminationReason = ""

    for (const family of config.families) {
      const selectionResult = rawSelections.families[family]
      const candidatesToRun: Array<EvaluatedCandidate> =
        config.includeTies
          ? [...selectionResult?.winningCandidates ?? []]
          : selectionResult?.selected
            ? [selectionResult.selected]
            : []

      if (candidatesToRun.length === 0 || selectionResult?.status === "tie_unresolved") {
        familyRollups[family] = {
          family,
          status:
            selectionResult?.status === "tie_unresolved"
              ? "SKIPPED_TIE_UNRESOLVED"
              : "SKIPPED_NO_CANDIDATE",
          validRepetitions: 0,
          totalRepetitions: 0,
          repetitions: [],
          reason:
            selectionResult?.status === "tie_unresolved"
              ? "Unresolved tie detected; skipped unless --include-ties is specified"
              : "No eligible candidate",
        }
        continue
      }

      const isProviderManagedOnly = family === "Google" || family === "xAI"
      const candidateSummaries: Record<string, CandidateValidationSummary> = {}
      const combinedRepetitions: Array<CandidateRepetitionResult> = []
      let lastEdgeCases: Array<EdgeCaseTrialResult> | undefined

      for (const candidate of candidatesToRun) {
        const candidateId = candidate.catalogId ?? candidate.manifestEntry.id
        const repetitions: Array<CandidateRepetitionResult> = []

        for (let rep = 0; rep < config.reps; rep++) {
          const arms: Record<string, PairedArmResult> = {}

          if (isProviderManagedOnly) {
            const pair = await executeArmPair(
              candidate,
              "provider-managed",
              rep,
              randomBytes(4).toString("hex"),
              config,
              tracker,
            )
            if (pair.capViolationReason !== undefined) {
              hasCapViolation = true
              terminationReason = pair.capViolationReason
              break
            }
            if (pair.arm !== undefined) {
              arms["provider-managed"] = pair.arm
            }
          } else {
            // Counterbalance order: even reps policy-first, odd reps control-first
            const armOrder: Array<"policy" | "control"> =
              rep % 2 === 0 ? ["policy", "control"] : ["control", "policy"]

            for (const armType of armOrder) {
              const pair = await executeArmPair(
                candidate,
                armType,
                rep,
                randomBytes(4).toString("hex"),
                config,
                tracker,
              )
              if (pair.capViolationReason !== undefined) {
                hasCapViolation = true
                terminationReason = pair.capViolationReason
                break
              }
              if (pair.arm !== undefined) {
                arms[armType] = pair.arm
              }
            }
          }

          if (hasCapViolation) break

          const repResult = classifyCandidateRepetition(
            rep,
            arms,
            isProviderManagedOnly,
          )
          repetitions.push(repResult)
          combinedRepetitions.push(repResult)
        }

        // Optional Edge Cases
        let edgeCases: Array<EdgeCaseTrialResult> | undefined
        if (config.runEdges && !hasCapViolation) {
          edgeCases = await runEdgeCasesForCandidate(candidate, config, tracker)
          lastEdgeCases = edgeCases
          if (tracker.capViolationReason !== undefined) {
            hasCapViolation = true
            terminationReason = tracker.capViolationReason
          }
        }

        candidateSummaries[candidateId] = summarizeCandidateRollup(
          family,
          candidateId,
          repetitions,
          edgeCases,
        )

        if (hasCapViolation) break
      }

      familyRollups[family] = summarizeFamilyRollup(
        family,
        candidatesToRun[0],
        combinedRepetitions,
        lastEdgeCases,
        config.includeTies ? candidateSummaries : undefined,
      )

      if (hasCapViolation) break
    }

    // 8. Assemble & Write Final Redacted Artifact
    const runStatus = hasCapViolation
      ? "PARTIAL_CAP_EXCEEDED"
      : "COMPLETED"

    const finalArtifact = {
      planVersion: "1.0",
      timestamp: new Date().toISOString(),
      runStatus,
      terminationReason: hasCapViolation ? terminationReason : undefined,
      actualBillingObserved: false,
      costClassification: "INDICATIVE_UNVERIFIED",
      planHash: computedHash,
      officialDocsUrl: OFFICIAL_COPILOT_BILLING_URL,
      manifest: CACHE_VALIDATION_MANIFEST,
      selections: planArtifact.selections,
      plannedReservations: planArtifact.plannedReservations,
      familyRollups: sanitizeFamilyRollups(familyRollups),
      executionStats: tracker.stats,
      limitations: [
        "All cost calculations are INDICATIVE_UNVERIFIED and based on documented default-tier token rates from GitHub Copilot documentation. Actual invoice dollars/savings were not directly observed.",
        "The nominal $100 budget is an operator safety ceiling and is not verified against live upstream billing accounts.",
        "Comparisons are strictly within-model (policy vs control / cold vs warm). Cross-family cost rollups are not performed.",
        "Anthropic inclusive reconciliation is not provided by the upstream /v1/messages protocol.",
      ],
    }

    try {
      writeFileSync(artifactPath, JSON.stringify(finalArtifact, null, 2), "utf8")
      consola.success(
        `[cache-family-probe] Final validation artifact written to: ${artifactPath}`,
      )
    } catch (err) {
      consola.warn(
        `[cache-family-probe] Failed to write final artifact: ${String(err)}`,
      )
    }

    return {
      success: !hasCapViolation,
      artifactPath,
      planHash: computedHash,
    }
  } finally {
    if (stopRefresh) {
      try {
        stopRefresh()
      } catch {
        // Ignore disposer errors on shutdown
      }
    }
  }
}

function printPlanSummary(plan: SanitizedValidationPlanArtifact): void {
  consola.info("\n=== Cache Family Validation Plan ===")
  consola.info(`Plan Hash: ${plan.planHash}`)
  consola.info(`Official Docs: ${plan.officialDocsUrl}\n`)

  for (const family of OFFICIAL_BILLING_FAMILIES) {
    const sel = plan.selections.families[family]
    if (!sel) continue
    if ((sel.status === "selected" || sel.status === "tie") && sel.selected) {
      const entry = sel.selected.manifestEntry
      consola.info(
        `[${family}] Selected: ${entry.name} (${sel.selected.catalogId}) - Rate: $${entry.inputRatePerMillion} in / $${entry.outputRatePerMillion} out (Cached Read: $${entry.cachedInputRatePerMillion ?? "N/A"})`,
      )
    } else if (sel.status === "tie_unresolved") {
      consola.info(
        `[${family}] Unresolved Tie: ${sel.winningCandidates.map((c) => c.manifestEntry.name).join(" vs ")} (Skipped by default; use --include-ties to run)`,
      )
    } else {
      consola.info(`[${family}] Status: ${sel.status}`)
    }
  }
  consola.info(
    `\nPlanned Calls: ${plan.plannedReservations.totalPlannedCalls} | Est. Input Tokens: ${plan.plannedReservations.estimatedTotalInputTokens}`,
  )
}

// ---------------------------------------------------------------------------
// CLI Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = parseProbeArgs(process.argv.slice(2))
  runFamilyProbe(config)
    .then(({ success }) => {
      if (!success) {
        process.exit(1)
      }
    })
    .catch((err) => {
      consola.error(`[cache-family-probe] Fatal error: ${String(err)}`)
      process.exit(1)
    })
}
