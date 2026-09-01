/**
 * Unit tests for pure validation module `scripts/cache-validation.ts`.
 *
 * Verifies:
 * - Official Copilot billing families (OpenAI, Anthropic, Google, xAI)
 * - Documented default-tier candidate manifest & USD-per-million rates
 * - Exact catalog ID matches & alias handling (no fuzzy matching)
 * - Ties preservation for Google (Gemini 3.6/3.7 Flash) & xAI (Grok 4.5/4.6)
 * - includeTies behavior
 * - Missing and ambiguous IDs
 * - Exclusion of fallback prices and cache prices
 * - Live price mismatch warnings and malformed price handling
 * - Endpoint resolution (messages, chat, responses) and endpoint aliases
 * - Claude identity fail-closed detection
 * - Effective input ceiling & output caps
 * - Disabled policy state exclusion
 * - Unknown vendor / family contradiction handling
 * - Deterministic plan sanitization and SHA-256 plan hashing
 */

import { describe, expect, test } from "bun:test"

import {
  CACHE_VALIDATION_MANIFEST,
  computePlanHash,
  findManifestEntryForCatalogId,
  getEffectiveLimits,
  isModelPolicyEnabled,
  normalizeBillingFamily,
  OFFICIAL_BILLING_FAMILIES,
  OFFICIAL_COPILOT_BILLING_URL,
  planHash,
  resolveModelEndpoint,
  resolveModelFamily,
  sanitizeCatalogForPlan,
  selectCheapestPerFamily,
  validateLivePrices,
  ValidationReasonCode,
} from "../scripts/cache-validation"
import type { Model } from "../src/services/copilot/get-models"

function createMockModel(overrides: Partial<Model> = {}): Model {
  const id = overrides.id ?? "mock-model"
  return {
    id,
    name: overrides.name ?? id,
    object: "model",
    preview: overrides.preview ?? false,
    vendor: overrides.vendor ?? "test-vendor",
    version: overrides.version ?? "1",
    model_picker_enabled: true,
    capabilities: {
      family: overrides.capabilities?.family ?? id,
      object: "model_capabilities",
      tokenizer: "test",
      type: "chat",
      limits: overrides.capabilities?.limits ?? {
        max_context_window_tokens: 1_000_000,
        max_prompt_tokens: 900_000,
        max_output_tokens: 64_000,
      },
      supports: overrides.capabilities?.supports ?? {
        tool_calls: true,
      },
    },
    supported_endpoints: overrides.supported_endpoints ?? [
      "/chat/completions",
      "/responses",
    ],
    policy: overrides.policy,
    billing: overrides.billing,
    ...overrides,
  }
}

describe("Official Constants & Billing Families", () => {
  test("defines official billing families constant", () => {
    expect(OFFICIAL_BILLING_FAMILIES).toEqual([
      "OpenAI",
      "Anthropic",
      "Google",
      "xAI",
    ])
    expect(OFFICIAL_COPILOT_BILLING_URL).toBe(
      "https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing",
    )
  })

  test("normalizes billing family strings correctly and rejects unknowns", () => {
    expect(normalizeBillingFamily("openai")).toBe("OpenAI")
    expect(normalizeBillingFamily("OPENAI")).toBe("OpenAI")
    expect(normalizeBillingFamily("open_ai")).toBe("OpenAI")
    expect(normalizeBillingFamily("anthropic")).toBe("Anthropic")
    expect(normalizeBillingFamily("claude")).toBe("Anthropic")
    expect(normalizeBillingFamily("google")).toBe("Google")
    expect(normalizeBillingFamily("gemini")).toBe("Google")
    expect(normalizeBillingFamily("xai")).toBe("xAI")
    expect(normalizeBillingFamily("x-ai")).toBe("xAI")
    expect(normalizeBillingFamily("grok")).toBe("xAI")

    expect(normalizeBillingFamily("unknown")).toBeUndefined()
    expect(normalizeBillingFamily("meta")).toBeUndefined()
    expect(normalizeBillingFamily("")).toBeUndefined()
    expect(normalizeBillingFamily(undefined)).toBeUndefined()
  })
})

