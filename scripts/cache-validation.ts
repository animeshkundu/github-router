/**
 * Pure prompt-cache validation, cost calculation, and model catalog evaluation module.
 *
 * Implements deterministic validation, default-tier candidate ranking,
 * live catalog eligibility checks, plan hashing, documented cost calculation,
 * deterministic prompt metadata construction, and paired verdict classification
 * against official GitHub Copilot billing families and documented model rates.
 *
 * Authority:
 *   Official Copilot billing families: OpenAI, Anthropic, Google, xAI.
 *   Documented default-tier candidate manifest is the authoritative rate source.
 *   Live catalog ordinary prices are used ONLY for mismatch warnings.
 *   No fallback token prices and no cache prices are used.
 *
 * This module is 100% pure: no state, no network, and no I/O.
 */

import { createHash } from "node:crypto"

import type { Model } from "~/services/copilot/get-models"

// ---------------------------------------------------------------------------
// Constants & Documentation
// ---------------------------------------------------------------------------

/**
 * Official documentation URL for GitHub Copilot model pricing and families.
 */
export const OFFICIAL_COPILOT_BILLING_URL =
  "https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-billing/models-and-pricing"

/**
 * Official GitHub Copilot billing families supported for cache validation.
 */
export const OFFICIAL_BILLING_FAMILIES = Object.freeze([
  "OpenAI",
  "Anthropic",
  "Google",
  "xAI",
] as const)

export type OfficialBillingFamily = (typeof OFFICIAL_BILLING_FAMILIES)[number]

/**
 * Scaling factors for live Copilot catalog token_prices conversion.
 * Copilot token_prices are scaled by 1e9 per batch_size tokens.
 */
const CATALOG_PRICE_SCALE = 1_000_000_000
const TOKENS_PER_MILLION = 1_000_000

// ---------------------------------------------------------------------------
// Documented Candidate & Rate Manifest
// ---------------------------------------------------------------------------

/**
 * Documented default-tier candidate model metadata and rates in USD per million tokens.
 * Cached input and write rates are metadata for cost calculations, NOT candidate selection.
 */
export interface DocumentedModelRate {
  /** Canonical identifier in the manifest. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** Official Copilot billing family. */
  readonly family: OfficialBillingFamily
  /** Documented default-tier ordinary input rate in USD per million tokens. */
  readonly inputRatePerMillion: number
  /** Documented default-tier ordinary output rate in USD per million tokens. */
  readonly outputRatePerMillion: number
  /** Documented default-tier cached input read rate in USD per million tokens (if available). */
  readonly cachedInputRatePerMillion?: number
  /** Documented default-tier cache write rate in USD per million tokens (undefined where write is free or omitted). */
  readonly cacheWriteRatePerMillion?: number
  /** Exact catalog IDs and aliases recognized for this candidate (no fuzzy match). */
  readonly aliases: ReadonlyArray<string>
  /** Audit-only candidate flag if applicable. */
  readonly auditOnly?: boolean
}

/**
 * Checked-in authoritative default-tier candidate manifest.
 *
 * Rates (USD per million tokens):
 * - OpenAI:
 *     - GPT-5.6 Luna: $0.20 input / $1.20 output / $0.02 cached read / $0.25 cache write
 *     - GPT-5.4 Nano: $0.20 input / $1.25 output / $0.02 cached read / $0.25 cache write (Luna wins output tie)
 * - Anthropic:
 *     - Claude Haiku 4.5: $1.00 input / $5.00 output / $0.10 cached read / $1.25 cache write (aliases: claude-haiku-4.5, claude-haiku-4-5)
 * - Google:
 *     - Gemini 3.6 Flash: $0.075 input / $0.375 output / $0.01875 cached read / undefined cache write (tie)
 *     - Gemini 3.7 Flash: $0.075 input / $0.375 output / $0.01875 cached read / undefined cache write (tie)
 * - xAI:
 *     - Grok 4.5: $0.20 input / $0.60 output / $0.05 cached read / undefined cache write (tie)
 *     - Grok 4.6: $0.20 input / $0.60 output / $0.05 cached read / undefined cache write (tie)
 */
