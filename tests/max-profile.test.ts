import { afterEach, describe, expect, test } from "bun:test"

import {
  MAX_LUNA_HIGH_ALIAS_ID,
  MAX_LUNA_MAX_ALIAS_ID,
  canonicalizeAliasModel,
  resolveModelAlias,
  resolveLaunchProfile,
} from "../src/lib/launch-profile"
import {
  MAX_AGENT_SCHEMA_MODEL_ALIASES,
  decideMaxDispatchGuard,
} from "../src/lib/max-dispatch-acl"
import { BROWSE_DEFAULT_MODEL } from "../src/lib/worker-agent/engine"
import { state } from "../src/lib/state"
import { advisorSystemPrompt } from "../src/services/advisor/advisor"
import {
  MAX_PROFILE_ADVISOR_INSTRUCTIONS,
  MAX_PROFILE_MODELS,
  formatMaxPrerequisiteFailure,
  maxAdvisorModelFromPin,
  maxAdvisorPinIsValid,
  maxReviewerModel,
  validateMaxProfilePrerequisites,
} from "../src/lib/max-profile-contract"
import { buildPeerAgentDefinitions } from "../src/lib/codex-mcp-config"
import { buildPeerAwarenessSummary, buildPeerAwarenessSnippet } from "../src/lib/peer-mcp-personas"
import { preprocessMaxRequest } from "../src/lib/max-request-preprocess"
import { buildMaxDispatchGuardHookCommand } from "../src/internal-max-dispatch-guard"

const model = (id: string, options: {
  context?: number
  prompt?: number
  output?: number
  efforts?: string[]
  endpoints?: string[]
  adaptive?: boolean
} = {}) => ({
  id,
  name: id,
  object: "model" as const,
  preview: false,
  vendor: id.startsWith("claude") ? "anthropic" : "test",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: options.endpoints,
  capabilities: {
    family: id,
    object: "model_capabilities" as const,
    tokenizer: "o200k_base",
    type: "chat" as const,
    limits: {
      max_context_window_tokens: options.context,
      max_prompt_tokens: options.prompt,
      max_output_tokens: options.output,
    },
    supports: {
      tool_calls: true,
      reasoning_effort: options.efforts,
      adaptive_thinking: options.adaptive,
    },
  },
})

const savedModels = state.models

afterEach(() => {
  state.models = savedModels
})

