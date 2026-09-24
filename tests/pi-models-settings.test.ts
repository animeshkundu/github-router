import { describe, expect, test } from "bun:test"

import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "~/lib/pi-extension"
import {
  applyCosmeticUserOverrides,
  buildPiAgentFiles,
  buildPiAppendSystem,
  buildPiModelsJson,
  buildPiSettingsJson,
  derivePiCompactionSettings,
  PI_HELPERS_AGENT_EXTENSIONS,
  PI_HELPERS_MCP_ADAPTER,
  PI_HELPERS_WEB_ACCESS,
  PI_IMAGE_RESIZE_MAX_BYTES,
  piAdvisorModel,
  piApiForEndpoints,
  piImageResizeFor,
  piLeadModel,
  piLeadThinking,
  piNativeRoles,
  piOracleModel,
  piProfileModelIds,
  piThinkingLevelMapFor,
  piUsdCostFor,
  PI_MAX_TOKENS_FALLBACK,
  PI_PROFILE_CONTEXT_TOKENS,
} from "~/lib/pi-models-settings"
import { EFFORT_ORDER } from "~/lib/reasoning-effort"

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
    expect(
      buildPiSkills({ profileId: "balanced", peers: true, swe: true }).some((s) =>
        s.dir.includes("advisor"),
      ),
    ).toBe(false)
    expect(
      buildPiPrompts({ profileId: "balanced", swe: true }).some((p) =>
        p.name.includes("plan-review"),
      ),
    ).toBe(false)
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
    expect(reviewer).toContain("allowedAgents: Explore")
  })
})

describe("pi models.json", () => {
  test("Responses provider (roster is Responses-only), tier windows, bare rows", () => {
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
      // Luna/Sol/Grok serve /v1/responses only; chat completions is a
      // Copilot 400 for them (observed live).
      expect(provider.api).toBe("openai-responses")
      expect(provider.apiKey).toBe("dummy")
      expect(provider.authHeader).toBe(true)
      expect(provider.models.length).toBeGreaterThan(0)
      for (const m of provider.models) {
        expect(m.contextWindow).toBe(windows[m.id] ?? 200_000)
        expect(m.reasoning).toBe(true)
        expect(m.id).not.toContain("[1m]")
        expect(m.maxTokens).toBeGreaterThanOrEqual(16)
        expect(m.api).toBeUndefined()
      }
    }
  })

  test("maxTokens from catalog, floored, with fallback; cost passthrough; api override", () => {
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, maxOutputTokens: 128_000, efforts: ["max"], endpoints: ["responses"], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["responses"] },
      ],
      apiOverrides: { "gpt-6-sol": "openai-completions" },
    })
    const rows = Object.fromEntries(
      json.providers["gh-router"].models.map((m) => [m.id, m]),
    )
    expect(rows["gpt-6-luna"].maxTokens).toBe(128_000)
    expect(rows["gpt-6-luna"].cost).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    })
    expect(rows["gpt-6-luna"].api).toBeUndefined()
    // No output metadata -> documented fallback (proxy floor is 16).
    expect(rows["gpt-6-sol"].maxTokens).toBe(PI_MAX_TOKENS_FALLBACK)
    expect(rows["gpt-6-sol"].cost).toBeUndefined()
    expect(rows["gpt-6-sol"].api).toBe("openai-completions")
  })

  test("emitted lead triple is proxy-acceptable on /v1/responses", () => {
    // Contract: what Pi sends for the lead (model + thinking effort +
    // output cap) must pass the proxy's responses guards with no
    // translation: recognized effort tier, output floor, bare slug.
    for (const profile of ["cheapest", "balanced"] as const) {
      const json = buildPiModelsJson({
        serverUrl: "http://127.0.0.1:8787",
        profileId: profile,
        catalog: [
          { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, maxOutputTokens: 128_000, efforts: ["max"], endpoints: ["responses"] },
          { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, maxOutputTokens: 64_000, efforts: ["medium", "high"], endpoints: ["responses"] },
          { id: "grok-4.6", maxContextTokens: 500_000, maxPromptTokens: 300_000, maxOutputTokens: 128_000, efforts: ["medium"], endpoints: ["responses"] },
        ],
      })
      const provider = json.providers["gh-router"]
      expect(provider.api).toBe("openai-responses")
      for (const m of provider.models) {
        // Effort Pi will send (modelThinkingLevels/agent thinking resolve
        // to these) must be a recognized Copilot tier — direct
        // /v1/responses performs no bucketing or clamping.
        const thinking =
          m.id === provider.models[0].id
            ? piLeadThinking(profile)
            : undefined
        if (thinking !== undefined) {
          expect(EFFORT_ORDER as ReadonlyArray<string>).toContain(thinking)
        }
        expect(m.maxTokens).toBeGreaterThanOrEqual(16)
        expect(m.id).not.toContain("[1m]")
      }
    }
  })

  test("cost is all-or-nothing: partial figures omit the object", () => {
    // Pi quirk (verified live): a partial cost object silently rejects
    // the whole provider ("Unknown provider"). Never guess zero.
    const full = {
      batch_size: 1_000_000,
      input_price: 10_000_000_000,
      output_price: 50_000_000_000,
      cache_read_price: 1_000_000_000,
      cache_write_price: 12_500_000_000,
    }
    expect(piUsdCostFor(full)).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    })
    const { cache_write_price: dropped, ...partial } = full
    expect(dropped).toBe(12_500_000_000)
    expect(piUsdCostFor(partial)).toBeUndefined()
    expect(piUsdCostFor(undefined)).toBeUndefined()
    expect(piUsdCostFor({ batch_size: 0, input_price: 1 })).toBeUndefined()
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

