/**
 * Pure prompt-cache validation and model catalog evaluation module.
 *
 * Implements deterministic validation, default-tier candidate ranking,
 * live catalog eligibility checks, and plan hashing against official
 * GitHub Copilot billing families and documented model rates.
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

import { isClaudeModel } from "~/lib/anthropic-translate/classifier"
import { pickEndpoint } from "~/services/copilot/endpoint"
import type { Model } from "~/services/copilot/get-models"

// ---------------------------------------------------------------------------
// Constants & Documentation
// ---------------------------------------------------------------------------

/**
 * Official documentation URL for GitHub Copilot model pricing and families.
 */
export const OFFICIAL_COPILOT_BILLING_URL =
  "https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing"

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
 */
export interface DocumentedModelRate {
  /** Canonical identifier in the manifest. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** Official Copilot billing family. */
  readonly family: OfficialBillingFamily
  /** Documented default-tier input rate in USD per million tokens. */
  readonly inputRatePerMillion: number
  /** Documented default-tier output rate in USD per million tokens. */
  readonly outputRatePerMillion: number
  /** Exact catalog IDs and aliases recognized for this candidate (no fuzzy match). */
  readonly aliases: ReadonlyArray<string>
  /** Audit-only candidates (e.g. GPT-5.4 Nano) excluded from standard ranking by default. */
  readonly auditOnly?: boolean
}

/**
 * Checked-in authoritative default-tier candidate manifest.
 *
 * Rates:
 * - OpenAI:
 *     - GPT-5.6 Luna: $0.20 input / $1.20 output per 1M tokens.
 *     - GPT-5.4 Nano (audit candidate): $0.05 input / $0.25 output per 1M tokens.
 * - Anthropic:
 *     - Claude Haiku 4.5: $1.00 input / $5.00 output per 1M tokens (aliases: claude-haiku-4.5, claude-haiku-4-5).
 * - Google:
 *     - Gemini 3.6 Flash: $0.075 input / $0.375 output per 1M tokens (tie).
 *     - Gemini 3.7 Flash: $0.075 input / $0.375 output per 1M tokens (tie).
 * - xAI:
 *     - Grok 4.5: $0.20 input / $0.60 output per 1M tokens (tie).
 *     - Grok 4.6: $0.20 input / $0.60 output per 1M tokens (tie).
 */
export const CACHE_VALIDATION_MANIFEST: ReadonlyArray<DocumentedModelRate> = Object.freeze([
  // OpenAI
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    family: "OpenAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 1.20,
    aliases: Object.freeze(["gpt-5.6-luna"]),
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    family: "OpenAI",
    inputRatePerMillion: 0.05,
    outputRatePerMillion: 0.25,
    aliases: Object.freeze(["gpt-5.4-nano"]),
    auditOnly: true,
  },
  // Anthropic
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    family: "Anthropic",
    inputRatePerMillion: 1.00,
    outputRatePerMillion: 5.00,
    aliases: Object.freeze(["claude-haiku-4.5", "claude-haiku-4-5"]),
  },
  // Google (Tie)
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "Google",
    inputRatePerMillion: 0.075,
    outputRatePerMillion: 0.375,
    aliases: Object.freeze(["gemini-3.6-flash"]),
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "Google",
    inputRatePerMillion: 0.075,
    outputRatePerMillion: 0.375,
    aliases: Object.freeze(["gemini-3.7-flash"]),
  },
  // xAI (Tie)
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    family: "xAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 0.60,
    aliases: Object.freeze(["grok-4.5"]),
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    family: "xAI",
    inputRatePerMillion: 0.20,
    outputRatePerMillion: 0.60,
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
 * Returns undefined when unreachable.
 */
export function resolveModelEndpoint(
  model: Model,
): "messages" | "chat" | "responses" | undefined {
  if (isClaudeModel(model.id, model)) {
    const eps = model.supported_endpoints
    // Claude models natively serve /v1/messages or omit endpoints
    if (!eps || eps.length === 0) return "messages"
    if (eps.some((e) => e === "/messages" || e === "/v1/messages")) {
      return "messages"
    }
    // If Claude model only advertises chat/responses endpoint aliases
    const standard = pickEndpoint(model)
    return standard ?? "messages"
  }

  const endpoint = pickEndpoint(model)
  return endpoint
}

