/**
 * Drift guard for `peer_review.critic`'s TypeBox literal-union.
 *
 * The worker_implement / worker_explore `peer_review` tool exposes a
 * discriminated union over critic names. We hardcode the union as a
 * TypeBox tuple in `src/lib/worker-agent/tools.ts`
 * (`PEER_CRITIC_TUPLE`, exposed publicly as `PEER_CRITIC_NAMES`) so
 * `Static<typeof PEER_REVIEW_PARAMS>` preserves a real `"codex_critic"
 * | "gemini_critic" | …` union rather than collapsing to `string`.
 *
 * The authoritative list of critics lives in
 * `src/lib/peer-mcp-personas.ts` as `PERSONAS_READ` (the same array
 * that drives the `/mcp` peer tools). If a critic is added to or
 * removed from `PERSONAS_READ` without updating `PEER_CRITIC_TUPLE`,
 * the model's enum will silently drift and `peer_review` will either
 * reject a valid critic or accept an unknown one.
 *
 * This test was previously a module-load runtime check
 * (`assertCriticsMatchPersonas()` called at the bottom of tools.ts) —
 * moved here because reading `PERSONAS_READ` at tools.ts module init
 * closed an import cycle (peer-mcp-personas → worker-agent/index →
 * engine → tools → peer-mcp-personas), forcing a dynamic
 * `await import("~/lib/worker-agent")` in peer-mcp-personas.ts to
 * break it. The cycle dissolves entirely once the assertion is a test.
 */

import { describe, expect, test } from "bun:test"

import { PERSONAS_READ } from "~/lib/peer-mcp-personas"
import { PEER_CRITIC_NAMES } from "~/lib/worker-agent/tools"

/**
 * The `peer_review` tool accepts ONLY critics + the line-level
 * reviewer — not every entry in `PERSONAS_READ` (e.g. `codex_implementer`
 * is a writer persona, not a reviewer). The filter below is the
 * canonical predicate; if a new reviewer persona is added it should
 * match the suffix or be added to the explicit allow-list here.
 */
function reviewerPersonaNames(): string[] {
  return PERSONAS_READ.filter(
    (p) =>
      p.toolNameHttp.endsWith("_critic") ||
      p.toolNameHttp === "codex_reviewer",
  )
    .map((p) => p.toolNameHttp)
    .sort()
}

describe("peer_review critic list drift", () => {
  test("PEER_CRITIC_NAMES matches the reviewer subset of PERSONAS_READ", () => {
    const literalNames = [...PEER_CRITIC_NAMES].sort()
    expect(literalNames).toEqual(reviewerPersonaNames())
  })

  test("every critic literal corresponds to a real persona", () => {
    const personaSet = new Set(PERSONAS_READ.map((p) => p.toolNameHttp))
    for (const name of PEER_CRITIC_NAMES) {
      expect(personaSet.has(name)).toBe(true)
    }
  })

  test("every reviewer persona has a corresponding critic literal", () => {
    const literalSet = new Set(PEER_CRITIC_NAMES)
    for (const name of reviewerPersonaNames()) {
      expect(literalSet.has(name)).toBe(true)
    }
  })
})
