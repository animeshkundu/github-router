// Classifier + non-regression guard: Claude models must never route to the shim.

import { expect, test, describe } from "bun:test"

import {
  classifyMessagesRoute,
  isClaudeModel,
} from "~/lib/anthropic-translate/classifier"
import type { Model } from "~/services/copilot/get-models"

function model(over: Partial<Model> & { id: string }): Model {
  return {
    name: over.id,
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: {},
    },
    supported_endpoints: ["/responses"],
    ...over,
  } as Model
}

const claudeModel = (id: string): Model =>
  model({
    id,
    vendor: "anthropic",
    capabilities: {
      family: "claude",
      object: "model_capabilities",
      tokenizer: "claude",
      type: "chat",
      supports: {},
    },
    supported_endpoints: ["/v1/messages"],
  })

describe("isClaudeModel", () => {
  test("true for claude-* ids", () => {
    expect(isClaudeModel("claude-opus-4-8")).toBe(true)
    expect(isClaudeModel("claude-sonnet-4-6")).toBe(true)
    expect(isClaudeModel("claude-haiku-4-5")).toBe(true)
  })
  test("true by vendor / family even if id is unusual", () => {
    expect(isClaudeModel("some-alias", model({ id: "some-alias", vendor: "Anthropic" }))).toBe(true)
    expect(
      isClaudeModel(
        "x",
        model({
          id: "x",
          capabilities: {
            family: "claude-3",
            object: "model_capabilities",
            tokenizer: "claude",
            type: "chat",
            supports: {},
          },
        }),
      ),
    ).toBe(true)
  })
  test("false for gpt / gemini", () => {
    expect(isClaudeModel("gpt-5.5")).toBe(false)
    expect(isClaudeModel("gpt-5.3-codex")).toBe(false)
    expect(isClaudeModel("gemini-3.1-pro-preview")).toBe(false)
  })
})

describe("classifyMessagesRoute", () => {
  test("gpt-5.5 / gpt-5.3-codex (responses endpoint) → responses-shim", () => {
    expect(classifyMessagesRoute("gpt-5.5", model({ id: "gpt-5.5" }))).toBe("responses-shim")
    expect(classifyMessagesRoute("gpt-5.3-codex", model({ id: "gpt-5.3-codex" }))).toBe(
      "responses-shim",
    )
  })

  test("Claude models ALWAYS passthrough (opus/sonnet/haiku)", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(classifyMessagesRoute(id, claudeModel(id))).toBe("claude-passthrough")
    }
  })

  test("NON-REGRESSION: a Claude model never routes to the shim even if catalog metadata (wrongly) advertises /responses", () => {
    const rogue = claudeModel("claude-opus-4-8")
    rogue.supported_endpoints = ["/responses"] // pathological metadata
    expect(classifyMessagesRoute("claude-opus-4-8", rogue)).toBe("claude-passthrough")
  })

  test("non-Claude chat-only model (gemini) → chat-shim (Phase 2)", () => {
    const gemini = model({
      id: "gemini-3.1-pro-preview",
      vendor: "google",
      capabilities: {
        family: "gemini",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: ["/chat/completions"],
    })
    expect(classifyMessagesRoute("gemini-3.1-pro-preview", gemini)).toBe("chat-shim")
  })

  test("non-Claude model with NO supported_endpoints (chat-default) → chat-shim", () => {
    const chatDefault = model({
      id: "gemini-3.5-flash",
      vendor: "google",
      capabilities: {
        family: "gemini",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: undefined,
    })
    expect(classifyMessagesRoute("gemini-3.5-flash", chatDefault)).toBe("chat-shim")
  })

  test("fast profile keeps fixed endpoint policy when a model advertises both", () => {
    const luna = model({
      id: "gpt-5.6-luna",
      vendor: "openai",
      supported_endpoints: ["/chat/completions", "/responses"],
    })
    const gemini = model({
      id: "gemini-3.8-flash",
      vendor: "google",
      supported_endpoints: ["/responses", "/chat/completions"],
    })

    expect(classifyMessagesRoute("gpt-5.6-luna", luna)).toBe("chat-shim")
    expect(classifyMessagesRoute("gpt-5.6-luna", luna, undefined, true)).toBe(
      "responses-shim",
    )
    expect(classifyMessagesRoute("gemini-3.8-flash", gemini, undefined, true)).toBe(
      "chat-shim",
    )
  })

  test("undefined model id / model absent from catalog → passthrough", () => {
    expect(classifyMessagesRoute(undefined)).toBe("claude-passthrough")
    expect(classifyMessagesRoute("gpt-5.5", undefined)).toBe("claude-passthrough")
  })

  test("I3 HARDEN: a Claude alias under path-shaped metadata is NEVER diverted to the shim", () => {
    // vendor "github", empty family, /responses advertised — the claude token
    // surfaces only as a mid-id path segment, which the old id.startsWith check
    // missed. Both id and route must classify as Claude.
    const rogueGithub = model({
      id: "github/claude-3-7-sonnet",
      vendor: "github",
      capabilities: {
        family: "",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: ["/responses"],
    })
    expect(isClaudeModel("github/claude-3-7-sonnet", rogueGithub)).toBe(true)
    expect(classifyMessagesRoute("github/claude-3-7-sonnet", rogueGithub)).toBe(
      "claude-passthrough",
    )

    const rogueAnthropic = model({
      id: "anthropic/claude-3-7-sonnet",
      vendor: "github",
      capabilities: {
        family: "",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: ["/responses"],
    })
    expect(classifyMessagesRoute("anthropic/claude-3-7-sonnet", rogueAnthropic)).toBe(
      "claude-passthrough",
    )
  })

  test("I3 HARDEN: genuine non-Claude /responses ids still route to the shim", () => {
    expect(classifyMessagesRoute("gpt-5.5", model({ id: "gpt-5.5" }))).toBe("responses-shim")
    const geminiResponses = model({
      id: "gemini-3.1-pro-preview",
      vendor: "google",
      capabilities: {
        family: "gemini",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: ["/responses"],
    })
    expect(classifyMessagesRoute("gemini-3.1-pro-preview", geminiResponses)).toBe("responses-shim")
    // guard against boundary false-positives: "claude" as an incidental
    // substring (not a path segment) must NOT be treated as Claude.
    expect(isClaudeModel("notclaudeish", model({ id: "notclaudeish", vendor: "openai" }))).toBe(false)
  })

  test("Phase 2 three-way: gemini → chat-shim, claude → passthrough, gpt-5.5 → responses-shim", () => {
    const gemini = model({
      id: "gemini-3.5-flash",
      vendor: "google",
      capabilities: {
        family: "gemini",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        supports: {},
      },
      supported_endpoints: ["/chat/completions"],
    })
    expect(classifyMessagesRoute("gemini-3.5-flash", gemini)).toBe("chat-shim")
    expect(classifyMessagesRoute("claude-opus-4-8", claudeModel("claude-opus-4-8"))).toBe(
      "claude-passthrough",
    )
    expect(classifyMessagesRoute("gpt-5.5", model({ id: "gpt-5.5" }))).toBe("responses-shim")
  })
})