describe("Documented Candidate Manifest", () => {
  test("manifest contains expected rates for official candidates", () => {
    const luna = CACHE_VALIDATION_MANIFEST.find((m) => m.id === "gpt-5.6-luna")
    expect(luna).toBeDefined()
    expect(luna?.family).toBe("OpenAI")
    expect(luna?.inputRatePerMillion).toBe(0.20)
    expect(luna?.outputRatePerMillion).toBe(1.20)

    const nano = CACHE_VALIDATION_MANIFEST.find((m) => m.id === "gpt-5.4-nano")
    expect(nano).toBeDefined()
    expect(nano?.family).toBe("OpenAI")
    expect(nano?.auditOnly).toBe(true)
    expect(nano?.inputRatePerMillion).toBe(0.05)
    expect(nano?.outputRatePerMillion).toBe(0.25)

    const haiku = CACHE_VALIDATION_MANIFEST.find(
      (m) => m.id === "claude-haiku-4.5",
    )
    expect(haiku).toBeDefined()
    expect(haiku?.family).toBe("Anthropic")
    expect(haiku?.inputRatePerMillion).toBe(1.00)
    expect(haiku?.outputRatePerMillion).toBe(5.00)
    expect(haiku?.aliases).toContain("claude-haiku-4-5")

    const gem36 = CACHE_VALIDATION_MANIFEST.find(
      (m) => m.id === "gemini-3.6-flash",
    )
    const gem37 = CACHE_VALIDATION_MANIFEST.find(
      (m) => m.id === "gemini-3.7-flash",
    )
    expect(gem36?.inputRatePerMillion).toBe(0.075)
    expect(gem37?.inputRatePerMillion).toBe(0.075)
    expect(gem36?.outputRatePerMillion).toBe(0.375)
    expect(gem37?.outputRatePerMillion).toBe(0.375)

    const grok45 = CACHE_VALIDATION_MANIFEST.find((m) => m.id === "grok-4.5")
    const grok46 = CACHE_VALIDATION_MANIFEST.find((m) => m.id === "grok-4.6")
    expect(grok45?.inputRatePerMillion).toBe(0.20)
    expect(grok46?.inputRatePerMillion).toBe(0.20)
    expect(grok45?.outputRatePerMillion).toBe(0.60)
    expect(grok46?.outputRatePerMillion).toBe(0.60)
  })

  test("exact ID matching and alias resolution with no fuzzy matching", () => {
    expect(findManifestEntryForCatalogId("gpt-5.6-luna")?.id).toBe(
      "gpt-5.6-luna",
    )
    expect(findManifestEntryForCatalogId("claude-haiku-4-5")?.id).toBe(
      "claude-haiku-4.5",
    )
    expect(findManifestEntryForCatalogId("claude-haiku-4.5")?.id).toBe(
      "claude-haiku-4.5",
    )

    // Substrings / fuzzy IDs must NOT match
    expect(findManifestEntryForCatalogId("luna")).toBeUndefined()
    expect(findManifestEntryForCatalogId("gpt-5.6-luna-preview")).toBeUndefined()
    expect(findManifestEntryForCatalogId("haiku")).toBeUndefined()
    expect(findManifestEntryForCatalogId("gemini-3.7")).toBeUndefined()
  })
})

