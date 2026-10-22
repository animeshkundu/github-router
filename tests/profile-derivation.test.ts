import { describe, expect, test } from "bun:test"

import {
  BALANCED_PROFILE_CONTRACT,
  BALANCED_PROFILE_MODELS,
} from "~/lib/balanced-profile-contract"
import {
  BALANCED2_PROFILE_CONTRACT,
  BALANCED2_PROFILE_MODELS,
} from "~/lib/balanced2-profile-contract"
import {
  CHEAPEST_PROFILE_CONTRACT,
  CHEAPEST_PROFILE_MODELS,
} from "~/lib/cheapest-profile-contract"
import {
  CHEAPEST2_PROFILE_CONTRACT,
  CHEAPEST2_PROFILE_MODELS,
} from "~/lib/cheapest2-profile-contract"
import {
  piAdvisorModel,
  piLeadModel,
  piLeadThinking,
  piNativeRoles,
  piOracleModel,
  piOracleThinking,
  piProfileModelIds,
} from "~/lib/pi-models-settings"
import {
  balancedContractFor,
  cheapestContractFor,
  cheapestRewriteModelFor,
  displayModelName,
  isBalancedFamily,
  isCheapestFamily,
  isPinnedLaunchProfile,
} from "~/lib/profile-family"
import { getClaudeCodeEnvVars } from "~/lib/server-setup"

/**
 * "Nothing else changes" is a claim about DERIVATION, so these tests assert it
 * structurally: every surface the `-2` aliases touch must equal the base
 * surface with only the declared substitutions applied. A new field added to a
 * base contract therefore fails here if a sibling silently fails to inherit it,
 * which a hand-written expectation list cannot catch.
 */

/** Replace a fixed set of keys, then assert the two records are equal. */
function expectDerived(
  base: Record<string, unknown>,
  derived: Record<string, unknown>,
  replacements: Record<string, unknown>,
): void {
  expect(derived).toEqual({ ...base, ...replacements })
}

