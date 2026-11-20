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
  buildPiKeybindingsJson,
  buildPiModelsJson,
  buildPiSettingsJson,
  mergePiKeybindingsSettings,
  PI_THINKING_CYCLE_ACTION,
  PI_THINKING_CYCLE_REBIND,
  PI_SEARCH_ORDER_LINE,
  PI_TOOL_PREFERENCE_LINE,
  piProfileModelIds,
} from "~/lib/pi-models-settings"
import { resolvePiSurfaces } from "~/lib/pi-mcp-config"
import {
  CHEAPEST_CONSULT_CONTRACT,
  CHEAPEST_CONSULT_CONTRACT_POINTER,
  FRESH_CONSULT_CONTRACT,
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

    test(`${profileId}: extension registers no model-facing tools`, () => {
      // Every group reaches Pi as a native MCP server, so a hand-wrapped
      // tool here would both shadow the native one and pay a definition per
      // request for a surface `tool_search` already covers.
      const ext = buildPiExtensionSource({ profileId })
      expect(ext).not.toContain("pi.registerTool")
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
      "gpt-6.2-sol",
    ])
  })

  test("extension registers no consult tools either way", () => {
    // Consults are `mcp__gh-router-peers__oracle` and the `advisor` subagent
    // now, so `--no-peers` shrinks the MCP surface and the agent roster, not
    // the generated extension.
    const ext = buildPiExtensionSource({ profileId: "cheapest" })
    expect(ext).not.toContain("OracleParams")
    expect(ext).not.toContain("AdvisorParams")
    expect(ext).not.toContain("pi.registerTool")
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

describe("pi local profiles carry the consultants they can reach locally", () => {
  test("the oracle skill is emitted for every profile, including local", () => {
    // `local`'s consult runs on the LOCAL tier, so the role exists there and is
    // advertised: it is a plain consult of the endpoint the lead already uses.
    // Withholding the skill would have hidden a role the model is allowed to
    // use, which is worse than either emitting or omitting the persona.
    const local = buildPiSkills({ profileId: "local" })
    expect(local.map((s) => s.dir)).toEqual(["gh-oracle"])
    expect(local[0].content).toContain("mcp__gh-router-peers__oracle")
    // `local2` keeps the same stateless MCP persona, billed to Sol.
    const local2 = buildPiSkills({ profileId: "local2" })
    expect(local2.map((s) => s.dir)).toEqual(["gh-oracle"])
    expect(local2[0].content).toContain("mcp__gh-router-peers__oracle")
  })

  test("--swe names the consultant both local profiles actually have", () => {
    const local = buildPiSkills({ profileId: "local", swe: true })
    expect(local.map((s) => s.dir)).toEqual(["gh-oracle", "gh-delegate"])
    const localDelegate = local.find((s) => s.dir === "gh-delegate")
    expect(localDelegate?.content).toContain("`oracle` for consults")
    // No Advisor on `local`: the roster sentence must not promise one.
    expect(localDelegate?.content).not.toContain("`advisor`")

    const local2 = buildPiSkills({ profileId: "local2", swe: true })
    expect(local2.map((s) => s.dir)).toEqual(["gh-oracle", "gh-delegate", "gh-advisor"])
    const local2Delegate = local2.find((s) => s.dir === "gh-delegate")
    expect(local2Delegate?.content).toContain("`oracle`/`advisor` for consults")
  })
})

describe("pi --search owns the search skill prose", () => {
  test("the skill is opt-in; the code tool is not", () => {
    // `code` is published on every launch: it always answers (semantic when
    // the index is ready, labelled lexical otherwise) and `web` rides the
    // same group, so there is no configuration where withholding the group
    // buys anything. What `--search` still owns is the ColBERT-specific
    // prose, which would be wrong advice on a Bluebird or lexical backend.
    const skillsOff = buildPiSkills({
      profileId: "cheapest",
      peers: false,
      search: false,
    })
    expect(skillsOff).toEqual([])

    const skillsOn = buildPiSkills({ profileId: "cheapest", search: true })
    // peers default ON, so gh-oracle rides along; the search skill is
    // the delta this flag owns.
    expect(skillsOn.map((s) => s.dir)).toEqual([
      "gh-oracle",
      "gh-search-first",
    ])
  })
})

describe("pi cheapest digest carries the fresh consult contract", () => {
  test("the digest carries the fresh variant and not the curated-transcript one", () => {
    const digest = buildPiAppendSystem("cheapest")
    // Asserting the IMPORT rather than a copy: the two front-ends must not be
    // able to drift, and a re-typed sentence here would pass a containment
    // check while quietly diverging from the Claude side.
    expect(digest).toContain(FRESH_CONSULT_CONTRACT.trimEnd())
    expect(digest).toContain("the shortest path, what to consider")
    // Pi's `advisor` subagent is `defaultContext: fresh` with a read-only
    // toolset, so it never sees the lead's conversation. Promising a curated
    // view of the session would tell the lead to under-write the brief.
    expect(digest).not.toContain(CHEAPEST_CONSULT_CONTRACT)
    expect(digest).not.toContain("reads a curated view of this session")
    expect(digest).toContain("the Advisor reads only what you write")
    // The pointer is Claude-specific: it ends by telling the reader the full
    // how-to is in their CLAUDE.md, which Pi does not load. If it ever appears
    // in a Pi digest, the lead is being sent after a file that is not there.
    expect(digest).not.toContain(CHEAPEST_CONSULT_CONTRACT_POINTER)
  })

  test("balanced stays floor-free and peerless cheapest carries no consults", () => {
    // The balanced family has no advisor, so it has no consult budget to
    // describe — balanced2 derives that property rather than re-declaring it.
    for (const profileId of ["balanced", "balanced2"] as const) {
      expect(buildPiAppendSystem(profileId)).not.toContain(FRESH_CONSULT_CONTRACT)
    }
    // Peerless cheapest has no advisor either.
    for (const profileId of ["cheapest", "cheapest2"] as const) {
      expect(buildPiAppendSystem(profileId, { peers: false })).not.toContain(
        FRESH_CONSULT_CONTRACT,
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

describe("pi keybindings: shift+tab is freed for plan mode", () => {
  test("exactly one action moves, and it is pi's thinking cycle", () => {
    // `app.thinking.cycle` is pi's own default owner of shift+tab
    // (dist/core/keybindings.js:13) and it is listed in
    // RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS, which is what makes a bare
    // extension registration die with "conflicts with built-in shortcut".
    // Moving the action off shift+tab is the way past it: the conflict table is
    // built by key, so the old key simply stops being reserved.
    expect(buildPiKeybindingsJson()).toEqual({
      "app.thinking.cycle": [PI_THINKING_CYCLE_REBIND],
    })
  })

  test("the freed key is the only one touched — no incidental re-mapping", () => {
    const built = buildPiKeybindingsJson()
    // A template that emptied or moved every default would keep the shift+tab
    // test green while silently taking ctrl+o, ctrl+t, escape and the rest.
    expect(Object.keys(built)).toHaveLength(1)
    expect(PI_THINKING_CYCLE_ACTION).toBe("app.thinking.cycle")
    // Emitting [] would ALSO free the key, but it costs a working pi binding
    // for a toggle `/plan` already provides. The rebind keeps cycling alive.
    expect(built["app.thinking.cycle"]).not.toEqual([])
    expect(built["app.thinking.cycle"]).not.toContain("shift+tab")
  })

  test("the replacement key is not claimed by pi or a bundled extension", () => {
    // pi's own table plus every shortcut the bundled packages register
    // (ctrl+shift+o/e/r, ctrl+., alt+t — verified against the installed tree).
    const taken = ["shift+tab", "ctrl+o", "ctrl+t", "ctrl+l", "ctrl+g", "ctrl+p",
      "ctrl+shift+o", "ctrl+shift+e", "ctrl+shift+r", "ctrl+.", "alt+t"]
    expect(taken).not.toContain(PI_THINKING_CYCLE_REBIND)
  })

  test("a user's other bindings survive", () => {
    const merged = mergePiKeybindingsSettings(
      { "app.message.copy": ["ctrl+y"] },
      buildPiKeybindingsJson(),
    )
    expect(merged["app.message.copy"]).toEqual(["ctrl+y"])
    // Absent means pi's default is in force, which still claims shift+tab, so
    // the built value is applied.
    expect(merged["app.thinking.cycle"]).toEqual([PI_THINKING_CYCLE_REBIND])
  })

  test("a user who still routes shift+tab through the action gets moved", () => {
    // ["shift+tab", "F2"] and the bare string form both still claim the key;
    // leaving either would cost plan mode the binding with no diagnostic.
    for (const userValue of [["shift+tab"], "shift+tab", ["F2", "shift+tab"], ["Shift+Tab"]]) {
      const merged = mergePiKeybindingsSettings(
        { "app.thinking.cycle": userValue },
        buildPiKeybindingsJson(),
      )
      expect(merged["app.thinking.cycle"]).toEqual([PI_THINKING_CYCLE_REBIND])
    }
  })

  test("a user who already moved it keeps their own key", () => {
    // The invariant is "shift+tab is unbound", not "our value wins". F2 has no
    // shift+tab in it, so the key is already free and their choice stands.
    const merged = mergePiKeybindingsSettings(
      { "app.thinking.cycle": ["F2"] },
      buildPiKeybindingsJson(),
    )
    expect(merged["app.thinking.cycle"]).toEqual(["F2"])
  })

  test("a corrupt or non-object file is discarded rather than spread", () => {
    // JSON.parse can legally return a string, a number or an array. Spreading
    // any of those into the object would plant junk keys in the mirror.
    const expected = { "app.thinking.cycle": [PI_THINKING_CYCLE_REBIND] }
    expect(mergePiKeybindingsSettings("nope", buildPiKeybindingsJson())).toEqual(expected)
    expect(mergePiKeybindingsSettings(["ctrl+x"], buildPiKeybindingsJson())).toEqual(expected)
    expect(mergePiKeybindingsSettings(null, buildPiKeybindingsJson())).toEqual(expected)
  })
})

describe("pi digest: native tools first, shell when it is the better tool", () => {
  test("every profile carries the steer, peers or not", () => {
    for (const profileId of ["cheapest", "local", "balanced2", "cheapest2"] as const) {
      for (const peers of [true, false]) {
        expect(buildPiAppendSystem(profileId, { peers })).toContain(PI_TOOL_PREFERENCE_LINE)
      }
    }
  })

  test("both halves are present — the steer is not a blanket shell ban", () => {
    // The first half is the Claude-shaped "use the dedicated tool"; the second
    // half keeps rg/jq/ast-grep/git/build available for the jobs those tools
    // cannot express. Dropping either half makes the agent worse, so pin both.
    expect(PI_TOOL_PREFERENCE_LINE).toContain("read/write/edit")
    expect(PI_TOOL_PREFERENCE_LINE).toContain("grep/find/ls")
    for (const tool of ["rg", "jq", "ast-grep", "git"]) {
      expect(PI_TOOL_PREFERENCE_LINE).toContain(tool)
    }
  })

  test("the steer names tools the launch actually emits", () => {
    // Names must match the built-in roster the settings writer installs, or the
    // digest is telling the lead to reach for a tool it does not have.
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    const tools = settings.defaultTools ?? []
    for (const tool of ["read", "write", "edit", "grep", "find", "ls", "bash"]) {
      expect(tools).toContain(tool)
    }
  })
})

describe("pi digest: semantic search narrows, rg/grep answers what meaning cannot", () => {
  test("the line rides only when this launch serves `code`", () => {
    // A launch without `--search` (and without Bluebird) has no `code` tool in
    // the roster, so naming it would be a dead pointer — the exact failure the
    // digest exists to prevent.
    for (const profileId of ["cheapest", "local", "balanced2"] as const) {
      expect(buildPiAppendSystem(profileId, { codeSearch: true })).toContain(
        PI_SEARCH_ORDER_LINE,
      )
      expect(buildPiAppendSystem(profileId, { codeSearch: false })).not.toContain(
        PI_SEARCH_ORDER_LINE,
      )
      // Absent means no code search: the default must not advertise one.
      expect(buildPiAppendSystem(profileId)).not.toContain(PI_SEARCH_ORDER_LINE)
    }
  })

  test("the ordering is semantic first and names the shell fallback", () => {
    // Both halves are load-bearing, same as the tool-preference steer: the
    // ordering alone would leave the model grepping for concepts, and the
    // fallback alone would not say which way round they go.
    expect(PI_SEARCH_ORDER_LINE).toContain("semantic")
    expect(PI_SEARCH_ORDER_LINE).toContain("first")
    for (const tool of ["rg", "grep"]) {
      expect(PI_SEARCH_ORDER_LINE).toContain(tool)
    }
    // Meaning cannot answer these; the model must know the shell still owns them.
    for (const job of ["every occurrence", "exact token", "regex", "filename"]) {
      expect(PI_SEARCH_ORDER_LINE).toContain(job)
    }
    expect(PI_SEARCH_ORDER_LINE.indexOf("semantic")).toBeLessThan(
      PI_SEARCH_ORDER_LINE.indexOf("rg/grep"),
    )
  })

  test("the surface flag follows --search and Bluebird, not the profile", () => {
    // `surfaces.codeSearch` is the same predicate the MCP config uses to
    // publish the group, so digest and roster cannot disagree.
    for (const bluebirdEnabled of [false, true]) {
      const on = resolvePiSurfaces({
        profileId: "local",
        searchEnabled: true,
        bluebirdEnabled,
        adoEnabled: false,
        kustoEnabled: false,
        cloudAgentEnabled: false,
        workiqEnabled: false,
        browseAgentAvailable: false,
        directBrowserAvailable: false,
        artifactToolsAvailable: false,
        peersEnabled: true,
      })
      const off = resolvePiSurfaces({
        profileId: "local",
        searchEnabled: false,
        bluebirdEnabled,
        adoEnabled: false,
        kustoEnabled: false,
        cloudAgentEnabled: false,
        workiqEnabled: false,
        browseAgentAvailable: false,
        directBrowserAvailable: false,
        artifactToolsAvailable: false,
        peersEnabled: true,
      })
      if (bluebirdEnabled) {
        // Bluebird answers `code` with or without --search.
        expect(off.codeSearch).toBe(true)
      } else {
        expect(on.codeSearch).toBe(true)
        expect(off.codeSearch).toBe(false)
      }
      expect(buildPiAppendSystem("local", { codeSearch: on.codeSearch })).toContain(
        PI_SEARCH_ORDER_LINE,
      )
    }
  })
})