export const CACHE_VALIDATION_MANIFEST: ReadonlyArray<DocumentedModelRate> = Object.freeze([
  // OpenAI
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    family: "OpenAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 1.20,
    cachedInputRatePerMillion: 0.02,
    cacheWriteRatePerMillion: 0.25,
    aliases: Object.freeze(["gpt-5.6-luna"]),
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    family: "OpenAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 1.25,
    cachedInputRatePerMillion: 0.02,
    cacheWriteRatePerMillion: 0.25,
    aliases: Object.freeze(["gpt-5.4-nano"]),
  },
  // Anthropic
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    family: "Anthropic",
    inputRatePerMillion: 1.00,
    outputRatePerMillion: 5.00,
    cachedInputRatePerMillion: 0.10,
    cacheWriteRatePerMillion: 1.25,
    aliases: Object.freeze(["claude-haiku-4.5", "claude-haiku-4-5"]),
  },
  // Google (Tie)
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "Google",
    inputRatePerMillion: 0.075,
    outputRatePerMillion: 0.375,
    cachedInputRatePerMillion: 0.01875,
    cacheWriteRatePerMillion: undefined,
    aliases: Object.freeze(["gemini-3.6-flash"]),
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "Google",
    inputRatePerMillion: 0.075,
    outputRatePerMillion: 0.375,
    cachedInputRatePerMillion: 0.01875,
    cacheWriteRatePerMillion: undefined,
    aliases: Object.freeze(["gemini-3.7-flash"]),
  },
  // xAI (Tie)
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    family: "xAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 0.60,
    cachedInputRatePerMillion: 0.05,
    cacheWriteRatePerMillion: undefined,
    aliases: Object.freeze(["grok-4.5"]),
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    family: "xAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 0.60,
    cachedInputRatePerMillion: 0.05,
    cacheWriteRatePerMillion: undefined,
    aliases: Object.freeze(["grok-4.6"]),
  },
])

// ---------------------------------------------------------------------------
// Reason Codes
// ---------------------------------------------------------------------------

export const ValidationReasonCode = {
  ELIGIBLE: "ELIGIBLE",
  SELECTED: "SELECTED",
  TIE_UNRESOLVED: "TIE_UNRESOLVED",
  TIE_INCLUDED: "TIE_INCLUDED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  POLICY_DISABLED: "POLICY_DISABLED",
  ENDPOINT_UNREACHABLE: "ENDPOINT_UNREACHABLE",
  PRICE_MISMATCH: "PRICE_MISMATCH",
  MALFORMED_LIVE_PRICE: "MALFORMED_LIVE_PRICE",
  MISSING_LIVE_PRICE: "MISSING_LIVE_PRICE",
  VENDOR_FAMILY_MISMATCH: "VENDOR_FAMILY_MISMATCH",
  INSUFFICIENT_CONTEXT: "INSUFFICIENT_CONTEXT",
  EXCLUDED_AUDIT_CANDIDATE: "EXCLUDED_AUDIT_CANDIDATE",
} as const

export type ValidationReasonCode =
  (typeof ValidationReasonCode)[keyof typeof ValidationReasonCode]

// ---------------------------------------------------------------------------
// Pure Endpoint and Model Identity Helpers (No global state imports)
// ---------------------------------------------------------------------------

const CLAUDE_ID_RE = /(^|[/_.:-])(claude|anthropic)(?=$|[/_.:-]|\d)/i

/**
 * Pure check for Claude / Anthropic identity without importing runtime state.
 */
export function isPureClaudeModel(
  modelId: string | undefined,
  model?: Model,
  originalModelId?: string,
): boolean {
  if (model) {
    const vendor = model.vendor?.toLowerCase() ?? ""
    if (vendor.includes("anthropic")) return true
    const family = model.capabilities?.family?.toLowerCase() ?? ""
    if (family.includes("claude")) return true
  }
  return [modelId, originalModelId, model?.id].some(
    (id) => typeof id === "string" && CLAUDE_ID_RE.test(id),
  )
}

const CHAT_ENDPOINTS: ReadonlySet<string> = new Set([
  "/chat/completions",
  "/v1/chat/completions",
])
const RESPONSES_ENDPOINTS: ReadonlySet<string> = new Set([
  "/responses",
  "/v1/responses",
])

/**
 * Pure endpoint picker matching Copilot catalog supported_endpoints rules.
 */
export function pickPureEndpoint(
  model: Model,
): "chat" | "responses" | undefined {
  const eps = model.supported_endpoints
  if (!eps || eps.length === 0) return "chat"
  if (eps.some((e) => CHAT_ENDPOINTS.has(e))) return "chat"
  if (eps.some((e) => RESPONSES_ENDPOINTS.has(e))) return "responses"
  return undefined
}

// ---------------------------------------------------------------------------
// Normalization & Mapping Helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw family/vendor string to an OfficialBillingFamily.
 * Returns undefined for unrecognized families.
 * Raw vendor strings are kept distinct from official billing families.
 */
