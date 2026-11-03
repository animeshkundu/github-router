// Copilot egress policy for the `-m local` / `-m local2` launch profiles.
//
// These two profiles keep the whole Claude Code surface (native subagents,
// agent-team teammates, every CLI feature) but every agent turn has to land on
// the operator's local endpoint. Prompting cannot enforce that: a teammate's
// model is whatever its frontmatter or the client's tier picker says, and a
// runtime `/model` switch can name any catalog id. The restriction therefore
// lives at the Copilot egress, and this file pins it from the outside:
//
//   - which policy a registered launch imposes (`local` forbids every Copilot
//     model, `local2` allows the `sol` and `luna` families);
//   - that the policy is resolved from the live registry, most restrictive
//     first, so a stray `local` launch cannot be widened by a `local2` one;
//   - that a bound identity wins over the process-wide answer, so a teammate
//     that lost its launch header still routes local;
//   - the `browse` carve-out is exactly one surface and does not widen agent
//     turns;
//   - every Copilot egress refuses before any fetch, the two ad-hoc ones
//     (`/v1/embeddings`, `/v1/responses/compact`) included.
//
// The bearer channel (`writeLaunchBoundSyntheticCredential` →
// `Authorization: Bearer github-router-launch:<secret>`) is the only identity
// an agent-team teammate can present, so its match/mismatch/unbound behaviour
// is pinned here too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  activeCopilotModelPolicy,
  activeLocalLaunchProfile,
  assertCopilotMessagesBodyAllowed,
  assertCopilotModelAllowed,
  copilotModelFamily,
  CopilotModelRestrictedError,
  copilotModelPolicyForProfile,
  effectiveLocalProfile,
  isCopilotModelAllowed,
  isCopilotModelAllowedUnder,
  LOCAL2_COPILOT_MODEL_FAMILIES,
} from "~/lib/copilot-model-policy"
import {
  clearLaunchRegistry,
  LAUNCH_BOUND_TOKEN_PREFIX,
  launchBoundAccessToken,
  registerLaunch,
  unregisterLaunch,
} from "~/lib/launch-registry"
import {
  LAUNCH_SECRET_HEADER,
  runMessagesIdentityPreflight,
} from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { handleResponsesCompact } from "~/routes/responses/handler"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createEmbeddings } from "~/services/copilot/create-embeddings"
import { countTokens, createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"
import {
  __resetCompressorBackendForTests,
  pickBackendFromCatalog,
} from "~/lib/browser-mcp/compressor"

const originalFetch = globalThis.fetch
let fetchCalls: number

function body(model: string) {
  return JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
}

function chatPayload(model: string) {
  return { model, messages: [{ role: "user" as const, content: "hi" }] }
}

/** The slice of a Hono context `handleResponsesCompact` touches before it
 *  reaches its first fetch. */
function compactContext(payload: unknown) {
  return {
    req: { json: async () => payload, path: "/v1/responses/compact" },
    json: (value: unknown, status = 200) => new Response(JSON.stringify(value), { status }),
  } as never
}

beforeEach(() => {
  clearLaunchRegistry()
  __resetCompressorBackendForTests()
  fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-6.1-sol",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as never
  state.copilotToken = "test-copilot-token"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearLaunchRegistry()
  __resetCompressorBackendForTests()
  state.copilotToken = undefined
  state.models = undefined
})

describe("per-profile policy", () => {
  test("every non-local profile is unrestricted", () => {
    for (const id of [undefined, null, "standard", "fast", "max", "cheap", "cheapest2", "balanced2"]) {
      expect(copilotModelPolicyForProfile(id)).toEqual({ kind: "unrestricted" })
    }
  })

  test("local forbids every Copilot model; local2 admits sol and luna", () => {
    expect(copilotModelPolicyForProfile("local")).toEqual({ kind: "forbidden", profileId: "local" })
    const local2 = copilotModelPolicyForProfile("local2")
    expect(local2.kind).toBe("families")
    expect([...LOCAL2_COPILOT_MODEL_FAMILIES].sort()).toEqual(["luna", "sol"])
  })

  test("the process-wide answer comes from the live registry, most restrictive first", () => {
    expect(activeCopilotModelPolicy()).toEqual({ kind: "unrestricted" })

    const nonLocal = registerLaunch({ profileId: "fast", nonce: "a".repeat(64), secret: "sa" })
    expect(activeCopilotModelPolicy()).toEqual({ kind: "unrestricted" })

    const local2 = registerLaunch({ profileId: "local2", nonce: "b".repeat(64), secret: "sb" })
    expect(activeCopilotModelPolicy().kind).toBe("families")
    expect(activeLocalLaunchProfile()).toBe("local2")

    // A `local` launch sharing the process tightens it outright, regardless of
    // registration order: resolving the ambiguity toward the stricter profile
    // is the fail-closed direction.
    const local = registerLaunch({ profileId: "local", nonce: "c".repeat(64), secret: "sc" })
    expect(activeCopilotModelPolicy()).toEqual({ kind: "forbidden", profileId: "local" })
    expect(activeLocalLaunchProfile()).toBe("local")

    // Tearing the strict launch down restores the sibling's policy, not
    // `unrestricted`: the registry is the only state.
    unregisterLaunch(local.launchId)
    expect(activeCopilotModelPolicy().kind).toBe("families")
    unregisterLaunch(local2.launchId)
    unregisterLaunch(nonLocal.launchId)
    expect(activeCopilotModelPolicy()).toEqual({ kind: "unrestricted" })
  })
})

describe("effectiveLocalProfile", () => {
  test("a bound identity wins in both directions", () => {
    const local = registerLaunch({ profileId: "local", nonce: "l".repeat(64), secret: "sl" })
    expect(local.launchId).toBeTruthy()

    // Bound local traffic stays local even with nothing else registered.
    expect(effectiveLocalProfile("local")).toBe("local")
    expect(effectiveLocalProfile("local2")).toBe("local2")
    // A bound NON-local launch keeps its own profile even while a local
    // launch shares the process (the `serve` / multi-launch arrangement).
    expect(effectiveLocalProfile("fast")).toBeUndefined()
    expect(effectiveLocalProfile("standard")).toBeUndefined()
  })

  test("only an identity-less request falls back to the process-wide answer", () => {
    expect(effectiveLocalProfile(undefined)).toBeUndefined()
    expect(effectiveLocalProfile(null)).toBeUndefined()

    registerLaunch({ profileId: "local2", nonce: "m".repeat(64), secret: "sm" })
    expect(effectiveLocalProfile(undefined)).toBe("local2")
    expect(effectiveLocalProfile(null)).toBe("local2")
  })
})

describe("copilotModelFamily", () => {
  test("reads the trailing tier token through both accounting suffixes", () => {
    expect(copilotModelFamily("gpt-6.1-sol")).toBe("sol")
    expect(copilotModelFamily("gpt-6-sol")).toBe("sol")
    expect(copilotModelFamily("gpt-5.6-sol")).toBe("sol")
    expect(copilotModelFamily("gpt-6-luna")).toBe("luna")
    expect(copilotModelFamily(" gpt-6.1-sol[1m] ")).toBe("sol")
    expect(copilotModelFamily("gpt-6-sol-1m")).toBe("sol")
  })

  test("does not admit a lookalike or a different tier", () => {
    expect(copilotModelFamily("gpt-6-sol-like")).toBe("like")
    expect(copilotModelFamily("gemini-3.1-pro-preview")).toBe("preview")
    expect(copilotModelFamily("claude-opus-5.5")).toBe("5.5")
    expect(copilotModelFamily("claude-haiku-4.5")).toBe("4.5")
  })
})

describe("isCopilotModelAllowedUnder", () => {
  const forbidden = copilotModelPolicyForProfile("local")!
  const families = copilotModelPolicyForProfile("local2")!

  test("unrestricted admits everything on every surface", () => {
    const policy = copilotModelPolicyForProfile("fast")!
    for (const id of ["gpt-6.1-sol", "claude-opus-5.5", "gemini-3.1-pro-preview"]) {
      expect(isCopilotModelAllowedUnder(policy, id)).toBe(true)
      expect(isCopilotModelAllowedUnder(policy, id, "browse")).toBe(true)
    }
  })

  test("forbidden refuses every model and carves out only the browse surface", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-luna", "claude-opus-5.5", "opus"]) {
      expect(isCopilotModelAllowedUnder(forbidden, id)).toBe(false)
      expect(isCopilotModelAllowedUnder(forbidden, id, "browse")).toBe(true)
    }
  })

  test("families admits sol and luna and nothing else", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol[1m]", "gpt-6-luna"]) {
      expect(isCopilotModelAllowedUnder(families, id)).toBe(true)
    }
    for (const id of [
      "claude-opus-5.5",
      "claude-sonnet-5",
      "gemini-3.1-pro-preview",
      "gemini-3.8-flash",
      "grok-4.6",
      "gpt-5.4-mini",
      "opus",
    ]) {
      expect(isCopilotModelAllowedUnder(families, id)).toBe(false)
    }
  })

  test("the browse surface is exempt from the family ceiling too", () => {
    // The exemption is complete rather than a narrowing of the ban: the page
    // compressor's chain is fixed and short, so a browse call may name any
    // entry in it on either local profile. Binding it to the ceiling would
    // make the backend depend on which launch happens to be registered.
    expect(isCopilotModelAllowedUnder(families, "claude-opus-5.5", "browse")).toBe(true)
    expect(isCopilotModelAllowedUnder(families, "gpt-5.4-mini", "browse")).toBe(true)
    expect(isCopilotModelAllowedUnder(forbidden, "gpt-5.4-mini", "browse")).toBe(true)
  })
})

