import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  CHEAPEST_PROFILE_CONTRACT,
  CHEAPEST_PROFILE_MODELS,
} from "~/lib/cheapest-profile-contract"
import {
  CHEAPEST_PROFILE,
  CHEAPLOCAL_PROFILE,
  formatCheapestPrerequisiteFailure,
  profileDescriptor,
  resolveLaunchProfile,
  validateCheapestProfilePrerequisites,
} from "~/lib/launch-profile"
import {
  CHEAPLOCAL_CONSULT_MODEL,
  CHEAPLOCAL_PROFILE_CONTRACT,
  CHEAPLOCAL_PROFILE_MODELS,
} from "~/lib/cheaplocal-profile-contract"
import {
  activeLocalLaunchProfile,
  assertCopilotModelAllowed,
  CopilotModelRestrictedError,
  copilotModelPolicyForProfile,
  effectiveLocalProfile,
} from "~/lib/copilot-model-policy"
import { clearLaunchRegistry, registerLaunch, unregisterLaunch } from "~/lib/launch-registry"
import {
  configureLocalEgress,
  LOCAL_DEFAULT_BASE_URL,
  localBaseUrl,
} from "~/lib/local-egress"
import { cheaplocalOracleModel, cheapestOracleModel } from "~/lib/mcp-capabilities"
import { selectableModelsInCatalog } from "~/lib/model-picker-settings"
import { resolveLeadSlugArg } from "~/lib/port"
import {
  cheapestContractFor,
  cheapestRewriteModelFor,
  isCheapestFamily,
  isCheaplocalProfile,
  isLocalFamily,
  isPinnedLaunchProfile,
} from "~/lib/profile-family"
import { getClaudeCodeEnvVars } from "~/lib/server-setup"
import { state } from "~/lib/state"

/**
 * `-m cheaplocal` is the third cheapest-family member: the cheapest roster,
 * windows, energies and groups exactly, with the Advisor and the Oracle served
 * by the local Anthropic-Messages endpoint instead of a Copilot model.
 *
 * "Everything else remains the same" is asserted structurally where it can be
 * (contract derivation), and behaviourally where it cannot (lead resolution,
 * launch env, picker rows, prerequisites).
 */

/** Replace a fixed set of keys, then assert the two records are equal. */
function expectDerived(
  base: Record<string, unknown>,
  derived: Record<string, unknown>,
  replacements: Record<string, unknown>,
): void {
  expect(derived).toEqual({ ...base, ...replacements })
}