export function normalizeBillingFamily(
  raw: string | undefined | null,
): OfficialBillingFamily | undefined {
  if (!raw || typeof raw !== "string") return undefined
  const cleaned = raw.trim().toLowerCase()

  if (cleaned === "openai" || cleaned === "open-ai" || cleaned === "open_ai") {
    return "OpenAI"
  }
  if (
    cleaned === "anthropic" ||
    cleaned === "claude" ||
    cleaned === "anthropic-ai"
  ) {
    return "Anthropic"
  }
  if (cleaned === "google" || cleaned === "gemini") {
    return "Google"
  }
  if (
    cleaned === "xai" ||
    cleaned === "x-ai" ||
    cleaned === "x_ai" ||
    cleaned === "grok"
  ) {
    return "xAI"
  }

  return undefined
}

/**
 * Find a manifest entry by exact catalog ID or recognized alias.
 * Does NOT perform fuzzy matching.
 */
export function findManifestEntryForCatalogId(
  catalogId: string,
): DocumentedModelRate | undefined {
  if (!catalogId || typeof catalogId !== "string") return undefined
  const target = catalogId.trim()
  return CACHE_VALIDATION_MANIFEST.find(
    (entry) => entry.id === target || entry.aliases.includes(target),
  )
}

/**
 * Pure endpoint resolver: determines whether a model is driven through
 * "messages" (native Claude/Anthropic), "chat" (/chat/completions), or "responses" (/responses).
 * Claude catalog models advertising only chat/responses return undefined (ENDPOINT_UNREACHABLE).
 */
export function resolveModelEndpoint(
  model: Model,
): "messages" | "chat" | "responses" | undefined {
  if (isPureClaudeModel(model.id, model)) {
    const eps = model.supported_endpoints
    // Claude models natively serve /v1/messages or omit endpoints
    if (!eps || eps.length === 0) return "messages"
    if (eps.some((e) => e === "/messages" || e === "/v1/messages")) {
      return "messages"
    }
    // Claude models advertising only other endpoints cannot be driven natively on Messages
    return undefined
  }

  return pickPureEndpoint(model)
}

/**
 * Resolves the official billing family for a catalog model or ID.
 * Checks model vendor / capabilities.family, then exact manifest mapping.
 */
export function resolveModelFamily(
  modelOrId: Model | string,
): OfficialBillingFamily | undefined {
  if (typeof modelOrId === "string") {
    const entry = findManifestEntryForCatalogId(modelOrId)
    return entry?.family ?? normalizeBillingFamily(modelOrId)
  }

  // Model object: check vendor / capabilities.family
  const vendorFamily = normalizeBillingFamily(modelOrId.vendor)
  if (vendorFamily) return vendorFamily

  const capFamily = normalizeBillingFamily(modelOrId.capabilities?.family)
  if (capFamily) return capFamily

  const entry = findManifestEntryForCatalogId(modelOrId.id)
  return entry?.family
}

/**
 * Checks whether a model's policy state permits invocation.
 * Only absent policy or exactly policy.state === "enabled" is permitted.
 */
export function isModelPolicyEnabled(model: Model): boolean {
  if (!model.policy || model.policy.state === undefined) return true
  return model.policy.state === "enabled"
}

// ---------------------------------------------------------------------------
// Effective Limits
// ---------------------------------------------------------------------------

export interface ModelEffectiveLimits {
  readonly contextWindow?: number
  readonly maxPromptTokens?: number
  readonly effectiveInputCeiling?: number
  readonly maxOutputTokens?: number
}

function isValidPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

/**
 * Extracts effective input ceiling and output caps from model capabilities.
 * Effective input ceiling is min(valid positive context, valid positive prompt).
 * Invalid or missing metadata does not fail open.
 */
export function getEffectiveLimits(model: Model): ModelEffectiveLimits {
  const limits = model.capabilities?.limits
  const rawContext = limits?.max_context_window_tokens
  const rawPrompt = limits?.max_prompt_tokens
  const rawOutput =
    limits?.max_output_tokens ?? limits?.max_non_streaming_output_tokens

  const contextWindow = isValidPositiveInteger(rawContext) ? rawContext : undefined
  const maxPromptTokens = isValidPositiveInteger(rawPrompt) ? rawPrompt : undefined
  const maxOutputTokens = isValidPositiveInteger(rawOutput) ? rawOutput : undefined

  let effectiveInputCeiling: number | undefined
  if (contextWindow !== undefined && maxPromptTokens !== undefined) {
    effectiveInputCeiling = Math.min(contextWindow, maxPromptTokens)
  } else {
    effectiveInputCeiling = maxPromptTokens ?? contextWindow
  }

  return {
    contextWindow,
    maxPromptTokens,
    effectiveInputCeiling,
    maxOutputTokens,
  }
}

