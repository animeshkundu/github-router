import { test, expect, afterEach } from "bun:test"

import {
  buildCatalogView,
  catalogTokenPrices,
  FALLBACK_TOKEN_PRICES,
  INDICATIVE_TOKENS_PER_SECOND,
  indicativeTokensPerSecond,
  warnOnTokenPriceDrift,
  WORKER_THINKING_LEVELS,
} from "~/lib/worker-agent/model-resolve"
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL_CHAIN,
  EXPLORE_DEFAULT_MODEL,
  IMPLEMENT_DEFAULT_MODEL,
  PLAN_DEFAULT_MODEL,
  REVIEW_DEFAULT_MODEL,
  TEST_DEFAULT_MODEL,
} from "~/lib/worker-agent/engine"
import { SCOUT_MODEL_CHAIN } from "~/lib/mcp-capabilities"
import { OPENAI_FRONTIER_MODELS } from "~/lib/openai-frontier"
import consola from "consola"

import { state } from "~/lib/state"

// The catalog view exists to close a DISCOVERABILITY gap: models ship in the
// live Copilot catalog that appear nowhere in `src/`, so the hardcoded chains
// cannot route to them and nobody evaluates them. It is derived metadata plus
// one explicitly-labelled, dated speed hint. It deliberately carries no
// reasoning, quality, intelligence, or benchmark prose: that characterization
// rots silently as vendors ship, and a WRONG one misroutes invisibly at the
// call site while a MISSING one costs only one recoverable pick.
//
// These tests pin the filter and the clamp, because both are places where
// being subtly wrong would surface a model the worker layer cannot actually
// drive — which is worse than omitting it.

const realModels = state.models

afterEach(() => {
  state.models = realModels
})

function setCatalog(data: Array<unknown>): void {
  state.models = { data, object: "list" } as unknown as typeof state.models
}

function model(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "m",
    vendor: "V",
    capabilities: {
      supports: { tool_calls: true, reasoning_effort: ["low", "high"] },
      limits: { max_context_window_tokens: 1_000_000 },
    },
    ...over,
  }
}

test("excludes models a worker cannot actually drive", () => {
  setCatalog([
    // No tool_calls: the worker loop IS function calling, so this is unusable.
    model({
      id: "no-tools",
      capabilities: {
        supports: { tool_calls: false, reasoning_effort: ["high"] },
        limits: { max_context_window_tokens: 1_000_000 },
      },
    }),
    // Window too small to be worth delegating to.
    model({
      id: "tiny-ctx",
      capabilities: {
        supports: { tool_calls: true, reasoning_effort: ["high"] },
        limits: { max_context_window_tokens: 8_000 },
      },
    }),
    // No reasoning efforts the worker layer can request.
    model({
      id: "no-efforts",
      capabilities: {
        supports: { tool_calls: true, reasoning_effort: [] },
        limits: { max_context_window_tokens: 1_000_000 },
      },
    }),
    model({ id: "usable" }),
  ])

  expect(buildCatalogView().map((r) => r.id)).toEqual(["usable"])
})

test("clamps efforts to what the worker layer can request", () => {
  // Real models advertise a `max` tier above xhigh that the worker layer
  // filters out. Surfacing the RAW array would advertise an effort no worker
  // can ask for — the caller would set it and silently get something else.
  setCatalog([
    model({
      id: "with-max",
      capabilities: {
        supports: {
          tool_calls: true,
          reasoning_effort: ["low", "high", "xhigh", "max"],
        },
        limits: { max_context_window_tokens: 1_000_000 },
      },
    }),
  ])

  const [row] = buildCatalogView()
  expect(row!.efforts).toEqual(["low", "high", "xhigh"])
  for (const effort of row!.efforts) {
    expect(WORKER_THINKING_LEVELS as ReadonlyArray<string>).toContain(effort)
  }
})

test("surfaces the effective prompt ceiling in the worker catalog", () => {
  setCatalog([
    model({
      id: "asymmetric-window",
      capabilities: {
        supports: { tool_calls: true, reasoning_effort: ["high"] },
        limits: {
          max_context_window_tokens: 1_050_000,
          max_prompt_tokens: 922_000,
        },
      },
    }),
    model({
      id: "prompt-only-window",
      capabilities: {
        supports: { tool_calls: true, reasoning_effort: ["high"] },
        limits: { max_prompt_tokens: 300_000 },
      },
    }),
  ])

  expect(buildCatalogView()).toEqual([
    expect.objectContaining({ id: "asymmetric-window", ctx: 922_000 }),
    expect.objectContaining({ id: "prompt-only-window", ctx: 300_000 }),
  ])
})

