import { describe, expect, test } from "bun:test"

import {
  assembleStatusLine,
  buildCtxSegment,
  parseStatusInput,
} from "../../src/lib/default-statusline"
import { bundleContainsAny, installedClaudeBundle } from "./installed-claude"

/**
 * Drift canary for the status-line payload contract.
 *
 * The rich status line reads Claude Code's stdin JSON, and the ctx segment
 * depends on three field names inside `context_window` that the CLIENT owns:
 * `used_percentage` (the bar), `context_window_size` (the `·200K` / `·272K` /
 * `·1M` denominator), and the sibling token counters. The client may rename or
 * drop any of them in a release; our failure mode is silent — the bar keeps
 * rendering, it just quietly becomes `[----------] --%·--` for everyone, with
 * no error anywhere. That is exactly the class of drift a canary is for.
 *
 * These are object-literal PROPERTY KEYS, which minification does not mangle,
 * so the markers survive rebuilds; only a deliberate client-side rename moves
 * them. It SKIPS where no client is installed (CI, a fresh container) because
 * absence there proves nothing.
 */

/** Property keys the renderer parses out of the client's stdin payload. */
const REQUIRED_KEYS: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: "used_percentage",
    why: "the ctx bar's fill (renders `--%` without it)",
  },
  {
    key: "context_window_size",
    why: "the window suffix (renders `·--` without it)",
  },
  {
    key: "total_input_tokens",
    why: "the in/out segment's left half",
  },
  {
    key: "exceeds_200k_tokens",
    why: "the sibling field proving the context_window block is still built as one unit",
  },
]

describe("client statusline contract canary", () => {
  const bundle = installedClaudeBundle()

  test("every ctx field we parse still appears in the installed build", async () => {
    if (!bundle) {
      console.log(
        "[canary] no Claude Code install found — skipping statusline-contract check",
      )
      return
    }
    for (const { key, why } of REQUIRED_KEYS) {
      const present = await bundleContainsAny(bundle, [`${key}:`])
      if (!present) {
        throw new Error(
          `Status-line payload key no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(`${key}:`)} (${why})\n`
            + "Re-derive the payload shape from the installed bundle and update "
            + "src/lib/default-statusline.ts. Until then the ctx segment "
            + "degrades to placeholders with no error to notice.",
        )
      }
      expect(present).toBe(true)
    }
  }, 120_000)

  test("a payload missing the window degrades to a placeholder, never a wrong number", () => {
    // The canary's teeth: whatever the client does to the key, the renderer
    // must show `--` rather than guess a denominator.
    const in_ = parseStatusInput(
      JSON.stringify({ context_window: { used_percentage: 42 } }),
    )
    expect(in_.usedPct).toBe(42)
    expect(in_.windowSize).toBeUndefined()
    expect(buildCtxSegment(in_.usedPct, in_.windowSize).plain).toBe(
      "[####------] 42%·--",
    )
  })

  test("a renamed window key degrades the whole line without throwing", () => {
    const line = assembleStatusLine("[AIC 1.00]", {}, { width: 500 })
    expect(line).toContain("[AIC 1.00]")
  })
})
