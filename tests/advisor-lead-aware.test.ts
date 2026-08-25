import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import {
  FAST_LEAD_MODEL,
  isBudgetClaudeLead,
  resolveLeadSlugArg,
} from "../src/lib/port"
import {
  ADVISOR_DEFAULT_EFFORT,
  ADVISOR_DEFAULT_MODEL,
  ADVISOR_ESCALATION_MODEL,
  ADVISOR_FAST_PROFILE_MODEL,
  FAST_PROFILE_LEAD_MODEL,
  advisorTransport,
  advisorUsesResponses,
  isFastProfileLead,
  resolveAdvisorEffort,
  resolveAdvisorModel,
} from "../src/services/advisor/advisor"

/**
 * Lead-aware advisor selection.
 *
 * Two independent axes, tested independently because they fail independently:
 * WHICH model advises (lead-dependent) and HOW HARD it thinks (picker-dependent
 * on every lead).
 *
 * Every catalog read is stubbed. A branch that depended on the live catalog
 * carrying `claude-opus-5` would be a flake vector, and this repo does not
 * tolerate one.
 */

let savedModels: typeof state.models
let savedEnv: string | undefined

/** Effort ladders differ per model, which is the whole reason the clamp runs
 *  against the RESOLVED ADVISOR rather than the lead. These mirror the live
 *  catalog as read when the escalation was added; they are stubs regardless,
 *  so the assertions below never depend on what upstream ships today. */
const OPUS_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const SOL_EFFORTS = ["none", "low", "medium", "high", "xhigh"]
/** Gemini 3.7 Flash's advertised ladder per the plan: "low..high", no xhigh/max/none. */
const GEMINI_EFFORTS = ["low", "medium", "high"]

