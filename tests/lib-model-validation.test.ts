import { test, expect, describe, beforeEach, afterEach } from "bun:test"

import {
  listModelsForEndpoint,
  logEndpointMismatch,
  modelSupportsEndpoint,
} from "../src/lib/model-validation"
import { state } from "../src/lib/state"

const fakeModels = [
  { id: "gpt-5.4", supported_endpoints: ["/responses"] },
  { id: "gpt-5.3-codex", supported_endpoints: ["/responses"] },
  { id: "gpt-5.2-codex", supported_endpoints: ["/responses"] },
  { id: "claude-opus-4.6-1m", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "gpt-4.1", supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "legacy-model" }, // no supported_endpoints
]

describe("modelSupportsEndpoint", () => {
  beforeEach(() => {
    // @ts-expect-error - partial model data for testing
    state.models = { data: fakeModels, object: "list" }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("returns true for supported endpoint", () => {
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/responses")).toBe(true)
  })

  test("returns false for unsupported endpoint", () => {
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/chat/completions")).toBe(false)
  })

  test("normalizes /v1/ prefixed paths", () => {
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/v1/responses")).toBe(true)
  })

  test("returns true when model has no supported_endpoints (backward compat)", () => {
    expect(modelSupportsEndpoint("legacy-model", "/chat/completions")).toBe(true)
  })

  test("returns true when model not found in cache", () => {
    expect(modelSupportsEndpoint("unknown-model", "/responses")).toBe(true)
  })

  test("returns true when no models cached", () => {
    state.models = undefined
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/responses")).toBe(true)
  })
})

describe("logEndpointMismatch", () => {
  beforeEach(() => {
    // @ts-expect-error - partial model data for testing
    state.models = { data: fakeModels, object: "list" }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("returns true when mismatch detected", () => {
    expect(logEndpointMismatch("gpt-5.3-codex", "/chat/completions")).toBe(true)
  })

  test("returns false when no mismatch", () => {
    expect(logEndpointMismatch("gpt-5.3-codex", "/responses")).toBe(false)
  })

  test("returns false for unknown models", () => {
    expect(logEndpointMismatch("unknown-model", "/responses")).toBe(false)
  })
})

describe("listModelsForEndpoint", () => {
  beforeEach(() => {
    // @ts-expect-error - partial model data for testing
    state.models = { data: fakeModels, object: "list" }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("lists models for /responses", () => {
    const models = listModelsForEndpoint("/responses")
    expect(models).toContain("gpt-5.4")
    expect(models).toContain("gpt-5.3-codex")
    expect(models).toContain("gpt-5.2-codex")
    expect(models).toContain("gpt-4.1")
    expect(models).toContain("legacy-model") // no restrictions
    expect(models).not.toContain("claude-opus-4.6-1m")
  })

  test("lists models for /v1/messages", () => {
    const models = listModelsForEndpoint("/v1/messages")
    expect(models).toContain("claude-opus-4.6-1m")
    expect(models).toContain("claude-sonnet-4.6")
    expect(models).toContain("legacy-model") // no restrictions
    expect(models).not.toContain("gpt-5.3-codex")
  })

  test("returns empty when no models cached", () => {
    state.models = undefined
    expect(listModelsForEndpoint("/responses")).toEqual([])
  })
})