describe("assertCopilotModelAllowed", () => {
  test("a local launch refuses a Copilot model with an actionable error", () => {
    registerLaunch({ profileId: "local", nonce: "x".repeat(64), secret: "sx" })
    let thrown: unknown
    try {
      assertCopilotModelAllowed("claude-opus-5.5")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CopilotModelRestrictedError)
    const error = thrown as CopilotModelRestrictedError
    expect(error.model).toBe("claude-opus-5.5")
    expect(error.policy.kind).toBe("forbidden")
    expect(error.message).toContain("`-m local`")
    expect(error.message).toContain("-m local2")
  })

  test("local2 refuses an out-of-family model and names the two allowed tiers", () => {
    registerLaunch({ profileId: "local2", nonce: "y".repeat(64), secret: "sy" })
    expect(() => assertCopilotModelAllowed("gpt-6.1-sol")).not.toThrow()
    expect(() => assertCopilotModelAllowed("gpt-6-luna")).not.toThrow()
    expect(() => assertCopilotModelAllowed("gemini-3.1-pro-preview")).toThrow(CopilotModelRestrictedError)
    expect(() => assertCopilotModelAllowed("gemini-3.1-pro-preview")).toThrow(/luna, sol/)
  })
})

describe("assertCopilotMessagesBodyAllowed", () => {
  test("unrestricted passes the body through unparsed", () => {
    expect(() => assertCopilotMessagesBodyAllowed("{not json")).not.toThrow()
  })

  test("a restrictive policy inspects the raw model id", () => {
    registerLaunch({ profileId: "local2", nonce: "z".repeat(64), secret: "sz" })
    expect(() => assertCopilotMessagesBodyAllowed(body("gpt-6.1-sol"))).not.toThrow()
    expect(() => assertCopilotMessagesBodyAllowed(body("gpt-6-luna"))).not.toThrow()
    expect(() => assertCopilotMessagesBodyAllowed(body("claude-opus-5.5"))).toThrow(CopilotModelRestrictedError)
    // The tier alias the local lead sends is not a Copilot family, so a stray
    // Copilot-bound caller naming it is refused rather than resolved.
    expect(() => assertCopilotMessagesBodyAllowed(body("opus"))).toThrow(CopilotModelRestrictedError)
  })

  test("fails closed on a body it cannot inspect", () => {
    registerLaunch({ profileId: "local", nonce: "w".repeat(64), secret: "sw" })
    expect(() => assertCopilotMessagesBodyAllowed("{not json")).toThrow(CopilotModelRestrictedError)
    expect(() => assertCopilotMessagesBodyAllowed(JSON.stringify({ messages: [] }))).toThrow(CopilotModelRestrictedError)
    expect(() => assertCopilotMessagesBodyAllowed(JSON.stringify({ model: 7 }))).toThrow(CopilotModelRestrictedError)
  })
})

