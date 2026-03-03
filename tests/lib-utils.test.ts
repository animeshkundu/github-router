import { test, expect, mock, afterEach, describe, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { DEFAULT_CODEX_MODEL } from "../src/lib/port"
import {
  cacheModels,
  cacheVSCodeVersion,
  isNullish,
  normalizeModelId,
  resolveCodexModel,
  resolveModel,
  sleep,
} from "../src/lib/utils"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("DEFAULT_CODEX_MODEL matches Copilot API format", () => {
  // Must match both Copilot's model ID and Codex CLI's bundled catalog entry
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.3-codex")
})

test("isNullish handles null and undefined", () => {
  expect(isNullish(null)).toBe(true)
  expect(isNullish(undefined)).toBe(true)
  expect(isNullish(0)).toBe(false)
})

test("cacheModels stores models in state", async () => {
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [], object: "list" }))
    }
    return new Response("pkgver=1.2.3")
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  state.copilotToken = "token"
  state.vsCodeVersion = "1.2.3"
  state.accountType = "individual"
  state.models = undefined
  await cacheModels()
  const models = state.models as { object: string } | undefined
  if (!models) {
    throw new Error("Expected models to be cached")
  }
  expect(models.object).toBe("list")
})

test("cacheVSCodeVersion updates state", async () => {
  const fetchMock = mock(() => new Response("pkgver=1.2.3"))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  state.vsCodeVersion = undefined
  await cacheVSCodeVersion()
  if (!state.vsCodeVersion) {
    throw new Error("Expected VSCode version to be cached")
  }
  expect(state.vsCodeVersion as string).toBe("1.2.3")
})

test("sleep resolves after timeout", async () => {
  await sleep(0)
  expect(true).toBe(true)
})

// --- normalizeModelId ---

describe("normalizeModelId", () => {
  test("lowercases and inserts dash at letter-digit boundary", () => {
    expect(normalizeModelId("GPT-5.3-Codex")).toBe("gpt-5-3-codex")
  })

  test("replaces dots with dashes", () => {
    expect(normalizeModelId("gpt-5.3-codex")).toBe("gpt-5-3-codex")
  })

  test("inserts dash at letter-digit boundary", () => {
    expect(normalizeModelId("gpt5.3-codex")).toBe("gpt-5-3-codex")
  })

  test("collapses repeated dashes", () => {
    expect(normalizeModelId("gpt--5.3--codex")).toBe("gpt-5-3-codex")
  })

  test("handles no-op input", () => {
    expect(normalizeModelId("gpt-4o")).toBe("gpt-4o")
  })
})

// --- resolveModel ---

const fakeModels = [
  { id: "gpt-5.3-codex", supported_endpoints: ["/responses"] },
  { id: "gpt-5.2-codex", supported_endpoints: ["/responses"] },
  { id: "claude-opus-4.6-1m", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "gpt-4.1", supported_endpoints: ["/chat/completions", "/responses"] },
]

describe("resolveModel", () => {
  beforeEach(() => {
    // @ts-expect-error - partial model data for testing
    state.models = { data: fakeModels, object: "list" }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("exact match returns as-is", () => {
    expect(resolveModel("gpt-5.3-codex")).toBe("gpt-5.3-codex")
  })

  test("case-insensitive match", () => {
    expect(resolveModel("GPT-5.3-CODEX")).toBe("gpt-5.3-codex")
  })

  test("normalized match (dots → dashes)", () => {
    expect(resolveModel("gpt5.3-codex")).toBe("gpt-5.3-codex")
  })

  test("opus family preference resolves to 1m variant", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4.6-1m")
  })

  test("claude-opus-4-6 resolves to 1m, not 200K variant (regression)", () => {
    // Claude Code sends "claude-opus-4-6" (dashes, no dots).
    // Family preference (opus→1m) must run before normalization,
    // otherwise it matches claude-opus-4.6 (200K) via normalization.
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4.6-1m")
  })

  test("claude-opus-4.6 exact match stays at 200K, does not redirect to 1m", () => {
    // When user explicitly requests the 200K variant, respect it.
    expect(resolveModel("claude-opus-4.6")).toBe("claude-opus-4.6")
  })

  test("claude-opus-4.6-1m exact match stays as-is", () => {
    expect(resolveModel("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m")
  })

  test("codex family preference resolves to highest version", () => {
    expect(resolveModel("codex")).toBe("gpt-5.3-codex")
  })

  test("returns input when no models cached", () => {
    state.models = undefined
    expect(resolveModel("gpt-5.3-codex")).toBe("gpt-5.3-codex")
  })

  test("returns input when no match found", () => {
    expect(resolveModel("nonexistent-model")).toBe("nonexistent-model")
  })
})

// --- resolveCodexModel ---

describe("resolveCodexModel", () => {
  beforeEach(() => {
    // @ts-expect-error - partial model data for testing
    state.models = { data: fakeModels, object: "list" }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("resolves exact model", () => {
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex")
  })

  test("resolves normalized model", () => {
    expect(resolveCodexModel("gpt5.3-codex")).toBe("gpt-5.3-codex")
  })

  test("falls back to best codex model when not found", () => {
    const result = resolveCodexModel("nonexistent-codex")
    expect(result).toBe("gpt-5.3-codex")
  })

  test("returns input when no models cached", () => {
    state.models = undefined
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex")
  })
})