// ---------------------------------------------------------------------------
// Live Ordinary Price Validation
// ---------------------------------------------------------------------------

export interface LivePriceValidationResult {
  readonly valid: boolean
  readonly liveInputPerMillion?: number
  readonly liveOutputPerMillion?: number
  readonly mismatch: boolean
  readonly reasonCode: ValidationReasonCode
  readonly warning?: string
}

/**
 * Validates ordinary live catalog token prices against documented rates.
 * Used ONLY for mismatch warnings. Does NOT use fallback or cache prices.
 * Performs exact arithmetic with zero speculative scaling heuristics.
 */
export function validateLivePrices(
  model: Model,
  manifestEntry?: DocumentedModelRate,
): LivePriceValidationResult {
  const prices = model.billing?.token_prices
  if (!prices) {
    return {
      valid: false,
      mismatch: false,
      reasonCode: ValidationReasonCode.MISSING_LIVE_PRICE,
      warning: `No live token_prices found for ${model.id}`,
    }
  }

  const { batch_size, input_price, output_price } = prices

  if (
    typeof batch_size !== "number" ||
    !Number.isSafeInteger(batch_size) ||
    batch_size <= 0 ||
    typeof input_price !== "number" ||
    !Number.isFinite(input_price) ||
    input_price < 0 ||
    typeof output_price !== "number" ||
    !Number.isFinite(output_price) ||
    output_price < 0
  ) {
    return {
      valid: false,
      mismatch: false,
      reasonCode: ValidationReasonCode.MALFORMED_LIVE_PRICE,
      warning: `Malformed live token_prices for ${model.id}`,
    }
  }

  const liveInputPerMillion =
    ((input_price / CATALOG_PRICE_SCALE) * TOKENS_PER_MILLION) / batch_size
  const liveOutputPerMillion =
    ((output_price / CATALOG_PRICE_SCALE) * TOKENS_PER_MILLION) / batch_size

  if (!manifestEntry) {
    return {
      valid: true,
      liveInputPerMillion,
      liveOutputPerMillion,
      mismatch: false,
      reasonCode: ValidationReasonCode.ELIGIBLE,
    }
  }

  // Exact comparison with 1e-4 tolerance
  const inputDiff = Math.abs(liveInputPerMillion - manifestEntry.inputRatePerMillion)
  const outputDiff = Math.abs(liveOutputPerMillion - manifestEntry.outputRatePerMillion)
  const mismatch = inputDiff > 0.0001 || outputDiff > 0.0001

  if (mismatch) {
    return {
      valid: true,
      liveInputPerMillion,
      liveOutputPerMillion,
      mismatch: true,
      reasonCode: ValidationReasonCode.PRICE_MISMATCH,
      warning:
        `Price mismatch for ${model.id}: documented $${manifestEntry.inputRatePerMillion}/$${manifestEntry.outputRatePerMillion} per 1M, ` +
        `live catalog reported $${liveInputPerMillion}/$${liveOutputPerMillion} per 1M`,
    }
  }

  return {
    valid: true,
    liveInputPerMillion,
    liveOutputPerMillion,
    mismatch: false,
    reasonCode: ValidationReasonCode.ELIGIBLE,
  }
}

// ---------------------------------------------------------------------------
// Cheapest Model Selection Per Billing Family
// ---------------------------------------------------------------------------

export interface SelectCheapestOptions {
  readonly families?: ReadonlyArray<OfficialBillingFamily | string>
  readonly includeTies?: boolean
  readonly includeAuditCandidates?: boolean
  readonly minContextTokens?: number
  readonly minPromptTokens?: number
  readonly validateLivePrices?: boolean
}

export interface EvaluatedCandidate {
  readonly manifestEntry: DocumentedModelRate
  readonly catalogModel?: Model
  readonly catalogId?: string
  readonly endpoint?: "messages" | "chat" | "responses"
  readonly effectiveLimits: ModelEffectiveLimits
  readonly policyState?: string
  readonly eligible: boolean
  readonly reasonCode: ValidationReasonCode
  readonly livePriceValidation?: LivePriceValidationResult
  readonly warnings: ReadonlyArray<string>
}

export interface FamilySelectionResult {
  readonly family: OfficialBillingFamily
  readonly status:
    | "selected"
    | "tie"
    | "tie_unresolved"
    | "no_candidates"
    | "all_ineligible"
  readonly selected?: EvaluatedCandidate
  readonly candidates: ReadonlyArray<EvaluatedCandidate>
  readonly winningCandidates: ReadonlyArray<EvaluatedCandidate>
  readonly reasonCode: ValidationReasonCode
  readonly warnings: ReadonlyArray<string>
}