const catalog = {
  object: "list" as const,
  data: [
    model("gpt-5.6-sol", { context: 1_050_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh", "max"], endpoints: ["/responses"] }),
    model("gpt-5.6-luna", { context: 1_050_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh", "max"], endpoints: ["/responses"] }),
    model("gemini-3.8-flash", { context: 1_000_000, prompt: 900_000, output: 32_000, efforts: ["low", "medium", "high"], endpoints: ["/chat/completions"] }),
    model("grok-4.6", { context: 500_000, prompt: 372_000, output: 16_000, efforts: ["low", "medium", "high"], endpoints: ["/responses"] }),
    model("claude-opus-5", { context: 1_000_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh"], endpoints: ["/messages"], adaptive: true }),
    model("claude-sonnet-5", { context: 1_000_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh"], endpoints: ["/messages"], adaptive: true }),
    model("gpt-5.3-codex", { context: 400_000, prompt: 272_000, output: 32_000, efforts: ["high", "xhigh"], endpoints: ["/responses"] }),
  ],
}

describe("max profile contract", () => {
  test("selects only the raw max alias", () => {
    expect(resolveLaunchProfile(" max ")).toBe("max")
    expect(resolveLaunchProfile("gpt-5.6-sol")).toBe("standard")
    expect(resolveLaunchProfile("fast")).toBe("fast")
  })

  test("keeps max Luna aliases distinct and canonicalizes them", () => {
    expect(resolveModelAlias(MAX_LUNA_HIGH_ALIAS_ID)?.absentEffortDefault).toBe("high")
    expect(resolveModelAlias(MAX_LUNA_MAX_ALIAS_ID)?.absentEffortDefault).toBe("max")
    expect(canonicalizeAliasModel(`${MAX_LUNA_MAX_ALIAS_ID}[1m]`)).toBe("gpt-5.6-luna[1m]")
  })

  test("validates mandatory models and actionable failure text", () => {
    const result = validateMaxProfilePrerequisites(catalog as never)
    expect(result.ok).toBe(true)
    const failure = validateMaxProfilePrerequisites({ object: "list", data: [] } as never)
    expect(failure.ok).toBe(false)
    expect(formatMaxPrerequisiteFailure(failure.missing)).toContain("gpt-5.6-sol")
  })

  test("resolves Max reviewer to Sonnet 5 1M xhigh from capabilities", () => {
    state.models = catalog as never
    expect(maxReviewerModel()).toBe("claude-sonnet-5")
  })

  test("shared native-model defaults match emitted frontmatter", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      maxProfile: true,
      groupKeys: { peers: "peers", search: "search", workers: "workers" },
      nonce: "0".repeat(64),
      codexHome: "/tmp/codex",
    })
    expect(agents.Explore?.model).toBe("gpt-5.6-luna[1m]")
    expect(agents.Plan?.model).toBe("gpt-5.6-sol[1m]")
    expect(agents["general-purpose"]?.model).toBe("gpt-5.6-luna[1m]")
    expect(agents.implementer?.model).toBe("gemini-3.8-flash[1m]")
    expect(agents.reviewer?.model).toBe("claude-sonnet-5[1m]")
    expect(agents.brainstorm?.model).toBe("claude-opus-5[1m]")
    expect(agents["peer-review-coordinator"]?.model).toBe("gpt-5.6-luna[1m]")
  })

  test("emits the exact max native roster and explicit model efforts", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      maxProfile: true,
      groupKeys: { peers: "peers", search: "search", workers: "workers" },
      nonce: "0".repeat(64),
      codexHome: "/tmp/codex",
      maxExploreModel: MAX_PROFILE_MODELS.luna,
      maxPlanModel: MAX_PROFILE_MODELS.sol,
      maxGeneralPurposeModel: MAX_PROFILE_MODELS.luna,
      maxImplementerModel: MAX_PROFILE_MODELS.gemini,
      maxReviewerModel: MAX_PROFILE_MODELS.sonnet,
      maxBrainstormModel: MAX_PROFILE_MODELS.opus,
      maxPeerModels: { sol: MAX_PROFILE_MODELS.sol, codex: MAX_PROFILE_MODELS.codex, sonnet: MAX_PROFILE_MODELS.sonnet, luna: MAX_PROFILE_MODELS.luna, gemini: MAX_PROFILE_MODELS.gemini, grok: MAX_PROFILE_MODELS.grok, opus: MAX_PROFILE_MODELS.opus },
    })
    expect(Object.keys(agents).sort()).toEqual([
      "Explore", "Plan", "brainstorm", "general-purpose", "implementer", "peer-review-coordinator", "reviewer",
    ])
    expect(agents.Plan?.model).toBe("gpt-5.6-sol[1m]")
    expect(agents.Plan?.effort).toBe("high")
    expect(agents.reviewer?.model).toBe("claude-sonnet-5[1m]")
    expect(agents.reviewer?.effort).toBe("xhigh")
    expect(agents.brainstorm?.model).toBe("claude-opus-5[1m]")
    expect(agents.brainstorm?.effort).toBe("high")
    expect(agents.implementer?.model).toBe("gemini-3.8-flash[1m]")
    expect(agents.implementer?.effort).toBe("high")
    expect(agents["peer-review-coordinator"]?.prompt).toContain("sol_critic")
    expect(agents["peer-review-coordinator"]?.prompt).toContain("codex_reviewer")
    expect(agents["peer-review-coordinator"]?.tools).toEqual(["mcp__peers__*"])
    for (const role of ["Explore", "Plan", "reviewer", "brainstorm"] as const) {
      expect(agents[role]?.tools).not.toContain("mcp__peers__*")
    }
    expect(agents.Explore?.description).toContain("Best suited")
    expect(agents.Plan?.prompt).toContain("the lead owns plan acceptance")
    expect(agents.implementer?.prompt).toContain("Role: coding implementation")
    expect(agents.reviewer?.prompt).toContain("distinguish no findings from checks not run")
    expect(agents.brainstorm?.prompt).toContain("the lead owns the decision")
    expect(agents["peer-review-coordinator"]?.prompt).toContain("Peer output is advisory")
    expect(agents.scout).toBeUndefined()
    expect(agents["worker-browse"]).toBeUndefined()
  })

  test("public Agent schema placeholders reach every max role through frontmatter", () => {
    const roles = [
      "Explore",
      "Plan",
      "general-purpose",
      "implementer",
      "reviewer",
      "brainstorm",
      "peer-review-coordinator",
    ]
    for (const role of roles) {
      for (const schemaModel of MAX_AGENT_SCHEMA_MODEL_ALIASES) {
        const reviewerFallback = role === "reviewer"
          ? { reviewerModel: "claude-sonnet-5", reviewerEffort: "xhigh" as const }
          : undefined
        const decision = decideMaxDispatchGuard({
          tool_name: "Agent",
          tool_input: {
            subagent_type: role,
            prompt: "smoke test",
            model: schemaModel,
          },
        }, reviewerFallback)
        expect(decision.allowed).toBe(true)
        expect(decision.updatedInput).toEqual({
          subagent_type: role,
          prompt: "smoke test",
          ...(role === "reviewer" ? { effort: "xhigh" } : {}),
        })
      }
    }
  })

  test("pins the retained browse dispatcher to Luna high", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      maxProfile: true,
      browseAvailable: true,
      groupKeys: { peers: "peers", search: "search", workers: "workers" },
      nonce: "0".repeat(64),
      codexHome: "/tmp/codex",
    })
    expect(agents["worker-browse"]?.model).toBe("gpt-5.6-luna[1m]")
    expect(agents["worker-browse"]?.effort).toBe("high")
    expect(agents["worker-browse"]?.tools).toEqual(["mcp__workers__*"])
  })

  test("allows the retained browse dispatcher while preserving its fixed frontmatter", () => {
    // The hook bundle deliberately avoids importing the worker runtime, so pin
    // its local effective-model constant to the worker engine's SSOT here.
    expect(BROWSE_DEFAULT_MODEL).toBe("gpt-5.6-luna")
    for (const schemaModel of MAX_AGENT_SCHEMA_MODEL_ALIASES) {
      const decision = decideMaxDispatchGuard({
        tool_name: "Agent",
        tool_input: {
          subagent_type: "worker-browse",
          prompt: "open example.com",
          model: schemaModel,
        },
      })
      expect(decision.allowed).toBe(true)
      expect(decision.updatedInput).toEqual({
        subagent_type: "worker-browse",
        prompt: "open example.com",
      })
    }
  })

  test("continues to deny non-max native agents", () => {
    for (const target of ["scout", "scribe", "worker-explore"]) {
      const decision = decideMaxDispatchGuard({
        tool_name: "Agent",
        tool_input: {
          subagent_type: target,
          prompt: "smoke test",
          model: "fable",
        },
      })
      expect(decision.allowed).toBe(false)
    }
  })

  test("normalizes schema placeholder spelling before removing it", () => {
    for (const modelAlias of [" Opus ", "FABLE", "haiku[1m]"]) {
      const decision = decideMaxDispatchGuard({
        tool_name: "Agent",
        tool_input: {
          subagent_type: "implementer",
          prompt: "smoke test",
          model: modelAlias,
        },
      })
      expect(decision.allowed).toBe(true)
      expect(decision.updatedInput).toEqual({
        subagent_type: "implementer",
        prompt: "smoke test",
      })
    }
  })

  test("schema placeholders validate effort against the target frontmatter model", () => {
    const planRole = decideMaxDispatchGuard({
      tool_name: "Agent",
      tool_input: { subagent_type: "Plan", model: "sonnet", effort: "high" },
    })
    expect(planRole.allowed).toBe(true)
    expect(planRole.updatedInput).toEqual({
      subagent_type: "Plan",
      effort: "high",
    })
    expect(decideMaxDispatchGuard({
      tool_name: "Agent",
      tool_input: { subagent_type: "Plan", model: "sonnet", effort: "low" },
    }).allowed).toBe(false)

    const geminiRole = decideMaxDispatchGuard({
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer", model: "fable", effort: "xhigh" },
    })
    expect(geminiRole.allowed).toBe(false)

    const lunaRole = decideMaxDispatchGuard({
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "fable", effort: "max" },
    })
    expect(lunaRole.allowed).toBe(true)
    expect(lunaRole.updatedInput).toEqual({
      subagent_type: "general-purpose",
      effort: "max",
    })
  })

  test("persists the resolved reviewer model and effort in the Max hook command", () => {
    expect(buildMaxDispatchGuardHookCommand(
      { execPath: "/usr/bin/node", scriptPath: "/app/main.js" },
      { reviewerModel: "gpt-5.6-luna", reviewerEffort: "max" },
    )).toBe(
      '"/usr/bin/node" "/app/main.js" internal-max-dispatch-guard --reviewerModel "gpt-5.6-luna" --reviewerEffort max',
    )
  })

  test("max dispatch ACL preserves allowed catalog overrides and pins the resolved reviewer fallback effort", () => {
    const allowed = decideMaxDispatchGuard(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", model: "gpt-5.6-luna[1m]" } }))
    expect(allowed.allowed).toBe(true)
    expect(allowed.updatedInput?.model).toBe("gpt-5.6-luna[1m]")

    const fallback = decideMaxDispatchGuard(
      { tool_name: "Agent", tool_input: { subagent_type: "reviewer", model: "fable" } },
      { reviewerModel: "gpt-5.6-luna", reviewerEffort: "max" },
    )
    expect(fallback.allowed).toBe(true)
    expect(fallback.updatedInput).toEqual({ subagent_type: "reviewer", effort: "max" })

    const grok = decideMaxDispatchGuard(
      { tool_name: "Agent", tool_input: { subagent_type: "reviewer", model: "fable" } },
      { reviewerModel: "grok-4.6", reviewerEffort: "high" },
    )
    expect(grok.updatedInput).toEqual({ subagent_type: "reviewer", effort: "high" })

    const denied = decideMaxDispatchGuard(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", model: "gpt-5.6-sol[1m]" } }))
    expect(denied.allowed).toBe(false)
  })

  test("max request preprocessor canonicalizes max aliases and enforces allowed lead models", () => {
    const launch = {
      launchId: "test-max",
      profileId: "max" as const,
      nonce: "test",
      secret: "secret",
      createdAt: Date.now(),
    }
    const aliasReq = preprocessMaxRequest(
      JSON.stringify({ model: MAX_LUNA_HIGH_ALIAS_ID, messages: [] }),
      launch,
    )
    expect(aliasReq.modified).toBe(true)
    expect(JSON.parse(aliasReq.body).model).toBe("gpt-5.6-luna")
    expect(JSON.parse(aliasReq.body).output_config.effort).toBe("high")

    const allowedLead = preprocessMaxRequest(
      JSON.stringify({ model: "gpt-5.6-sol[1m]", messages: [] }),
      launch,
    )
    expect(allowedLead.modified).toBe(true)
    expect(allowedLead.rejectedModel).toBeUndefined()

    const grokBody = JSON.stringify({ model: "grok-4.6", messages: [] })
    const disallowedLead = preprocessMaxRequest(grokBody, launch)
    expect(disallowedLead.rejectedModel).toBe("grok-4.6")

    const allowedSubagent = preprocessMaxRequest(grokBody, launch, true)
    expect(allowedSubagent.rejectedModel).toBeUndefined()
    expect(allowedSubagent.modified).toBe(true)
    expect(JSON.parse(allowedSubagent.body).output_config.effort).toBe("high")

    const lunaReviewer = preprocessMaxRequest(
      JSON.stringify({ model: "gpt-5.6-luna[1m]", messages: [] }),
      launch,
      true,
    )
    expect(JSON.parse(lunaReviewer.body).output_config.effort).toBe("max")
  })

  test("keeps Max Advisor optional, non-binding, and out of routine workflow gates", () => {
    for (const required of [
      "optional",
      "not a supervisor",
      "You keep decision ownership",
      "focused command or test",
      "Do not call it automatically before substantive work or completion",
      "directly verifiable facts",
      "planner approval",
      "reviewer verification",
      "materially new evidence",
      "advice, not authority",
    ]) {
      expect(MAX_PROFILE_ADVISOR_INSTRUCTIONS).toContain(required)
    }
    expect(MAX_PROFILE_ADVISOR_INSTRUCTIONS).not.toContain("call advisor at least once")
  })

  test("gives max Advisor a non-binding consultant system prompt without changing neighbors", () => {
    const standard = advisorSystemPrompt(false, false, false)
    const fast = advisorSystemPrompt(false, true, false)
    const max = advisorSystemPrompt(false, false, true)
    expect(max).toContain("non-binding consultant")
    expect(max).toContain("not an invitation to supervise the whole session")
    expect(max).toContain("Do not approve, veto, dictate")
    expect(max).not.toContain("actionable advice on the next step or course-correction")
    expect(max).not.toContain("Give a directive recommendation")
    expect(fast).toContain("non-binding consultant")
    expect(standard).not.toContain("non-binding consultant")
    expect(advisorSystemPrompt(true, false, false)).toContain("Give a directive recommendation")
  })

  test("validates max advisor pins strictly", () => {
    expect(maxAdvisorPinIsValid(undefined)).toBe(true)
    expect(maxAdvisorPinIsValid("")).toBe(true)
    expect(maxAdvisorPinIsValid("gpt-5.6-sol")).toBe(true)
    expect(maxAdvisorPinIsValid("claude-opus-5")).toBe(true)
    expect(maxAdvisorPinIsValid("gpt-5.6-sol[1m]")).toBe(true)
    expect(maxAdvisorPinIsValid("claude-opus-5[1m]")).toBe(true)
    expect(maxAdvisorPinIsValid("gemini-3.8-flash")).toBe(false)
    expect(maxAdvisorPinIsValid("gpt-5.6-luna")).toBe(false)
    expect(maxAdvisorModelFromPin("gpt-5.6-sol", "claude-opus-5")).toBe("gpt-5.6-sol")
    expect(maxAdvisorModelFromPin(undefined, "claude-opus-5")).toBe("claude-opus-5")
  })

  test("max awareness omits orchestration and core workers", () => {
    const snippet = buildPeerAwarenessSnippet({
      profile: "max",
      codexCli: false,
      geminiAvailable: true,
      workerToolsAvailable: false,
      standInAvailable: true,
      browseAvailable: false,
      compoundBrowseAvailable: false,
      groupKeys: { peers: "peers", search: "search" },
    })
    expect(snippet).toContain("general-purpose")
    expect(snippet).toContain("menu of complementary capabilities")
    expect(snippet).toContain("Small or obvious tasks are often better handled directly")
    expect(snippet).toContain("evidence to synthesize rather than a vote")
    expect(snippet).toContain("Advisor is optional, non-binding")
    expect(snippet).toContain("not a supervisor")
    expect(snippet).toContain("materially new evidence")
    expect(snippet).not.toContain("orchestrate")
    const summary = buildPeerAwarenessSummary({ profile: "max", workerToolsAvailable: false, standInAvailable: false, browseAvailable: false })
    expect(summary).toContain("Max launch profile")
    expect(summary).toContain("Advisor is optional, non-binding")
    expect(summary).toContain("no approval or workflow authority")
    expect(summary).toContain("focused consequential uncertainty")
    expect(summary).not.toContain("worker-browse")

    const browseSummary = buildPeerAwarenessSummary({
      profile: "max",
      workerToolsAvailable: false,
      standInAvailable: false,
      browseAvailable: true,
      browserToolsAvailable: true,
      groupKeys: { browser: "browser", workers: "workers" },
    })
    expect(browseSummary).toContain("worker-browse")
    expect(browseSummary).toContain("mcp__workers__browse")
    expect(browseSummary).toContain("mcp__browser__*")
    expect(browseSummary).not.toContain("orchestrate")

    const workerOnlySummary = buildPeerAwarenessSummary({
      profile: "max",
      workerToolsAvailable: false,
      standInAvailable: false,
      browseAvailable: true,
      browserToolsAvailable: false,
      groupKeys: { browser: "browser", workers: "workers" },
    })
    expect(workerOnlySummary).toContain("worker-browse")
    expect(workerOnlySummary).not.toContain("mcp__browser__*")
  })
})
