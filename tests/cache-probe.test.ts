/**
 * Unit tests for the pure helpers backing scripts/probe-prompt-cache.ts.
 * No live model calls, no child process spawning, no network access —
 * see src/lib/cache-probe.ts for what's under test.
 */

import { describe, expect, test } from "bun:test"

import {
  buildCacheProbeClaudeArgs,
  buildCacheProbeTurns,
  buildDeterministicSystemPrefix,
  buildGrowingHistoryTurns,
  buildStreamJsonUserLine,
  cacheOracleClassFor,
  collectCacheProbeSamples,
  computeCacheProbeExitDecision,
  computeCacheProbeRollup,
  computeCacheProbeVerdict,
  DEFAULT_SYSTEM_PREFIX_CHARS,
  EXACT_CACHE_PROBE_TARGETS,
  isCacheProbeResultEvent,
  LARGE_SYSTEM_PREFIX_CHARS,
  parseCacheProbeResultUsage,
  randomSaltHex,
  selectCacheProbeTargets,
  systemPrefixCharsFor,
} from "~/lib/cache-probe"
import type { Model } from "~/services/copilot/get-models"

function makeModel(
  id: string,
  contextWindow?: number,
  promptWindow?: number,
): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test-vendor",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "test",
      type: "chat",
      limits:
        contextWindow === undefined && promptWindow === undefined
          ? undefined
          : {
              ...(contextWindow === undefined ? {} : { max_context_window_tokens: contextWindow }),
              ...(promptWindow === undefined ? {} : { max_prompt_tokens: promptWindow }),
            },
    },
  }
}

describe("selectCacheProbeTargets", () => {
  test("resolves every exact target present in the catalog", () => {
    const catalog = EXACT_CACHE_PROBE_TARGETS.map((id) => makeModel(id, 1_000_000))
    const selection = selectCacheProbeTargets(catalog)
    for (const id of EXACT_CACHE_PROBE_TARGETS) {
      const target = selection.targets.find((t) => t.requestedId === id)
      expect(target?.found).toBe(true)
      expect(target?.catalogId).toBe(id)
      expect(target?.contextWindow).toBe(1_000_000)
    }
    expect(selection.missing).not.toContain("claude-opus-5")
  })

  test("reports missing exact targets honestly rather than substituting", () => {
    const selection = selectCacheProbeTargets([makeModel("claude-opus-5", 1_000_000)])
    expect(selection.missing).toContain("claude-haiku-4.5")
    expect(selection.missing).toContain("gpt-5.6-sol")
    expect(selection.missing).toContain("gpt-5.6-terra")
    expect(selection.missing).toContain("gpt-5.6-luna")
    expect(selection.missing).toContain("gemini-3.7-flash")
    const gptSol = selection.targets.find((t) => t.requestedId === "gpt-5.6-sol")
    expect(gptSol?.found).toBe(false)
    expect(gptSol?.catalogId).toBeUndefined()
  })

  test("picks the highest-effective-input-window grok-4.6* sibling, not just the first match", () => {
    const catalog = [
      makeModel("grok-4.6-mini", 128_000),
      makeModel("grok-4.6", 500_000),
      makeModel("grok-4.6-fast", 300_000),
      // Must NOT match: different family.
      makeModel("grok-4.5", 1_000_000),
    ]
    const selection = selectCacheProbeTargets(catalog)
    const grok = selection.targets.find((t) => t.requestedId === "grok-4.6*")
    expect(grok?.found).toBe(true)
    expect(grok?.catalogId).toBe("grok-4.6")
    expect(grok?.contextWindow).toBe(500_000)
  })

  test("uses the stricter prompt ceiling when choosing a grok sibling", () => {
    const catalog = [
      makeModel("grok-4.6-wide", 1_000_000, 180_000),
      makeModel("grok-4.6", 500_000, 372_000),
    ]
    const selection = selectCacheProbeTargets(catalog)
    const grok = selection.targets.find((t) => t.requestedId === "grok-4.6*")
    expect(grok?.catalogId).toBe("grok-4.6")
    expect(grok?.contextWindow).toBe(372_000)
  })

  test("grok wildcard is honestly reported missing when no grok-4.6* sibling exists", () => {
    const selection = selectCacheProbeTargets([makeModel("grok-4.5", 1_000_000)])
    const grok = selection.targets.find((t) => t.requestedId === "grok-4.6*")
    expect(grok?.found).toBe(false)
    expect(selection.missing).toContain("grok-4.6*")
  })
})

