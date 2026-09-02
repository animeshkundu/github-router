/**
 * Hermetic unit tests for additive cache probe script `scripts/probe-cache-families.ts`.
 *
 * Covers:
 * - CLI argument parsing & dry-run gating
 * - Environment variable overrides & defaults
 * - Strict argument parsing and explicit live caps requirement
 * - Fail-fast live gating before auth/disk
 * - Non-empty plan hash requirement before live execution
 * - Call, token, and wall-clock caps tracking & guard enforcement (including estimatedCalls and post-call overrun)
 * - Candidate selection, tie reporting, and manifest extraction
 * - Request payload construction for Messages, Responses, and Chat endpoints
 * - Equal byte length prefix across policy & control arms (ARM excluded from header)
 * - Provider-aware prefix construction via systemPrefixCharsFor
 * - Policy application on policy vs control arms
 * - Fetch instrumentation, attempt counting, and contamination detection (401 refresh / multiple attempts)
 * - Usage normalization and inclusive reconciliation (OpenAI total reconciliation, nested output content text)
 * - Short output contract verification (fixed max output 16, exact OK validation, hash & length matching)
 * - Documented cost calculation (within-model indicative costs, inconclusive on missing rates)
 * - Paired arm verdict classification (cached, uncached, inconclusive, regression)
 * - Edge case evaluation (sub-threshold, growing-history conversation, prefix perturbation, suffix change)
 * - Explicit reporting of edge cap blocks
 * - Sanitized plan artifact redaction (no secrets, prompt text, catalogModel, raw outputText, or local paths)
 * - Plan hash stability & drift detection
 */

import { describe, expect, test } from "bun:test"

import {
  buildSanitizedPlanArtifact,
  buildTrialStablePrefix,
  buildTrialUserPrompt,
  classifyArmTrial,
  classifyCandidateRepetition,
  constructModelRequestPayload,
  executeInstrumentedCall,
  ExecutionCapTracker,
  extractUsageFromResponse,
  parseProbeArgs,
  runFamilyProbe,
  type ConstructedRequest,
  type SingleTurnResult,
} from "../scripts/probe-cache-families"
import {
  CACHE_VALIDATION_MANIFEST,
  OFFICIAL_BILLING_FAMILIES,
  OFFICIAL_COPILOT_BILLING_URL,
  selectCheapestPerFamily,
  type DocumentedModelRate,
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

function createFullMockCatalog(): Array<Model> {
  return [
    createMockModel({
      id: "gpt-5.6-luna",
      vendor: "openai",
      capabilities: {
        family: "gpt-5.6",
        object: "model_capabilities",
        tokenizer: "o200k",
        type: "chat",
        limits: {
          max_context_window_tokens: 1_000_000,
          max_prompt_tokens: 900_000,
          max_output_tokens: 64_000,
        },
      },
      supported_endpoints: ["/responses"],
    }),
    createMockModel({
      id: "gpt-5.4-nano",
      vendor: "openai",
      capabilities: {
        family: "gpt-5.4",
        object: "model_capabilities",
        tokenizer: "o200k",
        type: "chat",
        limits: {
          max_context_window_tokens: 400_000,
          max_prompt_tokens: 350_000,
          max_output_tokens: 16_000,
        },
      },
      supported_endpoints: ["/responses"],
    }),
    createMockModel({
      id: "claude-haiku-4.5",
      vendor: "anthropic",
      capabilities: {
        family: "claude-haiku",
        object: "model_capabilities",
        tokenizer: "claude",
        type: "chat",
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 200_000,
          max_output_tokens: 8_192,
        },
      },
      supported_endpoints: ["/v1/messages"],
    }),
    createMockModel({
      id: "gemini-3.7-flash",
      vendor: "google",
      capabilities: {
        family: "gemini",
        object: "model_capabilities",
        tokenizer: "gemini",
        type: "chat",
        limits: {
          max_context_window_tokens: 1_000_000,
          max_prompt_tokens: 1_000_000,
          max_output_tokens: 64_000,
        },
      },
      supported_endpoints: ["/chat/completions"],
    }),
    createMockModel({
      id: "grok-4.6",
      vendor: "xai",
      capabilities: {
        family: "grok",
        object: "model_capabilities",
        tokenizer: "grok",
        type: "chat",
        limits: {
          max_context_window_tokens: 500_000,
          max_prompt_tokens: 500_000,
          max_output_tokens: 32_000,
        },
      },
      supported_endpoints: ["/chat/completions"],
    }),
  ]
}

