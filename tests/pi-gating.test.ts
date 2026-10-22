import { describe, expect, test } from "bun:test"

import {
  validateBalancedProfilePrerequisites,
  validateCheapestProfilePrerequisites,
} from "~/lib/launch-profile"
import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "~/lib/pi-extension"
import {
  buildPiAppendSystem,
  buildPiModelsJson,
  buildPiSettingsJson,
  piProfileModelIds,
} from "~/lib/pi-models-settings"
import {
  CHEAPEST_CONSULT_CONTRACT,
  CHEAPEST_CONSULT_CONTRACT_POINTER,
} from "~/lib/claude-md-injection"
import type { ModelsResponse } from "~/services/copilot/get-models"

const model = (id: string, opts: {
  context?: number
  prompt?: number
  efforts?: string[]
  endpoints?: string[]
  toolCalls?: boolean
} = {}) => ({
  id,
  name: id,
  object: "model" as const,
  preview: false,
  vendor: "test",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: opts.endpoints,
  capabilities: {
    family: id,
    object: "model_capabilities" as const,
    tokenizer: "o200k_base",
    type: "chat",
    limits: {
      max_context_window_tokens: opts.context,
      max_prompt_tokens: opts.prompt,
    },
    supports: {
      tool_calls: opts.toolCalls ?? true,
      reasoning_effort: opts.efforts,
    },
  },
})

const catalogOf = (data: Array<ReturnType<typeof model>>): ModelsResponse =>
  ({ object: "list", data }) as unknown as ModelsResponse

describe("pi launch advertises only owned surfaces", () => {
  for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
    test(`${profileId}: peers skill only by default, no prompts`, () => {
      // Peers are default-ON (the --codex-mcp parity call), so the
      // oracle consult skill rides along; pipeline and search surfaces
      // stay out until --swe / --search.
      expect(buildPiSkills({ profileId }).map((s) => s.dir)).toEqual([
        "gh-oracle",
      ])
      expect(buildPiPrompts({ profileId })).toEqual([])
      expect(buildPiPrompts({ profileId, swe: false })).toEqual([])
    })

    test(`${profileId}: fully bare with --no-peers`, () => {
      expect(buildPiSkills({ profileId, peers: false })).toEqual([])
      // Prompts are swe-gated only; peers is irrelevant to them.
      expect(buildPiPrompts({ profileId })).toEqual([])
    })

    test(`${profileId}: extension carries consults but no search/browse`, () => {
      const ext = buildPiExtensionSource({
        profileId,
        searchEnabled: false,
        browseEnabled: false,
      })
      expect(ext).toContain('"oracle"')
      expect(ext).not.toContain("code_search")
      expect(ext).not.toContain("browser_open_tab")
    })

    test(`${profileId}: APPEND digest is mode identity without consults gated off`, () => {
      const digest = buildPiAppendSystem(profileId, { peers: false })
      expect(digest).toContain(`gh-router ${profileId} mode`)
      expect(digest).toContain("Peerless launch")
      expect(digest).not.toContain("oracle")
    })
  }
})

describe("pi --no-peers shrinks the surface", () => {
  test("model ids collapse to the lead", () => {
    expect(piProfileModelIds("cheapest", { peers: false })).toEqual([
      "gpt-6-luna",
    ])
    expect(piProfileModelIds("balanced", { peers: false })).toEqual([
      "gpt-5.6-sol",
    ])
    // The -2 aliases move only their contracted Sol slots, so the peerless
    // surface collapses to the same shape with the 6.1 lead.
    expect(piProfileModelIds("cheapest2", { peers: false })).toEqual([
      "gpt-6-luna",
    ])
    expect(piProfileModelIds("balanced2", { peers: false })).toEqual([
      "gpt-6.1-sol",
    ])
  })

  test("extension registers no consult tools", () => {
    const ext = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      peers: false,
    })
    expect(ext).not.toContain('"oracle"')
    expect(ext).not.toContain('"advisor"')
    expect(ext).not.toContain("OracleParams")
    expect(ext).not.toContain("AdvisorParams")
  })

  test("settings drop pi-subagents but keep the built-in footer extension", () => {
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      peers: false,
    })
    expect(
      settings.packages.some(
        (p) => typeof p === "object" && p.source === "npm:pi-subagents",
      ),
    ).toBe(false)
    expect(settings.packages).not.toContain("npm:pi-statusline")
    expect(settings.packages).toContain("local:gh-router-pi")
    expect(settings.packages).toContain("local:gh-router-pi")
    expect(settings.enabledModels).toEqual(["gh-router/gpt-6-luna"])
  })

  test("models.json registers the lead only", () => {
    const json = buildPiModelsJson({
      serverUrl: "http://127.0.0.1:8787",
      profileId: "balanced",
      peers: false,
    })
    expect(
      json.providers["gh-router"].models.map((m) => m.id),
    ).toEqual(["gpt-5.6-sol"])
  })

  test("prereqs validate the lead only", () => {
    const lunaOnly = catalogOf([
      model("gpt-6-luna", {
        context: 1_050_000,
        efforts: ["high", "xhigh", "max"],
        endpoints: ["/responses"],
      }),
    ])
    expect(
      validateCheapestProfilePrerequisites(lunaOnly, { peers: false }).ok,
    ).toBe(true)
    expect(
      validateCheapestProfilePrerequisites(undefined, { peers: false }).ok,
    ).toBe(false)

    const solOnly = catalogOf([
      model("gpt-5.6-sol", {
        context: 500_000,
        efforts: ["medium", "high"],
        endpoints: ["/responses"],
      }),
    ])
    expect(
      validateBalancedProfilePrerequisites(solOnly, { peers: false }).ok,
    ).toBe(true)
    // Grok absent is fine peerless; missing lead is not.
    expect(
      validateBalancedProfilePrerequisites(undefined, { peers: false }).ok,
    ).toBe(false)
  })
})