describe("pi models.json vision + thinking + api parity", () => {
  test("vision fail-open: unknown advertises image, explicit false is text-only", () => {
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, efforts: ["max"], endpoints: ["responses"], vision: true },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["responses"], vision: false },
      ],
    })
    const rows = Object.fromEntries(
      json.providers["gh-router"].models.map((m) => [m.id, m]),
    )
    expect(rows["gpt-6-luna"].input).toEqual(["text", "image"])
    expect(rows["gpt-6-sol"].input).toEqual(["text"])
    // No catalog entry at all also fails open (preflight is the backstop).
    const bare = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
    })
    for (const m of bare.providers["gh-router"].models) {
      expect(m.input).toEqual(["text", "image"])
    }
  })

  test("thinkingLevelMap mirrors the catalog effort allowlist", () => {
    expect(piThinkingLevelMapFor(["high"])).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    })
    expect(piThinkingLevelMapFor([])).toBeUndefined()
    expect(piThinkingLevelMapFor(undefined)).toBeUndefined()
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, efforts: ["max"], endpoints: ["responses"] },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: [], endpoints: ["responses"] },
      ],
    })
    const rows = Object.fromEntries(
      json.providers["gh-router"].models.map((m) => [m.id, m]),
    )
    expect(rows["gpt-6-luna"].thinkingLevelMap?.["max"]).toBe("max")
    expect(rows["gpt-6-luna"].thinkingLevelMap?.["low"]).toBeNull()
    expect(rows["gpt-6-sol"].thinkingLevelMap).toBeUndefined()
  })

  test("inputLimits resize is conservative and clamps to small catalog limits", () => {
    const resize = piImageResizeFor(true, 3 * 1024 * 1024)
    expect(resize?.images?.resize?.maxWidth).toBe(1568)
    expect(resize?.images?.resize?.maxBytes).toBe(PI_IMAGE_RESIZE_MAX_BYTES)
    // Text-only models carry no budget.
    expect(piImageResizeFor(false, 3 * 1024 * 1024)).toBeUndefined()
    // A tiny catalog limit clamps the encoded budget (decoded × 4/3).
    const small = piImageResizeFor(true, 3000)
    expect(small?.images?.resize?.maxBytes).toBe(4000)
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, efforts: ["max"], endpoints: ["responses"], vision: true, maxImageBytes: 3 * 1024 * 1024 },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["responses"], vision: false },
      ],
    })
    const rows = Object.fromEntries(
      json.providers["gh-router"].models.map((m) => [m.id, m]),
    )
    expect(rows["gpt-6-luna"].inputLimits?.images?.resize?.maxBytes).toBe(
      PI_IMAGE_RESIZE_MAX_BYTES,
    )
    expect(rows["gpt-6-sol"].inputLimits).toBeUndefined()
  })

  test("api override derives from catalog endpoints, explicit wins", () => {
    expect(piApiForEndpoints(["/responses"])).toBe("openai-responses")
    expect(piApiForEndpoints(["/chat/completions"])).toBe("openai-completions")
    expect(piApiForEndpoints([])).toBeUndefined()
    expect(piApiForEndpoints(undefined)).toBeUndefined()
    // Responses-capable rows omit the override (matches provider default).
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "cheapest",
      catalog: [
        { id: "gpt-6-luna", maxContextTokens: 1_050_000, maxPromptTokens: 922_000, efforts: ["max"], endpoints: ["/responses"] },
        { id: "gpt-6-sol", maxContextTokens: 500_000, maxPromptTokens: 400_000, efforts: ["high"], endpoints: ["/responses"] },
      ],
    })
    for (const m of json.providers["gh-router"].models) {
      expect(m.api).toBeUndefined()
    }
  })
})