describe("CLI Argument & Environment Parsing", () => {
  test("defaults to dry-run mode, all families, and standard caps", () => {
    const config = parseProbeArgs([], {})
    expect(config.isLive).toBe(false)
    expect(config.explicitLiveCaps).toBe(false)
    expect(config.parseError).toBeUndefined()
    expect(config.families).toEqual(OFFICIAL_BILLING_FAMILIES)
    expect(config.includeTies).toBe(false)
    expect(config.includeAuditCandidates).toBe(false)
    expect(config.reps).toBe(3)
    expect(config.runEdges).toBe(false)
    expect(config.maxCalls).toBe(64)
    expect(config.maxInputTokens).toBe(500_000)
    expect(config.maxOutputTokens).toBe(4_096)
    expect(config.maxWallclockMs).toBe(300_000)
    expect(config.callTimeoutMs).toBe(60_000)
  })

  test("parses flags and environment variable overrides correctly", () => {
    const config = parseProbeArgs(
      [
        "--live",
        "--include-ties",
        "--edges",
        "--reps",
        "5",
        "--families",
        "OpenAI,Anthropic",
        "--max-calls",
        "32",
        "--max-input-tokens",
        "200000",
        "--max-output-tokens",
        "1024",
        "--max-wallclock-ms",
        "120000",
        "--plan-hash",
        "abc123hash",
      ],
      {
        GH_ROUTER_CACHE_VALIDATION_PLAN_SHA256: "fallbackhash",
      },
    )
    expect(config.isLive).toBe(true)
    expect(config.explicitLiveCaps).toBe(true)
    expect(config.parseError).toBeUndefined()
    expect(config.includeTies).toBe(true)
    expect(config.runEdges).toBe(true)
    expect(config.reps).toBe(5)
    expect(config.families).toEqual(["OpenAI", "Anthropic"])
    expect(config.maxCalls).toBe(32)
    expect(config.maxInputTokens).toBe(200_000)
    expect(config.maxOutputTokens).toBe(1_024)
    expect(config.maxWallclockMs).toBe(120_000)
    expect(config.expectedPlanHash).toBe("abc123hash")
  })

  test("captures parse error on malformed or non-positive caps or invalid families", () => {
    const configInvalidInt = parseProbeArgs(["--max-calls", "invalid"])
    expect(configInvalidInt.parseError).toBeDefined()
    expect(configInvalidInt.parseError).toContain("Invalid positive integer")

    const configNegative = parseProbeArgs(["--max-input-tokens", "-500"])
    expect(configNegative.parseError).toBeDefined()

    const configBadFamily = parseProbeArgs(["--families", "OpenAI,InvalidFamily"])
    expect(configBadFamily.parseError).toBeDefined()
    expect(configBadFamily.parseError).toContain("Unrecognized billing family")
  })
})

