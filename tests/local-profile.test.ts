// Profile identity, lead resolution and prerequisites for `-m local` /
// `-m local2`. These are the seams that make the local pair a THIRD family:
// neither a cheapest sibling (different egress, non-Copilot ids) nor a
// standard launch (pinned surface, 200K tier rows, no catalog for the lead).

import { describe, expect, test } from "bun:test"

import { claudeArgs, collectChildPassthroughArgs } from "../src/claude"
import { collectPiPassthroughArgs, piArgs } from "../src/pi"
import { preprocessFastRequest } from "~/lib/fast-request-preprocess"
import {
  formatLocalPrerequisiteFailure,
  profileDescriptor,
  resolveLaunchProfile,
  validateLocalProfilePrerequisites,
} from "~/lib/launch-profile"
import { LOCAL_PROFILE_TIER_MODELS } from "~/lib/local-profile-contract"
import { selectableModelsInCatalog } from "~/lib/model-picker-settings"
import { resolveLeadSlugArg } from "~/lib/port"
import {
  isBalancedFamily,
  isCheapestFamily,
  isLocalFamily,
  isPinnedLaunchProfile,
  localContractFor,
  local2AdvisorContract,
} from "~/lib/profile-family"

describe("local profile identity", () => {
  test("the raw aliases resolve to the local family", () => {
    expect(resolveLaunchProfile("local")).toBe("local")
    expect(resolveLaunchProfile("local2")).toBe("local2")
    expect(resolveLaunchProfile(" LOCAL ")).toBe("local")
  })

  test("local is its own family, never a cheapest or balanced sibling", () => {
    expect(isLocalFamily("local")).toBe(true)
    expect(isLocalFamily("local2")).toBe(true)
    expect(isCheapestFamily("local")).toBe(false)
    expect(isBalancedFamily("local")).toBe(false)
    // ...while the existing families keep their own answers.
    expect(isCheapestFamily("cheapest2")).toBe(true)
    expect(isBalancedFamily("balanced2")).toBe(true)
    expect(isLocalFamily("cheapest2")).toBe(false)
  })

  test("the pinned surface switch knows both ids", () => {
    expect(isPinnedLaunchProfile("local")).toBe(true)
    expect(isPinnedLaunchProfile("local2")).toBe(true)
    // The pre-existing answers are unchanged.
    expect(isPinnedLaunchProfile("cheapest2")).toBe(true)
    expect(isPinnedLaunchProfile("standard")).toBe(false)
    expect(isPinnedLaunchProfile(undefined)).toBe(false)
  })

  test("the descriptors carry the cheapest roster and no coordinator", () => {
    const local = profileDescriptor("local")
    expect(local.id).toBe("local")
    expect(local.hasCoordinator).toBe(false)
    expect([...local.nativeRoster!]).toEqual([
      "Explore",
      "General-Purpose",
      "reviewer",
    ])
    expect(profileDescriptor("local2").id).toBe("local2")
    expect(profileDescriptor("local2").nativeRoster).toEqual(local.nativeRoster)
  })

  test("local keeps the `peers` group for artifacts and exactly one persona", () => {
    const local = profileDescriptor("local")
    // The group has to be registered for the artifact tools to list at all
    // (`ARTIFACT_GROUP` is `peers`). The Oracle is in it because `local`'s
    // consult now runs on the LOCAL tier: the invariant is "no Copilot model
    // is billed", not "no consultant exists", so the only persona that survives
    // is the one the local consult transport can serve.
    expect(local.allowedGroups!.has("peers")).toBe(true)
    expect([...local.personaAllowlist!]).toEqual(["oracle"])
  })

  test("local2 adds no persona that local lacks, only a Copilot-served Oracle", () => {
    const local = profileDescriptor("local")
    const local2 = profileDescriptor("local2")
    // Same persona SET; the difference is the transport behind it, which the
    // profile contract carries (`local` = local tier, `local2` = Sol).
    expect([...local2.personaAllowlist!]).toEqual(["oracle"])
    expect([...local2.allowedGroups!].sort()).toEqual([...local.allowedGroups!].sort())
  })

  test("neither profile can reach a Pi worker", () => {
    // A worker answers on a Copilot model, which is exactly what these
    // profiles exist to avoid.
    for (const id of ["local", "local2"] as const) {
      expect(profileDescriptor(id).allowedGroups!.has("workers")).toBe(false)
    }
  })

  test("both profiles keep the browser group", () => {
    // Browse is a capability, not an agent model call: the `browser_*` tools
    // drive a local extension, and the page compressor that backs the
    // compound tools carries its own fixed chain rather than a lead model.
    // Dropping the group here would silently remove browse from the modes
    // that most need a cheap way to look at a page.
    for (const id of ["local", "local2"] as const) {
      expect(profileDescriptor(id).allowedGroups!.has("browser")).toBe(true)
    }
  })

  test("the contract maps roles onto the three tier ids", () => {
    const contract = localContractFor("local")
    expect(contract.models.lead).toBe("opus")
    expect(contract.leadContextTokens).toBe(200_000)
    expect(contract.subagentContextTokens).toBe(200_000)
    // Advisor fields exist only on the `local2` contract.
    expect(local2AdvisorContract().advisorModel).toBe("gpt-6.1-sol")
    expect(local2AdvisorContract().advisorEffort).toBe("high")
  })
})