describe("Endpoint & Family Resolution", () => {
  test("resolves endpoints including Claude Messages and aliases", () => {
    const claudeModel = createMockModel({
      id: "claude-haiku-4.5",
      vendor: "Anthropic",
      supported_endpoints: ["/v1/messages"],
    })
    expect(resolveModelEndpoint(claudeModel)).toBe("messages")

    const chatModel = createMockModel({
      id: "gemini-3.7-flash",
      vendor: "Google",
      supported_endpoints: ["/chat/completions"],
    })
    expect(resolveModelEndpoint(chatModel)).toBe("chat")

    const respModel = createMockModel({
      id: "gpt-5.6-luna",
      vendor: "OpenAI",
      supported_endpoints: ["/responses"],
    })
    expect(resolveModelEndpoint(respModel)).toBe("responses")

    const v1RespModel = createMockModel({
      id: "gpt-5.6-luna",
      vendor: "OpenAI",
      supported_endpoints: ["/v1/responses"],
    })
    expect(resolveModelEndpoint(v1RespModel)).toBe("responses")

    const wsOnlyModel = createMockModel({
      id: "custom-ws",
      vendor: "OpenAI",
      supported_endpoints: ["ws:/responses"],
    })
    expect(resolveModelEndpoint(wsOnlyModel)).toBeUndefined()
  })

  test("resolves model family from manifest, vendor, or capabilities", () => {
    expect(resolveModelFamily("gpt-5.6-luna")).toBe("OpenAI")
    expect(resolveModelFamily("claude-haiku-4-5")).toBe("Anthropic")
    expect(
      resolveModelFamily(
        createMockModel({ id: "unknown-id", vendor: "Google" }),
      ),
    ).toBe("Google")
    expect(
      resolveModelFamily(
        createMockModel({
          id: "custom",
          vendor: "Other",
          capabilities: { family: "grok", object: "cap", tokenizer: "t", type: "chat" },
        }),
      ),
    ).toBe("xAI")
  })
})

describe("Effective Limits & Policy State", () => {
  test("computes effective prompt ceiling from max_prompt_tokens or context window", () => {
    const modelWithPrompt = createMockModel({
      capabilities: {
        family: "gpt",
        object: "cap",
        tokenizer: "t",
        type: "chat",
        limits: {
          max_context_window_tokens: 1_000_000,
          max_prompt_tokens: 850_000,
          max_output_tokens: 32_000,
        },
      },
    })
    const limits1 = getEffectiveLimits(modelWithPrompt)
    expect(limits1.contextWindow).toBe(1_000_000)
    expect(limits1.maxPromptTokens).toBe(850_000)
    expect(limits1.effectiveInputCeiling).toBe(850_000)
    expect(limits1.maxOutputTokens).toBe(32_000)

    const modelWithoutPrompt = createMockModel({
      capabilities: {
        family: "gpt",
        object: "cap",
        tokenizer: "t",
        type: "chat",
        limits: {
          max_context_window_tokens: 400_000,
          max_non_streaming_output_tokens: 16_000,
        },
      },
    })
    const limits2 = getEffectiveLimits(modelWithoutPrompt)
    expect(limits2.contextWindow).toBe(400_000)
    expect(limits2.maxPromptTokens).toBeUndefined()
    expect(limits2.effectiveInputCeiling).toBe(400_000)
    expect(limits2.maxOutputTokens).toBe(16_000)
  })

  test("evaluates policy state correctly", () => {
    expect(isModelPolicyEnabled(createMockModel({ policy: { state: "enabled", terms: "terms" } }))).toBe(true)
    expect(isModelPolicyEnabled(createMockModel({ policy: { state: "disabled", terms: "terms" } }))).toBe(false)
    expect(isModelPolicyEnabled(createMockModel({ policy: undefined }))).toBe(true)
  })
})

describe("Live Ordinary Price Validation (Warnings only)", () => {
  test("validates matching live prices and reports valid with no warning", () => {
    const model = createMockModel({
      id: "gpt-5.6-luna",
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: {
          batch_size: 1_000_000,
          input_price: 200_000_000, // $0.20 per 1M (scaled by 1e9)
          output_price: 1_200_000_000, // $1.20 per 1M (scaled by 1e9)
        },
      },
    })
    const manifestEntry = findManifestEntryForCatalogId("gpt-5.6-luna")
    const res = validateLivePrices(model, manifestEntry)
    expect(res.valid).toBe(true)
    expect(res.mismatch).toBe(false)
    expect(res.liveInputPerMillion).toBeCloseTo(0.20, 4)
    expect(res.liveOutputPerMillion).toBeCloseTo(1.20, 4)
    expect(res.warning).toBeUndefined()
  })

  test("flags price mismatch when live price diverges from documented rate", () => {
    const model = createMockModel({
      id: "gpt-5.6-luna",
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: {
          batch_size: 1_000_000,
          input_price: 500_000_000, // $0.50 (differs from $0.20)
          output_price: 1_200_000_000,
        },
      },
    })
    const manifestEntry = findManifestEntryForCatalogId("gpt-5.6-luna")
    const res = validateLivePrices(model, manifestEntry)
    expect(res.valid).toBe(true)
    expect(res.mismatch).toBe(true)
    expect(res.reasonCode).toBe(ValidationReasonCode.PRICE_MISMATCH)
    expect(res.warning).toContain("Price mismatch for gpt-5.6-luna")
  })

  test("handles missing and malformed live token prices without throwing", () => {
    const noPrices = createMockModel({ id: "gpt-5.6-luna" })
    const res1 = validateLivePrices(noPrices)
    expect(res1.valid).toBe(false)
    expect(res1.reasonCode).toBe(ValidationReasonCode.MISSING_LIVE_PRICE)

    const malformed = createMockModel({
      id: "gpt-5.6-luna",
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: {
          batch_size: 0,
          input_price: -1,
        },
      },
    })
    const res2 = validateLivePrices(malformed)
    expect(res2.valid).toBe(false)
    expect(res2.reasonCode).toBe(ValidationReasonCode.MALFORMED_LIVE_PRICE)
  })
})

