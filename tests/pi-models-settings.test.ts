import { describe, expect, test } from "bun:test"

import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "~/lib/pi-extension"
import {
  buildPiAgentFiles,
  buildPiAppendSystem,
  buildPiModelsJson,
  buildPiSettingsJson,
  derivePiCompactionSettings,
  PI_PROFILE_CONTEXT_TOKENS,
  piAdvisorModel,
  piLeadModel,
  piLeadThinking,
  piNativeRoles,
  piOracleModel,
  piProfileModelIds,
} from "~/lib/pi-models-settings"

describe("pi cheapest profile", () => {
  test("Luna/max lead, all roles bare 200K", () => {
    expect(piLeadModel("cheapest")).toBe("gpt-6-luna")
    expect(piLeadThinking("cheapest")).toBe("max")
    expect(PI_PROFILE_CONTEXT_TOKENS).toBe(200_000)
    for (const id of piProfileModelIds("cheapest")) {
      expect(id).not.toContain("[1m]")
    }
  })

  test("Sol advisor present (medium), Sol oracle (high)", () => {
    expect(piAdvisorModel("cheapest")).toEqual({
      model: "gpt-6-sol",
      thinking: "medium",
    })
    expect(piOracleModel("cheapest")).toBe("gpt-6-sol")
  })

  test("three-agent roster, no Plan", () => {
    const names = piNativeRoles("cheapest").map((r) => r.name)
    expect(names).toEqual(["Explore", "General-Purpose", "reviewer"])
  })

  test("agent files include advisor", () => {
    const files = buildPiAgentFiles("cheapest")
    const keys = Object.keys(files)
    expect(keys.some((k) => k.includes("advisor"))).toBe(true)
    expect(keys.some((k) => k.includes("oracle"))).toBe(true)
    // Every agent pins the gh-router provider and a thinking level.
    for (const content of Object.values(files)) {
      expect(content).toContain("model: gh-router/")
      expect(content).toContain("thinking: ")
      expect(content).not.toContain("[1m]")
    }
  })
})

describe("pi balanced profile", () => {
  test("Sol/medium lead", () => {
    expect(piLeadModel("balanced")).toBe("gpt-6-sol")
    expect(piLeadThinking("balanced")).toBe("medium")
  })

  test("advisor-free by design across every surface", () => {
    expect(piAdvisorModel("balanced")).toBeUndefined()
    const files = buildPiAgentFiles("balanced")
    expect(Object.keys(files).some((k) => k.includes("advisor"))).toBe(false)
    for (const content of Object.values(files)) {
      expect(content.toLowerCase()).not.toContain("advisor")
    }
    expect(buildPiSkills("balanced").some((s) => s.dir.includes("advisor"))).toBe(
      false,
    )
    expect(buildPiPrompts("balanced").some((p) => p.name.includes("plan-review"))).toBe(
      false,
    )
    expect(buildPiAppendSystem("balanced")).toContain("no advisor")
    const ext = buildPiExtensionSource({
      profileId: "balanced",
      searchEnabled: true,
      browseEnabled: true,
    })
    expect(ext).not.toContain("advisor")
  })

  test("reviewer may delegate Explore", () => {
    const files = buildPiAgentFiles("balanced")
    const reviewer = files["agents/reviewer.md"]
    expect(reviewer).toContain("allowedAgents: [Explore]")
  })
})

describe("pi models.json", () => {
  test("single gh-router OpenAI-compatible provider, tier windows, bare rows", () => {
    const windows: Record<string, number> = {
      "gpt-6-luna": 272_000,
      "gpt-6-sol": 272_000,
      "grok-4.6": 200_000,
    }
    for (const profile of ["cheapest", "balanced"] as const) {
      const json = buildPiModelsJson({
        serverUrl: "http://127.0.0.1:8787",
        profileId: profile,
      })
      const provider = json.providers["gh-router"]
      expect(provider.baseUrl).toBe("http://127.0.0.1:8787/v1")
      expect(provider.api).toBe("openai-completions")
      expect(provider.models.length).toBeGreaterThan(0)
      for (const m of provider.models) {
        expect(m.contextWindow).toBe(windows[m.id] ?? 200_000)
        expect(m.reasoning).toBe(true)
        expect(m.id).not.toContain("[1m]")
      }
    }
  })

  test("window is capped at the advertised catalog total", () => {
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 200_000, maxPromptTokens: 150_000, efforts: ["max"], endpoints: ["responses"] },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["responses"] },
      ],
    })
    const rows = Object.fromEntries(
      json.providers["gh-router"].models.map((m) => [m.id, m.contextWindow]),
    )
    expect(rows["gpt-6-luna"]).toBe(200_000)
    expect(rows["gpt-6-sol"]).toBe(272_000)
  })
})