describe("cacheOracleClassFor", () => {
  test("native Claude and the gpt-5.6 family are strict", () => {
    expect(cacheOracleClassFor("claude-opus-5")).toBe("strict")
    expect(cacheOracleClassFor("claude-sonnet-5")).toBe("strict")
    expect(cacheOracleClassFor("gpt-5.6-sol")).toBe("strict")
    expect(cacheOracleClassFor("gpt-5.6-terra")).toBe("strict")
    expect(cacheOracleClassFor("gpt-5.6-luna")).toBe("strict")
    expect(cacheOracleClassFor("gpt-5.6")).toBe("strict")
  })

  test("gemini, grok, and non-5.6 gpt families are provider-managed", () => {
    expect(cacheOracleClassFor("gemini-3.7-flash")).toBe("provider-managed")
    expect(cacheOracleClassFor("grok-4.6")).toBe("provider-managed")
    // Boundary case: gpt-5.5 must NOT match the gpt-5.6 prefix check.
    expect(cacheOracleClassFor("gpt-5.5")).toBe("provider-managed")
    expect(cacheOracleClassFor("gpt-5.3-codex")).toBe("provider-managed")
  })
})

describe("parseCacheProbeResultUsage", () => {
  test("extracts usage from a top-level result event", () => {
    const line = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 26,
        cache_creation_input_tokens: 44,
        cache_read_input_tokens: 7566,
        output_tokens: 12,
      },
    })
    const sample = parseCacheProbeResultUsage(line)
    expect(sample).toEqual({
      inputTokens: 26,
      cacheCreationInputTokens: 44,
      cacheReadInputTokens: 7566,
      outputTokens: 12,
    })
  })

  test("ignores a subagent's own result event (parent_tool_use_id set)", () => {
    const line = JSON.stringify({
      type: "result",
      parent_tool_use_id: "toolu_123",
      usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
    })
    expect(parseCacheProbeResultUsage(line)).toBeUndefined()
  })

  test("ignores non-JSON launch/log noise", () => {
    expect(parseCacheProbeResultUsage("github-router v0.3.288")).toBeUndefined()
    expect(parseCacheProbeResultUsage("")).toBeUndefined()
  })

  test("ignores non-result event types, including assistant", () => {
    expect(parseCacheProbeResultUsage(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1 } } }))).toBeUndefined()
    expect(parseCacheProbeResultUsage(JSON.stringify({ type: "system" }))).toBeUndefined()
  })

  test("returns undefined when the result event carries no usage", () => {
    const line = JSON.stringify({ type: "result" })
    expect(parseCacheProbeResultUsage(line)).toBeUndefined()
  })

  test("drops non-numeric usage subfields rather than coercing them", () => {
    const line = JSON.stringify({
      type: "result",
      usage: { input_tokens: "26", cache_read_input_tokens: null },
    })
    const sample = parseCacheProbeResultUsage(line)
    expect(sample?.inputTokens).toBeUndefined()
    expect(sample?.cacheReadInputTokens).toBeUndefined()
  })

  test("REGRESSION: an all-zero assistant placeholder followed by a nonzero result yields exactly one nonzero sample", () => {
    // Reproduces the live defect: for translated (non-Claude) models,
    // assistant.message.usage is a synthesized all-zero placeholder, while
    // the real numbers only ever reach the client on the result event.
    const assistantZeroLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    })
    const resultNonzeroLine = JSON.stringify({
      type: "result",
      usage: { input_tokens: 3, cache_creation_input_tokens: 1_140, cache_read_input_tokens: 0, output_tokens: 8 },
    })
    const samples = collectCacheProbeSamples([assistantZeroLine, resultNonzeroLine])
    expect(samples).toHaveLength(1)
    expect(samples[0]).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 1_140,
      cacheReadInputTokens: 0,
      outputTokens: 8,
    })
  })
})

