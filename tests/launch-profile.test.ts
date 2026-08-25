import { afterEach, describe, expect, test } from "bun:test"

import {
  LUNA_DRIVER_ALIAS_ID,
  LUNA_HAIKU_ALIAS_ID,
  LUNA_REAL_MODEL_ID,
  LUNA_SONNET_ALIAS_ID,
  canonicalizeAliasModel,
  formatFastPrerequisiteFailure,
  resolveEffortWithAliasDefault,
  resolveLaunchProfile,
  resolveModelAlias,
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
    model("gpt-5.6-luna", { context: 1_050_000, efforts: ["high", "xhigh", "max"] }),
    model("grok-4.6", { context: 500_000, prompt: 372_000, efforts: ["medium"] }),
    model("gemini-3.7-flash", { context: 1_000_000, efforts: ["high"], endpoints: ["/chat/completions"] }),
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
})

describe("Luna aliases", () => {
  test("canonicalize to Luna while retaining distinct defaults", () => {
    expect(resolveModelAlias(`${LUNA_DRIVER_ALIAS_ID}[1m]`)?.absentEffortDefault).toBe("max")
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
        entry.id === "gemini-3.7-flash"
          ? { ...entry, supported_endpoints: ["/v1/chat/completions"] }
          : entry,
      ),
    }
    expect(validateFastProfilePrerequisites(prefixed as never)).toEqual({ ok: true, missing: [] })
  })

  test("reports every missing or invalid prerequisite and rollback command", () => {
    const result = validateFastProfilePrerequisites({ object: "list", data: [] } as never)
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(3)
    const message = formatFastPrerequisiteFailure(result.missing)
    expect(message).toContain("gpt-5.6-luna")
    expect(message).toContain("grok-4.6")
    expect(message).toContain("gemini-3.7-flash")
    expect(message).toContain("github-router claude")
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