describe("Copilot egress refuses before it fetches", () => {
  test("every egress function is guarded under `local`", async () => {
    registerLaunch({ profileId: "local", nonce: "q".repeat(64), secret: "sq" })

    await expect(createChatCompletions(chatPayload("claude-opus-5.5") as never)).rejects.toThrow(
      CopilotModelRestrictedError,
    )
    await expect(
      createResponses({ model: "claude-opus-5.5", input: "hi" } as never),
    ).rejects.toThrow(CopilotModelRestrictedError)
    await expect(createMessages(body("claude-opus-5.5"))).rejects.toThrow(CopilotModelRestrictedError)
    await expect(countTokens(body("claude-opus-5.5"))).rejects.toThrow(CopilotModelRestrictedError)
    await expect(
      createEmbeddings({ model: "text-embedding-3-small", input: "hi" }),
    ).rejects.toThrow(CopilotModelRestrictedError)
    // `/v1/responses/compact` talks to Copilot through a raw fetch of its own,
    // so it carries its own assert rather than inheriting one from a service.
    await expect(
      handleResponsesCompact(compactContext({ model: "claude-opus-5.5", input: [] })),
    ).rejects.toThrow(CopilotModelRestrictedError)

    // Not one of them reached the network.
    expect(fetchCalls).toBe(0)
  })

  test("`local2` lets its two families through and refuses the rest", async () => {
    registerLaunch({ profileId: "local2", nonce: "r".repeat(64), secret: "sr" })

    await expect(
      createResponses({ model: "claude-opus-5.5", input: "hi" } as never),
    ).rejects.toThrow(CopilotModelRestrictedError)
    expect(fetchCalls).toBe(0)

    await createChatCompletions(chatPayload("gpt-6.1-sol") as never)
    expect(fetchCalls).toBe(1)
  })

  test("the browse carve-out is the only way a `local` launch reaches Copilot", async () => {
    registerLaunch({ profileId: "local", nonce: "v".repeat(64), secret: "sv" })
    await createChatCompletions(chatPayload("claude-opus-5.5") as never, undefined, undefined, false, "browse")
    expect(fetchCalls).toBe(1)
    // ...and the same call through the ordinary surface is still refused.
    await expect(createChatCompletions(chatPayload("claude-opus-5.5") as never)).rejects.toThrow(
      CopilotModelRestrictedError,
    )
    expect(fetchCalls).toBe(1)
  })

  test("a local egress sends the body verbatim and is never policed", async () => {
    // The `/v1/messages` handler passes `localEgress` for local traffic, which
    // both skips the guard and switches the URL. A `local` profile's tier ids
    // (`opus`) must survive that path even though Copilot would never accept
    // them.
    registerLaunch({ profileId: "local", nonce: "u".repeat(64), secret: "su" })
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls += 1
      expect(String(url)).toBe("http://127.0.0.1:9/v1/messages")
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as never
    const response = await createMessages(body("opus"), undefined, undefined, false, {
      baseUrl: "http://127.0.0.1:9/v1",
      sessionId: "sess-1",
    })
    expect(response.status).toBe(200)
    expect(fetchCalls).toBe(1)
  })
})