describe("pi settings.json", () => {
  test("narrow scope, limited tools, retry on", () => {
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(settings.defaultProvider).toBe("gh-router")
    expect(settings.defaultModel).toBe("gpt-6-luna")
    expect(settings.enabledModels).toContain("gh-router/gpt-6-luna")
    expect(settings.defaultTools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ])
    expect(settings.retry).toEqual({ enabled: true, maxRetries: 3 })
    expect(settings.packages).toContain("npm:pi-subagents")
    expect(settings.packages).toContain("npm:pi-statusline")
  })
})

describe("pi compaction derivation", () => {
  const catalog = [
    { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, efforts: ["high", "max"], endpoints: ["responses"] },
    { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["responses"] },
    { id: "grok-4.6", maxContextTokens: 500_000, maxPromptTokens: 300_000, efforts: ["medium"], endpoints: ["responses"] },
  ]

  test("reserve keeps the trigger below tier cliff and prompt ceiling", () => {
    const s = derivePiCompactionSettings(catalog, ["gpt-6-luna", "gpt-6-sol"])
    // windows 272K/272K; ceilings min(922000,272000)=272000 and
    // min(400000,272000)=272000 -> trigger floor(272000*0.85)=231200,
    // reserve 272000-231200=40800. Trigger sits below the 272K price
    // cliff AND every prompt ceiling.
    expect(s.reserveTokens).toBe(40_800)
    expect(s.keepRecentTokens).toBe(20_000)
    expect(s.enabled).toBe(true)
    expect(s.modelOverrides["gh-router/gpt-6-luna"].reserveTokens).toBe(40_800)
  })

  test("tight ceiling raises the reserve", () => {
    const tight = [
      { id: "gpt-6-luna", maxContextTokens: 200_000, maxPromptTokens: 150_000, efforts: ["max"], endpoints: ["responses"] },
    ]
    const s = derivePiCompactionSettings(tight, ["gpt-6-luna"])
    // floor(150000*0.85)=127500 -> reserve 200000-127500=72500
    expect(s.reserveTokens).toBe(72_500)
    expect(s.modelOverrides["gh-router/gpt-6-luna"].reserveTokens).toBe(72_500)
  })

  test("unknown catalog falls back to Pi built-in defaults (never disables)", () => {
    const s = derivePiCompactionSettings(undefined, ["gpt-6-luna"])
    expect(s).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
      modelOverrides: {},
    })
  })
})

describe("pi extension source", () => {
  test("oracle always; advisor/search/browse gated", () => {
    const base = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(base).toContain('"oracle"')
    expect(base).toContain('"advisor"')
    expect(base).not.toContain("code_search")
    expect(base).not.toContain("browser_open_tab")

    const full = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: true,
    })
    expect(full).toContain("code_search")
    expect(full).toContain("browser_open_tab")
    // Compaction stays native; the hook only observes.
    expect(full).toContain("session_before_compact")
    // No [1m] accounting anywhere.
    expect(full).not.toContain("[1m]")
  })

  test("follows Pi's TypeBox registerTool contract", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: true,
    })
    // TypeBox object schemas under `parameters` (Pi rejects plain JSON dicts).
    expect(src).toContain('import { Type } from "typebox"')
    expect(src).toContain("parameters: OracleParams")
    expect(src).toContain("parameters: AdvisorParams")
    expect(src).toContain("parameters: CodeSearchParams")
    expect(src).toContain("parameters: BrowserParams")
    expect(src).not.toContain("inputSchema")
    // execute(toolCallId, params, signal) returning { content, details }.
    expect(src).toContain("async execute(_toolCallId, params, signal)")
    expect(src).toContain("content: [{ type: \"text\", text")
    expect(src).toContain("details: undefined")
    expect(src).not.toContain("ctx.signal")
    expect(src).not.toContain("async execute(args, ctx)")
  })
})
