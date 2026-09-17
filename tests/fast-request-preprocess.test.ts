import { describe, expect, test } from "bun:test"

import { preprocessFastRequest } from "../src/lib/fast-request-preprocess"
import {
  CHEAPEST_EXPLORE_ALIAS_ID,
  CHEAPEST_GENERAL_PURPOSE_ALIAS_ID,
  CHEAPEST_PLAN_ALIAS_ID,
  CHEAPEST_REVIEWER_ALIAS_ID,
  CHEAP_EXPLORE_ALIAS_ID,
  CHEAP_IMPLEMENTER_ALIAS_ID,
  CHEAP_PLAN_ALIAS_ID,
  CHEAP_REVIEWER_ALIAS_ID,
  FAST_CRITIC_ALIAS_ID,
  LUNA_IMPLEMENTER_ALIAS_ID,
} from "../src/lib/launch-profile"
import type { LaunchRegistryEntry } from "../src/lib/state"

const fastLaunch: LaunchRegistryEntry = {
  launchId: "fast",
  nonce: "n",
  secret: "s",
  profileId: "fast",
  allowedGroups: new Set(["peers", "search"]),
  allowedPersonas: new Set(["oracle"]),
  createdAt: 1,
}

const cheapLaunch: LaunchRegistryEntry = {
  ...fastLaunch,
  launchId: "cheap",
  profileId: "cheap",
}

const cheap1mLaunch: LaunchRegistryEntry = {
  ...fastLaunch,
  launchId: "cheap1m",
  profileId: "cheap1m",
}

const cheapestLaunch: LaunchRegistryEntry = {
  ...fastLaunch,
  launchId: "cheapest",
  profileId: "cheapest",
}

function body(model: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model, messages: [], ...extra })
}

