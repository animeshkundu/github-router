import { afterEach, describe, expect, test } from "bun:test"

import {
  FAST_CRITIC_ALIAS_ID,
  LUNA_DRIVER_ALIAS_ID,
  LUNA_HAIKU_ALIAS_ID,
  LUNA_REAL_MODEL_ID,
  LUNA_SONNET_ALIAS_ID,
  canonicalizeAliasModel,
  formatCheap1mPrerequisiteFailure,
  formatCheapPrerequisiteFailure,
  formatFastPrerequisiteFailure,
  isRetiredFastModelAlias,
  profileDescriptor,
  resolveEffortWithAliasDefault,
  resolveLaunchProfile,
  resolveModelAlias,
  validateCheap1mProfilePrerequisites,
  validateCheapProfilePrerequisites,
  validateFastProfilePrerequisites,
} from "../src/lib/launch-profile"
import {
  clearLaunchRegistry,
  registerLaunch,
} from "../src/lib/launch-registry"
import {
  LAUNCH_SECRET_HEADER,
  runMessagesIdentityPreflight,
} from "../src/lib/messages-identity-preflight"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { CHEAP_PROFILE_DELEGATION_GRAPH } from "../src/lib/cheap-profile-contract"
import { FAST_PROFILE_DELEGATION_GRAPH } from "../src/lib/fast-profile-contract"

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

const fullCatalog = {
  object: "list" as const,
  data: [
    model("gpt-5.6-luna", { context: 1_050_000, efforts: ["high", "xhigh", "max"], endpoints: ["/responses"] }),
    model("gpt-5.6-sol", { context: 1_050_000, efforts: ["high", "max"], endpoints: ["/responses"] }),
    model("grok-4.6", { context: 500_000, prompt: 372_000, efforts: ["medium"], endpoints: ["/responses"] }),
    model("gemini-3.8-flash", { context: 1_000_000, efforts: ["medium", "high"], endpoints: ["/chat/completions"] }),
    {
      ...model("claude-sonnet-5", { context: 1_000_000, prompt: 872_000, efforts: ["high", "xhigh", "max"], endpoints: ["/v1/messages"] }),
      capabilities: {
        ...model("claude-sonnet-5").capabilities,
        limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 872_000 },
        supports: { tool_calls: true, reasoning_effort: ["high", "xhigh", "max"], adaptive_thinking: true },
      },
    },
    {
      ...model("claude-opus-5", { context: 1_000_000, prompt: 872_000, efforts: ["high", "max"], endpoints: ["/v1/messages"] }),
      capabilities: {
        ...model("claude-opus-5").capabilities,
        limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 872_000 },
        supports: { tool_calls: true, reasoning_effort: ["high", "max"], adaptive_thinking: true },
      },
    },
  ],
}

const savedModels = state.models

afterEach(() => {
  clearLaunchRegistry()
  state.models = savedModels
})

describe("launch profile selection", () => {
  test("only the literal fast alias selects the fast surface", () => {
    expect(resolveLaunchProfile("fast")).toBe("fast")
    expect(resolveLaunchProfile(" FAST ")).toBe("fast")
    expect(resolveLaunchProfile(undefined)).toBe("standard")
    expect(resolveLaunchProfile("")).toBe("standard")
    expect(resolveLaunchProfile("gpt-5.6-luna")).toBe("standard")
    expect(resolveLaunchProfile("fast-mode")).toBe("standard")
  })

  test("only the literal cheap aliases select the cheap-family surface", () => {
    expect(resolveLaunchProfile("cheap")).toBe("cheap")
    expect(resolveLaunchProfile(" CHEAP ")).toBe("cheap")
    expect(resolveLaunchProfile("cheap1m")).toBe("cheap1m")
    expect(resolveLaunchProfile("cheap1m ")).toBe("cheap1m")
    expect([...profileDescriptor("cheap").personaAllowlist!]).toEqual(["oracle"])
    expect([...profileDescriptor("cheap1m").personaAllowlist!]).toEqual(["oracle", "astra"])
  })
})

