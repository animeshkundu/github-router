import { describe, expect, test } from "bun:test"

import { pickEndpoint } from "../src/services/copilot/endpoint"
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
})