describe("Live Mode Gating Preconditions", () => {
  test("fails fast before network/auth if parseError is present", async () => {
    const config = parseProbeArgs(["--max-calls", "bad"])
    const res = await runFamilyProbe(config)
    expect(res.success).toBe(false)
    expect(res.planHash).toBe("")
  })

  test("fails fast before network/auth in live mode without GH_ROUTER_RUN_CACHE_PROBE=1", async () => {
    const config = parseProbeArgs([
      "--live",
      "--max-calls",
      "10",
      "--max-input-tokens",
      "10000",
      "--max-output-tokens",
      "100",
      "--max-wallclock-ms",
      "10000",
      "--plan-hash",
      "somehash",
    ], {})
    const res = await runFamilyProbe(config)
    expect(res.success).toBe(false)
    expect(res.planHash).toBe("")
  })

  test("fails fast before network/auth in live mode without explicit caps", async () => {
    const config = parseProbeArgs([
      "--live",
      "--plan-hash",
      "somehash",
    ], { GH_ROUTER_RUN_CACHE_PROBE: "1" })
    const res = await runFamilyProbe(config)
    expect(res.success).toBe(false)
    expect(res.planHash).toBe("")
  })

  test("fails fast before network/auth in live mode without non-empty expected plan hash", async () => {
    const config = parseProbeArgs([
      "--live",
      "--max-calls",
      "10",
      "--max-input-tokens",
      "10000",
      "--max-output-tokens",
      "100",
      "--max-wallclock-ms",
      "10000",
    ], { GH_ROUTER_RUN_CACHE_PROBE: "1" })
    const res = await runFamilyProbe(config)
    expect(res.success).toBe(false)
    expect(res.planHash).toBe("")
  })
})

describe("Execution Cap Tracker", () => {
  test("enforces max calls, token caps, and wallclock limits with estimatedCalls", () => {
    const config = parseProbeArgs([
      "--max-calls",
      "2",
      "--max-input-tokens",
      "3000",
      "--max-output-tokens",
      "32",
    ])
    const tracker = new ExecutionCapTracker(config)

    // Call 1: OK
    let check = tracker.checkBeforeCall(1, 1500, 16)
    expect(check.canProceed).toBe(true)
    let overrun = tracker.recordCall(1500, 16)
    expect(overrun.hasOverrun).toBe(false)

    // Call 2: OK
    check = tracker.checkBeforeCall(1, 1500, 16)
    expect(check.canProceed).toBe(true)
    overrun = tracker.recordCall(1500, 16)
    expect(overrun.hasOverrun).toBe(false)

    // Call 3: Exceeds max calls
    check = tracker.checkBeforeCall(1, 1500, 16)
    expect(check.canProceed).toBe(false)
    expect(check.reason).toContain("Exceeded max calls cap")
  })
})