describe("isCacheProbeResultEvent", () => {
  test("recognizes a top-level result event", () => {
    expect(isCacheProbeResultEvent(JSON.stringify({ type: "result", usage: {} }))).toBe(true)
    // Counts even without a usable usage field — see resultEventCount's
    // doc comment in scripts/probe-prompt-cache.ts.
    expect(isCacheProbeResultEvent(JSON.stringify({ type: "result" }))).toBe(true)
  })
  test("rejects everything else, including assistant events", () => {
    expect(isCacheProbeResultEvent(JSON.stringify({ type: "assistant" }))).toBe(false)
    expect(isCacheProbeResultEvent("not json")).toBe(false)
  })
})

describe("computeCacheProbeVerdict", () => {
  test("AMBIGUOUS when the observed sample count doesn't match expectedTurns", () => {
    const result = computeCacheProbeVerdict("strict", [{ inputTokens: 1 }], 2)
    expect(result.verdict).toBe("AMBIGUOUS")
    expect(result.reason).toContain("expected 2")
  })

  test("AMBIGUOUS when expectedTurns is below 2", () => {
    expect(computeCacheProbeVerdict("strict", [], 1).verdict).toBe("AMBIGUOUS")
  })

  test("strict PASS on the real cold/warm figures from a live controlled trial", () => {
    // cold: cache_creation=7566 cache_read=0 input=26; warm: cache_creation=44 cache_read=7566 input=26
    const cold = { inputTokens: 26, cacheCreationInputTokens: 7_566, cacheReadInputTokens: 0 }
    const warm = { inputTokens: 26, cacheCreationInputTokens: 44, cacheReadInputTokens: 7_566 }
    const result = computeCacheProbeVerdict("strict", [cold, warm], 2)
    expect(result.verdict).toBe("PASS")
    expect(result.coldTotalInputTokens).toBe(26 + 7_566 + 0)
    // Per-turn ratio: the warm turn's OWN total (26 + 44 + 7566), not the
    // cold turn's total — see computeCacheProbeVerdict's doc comment on why
    // a fixed cold-denominator would misreport a growing conversation.
    expect(result.cacheCoverageRatio).toBeCloseTo((7_566 + 44) / (26 + 44 + 7_566), 3)
  })

  test("strict FAIL when warm cache_read is 0 despite metrics being present", () => {
    const cold = { inputTokens: 10, cacheCreationInputTokens: 500, cacheReadInputTokens: 0 }
    const warm = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    const result = computeCacheProbeVerdict("strict", [cold, warm], 2)
    expect(result.verdict).toBe("FAIL")
  })

  test("strict FAIL when cache fields are entirely absent (never INCONCLUSIVE for native/gpt-5.6)", () => {
    const cold = { inputTokens: 10 }
    const warm = { inputTokens: 10 }
    const result = computeCacheProbeVerdict("strict", [cold, warm], 2)
    expect(result.verdict).toBe("FAIL")
  })

  test("provider-managed INCONCLUSIVE when cache fields are absent", () => {
    const cold = { inputTokens: 10 }
    const warm = { inputTokens: 10 }
    const result = computeCacheProbeVerdict("provider-managed", [cold, warm], 2)
    expect(result.verdict).toBe("INCONCLUSIVE")
  })

  test("provider-managed FAIL when fields are present but read stays 0", () => {
    const cold = { inputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 0 }
    const warm = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    const result = computeCacheProbeVerdict("provider-managed", [cold, warm], 2)
    expect(result.verdict).toBe("FAIL")
  })

  test("provider-managed records positive partial reuse without imposing the strict threshold", () => {
    const cold = { inputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 0 }
    const warm = { inputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 90 }
    const result = computeCacheProbeVerdict("provider-managed", [cold, warm], 2)
    expect(result.verdict).toBe("PASS")
    expect(result.cacheCoverageRatio).toBeCloseTo((90 + 5) / 105, 5)
    expect(result.reason).toContain("provider-managed")
  })

  test("provider-managed PASS when read coverage meets the threshold", () => {
    const cold = { inputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 0 }
    const warm = { inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 95 }
    const result = computeCacheProbeVerdict("provider-managed", [cold, warm], 2)
    expect(result.verdict).toBe("PASS")
    expect(result.cacheCoverageRatio).toBeCloseTo(0.95, 5)
  })

  test("multiple warm turns average the PER-TURN cache coverage ratio, and a weak later turn can still fail the run", () => {
    const cold = { inputTokens: 0, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 0 }
    // Fully covered: 1000/1000 = 1.0
    const warmA = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000 }
    // Not covered at all despite metrics being present: 0/1000 = 0
    const warmB = { inputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    const result = computeCacheProbeVerdict("strict", [cold, warmA, warmB], 3)
    expect(result.cacheCoverageRatio).toBeCloseTo(0.5, 5)
    // Mean 0.5 is below the default 0.9 threshold — FAIL, not laundered
    // into a PASS by averaging against a strong first warm turn.
    expect(result.verdict).toBe("FAIL")
  })
})