/**
 * Resolves the official billing family for a catalog model or ID.
 * When passed a Model object, it checks model properties (vendor, capabilities.family)
 * and compares against manifest entries.
 */
export function resolveModelFamily(
  modelOrId: Model | string,
): OfficialBillingFamily | undefined {
  if (typeof modelOrId === "string") {
    const entry = findManifestEntryForCatalogId(modelOrId)
    return entry?.family ?? normalizeBillingFamily(modelOrId)
  }

  // Check vendor / capability family first from model object
  const modelFamily =
    normalizeBillingFamily(modelOrId.vendor) ??
    normalizeBillingFamily(modelOrId.capabilities?.family)

  if (modelFamily) return modelFamily

  const entry = findManifestEntryForCatalogId(modelOrId.id)
  return entry?.family
}

/**
 * Checks whether a model's policy state permits invocation.
 * Disabled models (`policy.state === "disabled"`) are ineligible.
 */
export function isModelPolicyEnabled(model: Model): boolean {
  if (!model.policy) return true
  return model.policy.state !== "disabled"
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

/**
 * Extracts effective input ceiling and output caps from model capabilities.
 * Effective input ceiling is `max_prompt_tokens` if defined, else `max_context_window_tokens`.
 */
export function getEffectiveLimits(model: Model): ModelEffectiveLimits {
  const limits = model.capabilities?.limits
  const contextWindow = limits?.max_context_window_tokens
  const maxPromptTokens = limits?.max_prompt_tokens
  const effectiveInputCeiling = maxPromptTokens ?? contextWindow
  const maxOutputTokens =
    limits?.max_output_tokens ?? limits?.max_non_streaming_output_tokens

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

  // Compare with tolerance for floating point representations (cents vs USD scale)
  // Some catalog feeds represent $0.20 as 20 or 0.20; normalize comparison
  const normalizedLiveInput =
    liveInputPerMillion > 1 && manifestEntry.inputRatePerMillion < 1
      ? liveInputPerMillion / 100
      : liveInputPerMillion
  const normalizedLiveOutput =
    liveOutputPerMillion > 1 && manifestEntry.outputRatePerMillion < 1
      ? liveOutputPerMillion / 100
      : liveOutputPerMillion

  const inputDiff = Math.abs(
    normalizedLiveInput - manifestEntry.inputRatePerMillion,
  )
  const outputDiff = Math.abs(
    normalizedLiveOutput - manifestEntry.outputRatePerMillion,
  )
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

  for (const family of targetFamilies) {
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

      // Check vendor contradiction
      const resolvedFamily = resolveModelFamily(model)
      if (resolvedFamily && resolvedFamily !== family) {
        const warn = `Vendor family contradiction for ${model.id}: expected ${family}, resolved ${resolvedFamily}`
        candidateWarnings.push(warn)
        familyWarnings.push(warn)
      }

      // Eligibility checks
      let eligible = true
      let reasonCode: ValidationReasonCode = ValidationReasonCode.ELIGIBLE

      if (!isModelPolicyEnabled(model)) {
        eligible = false
        reasonCode = ValidationReasonCode.POLICY_DISABLED
      } else if (!endpoint) {
        eligible = false
        reasonCode = ValidationReasonCode.ENDPOINT_UNREACHABLE
      } else if (
        options.minContextTokens !== undefined &&
        (effectiveLimits.contextWindow ?? 0) < options.minContextTokens
      ) {
        eligible = false
        reasonCode = ValidationReasonCode.INSUFFICIENT_CONTEXT
      } else if (
        options.minPromptTokens !== undefined &&
        (effectiveLimits.maxPromptTokens ?? effectiveLimits.contextWindow ?? 0) <
          options.minPromptTokens
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
        allSelected.push(selected)
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