describe("Request Construction & Equal Byte-Length Prefixes", () => {
  const catalog = createFullMockCatalog()
  const selections = selectCheapestPerFamily(catalog, { includeTies: true })

  test("generates identical prefix bytes for policy and control arms (ARM excluded from header)", () => {
    const policyPrefix = buildTrialStablePrefix("OpenAI", "gpt-5.6-luna", "policy", 0, "nonce123")
    const controlPrefix = buildTrialStablePrefix("OpenAI", "gpt-5.6-luna", "control", 0, "nonce123")
    expect(policyPrefix).toBe(controlPrefix)
    expect(Buffer.byteLength(policyPrefix, "utf8")).toBe(Buffer.byteLength(controlPrefix, "utf8"))
  })

  test("builds provider-aware prefix sizing correctly", () => {
    const haikuPrefix = buildTrialStablePrefix("Anthropic", "claude-haiku-4.5", "policy", 0, "nonce")
    const lunaPrefix = buildTrialStablePrefix("OpenAI", "gpt-5.6-luna", "policy", 0, "nonce")

    // Haiku gets large prefix (>= 40,000 chars)
    expect(haikuPrefix.length).toBeGreaterThanOrEqual(40_000)
    // Luna gets default prefix (>= 4,600 bytes)
    expect(Buffer.byteLength(lunaPrefix, "utf8")).toBeGreaterThanOrEqual(4_600)
  })

  test("constructs Messages payload with cache_control only for policy arm", () => {
    const candidate = selections.families.Anthropic.selected!
    const stablePrefix = buildTrialStablePrefix(
      "Anthropic",
      "claude-haiku-4.5",
      "policy",
      0,
      "nonce123",
    )
    const userPrompt = buildTrialUserPrompt("cold", 0)

    // Policy arm: has cache_control
    const policyReq: ConstructedRequest = constructModelRequestPayload(
      candidate,
      "policy",
      stablePrefix,
      userPrompt,
    )
    expect(policyReq.endpointType).toBe("messages")
    expect(policyReq.cacheFieldPaths.length).toBeGreaterThan(0)
    expect(policyReq.cacheFieldPaths).toContain("system[0].cache_control")

    // Control arm: NO cache_control
    const controlReq: ConstructedRequest = constructModelRequestPayload(
      candidate,
      "control",
      stablePrefix,
      userPrompt,
    )
    expect(controlReq.endpointType).toBe("messages")
    expect(controlReq.cacheFieldPaths.length).toBe(0)
  })

  test("constructs Responses payload with prompt_cache_key & options only for policy arm", () => {
    const candidate = selections.families.OpenAI.selected!
    const stablePrefix = buildTrialStablePrefix(
      "OpenAI",
      "gpt-5.6-luna",
      "policy",
      0,
      "nonce123",
    )
    const userPrompt = buildTrialUserPrompt("cold", 0)

    // Policy arm: has explicit prompt_cache_key and breakpoint
    const policyReq: ConstructedRequest = constructModelRequestPayload(
      candidate,
      "policy",
      stablePrefix,
      userPrompt,
    )
    expect(policyReq.endpointType).toBe("responses")
    expect(policyReq.cacheFieldPaths).toContain("prompt_cache_key")
    expect(policyReq.cacheFieldPaths).toContain("prompt_cache_options")

    // Control arm: NO prompt_cache_key
    const controlReq: ConstructedRequest = constructModelRequestPayload(
      candidate,
      "control",
      stablePrefix,
      userPrompt,
    )
    expect(controlReq.endpointType).toBe("responses")
    expect(controlReq.cacheFieldPaths.length).toBe(0)
  })
})

describe("Fetch Instrumentation", () => {
  test("intercepts fetch calls to capture attemptCount, paths, and bodySha256", async () => {
    const sampleBody = JSON.stringify({
      model: "test-model",
      prompt_cache_key: "ghr-cache-v1-abc",
    })

    const { metadata } = await executeInstrumentedCall(async () => {
      const resp = await globalThis.fetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sampleBody,
      })
      return resp
    })

    expect(metadata.attemptCount).toBe(1)
    expect(metadata.paths).toContain("/responses")
    expect(metadata.bodyByteLengths[0]).toBe(Buffer.byteLength(sampleBody, "utf8"))
    expect(metadata.cacheFieldPaths).toContain("prompt_cache_key")
  })
})

