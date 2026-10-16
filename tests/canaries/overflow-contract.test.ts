import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildCapabilityRejectedMessage } from "../../src/lib/error"
import {
  anyContractGroupMatches,
  bundleContainsAll,
  bundleContainsAny,
  installedClaudeBundle,
} from "./installed-claude"

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
    "EFe=1e5,vYe=1e6",
    "Ore(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,EFe,vYe);if(U.status!==\"invalid\"){let fe=Math.max(EFe,U.effective)",
  ],
  [
    "hPe=1e5,dze=1e6",
    "Bne(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,hPe,dze);if(N.status!==\"invalid\"){let F=Math.max(hPe,N.effective)",
  ],
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
  [
    "JCe=1e5,kBe=1e6",
    "kte(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,JCe,kBe);if(N.status!==\"invalid\"){let F=Math.max(JCe,N.effective)",
  ],
  [
    "NVe=1e5,_ot=1e6",
    "kPe(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,NVe,_ot);if(j.status!==\"invalid\"){let he=Math.max(NVe,j.effective)",
  ],
  // 2.1.301: the pair moved into the auto-compact settings module and the
  // parser call site was restructured to an early `if (process.env...)`
  // guard. The bounds are unchanged (floor 1e5, cap 1e6) and the floor is
  // still applied with Math.max, which is the property we depend on.
  [
    "GO=1e5,Q$=1e6",
    'oje("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,GO,Q$);if(y.status!=="invalid"){let S=Math.max(GO,y.effective)',
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

    const parserContractPresent = await anyContractGroupMatches(
      bundle,
      AUTO_COMPACT_CONTRACTS,
    )
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

describe("contract-group matching semantics", () => {
  test("a group requires EVERY marker, and groups are alternatives to each other", async () => {
    // Drives the same helpers the canary above uses against synthetic content,
    // so this runs on a machine with no client installed (CI) where that canary
    // skips. The failure it guards is silent by construction: evaluating a group
    // with `bundleContainsAny`'s ALTERNATIVES combinator would pass on today's
    // build and stop discriminating only once a marker disappears for real,
    // which is exactly when nobody is looking.
    const dir = mkdtempSync(path.join(os.tmpdir(), "gh-router-canary-"))
    const file = path.join(dir, "synthetic-bundle")
    const constants = "EFe=1e5,vYe=1e6"
    const callSite = "Math.max(EFe,U.effective)"
    try {
      writeFileSync(file, `${constants} and nothing else`)
      // Half a group is not a group. The constants alone are exactly the
      // identifiers-only match the pairing exists to reject.
      expect(await bundleContainsAll(file, [constants, callSite])).toBe(false)
      expect(await bundleContainsAll(file, [constants])).toBe(true)

      writeFileSync(file, `${constants} ... ${callSite}`)
      expect(await bundleContainsAll(file, [constants, callSite])).toBe(true)

      // Across groups the relation is OR: a developer on an older build must
      // keep passing on that build's group.
      const groups = [[constants, callSite], ["GO=1e5,Q$=1e6"]]
      expect(await anyContractGroupMatches(file, groups)).toBe(true)
      writeFileSync(file, `${constants} and nothing else`)
      expect(await anyContractGroupMatches(file, groups)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