describe("cheapest2 derives from cheapest", () => {
  const declared = {
    models: CHEAPEST2_PROFILE_MODELS,
    nativeModels: CHEAPEST2_PROFILE_CONTRACT.nativeModels,
    advisorModel: "gpt-6.1-sol",
    advisorClientModel: "gpt-6.1-sol",
    advisorEffort: "high",
    oracleModel: "gpt-6.1-sol",
  }

  test("the whole aggregate equals the base with only the declared deltas", () => {
    expectDerived(CHEAPEST_PROFILE_CONTRACT, CHEAPEST2_PROFILE_CONTRACT, declared)
  })

  test("every inherited field is the base value, identity included", () => {
    for (const key of Object.keys(CHEAPEST_PROFILE_CONTRACT) as Array<
      keyof typeof CHEAPEST_PROFILE_CONTRACT
    >) {
      if (key in declared) continue
      // Identity, not just equality: a copied literal would pass a deep-equal
      // check but would not be inherited. Widened to unknown because the
      // union of value types across the key set differs between the two
      // aggregates by design (that is exactly the delta being excluded here).
      const derivedValue: unknown = CHEAPEST2_PROFILE_CONTRACT[key]
      const baseValue: unknown = CHEAPEST_PROFILE_CONTRACT[key]
      expect(derivedValue).toBe(baseValue)
    }
  })

  test("the model map changes only the two Sol slots", () => {
    expectDerived(CHEAPEST_PROFILE_MODELS, CHEAPEST2_PROFILE_MODELS, {
      advisor: "gpt-6.1-sol",
      oracle: "gpt-6.1-sol",
    })
    expect(CHEAPEST2_PROFILE_MODELS.lead).toBe(CHEAPEST_PROFILE_MODELS.lead)
    expect(CHEAPEST2_PROFILE_MODELS.explore).toBe(CHEAPEST_PROFILE_MODELS.explore)
    expect(CHEAPEST2_PROFILE_MODELS.reviewer).toBe(CHEAPEST_PROFILE_MODELS.reviewer)
  })

  test("the native roster is inherited verbatim", () => {
    // cheapest2 keeps the Luna Explore/General-Purpose/reviewer trio. The
    // aggregate assertion above already covers this field, but naming it here
    // is what makes the "roster unchanged" claim checkable on its own.
    expect(CHEAPEST2_PROFILE_CONTRACT.nativeModels).toEqual(
      CHEAPEST_PROFILE_CONTRACT.nativeModels,
    )
  })

  test("the Advisor effort is the only non-model delta", () => {
    expect(CHEAPEST_PROFILE_CONTRACT.advisorEffort).toBe("medium")
    expect(CHEAPEST2_PROFILE_CONTRACT.advisorEffort).toBe("high")
    expect(CHEAPEST2_PROFILE_CONTRACT.oracleEffort).toBe(
      CHEAPEST_PROFILE_CONTRACT.oracleEffort,
    )
  })

  test("Pi resolves cheapest2 as cheapest with the 6.1 Sol identities", () => {
    expect(piLeadModel("cheapest2")).toBe(piLeadModel("cheapest"))
    expect(piLeadThinking("cheapest2")).toBe(piLeadThinking("cheapest"))
    expect(piOracleModel("cheapest2")).toBe("gpt-6.1-sol")
    expect(piOracleThinking("cheapest2")).toBe(piOracleThinking("cheapest"))
    expect(piAdvisorModel("cheapest2")).toEqual({
      model: "gpt-6.1-sol",
      thinking: "high",
    })
    expect(piAdvisorModel("cheapest")).toEqual({
      model: "gpt-5.6-sol",
      thinking: "medium",
    })

    // The native roles are untouched: only the consultant identities move.
    expect(piNativeRoles("cheapest2")).toEqual(piNativeRoles("cheapest"))
    expect([...piProfileModelIds("cheapest2")].sort()).toEqual(
      [
        ...piProfileModelIds("cheapest").filter(
          (id) => id !== "gpt-5.6-sol",
        ),
        "gpt-6.1-sol",
      ].sort(),
    )
  })

  test("the prompt rewrite follows the contract's Sol tier", () => {
    expect(cheapestRewriteModelFor("cheapest")).toBe("gpt-5.6-sol")
    expect(cheapestRewriteModelFor("cheapest2")).toBe("gpt-6.1-sol")
  })

  test("the server env pins bare 200K and the contracted lead effort", () => {
    const base = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-6-luna", "cheapest")
    const derived = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-6-luna", "cheapest2")
    expect(derived).toEqual(base)
    expect(derived.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1")
    expect(derived.CLAUDE_CODE_EFFORT_LEVEL).toBe(
      CHEAPEST_PROFILE_CONTRACT.leadEffort,
    )
    expect(derived).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
  })
})

describe("balanced2 derives from balanced", () => {
  const declared = {
    models: BALANCED2_PROFILE_MODELS,
    nativeModels: BALANCED2_PROFILE_CONTRACT.nativeModels,
    oracleModel: "grok-4.7",
  }

  test("the whole aggregate equals the base with only the declared deltas", () => {
    expectDerived(BALANCED_PROFILE_CONTRACT, BALANCED2_PROFILE_CONTRACT, declared)
  })

  test("every inherited field is the base value, identity included", () => {
    for (const key of Object.keys(BALANCED_PROFILE_CONTRACT) as Array<
      keyof typeof BALANCED_PROFILE_CONTRACT
    >) {
      if (key in declared) continue
      const derivedValue: unknown = BALANCED2_PROFILE_CONTRACT[key]
      const baseValue: unknown = BALANCED_PROFILE_CONTRACT[key]
      expect(derivedValue).toBe(baseValue)
    }
  })

  test("the model map changes the lead, reviewer, and Oracle only", () => {
    expectDerived(BALANCED_PROFILE_MODELS, BALANCED2_PROFILE_MODELS, {
      lead: "gpt-6.1-sol",
      reviewer: "gpt-6.1-sol",
      oracle: "grok-4.7",
    })
    expect(BALANCED2_PROFILE_MODELS.explore).toBe(BALANCED_PROFILE_MODELS.explore)
    expect(BALANCED2_PROFILE_MODELS["General-Purpose"]).toBe(
      BALANCED_PROFILE_MODELS["General-Purpose"],
    )
  })

  test("the native roster keeps the same roles and moves only the reviewer", () => {
    // Unlike cheapest2 (whose native models are all inherited), balanced2's
    // reviewer IS the Sol tier swap: the role set and the Luna entries are
    // inherited, and `reviewer` is the one declared delta.
    expect(Object.keys(BALANCED2_PROFILE_CONTRACT.nativeModels).sort()).toEqual(
      Object.keys(BALANCED_PROFILE_CONTRACT.nativeModels).sort(),
    )
    expect(BALANCED2_PROFILE_CONTRACT.nativeModels.Explore).toBe(
      BALANCED_PROFILE_CONTRACT.nativeModels.Explore,
    )
    expect(BALANCED2_PROFILE_CONTRACT.nativeModels["General-Purpose"]).toBe(
      BALANCED_PROFILE_CONTRACT.nativeModels["General-Purpose"],
    )
    expect(BALANCED_PROFILE_CONTRACT.nativeModels.reviewer).toBe("gpt-5.6-sol")
    expect(BALANCED2_PROFILE_CONTRACT.nativeModels.reviewer).toBe("gpt-6.1-sol")
  })

  test("astra is inherited untouched (declarative only on this family)", () => {
    expect(BALANCED_PROFILE_MODELS.astra).toBe("gpt-6-astra")
    expect(BALANCED2_PROFILE_MODELS.astra).toBe("gpt-6-astra")
  })

  test("the Oracle effort stays at the base's medium", () => {
    expect(BALANCED_PROFILE_CONTRACT.oracleEffort).toBe("medium")
    expect(BALANCED2_PROFILE_CONTRACT.oracleEffort).toBe("medium")
  })

  test("Pi resolves balanced2 as balanced with the declared identities", () => {
    expect(piLeadModel("balanced2")).toBe("gpt-6.1-sol")
    expect(piLeadThinking("balanced2")).toBe(piLeadThinking("balanced"))
    expect(piOracleModel("balanced2")).toBe("grok-4.7")
    expect(piOracleThinking("balanced2")).toBe(piOracleThinking("balanced"))

    // Advisor-free by design: the `-2` sibling does not wire one either.
    expect(piAdvisorModel("balanced2")).toBeUndefined()
    expect(piAdvisorModel("balanced")).toBeUndefined()

    const baseRoles = piNativeRoles("balanced")
    const derivedRoles = piNativeRoles("balanced2")
    expect(derivedRoles.map((r) => ({ ...r, model: undefined }))).toEqual(
      baseRoles.map((r) => ({ ...r, model: undefined })),
    )
    expect(derivedRoles.map((r) => r.model)).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"])
  })

  test("the server env pins bare 200K and the contracted lead effort", () => {
    const base = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-5.6-sol", "balanced")
    const derived = getClaudeCodeEnvVars("http://127.0.0.1:8787", "gpt-6.1-sol", "balanced2")
    const { ANTHROPIC_MODEL: baseModel, ...baseRest } = base
    const { ANTHROPIC_MODEL: derivedModel, ...derivedRest } = derived
    expect(baseModel).toBe("gpt-5.6-sol")
    expect(derivedModel).toBe("gpt-6.1-sol")
    expect(derivedRest).toEqual(baseRest)
    expect(derivedRest.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1")
    expect(derivedRest.CLAUDE_CODE_EFFORT_LEVEL).toBe(
      BALANCED_PROFILE_CONTRACT.leadEffort,
    )
    expect(derivedRest).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
  })
})

describe("family helpers", () => {
  test("recognize both siblings and nothing else", () => {
    for (const id of ["cheapest", "cheapest2"]) {
      expect(isCheapestFamily(id)).toBe(true)
      expect(isBalancedFamily(id)).toBe(false)
    }
    for (const id of ["balanced", "balanced2"]) {
      expect(isBalancedFamily(id)).toBe(true)
      expect(isCheapestFamily(id)).toBe(false)
    }
    for (const id of ["fast", "max", "cheap", "cheap1m", "standard", "", undefined, null]) {
      expect(isCheapestFamily(id)).toBe(false)
      expect(isBalancedFamily(id)).toBe(false)
    }
  })

  test("both siblings are pinned launches", () => {
    for (const id of ["cheapest", "cheapest2", "balanced", "balanced2"]) {
      expect(isPinnedLaunchProfile(id)).toBe(true)
    }
  })

  test("contract selectors return the sibling's aggregate, base as fallback", () => {
    expect(cheapestContractFor("cheapest")).toBe(CHEAPEST_PROFILE_CONTRACT)
    expect(cheapestContractFor("cheapest2")).toBe(CHEAPEST2_PROFILE_CONTRACT)
    expect(cheapestContractFor("balanced2")).toBe(CHEAPEST_PROFILE_CONTRACT)
    expect(cheapestContractFor(undefined)).toBe(CHEAPEST_PROFILE_CONTRACT)
    expect(balancedContractFor("balanced")).toBe(BALANCED_PROFILE_CONTRACT)
    expect(balancedContractFor("balanced2")).toBe(BALANCED2_PROFILE_CONTRACT)
    expect(balancedContractFor("cheapest")).toBe(BALANCED_PROFILE_CONTRACT)
  })

  test("display names are spelled, and unknown ids pass through verbatim", () => {
    expect(displayModelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol")
    expect(displayModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol")
    expect(displayModelName("grok-4.7")).toBe("Grok 4.7")
    expect(displayModelName("grok-4.6")).toBe("Grok 4.6")
    expect(displayModelName("some-future-model")).toBe("some-future-model")
  })
})