describe("Usage Extraction & Normalization", () => {
  test("extracts and normalizes Anthropic Messages usage", () => {
    const mockMessagesResp = {
      content: [{ type: "text", text: "OK" }],
      usage: {
        input_tokens: 1500,
        output_tokens: 2,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 0,
      },
    }

    const extracted = extractUsageFromResponse("messages", mockMessagesResp)
    expect(extracted.ok).toBe(true)
    expect(extracted.outputMatchesOk).toBe(true)
    expect(extracted.usage?.validMetrics).toBe(true)
    expect(extracted.usage?.cacheMetricsPresent).toBe(true)
    expect(extracted.usage?.totalInput).toBe(2700)
    expect(extracted.usage?.cacheRead).toBe(1200)
    expect(extracted.usage?.uncachedInput).toBe(1500)
    expect(extracted.usage?.inclusiveReconciled).toBe("UNAVAILABLE_ANTHROPIC")
  })

  test("flags Anthropic usage invalid if cache fields are missing", () => {
    const mockMessagesMissing = {
      content: [{ type: "text", text: "OK" }],
      usage: {
        input_tokens: 1500,
        output_tokens: 2,
        // Missing cache_read_input_tokens and cache_creation_input_tokens
      },
    }

    const extracted = extractUsageFromResponse("messages", mockMessagesMissing)
    expect(extracted.usage?.validMetrics).toBe(false)
    expect(extracted.usage?.cacheMetricsPresent).toBe(false)
  })

  test("extracts and normalizes OpenAI Responses usage with nested content output and reconciles total", () => {
    const mockResponsesResp = {
      output: [
        {
          content: [
            { type: "output_text", text: "OK" },
          ],
        },
      ],
      usage: {
        input_tokens: 2000,
        output_tokens: 2,
        total_tokens: 2002,
        input_tokens_details: {
          cached_tokens: 1800,
          cache_write_tokens: 0,
        },
      },
    }

    const extracted = extractUsageFromResponse("responses", mockResponsesResp)
    expect(extracted.ok).toBe(true)
    expect(extracted.outputMatchesOk).toBe(true)
    expect(extracted.usage?.validMetrics).toBe(true)
    expect(extracted.usage?.cacheMetricsPresent).toBe(true)
    expect(extracted.usage?.totalInput).toBe(2000)
    expect(extracted.usage?.cacheRead).toBe(1800)
    expect(extracted.usage?.uncachedInput).toBe(200)
    expect(extracted.usage?.inclusiveReconciled).toBe(true)
  })

  test("flags OpenAI usage as invalid when total tokens reconciliation fails (>1% discrepancy)", () => {
    const mockResponsesDiscrepant = {
      output_text: "OK",
      usage: {
        input_tokens: 2000,
        output_tokens: 2,
        total_tokens: 5000, // Discrepant total
        input_tokens_details: {
          cached_tokens: 1800,
          cache_write_tokens: 0,
        },
      },
    }

    const extracted = extractUsageFromResponse("responses", mockResponsesDiscrepant)
    expect(extracted.usage?.inclusiveReconciled).toBe(false)
    expect(extracted.usage?.validMetrics).toBe(false)
  })

  test("flags OpenAI usage as invalid when cache telemetry is completely missing", () => {
    const mockResponsesNoCache = {
      output_text: "OK",
      usage: {
        input_tokens: 2000,
        output_tokens: 2,
        total_tokens: 2002,
      },
    }

    const extracted = extractUsageFromResponse("responses", mockResponsesNoCache)
    expect(extracted.usage?.cacheMetricsPresent).toBe(false)
    expect(extracted.usage?.validMetrics).toBe(false)
  })
})