describe("Luna aliases", () => {
  test("canonicalize to Luna while retaining distinct defaults", () => {
    expect(resolveModelAlias(`${LUNA_DRIVER_ALIAS_ID}[1m]`)?.absentEffortDefault).toBe("max")
    expect(resolveModelAlias(`${FAST_CRITIC_ALIAS_ID}[1m]`)).toBeUndefined()
    expect(isRetiredFastModelAlias(`${FAST_CRITIC_ALIAS_ID}[1m]`)).toBe(true)
    expect(canonicalizeAliasModel(`${FAST_CRITIC_ALIAS_ID}[1m]`)).toBe(`${FAST_CRITIC_ALIAS_ID}[1m]`)
    expect(resolveModelAlias(LUNA_SONNET_ALIAS_ID)?.absentEffortDefault).toBe("xhigh")
    expect(resolveModelAlias(LUNA_HAIKU_ALIAS_ID)?.absentEffortDefault).toBe("high")
    expect(canonicalizeAliasModel(`${LUNA_SONNET_ALIAS_ID}[1m]`)).toBe(`${LUNA_REAL_MODEL_ID}[1m]`)
    expect(canonicalizeAliasModel("gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })

  test("effort precedence is explicit then thinking then alias default", () => {
    expect(resolveEffortWithAliasDefault({ aliasId: LUNA_DRIVER_ALIAS_ID })).toBe("max")
    expect(resolveEffortWithAliasDefault({ aliasId: LUNA_DRIVER_ALIAS_ID, thinkingBucketedEffort: "medium" })).toBe("medium")
    expect(resolveEffortWithAliasDefault({ aliasId: LUNA_DRIVER_ALIAS_ID, thinkingBucketedEffort: "medium", explicitEffort: "low" })).toBe("low")
    expect(resolveEffortWithAliasDefault({ aliasId: "gpt-5.6-sol" })).toBeUndefined()
  })
})

describe("fast startup prerequisites", () => {
  test("accepts both live bare and prefixed chat endpoint spellings", () => {
    expect(validateFastProfilePrerequisites(fullCatalog as never)).toEqual({ ok: true, missing: [] })
    const prefixed = {
      ...fullCatalog,
      data: fullCatalog.data.map((entry) =>
        entry.id === "gemini-3.8-flash"
          ? { ...entry, supported_endpoints: ["/v1/chat/completions"] }
          : entry,
      ),
    }
    expect(validateFastProfilePrerequisites(prefixed as never)).toEqual({ ok: true, missing: [] })
  })

  test("reports every missing or invalid prerequisite and rollback command", () => {
    const result = validateFastProfilePrerequisites({ object: "list", data: [] } as never)
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(5)
    const message = formatFastPrerequisiteFailure(result.missing)
    expect(message).toContain("gpt-5.6-luna")
    expect(message).toContain("claude-sonnet-5")
    expect(message).toContain("gemini-3.8-flash")
    expect(message).toContain("github-router claude")
  })
})

function cheapCatalog(): typeof fullCatalog {
  return {
    object: "list" as const,
    data: [
      // Lead: 1M window, chat endpoint, high effort (same gemini as fast).
      model("gemini-3.8-flash", { context: 1_000_000, efforts: ["medium", "high"], endpoints: ["/chat/completions"] }),
      // Subagents run at the 200K default window, not the fast 1M per-role
      // windows — the whole cheap cost lever.
      model("gpt-5.6-luna", { context: 500_000, prompt: 372_000, efforts: ["high", "max"], endpoints: ["/responses"] }),
      model("gpt-5.6-sol", { context: 500_000, efforts: ["high"], endpoints: ["/responses"] }),
      // Reviewer shares the Luna entry above (Luna/max at the 200K default
      // window), so no separate reviewer row is needed here.
      model("grok-4.6", { context: 500_000, prompt: 372_000, efforts: ["low", "medium"], endpoints: ["/responses"] }),
    ],
  }
}

describe("cheap-family startup prerequisites", () => {
  test("accepts the bare-slug 200K subagent catalog for both cheap siblings", () => {
    expect(validateCheapProfilePrerequisites(cheapCatalog() as never)).toEqual({ ok: true, missing: [] })
    expect(validateCheap1mProfilePrerequisites(cheapCatalog() as never)).toEqual({ ok: true, missing: [] })
  })

  test("cheap1m requires the leader to keep a 1M window even though subagents run at 200K", () => {
    const below = cheapCatalog()
    below.data = below.data.map((entry) =>
      entry.id === "gemini-3.8-flash"
        ? { ...entry, capabilities: { ...entry.capabilities, limits: { ...entry.capabilities.limits, max_context_window_tokens: 400_000 } } }
        : entry,
    ) as typeof fullCatalog["data"]
    const cheap1mResult = validateCheap1mProfilePrerequisites(below as never)
    expect(cheap1mResult.ok).toBe(false)
    expect(cheap1mResult.missing).toEqual([
      "gemini-3.8-flash: advertised context window is below 1M (leader window)",
    ])
    // The same 400K leader is FINE for `-m cheap`, whose only lead gate is
    // the 200K default floor the bare slug actually runs at.
    expect(validateCheapProfilePrerequisites(below as never)).toEqual({ ok: true, missing: [] })
  })

  test("cheap requires the leader to clear the 200K default lead floor", () => {
    const below = cheapCatalog()
    below.data = below.data.map((entry) =>
      entry.id === "gemini-3.8-flash"
        ? { ...entry, capabilities: { ...entry.capabilities, limits: { ...entry.capabilities.limits, max_context_window_tokens: 100_000 } } }
        : entry,
    ) as typeof fullCatalog["data"]
    const cheapResult = validateCheapProfilePrerequisites(below as never)
    expect(cheapResult.ok).toBe(false)
    expect(cheapResult.missing).toEqual([
      "gemini-3.8-flash: advertised context window is below the 200K lead floor",
    ])
    // The same 100K leader also fails cheap1m, but on its own 1M gate.
    const cheap1mResult = validateCheap1mProfilePrerequisites(below as never)
    expect(cheap1mResult.ok).toBe(false)
    expect(cheap1mResult.missing).toEqual([
      "gemini-3.8-flash: advertised context window is below 1M (leader window)",
    ])
  })

  test("rejects a subagent whose context window falls below the 200K floor", () => {
    const below = cheapCatalog()
    below.data = below.data.map((entry) =>
      entry.id === "gpt-5.6-sol"
        ? { ...entry, capabilities: { ...entry.capabilities, limits: { ...entry.capabilities.limits, max_context_window_tokens: 150_000 } } }
        : entry,
    ) as typeof fullCatalog["data"]
    const cheapResult = validateCheapProfilePrerequisites(below as never)
    expect(cheapResult.ok).toBe(false)
    expect(cheapResult.missing).toEqual([
      "gpt-5.6-sol: advertised context window is below the 200K subagent floor",
    ])
    const cheap1mResult = validateCheap1mProfilePrerequisites(below as never)
    expect(cheap1mResult.ok).toBe(false)
    expect(cheap1mResult.missing).toEqual([
      "gpt-5.6-sol: advertised context window is below the 200K subagent floor",
    ])
  })

  test("cheap and cheap1m reject every role-specific capability failure with the exact same message", () => {
    // Both siblings share the identical roster checks in
    // `collectCheapPrerequisiteMissing`; only the LEAD's context gate differs.
    // Drive every non-lead-gate check to failure and assert both validators
    // produce byte-identical `missing` lists — so a capability regression in
    // Copilot's catalog can never be masked by the cheap1m/cheap split.
    type CheapEntry = ReturnType<typeof cheapCatalog>["data"][number]
    const cases: ReadonlyArray<{
      id: string
      mutate: (entry: CheapEntry) => CheapEntry
      expected: string | ReadonlyArray<string>
    }> = [
      {
        id: "gemini-3.8-flash",
        mutate: (entry) => ({ ...entry, capabilities: { ...entry.capabilities, supports: { ...entry.capabilities.supports, tool_calls: false } } }),
        expected: `gemini-3.8-flash: does not advertise tool_calls`,
      },
      {
        id: "gemini-3.8-flash",
        mutate: (entry) => ({ ...entry, capabilities: { ...entry.capabilities, supports: { ...entry.capabilities.supports, reasoning_effort: ["medium"] } } }),
        expected: `gemini-3.8-flash: does not advertise a "high" reasoning effort`,
      },
      {
        id: "gemini-3.8-flash",
        mutate: (entry) => ({ ...entry, supported_endpoints: ["/responses"] }),
        expected: `gemini-3.8-flash: does not advertise a supported chat-completions endpoint`,
      },
      {
        id: "gpt-5.6-luna",
        mutate: (entry) => ({ ...entry, capabilities: { ...entry.capabilities, supports: { ...entry.capabilities.supports, reasoning_effort: ["max"] } } }),
        expected: `gpt-5.6-luna: does not advertise both "high" and "max" reasoning effort`,
      },
      {
        id: "gpt-5.6-sol",
        mutate: (entry) => ({ ...entry, supported_endpoints: ["/v1/messages"] }),
        expected: `gpt-5.6-sol: does not advertise a supported Responses endpoint`,
      },
      // Reviewer shares Luna's catalog entry with Explore, so a Luna
      // regression double-reports: once for Explore, once for the reviewer.
      {
        id: "gpt-5.6-luna",
        mutate: (entry) => ({ ...entry, capabilities: { ...entry.capabilities, supports: { ...entry.capabilities.supports, reasoning_effort: ["high"] } } }),
        expected: [
          `gpt-5.6-luna: does not advertise both "high" and "max" reasoning effort`,
          `gpt-5.6-luna: does not advertise a "max" reasoning effort`,
        ],
      },
      {
        id: "gpt-5.6-luna",
        mutate: (entry) => ({ ...entry, supported_endpoints: ["/v1/messages"] }),
        expected: [
          "gpt-5.6-luna: does not advertise a supported Responses endpoint",
          "gpt-5.6-luna: does not advertise a supported Responses endpoint",
        ],
      },
    ]
    for (const { id, mutate, expected } of cases) {
      const catalog = cheapCatalog()
      catalog.data = catalog.data.map((entry) =>
        entry.id === id ? mutate(structuredClone(entry)) : entry,
      ) as typeof fullCatalog["data"]
      const want = typeof expected === "string" ? [expected] : [...expected]
      expect(validateCheapProfilePrerequisites(catalog as never).missing).toEqual(want)
      expect(validateCheap1mProfilePrerequisites(catalog as never).missing).toEqual(want)
    }
  })

  test("reports every missing role and each sibling's rollback command", () => {
    const result = validateCheapProfilePrerequisites({ object: "list", data: [] } as never)
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(5)
    const cheapMessage = formatCheapPrerequisiteFailure(result.missing)
    expect(cheapMessage).toContain("gemini-3.8-flash")
    expect(cheapMessage).toContain("gpt-5.6-luna")
    expect(cheapMessage).toContain("gpt-5.6-sol")
    // Reviewer shares Luna's entry, so Luna is reported twice on an empty catalog.
    expect(result.missing.filter((m) => m.startsWith("gpt-5.6-luna:"))).toHaveLength(2)
    expect(cheapMessage).toContain("grok-4.6")
    expect(cheapMessage).toContain("github-router claude -m cheap")

    const cheap1mResult = validateCheap1mProfilePrerequisites({ object: "list", data: [] } as never)
    expect(cheap1mResult.ok).toBe(false)
    expect(cheap1mResult.missing).toHaveLength(5)
    const cheap1mMessage = formatCheap1mPrerequisiteFailure(cheap1mResult.missing)
    expect(cheap1mMessage).toContain("github-router claude -m cheap1m")
  })

  test("cheap shares fast's exact delegation graph by alias, not by copy", () => {
    // The PreToolUse ACL enforces FAST_PROFILE_DELEGATION_GRAPH for both
    // profiles; a restated literal would be dead and drift-prone.
    expect(CHEAP_PROFILE_DELEGATION_GRAPH).toBe(FAST_PROFILE_DELEGATION_GRAPH)
    expect(Object.keys(CHEAP_PROFILE_DELEGATION_GRAPH).sort()).toEqual(
      ["Explore", "Plan", "general-purpose", "implementer", "reviewer"],
    )
  })

  test("rejects the oracle when context metadata is unusable", () => {    const noPrompt = cheapCatalog()
    noPrompt.data = noPrompt.data.map((entry) =>
      entry.id === "grok-4.6"
        ? { ...entry, capabilities: { ...entry.capabilities, limits: { max_context_window_tokens: 500_000 } } }
        : entry,
    ) as typeof fullCatalog["data"]
    expect(validateCheapProfilePrerequisites(noPrompt as never).missing).toEqual([
      "grok-4.6: no usable max_prompt_tokens metadata",
    ])
    expect(validateCheap1mProfilePrerequisites(noPrompt as never).missing).toEqual([
      "grok-4.6: no usable max_prompt_tokens metadata",
    ])
  })
})

describe("messages launch identity", () => {
  test("missing header remains unbound BYO traffic", () => {
    const c = { req: { header: () => undefined } }
    expect(runMessagesIdentityPreflight(c as never)).toEqual({ ok: true })
  })

  test("matching header binds its registry entry; a mismatch fails", () => {
    const launch = registerLaunch({ profileId: "fast", nonce: "n".repeat(64), secret: "s".repeat(64) })
    const matching = { req: { header: (name: string) => name === LAUNCH_SECRET_HEADER ? launch.secret : undefined } }
    const mismatch = { req: { header: (name: string) => name === LAUNCH_SECRET_HEADER ? "x".repeat(64) : undefined } }
    expect(runMessagesIdentityPreflight(matching as never)).toEqual({ ok: true, launch })
    expect(runMessagesIdentityPreflight(mismatch as never)).toEqual(expect.objectContaining({ ok: false }))
  })

  test("an invalid bound secret returns 403, never 401", async () => {
    state.models = fullCatalog as never
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LAUNCH_SECRET_HEADER]: "x".repeat(64),
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(403)
    expect(response.status).not.toBe(401)
    expect(await response.json()).toEqual(expect.objectContaining({ type: "error" }))
  })
})