const model = (
  id: string,
  opts: {
    context?: number
    prompt?: number
    efforts?: string[]
    endpoints?: string[]
    toolCalls?: boolean
  } = {},
) => ({
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

/** A catalog that satisfies the whole cheaplocal roster: `gpt-6-luna` is the
 *  lead, every native, and the reviewer, so one row covers all of them. No
 *  `opus` and no Sol row appears: the local consultants must not need one. */
const lunaOnlyCatalog = () => ({
  data: [
    model("gpt-6-luna", {
      context: 1_050_000,
      prompt: 872_000,
      efforts: ["high", "xhigh", "max"],
      endpoints: ["/responses"],
    }),
  ],
})

describe("cheaplocal is a cheapest-family member, not a local one", () => {
  test("the literal alias resolves to its own profile", () => {
    expect(resolveLaunchProfile("cheaplocal")).toBe("cheaplocal")
    expect(resolveLaunchProfile(" CHEAPLOCAL ")).toBe("cheaplocal")
    // Not the standard surface: the alias narrows roster and group set.
    expect(resolveLaunchProfile("gpt-6-luna")).toBe("standard")
  })

  test("family predicates answer independently", () => {
    expect(isCheapestFamily("cheaplocal")).toBe(true)
    expect(isCheaplocalProfile("cheaplocal")).toBe(true)
    // The inverse profile: its lead never leaves Copilot, so none of the
    // local-family egress behaviour may engage.
    expect(isLocalFamily("cheaplocal")).toBe(false)
    expect(isLocalFamily("local")).toBe(true)
    expect(isLocalFamily("local2")).toBe(true)
    expect(isCheaplocalProfile("cheapest2")).toBe(false)
    expect(isCheapestFamily("local2")).toBe(false)
  })

  test("it is a pinned profile", () => {
    expect(isPinnedLaunchProfile("cheaplocal")).toBe(true)
  })

  test("the descriptor is the cheapest surface under a new id", () => {
    const cheapest = profileDescriptor("cheapest")
    const cheaplocal = profileDescriptor("cheaplocal")
    expect(cheaplocal.id).toBe("cheaplocal")
    expect(cheaplocal.nativeRoster).toEqual(cheapest.nativeRoster)
    expect(cheaplocal.personaAllowlist).toEqual(new Set(["oracle"]))
    expect(cheaplocal.personaAllowlist).toEqual(cheapest.personaAllowlist)
    expect(cheaplocal.allowedGroups).toEqual(cheapest.allowedGroups)
    expect(cheaplocal.hasCoordinator).toBe(false)
  })

  test("the exported descriptor is the one the resolver returns", () => {
    expect(profileDescriptor("cheaplocal")).toBe(CHEAPLOCAL_PROFILE)
    expect(profileDescriptor("cheapest")).toBe(CHEAPEST_PROFILE)
  })
})

describe("the contract derives from cheapest by spread", () => {
  // Only these fields may differ. `rewriteModel` is listed because it is the
  // whole point of the split: cheaplocal's rewrite must NOT follow
  // `advisorModel` to the local slug, so the field is declared even though its
  // value coincides with the base's today.
  const declared = {
    models: CHEAPLOCAL_PROFILE_MODELS,
    nativeModels: CHEAPLOCAL_PROFILE_CONTRACT.nativeModels,
    advisorModel: "opus",
    advisorClientModel: "local",
    oracleModel: "opus",
    rewriteModel: "gpt-5.6-sol",
    consultTransport: "local",
  }

  test("the whole aggregate equals the base with only the declared deltas", () => {
    expectDerived(CHEAPEST_PROFILE_CONTRACT, CHEAPLOCAL_PROFILE_CONTRACT, declared)
  })

  test("every inherited field is the base value, identity included", () => {
    for (const key of Object.keys(CHEAPEST_PROFILE_CONTRACT) as Array<
      keyof typeof CHEAPEST_PROFILE_CONTRACT
    >) {
      if (key in declared) continue
      const derivedValue: unknown = CHEAPLOCAL_PROFILE_CONTRACT[key]
      const baseValue: unknown = CHEAPEST_PROFILE_CONTRACT[key]
      expect(derivedValue).toBe(baseValue)
    }
  })

  test("the model map changes only the two consultant slots", () => {
    expectDerived(CHEAPEST_PROFILE_MODELS, CHEAPLOCAL_PROFILE_MODELS, {
      advisor: "opus",
      oracle: "opus",
    })
    expect(CHEAPLOCAL_PROFILE_MODELS.lead).toBe(CHEAPEST_PROFILE_MODELS.lead)
    expect(CHEAPLOCAL_PROFILE_MODELS.explore).toBe(CHEAPEST_PROFILE_MODELS.explore)
    expect(CHEAPLOCAL_PROFILE_MODELS["General-Purpose"]).toBe(
      CHEAPEST_PROFILE_MODELS["General-Purpose"],
    )
    expect(CHEAPLOCAL_PROFILE_MODELS.reviewer).toBe(CHEAPEST_PROFILE_MODELS.reviewer)
  })

  test("both consultants send the same bare wire slug", () => {
    expect(CHEAPLOCAL_PROFILE_CONTRACT.advisorModel).toBe(CHEAPLOCAL_CONSULT_MODEL)
    expect(CHEAPLOCAL_PROFILE_CONTRACT.oracleModel).toBe(CHEAPLOCAL_CONSULT_MODEL)
  })

  test("the client-visible Advisor pin is a transport label, not a model id", () => {
    // The pin must survive Claude Code untouched: a recognized model alias is
    // resolved through Claude Code's own registry (observed: `--advisor opus`
    // arrives at the proxy as `claude-opus-5.5`), so it cannot be the pin.
    expect(CHEAPLOCAL_PROFILE_CONTRACT.advisorClientModel).toBe("local")
    expect(CHEAPLOCAL_PROFILE_CONTRACT.advisorClientModel).not.toBe(
      CHEAPLOCAL_CONSULT_MODEL,
    )
    // No window bracket: the profile knows nothing about the endpoint's model,
    // so it cannot claim a window for it.
    expect(CHEAPLOCAL_PROFILE_CONTRACT.advisorClientModel).not.toContain("[")
  })

  test("the consult transport is the only behavioural delta", () => {
    expect(cheapestContractFor("cheapest").consultTransport).toBe("copilot")
    expect(cheapestContractFor("cheapest2").consultTransport).toBe("copilot")
    expect(cheapestContractFor("cheaplocal").consultTransport).toBe("local")
  })

  test("the Copilot prompt rewrite does not follow the consultants", () => {
    // The rewrite is a Copilot dispatch under the profile's {sol, luna}
    // egress ceiling, so handing it the local slug would make every prompt
    // submit fail the model policy.
    expect(cheapestRewriteModelFor("cheaplocal")).toBe("gpt-5.6-sol")
    expect(cheapestRewriteModelFor("cheapest")).toBe("gpt-5.6-sol")
    expect(cheapestRewriteModelFor("cheapest2")).toBe("gpt-6.1-sol")
    expect(cheapestRewriteModelFor("cheaplocal")).toBe(
      CHEAPEST_PROFILE_CONTRACT.rewriteModel,
    )
    expect(cheapestRewriteModelFor("cheaplocal")).not.toBe(
      CHEAPLOCAL_PROFILE_CONTRACT.advisorModel,
    )
  })

  test("the Oracle gate needs no catalog entry", () => {
    // The Copilot gate resolves the contract model against the live catalog,
    // so it would answer `undefined` for the local slug. cheaplocal has its
    // own gate, which is always true because there is nothing to check.
    expect(cheaplocalOracleModel()).toBe(true)
    state.models = lunaOnlyCatalog() as never
    try {
      expect(cheapestOracleModel("cheaplocal")).toBeUndefined()
    } finally {
      state.models = undefined
    }
  })
})

describe("the lead and the launch env are cheapest's", () => {
  test("the alias resolves to the bare Luna lead", () => {
    const lead = resolveLeadSlugArg("cheaplocal")
    expect(lead).toBe("gpt-6-luna")
    expect(lead).toBe(resolveLeadSlugArg("cheapest"))
    // A pinned 200K profile never decorates its lead.
    expect(lead).not.toContain("[1m]")
  })

  test("the injected env is byte-identical to cheapest's", () => {
    const base = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-6-luna", "cheapest")
    const derived = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-6-luna", "cheaplocal")
    expect(derived).toEqual(base)
    expect(derived.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1")
    expect(derived.CLAUDE_CODE_EFFORT_LEVEL).toBe(CHEAPEST_PROFILE_CONTRACT.leadEffort)
    expect(derived).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
  })

  test("the picker rows are the cheapest rows, unfiltered by the local slug", () => {
    const saved = state.models
    // Both rows present, so the assertion below fails if a consultant row is
    // ever derived from the contract model instead of the base picker set.
    state.models = {
      data: [...lunaOnlyCatalog().data, model("gpt-5.6-sol", { context: 1_000_000 })],
    } as never
    try {
      expect(selectableModelsInCatalog("cheaplocal")).toEqual(
        selectableModelsInCatalog("cheapest"),
      )
      // The consultant rows follow the base contract's Sol, never the local
      // slug: `opus` is not a Copilot id and must not appear in the picker.
      expect(selectableModelsInCatalog("cheaplocal").map((row) => row.model)).toEqual([
        "gpt-5.6-sol",
        "gpt-6-luna",
      ])
    } finally {
      state.models = saved
    }
  })
})

describe("launch prerequisites validate only the Copilot calls", () => {
  test("a Luna-only catalog satisfies the whole roster", () => {
    // No `opus`, no Sol: the Oracle block is skipped because the transport is
    // local, and the reviewer block passes on the Luna row it shares with the
    // lead.
    expect(
      validateCheapestProfilePrerequisites(lunaOnlyCatalog() as never, {}, "cheaplocal"),
    ).toEqual({ ok: true, missing: [] })
  })

  test("a missing Luna lead still fails the launch", () => {
    const result = validateCheapestProfilePrerequisites({ data: [] } as never, {}, "cheaplocal")
    expect(result.ok).toBe(false)
    expect(result.missing.join("\n")).toContain("gpt-6-luna: absent from the live catalog")
  })

  test("the lead and reviewer blocks both run without peers:false", () => {
    // The reviewer is a Copilot call on this family member too. It shares the
    // lead's id, so the only observable proof its own block ran is that the
    // shared id is reported once per block rather than once overall.
    const result = validateCheapestProfilePrerequisites(undefined, {}, "cheaplocal")
    expect(
      result.missing.filter((entry) => entry === "gpt-6-luna: absent from the live catalog"),
    ).toHaveLength(2)
  })

  test("peers:false validates the lead only, exactly like cheapest", () => {
    expect(
      validateCheapestProfilePrerequisites(lunaOnlyCatalog() as never, { peers: false }, "cheaplocal"),
    ).toEqual({ ok: true, missing: [] })
    expect(
      validateCheapestProfilePrerequisites({ data: [] } as never, { peers: false }, "cheaplocal"),
    ).toEqual({ ok: false, missing: ["gpt-6-luna: absent from the live catalog"] })
  })

  test("the failure message names the alias the user typed", () => {
    const message = formatCheapestPrerequisiteFailure(
      ["gpt-6-luna: absent from the live catalog"],
      "cheaplocal",
    )
    expect(message).toContain("-m cheaplocal requires")
    expect(message).toContain("the cheaplocal profile's exact roster")
    expect(message).not.toContain("-m cheapest requires")
  })
})

describe("Copilot egress is capped to {sol, luna}", () => {
  beforeEach(() => {
    clearLaunchRegistry()
  })
  afterEach(() => {
    clearLaunchRegistry()
  })

  test("the profile policy is the families ceiling", () => {
    const policy = copilotModelPolicyForProfile("cheaplocal")
    expect(policy.kind).toBe("families")
    if (policy.kind !== "families") throw new Error("unreachable")
    expect(policy.profileId).toBe("cheaplocal")
    expect([...policy.families].sort()).toEqual(["luna", "sol"])
  })

  test("a registered cheaplocal launch does NOT make the main loop local", () => {
    const launch = registerLaunch({
      profileId: "cheaplocal",
      nonce: "nonce",
      secret: "secret",
    })
    try {
      // The hazard the narrowing prevents: a restricted policy is not the
      // same fact as a local main loop.
      expect(activeLocalLaunchProfile()).toBeUndefined()
      expect(effectiveLocalProfile(undefined)).toBeUndefined()
      expect(effectiveLocalProfile("cheaplocal")).toBeUndefined()
      expect(effectiveLocalProfile("local2")).toBe("local2")
    } finally {
      unregisterLaunch(launch.launchId)
    }
  })

  test("Luna and Sol pass the ceiling, everything else is refused", () => {
    const launch = registerLaunch({
      profileId: "cheaplocal",
      nonce: "nonce",
      secret: "secret",
    })
    try {
      expect(() => assertCopilotModelAllowed("gpt-6-luna")).not.toThrow()
      expect(() => assertCopilotModelAllowed("gpt-5.6-sol")).not.toThrow()
      expect(() => assertCopilotModelAllowed("gpt-6.1-sol[1m]")).not.toThrow()
      expect(() => assertCopilotModelAllowed("claude-opus-5.5")).toThrow(
        CopilotModelRestrictedError,
      )
      expect(() => assertCopilotModelAllowed("gemini-3.1-pro-preview")).toThrow(
        CopilotModelRestrictedError,
      )
      // The browser page compressor is the one named carve-out.
      expect(() =>
        assertCopilotModelAllowed("gemini-3.1-pro-preview", "browse"),
      ).not.toThrow()
    } finally {
      unregisterLaunch(launch.launchId)
    }
  })
})

describe("the local endpoint flags are live for cheaplocal", () => {
  afterEach(() => {
    configureLocalEgress({})
  })

  test("--localurl configures the consultants' endpoint and beats the env", () => {
    configureLocalEgress({ profileId: "cheaplocal", baseUrl: "http://127.0.0.1:9123/v1" })
    expect(localBaseUrl({})).toBe("http://127.0.0.1:9123/v1")
    expect(localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "http://env.example/v1" })).toBe(
      "http://127.0.0.1:9123/v1",
    )
  })

  test("--localport configures the consultants' endpoint", () => {
    configureLocalEgress({ profileId: "cheaplocal", port: 9555 })
    expect(localBaseUrl({})).toBe("https://localhost:9555/v1")
  })

  test("a non-consulting profile refuses the override", () => {
    configureLocalEgress({ profileId: "cheapest", baseUrl: "http://127.0.0.1:9123/v1" })
    // Refused, not merely warned about: the stored override is cleared, so
    // the default endpoint is in force.
    expect(localBaseUrl({})).toBe(LOCAL_DEFAULT_BASE_URL)
  })
})