describe("buildDeterministicSystemPrefix", () => {
  test("returns exactly targetChars characters", () => {
    expect(buildDeterministicSystemPrefix(500)).toHaveLength(500)
    expect(buildDeterministicSystemPrefix(10_000)).toHaveLength(10_000)
  })

  test("is deterministic across calls", () => {
    expect(buildDeterministicSystemPrefix(1_234)).toBe(buildDeterministicSystemPrefix(1_234))
  })

  test("returns empty string for a non-positive target", () => {
    expect(buildDeterministicSystemPrefix(0)).toBe("")
    expect(buildDeterministicSystemPrefix(-5)).toBe("")
  })
})

describe("randomSaltHex", () => {
  test("returns byteLength*2 hex characters", () => {
    const salt = randomSaltHex(16)
    expect(salt).toHaveLength(32)
    expect(/^[0-9a-f]+$/.test(salt)).toBe(true)
  })

  test("is fresh on every call", () => {
    expect(randomSaltHex()).not.toBe(randomSaltHex())
  })
})

describe("buildStreamJsonUserLine / buildCacheProbeTurns", () => {
  test("produces a valid single-line JSON user turn", () => {
    const line = buildStreamJsonUserLine("hello")
    expect(line.includes("\n")).toBe(false)
    const parsed = JSON.parse(line) as { type: string, message: { role: string, content: string } }
    expect(parsed).toEqual({ type: "user", message: { role: "user", content: "hello" } })
  })

  test("builds turnCount turns, each embedding the salt and forbidding tools", () => {
    const turns = buildCacheProbeTurns("deadbeef", 3)
    expect(turns).toHaveLength(3)
    for (const turn of turns) {
      expect(turn).toContain("deadbeef")
      expect(turn.toLowerCase()).toContain("do not call or use any tools")
    }
  })
})

