import { describe, expect, test } from "bun:test"

import { preprocessFastRequest } from "../src/lib/fast-request-preprocess"
import {
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

function body(model: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model, messages: [], ...extra })
}

describe("fast request preprocessing", () => {
  test("rejects private aliases outside an authenticated fast launch", () => {
    expect(preprocessFastRequest(body("gh-router-luna-scout-high[1m]"), undefined).rejectedAlias)
      .toBe("gh-router-luna-scout-high[1m]")
  })

  test("forces role model and effort for authenticated aliases", () => {
    const result = preprocessFastRequest(
      body("gh-router-luna-scout-high[1m]", {
        output_config: { effort: "max" },
        thinking: { type: "enabled", budget_tokens: 99_999 },
      }),
      fastLaunch,
    )
    const parsed = JSON.parse(result.body)
    expect(parsed.model).toBe("gpt-5.6-luna[1m]")
    expect(parsed.output_config.effort).toBe("high")
    expect(parsed.thinking).toEqual({ type: "adaptive" })
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
})