/** A catalog row good enough for `pickEndpoint` and the compressor's
 *  `tool_calls` gate. */
function catalogModel(id: string, endpoints: Array<string>) {
  return {
    id,
    name: id,
    object: "model" as const,
    vendor: "openai",
    version: id,
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
      limits: { max_context_window_tokens: 1_000_000 },
    },
  }
}

describe("browser compressor picks the same backend on every launch profile", () => {
  const catalog = [
    catalogModel("gpt-5.4-mini", ["/v1/responses"]),
    catalogModel("claude-sonnet-4.6", ["/v1/chat/completions"]),
    catalogModel("gpt-6-luna", ["/v1/chat/completions"]),
  ]

  test("every profile, local pair included, prefers gpt-5.4-mini", () => {
    for (const profileId of [undefined, "fast", "cheapest2", "balanced2", "local", "local2"] as const) {
      clearLaunchRegistry()
      __resetCompressorBackendForTests()
      if (profileId) registerLaunch({ profileId, nonce: "t".repeat(64), secret: `s-${profileId}` })
      state.models = { object: "list", data: catalog } as never
      expect(pickBackendFromCatalog()).toBe("gpt-5.4-mini")
    }
  })

  test("the chain falls back to gpt-6-luna when mini is absent from the catalog", () => {
    for (const profileId of [undefined, "local", "local2"] as const) {
      clearLaunchRegistry()
      __resetCompressorBackendForTests()
      if (profileId) registerLaunch({ profileId, nonce: "u".repeat(64), secret: `s2-${profileId}` })
      state.models = {
        object: "list",
        data: catalog.filter((model) => model.id !== "gpt-5.4-mini"),
      } as never
      expect(pickBackendFromCatalog()).toBe("gpt-6-luna")
    }
  })
})

