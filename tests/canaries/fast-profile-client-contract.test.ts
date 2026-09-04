import { describe, expect, test } from "bun:test"

import { bundleContainsAny, installedClaudeBundle } from "./installed-claude"

/**
 * Drift canary for the client-owned seams used by the fixed fast profile.
 * It skips where no Claude Code install exists, matching the other canaries.
 *
 * 2.1.260 reworded the Agent-spawn rewrite comment. Through 2.1.258 the
 * checkArgument explanation was "the Agent tool decided it; a rewrite
 * changes model alone". 2.1.260 still admits a string model on agent.spawn
 * via check:_((e)=>ut(e,"{ model }",(t)=>typeof t.model==="string")) while
 * pinning identity fields, so a PreToolUse hook may still return
 * updatedInput that changes model alone.
 */
const REQUIRED_MARKERS = [
  "--advisor <model>",
  "advisorModel",
  'type:"advisor_20260301",name:"advisor",model:',
  "Advising",
  " using ",
  "updatedInput",
  'check:_((e)=>ut(e,"{ model }",(t)=>typeof t.model==="string"))',
  'agentType:"Explore"',
  "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP",
] as const

describe("fast-profile client contract canary", () => {
  const bundle = installedClaudeBundle()

  test("installed client still exposes Advisor identity, input rewriting, and Explore seams", async () => {
    if (!bundle) {
      console.log("[canary] no Claude Code install found — skipping fast-profile contract")
      return
    }
    for (const marker of REQUIRED_MARKERS) {
      const present = await bundleContainsAny(bundle, [marker])
      if (!present) {
        throw new Error(
          `Fast-profile client marker no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(marker)}\n`
            + "Re-derive Advisor/PreToolUse/Explore behavior before changing the fixed profile.",
        )
      }
      expect(present).toBe(true)
    }
  }, 180_000)
})