test("carries vendor but no quality ranking", () => {
  // `vendor` is present so a caller can reason about LAB DIVERSITY — the
  // reviewer must differ from whoever produced the artifact. No field here may
  // imply a quality ranking: if the lead could sort by "best", it would pick
  // the producer's model for review and silently undo cross-lab decorrelation.
  setCatalog([model({ id: "a", vendor: "Anthropic" })])

  const [row] = buildCatalogView()
  expect(row!.vendor).toBe("Anthropic")
  for (const banned of ["reasoning", "quality", "rank", "score", "best"]) {
    expect(Object.keys(row!)).not.toContain(banned)
  }
})

test("derives exact per-1M input and output prices from the live catalog", () => {
  setCatalog([
    model({
      id: "priced",
      billing: {
        token_prices: {
          batch_size: 1_000_000,
          input_price: 20_000_000_000,
          output_price: 120_000_000_000,
        },
      },
    }),
  ])

  expect(catalogTokenPrices("priced")).toEqual({ in: 20, out: 120 })
  expect(buildCatalogView()).toContainEqual(expect.objectContaining({
    id: "priced",
    in: 20,
    out: 120,
  }))
})

test("normalizes live batch prices to per-1M-token units", () => {
  setCatalog([
    model({
      id: "smaller-batch",
      billing: {
        token_prices: {
          batch_size: 100_000,
          input_price: 2_000_000_000,
          output_price: 12_000_000_000,
        },
      },
    }),
  ])

  expect(catalogTokenPrices("smaller-batch")).toEqual({ in: 20, out: 120 })
})

test("omits prices when token_prices is absent or malformed", () => {
  setCatalog([
    model({ id: "absent" }),
    model({
      id: "missing-output",
      billing: { token_prices: { batch_size: 1_000_000, input_price: 20_000_000_000 } },
    }),
    model({
      id: "invalid-batch",
      billing: {
        token_prices: {
          batch_size: 0,
          input_price: 20_000_000_000,
          output_price: 120_000_000_000,
        },
      },
    }),
    model({
      id: "fractional-batch",
      billing: {
        token_prices: {
          batch_size: 0.5,
          input_price: 20_000_000_000,
          output_price: 120_000_000_000,
        },
      },
    }),
    model({
      id: "unsafe-batch",
      billing: {
        token_prices: {
          batch_size: Number.MAX_SAFE_INTEGER + 1,
          input_price: 20_000_000_000,
          output_price: 120_000_000_000,
        },
      },
    }),
    model({
      id: "negative-input",
      billing: {
        token_prices: {
          batch_size: 1_000_000,
          input_price: -1,
          output_price: 120_000_000_000,
        },
      },
    }),
  ])

  expect(catalogTokenPrices("absent")).toBeUndefined()
  expect(catalogTokenPrices("missing-output")).toBeUndefined()
  expect(catalogTokenPrices("invalid-batch")).toBeUndefined()
  expect(catalogTokenPrices("fractional-batch")).toBeUndefined()
  expect(catalogTokenPrices("unsafe-batch")).toBeUndefined()
  expect(catalogTokenPrices("negative-input")).toBeUndefined()
  for (const row of buildCatalogView()) {
    expect(row).not.toHaveProperty("in")
    expect(row).not.toHaveProperty("out")
  }
})

test("keeps a zero live price and does not require cache_price", () => {
  setCatalog([
    model({
      id: "free-input",
      billing: {
        token_prices: {
          batch_size: 1_000_000,
          input_price: 0,
          output_price: 120_000_000_000,
        },
      },
    }),
  ])

  expect(catalogTokenPrices("free-input")).toEqual({ in: 0, out: 120 })
})

test("includes approximate tps only for models in the measured table", () => {
  setCatalog([
    model({ id: "gpt-5.6-luna" }),
    model({ id: "unmeasured" }),
  ])

  const luna = INDICATIVE_TOKENS_PER_SECOND["gpt-5.6-luna"]
  expect(indicativeTokensPerSecond("gpt-5.6-luna")).toBe(luna)
  expect(indicativeTokensPerSecond("unmeasured")).toBeUndefined()
  expect(buildCatalogView()).toContainEqual(expect.objectContaining({
    id: "gpt-5.6-luna",
    tps: luna,
  }))
  expect(buildCatalogView().find((row) => row.id === "unmeasured")).not.toHaveProperty("tps")
})