describe("launch identity over the bearer channel", () => {
  function context(headers: Record<string, string>) {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return { req: { header: (name: string) => lower.get(name.toLowerCase()) } } as never
  }

  test("a launch-bound bearer binds the same entry the header would", () => {
    const launch = registerLaunch({ profileId: "local", nonce: "p".repeat(64), secret: "sp" })
    const result = runMessagesIdentityPreflight(
      context({ authorization: `Bearer ${launchBoundAccessToken(launch.secret)}` }),
    )
    expect(result).toEqual({ ok: true, launch })
  })

  test("an unmatched launch-bound bearer fails closed", () => {
    registerLaunch({ profileId: "local", nonce: "o".repeat(64), secret: "so" })
    const result = runMessagesIdentityPreflight(
      context({ authorization: `Bearer ${LAUNCH_BOUND_TOKEN_PREFIX}${"z".repeat(64)}` }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("launch token")
  })

  test("a prefixed but empty bearer is a failed match, never unbound traffic", () => {
    const result = runMessagesIdentityPreflight(
      context({ authorization: `Bearer ${LAUNCH_BOUND_TOKEN_PREFIX}` }),
    )
    expect(result.ok).toBe(false)
  })

  test("the shared synthetic token and other schemes stay unbound", () => {
    registerLaunch({ profileId: "local", nonce: "n".repeat(64), secret: "sn" })
    for (const authorization of [
      "Bearer github-router-synthetic",
      "Basic Zm9vOmJhcg==",
      "Bearer some-other-token",
    ]) {
      expect(runMessagesIdentityPreflight(context({ authorization }))).toEqual({ ok: true })
    }
    expect(runMessagesIdentityPreflight(context({}))).toEqual({ ok: true })
  })

  test("the header still wins when both channels are present", () => {
    const byHeader = registerLaunch({ profileId: "local2", nonce: "h".repeat(64), secret: "sh" })
    const byBearer = registerLaunch({ profileId: "local", nonce: "g".repeat(64), secret: "sg" })
    const result = runMessagesIdentityPreflight(
      context({
        [LAUNCH_SECRET_HEADER]: byHeader.secret,
        authorization: `Bearer ${launchBoundAccessToken(byBearer.secret)}`,
      }),
    )
    expect(result).toEqual({ ok: true, launch: byHeader })
  })
})

describe("a bound local identity governs route selection", () => {
  test("a bearer-bound teammate is local even though its model names Copilot", () => {
    const launch = registerLaunch({ profileId: "local", nonce: "f".repeat(64), secret: "sf" })
    const identity = runMessagesIdentityPreflight(
      context({ authorization: `Bearer ${launchBoundAccessToken(launch.secret)}` }),
    )
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    // The client may name anything; the bound identity is what decides where
    // the turn goes, and the policy then forbids any Copilot egress for it.
    expect(effectiveLocalProfile(identity.launch?.profileId)).toBe("local")
    expect(isCopilotModelAllowed("claude-opus-5.5")).toBe(false)
  })

  function context(headers: Record<string, string>) {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return { req: { header: (name: string) => lower.get(name.toLowerCase()) } } as never
  }
})