describe("fast request preprocessing", () => {
  test("rejects private aliases outside an authenticated fast launch", () => {
    expect(preprocessFastRequest(body("gh-router-luna-scout-high[1m]"), undefined).rejectedAlias)
      .toBe("gh-router-luna-scout-high[1m]")
  })

  test("resolves role aliases; lead keeps explicit effort, subagents stay pinned", () => {
    const lead = preprocessFastRequest(
      body("gh-router-luna-scout-high[1m]", {
        output_config: { effort: "max" },
        thinking: { type: "enabled", budget_tokens: 99_999 },
      }),
      fastLaunch,
    )
    const leadParsed = JSON.parse(lead.body)
    expect(leadParsed.model).toBe("gpt-5.6-luna[1m]")
    expect(leadParsed.output_config.effort).toBe("max")
    expect(leadParsed.thinking).toEqual({ type: "adaptive" })
    const sub = JSON.parse(
      preprocessFastRequest(
        body("gh-router-luna-scout-high[1m]", {
          output_config: { effort: "max" },
          thinking: { type: "enabled", budget_tokens: 99_999 },
        }),
        fastLaunch,
        true,
      ).body,
    )
    expect(sub.model).toBe("gpt-5.6-luna[1m]")
    expect(sub.output_config.effort).toBe("high")
    expect(sub.thinking).toEqual({ type: "adaptive" })
  })

  test("rejects aliases for retired Fast roles even on an authenticated Fast launch", () => {
    for (const retired of [FAST_CRITIC_ALIAS_ID, LUNA_IMPLEMENTER_ALIAS_ID]) {
      const result = preprocessFastRequest(body(`${retired}[1m]`), fastLaunch)
      expect(result.retiredAlias).toBe(`${retired}[1m]`)
      expect(result.rejectedAlias).toBeUndefined()
      expect(result.modified).toBe(false)
    }
  })

  test("forces bare fast role models and rejects every other model", () => {
    for (const [model, effort] of [
      ["gpt-5.6-luna", "max"],
      ["gpt-5.6-sol[1m]", "high"],
      ["grok-4.6", "medium"],
      ["gemini-3.8-flash", "high"],
      ["claude-sonnet-5[1m]", "xhigh"],
      ["claude-opus-5[1m]", "high"],
    ] as const) {
      const parsed = JSON.parse(preprocessFastRequest(body(model), fastLaunch).body)
      expect(parsed.output_config.effort).toBe(effort)
    }
    expect(preprocessFastRequest(body("gpt-5.5"), fastLaunch).rejectedModel).toBe("gpt-5.5")
  })

  test("accepts repeated 1M suffixes on fixed fast model ids", () => {
    for (const [model, effort] of [
      ["gpt-5.6-luna[1m][1M]", "max"],
      ["gpt-5.6-sol[1m][1m]", "high"],
      ["gemini-3.8-flash[1m][1m]", "high"],
      ["claude-sonnet-5[1m][1m]", "xhigh"],
      ["claude-opus-5[1m][1m]", "high"],
    ] as const) {
      const result = preprocessFastRequest(body(model), fastLaunch)
      expect(result.rejectedModel).toBeUndefined()
      expect(JSON.parse(result.body).output_config.effort).toBe(effort)
    }
  })

  test("standard bare models remain byte-identical", () => {
    const raw = body("gpt-5.5", { output_config: { effort: "low" } })
    expect(preprocessFastRequest(raw, undefined)).toEqual({
      body: raw,
      originalModel: "gpt-5.5",
      modified: false,
    })
  })

  describe("cheap profile (shared fast effort mapping at 200K; reviewer is Luna/max, not Sonnet/xhigh)", () => {
    test("forces the same role efforts as fast", () => {
      for (const [model, effort] of [
        ["gpt-5.6-luna", "max"],
        ["gpt-5.6-sol", "high"],
        ["grok-4.6", "medium"],
        ["gemini-3.8-flash[1m]", "high"],
        ["claude-sonnet-5", "xhigh"],
        ["claude-opus-5", "high"],
      ] as const) {
        // Lead traffic without an explicit effort falls back to the fixed mapping.
        const parsed = JSON.parse(preprocessFastRequest(body(model), cheapLaunch).body)
        expect(parsed.output_config.effort).toBe(effort)
        // Subagent traffic always receives the fixed per-model effort.
        const sub = JSON.parse(
          preprocessFastRequest(body(model, { output_config: { effort: "low" } }), cheapLaunch, true).body,
        )
        expect(sub.output_config.effort).toBe(effort)
      }
    })

    test("strips [1m] to the 200K default on cheap lead and subagent traffic", () => {
      for (const model of ["gemini-3.8-flash[1m]", "gpt-5.6-sol[1m]", "gpt-5.6-luna[1m]"] as const) {
        expect(JSON.parse(preprocessFastRequest(body(model), cheapLaunch).body).model).toBe(
          model.replace(/\[1m\]$/i, ""),
        )
        expect(
          JSON.parse(preprocessFastRequest(body(model), cheapLaunch, true).body).model,
        ).toBe(model.replace(/\[1m\]$/i, ""))
      }
    })

    test("cheap lead keeps an explicit picker effort; subagents stay pinned", () => {
      const lead = JSON.parse(
        preprocessFastRequest(
          body("gemini-3.8-flash[1m]", { output_config: { effort: "low" } }),
          cheapLaunch,
        ).body,
      )
      expect(lead.model).toBe("gemini-3.8-flash")
      expect(lead.output_config.effort).toBe("low")
      const sub = JSON.parse(
        preprocessFastRequest(
          body("gemini-3.8-flash", { output_config: { effort: "low" } }),
          cheapLaunch,
          true,
        ).body,
      )
      expect(sub.output_config.effort).toBe("high")
    })

    test("accepts private role aliases on an authenticated cheap launch", () => {
      // Lead: alias canonicalizes to the bare real model and keeps the
      // caller's explicit effort.
      const lead = preprocessFastRequest(
        body("gh-router-luna-scout-high[1m]", { output_config: { effort: "max" } }),
        cheapLaunch,
      )
      expect(lead.rejectedAlias).toBeUndefined()
      const leadParsed = JSON.parse(lead.body)
      expect(leadParsed.model).toBe("gpt-5.6-luna")
      expect(leadParsed.output_config.effort).toBe("max")
      // Subagent: same alias resolves bare with its fixed absent-effort default.
      const sub = preprocessFastRequest(
        body("gh-router-luna-scout-high[1m]", { output_config: { effort: "max" } }),
        cheapLaunch,
        true,
      )
      expect(sub.rejectedAlias).toBeUndefined()
      const subParsed = JSON.parse(sub.body)
      expect(subParsed.model).toBe("gpt-5.6-luna")
      expect(subParsed.output_config.effort).toBe("high")
    })

    test("rejects aliases and models outside the fixed cheap set", () => {
      expect(preprocessFastRequest(body("gh-router-luna-scout-high[1m]"), undefined).rejectedAlias)
        .toBe("gh-router-luna-scout-high[1m]")
      expect(preprocessFastRequest(body(CHEAP_PLAN_ALIAS_ID), undefined).rejectedAlias)
        .toBe(CHEAP_PLAN_ALIAS_ID)
      expect(preprocessFastRequest(body("gpt-5.5"), cheapLaunch).rejectedModel).toBe("gpt-5.5")
      expect(preprocessFastRequest(body("claude-opus-4-7"), cheapLaunch).rejectedModel).toBe("claude-opus-4-7")
    })

    test("cheap role aliases canonicalize bare with alias effort on subagents", () => {
      // Subagent traffic always takes the alias default, even over an
      // explicit effort — and a client-added [1m] is stripped after
      // canonicalization, so the wire id is the bare real model.
      for (const [alias, real, effort] of [
        [CHEAP_EXPLORE_ALIAS_ID, "gpt-5.6-luna", "high"],
        [CHEAP_PLAN_ALIAS_ID, "gpt-5.6-sol", "high"],
        [CHEAP_IMPLEMENTER_ALIAS_ID, "gemini-3.8-flash", "max"],
        [CHEAP_REVIEWER_ALIAS_ID, "gpt-5.6-luna", "max"],
      ] as const) {
        for (const wire of [alias, `${alias}[1m]`]) {
          const sub = preprocessFastRequest(
            body(wire, { output_config: { effort: "low" } }),
            cheapLaunch,
            true,
          )
          expect(sub.rejectedAlias).toBeUndefined()
          const parsed = JSON.parse(sub.body)
          expect(parsed.model).toBe(real)
          expect(parsed.output_config.effort).toBe(effort)
        }
      }
      // Lead keeps an explicit effort; the id still canonicalizes bare.
      const lead = JSON.parse(
        preprocessFastRequest(
          body(CHEAP_PLAN_ALIAS_ID, { output_config: { effort: "low" } }),
          cheapLaunch,
        ).body,
      )
      expect(lead.model).toBe("gpt-5.6-sol")
      expect(lead.output_config.effort).toBe("low")
    })

    test("still rejects retired fast role aliases", () => {
      for (const retired of [FAST_CRITIC_ALIAS_ID, LUNA_IMPLEMENTER_ALIAS_ID]) {
        const result = preprocessFastRequest(body(`${retired}[1m]`), cheapLaunch)
        expect(result.retiredAlias).toBe(`${retired}[1m]`)
        expect(result.rejectedAlias).toBeUndefined()
        expect(result.modified).toBe(false)
      }
    })

    test("cheap1m keeps 1M on the lead, strips subagents, and isolates effort", () => {
      for (const [model, effort] of [
        ["gpt-5.6-luna", "max"],
        ["grok-4.6", "medium"],
        ["gemini-3.8-flash[1m]", "high"],
        ["claude-sonnet-5", "xhigh"],
      ] as const) {
        const parsed = JSON.parse(preprocessFastRequest(body(model), cheap1mLaunch).body)
        expect(parsed.output_config.effort).toBe(effort)
      }
      // Lead bracket preserved (1M lead by design).
      expect(
        JSON.parse(preprocessFastRequest(body("gemini-3.8-flash[1m]"), cheap1mLaunch).body).model,
      ).toBe("gemini-3.8-flash[1m]")
      // Subagent bracket stripped (200K subagents).
      expect(
        JSON.parse(preprocessFastRequest(body("gemini-3.8-flash[1m]"), cheap1mLaunch, true).body).model,
      ).toBe("gemini-3.8-flash")
      // Lead keeps explicit effort; subagent stays pinned.
      expect(
        JSON.parse(
          preprocessFastRequest(
            body("gemini-3.8-flash[1m]", { output_config: { effort: "low" } }),
            cheap1mLaunch,
          ).body,
        ).output_config.effort,
      ).toBe("low")
      expect(
        JSON.parse(
          preprocessFastRequest(
            body("gemini-3.8-flash[1m]", { output_config: { effort: "low" } }),
            cheap1mLaunch,
            true,
          ).body,
        ).output_config.effort,
      ).toBe("high")
      // Role aliases resolve on cheap1m with the lead/subagent effort split.
      const lead = preprocessFastRequest(
        body("gh-router-luna-scout-high[1m]", { output_config: { effort: "max" } }),
        cheap1mLaunch,
      )
      expect(lead.rejectedAlias).toBeUndefined()
      expect(JSON.parse(lead.body).model).toBe("gpt-5.6-luna[1m]")
      expect(JSON.parse(lead.body).output_config.effort).toBe("max")
      const sub = preprocessFastRequest(
        body("gh-router-luna-scout-high[1m]", { output_config: { effort: "max" } }),
        cheap1mLaunch,
        true,
      )
      expect(sub.rejectedAlias).toBeUndefined()
      expect(JSON.parse(sub.body).model).toBe("gpt-5.6-luna")
      expect(JSON.parse(sub.body).output_config.effort).toBe("high")
      // And out-of-set models are refused identically.
      expect(preprocessFastRequest(body("gpt-5.5"), cheap1mLaunch).rejectedModel).toBe("gpt-5.5")
      expect(preprocessFastRequest(body("claude-opus-4-7"), cheap1mLaunch).rejectedModel).toBe("claude-opus-4-7")
    })
  })

  describe("cheapest profile (all-200K Luna lead; same isolation as cheap)", () => {
    test("strips [1m] and defaults lead effort from the fixed mapping", () => {
      const parsed = JSON.parse(preprocessFastRequest(body("gpt-5.6-luna[1m]"), cheapestLaunch).body)
      expect(parsed.model).toBe("gpt-5.6-luna")
      expect(parsed.output_config.effort).toBe("max")
    })

    test("cheapest lead keeps an explicit picker effort; subagents stay pinned", () => {
      const lead = JSON.parse(
        preprocessFastRequest(
          body("gpt-5.6-luna[1m]", { output_config: { effort: "low" } }),
          cheapestLaunch,
        ).body,
      )
      expect(lead.model).toBe("gpt-5.6-luna")
      expect(lead.output_config.effort).toBe("low")
      const sub = JSON.parse(
        preprocessFastRequest(
          body("gpt-5.6-sol", { output_config: { effort: "low" } }),
          cheapestLaunch,
          true,
        ).body,
      )
      expect(sub.model).toBe("gpt-5.6-sol")
      expect(sub.output_config.effort).toBe("high")
    })

    test("cheapest role aliases canonicalize bare with alias effort on subagents", () => {
      for (const [alias, real, effort] of [
        [CHEAPEST_EXPLORE_ALIAS_ID, "gpt-5.6-luna", "high"],
        [CHEAPEST_PLAN_ALIAS_ID, "gpt-5.6-sol", "high"],
        [CHEAPEST_GENERAL_PURPOSE_ALIAS_ID, "gpt-5.6-luna", "max"],
        [CHEAPEST_REVIEWER_ALIAS_ID, "gemini-3.8-flash", "high"],
      ] as const) {
        for (const wire of [alias, `${alias}[1m]`]) {
          const sub = preprocessFastRequest(
            body(wire, { output_config: { effort: "low" } }),
            cheapestLaunch,
            true,
          )
          expect(sub.rejectedAlias).toBeUndefined()
          const parsed = JSON.parse(sub.body)
          expect(parsed.model).toBe(real)
          expect(parsed.output_config.effort).toBe(effort)
        }
      }
    })
  })
})