export interface SelectCheapestResult {
  readonly families: Record<OfficialBillingFamily, FamilySelectionResult>
  readonly allSelected: ReadonlyArray<EvaluatedCandidate>
  readonly warnings: ReadonlyArray<string>
}

/**
 * Select the cheapest model per official billing family using documented default-tier rates.
 * Preserves unresolved ties for Google/xAI unless `includeTies` is enabled.
 * When `includeTies` is true, all tied winners are returned in `allSelected`.
 */
export function selectCheapestPerFamily(
  catalog: ReadonlyArray<Model>,
  options: SelectCheapestOptions = {},
): SelectCheapestResult {
  const targetFamilies: Array<OfficialBillingFamily> = options.families
    ? (options.families
        .map((f) => normalizeBillingFamily(f))
        .filter((f): f is OfficialBillingFamily => f !== undefined) as Array<OfficialBillingFamily>)
    : [...OFFICIAL_BILLING_FAMILIES]

  const globalWarnings: Array<string> = []
  const familiesResult: Partial<
    Record<OfficialBillingFamily, FamilySelectionResult>
  > = {}
  const allSelected: Array<EvaluatedCandidate> = []

  for (const family of OFFICIAL_BILLING_FAMILIES) {
    if (!targetFamilies.includes(family)) {
      familiesResult[family] = {
        family,
        status: "no_candidates",
        candidates: [],
        winningCandidates: [],
        reasonCode: ValidationReasonCode.MODEL_NOT_FOUND,
        warnings: [],
      }
      continue
    }

    const familyWarnings: Array<string> = []

    // 1. Filter manifest entries for this family
    let manifestEntries = CACHE_VALIDATION_MANIFEST.filter(
      (entry) => entry.family === family,
    )

    if (!options.includeAuditCandidates) {
      manifestEntries = manifestEntries.filter((entry) => !entry.auditOnly)
    }

    // 2. Evaluate each manifest candidate against the catalog
    const evaluated: Array<EvaluatedCandidate> = []

    for (const manifestEntry of manifestEntries) {
      const candidateWarnings: Array<string> = []

      // Exact ID or alias match only (no fuzzy matching)
      const model = catalog.find(
        (m) =>
          m.id === manifestEntry.id || manifestEntry.aliases.includes(m.id),
      )

      if (!model) {
        evaluated.push({
          manifestEntry,
          effectiveLimits: {},
          eligible: false,
          reasonCode: ValidationReasonCode.MODEL_NOT_FOUND,
          warnings: candidateWarnings,
        })
        continue
      }

      const effectiveLimits = getEffectiveLimits(model)
      const policyState = model.policy?.state ?? "enabled"
      const endpoint = resolveModelEndpoint(model)

      // Live price validation
      let priceVal: LivePriceValidationResult | undefined
      if (options.validateLivePrices) {
        priceVal = validateLivePrices(model, manifestEntry)
        if (priceVal.warning) {
          candidateWarnings.push(priceVal.warning)
          familyWarnings.push(priceVal.warning)
        }
      }

      // Check vendor/family contradiction (makes candidate ineligible)
      const resolvedFamily = resolveModelFamily(model)
      let vendorContradiction = false
      if (resolvedFamily && resolvedFamily !== family) {
        vendorContradiction = true
        const warn = `Vendor family contradiction for ${model.id}: candidate family ${family}, model vendor/family ${resolvedFamily}`
        candidateWarnings.push(warn)
        familyWarnings.push(warn)
      }

      // Eligibility checks
      let eligible = true
      let reasonCode: ValidationReasonCode = ValidationReasonCode.ELIGIBLE

      if (vendorContradiction) {
        eligible = false
        reasonCode = ValidationReasonCode.VENDOR_FAMILY_MISMATCH
      } else if (!isModelPolicyEnabled(model)) {
        eligible = false
        reasonCode = ValidationReasonCode.POLICY_DISABLED
      } else if (!endpoint) {
        eligible = false
        reasonCode = ValidationReasonCode.ENDPOINT_UNREACHABLE
      } else if (
        options.minContextTokens !== undefined &&
        ((effectiveLimits.contextWindow ?? 0) < options.minContextTokens ||
          effectiveLimits.contextWindow === undefined)
      ) {
        eligible = false
        reasonCode = ValidationReasonCode.INSUFFICIENT_CONTEXT
      } else if (
        options.minPromptTokens !== undefined &&
        ((effectiveLimits.effectiveInputCeiling ?? 0) < options.minPromptTokens ||
          effectiveLimits.effectiveInputCeiling === undefined)
      ) {
        eligible = false
        reasonCode = ValidationReasonCode.INSUFFICIENT_CONTEXT
      }

      evaluated.push({
        manifestEntry,
        catalogModel: model,
        catalogId: model.id,
        endpoint,
        effectiveLimits,
        policyState,
        eligible,
        reasonCode,
        livePriceValidation: priceVal,
        warnings: candidateWarnings,
      })
    }

    // 3. Filter eligible candidates and rank by default-tier rates (input ASC, then output ASC)
    const eligibleCandidates = evaluated.filter((c) => c.eligible)

    if (evaluated.length === 0 || evaluated.every((c) => !c.catalogModel)) {
      familiesResult[family] = {
        family,
        status: "no_candidates",
        candidates: evaluated,
        winningCandidates: [],
        reasonCode: ValidationReasonCode.MODEL_NOT_FOUND,
        warnings: familyWarnings,
      }
      globalWarnings.push(...familyWarnings)
      continue
    }

    if (eligibleCandidates.length === 0) {
      familiesResult[family] = {
        family,
        status: "all_ineligible",
        candidates: evaluated,
        winningCandidates: [],
        reasonCode: evaluated[0]?.reasonCode ?? ValidationReasonCode.POLICY_DISABLED,
        warnings: familyWarnings,
      }
      globalWarnings.push(...familyWarnings)
      continue
    }

    // Sort: inputRatePerMillion ASC, then outputRatePerMillion ASC, then ID ASC for determinism
    eligibleCandidates.sort((a, b) => {
      const inDiff =
        a.manifestEntry.inputRatePerMillion -
        b.manifestEntry.inputRatePerMillion
      if (inDiff !== 0) return inDiff

      const outDiff =
        a.manifestEntry.outputRatePerMillion -
        b.manifestEntry.outputRatePerMillion
      if (outDiff !== 0) return outDiff

      return a.manifestEntry.id.localeCompare(b.manifestEntry.id)
    })

    const minInput = eligibleCandidates[0].manifestEntry.inputRatePerMillion
    const minOutput = eligibleCandidates[0].manifestEntry.outputRatePerMillion

    const winners = eligibleCandidates.filter(
      (c) =>
        c.manifestEntry.inputRatePerMillion === minInput &&
        c.manifestEntry.outputRatePerMillion === minOutput,
    )

    if (winners.length === 1) {
      const selected = winners[0]
      familiesResult[family] = {
        family,
        status: "selected",
        selected,
        candidates: evaluated,
        winningCandidates: winners,
        reasonCode: ValidationReasonCode.SELECTED,
        warnings: familyWarnings,
      }
      allSelected.push(selected)
    } else {
      // Tie detected
      if (options.includeTies) {
        const selected = winners[0]
        familiesResult[family] = {
          family,
          status: "tie",
          selected,
          candidates: evaluated,
          winningCandidates: winners,
          reasonCode: ValidationReasonCode.TIE_INCLUDED,
          warnings: familyWarnings,
        }
        allSelected.push(...winners)
      } else {
        // Preserve tie as unresolved unless includeTies is specified
        familiesResult[family] = {
          family,
          status: "tie_unresolved",
          selected: undefined,
          candidates: evaluated,
          winningCandidates: winners,
          reasonCode: ValidationReasonCode.TIE_UNRESOLVED,
          warnings: familyWarnings,
        }
      }
    }

    globalWarnings.push(...familyWarnings)
  }

  return {
    families: familiesResult as Record<OfficialBillingFamily, FamilySelectionResult>,
    allSelected,
    warnings: globalWarnings,
  }
}

