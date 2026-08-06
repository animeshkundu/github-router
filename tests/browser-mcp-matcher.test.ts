import { describe, expect, test } from "bun:test"

import { deterministicResolve } from "../src/lib/browser-mcp/matcher"
import { parseIntent } from "../src/lib/browser-mcp/parse-intent"
import type {
  PageSnapshot,
  SnapshotElement,
} from "../src/lib/browser-mcp/snapshot-types"

const VIEWPORT: PageSnapshot["viewport"] = {
  width: 1280,
  height: 720,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

function element(
  ref: string,
  role: string,
  overrides: Partial<SnapshotElement> = {},
): SnapshotElement {
  return {
    ref,
    role,
    bbox: [10, 10, 120, 32],
    ...overrides,
  }
}

function snapshot(elements: ReadonlyArray<SnapshotElement>): PageSnapshot {
  return { viewport: VIEWPORT, text: "", elements }
}

describe("browser-mcp deterministic matcher cascade", () => {
  test.each([
    {
      layer: "L0",
      intent: "click Save",
      elements: [element("exact", "button", { name: "Save" })],
      confidence: 1,
    },
    {
      layer: "L1",
      intent: "fill email field",
      elements: [element("label", "textbox", { name: "Email (required)" })],
      confidence: 0.95,
    },
    {
      layer: "L2",
      intent: "fill email field",
      elements: [element("placeholder", "textbox", { placeholder: "Email" })],
      confidence: 0.85,
    },
    {
      layer: "L3",
      intent: "click save",
      elements: [element("fuzzy-name", "button", { name: "Save changes" })],
      confidence: 0.68,
    },
    {
      layer: "L4",
      intent: "click go",
      elements: [element("visible-value", "button", { value: "Go" })],
      confidence: 0.65,
    },
    {
      layer: "L5",
      intent: "click checkout-submit",
      elements: [element("test-id", "button", { attrs: { testid: "checkout_submit" } })],
      confidence: 0.9,
    },
    {
      layer: "L6",
      intent: "click the third card",
      elements: [
        element("card-1", "card", { bbox: [10, 10, 80, 40] }),
        element("card-2", "card", { bbox: [100, 10, 80, 40] }),
        element("card-3", "card", { bbox: [10, 60, 80, 40] }),
      ],
      confidence: 0.8,
      ref: "card-3",
    },
    {
      layer: "L7",
      intent: "fill email",
      elements: [element("semantic-email", "textbox", { inputType: "email" })],
      confidence: 0.55,
    },
  ])("reaches $layer without a model fallback", ({ layer, intent, elements, confidence, ref }) => {
    const result = deterministicResolve(snapshot(elements), parseIntent(intent), "value")

    expect(result.source).toBe(layer)
    expect(result.ref).toBe(ref ?? elements[0]!.ref)
    expect(result.confidence).toBe(confidence)
  })

  test("an exact accessible name wins before a fuzzy whole-word match", () => {
    // Dispatching the broader label would violate the cascade's strict-to-fuzzy
    // contract even though it is also a valid whole-word match.
    const result = deterministicResolve(
      snapshot([
        element("fuzzy", "button", { name: "Save changes" }),
        element("exact", "button", { name: "Save" }),
      ]),
      parseIntent("click save"),
    )

    expect(result).toMatchObject({
      ref: "exact",
      source: "L0",
      confidence: 1,
    })
  })

  test("candidates separated by only the 0.08 viewport penalty escalate", () => {
    // The 8% gap is inside the advertised 0.10 ambiguity band. Picking the
    // on-screen duplicate would be a false positive; the model must see both.
    const result = deterministicResolve(
      snapshot([
        element("onscreen", "button", { name: "Submit" }),
        element("offscreen", "button", {
          name: "Submit",
          bbox: [-10, 10, 120, 32],
        }),
      ]),
      parseIntent("click submit"),
    )

    expect(result.source).toBe("escalate")
    expect(result.ref).toBe("")
    expect(result.confidence).toBe(0)
    expect(result.candidates?.map(({ ref }) => ref).sort()).toEqual([
      "offscreen",
      "onscreen",
    ])
  })

  test("the implemented 0.15 clear-winner gap keeps a 0.126 gap ambiguous", () => {
    // This pins the implementation's `>= 0.15` rule independently of the
    // header's narrower 0.10 wording, so either side changing cannot be silent.
    const result = deterministicResolve(
      snapshot([
        element("primary", "button", { name: "Continue" }),
        element("iframe-offscreen", "button", {
          name: "Continue",
          bbox: [-10, 10, 120, 32],
          isInIframe: true,
        }),
      ]),
      parseIntent("click continue"),
    )

    expect(result.source).toBe("escalate")
    expect(result.candidates).toHaveLength(2)
  })

  test("empty snapshots escalate with an actionable empty shortlist", () => {
    const result = deterministicResolve(snapshot([]), parseIntent("click Save"))

    expect(result).toEqual({
      ref: "",
      action: "click",
      confidence: 0,
      source: "escalate",
      reason: "no candidates from any cascade layer",
      candidates: [],
    })
  })

  test("a populated snapshot with no matching candidate also escalates cleanly", () => {
    const result = deterministicResolve(
      snapshot([element("cancel", "button", { name: "Cancel" })]),
      parseIntent("click Save"),
    )

    expect(result.source).toBe("escalate")
    expect(result.reason).toBe("no candidates from any cascade layer")
    expect(result.candidates).toEqual([])
  })

  test("explicit values override parsed tails and preserve input action inference", () => {
    const result = deterministicResolve(
      snapshot([element("email", "textbox", { name: "Email" })]),
      parseIntent("type email with parsed@example.com"),
      "explicit@example.com",
    )

    expect(result).toMatchObject({
      ref: "email",
      action: "type",
      value: "explicit@example.com",
      source: "L0",
    })
  })
})