describe("pi --swe owns the pipeline surface", () => {
  test("cheapest gains delegate + advisor skills and all review prompts", () => {
    const dirs = buildPiSkills({
      profileId: "cheapest",
      peers: true,
      swe: true,
    }).map((s) => s.dir)
    expect(dirs).toEqual(["gh-oracle", "gh-delegate", "gh-advisor"])
    const names = buildPiPrompts({ profileId: "cheapest", swe: true }).map(
      (p) => p.name,
    )
    expect(names).toEqual(["review", "parallel-review", "plan-review"])
  })

  test("balanced gains delegate but stays advisor-free", () => {
    const dirs = buildPiSkills({
      profileId: "balanced",
      peers: true,
      swe: true,
    }).map((s) => s.dir)
    expect(dirs).toEqual(["gh-oracle", "gh-delegate"])
    const names = buildPiPrompts({ profileId: "balanced", swe: true }).map(
      (p) => p.name,
    )
    expect(names).toEqual(["review", "parallel-review"])
  })

  test("--swe without peers emits no pipeline skills or prompts", () => {
    // The delegate/review prose names agents + the subagent provider that a
    // peerless launch never writes — emitting it would dangle.
    const dirs = buildPiSkills({
      profileId: "cheapest",
      peers: false,
      swe: true,
    }).map((s) => s.dir)
    expect(dirs).toEqual([])
    expect(buildPiPrompts({ profileId: "cheapest", swe: true, peers: false })).toEqual([])
  })
})

describe("pi --search owns search prose and tool together", () => {
  test("skill and tool appear together or not at all", () => {
    const skillsOff = buildPiSkills({
      profileId: "cheapest",
      peers: false,
      search: false,
    })
    const extOff = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(skillsOff).toEqual([])
    expect(extOff).not.toContain("code_search")

    const skillsOn = buildPiSkills({ profileId: "cheapest", search: true })
    const extOn = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: false,
    })
    // peers default ON, so gh-oracle rides along; the search skill is
    // the delta this flag owns.
    expect(skillsOn.map((s) => s.dir)).toEqual([
      "gh-oracle",
      "gh-search-first",
    ])
    expect(extOn).toContain("code_search")
  })
})

describe("pi cheapest digest carries the shared consult contract", () => {
  test("the contract text is the same constant the Claude directive uses", () => {
    const digest = buildPiAppendSystem("cheapest")
    // Asserting the IMPORT rather than a copy: the two front-ends must not be
    // able to drift, and a re-typed sentence here would pass a containment
    // check while quietly diverging from the Claude side.
    expect(digest).toContain(CHEAPEST_CONSULT_CONTRACT.trimEnd())
    expect(digest).toContain("the shortest path, what to consider")
    // The pointer is Claude-specific: it ends by telling the reader the full
    // how-to is in their CLAUDE.md, which Pi does not load. If it ever appears
    // in a Pi digest, the lead is being sent after a file that is not there.
    expect(digest).not.toContain(CHEAPEST_CONSULT_CONTRACT_POINTER)
  })

  test("balanced stays floor-free and peerless cheapest carries no consults", () => {
    // The balanced family has no advisor, so it has no consult budget to
    // describe — balanced2 derives that property rather than re-declaring it.
    for (const profileId of ["balanced", "balanced2"] as const) {
      expect(buildPiAppendSystem(profileId)).not.toContain(CHEAPEST_CONSULT_CONTRACT)
    }
    // Peerless cheapest has no advisor either.
    for (const profileId of ["cheapest", "cheapest2"] as const) {
      expect(buildPiAppendSystem(profileId, { peers: false })).not.toContain(
        CHEAPEST_CONSULT_CONTRACT,
      )
    }
  })

  test("the cheapest family digest still names only tools the launch emits", () => {
    for (const profileId of ["cheapest", "cheapest2"] as const) {
      const digest = buildPiAppendSystem(profileId)
      expect(digest).toContain("`advisor`")
      expect(digest).toContain("`oracle`")
      expect(digest).toContain("`reviewer`")
    }
  })
})

describe("pi-subagents package loads extensions only", () => {
  test("object filter narrows skills and prompts", () => {
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const settings = buildPiSettingsJson({
        profileId,
        searchEnabled: false,
        browseEnabled: false,
      })
      const entry = settings.packages.find(
        (p) => typeof p === "object" && p.source === "npm:pi-subagents",
      )
      expect(entry).toEqual({
        source: "npm:pi-subagents",
        skills: [],
        prompts: [],
      })
    }
  })
})