describe("buildCacheProbeClaudeArgs", () => {
  test("controlled trial disables tools/MCP and carries the system prefix", () => {
    const args = buildCacheProbeClaudeArgs({
      modelId: "gpt-5.6-sol",
      controlled: true,
      systemPrefix: "PREFIX-TEXT",
    })
    expect(args).toContain("-m")
    expect(args).toContain("gpt-5.6-sol")
    expect(args).toContain("--no-auto-update")
    expect(args).toContain("--no-self-update")
    expect(args).toContain("--no-update-check")
    expect(args).toContain("--no-stop-gate")
    expect(args).toContain("--")
    expect(args).toContain("--print")
    expect(args).toContain("--input-format")
    expect(args).toContain("--output-format")
    expect(args).toContain("--verbose")
    expect(args).toContain("--no-session-persistence")
    expect(args).toContain("--tools")
    expect(args).toContain("--strict-mcp-config")
    expect(args).toContain("--system-prompt")
    expect(args).toContain("PREFIX-TEXT")
    // No --resume/--continue anywhere.
    expect(args.some((a) => a.includes("resume") || a.includes("continue"))).toBe(false)
  })

  test("authentic native-Claude trial keeps the default toolset and system prompt", () => {
    for (const modelId of ["claude-opus-5", "claude-haiku-4.5"]) {
      const args = buildCacheProbeClaudeArgs({ modelId, controlled: false })
      expect(args).not.toContain("--tools")
      expect(args).not.toContain("--strict-mcp-config")
      expect(args).not.toContain("--system-prompt")
      expect(args).not.toContain("--bare")
      expect(args).not.toContain("--safe-mode")
    }
  })

  test("forwards --max-budget-usd only when provided", () => {
    const withCap = buildCacheProbeClaudeArgs({ modelId: "gpt-5.6-luna", controlled: true, maxBudgetUsd: "0.50" })
    expect(withCap).toContain("--max-budget-usd")
    expect(withCap).toContain("0.50")
    const withoutCap = buildCacheProbeClaudeArgs({ modelId: "gpt-5.6-luna", controlled: true })
    expect(withoutCap).not.toContain("--max-budget-usd")
  })
})

describe("systemPrefixCharsFor", () => {
  test("gives Haiku, Gemini, and Grok the larger prefix by default", () => {
    expect(systemPrefixCharsFor("claude-haiku-4.5")).toBe(LARGE_SYSTEM_PREFIX_CHARS)
    expect(systemPrefixCharsFor("gemini-3.7-flash")).toBe(LARGE_SYSTEM_PREFIX_CHARS)
    expect(systemPrefixCharsFor("grok-4.6")).toBe(LARGE_SYSTEM_PREFIX_CHARS)
  })

  test("gives Opus and every gpt-5.6 tier the default prefix", () => {
    expect(systemPrefixCharsFor("claude-opus-5")).toBe(DEFAULT_SYSTEM_PREFIX_CHARS)
    expect(systemPrefixCharsFor("gpt-5.6-sol")).toBe(DEFAULT_SYSTEM_PREFIX_CHARS)
    expect(systemPrefixCharsFor("gpt-5.6-terra")).toBe(DEFAULT_SYSTEM_PREFIX_CHARS)
    expect(systemPrefixCharsFor("gpt-5.6-luna")).toBe(DEFAULT_SYSTEM_PREFIX_CHARS)
  })

  test("an explicit override always wins, for every model", () => {
    expect(systemPrefixCharsFor("gemini-3.7-flash", 1_234)).toBe(1_234)
    expect(systemPrefixCharsFor("claude-opus-5", 1_234)).toBe(1_234)
  })
})

describe("buildGrowingHistoryTurns", () => {
  test("builds turnCount turns, each with its own salted chunk of chunkChars", () => {
    const turns = buildGrowingHistoryTurns("cafef00d", 4, 500)
    expect(turns).toHaveLength(4)
    turns.forEach((turn, i) => {
      expect(turn).toContain(`cafef00d-${i}`)
      expect(turn.toLowerCase()).toContain("do not call or use any tools")
      // Each turn carries its own ~500-char deterministic block, not just
      // the short reply instruction.
      expect(turn.length).toBeGreaterThan(500)
    })
  })
})

