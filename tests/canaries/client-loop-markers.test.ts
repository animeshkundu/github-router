import { describe, expect, test } from "bun:test"

import { CLIENT_REDUNDANCY_MARKERS } from "../../src/lib/tool-loop-guard"
import {
  bundleContainsAny,
  bundleForms,
  installedClaudeBundle,
} from "./installed-claude"

/**
 * Drift canary for the loop guard's Tier A signal.
 *
 * Tier A recognizes tool results in which the CLIENT declares a call
 * redundant — the strongest loop evidence available, because the client has
 * already adjudicated it. The cost of that precision is a coupling to strings
 * the client owns and can reword in any release, and the failure mode is the
 * bad one: Tier A would silently stop matching and nobody would learn until the
 * next runaway burned another 4,000 calls.
 *
 * So this asserts the markers still exist in the installed client. It SKIPS
 * where no client is installed (CI, a fresh container) rather than failing,
 * because absence there proves nothing — the check is meaningful exactly on the
 * machines that actually run the client.
 *
 * On failure: re-derive the marker from a real transcript (under
 * `~/.claude/projects/<slug>/subagents/`, look at `tool_result` contents)
 * and update `CLIENT_REDUNDANCY_MARKERS`. Tier B still bounds the loop in the
 * meantime, so this is a degradation, not an outage.
 */

describe("client loop-marker canary", () => {
  const bundle = installedClaudeBundle()

  test("the marker set is non-empty and exactly specified", () => {
    // Guards against someone emptying the set and quietly disabling Tier A.
    expect(CLIENT_REDUNDANCY_MARKERS.size).toBeGreaterThan(0)
    for (const marker of CLIENT_REDUNDANCY_MARKERS) {
      expect(marker.trim()).toBe(marker)
      expect(marker.length).toBeGreaterThan(20)
    }
  })

  test("every marker still appears in the installed Claude Code build", async () => {
    if (!bundle) {
      console.log(
        "[canary] no Claude Code install found — skipping marker check",
      )
      return
    }
    for (const marker of CLIENT_REDUNDANCY_MARKERS) {
      const present = await bundleContainsAny(bundle, bundleForms(marker))
      if (!present) {
        throw new Error(
          `Tier A loop marker no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(marker)}\n`
            + "The client reworded it; Tier A is now inert for this case. "
            + "Re-derive it from a real transcript and update "
            + "CLIENT_REDUNDANCY_MARKERS in src/lib/tool-loop-guard.ts.",
        )
      }
      expect(present).toBe(true)
    }
  }, 60_000)
})
