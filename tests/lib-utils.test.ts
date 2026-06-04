import { test, expect, mock, afterEach, describe, beforeEach } from "bun:test"
import consola from "consola"

import { state } from "../src/lib/state"
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_MODEL_FALLBACKS,
  pickClaudeDefault,
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
  // `claude-opus-4.8` at request time (no -1m sibling on 4.8; the single
  // base slug already advertises 1M context).
  expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-4-8")
})

test("DEFAULT_CLAUDE_MODEL_FALLBACKS lists older Opus versions (Anthropic slugs)", () => {
  // Ordering matters — the launcher uses the first match.
  // 1M↔200K downgrade is handled inside the resolver, so we don't need
  // separate `-1m` entries here — only major.minor regressions.
  expect(Array.from(DEFAULT_CLAUDE_MODEL_FALLBACKS)).toEqual([
    "claude-opus-4-7",
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

  test("claude-opus-4-8 (dashed) resolves to bare claude-opus-4.8, not a wrong-version 1M variant", () => {
    // Copilot ships claude-opus-4.8 without a -1m sibling. The resolver
    // must NOT fall back to claude-opus-4.7-1m-internal or claude-opus-4.6-1m.
    state.models = {
      data: [
        { id: "claude-opus-4.8", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7-1m-internal", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6-1m", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-opus-4-8")).toBe("claude-opus-4.8")
  })

  test("claude-opus-4-7 still resolves to 1m-internal when 4.8 is in catalog (regression guard)", () => {
    // Ensure the fix doesn't break the 4.7 path where a matching 1M
    // variant DOES exist.
    state.models = {
      data: [
        { id: "claude-opus-4.8", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7-1m-internal", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6-1m", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4.7-1m-internal")
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

  // --- Step 5: Anthropic dated-slug retry (claude-code-guide-driven Haiku/Sonnet path) ---

  test("haiku dated slug resolves to floating tag (claude-haiku-4-5-20251001 → claude-haiku-4.5)", () => {
    // Reproduces the bug: Claude Code's small-model background path requested
    // claude-haiku-4-5-20251001 every session and Copilot's catalog only has
    // claude-haiku-4.5. Without Step 5 the request fell through to a warn +
    // upstream rejection, breaking subagent dispatch.
    state.models = {
      data: [
        ...fakeModels,
        { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5")
  })

  test("sonnet 4.6 dated slug resolves to floating tag", () => {
    // Sonnet 4.6 hits the same path as Haiku — Anthropic's published slug
    // carries -YYYYMMDD, Copilot's catalog uses claude-sonnet-4.6.
    expect(resolveModel("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4.6")
  })

  test("sonnet 4.5 dated slug (claude-sonnet-4-5-20250929) resolves to claude-sonnet-4.5", () => {
    // Live coverage: as of today's Copilot /models catalog, both
    // claude-sonnet-4.5 and claude-sonnet-4.6 are present, so requests
    // pinned to the older 4.5 snapshot must still resolve correctly.
    state.models = {
      data: [
        ...fakeModels,
        { id: "claude-sonnet-4.5", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5")
  })

  test("legacy Anthropic convention (claude-3-5-sonnet-20241022) resolves to claude-3-5-sonnet", () => {
    // Locks in coverage of the older Anthropic shape (no major.minor with dot).
    state.models = {
      data: [
        ...fakeModels,
        { id: "claude-3-5-sonnet", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet")
  })

  test("opus dated slug composes with family preference (claude-opus-4-7-20260101 → 1m-internal)", () => {
    // Step 5 strips the date, retried Step 3 picks the 1M variant. Proves the
    // retry composes correctly with existing family-preference logic.
    expect(resolveModel("claude-opus-4-7-20260101")).toBe(
      "claude-opus-4.7-1m-internal",
    )
  })

  test("family guard: non-claude 8-digit suffix is NOT stripped (codex-critic must-fix)", () => {
    // If OpenAI (or any other provider) ever ships a slug like
    // gpt-future-20260101 (Anthropic-style concatenated date), the regex must
    // NOT silently strip it. Choosing a slug without "opus"/"codex" so it
    // skips Step 3 family preference and reaches Step 5 — which must refuse
    // to strip because the input doesn't start with "claude-".
    expect(resolveModel("gpt-future-20260101")).toBe("gpt-future-20260101")
  })

  test("explicit version pinning wins over date-strip retry (gemini-critic must-fix)", () => {
    // If Copilot ever publishes a dated catalog entry alongside the floating
    // tag (precedent: gpt-4o-2024-11-20 ↔ gpt-4o), Step 1 exact match must
    // win — the retry only fires when the standard cascade misses entirely.
    state.models = {
      data: [
        { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
        {
          id: "claude-haiku-4.5-20251001",
          supported_endpoints: ["/v1/messages"],
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    // Note: dotted catalog id with the date suffix appended. Step 1 finds
    // the exact catalog entry; Step 5 never runs.
    expect(resolveModel("claude-haiku-4.5-20251001")).toBe(
      "claude-haiku-4.5-20251001",
    )
  })

  // --- Step 0: [1m] literal-bracket suffix (Claude Code's 1M unlock) ---

  test("[1m] suffix on opus-4-7 routes to the 1M backend when present (enterprise tier)", () => {
    // cc-backup src/utils/context.ts:35-40: has1mContext matches /\[1m\]/i;
    // Claude Code's parseUserSpecifiedModel (model.ts:445-506) reattaches
    // the bracket after alias resolution, so the wire form is literally
    // "claude-opus-4-7[1m]". The proxy MUST strip the bracket before
    // touching Copilot (which 400s on the bracket) and prefer a -1m
    // variant if the catalog has one.
    expect(resolveModel("claude-opus-4-7[1m]")).toBe(
      "claude-opus-4.7-1m-internal",
    )
  })

  test("[1m] suffix preserves case-insensitively (matches /\\[1m\\]/i)", () => {
    // cc-backup uses the /i flag — Claude Code may send [1M] in some
    // edge case. Strip regardless.
    expect(resolveModel("claude-opus-4-7[1M]")).toBe(
      "claude-opus-4.7-1m-internal",
    )
  })

  test("[1m] suffix on opus-4-7 downgrades to 200K when no -1m backend in catalog (non-enterprise)", () => {
    // Pro+/Business/Max tier: only the 200K variant is present. The
    // bracket-strip delegates to the inner cascade, which finds
    // claude-opus-4.7 via normalized match. The proxy must NOT forward
    // the bracketed slug to Copilot — it would 400.
    state.models = {
      data: [
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(resolveModel("claude-opus-4-7[1m]")).toBe("claude-opus-4.7")
  })

  test("[1m] suffix on a family with no 1M backend (sonnet) downgrades silently to the 200K variant", () => {
    // Copilot's catalog has no sonnet-1m at any tier. A user (or future
    // misconfiguration) sending claude-sonnet-4-6[1m] must still produce
    // a valid Copilot request — just one where Claude Code's local
    // accounting is wrong.
    expect(resolveModel("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4.6")
  })

  test("[1m] suffix never appears in the resolved output (bracket stripped before return)", () => {
    // Defense-in-depth: regardless of which inner branch resolves the
    // stripped form, the literal "[1m]" must NEVER appear in the result.
    // If it did, the request would be forwarded verbatim to Copilot
    // and 400 with an unrecognized model id.
    const inputs = [
      "claude-opus-4-7[1m]",
      "claude-opus-4-7[1M]",
      "claude-sonnet-4-6[1m]",
      "claude-haiku-4-5[1m]",
    ]
    for (const input of inputs) {
      expect(resolveModel(input)).not.toContain("[1m]")
      expect(resolveModel(input)).not.toContain("[1M]")
    }
  })

  test("[1m] bracket-strip recursion is bounded (the stripped form cannot re-enter the bracket branch)", () => {
    // Sanity: a doubly-bracketed input shouldn't infinite-loop. The outer
    // strip removes one [1m]; the inner call sees "...[1m]" again,
    // strips once more; the third level has no bracket and falls into
    // the normal cascade. This is "fine" behavior — pathological inputs
    // resolve in a finite number of recursions.
    expect(() => resolveModel("claude-opus-4-7[1m][1m]")).not.toThrow()
  })
})

// --- resolveModel: consola breadcrumb assertions for Step 5 dated-slug retry ---

describe("resolveModel — Step 5 dated-slug retry log breadcrumbs", () => {
  let originalInfo: typeof consola.info
  let originalWarn: typeof consola.warn
  let infoCalls: Array<Array<unknown>>
  let warnCalls: Array<Array<unknown>>

  beforeEach(() => {
    originalInfo = consola.info
    originalWarn = consola.warn
    infoCalls = []
    warnCalls = []
    consola.info = mock((...args: Array<unknown>) => {
      infoCalls.push(args)
    }) as unknown as typeof consola.info
    consola.warn = mock((...args: Array<unknown>) => {
      warnCalls.push(args)
    }) as unknown as typeof consola.warn

    state.models = {
      data: [
        { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
  })

  afterEach(() => {
    consola.info = originalInfo
    consola.warn = originalWarn
    state.models = undefined
  })

  test("dated-slug success path emits one info breadcrumb and zero warns", () => {
    const result = resolveModel("claude-haiku-4-5-20251001")
    expect(result).toBe("claude-haiku-4.5")
    expect(infoCalls).toHaveLength(1)
    const [msg] = infoCalls[0] as [string]
    expect(msg).toContain("claude-haiku-4-5-20251001")
    expect(msg).toContain("claude-haiku-4.5")
    expect(msg).toContain("stripped -YYYYMMDD")
    // The fix's whole point: no "not found" warning on the success path.
    expect(warnCalls).toHaveLength(0)
  })

  test("haiku resolution does NOT trigger the legacy not-found warning", () => {
    resolveModel("claude-haiku-4-5-20251001")
    const warnTexts = warnCalls.map((c) => String(c[0] ?? ""))
    expect(
      warnTexts.some((t) => t.includes("not found in Copilot model list")),
    ).toBe(false)
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

  // --- Phase A: empirically verified new prefixes (2026-05-11 against Copilot enterprise) ---

  test("extended mode keeps task-budgets-* (Copilot 200 — verified)", () => {
    state.extendedBetas = true
    expect(filterBetaHeader("task-budgets-2026-03-13")).toBe(
      "task-budgets-2026-03-13",
    )
  })

  test("extended mode keeps token-efficient-tools-* (Copilot 200 — verified)", () => {
    state.extendedBetas = true
    expect(filterBetaHeader("token-efficient-tools-2026-03-28")).toBe(
      "token-efficient-tools-2026-03-28",
    )
  })

  test("extended mode keeps Anthropic-internal betas (won't fire for non-ant users but allowlisted defensively)", () => {
    state.extendedBetas = true
    const input = [
      "summarize-connector-text-2026-03-13",
      "afk-mode-2026-01-31",
      "cli-internal-2026-02-09",
      "oauth-2025-04-20",
    ].join(",")
    expect(filterBetaHeader(input)).toBe(input)
  })

  test("extended mode strips advisor-tool-* (Copilot 400 'unsupported beta header' — verified live)", () => {
    state.extendedBetas = true
    // Empirical 2026-05-11: Copilot returns
    //   `unsupported beta header(s): advisor-tool-2026-03-01`
    // on every request that includes this prefix. The proxy must strip
    // even when extended-betas is on. ADVISOR is not implementable via
    // Copilot upstream — see Phase I (proxy-side ADVISOR translation)
    // and CLAUDE.md for the planned alternative.
    expect(filterBetaHeader("advisor-tool-2026-03-01")).toBeUndefined()
  })

  test("extended mode strips advisor-tool-* even when bundled with other valid betas", () => {
    state.extendedBetas = true
    // The strip must be surgical — keep the working sibling, drop the
    // poison pill, so the request still benefits from the rest of the
    // beta set instead of failing wholesale.
    expect(
      filterBetaHeader(
        "task-budgets-2026-03-13,advisor-tool-2026-03-01,token-efficient-tools-2026-03-28",
      ),
    ).toBe("task-budgets-2026-03-13,token-efficient-tools-2026-03-28")
  })

  test("default (vscode-stealth) mode also strips advisor-tool-* (defense-in-depth)", () => {
    state.extendedBetas = false
    expect(filterBetaHeader("advisor-tool-2026-03-01")).toBeUndefined()
  })
})

// --- Phase A P0.4: legacy Sonnet/Haiku family fallback ---

describe("resolveModel — Step 6 legacy family fallback (Phase A P0.4)", () => {
  let originalInfo: typeof consola.info
  let infoCalls: Array<Array<unknown>>

  beforeEach(() => {
    originalInfo = consola.info
    infoCalls = []
    consola.info = mock((...args: Array<unknown>) => {
      infoCalls.push(args)
    }) as unknown as typeof consola.info

    // Simulate Copilot's catalog as of 2026-05-11: only sonnet 4.5 and 4.6,
    // no Sonnet < 4.5; only haiku 4.5, no Haiku < 4.5.
    state.models = {
      data: [
        { id: "claude-sonnet-4.5", supported_endpoints: ["/v1/messages"] },
        { id: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages"] },
        { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
  })

  afterEach(() => {
    consola.info = originalInfo
    state.models = undefined
  })

  test("legacy Sonnet 3.7 dated slug falls back to highest sonnet (claude-3-7-sonnet-20250219 → claude-sonnet-4.6)", () => {
    // Empirical 2026-05-11: requesting claude-3-7-sonnet-20250219 against
    // Copilot returns HTTP 400 "The requested model is not supported."
    // Without this fallback, every Claude Code session pinning legacy
    // Sonnet in settings.json fails wholesale.
    //
    // The cascade interaction: Step 5 (dated-slug retry) strips the date
    // and re-runs resolveModel, which lands on Step 6 (legacy fallback).
    // BOTH log breadcrumbs fire — Step 6's "legacy sonnet" inside the
    // retry, then Step 5's "stripped -YYYYMMDD" on the way out. We assert
    // the legacy-fallback breadcrumb appears SOMEWHERE so users know a
    // legacy substitution happened (the dated-slug log alone could be
    // misleading — it sounds like a same-family version match).
    const result = resolveModel("claude-3-7-sonnet-20250219")
    expect(result).toBe("claude-sonnet-4.6")
    const allMessages = infoCalls.map((c) => String(c[0] ?? "")).join(" | ")
    expect(allMessages).toContain("legacy sonnet")
    expect(allMessages).toContain("claude-sonnet-4.6")
  })

  test("legacy Sonnet 4.0 falls back to highest sonnet (claude-sonnet-4-0 → claude-sonnet-4.6)", () => {
    // Same empirical failure as the 3.7 case — Copilot 400s on sonnet-4-0.
    const result = resolveModel("claude-sonnet-4-0")
    expect(result).toBe("claude-sonnet-4.6")
  })

  test("legacy Haiku 3.5 falls back to highest haiku when not handled by step 5", () => {
    // The dated-slug retry alone strips the date and tries the cascade
    // again; if that still misses, family fallback must catch it.
    // (Empirical: Copilot accepts claude-3-5-haiku-20241022 natively, but
    // we should still translate it to a Copilot-known slug for consistency
    // and clearer logs.)
    const result = resolveModel("claude-3-5-haiku-future-slug")
    expect(result).toBe("claude-haiku-4.5")
  })

  test("legacy fallback does NOT fire when exact catalog match exists", () => {
    // Step 1 wins — fallback is the LAST resort before warn.
    expect(resolveModel("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(resolveModel("claude-sonnet-4.6")).toBe("claude-sonnet-4.6")
    // No info-log breadcrumb on exact match.
    expect(infoCalls).toHaveLength(0)
  })

  test("legacy fallback does NOT fire for non-claude families (codex-reviewer must-fix)", () => {
    // Per the claude- prefix guard added after codex-reviewer feedback:
    // a non-Claude provider coincidentally using "sonnet" in its slug
    // (custom-sonnet-future, gpt-future-sonnet, etc.) must NOT silently
    // remap to a Claude model. The fallback only fires for claude-*
    // inputs.
    const result = resolveModel("custom-sonnet-future")
    expect(result).toBe("custom-sonnet-future") // unchanged — falls through to Step 7 warn
  })

  test("legacy fallback does NOT fire for word-internal family substring (claude-supersonnet would not match)", () => {
    // Word-bounded family regex `(?:^|-)sonnet(?:-|$)` protects against
    // a future hypothetical model whose name happens to embed "sonnet"
    // mid-word.
    const result = resolveModel("claude-supersonnetx-future")
    expect(result).toBe("claude-supersonnetx-future") // no match, returns as-is + warn
  })

  test("legacy fallback uses numeric-aware sort (claude-sonnet-4.10 > claude-sonnet-4.6)", () => {
    // Lexicographic compare alone misorders two-digit minors. Numeric
    // collation picks the actual highest version. Today the catalog has
    // only single-digit minors so this is forward-compat insurance —
    // simulate a hypothetical future catalog.
    state.models = {
      data: [
        { id: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages"] },
        { id: "claude-sonnet-4.10", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    const result = resolveModel("claude-sonnet-3-7")
    expect(result).toBe("claude-sonnet-4.10")
  })

  test("legacy fallback emits info breadcrumb (visible substitution)", () => {
    resolveModel("claude-sonnet-4-0")
    expect(infoCalls.length).toBeGreaterThanOrEqual(1)
    const allMessages = infoCalls.map((c) => String(c[0] ?? "")).join(" | ")
    expect(allMessages).toContain("not in Copilot catalog")
    expect(allMessages).toContain("Pin a current catalog id")
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

// --- pickClaudeDefault: cap-aware ANTHROPIC_MODEL default ---

describe("pickClaudeDefault", () => {
  afterEach(() => {
    state.models = undefined
  })

  test("returns claude-opus-4-8[1m] when catalog base slug has max_context_window_tokens >= 1M (no sibling -1m needed)", () => {
    // Reflects the live catalog as of 2026-06-04: claude-opus-4.8 ships
    // as a single base slug whose capabilities.limits already advertises
    // max_context_window_tokens: 1_000_000. There is NO sibling -1m
    // entry. The dual-signal detector must flip [1m] on via the
    // base-slug capability signal.
    state.models = {
      data: [
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault()).toBe("claude-opus-4-8[1m]")
  })

  test("returns claude-opus-4-8[1m] when catalog has hypothetical opus-4.8-1m sibling slug too", () => {
    // Forward-compat: if Copilot ever ships a separate -1m sibling for 4.8,
    // the sibling-slug signal still fires (regex match is independent of
    // the base-slug capability check).
    state.models = {
      data: [
        { id: "claude-opus-4.8-1m", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.8", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault()).toBe("claude-opus-4-8[1m]")
  })

  test("returns bare claude-opus-4-8 when no 1M signal fires (base slug 200K, no sibling)", () => {
    // Pro-tier scenario: only the 200K variant is present and the base
    // slug's max_context_window_tokens isn't 1M. Without cap-awareness,
    // ANTHROPIC_MODEL=claude-opus-4-8[1m] would force Claude Code to
    // over-account context while the proxy silently downgrades.
    state.models = {
      data: [
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 200_000 } },
        },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault()).toBe(DEFAULT_CLAUDE_MODEL)
    expect(pickClaudeDefault()).not.toContain("[1m]")
  })

  test("returns bare claude-opus-4-8 when state.models is unset (pre-cacheModels safety)", () => {
    // If somehow pickClaudeDefault gets called before cacheModels populates
    // state.models, default safe-side to the bare slug.
    state.models = undefined
    expect(pickClaudeDefault()).toBe(DEFAULT_CLAUDE_MODEL)
  })

  test("does NOT false-positive on opus-4.7-1m-internal (version-anchored to 4.8)", () => {
    // The 1M detector for the default family matches /opus-4[.-]8-1m/
    // OR the 4.8 base slug's max_context_window_tokens. A 4.7 1M sibling
    // (stand_in's pinned row) must NOT flip the 4.8 default's [1m]
    // decoration, and the 4.8 base slug with no 1M signal must stay bare.
    state.models = {
      data: [
        {
          id: "claude-opus-4.7-1m-internal",
          supported_endpoints: ["/v1/messages"],
        },
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 200_000 } },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault()).toBe(DEFAULT_CLAUDE_MODEL)
    expect(pickClaudeDefault()).not.toContain("[1m]")
  })

  // --- Opus family shorthand (`-m 4.7` / `-m 4.6` / `-m 4.8`) ---

  test("pickClaudeDefault(\"4.7\") returns claude-opus-4-7[1m] when 1M variant present", () => {
    // Explicit family request still uses the sibling-slug signal.
    state.models = {
      data: [
        { id: "claude-opus-4.7-1m-internal", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.7")).toBe("claude-opus-4-7[1m]")
  })

  test("pickClaudeDefault(\"4.6\") returns claude-opus-4-6[1m] when opus-4.6-1m present", () => {
    state.models = {
      data: [
        { id: "claude-opus-4.6-1m", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.6")).toBe("claude-opus-4-6[1m]")
  })

  test("pickClaudeDefault(\"4.8\") returns claude-opus-4-8[1m] via base-slug capability signal", () => {
    // The explicit-family path uses the same dual-signal detector.
    state.models = {
      data: [
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
        },
        { id: "claude-opus-4.7-1m-internal", supported_endpoints: ["/v1/messages"] },
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.8")).toBe("claude-opus-4-8[1m]")
  })

  test("pickClaudeDefault(\"4.8\") returns bare claude-opus-4-8 when no 1M signal fires", () => {
    // Bare-slug branch: if a future Copilot tier ever ships claude-opus-4.8
    // as 200K-only (no -1m sibling and base-slug capability also 200K),
    // we must stay on the bare slug.
    state.models = {
      data: [
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 200_000 } },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.8")).toBe("claude-opus-4-8")
    expect(pickClaudeDefault("4.8")).not.toContain("[1m]")
  })

  test("pickClaudeDefault(\"4.7\") returns bare claude-opus-4-7 when only 200K variant present", () => {
    state.models = {
      data: [
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.7")).toBe("claude-opus-4-7")
  })

  test("base-slug 1M detection is NOT order-dependent when dotted + dashed aliases coexist", () => {
    // Defensive: if the catalog ever lists both `claude-opus-4.8` (200K)
    // and `claude-opus-4-8` (1M-capable) — or vice versa — the picker
    // must consider ALL base-slug matches, not just the first. The
    // .reduce(max(...)) form makes the result deterministic regardless
    // of catalog ordering. Today Copilot only ships dotted slugs, but
    // defending here keeps the detector robust against future drift.
    state.models = {
      data: [
        // dotted alias first, advertised as 200K
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 200_000 } },
        },
        // dashed alias second, advertised as 1M — would have been missed
        // by find()-then-check; reduce(max()) sees both.
        {
          id: "claude-opus-4-8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4.8")).toBe("claude-opus-4-8[1m]")
  })

  test("pickClaudeDefault accepts dashed family form (\"4-8\") as a convenience", () => {
    state.models = {
      data: [
        {
          id: "claude-opus-4.8",
          supported_endpoints: ["/v1/messages"],
          capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    expect(pickClaudeDefault("4-8")).toBe("claude-opus-4-8[1m]")
  })

  test("pickClaudeDefault warns when requested family is completely absent from catalog", () => {
    state.models = {
      data: [
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    const warnSpy = mock((..._args: unknown[]) => {})
    const original = consola.warn
    consola.warn = warnSpy as unknown as typeof consola.warn
    try {
      // 9.9 doesn't exist anywhere — should warn but still return the bare slug
      // so resolveModel's downstream "model not found" path can take over.
      const result = pickClaudeDefault("9.9")
      expect(result).toBe("claude-opus-9-9")
      expect(warnSpy).toHaveBeenCalled()
      const firstCall = warnSpy.mock.calls[0] ?? []
      const warnArg = String((firstCall as unknown[])[0] ?? "")
      expect(warnArg).toContain("9.9")
    } finally {
      consola.warn = original
    }
  })

  test("pickClaudeDefault does NOT warn for missing family when state.models is unset (pre-cache safety)", () => {
    // Before cacheModels populates the catalog, we can't tell "absent" from
    // "not loaded yet". Stay silent to avoid noisy launch logs.
    state.models = undefined
    const warnSpy = mock((..._args: unknown[]) => {})
    const original = consola.warn
    consola.warn = warnSpy as unknown as typeof consola.warn
    try {
      expect(pickClaudeDefault("4.8")).toBe("claude-opus-4-8")
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      consola.warn = original
    }
  })
})