// ---------------------------------------------------------------------------
// Documented Cost Calculation
// ---------------------------------------------------------------------------

export interface TokenUsageCounts {
  readonly uncachedInputTokens?: number
  readonly cachedReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
}

export interface CostCalculationResult {
  readonly costUsd?: number
  readonly uncachedInputCostUsd?: number
  readonly cachedReadCostUsd?: number
  readonly cacheWriteCostUsd?: number
  readonly outputCostUsd?: number
  readonly inconclusive: boolean
  readonly reason?: string
}

/**
 * Calculates theoretical cost in USD using documented rates.
 * If usage specifies tokens for a category whose rate is missing/undefined (e.g. cache write rate missing),
 * returns `{ inconclusive: true, reason: ... }`.
 */
export function calculateDocumentedCost(
  usage: TokenUsageCounts,
  rates: DocumentedModelRate,
): CostCalculationResult {
  const uncachedInput = usage.uncachedInputTokens ?? 0
  const cachedRead = usage.cachedReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const output = usage.outputTokens ?? 0

  if (cachedRead > 0 && rates.cachedInputRatePerMillion === undefined) {
    return {
      inconclusive: true,
      reason: `Missing documented cached input rate for ${rates.id}`,
    }
  }

  if (cacheWrite > 0 && rates.cacheWriteRatePerMillion === undefined) {
    return {
      inconclusive: true,
      reason: `Missing documented cache write rate for ${rates.id}`,
    }
  }

  const uncachedInputCostUsd = (uncachedInput / 1_000_000) * rates.inputRatePerMillion
  const cachedReadCostUsd =
    cachedRead > 0 ? (cachedRead / 1_000_000) * (rates.cachedInputRatePerMillion ?? 0) : 0
  const cacheWriteCostUsd =
    cacheWrite > 0 ? (cacheWrite / 1_000_000) * (rates.cacheWriteRatePerMillion ?? 0) : 0
  const outputCostUsd = (output / 1_000_000) * rates.outputRatePerMillion

  const totalCost =
    uncachedInputCostUsd + cachedReadCostUsd + cacheWriteCostUsd + outputCostUsd

  return {
    costUsd: totalCost,
    uncachedInputCostUsd,
    cachedReadCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    inconclusive: false,
  }
}

