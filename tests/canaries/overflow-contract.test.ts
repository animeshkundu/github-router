import { describe, expect, test } from "bun:test"

import { buildCapabilityRejectedMessage } from "../../src/lib/error"
import { bundleContainsAny, installedClaudeBundle } from "./installed-claude"

/**
 * Drift canary for the two client-owned mechanisms the overflow fix rides on.
 *
 * 1. The GATEWAY CAPABILITY CONTRACT. Claude Code lets a proxy that replaces an
 *    upstream 400/413 body substitute a stable token, `capability_rejected:
 *    <class>`, for the wording it hid. The client matches the token exactly as
 *    it would the original wording, and the session self-heals instead of
 *    stranding. `src/lib/error.ts` emits `prompt_too_long` and
 *    `max_tokens_context_overflow` through that contract.
 *
 * 2. The COMPACTION-WINDOW ENV BOUNDS. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is
 *    parsed with `parseInt` (NOT the suffix-aware `/config` parser), floored to
 *    100,000 and capped at 1,000,000. Those two constants are what
 *    `deriveAutoCompactWindowTokens` clamps to, and the floor is why a value
 *    like "1m" is a bug rather than a no-op: it parses to 1, gets raised to
 *    100,000, and silently compacts a 1M session every ~52K tokens.
 *
 * Both failure modes are silent on our side, which is what makes a canary worth
 * its weight. It SKIPS where no client is installed (CI, a fresh container)
 * because absence there proves nothing.
 */

/** Stable marker strings that must still be present in the installed build. */
const REQUIRED_MARKERS: ReadonlyArray<{ needles: Array<string>; why: string }> = [
  {
    needles: ["capability_rejected: "],
    why: "the gateway capability-rejection token prefix our overflow envelope emits",
  },
  {
    needles: ["prompt is too long"],
    why: "the client's wording matcher, the second half of our belt-and-braces envelope",
  },
  {
    needles: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"],
    why: "the env var the derived compaction window is exported through",
  },
]

/**
 * Minified identifiers change between client builds even when the parser's
 * behavior does not. Keep each known contract as a coherent pair: one marker
 * proves the 100K/1M constants, the other proves those same bindings feed the
 * env parser and that its effective value is raised to the 100K floor.
 */
const AUTO_COMPACT_CONTRACTS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "ike=1e5,JNe=1e6",
    "cee(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,ike,JNe);if(A.status!==\"invalid\"){let x=Math.max(ike,A.effective)",
  ],
  [
    "QTe=1e5,ZUe=1e6",
    "Uee(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,QTe,ZUe);if(N.status!==\"invalid\"){let F=Math.max(QTe,N.effective)",
  ],
  [
    "JCe=1e5,ABe=1e6",
    "vte(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,JCe,ABe);if(N.status!==\"invalid\"){let F=Math.max(JCe,N.effective)",
  ],
]

describe("client overflow-contract canary", () => {
  const bundle = installedClaudeBundle()

  test("our envelope satisfies the client's documented token shape", () => {
    const message = buildCapabilityRejectedMessage(
      "prompt_too_long",
      "Your input exceeds the context window of this model.",
    )

    // The client boundary-checks the character after the class so a class
    // cannot be read as the prefix of a longer identifier.
    const token = "capability_rejected: prompt_too_long"
    const at = message.indexOf(token)
    expect(at).toBeGreaterThanOrEqual(0)
    const next = message[at + token.length]
    expect(next !== undefined && /[A-Za-z0-9_:.-]/.test(next)).toBe(false)

    // And the independent wording path, which is matched lowercased.
    expect(message.toLowerCase()).toContain("prompt is too long")
  })

  test("every relied-on marker still appears in the installed build", async () => {
    if (!bundle) {
      console.log(
        "[canary] no Claude Code install found — skipping overflow-contract check",
      )
      return
    }
    for (const { needles, why } of REQUIRED_MARKERS) {
      const present = await bundleContainsAny(bundle, needles)
      if (!present) {
        throw new Error(
          `Overflow-contract marker no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(needles)} (${why})\n`
            + "Re-derive it from the installed bundle and update "
            + "src/lib/error.ts / src/lib/grok-context.ts. Until then a long "
            + "session can strand on an unrecognised context overflow.",
        )
      }
      expect(present).toBe(true)
    }

    const parserContractPresent = await Promise.all(
      AUTO_COMPACT_CONTRACTS.map(async (markers) =>
        (await Promise.all(markers.map((marker) => bundleContainsAny(bundle, [marker]))))
          .every(Boolean)),
    ).then((matches) => matches.some(Boolean))
    if (!parserContractPresent) {
      throw new Error(
        `Auto-compact parser contract no longer appears in ${bundle}.\n`
          + "Expected one known binding set to preserve the 100,000 floor, "
          + "1,000,000 cap, env parser bounds, and Math.max floor.\n"
          + "Re-derive it from the installed bundle and update "
          + "src/lib/error.ts / src/lib/grok-context.ts. Until then a long "
          + "session can strand on an unrecognised context overflow.",
      )
    }
    expect(parserContractPresent).toBe(true)
  }, 120_000)
})
