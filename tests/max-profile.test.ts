import { describe, expect, test } from "bun:test"

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
import {
  MAX_PROFILE_MODELS,
  formatMaxPrerequisiteFailure,
  maxAdvisorModelFromPin,
  maxAdvisorPinIsValid,
  validateMaxProfilePrerequisites,
} from "../src/lib/max-profile-contract"
import { buildPeerAgentDefinitions } from "../src/lib/codex-mcp-config"
import { buildPeerAwarenessSummary, buildPeerAwarenessSnippet } from "../src/lib/peer-mcp-personas"
import { preprocessMaxRequest } from "../src/lib/max-request-preprocess"

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

const catalog = {
  object: "list" as const,
  data: [
    model("gpt-5.6-sol", { context: 1_050_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh", "max"], endpoints: ["/responses"] }),
    model("gpt-5.6-luna", { context: 1_050_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh", "max"], endpoints: ["/responses"] }),
    model("gemini-3.7-flash", { context: 1_000_000, prompt: 900_000, output: 32_000, efforts: ["low", "medium", "high"], endpoints: ["/chat/completions"] }),
    model("grok-4.6", { context: 500_000, prompt: 372_000, output: 16_000, efforts: ["low", "medium", "high"], endpoints: ["/responses"] }),
    model("claude-opus-5", { context: 1_000_000, prompt: 900_000, output: 32_000, efforts: ["high", "xhigh"], endpoints: ["/messages"], adaptive: true }),
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
    expect(agents.implementer?.model).toBe("gemini-3.7-flash[1m]")
    expect(agents.reviewer?.model).toBe("gemini-3.7-flash[1m]")
    expect(agents.brainstorm?.model).toBe("grok-4.6")
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
      maxReviewerModel: MAX_PROFILE_MODELS.grok,
      maxBrainstormModel: MAX_PROFILE_MODELS.grok,
      maxPeerModels: { sol: MAX_PROFILE_MODELS.sol, luna: MAX_PROFILE_MODELS.luna, gemini: MAX_PROFILE_MODELS.gemini, grok: MAX_PROFILE_MODELS.grok, opus: MAX_PROFILE_MODELS.opus },
    })
    expect(Object.keys(agents).sort()).toEqual([
      "Explore", "Plan", "brainstorm", "general-purpose", "implementer", "peer-review-coordinator", "reviewer",
    ])
    expect(agents.Plan?.model).toBe("gpt-5.6-sol[1m]")
    expect(agents.Plan?.effort).toBe("high")
    expect(agents.reviewer?.model).toBe("grok-4.6")
    expect(agents.reviewer?.effort).toBe("high")
    expect(agents.implementer?.model).toBe("gemini-3.7-flash[1m]")
    expect(agents.implementer?.effort).toBe("high")
    expect(agents["peer-review-coordinator"]?.prompt).toContain("sol_critic")
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
        const decision = decideMaxDispatchGuard({
          tool_name: "Agent",
          tool_input: {
            subagent_type: role,
            prompt: "smoke test",
            model: schemaModel,
          },
        })
        expect(decision.allowed).toBe(true)
        expect(decision.updatedInput).toEqual({
          subagent_type: role,
          prompt: "smoke test",
        })
      }
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

  test("max dispatch ACL preserves allowed catalog overrides and rejects Sol", () => {
    const allowed = decideMaxDispatchGuard(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", model: "gpt-5.6-luna[1m]" } }))
    expect(allowed.allowed).toBe(true)
    expect(allowed.updatedInput?.model).toBe("gpt-5.6-luna[1m]")
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
    expect(JSON.parse(allowedSubagent.body).output_config.effort).toBe("medium")
  })

  test("validates max advisor pins strictly", () => {
    expect(maxAdvisorPinIsValid(undefined)).toBe(true)
    expect(maxAdvisorPinIsValid("")).toBe(true)
    expect(maxAdvisorPinIsValid("gpt-5.6-sol")).toBe(true)
    expect(maxAdvisorPinIsValid("claude-opus-5")).toBe(true)
    expect(maxAdvisorPinIsValid("gpt-5.6-sol[1m]")).toBe(true)
    expect(maxAdvisorPinIsValid("claude-opus-5[1m]")).toBe(true)
    expect(maxAdvisorPinIsValid("gemini-3.7-flash")).toBe(false)
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
    expect(snippet).not.toContain("orchestrate")
    const summary = buildPeerAwarenessSummary({ profile: "max", workerToolsAvailable: false, standInAvailable: false, browseAvailable: false })
    expect(summary).toContain("Max launch profile")
  })
})