describe("computeCacheProbeRollup", () => {
  test("rolls up to the single shared verdict when every trial agrees", () => {
    expect(computeCacheProbeRollup(["PASS", "PASS", "PASS"])).toBe("PASS")
    expect(computeCacheProbeRollup(["FAIL", "FAIL"])).toBe("FAIL")
  })

  test("rolls up to MIXED when trials disagree", () => {
    expect(computeCacheProbeRollup(["PASS", "FAIL"])).toBe("MIXED")
  })

  test("MUST include authentic/growing verdicts, not just controlled ones — regression guard", () => {
    // This is the exact defect the coordinator flagged: a rollup computed
    // from controlled trials ALONE would read "PASS" here even though the
    // growing-history trial (index 2) FAILed.
    const controlled: Array<"PASS"> = ["PASS", "PASS", "PASS"]
    const authentic = "PASS" as const
    const growing = "FAIL" as const
    const controlledOnlyRollup = computeCacheProbeRollup(controlled)
    const fullRollup = computeCacheProbeRollup([...controlled, authentic, growing])
    expect(controlledOnlyRollup).toBe("PASS")
    expect(fullRollup).toBe("MIXED")
    expect(fullRollup).not.toBe(controlledOnlyRollup)
  })

  test("empty input rolls up to AMBIGUOUS, never a silent PASS", () => {
    expect(computeCacheProbeRollup([])).toBe("AMBIGUOUS")
  })
})

describe("computeCacheProbeExitDecision", () => {
  test("all-PASS exits 0 with no warning", () => {
    const decision = computeCacheProbeExitDecision(["PASS", "PASS", "PASS"])
    expect(decision.exitCode).toBe(0)
    expect(decision.warning).toBeUndefined()
  })

  test("any FAIL exits 1, even among mostly-PASS trials", () => {
    const decision = computeCacheProbeExitDecision(["PASS", "PASS", "FAIL"])
    expect(decision.exitCode).toBe(1)
  })

  test("any AMBIGUOUS exits 1", () => {
    const decision = computeCacheProbeExitDecision(["PASS", "AMBIGUOUS"])
    expect(decision.exitCode).toBe(1)
  })

  test("INCONCLUSIVE alone (no FAIL/AMBIGUOUS) exits 0 but carries a clear warning", () => {
    const decision = computeCacheProbeExitDecision(["PASS", "INCONCLUSIVE"])
    expect(decision.exitCode).toBe(0)
    expect(decision.warning).toBeDefined()
    expect(decision.warning?.toLowerCase()).toContain("inconclusive")
  })

  test("FAIL/AMBIGUOUS takes precedence over an INCONCLUSIVE also being present", () => {
    const decision = computeCacheProbeExitDecision(["INCONCLUSIVE", "FAIL"])
    expect(decision.exitCode).toBe(1)
    // The exit code is what a caller scripts against; the FAIL/AMBIGUOUS
    // branch does not also need to fabricate a warning string.
  })

  test("empty input exits 1 with a warning — an all-missing run is a failure, never a silent pass", () => {
    const decision = computeCacheProbeExitDecision([])
    expect(decision.exitCode).toBe(1)
    expect(decision.warning).toBeDefined()
  })

  test("regression guard: a script that only checked the per-model rollup could miss a FAIL the flat exit decision catches", () => {
    // Mirrors the exact bug: model rollup across controlled trials alone
    // reads PASS, but the flat list (which MUST include the growing trial)
    // still drives exitCode to 1.
    const controlledOnlyRollup = computeCacheProbeRollup(["PASS", "PASS", "PASS"])
    const flatVerdicts = ["PASS", "PASS", "PASS", "FAIL"] as const
    expect(controlledOnlyRollup).toBe("PASS")
    expect(computeCacheProbeExitDecision(flatVerdicts).exitCode).toBe(1)
  })
})