// ---------------------------------------------------------------------------
// Deterministic Nonce-Position Prompt Construction
// ---------------------------------------------------------------------------

export interface SaltedPromptOptions {
  readonly body: string
  readonly nonce: string
  readonly prefix?: string
  readonly position?: "prefix" | "suffix" | "inline"
}

export interface SaltedPromptMetadata {
  readonly fullPrompt: string
  readonly nonce: string
  readonly position: "prefix" | "suffix" | "inline"
  readonly lengthChars: number
  readonly lengthBytes: number
  readonly sha256: string
}

/**
 * Pure helper to construct deterministic salted prompts and compute metadata/hash.
 */
export function buildSaltedPrompt(
  options: SaltedPromptOptions,
): SaltedPromptMetadata {
  const { body, nonce, prefix = "", position = "prefix" } = options

  let fullPrompt: string
  if (position === "prefix") {
    fullPrompt = `${prefix}[NONCE:${nonce}]\n${body}`
  } else if (position === "suffix") {
    fullPrompt = `${prefix}${body}\n[NONCE:${nonce}]`
  } else {
    fullPrompt = `${prefix}[NONCE:${nonce}]${body}`
  }

  const lengthBytes = Buffer.byteLength(fullPrompt, "utf8")
  const sha256 = createHash("sha256").update(fullPrompt).digest("hex")

  return {
    fullPrompt,
    nonce,
    position,
    lengthChars: fullPrompt.length,
    lengthBytes,
    sha256,
  }
}

// ---------------------------------------------------------------------------
// Paired Verdict Classifier
// ---------------------------------------------------------------------------

