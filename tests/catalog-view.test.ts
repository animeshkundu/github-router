import { test, expect, afterEach } from "bun:test"

import { buildCatalogView } from "~/lib/worker-agent/model-resolve"
import { WORKER_THINKING_LEVELS } from "~/lib/worker-agent/model-resolve"
import { state } from "~/lib/state"

// The catalog view exists to close a DISCOVERABILITY gap: models ship in the
// live Copilot catalog that appear nowhere in `src/`, so the hardcoded chains
// cannot route to them and nobody evaluates them. It is deliberately DERIVED
// ONLY — no reasoning/speed/quality prose. That is not laziness: such a
// characterization cannot be computed from catalog metadata, it rots silently
// as vendors ship, and a WRONG one misroutes invisibly at the call site while
// a MISSING one costs only one recoverable pick.
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

test("carries vendor but no quality ranking", () => {
  // `vendor` is present so a caller can reason about LAB DIVERSITY — the
  // reviewer must differ from whoever produced the artifact. It is not a
  // quality signal, and no field here may imply one: if the lead could sort
  // by "best", it would pick the producer's model for review and silently
  // undo the cross-lab decorrelation the hardcoded resolvers exist to enforce.
  setCatalog([model({ id: "a", vendor: "Anthropic" })])

  const [row] = buildCatalogView()
  expect(row!.vendor).toBe("Anthropic")
  for (const banned of ["reasoning", "speed", "quality", "rank", "score", "best"]) {
    expect(Object.keys(row!)).not.toContain(banned)
  }
})

test("omits optional fields rather than emitting nulls", () => {
  setCatalog([model({ id: "sparse" })])
  const [row] = buildCatalogView()
  expect(row).not.toHaveProperty("cost")
  expect(row).not.toHaveProperty("maxOut")
})

test("survives an absent catalog", () => {
  state.models = undefined
  expect(buildCatalogView()).toEqual([])
})