// The table is only useful where a routing decision is actually made, so every
// model a native agent or worker mode can resolve to must carry a figure. A
// missing entry silently drops the speed signal at exactly the call site that
// motivated measuring it.
// A speed figure is only useful where a routing decision happens, so every
// model any agent, worker, or fallback chain can resolve to must carry one.
//
// DERIVED, not hand-listed. The previous version of this test was a literal
// array, which silently omitted `gpt-5.5` — a real native-agent fallback with
// no tps entry — while claiming to cover "every model". A hand-maintained list
// asserting completeness is the failure it is supposed to catch, so the chains
// that can actually be routed to are imported and unioned here. Adding a model
// to any imported chain now fails this test until it is measured.
test("covers every model the native agents and worker modes route to", () => {
  const routed = new Set<string>([
    ...OPENAI_FRONTIER_MODELS,
    ...SCOUT_MODEL_CHAIN,
    ...DEFAULT_MODEL_CHAIN,
    // Per-mode worker defaults and per-agent chain heads that are not members
    // of an exported chain constant.
    EXPLORE_DEFAULT_MODEL,
    REVIEW_DEFAULT_MODEL,
    IMPLEMENT_DEFAULT_MODEL,
    TEST_DEFAULT_MODEL,
    BROWSE_DEFAULT_MODEL,
    PLAN_DEFAULT_MODEL,
    "gpt-5.6-terra",
  ])
  const missing = [...routed].filter((id) => indicativeTokensPerSecond(id) === undefined)
  expect(missing).toEqual([])
})

// The roster decision that deleted `generic-fast` rests on luna being faster
// than the Gemini flash family on the pre-registered tool-calling task, both
// measured through `scripts/bench-model-speed.ts`. Pin the ORDERING rather than
// the digits: the numbers are coarse and expected to be re-measured, but an
// edit that inverts this relation invalidates a shipped roster decision and
// must fail loudly rather than silently.
test("preserves the measured ordering the roster and explore decisions depend on", () => {
  const luna = indicativeTokensPerSecond("gpt-5.6-luna")!
  expect(luna).toBeGreaterThan(indicativeTokensPerSecond("gemini-3.6-flash")!)
  expect(luna).toBeGreaterThan(indicativeTokensPerSecond("gemini-3.5-flash")!)
})

test("includes every newly measured speed gap", () => {
  expect(indicativeTokensPerSecond("gpt-5.4-mini")).toBe(100)
  expect(indicativeTokensPerSecond("claude-sonnet-5")).toBe(100)
  expect(indicativeTokensPerSecond("claude-haiku-4.5")).toBe(85)
  expect(indicativeTokensPerSecond("grok-4.5")).toBe(70)
})

test("omits optional fields rather than emitting nulls", () => {
  setCatalog([model({ id: "sparse" })])
  const [row] = buildCatalogView()
  expect(row).not.toHaveProperty("in")
  expect(row).not.toHaveProperty("out")
  expect(row).not.toHaveProperty("tps")
  expect(row).not.toHaveProperty("maxOut")
})

test("survives an absent catalog", () => {
  state.models = undefined
  expect(buildCatalogView()).toEqual([])
})

// The fallback exists so a launch whose catalog fetch FAILED still gives the
// model cost signal instead of bare names. Live catalog must always win, and an
// id in neither source must stay undefined rather than being guessed.
test("falls back to recorded prices only when the live catalog cannot answer", () => {
  setCatalog([])
  expect(catalogTokenPrices("gpt-5.6-luna")).toEqual(
    FALLBACK_TOKEN_PRICES["gpt-5.6-luna"],
  )
  // Not in the catalog AND not in the fallback table: still undefined. The
  // fallback covers models actually recorded, never every id.
  expect(catalogTokenPrices("no-such-model")).toBeUndefined()

  // Live wins over the hardcoded copy, so a price change ships immediately
  // rather than waiting for someone to edit the table.
  setCatalog([
    model({
      id: "gpt-5.6-luna",
      billing: {
        token_prices: {
          batch_size: 1_000_000,
          input_price: 999_000_000_000,
          output_price: 120_000_000_000,
        },
      },
    }),
  ])
  expect(catalogTokenPrices("gpt-5.6-luna")).toEqual({ in: 999, out: 120 })
})

// A stale fallback is only ever READ on the degraded path, where nobody is
// looking, so without a startup check it could be wrong for months. Warn-only:
// a price mismatch must never block a launch.
test("drift check warns when a recorded price disagrees with the live catalog", () => {
  const warnings: Array<string> = []
  const realWarn = consola.warn
  // `LogFn` carries a `.raw` member the stub does not need, so the double cast
  // is narrowing an over-specified type rather than escaping type safety.
  consola.warn = ((msg: string) => {
    warnings.push(String(msg))
  }) as unknown as typeof consola.warn
  try {
    setCatalog([
      model({
        id: "gpt-5.6-luna",
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            input_price: 999_000_000_000,
            output_price: 120_000_000_000,
          },
        },
      }),
    ])
    warnOnTokenPriceDrift()
    expect(warnings.some((w) => w.includes("gpt-5.6-luna") && w.includes("999"))).toBe(true)

    // Agreement must be silent, or the warning becomes noise nobody reads.
    warnings.length = 0
    setCatalog([
      model({
        id: "gpt-5.6-luna",
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            input_price: 20_000_000_000,
            output_price: 120_000_000_000,
          },
        },
      }),
    ])
    warnOnTokenPriceDrift()
    expect(warnings).toEqual([])
  } finally {
    consola.warn = realWarn
  }
})
