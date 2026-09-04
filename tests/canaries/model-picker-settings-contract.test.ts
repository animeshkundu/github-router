import { describe, expect, test } from "bun:test"

import { bundleContainsAny, installedClaudeBundle } from "./installed-claude"

/**
 * Drift canary for the supported settings surface used to add the router's
 * profile-specific rows to `/model`.
 *
 * Claude Code 2.1.260 refreshes gateway discovery even when nonessential
 * traffic is disabled, filters the response to Claude/Anthropic ids, and
 * replaces its cache. `modelPicker.options` is therefore the durable source
 * for non-Claude rows. This skips where no client is installed, matching the
 * other installed-client canaries.
 */
const REQUIRED_MARKERS = [
  "modelPicker",
  "replaceBuiltInOptions",
  "behavesAs",
  // This is the load-bearing admission rule, not just schema vocabulary: an
  // unknown Copilot id without behavesAs is silently absent from `/model`.
  "is not offered until Claude Code is updated",
] as const

describe("modelPicker settings contract canary", () => {
  const bundle = installedClaudeBundle()

  test("installed client still exposes curated additive picker settings", async () => {
    if (!bundle) {
      console.log("[canary] no Claude Code install found — skipping modelPicker contract")
      return
    }
    for (const marker of REQUIRED_MARKERS) {
      const present = await bundleContainsAny(bundle, [marker])
      if (!present) {
        throw new Error(
          `modelPicker client marker no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(marker)}\n`
            + "Re-derive the supported settings schema before changing picker injection.",
        )
      }
      expect(present).toBe(true)
    }
  }, 120_000)
})