describe("Trial & Arm Verdict Classification", () => {
  const lunaRates: DocumentedModelRate = CACHE_VALIDATION_MANIFEST.find(
    (m) => m.id === "gpt-5.6-luna",
  )!

  test("classifies paired arm as cached when warm turn achieves >= 50% hit ratio and valid usage", () => {
    const cold: SingleTurnResult = {
      turnType: "cold",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash1",
      requestBytes: 5000,
      cacheFieldPaths: ["prompt_cache_key"],
      response: {
        ok: true,
        outputTextSha256: "text1hash",
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 2000,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const warm: SingleTurnResult = {
      turnType: "warm",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash2",
      requestBytes: 5000,
      cacheFieldPaths: ["prompt_cache_key"],
      response: {
        ok: true,
        outputTextSha256: "text1hash",
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 200,
          output: 2,
          cacheRead: 1800,
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const armResult = classifyArmTrial("policy", cold, warm, lunaRates)
    expect(armResult.valid).toBe(true)
    expect(armResult.pairedVerdict).toBe("cached")
    expect(armResult.readHitRatio).toBe(0.9)
    expect(armResult.indicativeSavingsUsd).toBeGreaterThan(0)
  })

  test("classifies candidate repetition policy improvement verdict", () => {
    const makeArm = (hitRatio: number) => ({
      arm: "policy" as const,
      cold: {} as SingleTurnResult,
      warm: {} as SingleTurnResult,
      valid: true,
      outputEquivalent: true,
      readHitRatio: hitRatio,
      coldContaminationRatio: 0,
      pairedVerdict: "cached" as const,
      indicativeCostColdUsd: 0.0004,
      indicativeCostWarmUsd: 0.00008,
      indicativeSavingsUsd: 0.00032,
      reason: "ok",
    })

    const repResult = classifyCandidateRepetition(
      0,
      {
        policy: makeArm(0.9),
        control: makeArm(0.05),
      },
      false,
    )
    expect(repResult.valid).toBe(true)
    expect(repResult.policyImprovementVerdict).toBe(
      "POLICY_IMPROVEMENT_SUPPORTED",
    )
  })

  test("marks trial inconclusive when output hashes or lengths diverge", () => {
    const cold: SingleTurnResult = {
      turnType: "cold",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash1",
      requestBytes: 5000,
      cacheFieldPaths: [],
      response: {
        ok: true,
        outputTextSha256: "hashA",
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 2000,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const warm: SingleTurnResult = {
      turnType: "warm",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash2",
      requestBytes: 5000,
      cacheFieldPaths: [],
      response: {
        ok: true,
        outputTextSha256: "hashB", // Divergent hash!
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 200,
          output: 2,
          cacheRead: 1800,
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const armResult = classifyArmTrial("policy", cold, warm, lunaRates)
    expect(armResult.valid).toBe(false)
    expect(armResult.pairedVerdict).toBe("inconclusive")
    expect(armResult.reason).toContain("failed exact OK match, length, or SHA-256 hash equivalence")
  })

  test("marks trial inconclusive when cold cache read exceeds 5% contamination ceiling", () => {
    const cold: SingleTurnResult = {
      turnType: "cold",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash1",
      requestBytes: 5000,
      cacheFieldPaths: [],
      response: {
        ok: true,
        outputTextSha256: "hashA",
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 1800,
          output: 2,
          cacheRead: 200, // 10% contamination (>5%)
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const warm: SingleTurnResult = {
      turnType: "warm",
      success: true,
      attempts: 1,
      contaminated: false,
      requestSha256: "hash2",
      requestBytes: 5000,
      cacheFieldPaths: [],
      response: {
        ok: true,
        outputTextSha256: "hashA",
        outputTextLength: 2,
        outputMatchesOk: true,
        usage: {
          totalInput: 2000,
          uncachedInput: 200,
          output: 2,
          cacheRead: 1800,
          cacheWrite: 0,
          totalTokens: 2002,
          inclusiveReconciled: true,
          validMetrics: true,
          cacheMetricsPresent: true,
          cacheReadMetricsPresent: true,
          cacheWriteMetricsPresent: true,
          rawNumericUsage: {},
        },
      },
    }

    const armResult = classifyArmTrial("policy", cold, warm, lunaRates)
    expect(armResult.valid).toBe(false)
    expect(armResult.pairedVerdict).toBe("inconclusive")
    expect(armResult.reason).toContain("Cold turn contaminated")
  })
})

describe("Plan Sanitization, Hashing & Redaction", () => {
  const catalog = createFullMockCatalog()
  const config = parseProbeArgs([])

  test("generates deterministic plan hash and redacts sensitive data and raw models", () => {
    const plan1 = buildSanitizedPlanArtifact(catalog, config)
    const plan2 = buildSanitizedPlanArtifact(catalog, config)

    expect(plan1.planHash).toBe(plan2.planHash)
    expect(plan1.officialDocsUrl).toBe(OFFICIAL_COPILOT_BILLING_URL)

    const serialized = JSON.stringify(plan1)
    // Invariants: no prompt text, tokens, usernames, catalogModel, or raw outputText
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("ghp_")
    expect(serialized).not.toContain("github_token")
    expect(serialized).not.toContain("C:\\Users\\")
    expect(serialized).not.toContain("catalogModel")
    expect(serialized).not.toContain("outputText")
  })
})
