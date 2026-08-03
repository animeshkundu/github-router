import { afterEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import {
  pickEndpoint,
  resolveEndpointForModelId,
} from "../src/services/copilot/endpoint"
import type { Model } from "../src/services/copilot/get-models"

const m = (endpoints?: Array<string>): Model =>
  ({ id: "x", supported_endpoints: endpoints } as unknown as Model)

describe("pickEndpoint", () => {
  test("prefers /chat/completions when the model serves it", () => {
    expect(pickEndpoint(m(["/chat/completions", "/v1/messages"]))).toBe("chat")
    // both available → chat is preferred (simpler shape)
    expect(pickEndpoint(m(["/responses", "/chat/completions"]))).toBe("chat")
  })

  test("falls back to /responses for /responses-only models", () => {
    expect(pickEndpoint(m(["/responses", "ws:/responses"]))).toBe("responses")
  })

  test("treats a model with no supported_endpoints as chat-eligible", () => {
    expect(pickEndpoint(m(undefined))).toBe("chat")
    expect(pickEndpoint(m([]))).toBe("chat")
  })

  test("returns undefined when the model serves neither client endpoint", () => {
    expect(pickEndpoint(m(["ws:/responses"]))).toBeUndefined()
    expect(pickEndpoint(m(["embeddings"]))).toBeUndefined()
  })

  test("accepts the /v1-prefixed spellings Copilot also emits", () => {
    // Copilot is not self-consistent about the prefix (`/v1/messages` is
    // prefixed, `/chat/completions` is not) and this repo's fixtures carry
    // both. Matching only the bare form silently misses a real shape — a miss
    // that used to be masked by the `?? "chat"` coercion downstream and now
    // would hard-fail the run.
    expect(pickEndpoint(m(["/v1/chat/completions"]))).toBe("chat")
    expect(pickEndpoint(m(["/v1/responses"]))).toBe("responses")
    expect(pickEndpoint(m(["/v1/messages", "/v1/chat/completions"]))).toBe("chat")
  })

  test("matches exactly — a ws: transport is not the HTTP responses client", () => {
    // Guard against a future refactor reaching for endsWith/includes.
    expect(pickEndpoint(m(["ws:/responses", "ws:/chat/completions"]))).toBeUndefined()
  })
})

// `resolveEndpointForModelId` exists to keep two genuinely different answers
// apart: "this id isn't in the catalog" (chat is a fine default) and "this
// catalog model serves NEITHER of our two clients" (no default is correct —
// every client we could pick 400s upstream). The predecessor,
// `endpointForModelId`, returned `pickEndpoint(found) ?? "chat"` and collapsed
// both into "chat".
describe("resolveEndpointForModelId", () => {
  const originalModels = state.models

  afterEach(() => {
    state.models = originalModels
  })

  const withCatalog = (models: Array<Model>): void => {
    state.models = { object: "list", data: models } as typeof state.models
  }

  const named = (id: string, endpoints?: Array<string>): Model =>
    ({ id, supported_endpoints: endpoints } as unknown as Model)

  test("resolves a driveable model to its endpoint", () => {
    withCatalog([
      named("chatty", ["/chat/completions"]),
      named("respy", ["/responses"]),
    ])
    expect(resolveEndpointForModelId("chatty")).toEqual({
      kind: "endpoint",
      endpoint: "chat",
    })
    expect(resolveEndpointForModelId("respy")).toEqual({
      kind: "endpoint",
      endpoint: "responses",
    })
  })

  test("reports an id absent from the catalog as unknown-model, NOT unreachable", () => {
    withCatalog([named("chatty", ["/chat/completions"])])
    expect(resolveEndpointForModelId("never-heard-of-it")).toEqual({
      kind: "unknown-model",
    })
  })

  test("an empty / unpopulated catalog is unknown-model", () => {
    withCatalog([])
    expect(resolveEndpointForModelId("anything")).toEqual({ kind: "unknown-model" })
    state.models = undefined
    expect(resolveEndpointForModelId("anything")).toEqual({ kind: "unknown-model" })
  })

  test("a catalog model serving neither client endpoint is unreachable, and says what it DOES serve", () => {
    // The shape this repo's own translate fixtures already model for Claude.
    withCatalog([named("claude-opus-5", ["/v1/messages"])])
    expect(resolveEndpointForModelId("claude-opus-5")).toEqual({
      kind: "unreachable",
      endpoints: ["/v1/messages"],
    })
  })

  test("a model that omits supported_endpoints stays chat-eligible (not unreachable)", () => {
    withCatalog([named("legacy", undefined), named("empty", [])])
    expect(resolveEndpointForModelId("legacy")).toEqual({
      kind: "endpoint",
      endpoint: "chat",
    })
    expect(resolveEndpointForModelId("empty")).toEqual({
      kind: "endpoint",
      endpoint: "chat",
    })
  })
})