describe("lead resolution", () => {
  test("both aliases resolve to the bare opus tier id", () => {
    expect(resolveLeadSlugArg("local")).toBe("opus")
    expect(resolveLeadSlugArg("local2")).toBe("opus")
  })

  test("no catalog consultation and no [1m] decoration", () => {
    // `pickClaudeDefault`/`withOneMSuffixForLead` would both consult the
    // Copilot catalog; the bare tier id proves neither ran.
    expect(resolveLeadSlugArg("local")).not.toContain("[1m]")
    expect(resolveLeadSlugArg("local")).not.toMatch(/claude-/)
  })
})

describe("model picker rows", () => {
  test("local offers exactly the three bare tier ids, without a catalog", () => {
    const rows = selectableModelsInCatalog("local")
    expect(rows.map((r) => r.model)).toEqual(["opus", "sonnet", "haiku"])
    for (const row of rows) expect(row.model).not.toContain("[1m]")
    expect(rows.map((r) => r.model)).toEqual([
      LOCAL_PROFILE_TIER_MODELS.opus,
      LOCAL_PROFILE_TIER_MODELS.sonnet,
      LOCAL_PROFILE_TIER_MODELS.haiku,
    ])
  })

  test("local2 shares the same rows", () => {
    expect(selectableModelsInCatalog("local2")).toEqual(
      selectableModelsInCatalog("local"),
    )
  })
})

describe("request preprocess", () => {
  const launch = { profileId: "local" } as never
  const local2Launch = { profileId: "local2" } as never

  test("opus is forwarded verbatim, never rejected", () => {
    const raw = JSON.stringify({ model: "opus", messages: [] })
    for (const l of [launch, local2Launch]) {
      const out = preprocessFastRequest(raw, l)
      expect(out.body).toBe(raw)
      expect(out.modified).toBe(false)
      expect((out as { rejectedModel?: string }).rejectedModel).toBeUndefined()
    }
  })

  test("sonnet and haiku pass through too", () => {
    for (const model of ["sonnet", "haiku"]) {
      const raw = JSON.stringify({ model, messages: [] })
      expect(preprocessFastRequest(raw, launch).body).toBe(raw)
    }
  })
})

describe("prerequisites", () => {
  test("local needs no catalog entry at all", () => {
    expect(validateLocalProfilePrerequisites(undefined, "local")).toEqual({
      ok: true,
      missing: [],
    })
  })

  test("local2 fails loudly when the Advisor model is absent", () => {
    const result = validateLocalProfilePrerequisites(undefined, "local2")
    expect(result.ok).toBe(false)
    expect(result.missing.join("\n")).toContain("gpt-6.1-sol")
  })

  test("the failure message names the subcommand the user typed", () => {
    expect(formatLocalPrerequisiteFailure(["x"], "local2", "pi")).toStartWith(
      "github-router pi -m local2",
    )
    expect(formatLocalPrerequisiteFailure(["x"], "local2")).toStartWith(
      "github-router claude -m local2",
    )
  })
})

describe("child argv passthrough", () => {
  test("claude consumes --localport and its value", () => {
    expect(
      collectChildPassthroughArgs(
        ["-m", "local", "--localport", "11111", "--print", "hi"],
        claudeArgs,
      ),
    ).toEqual(["--print", "hi"])
  })

  test("claude consumes --localurl and its value", () => {
    expect(
      collectChildPassthroughArgs(
        ["-m", "local", "--localurl", "http://localhost:11111/v1", "--print"],
        claudeArgs,
      ),
    ).toEqual(["--print"])
  })

  test("pi consumes the same two flags", () => {
    expect(
      collectPiPassthroughArgs(
        ["-m", "local", "--localport", "11111", "--print", "hi"],
        piArgs,
      ),
    ).toEqual(["--print", "hi"])
    expect(
      collectPiPassthroughArgs(
        ["-m", "local", "--localurl", "http://localhost:11111/v1"],
        piArgs,
      ),
    ).toEqual([])
  })
})
