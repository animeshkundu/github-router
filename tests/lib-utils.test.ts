import { test, expect, mock, afterEach, describe, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_MODEL_FALLBACKS,
} from "../src/lib/port"
import {
  cacheModels,
  cacheVSCodeVersion,
  filterBetaHeader,
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
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.5")
})

test("DEFAULT_CLAUDE_MODEL is the Anthropic-published dashed slug", () => {
  // Anthropic slug is what Claude Code's `/model` UI registry expects.
  // The proxy's `resolveModel` translates this to Copilot's
  // `claude-opus-4.7-1m-internal` (enterprise) or `claude-opus-4.7`
  // (Pro+/Business/Max) at request time.
  expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-4-7")
})

test("DEFAULT_CLAUDE_MODEL_FALLBACKS lists older Opus versions (Anthropic slugs)", () => {
  // Ordering matters — the launcher uses the first match.
  // 1M↔200K downgrade is handled inside the resolver, so we don't need
  // separate `-1m` entries here — only major.minor regressions.
  expect(Array.from(DEFAULT_CLAUDE_MODEL_FALLBACKS)).toEqual([
    "claude-opus-4-6",
    "claude-opus-4-5",
  ])
})

test("DEFAULT_CODEX_MODEL_FALLBACKS lists older /responses models in order", () => {
  expect(Array.from(DEFAULT_CODEX_MODEL_FALLBACKS)).toEqual([
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
  ])
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
  { id: "gpt-5.5", supported_endpoints: ["/responses"] },
  { id: "gpt-5.3-codex", supported_endpoints: ["/responses"] },
  { id: "gpt-5.2-codex", supported_endpoints: ["/responses"] },
  { id: "claude-opus-4.7-1m-internal", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages", "/chat/completions"] },
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

  test("opus family preference resolves to 1m variant (no version → first match)", () => {
    // Bare "opus" has no major.minor; falls back to first 1M variant in list order.
    expect(resolveModel("opus")).toBe("claude-opus-4.7-1m-internal")
  })

  test("claude-opus-4.7 exact match stays at 200K (does not auto-upgrade)", () => {
    // Exact match wins over 1M upgrade. The implicit default upgrade to the
    // 1M variant is the claude subcommand's responsibility, not the resolver's
    // — explicit ids are respected. Verified empirically against Copilot.
    expect(resolveModel("claude-opus-4.7")).toBe("claude-opus-4.7")
  })

  test("claude-opus-4-7 (dashed) resolves to 4.7-1m-internal via family preference", () => {
    // Claude Code sends "claude-opus-4-7" (dashes, no dots) — no exact match,
    // so family preference picks the 1M variant whose major.minor matches
    // (regression: the old endsWith("-1m") missed claude-opus-4.7-1m-internal,
    // and the version-preference guard prevents downgrading to 4.6-1m).
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4.7-1m-internal")
  })

  test("claude-opus-4-7 (dashed) downgrades to plain claude-opus-4.7 when 1M variant absent", () => {
    // Non-enterprise tier: only the 200K variant is in the cache. The
    // family-preference branch finds zero -1m variants, falls through to
    // step 4 (normalized match), which translates dashed → dotted.
    // Without this graceful downgrade, ANTHROPIC_MODEL=claude-opus-4-7
    // (the new default per plan §14) would 400 against Copilot for
    // Pro+/Business/Max tokens.
    state.models = {
      data: [
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4.7")
  })

  test("claude-opus-4-6 (dashed) resolves to 4.6-1m, not the older default", () => {
    // The version-preference logic must pick 4.6-1m, not silently upgrade
    // to claude-opus-4.7-1m-internal just because it comes first in the list.
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4.6-1m")
  })

  test("claude-opus-4.6-1m exact match stays as-is", () => {
    expect(resolveModel("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m")
  })

  test("codex family preference resolves to highest codex-suffix version", () => {
    expect(resolveModel("codex")).toBe("gpt-5.3-codex")
  })

  test("gpt-5.5 exact match returns as-is (no codex fallback)", () => {
    // gpt-5.5 is the new codex-class model but lacks the -codex suffix.
    // It must hit step 1 exact match, not fall through to codex fallback.
    expect(resolveModel("gpt-5.5")).toBe("gpt-5.5")
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

// --- filterBetaHeader: regression guards for Copilot's denylist ---

describe("filterBetaHeader", () => {
  const originalExtended = state.extendedBetas

  afterEach(() => {
    state.extendedBetas = originalExtended
  })

  test("default mode keeps the 3 VS Code-stealth prefixes", () => {
    state.extendedBetas = false
    const input = [
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "advanced-tool-use-2025-11-20",
    ].join(",")
    expect(filterBetaHeader(input)).toBe(input)
  })

  test("default mode strips Claude CLI extended betas", () => {
    state.extendedBetas = false
    expect(filterBetaHeader("prompt-caching-2024-07-31")).toBeUndefined()
    expect(filterBetaHeader("claude-code-2025-04-29")).toBeUndefined()
  })

  test("extended mode strips context-1m-* (Copilot 400s — verified live)", () => {
    state.extendedBetas = true
    // Empty header drop → undefined; mixed header drops only the rejected one
    expect(filterBetaHeader("context-1m-2025-08-07")).toBeUndefined()
    expect(
      filterBetaHeader("prompt-caching-2024-07-31,context-1m-2025-08-07"),
    ).toBe("prompt-caching-2024-07-31")
  })

  test("extended mode strips skills-* (Copilot 400s — verified live)", () => {
    state.extendedBetas = true
    expect(filterBetaHeader("skills-2025-10-02")).toBeUndefined()
  })

  test("extended mode strips files-api-* (Copilot 400s — verified live)", () => {
    state.extendedBetas = true
    expect(filterBetaHeader("files-api-2025-04-14")).toBeUndefined()
  })

  test("extended mode keeps confirmed-working betas", () => {
    state.extendedBetas = true
    const input = [
      "claude-code-2025-04-29",
      "prompt-caching-2024-07-31",
      "computer-use-2024-10-22",
      "mcp-client-2025-04-04",
      "web-search-2025-03-05",
    ].join(",")
    expect(filterBetaHeader(input)).toBe(input)
  })
})

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

  test("falls back to best codex-class model when not found (prefers -codex suffix)", () => {
    const result = resolveCodexModel("nonexistent-codex")
    expect(result).toBe("gpt-5.3-codex")
  })

  test("falls back to gpt-5.5 when no -codex suffix models in cache", () => {
    // Simulate a future Copilot catalog where the -codex line was retired.
    // resolveCodexModel must still pick the highest non-mini /responses model.
    state.models = {
      data: [
        { id: "gpt-5.5", supported_endpoints: ["/responses"] },
        { id: "gpt-5.4", supported_endpoints: ["/responses", "/chat/completions"] },
        { id: "gpt-5-mini", supported_endpoints: ["/responses"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    const result = resolveCodexModel("nonexistent-future-codex")
    expect(result).toBe("gpt-5.5")
  })

  test("returns input when no models cached", () => {
    state.models = undefined
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex")
  })
})