describe("pi cosmetic user overrides", () => {
  const built = () =>
    buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })

  test("empty user settings change nothing", () => {
    expect(applyCosmeticUserOverrides({}, built())).toEqual({})
    expect(applyCosmeticUserOverrides(undefined, built())).toEqual({})
  })

  test("user look wins for presentational keys", () => {
    const overrides = applyCosmeticUserOverrides(
      {
        hideThinkingBlock: false,
        theme: "tokyo-night",
        readOutputMode: "preview",
        themeAdaptive: true,
        toolBackground: "border",
        terminal: { showImages: false },
        markdown: { mermaid: "off" },
      },
      built(),
    )
    expect(overrides).toEqual({
      hideThinkingBlock: false,
      theme: "tokyo-night",
      readOutputMode: "preview",
      themeAdaptive: true,
      toolBackground: "border",
      terminal: { showImages: false },
      markdown: { mermaid: "off" },
    })
  })

  test("load-bearing keys never override, unknown keys ignored", () => {
    const overrides = applyCosmeticUserOverrides(
      {
        defaultModel: "gpt-6-sol",
        defaultTools: ["read"],
        packages: [],
        compaction: {},
        somethingElse: 1,
      },
      built(),
    )
    expect(overrides).toEqual({})
  })

  test("explicit undefined does not override", () => {
    const overrides = applyCosmeticUserOverrides(
      { hideThinkingBlock: undefined },
      built(),
    )
    expect(overrides).toEqual({})
  })

  test("rendering keys are cosmetic too", () => {
    const built = () =>
      buildPiSettingsJson({
        profileId: "cheapest",
        searchEnabled: false,
        browseEnabled: false,
      })
    const overrides = applyCosmeticUserOverrides(
      { markdown: { mermaid: "off" }, collapseChangelog: false },
      built(),
    )
    expect(overrides).toEqual({ markdown: { mermaid: "off" }, collapseChangelog: false })
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
      "powershell",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ])
    expect(settings.retry).toEqual({ enabled: true, maxRetries: 3, provider: { maxRetries: 0 } })
    // Per-model startup thinking stays on catalog-supported tiers.
    expect(settings.modelThinkingLevels?.["gh-router/gpt-6-luna"]).toBe("max")
    // Native image loop switches (never blockImages).
    expect(settings.images).toEqual({ autoResize: true, blockImages: false })
    expect(settings.terminal).toEqual({ showImages: true, imageWidthCells: 60, showTerminalProgress: true })
    // Zero-token display richness: mermaid streams, changelog condensed.
    expect(settings.collapseChangelog).toBe(true)
    // Mermaid streams in the TUI (display-only, zero tokens).
    expect(settings.markdown).toEqual({ mermaid: "streaming" })
    expect(settings.transport).toBe("auto")
    // pi-subagents loads extensions ONLY (third-party skills/prompts
    // filtered out so they never reach Ctrl+O).
    expect(settings.packages).toContainEqual({
      source: "npm:pi-subagents",
      skills: [],
      prompts: [],
    })
    // Helpful bundle rides peers by default (extensions-only filters).
    expect(settings.packages).toContainEqual(PI_HELPERS_MCP_ADAPTER)
    expect(settings.packages).toContainEqual(PI_HELPERS_AGENT_EXTENSIONS)
    // No third-party statusline package: the footer is built into the
    // mode's own gh-router-pi extension (the community bridge never sees
    // the launch mirror, so it cannot drive a per-launch footer).
    expect(settings.packages).not.toContain("npm:pi-statusline")
    expect(settings.packages).toContain("local:gh-router-pi")
  })

  test("helpers off drops the bundle but keeps pi-subagents + footer", () => {
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      helpers: false,
    })
    expect(settings.packages).toContainEqual({
      source: "npm:pi-subagents",
      skills: [],
      prompts: [],
    })
    expect(
      settings.packages.some(
        (p) => typeof p === "object" && p.source === "npm:pi-mcp-adapter",
      ),
    ).toBe(false)
    expect(settings.packages).toContain("local:gh-router-pi")
  })

  test("web-access rides helpers only when search and browse are both off", () => {
    const off = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(off.packages).toContainEqual(PI_HELPERS_WEB_ACCESS)
    const onSearch = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: false,
    })
    expect(onSearch.packages).not.toContainEqual(PI_HELPERS_WEB_ACCESS)
    const onBrowse = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: true,
    })
    expect(onBrowse.packages).not.toContainEqual(PI_HELPERS_WEB_ACCESS)
  })

  test("ui transcript package is default-on, pi-code stays opt-out", () => {
    const bare = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    // Presentational only (grouped rows, Shiki diffs) — zero model cost.
    expect(bare.packages).toContain("npm:pi-claude-code-ui")
    // Claude-Code look: hidden thinking, fixed Claude palette, one-line
    // tool rows (expandable via Ctrl+O).
    expect(bare.hideThinkingBlock).toBe(true)
    expect(bare.themeAdaptive).toBe(false)
    expect(bare.groupToolCalls).toBe(true)
    expect(bare.readOutputMode).toBe("summary")
    expect(bare.searchOutputMode).toBe("count")
    expect(bare.mcpOutputMode).toBe("summary")
    expect(bare.bashOutputMode).toBe("summary")
    expect(bare.toolBackground).toBe("transparent")
    // Genuine Claude Code dark palette, themes-only package (no code).
    expect(bare.theme).toBe("claude-code-dark")
    expect(bare.packages).toContainEqual({
      source: "npm:better-claude-code-ui",
      themes: ["theme/*.json"],
      extensions: [],
      skills: [],
      prompts: [],
    })
    // pi-code behaviors would collide with router-owned /memory + /context.
    expect(bare.packages).not.toContain("npm:pi-code")
    const noUi = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      ui: false,
    })
    expect(noUi.packages).not.toContain("npm:pi-claude-code-ui")
    expect(noUi.packages).toContain("local:gh-router-pi")
    // UI companion keys are inert without the package, so omitted;
    // thinking stays hidden regardless (native Pi setting, not cc-ui).
    expect(noUi.themeAdaptive).toBeUndefined()
    expect(noUi.groupToolCalls).toBeUndefined()
    expect(noUi.readOutputMode).toBeUndefined()
    expect(noUi.toolBackground).toBeUndefined()
    expect(noUi.theme).toBeUndefined()
    expect(
      noUi.packages.some(
        (p) => typeof p === "object" && p.source === "npm:better-claude-code-ui",
      ),
    ).toBe(false)
    expect(noUi.hideThinkingBlock).toBe(true)
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
    expect(base).not.toContain("open_tab")
    expect(base).not.toContain("browser_open_tab")

    const full = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: true,
    })
    expect(full).toContain("code_search")
    // Browser tools use stripped MCP names (open_tab/navigate/...) so a
    // `browser_*` wire name never reaches tools/call (which keys on the
    // stripped toolNameHttp and would reject with -32601).
    expect(full).toContain('"open_tab"')
    expect(full).toContain('"navigate"')
    expect(full).toContain('"screenshot"')
    expect(full).toContain('"act"')
    expect(full).toContain('"observe"')
    expect(full).toContain('"extract"')
    expect(full).not.toContain('"browser_open_tab"')
    expect(full).not.toContain('"browser_navigate"')
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
    expect(src).toContain("parameters: OpenTabParams")
    expect(src).toContain("parameters: NavigateParams")
    expect(src).toContain("parameters: ScreenshotParams")
    expect(src).toContain("parameters: ActParams")
    expect(src).toContain("parameters: ObserveParams")
    expect(src).toContain("parameters: ExtractParams")
    expect(src).not.toContain("parameters: BrowserParams")
    expect(src).not.toContain("inputSchema")
    // execute(toolCallId, params, signal) returning { content, details }.
    expect(src).toContain("async execute(_toolCallId, params, signal)")
    expect(src).toContain("content: [{ type: \"text\", text")
    expect(src).toContain("details: undefined")
    expect(src).not.toContain("ctx.signal")
    expect(src).not.toContain("async execute(args, ctx)")
  })

  test("pi bridge maps to MCP contracts (no schema drift)", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: true,
    })
    // Oracle/advisor translate Pi-friendly keys to the MCP {query, context}
    // contract. The old payload (decision/options/model/thinking) was
    // rejected by tools/call with -32602.
    expect(src).toContain('callMcp("peers", "oracle", { query, context }')
    expect(src).not.toContain("decision: params.decision")
    expect(src).not.toContain("model: ORACLE_MODEL")
    expect(src).not.toContain("model: ADVISOR_MODEL")
    // code_search always carries a workspace (explicit arg or launch env),
    // plus the X-GH-Workspace session header fallback.
    expect(src).toContain("PI_WORKSPACE")
    expect(src).toContain("GH_ROUTER_WORKSPACE")
    expect(src).toContain("X-GH-Workspace")
    expect(src).toContain('callMcp("search", "code"')
    expect(src).toContain("workspace")
    // NUL bytes are stripped before crossing the MCP boundary so strict
    // downstream JSON consumers never see a literal U+0000.
    expect(src).toContain("stripNul")
  })
})