function model(
  id: string,
  vendor: string,
  efforts: Array<string> | undefined,
  extra: Record<string, unknown> = {},
  supportedEndpoints?: Array<string>,
) {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor,
    version: "1",
    model_picker_enabled: true,
    ...(supportedEndpoints ? { supported_endpoints: supportedEndpoints } : {}),
    capabilities: {
      family: id,
      limits: { max_prompt_tokens: 900_000 },
      object: "model",
      supports: { ...(efforts ? { reasoning_effort: efforts } : {}), ...extra },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function setCatalog(...entries: Array<ReturnType<typeof model>>) {
  state.models = {
    object: "list",
    data: entries as unknown as NonNullable<typeof state.models>["data"],
  }
}

/** The ordinary enterprise catalog: both advisor candidates present.
 *  `supported_endpoints` mirror the live catalog exactly — opus-5 really does
 *  advertise /v1/messages AND /chat/completions, which is why transport cannot
 *  be decided by `pickEndpoint`. */
function fullCatalog() {
  setCatalog(
    model(
      ADVISOR_ESCALATION_MODEL,
      "anthropic",
      OPUS_EFFORTS,
      { adaptive_thinking: true },
      ["/v1/messages", "/chat/completions"],
    ),
    model("claude-sonnet-5", "anthropic", OPUS_EFFORTS, {}, [
      "/v1/messages",
      "/chat/completions",
    ]),
    model("claude-haiku-4.5", "anthropic", OPUS_EFFORTS),
    model(ADVISOR_DEFAULT_MODEL, "openai", SOL_EFFORTS, {}, ["/responses"]),
    model(FAST_PROFILE_LEAD_MODEL, "openai", SOL_EFFORTS, {}, ["/responses"]),
    model(ADVISOR_FAST_PROFILE_MODEL, "google", GEMINI_EFFORTS, {}, [
      "/chat/completions",
    ]),
  )
}

beforeEach(() => {
  savedModels = state.models
  savedEnv = process.env.GH_ROUTER_ADVISOR_MODEL
  delete process.env.GH_ROUTER_ADVISOR_MODEL
  fullCatalog()
})

afterEach(() => {
  state.models = savedModels
  if (savedEnv === undefined) delete process.env.GH_ROUTER_ADVISOR_MODEL
  else process.env.GH_ROUTER_ADVISOR_MODEL = savedEnv
})

describe("resolveAdvisorModel — opus lead must not move", () => {
  // Asserted against the literal constant rather than a computed value: the
  // point is that a future refactor introducing a frontier-model walk here
  // (which could yield gpt-5.5) fails this test instead of silently shipping.
  for (const lead of [
    "claude-opus-5",
    "claude-opus-5[1m]",
    "claude-opus-4.8",
    "claude-opus-4-8",
  ]) {
    test(`${lead} keeps the cross-lab default`, () => {
      expect(resolveAdvisorModel(lead)).toEqual({
        model: ADVISOR_DEFAULT_MODEL,
        escalated: false,
        fastProfile: false,
      })
    })
  }

  test("an absent lead keeps the default", () => {
    expect(resolveAdvisorModel(undefined)).toEqual({
      model: ADVISOR_DEFAULT_MODEL,
      escalated: false,
      fastProfile: false,
    })
  })
})

describe("resolveAdvisorModel — budget lead escalates", () => {
  for (const lead of [
    "claude-sonnet-5",
    "claude-sonnet-5[1m]",
    "claude-haiku-4.5",
    "claude-haiku-4-5",
  ]) {
    test(`${lead} escalates to the Anthropic frontier`, () => {
      expect(resolveAdvisorModel(lead)).toEqual({
        model: ADVISOR_ESCALATION_MODEL,
        escalated: true,
        fastProfile: false,
      })
    })
  }

  test("falls back to the default when the catalog has no opus-5", () => {
    setCatalog(
      model("claude-sonnet-5", "anthropic", OPUS_EFFORTS),
      model(ADVISOR_DEFAULT_MODEL, "openai", SOL_EFFORTS),
    )
    expect(resolveAdvisorModel("claude-sonnet-5")).toEqual({
      model: ADVISOR_DEFAULT_MODEL,
      escalated: false,
      fastProfile: false,
    })
  })

  test("a non-Claude lead is not a budget lead", () => {
    expect(resolveAdvisorModel("gpt-5.6-sol").escalated).toBe(false)
    expect(resolveAdvisorModel("gemini-3.1-pro-preview").escalated).toBe(false)
  })
})

describe("resolveAdvisorModel — operator pin", () => {
  test("wins on a budget lead", () => {
    process.env.GH_ROUTER_ADVISOR_MODEL = "gemini-3.1-pro-preview"
    expect(resolveAdvisorModel("claude-sonnet-5")).toEqual({
      model: "gemini-3.1-pro-preview",
      escalated: false,
      fastProfile: false,
    })
  })

  test("wins on an opus lead", () => {
    process.env.GH_ROUTER_ADVISOR_MODEL = "gemini-3.1-pro-preview"
    expect(resolveAdvisorModel("claude-opus-5").model).toBe(
      "gemini-3.1-pro-preview",
    )
  })

  test("pinning the escalation model is NOT an escalation", () => {
    // The system-prompt clause keys on `escalated`, so a pin that happens to
    // name opus on an opus lead must not inject "your caller is lighter".
    process.env.GH_ROUTER_ADVISOR_MODEL = ADVISOR_ESCALATION_MODEL
    expect(resolveAdvisorModel("claude-opus-5")).toEqual({
      model: ADVISOR_ESCALATION_MODEL,
      escalated: false,
      fastProfile: false,
    })
  })

  test("a whitespace-only pin is ignored", () => {
    process.env.GH_ROUTER_ADVISOR_MODEL = "   "
    expect(resolveAdvisorModel("claude-opus-5").model).toBe(
      ADVISOR_DEFAULT_MODEL,
    )
  })
})

describe("resolveAdvisorModel — fast Luna profile", () => {
  for (const lead of [
    FAST_PROFILE_LEAD_MODEL,
    `${FAST_PROFILE_LEAD_MODEL}[1m]`,
    `openai/${FAST_PROFILE_LEAD_MODEL}`,
  ]) {
    test(`${lead} picks the fast-profile Gemini advisor`, () => {
      expect(resolveAdvisorModel(lead, true)).toEqual({
        model: ADVISOR_FAST_PROFILE_MODEL,
        escalated: false,
        fastProfile: true,
      })
    })
  }

  test("falls back to the cross-lab default when the catalog has no Gemini 3.7 Flash", () => {
    setCatalog(
      model(FAST_PROFILE_LEAD_MODEL, "openai", SOL_EFFORTS, {}, ["/responses"]),
      model(ADVISOR_DEFAULT_MODEL, "openai", SOL_EFFORTS, {}, ["/responses"]),
    )
    expect(resolveAdvisorModel(FAST_PROFILE_LEAD_MODEL, true)).toEqual({
      model: ADVISOR_DEFAULT_MODEL,
      escalated: false,
      fastProfile: false,
    })
  })

  test("the operator pin still wins over the fast profile", () => {
    process.env.GH_ROUTER_ADVISOR_MODEL = ADVISOR_ESCALATION_MODEL
    expect(resolveAdvisorModel(FAST_PROFILE_LEAD_MODEL, true)).toEqual({
      model: ADVISOR_ESCALATION_MODEL,
      escalated: false,
      fastProfile: false,
    })
  })

  test("a standard (non-Luna) lead never reads as fast profile", () => {
    expect(resolveAdvisorModel("claude-opus-5").fastProfile).toBe(false)
    expect(resolveAdvisorModel("claude-sonnet-5").fastProfile).toBe(false)
    expect(resolveAdvisorModel("gpt-5.6-sol").fastProfile).toBe(false)
  })
})

describe("isFastProfileLead", () => {
  test("matches the bare id, the [1m] decoration, and a vendor-namespaced form", () => {
    expect(isFastProfileLead(FAST_PROFILE_LEAD_MODEL)).toBe(true)
    expect(isFastProfileLead(`${FAST_PROFILE_LEAD_MODEL}[1m]`)).toBe(true)
    expect(isFastProfileLead(`openai/${FAST_PROFILE_LEAD_MODEL}`)).toBe(true)
  })

  test("does not match a different lead, or an absent one", () => {
    expect(isFastProfileLead("gpt-5.6-sol")).toBe(false)
    expect(isFastProfileLead("claude-opus-5")).toBe(false)
    expect(isFastProfileLead(undefined)).toBe(false)
  })
})

describe("advisorTransport", () => {
  test("a Claude advisor model always uses messages, even though opus-5 also advertises chat", () => {
    expect(advisorTransport(ADVISOR_ESCALATION_MODEL)).toBe("messages")
  })

  test("a /responses-only advisor model uses responses", () => {
    expect(advisorTransport(ADVISOR_DEFAULT_MODEL)).toBe("responses")
  })

  test("a /chat/completions-only advisor model uses chat", () => {
    expect(advisorTransport(ADVISOR_FAST_PROFILE_MODEL)).toBe("chat")
  })
})

describe("resolveAdvisorEffort — precedence", () => {
  test("explicit output_config.effort wins over a thinking budget", () => {
    const body = JSON.stringify({
      output_config: { effort: "max" },
      thinking: { type: "enabled", budget_tokens: 1000 },
    })
    expect(resolveAdvisorEffort(body, ADVISOR_ESCALATION_MODEL)).toBe("max")
  })

  test("a thinking budget buckets when no explicit effort is present", () => {
    const body = JSON.stringify({
      thinking: { type: "enabled", budget_tokens: 30_000 },
    })
    expect(resolveAdvisorEffort(body, ADVISOR_ESCALATION_MODEL)).toBe("xhigh")
  })

  test("neither present keeps the historical default", () => {
    expect(resolveAdvisorEffort(JSON.stringify({}), ADVISOR_ESCALATION_MODEL))
      .toBe(ADVISOR_DEFAULT_EFFORT)
  })

  test("an unparseable body keeps the historical default", () => {
    expect(resolveAdvisorEffort("{not json", ADVISOR_ESCALATION_MODEL)).toBe(
      ADVISOR_DEFAULT_EFFORT,
    )
    expect(resolveAdvisorEffort(undefined, ADVISOR_ESCALATION_MODEL)).toBe(
      ADVISOR_DEFAULT_EFFORT,
    )
  })
})

describe("resolveAdvisorEffort — no floor (removed per the user-approved change)", () => {
  // The advisor now follows the picker all the way down as well as up — the
  // historical `high` floor is gone. The only remaining adjustment is the
  // CEILING clamp against the resolved advisor's own live ladder, so a value
  // the picker chose that the advisor doesn't support still lands on the
  // nearest one it does (see the "clamping" describe block below for that).
  for (const [picked, expected] of [
    // ADVISOR_ESCALATION_MODEL's stubbed ladder (OPUS_EFFORTS) has no "none",
    // so a "none" pick clamps to the nearest supported tier, "low" — this is
    // the CLAMP, not a floor, and the same clamp a picked "low"/"medium"
    // would receive if the ladder omitted it too.
    ["none", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const) {
    test(`picker ${picked} resolves to ${expected}`, () => {
      const body = JSON.stringify({ output_config: { effort: picked } })
      expect(resolveAdvisorEffort(body, ADVISOR_ESCALATION_MODEL)).toBe(expected)
    })
  }

  test("a low thinking budget is honored, not floored", () => {
    const body = JSON.stringify({
      thinking: { type: "enabled", budget_tokens: 500 },
    })
    expect(resolveAdvisorEffort(body, ADVISOR_ESCALATION_MODEL)).toBe("low")
  })

  test("a `none` pick is honored verbatim when the advisor's ladder supports it", () => {
    // ADVISOR_DEFAULT_MODEL's stubbed ladder (SOL_EFFORTS) DOES include
    // "none", so nothing clamps it away — this is the case the historical
    // floor used to override, and no longer does.
    const body = JSON.stringify({ output_config: { effort: "none" } })
    expect(resolveAdvisorEffort(body, ADVISOR_DEFAULT_MODEL)).toBe("none")
  })
})

describe("resolveAdvisorEffort — clamping against the ADVISOR's ladder", () => {
  test("a ladder without the picked tier clamps down", () => {
    // gpt-5.6-sol advertises no `max`, so a `max` pick must not be forwarded.
    const body = JSON.stringify({ output_config: { effort: "max" } })
    expect(resolveAdvisorEffort(body, ADVISOR_DEFAULT_MODEL)).toBe("xhigh")
    // ...while the escalation model does advertise it.
    expect(resolveAdvisorEffort(body, ADVISOR_ESCALATION_MODEL)).toBe("max")
  })

  test("a ceiling clamp lands on the nearest supported tier, direction-agnostic", () => {
    // No floor exists anymore, so this is a PURE clamp test: `tiny-model`'s
    // ladder omits "none" (the picked value) entirely, and the nearest
    // supported tier by EFFORT_ORDER distance is "low" (dist 1) over
    // "medium" (dist 2) — never a floor-then-clamp two-step.
    setCatalog(model("tiny-model", "openai", ["low", "medium"]))
    const body = JSON.stringify({ output_config: { effort: "none" } })
    expect(resolveAdvisorEffort(body, "tiny-model")).toBe("low")
  })

  test("an absent allowlist forwards unclamped", () => {
    setCatalog(model("no-ladder", "openai", undefined))
    const body = JSON.stringify({ output_config: { effort: "max" } })
    expect(resolveAdvisorEffort(body, "no-ladder")).toBe("max")
  })

  test("an empty allowlist forwards unclamped", () => {
    setCatalog(model("empty-ladder", "openai", []))
    const body = JSON.stringify({ output_config: { effort: "max" } })
    expect(resolveAdvisorEffort(body, "empty-ladder")).toBe("max")
  })

  test("a model absent from the catalog forwards unclamped", () => {
    const body = JSON.stringify({ output_config: { effort: "xhigh" } })
    expect(resolveAdvisorEffort(body, "not-in-catalog")).toBe("xhigh")
  })
})

// Regressions from cross-lab review of this change. Each of these was a real
// defect found by a reviewer, not a hypothetical.
describe("review regressions", () => {
  test("a namespaced operator pin is normalized to the catalog id AND routed to /responses", () => {
    // Found by SMOKE TEST, after two unit-test-only fixes had already "passed".
    // Choosing the transport correctly was not sufficient: `openai/gpt-5.6-sol`
    // still went upstream verbatim and Copilot answered 400 model_not_supported,
    // so the advisor degraded to its "[Advisor unavailable: ...]" fallback while
    // every assertion here stayed green. Assert BOTH halves.
    process.env.GH_ROUTER_ADVISOR_MODEL = "openai/gpt-5.6-sol"
    const choice = resolveAdvisorModel("claude-sonnet-5")
    expect(choice).toEqual({
      model: ADVISOR_DEFAULT_MODEL,
      escalated: false,
      fastProfile: false,
    })
    expect(advisorUsesResponses(choice.model)).toBe(true)
  })

  test("pin normalization only fires when the bare id is really in the catalog", () => {
    // An unknown pin passes through untouched — the catalog may not be loaded,
    // and inventing an id is worse than letting upstream reject it.
    process.env.GH_ROUTER_ADVISOR_MODEL = "somevendor/not-a-real-model"
    expect(resolveAdvisorModel("claude-sonnet-5").model).toBe(
      "somevendor/not-a-real-model",
    )
    // An exact catalog hit is never mangled, even if it contained a slash.
    process.env.GH_ROUTER_ADVISOR_MODEL = ADVISOR_ESCALATION_MODEL
    expect(resolveAdvisorModel("claude-sonnet-5").model).toBe(
      ADVISOR_ESCALATION_MODEL,
    )
  })

  test("transport selection across id shapes", () => {
    // Catalog-present ids route on what they SERVE, not on their name: opus-5
    // advertises /v1/messages + /chat/completions and must not be treated as a
    // Responses model, and a name-regex-only test would get sol right by luck.
    expect(advisorUsesResponses(ADVISOR_DEFAULT_MODEL)).toBe(true)
    expect(advisorUsesResponses(ADVISOR_ESCALATION_MODEL)).toBe(false)
    // Namespaced forms of both resolve the same way as their bare ids.
    expect(advisorUsesResponses(`openai/${ADVISOR_DEFAULT_MODEL}`)).toBe(true)
    expect(advisorUsesResponses(`anthropic/${ADVISOR_ESCALATION_MODEL}`)).toBe(
      false,
    )
    // An id in no catalog falls back to the name regex, on the bare segment.
    expect(advisorUsesResponses("gpt-9-unreleased")).toBe(true)
    expect(advisorUsesResponses("openai/gpt-9-unreleased")).toBe(true)
    expect(advisorUsesResponses("some-vendor/mystery-model")).toBe(false)
  })

  test("`-m` normalization: blank and padded arguments", () => {
    // codex_reviewer: `-m ""` used to return "" verbatim as a model id, and
    // `-m " fast "` missed the alias.
    expect(resolveLeadSlugArg("  fast  ")).toBe(FAST_LEAD_MODEL)
    expect(resolveLeadSlugArg("FAST")).toBe(FAST_LEAD_MODEL)
    expect(resolveLeadSlugArg("")).not.toBe("")
    expect(resolveLeadSlugArg("   ")).not.toBe("   ")
    expect(resolveLeadSlugArg("  claude-opus-5  ")).toBe("claude-opus-5")
  })

  test("isBudgetClaudeLead's contract: it takes a resolved slug, not a raw -m arg", () => {
    // "fast" itself is not a Claude slug, so it's false either way. Resolving
    // it now yields `gpt-5.6-luna` (the fast Luna profile, not a Sonnet
    // budget lead), which is ALSO not a Claude model — isBudgetClaudeLead
    // stays Claude-family-only and is unrelated to the fast profile.
    expect(isBudgetClaudeLead("fast")).toBe(false)
    expect(isBudgetClaudeLead(resolveLeadSlugArg("fast"))).toBe(false)
  })
})