export interface CacheTrialSample {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface PairedVerdictResult {
  readonly verdict: "cached" | "uncached" | "inconclusive" | "regression"
  readonly readHitRatio: number
  readonly savingsPercentage: number
  readonly estimatedSavingsUsd?: number
  readonly reason: string
}

/**
 * Classifies a paired cold vs warm trial into a structured cache verdict.
 */
export function classifyPairedTrialVerdict(
  cold: CacheTrialSample,
  warm: CacheTrialSample,
  rates?: DocumentedModelRate,
): PairedVerdictResult {
  const warmRead = warm.cachedReadTokens ?? 0
  const warmTotalInput = warm.inputTokens
  const coldWrite = cold.cacheWriteTokens ?? 0

  if (warmTotalInput <= 0) {
    return {
      verdict: "inconclusive",
      readHitRatio: 0,
      savingsPercentage: 0,
      reason: "Warm trial reported zero or invalid input tokens",
    }
  }

  const readHitRatio = Math.min(1.0, Math.max(0.0, warmRead / warmTotalInput))

  let estimatedSavingsUsd: number | undefined
  if (rates && rates.cachedInputRatePerMillion !== undefined) {
    const fullCost = (warmTotalInput / 1_000_000) * rates.inputRatePerMillion
    const uncachedInput = Math.max(0, warmTotalInput - warmRead)
    const actualCost =
      (uncachedInput / 1_000_000) * rates.inputRatePerMillion +
      (warmRead / 1_000_000) * rates.cachedInputRatePerMillion

    estimatedSavingsUsd = Math.max(0, fullCost - actualCost)
  }

  if (readHitRatio >= 0.50) {
    return {
      verdict: "cached",
      readHitRatio,
      savingsPercentage: readHitRatio * 100,
      estimatedSavingsUsd,
      reason: `Effective prompt caching observed: ${(readHitRatio * 100).toFixed(1)}% cache hit ratio on warm turn`,
    }
  }

  if (coldWrite > 0 && warmRead === 0) {
    return {
      verdict: "regression",
      readHitRatio: 0,
      savingsPercentage: 0,
      estimatedSavingsUsd: 0,
      reason: "Cold turn created cache writes but warm turn achieved zero cache reads",
    }
  }

  if (warmRead === 0) {
    return {
      verdict: "uncached",
      readHitRatio: 0,
      savingsPercentage: 0,
      estimatedSavingsUsd: 0,
      reason: "Zero cached input tokens observed on warm turn",
    }
  }

  return {
    verdict: "inconclusive",
    readHitRatio,
    savingsPercentage: readHitRatio * 100,
    estimatedSavingsUsd,
    reason: `Low cache reuse observed (${(readHitRatio * 100).toFixed(1)}% hit ratio)`,
  }
}

// ---------------------------------------------------------------------------
// Plan Sanitization & Hashing
// ---------------------------------------------------------------------------

export interface SanitizeCatalogOptions {
  readonly families?: ReadonlyArray<OfficialBillingFamily | string>
  readonly includeAllCatalogModels?: boolean
}

export interface SanitizedModelPlan {
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly family?: OfficialBillingFamily
  readonly endpoint?: string
  readonly policyState: string
  readonly effectiveInputCeiling?: number
  readonly maxOutputTokens?: number
  readonly documentedRate?: {
    readonly inputRatePerMillion: number
    readonly outputRatePerMillion: number
    readonly cachedInputRatePerMillion?: number
    readonly cacheWriteRatePerMillion?: number
  }
}

export interface SanitizedCatalogPlan {
  readonly version: string
  readonly models: ReadonlyArray<SanitizedModelPlan>
  readonly families: ReadonlyArray<OfficialBillingFamily>
}

/**
 * Strips non-deterministic fields and normalizes catalog models into a stable plan shape.
 */
export function sanitizeCatalogForPlan(
  catalog: ReadonlyArray<Model>,
  options: SanitizeCatalogOptions = {},
): SanitizedCatalogPlan {
  const targetFamilies = options.families
    ? (options.families
        .map((f) => normalizeBillingFamily(f))
        .filter((f): f is OfficialBillingFamily => f !== undefined) as Array<OfficialBillingFamily>)
    : [...OFFICIAL_BILLING_FAMILIES]

  const models: Array<SanitizedModelPlan> = []

  for (const model of catalog) {
    const family = resolveModelFamily(model)
    if (!options.includeAllCatalogModels) {
      if (!family || !targetFamilies.includes(family)) continue
    }

    const limits = getEffectiveLimits(model)
    const manifestEntry = findManifestEntryForCatalogId(model.id)
    const endpoint = resolveModelEndpoint(model)

    models.push({
      id: model.id,
      name: model.name || model.id,
      vendor: model.vendor || "unknown",
      family,
      endpoint,
      policyState: model.policy?.state ?? "enabled",
      effectiveInputCeiling: limits.effectiveInputCeiling,
      maxOutputTokens: limits.maxOutputTokens,
      documentedRate: manifestEntry
        ? {
            inputRatePerMillion: manifestEntry.inputRatePerMillion,
            outputRatePerMillion: manifestEntry.outputRatePerMillion,
            cachedInputRatePerMillion: manifestEntry.cachedInputRatePerMillion,
            cacheWriteRatePerMillion: manifestEntry.cacheWriteRatePerMillion,
          }
        : undefined,
    })
  }

  // Deterministic sorting by ID
  models.sort((a, b) => a.id.localeCompare(b.id))

  return {
    version: "1.0",
    models,
    families: [...targetFamilies].sort(),
  }
}

/**
 * Deterministic JSON stringifier that sorts all object keys recursively.
 */
function deterministicStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => deterministicStringify(item)).join(",")}]`
  }

  const record = value as Record<string, unknown>
  const sortedKeys = Object.keys(record).sort()
  const entries = sortedKeys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${deterministicStringify(record[k])}`)

  return `{${entries.join(",")}}`
}

/**
 * Computes a deterministic SHA-256 hash of a plan, selection, or catalog state.
 */
export function computePlanHash(input: unknown): string {
  const serialized = deterministicStringify(input)
  return createHash("sha256").update(serialized).digest("hex")
}

/** Alias for computePlanHash. */
export const planHash = computePlanHash