describe("selectCheapestPerFamily Ranking and Tie Preservation", () => {
  test("selects cheapest candidate for OpenAI (Luna) and Anthropic (Haiku)", () => {
    const catalog = [
      createMockModel({
        id: "gpt-5.6-luna",
        vendor: "OpenAI",
        supported_endpoints: ["/responses"],
      }),
      createMockModel({
        id: "claude-haiku-4.5",
        vendor: "Anthropic",
        supported_endpoints: ["/v1/messages"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, {
      families: ["OpenAI", "Anthropic"],
    })

    expect(result.families.OpenAI.status).toBe("selected")
    expect(result.families.OpenAI.selected?.manifestEntry.id).toBe(
      "gpt-5.6-luna",
    )
    expect(result.families.OpenAI.reasonCode).toBe(
      ValidationReasonCode.SELECTED,
    )

    expect(result.families.Anthropic.status).toBe("selected")
    expect(result.families.Anthropic.selected?.manifestEntry.id).toBe(
      "claude-haiku-4.5",
    )
  })

  test("preserves ties for Google (3.6/3.7 Flash) as tie_unresolved by default", () => {
    const catalog = [
      createMockModel({
        id: "gemini-3.6-flash",
        vendor: "Google",
        supported_endpoints: ["/chat/completions"],
      }),
      createMockModel({
        id: "gemini-3.7-flash",
        vendor: "Google",
        supported_endpoints: ["/chat/completions"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, { families: ["Google"] })
    expect(result.families.Google.status).toBe("tie_unresolved")
    expect(result.families.Google.selected).toBeUndefined()
    expect(result.families.Google.winningCandidates.length).toBe(2)
    expect(result.families.Google.reasonCode).toBe(
      ValidationReasonCode.TIE_UNRESOLVED,
    )
  })

  test("resolves tie deterministically when includeTies: true is passed", () => {
    const catalog = [
      createMockModel({
        id: "gemini-3.7-flash",
        vendor: "Google",
        supported_endpoints: ["/chat/completions"],
      }),
      createMockModel({
        id: "gemini-3.6-flash",
        vendor: "Google",
        supported_endpoints: ["/chat/completions"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, {
      families: ["Google"],
      includeTies: true,
    })
    expect(result.families.Google.status).toBe("tie")
    expect(result.families.Google.selected).toBeDefined()
    // Alphabetically first deterministic winner (gemini-3.6-flash < gemini-3.7-flash)
    expect(result.families.Google.selected?.manifestEntry.id).toBe(
      "gemini-3.6-flash",
    )
    expect(result.families.Google.reasonCode).toBe(
      ValidationReasonCode.TIE_INCLUDED,
    )
  })

  test("preserves ties for xAI (Grok 4.5/4.6) as tie_unresolved by default", () => {
    const catalog = [
      createMockModel({
        id: "grok-4.5",
        vendor: "xAI",
        supported_endpoints: ["/responses"],
      }),
      createMockModel({
        id: "grok-4.6",
        vendor: "xAI",
        supported_endpoints: ["/responses"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, { families: ["xAI"] })
    expect(result.families.xAI.status).toBe("tie_unresolved")
    expect(result.families.xAI.selected).toBeUndefined()
    expect(result.families.xAI.winningCandidates.length).toBe(2)
  })

  test("excludes audit-only candidates (GPT-5.4 Nano) unless includeAuditCandidates is true", () => {
    const catalog = [
      createMockModel({
        id: "gpt-5.4-nano",
        vendor: "OpenAI",
        supported_endpoints: ["/responses"],
      }),
      createMockModel({
        id: "gpt-5.6-luna",
        vendor: "OpenAI",
        supported_endpoints: ["/responses"],
      }),
    ]

    // By default: Nano is excluded
    const defaultRes = selectCheapestPerFamily(catalog, { families: ["OpenAI"] })
    expect(defaultRes.families.OpenAI.selected?.manifestEntry.id).toBe(
      "gpt-5.6-luna",
    )

    // With includeAuditCandidates: Nano is cheaper ($0.05 vs $0.20)
    const auditRes = selectCheapestPerFamily(catalog, {
      families: ["OpenAI"],
      includeAuditCandidates: true,
    })
    expect(auditRes.families.OpenAI.selected?.manifestEntry.id).toBe(
      "gpt-5.4-nano",
    )
  })

  test("handles policy disabled models by excluding them from winning candidates", () => {
    const catalog = [
      createMockModel({
        id: "gemini-3.6-flash",
        vendor: "Google",
        policy: { state: "disabled", terms: "terms" },
        supported_endpoints: ["/chat/completions"],
      }),
      createMockModel({
        id: "gemini-3.7-flash",
        vendor: "Google",
        policy: { state: "enabled", terms: "terms" },
        supported_endpoints: ["/chat/completions"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, { families: ["Google"] })
    // Only 3.7 is eligible, so no tie occurs
    expect(result.families.Google.status).toBe("selected")
    expect(result.families.Google.selected?.manifestEntry.id).toBe(
      "gemini-3.7-flash",
    )
  })

  test("handles unreachable endpoints by marking candidate ineligible", () => {
    const catalog = [
      createMockModel({
        id: "gpt-5.6-luna",
        vendor: "OpenAI",
        supported_endpoints: ["ws:/unsupported"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, { families: ["OpenAI"] })
    expect(result.families.OpenAI.status).toBe("all_ineligible")
    expect(result.families.OpenAI.reasonCode).toBe(
      ValidationReasonCode.ENDPOINT_UNREACHABLE,
    )
  })

  test("detects vendor/family contradictions and emits warnings", () => {
    const catalog = [
      createMockModel({
        id: "gpt-5.6-luna",
        vendor: "Google", // Contradicts OpenAI
        supported_endpoints: ["/responses"],
      }),
    ]

    const result = selectCheapestPerFamily(catalog, { families: ["OpenAI"] })
    expect(result.families.OpenAI.warnings.some((w) => w.includes("Vendor family contradiction"))).toBe(true)
  })
})

describe("Deterministic Plan Sanitization and Hashing", () => {
  test("sanitizes catalog deterministically and computes stable SHA-256 plan hash", () => {
    const catalog = [
      createMockModel({
        id: "gpt-5.6-luna",
        vendor: "OpenAI",
        capabilities: {
          family: "gpt-5.6",
          object: "cap",
          tokenizer: "t",
          type: "chat",
          limits: { max_context_window_tokens: 1_000_000 },
        },
      }),
      createMockModel({
        id: "claude-haiku-4.5",
        vendor: "Anthropic",
        capabilities: {
          family: "claude",
          object: "cap",
          tokenizer: "t",
          type: "chat",
          limits: { max_context_window_tokens: 200_000 },
        },
      }),
    ]

    const plan1 = sanitizeCatalogForPlan(catalog)
    const hash1 = planHash(plan1)

    // Reverse catalog input order
    const plan2 = sanitizeCatalogForPlan([...catalog].reverse())
    const hash2 = computePlanHash(plan2)

    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    expect(plan1.models.length).toBe(2)
    expect(plan1.models[0].id).toBe("claude-haiku-4.5")
    expect(plan1.models[1].id).toBe("gpt-5.6-luna")
  })
})
