// Prompt-surface guard for `-m cheaplocal`.
//
// `cheaplocal` is `cheapest` with one substitution: the Advisor and the Oracle
// answer from the local Anthropic-Messages endpoint instead of a Copilot model.
// The lead, the three natives, the 200K window, the efforts, the curated digest
// budget and the group set are the cheapest family's, unchanged. So this launch
// DOES know its own models and may name and price them, and knows nothing about
// the two consultants except the tier the profile itself declares for them:
// a 200K budget and `max` effort, both stated by the consult rather than
// discovered from the endpoint.
//
// That asymmetry is the point of this file: the scrub is sentence-scoped rather
// than surface-wide, because "Luna" is a true statement about the lead and a
// false one about the consultants. The controls at the bottom run the other
// direction, because deleting the model-named consultant prose from
// cheapest/cheapest2 would satisfy an absence check while making those
// profiles' own accurate sentences worse.

import { describe, expect, test } from "bun:test"

import {
  buildOperatingDefaultsDigest,
  buildOperatingDefaultsDirective,
  CHEAPEST_CONSULT_CONTRACT,
  CHEAPEST_CONSULT_CONTRACT_POINTER,
  CHEAPLOCAL_CONSULT_CONTRACT,
} from "~/lib/claude-md-injection"
import { buildPeerAgentDefinitions } from "~/lib/codex-mcp-config"
import {
  getPipelineSkills,
  injectedSkillsForLaunch,
} from "~/lib/injected-skills"
import {
  buildPeerAwarenessSnippet,
  buildPeerAwarenessSummary,
} from "~/lib/peer-mcp-personas"
import {
  CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPLOCAL_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPLOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
} from "~/services/advisor/advisor"

/** Availability as a realistic cheaplocal launch reports it. The profile is
 *  the cheapest group set, which includes `workers`, so the worker dispatcher
 *  prose is legitimately present; every standard-only native is not emitted. */
function availability(overrides: Record<string, unknown> = {}) {
  return {
    codexCli: false,
    geminiAvailable: false,
    workerToolsAvailable: true,
    standInAvailable: false,
    browseAvailable: false,
    browserToolsAvailable: false,
    compoundBrowseAvailable: false,
    scoutAvailable: false,
    implementerFastAvailable: false,
    reviewerFastAvailable: false,
    generalPurposeFastAvailable: false,
    artifactToolsAvailable: false,
    fleetAvailable: false,
    agentToolsAvailable: false,
    astraAvailable: false,
    semanticSearchAvailable: false,
    bluebirdEnabled: false,
    profile: "cheaplocal" as const,
    ...overrides,
  }
}

type SurfaceName = "directive" | "digest" | "snippet" | "summary"

const SURFACE_NAMES: ReadonlyArray<SurfaceName> = ["directive", "digest", "snippet", "summary"]

function text(overrides: Record<string, unknown> = {}): Record<SurfaceName, string> {
  const opts = availability(overrides)
  return {
    directive: buildOperatingDefaultsDirective({ ...opts, sweEnabled: true }),
    digest: buildOperatingDefaultsDigest({ profile: "cheaplocal", sweEnabled: true }),
    snippet: buildPeerAwarenessSnippet(opts),
    summary: buildPeerAwarenessSummary(opts),
  }
}

function joined(overrides: Record<string, unknown> = {}): string {
  const surfaces = text(overrides)
  return [surfaces.directive, surfaces.digest, surfaces.snippet, surfaces.summary].join("\n")
}

/** Sentences that talk about a consultant. Vocabulary elsewhere is not this
 *  file's business: the lead and the natives are Copilot models whose names,
 *  window and cost are facts this profile may state. */
function consultantSentences(surface: string): Array<string> {
  return surface
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /\b(?:advisor|oracle)\b/i.test(sentence))
}

/** The tier the profile itself declares for the two consultants: a 200K
 *  budget and `max` effort, both properties of the consult request rather than
 *  discoveries about the endpoint. The directive spells it out, the digest
 *  abbreviates it. */
const DECLARED_TIER_PHRASES = ["200K context, max effort", "200K/max"]

function declaresTier(sentence: string): boolean {
  return DECLARED_TIER_PHRASES.some((phrase) => sentence.includes(phrase))
}

describe("cheaplocal assumes nothing about the local consultants", () => {
  test("a consultant sentence carries no model, cost or freshness claim, and no tier beyond the declared one", () => {
    for (const surface of SURFACE_NAMES) {
      for (const sentence of consultantSentences(text()[surface])) {
        for (const pattern of [
          /\bSol\b/,
          /\bLuna\b/,
          /\bGemini\b/,
          /\bGrok\b/,
          /gpt-/i,
          /claude-/i,
          /\bopus\b/i,
          /\bmoney\b/i,
          /\bpric(?:e|ed|ing)\b/i,
          /\bcheaper\b/i,
          /\bstronger\b/i,
          /\bfrontier\b/i,
          /\bstale\b/i,
        ]) {
          expect(sentence).not.toMatch(pattern)
        }
        // The declared tier is the one window/effort mention a consultant
        // sentence may carry. Any other window or effort is a claim about an
        // endpoint the profile knows nothing about.
        if (!declaresTier(sentence)) {
          for (const pattern of [/\b200K\b/, /\b1M\b/, /\b(?:window|effort)\b/i]) {
            expect(sentence).not.toMatch(pattern)
          }
        }
      }
    }
  })

  test("no surface names a Copilot consultant model at all", () => {
    // Stronger than the sentence-scoped check above and deliberately so:
    // nothing else in a cheaplocal surface has any reason to name Sol. The
    // `gh-rebrief` skill does, but it names the real rewrite model, and skills
    // are checked separately.
    const all = joined()
    expect(all).not.toMatch(/\bSol\b/)
    expect(all).not.toMatch(/gpt-/i)
    expect(all).not.toMatch(/claude-/i)
    expect(all).not.toMatch(/\bopus\b/i)
    expect(all).not.toMatch(/\bGemini\b/)
    expect(all).not.toMatch(/\bGrok\b/)
  })

  test("the consultants are described by where they run, not by what runs them", () => {
    const surfaces = text()
    expect(surfaces.directive).toContain("`mcp__peers__oracle` is the local model (200K context, max effort)")
    expect(surfaces.snippet).toContain("`mcp__peers__oracle` is the local model")
    expect(surfaces.summary).toContain("`mcp__peers__oracle` is the local model")
    expect(surfaces.digest).toContain("(2) `advisor` (local model 200K/max, lead and `reviewer`, capped)")
    expect(surfaces.digest).toContain("(3) `oracle` (local model 200K/max, lead-only)")
    for (const surface of SURFACE_NAMES) {
      expect(surfaces[surface].toLowerCase()).toContain("local model")
    }
  })
})

describe("the consult contract is the cheapest one minus its consultant claims", () => {
  test("exactly three replacements separate the two contracts", () => {
    // Retyping the block would let the two transports drift. The round trip
    // below IS the pin: if a fourth difference is added to the constant, this
    // fails; if one of the three is dropped, the negative assertions below
    // fail.
    const roundTripped = CHEAPLOCAL_CONSULT_CONTRACT.replace(
      "the Advisor reads a curated view of this session",
      "Sol reads a curated view of this session",
    )
      .replace("each costs real time,", "each costs real time and money,")
      .replace(
        "a high-consequence risk or severity call",
        "a stale-knowledge / high-consequence risk or severity call",
      )
    expect(roundTripped).toBe(CHEAPEST_CONSULT_CONTRACT)

    expect(CHEAPLOCAL_CONSULT_CONTRACT).not.toContain("Sol")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).not.toContain("real time and money")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).not.toContain("stale-knowledge")

    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("the Advisor reads a curated view of this session")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("each costs real time, so spend them only")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("a high-consequence risk or severity call")
    // The budget count, the anchors, the disqualifiers and the discriminator
    // are about the WORK, so they stay verbatim.
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("you have roughly 8-10 advisor calls")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("a pre-commit framing check")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("Do NOT spend one on routine progress")
    expect(CHEAPLOCAL_CONSULT_CONTRACT).toContain("facts go to direct evidence")
  })

  test("the directive carries the local contract and not the Copilot one", () => {
    const directive = text().directive
    expect(directive).toContain(CHEAPLOCAL_CONSULT_CONTRACT)
    expect(directive).not.toContain(CHEAPEST_CONSULT_CONTRACT)
  })

  test("the digest keeps the model-free pointer", () => {
    expect(text().digest).toContain(CHEAPEST_CONSULT_CONTRACT_POINTER)
  })
})

describe("the lead and natives are described as the models they are", () => {
  test("the window note is scoped to the roles that run on Copilot", () => {
    const surfaces = text()
    for (const surface of SURFACE_NAMES) {
      expect(surfaces[surface]).toContain("The lead and every native subagent run at a 200K context window")
      // The unscoped form asserts a window for the consultants, which this
      // profile cannot know.
      expect(surfaces[surface]).not.toContain("All roles run at a 200K context window")
    }
  })

  test("the roster that is emitted is named", () => {
    const all = joined()
    for (const name of ["`Explore`", "`General-Purpose`", "`reviewer`"]) {
      expect(all).toContain(name)
    }
    // The cheapest family DOES inject the workers group, so the dispatcher
    // contrast is a true statement here; only the local family drops it.
    expect(text().directive).toContain("never worker-*")
  })

  test("names no agent the cheaplocal roster does not emit", () => {
    const all = joined()
    for (const name of [
      "`Plan`",
      "`scout`",
      "`implementer`",
      "`implementer-fast`",
      "`reviewer-fast`",
      "`general-purpose-fast`",
      "`brainstorm`",
      "`scribe`",
      "`stand_in`",
      "peer-review-coordinator",
    ]) {
      expect(all).not.toContain(name)
    }
  })

  test("no stale `code_search` tool name", () => {
    expect(joined()).not.toContain("`code_search`")
  })
})

describe("search guidance matches the launch's backend", () => {
  test("lexical-only launches describe lexical search and never name ColBERT", () => {
    const surfaces = text()
    expect(surfaces.directive).toContain("LOCAL LEXICAL `code` search")
    expect(surfaces.directive).not.toContain("ColBERT")
    expect(surfaces.snippet).toContain("local lexical")
    expect(surfaces.snippet).not.toContain("ColBERT")
    expect(surfaces.summary).toContain("local lexical")
    expect(surfaces.summary).not.toContain("ColBERT")
  })

  test("semantic launches keep both rungs of the cheapest-first ladder", () => {
    // The lead runs on Copilot, so the directive keeps the non-local labels:
    // lexical is the documented first step and semantic the second. Only a
    // local-family launch, whose main loop cannot reach ColBERT, drops the
    // numbered ladder.
    const surfaces = text({ semanticSearchAvailable: true })
    expect(surfaces.directive).toContain("(1) LOCAL LEXICAL `code` search")
    expect(surfaces.directive).toContain("(2) local ColBERT SEMANTIC `code` search")
    expect(surfaces.snippet).toContain("local ColBERT")
    expect(surfaces.snippet).toContain("start lexical")
    expect(surfaces.summary).toContain("local ColBERT")
  })
})

describe("the reviewer's protege grant names a consultant without describing one", () => {
  const BASE = {
    codexCli: false,
    geminiAvailable: false,
    groupKeys: { peers: "peers", search: "search", workers: "workers" },
    nonce: "n".repeat(64),
    codexHome: "/tmp/codex",
  }

  function reviewer(overrides: Record<string, unknown> = {}) {
    return buildPeerAgentDefinitions({
      ...BASE,
      cheapestProfile: true,
      cheaplocalProfile: true,
      ...overrides,
    } as never)["reviewer"]!
  }

  test("the cheaplocal reviewer is backed by an unnamed model on the local endpoint", () => {
    const agent = reviewer()
    expect(agent.prompt).toContain(
      "You have an `advisor` tool backed by a model on your local endpoint that sees the ask, the brief you write, and a bounded transcript.",
    )
    expect(agent.prompt).not.toMatch(/\bSol\b/)
    expect(agent.prompt).not.toContain("stronger cross-lab")
    expect(agent.prompt).not.toContain("Copilot-served")
    expect(agent.description).toContain("May consult its advisor (at most 5 advisor rounds per review)")
    expect(agent.description).not.toContain("Sol advisor")
    // The behavioural contract is shared with the other transports, so the
    // budget and the verdict ownership must survive the scrub.
    expect(agent.prompt).toContain("at most 5 advisor rounds per review")
    expect(agent.prompt).toContain("You own the verdict; the advisor is counsel, never authority")
  })

  test("the Copilot-served cheapest reviewer keeps its named consultant", () => {
    const agent = reviewer({ cheaplocalProfile: false })
    expect(agent.prompt).toContain("backed by Sol, a stronger cross-lab model")
    expect(agent.description).toContain("Sol advisor")
  })

  test("emits exactly the three cheaplocal natives", () => {
    const agents = buildPeerAgentDefinitions({
      ...BASE,
      cheapestProfile: true,
      cheaplocalProfile: true,
    } as never)
    expect(Object.keys(agents).sort()).toEqual(["Explore", "General-Purpose", "reviewer"])
  })
})

describe("advisor tool descriptions follow the consultant", () => {
  test("the cheaplocal variants name the local model and claim nothing more", () => {
    for (const description of [
      CHEAPLOCAL_ADVISOR_TOOL_INSTRUCTIONS,
      CHEAPLOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
    ]) {
      expect(description).toContain("the local model")
      expect(description).not.toMatch(/\bSol\b/)
      expect(description).not.toContain("stronger")
      expect(description).not.toContain("Copilot-served")
      // The caller-facing half of the redaction contract. This is the surface
      // that reaches whoever writes the brief, so a consult that left Copilot
      // for the operator's endpoint must carry it; the corresponding
      // consultant-side note is pinned on the system prompts.
      expect(description).toContain(
        "Replace every credential, token, key, password",
      )
      expect(description).toContain("placeholder")
    }
    expect(CHEAPLOCAL_ADVISOR_TOOL_INSTRUCTIONS).toContain(
      "which sees a curated view of this session",
    )
    expect(CHEAPLOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS).toContain(
      "which sees the brief you write plus a bounded transcript",
    )
  })

  test("the cheapest variants keep their cross-model comparison", () => {
    // The other direction: those launches can observe both models, so the
    // comparison is accurate there and must not be scrubbed away globally.
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("a stronger model across the same session")
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("Sol")
    expect(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS).toContain("a stronger cross-lab model")
    expect(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS).toContain("Sol")
  })
})

describe("cheaplocal pipeline skills describe the roster it emits", () => {
  function skills() {
    return injectedSkillsForLaunch({
      profileId: "cheaplocal",
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    })
  }

  test("injects the cheapest five, including the rebrief escape hatch", () => {
    expect(skills().map((skill) => skill.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
      "gh-rebrief",
    ])
  })

  test("names no absent agent and no stale planning dispatch", () => {
    const md = skills().map((skill) => skill.md).join("\n")
    expect(md).toContain("Explore, General-Purpose, reviewer")
    expect(md).not.toContain("implementer")
    expect(md).not.toContain("`Plan`")
    expect(md).not.toContain("subagent_type Plan")
    expect(md).not.toContain("Plan subagent")
    expect(md).not.toContain("Plan dispatch")
  })

  test("the Luna and Sol mentions are about the roles that really run them", () => {
    // The lead and its natives ARE Luna on this profile, so the gather skill's
    // cost framing is accurate. The rebrief skill's Sol is the real rewrite
    // model (`cheapestRewriteModelFor("cheaplocal")`), not a consultant, so it
    // is a true statement this launch may make.
    const gather = getPipelineSkills(false, false, "cheaplocal")[0]
    expect(gather?.md).toContain("Luna")
    expect(gather?.md).toContain("6x")
    const md = skills().map((skill) => skill.md).join("\n")
    expect(md).toContain("Sol grounds the original ask")
  })
})

describe("non-cheaplocal profiles keep their own consultant wording", () => {
  test("cheapest still names and prices Sol in the contract", () => {
    const directive = buildOperatingDefaultsDirective({ profile: "cheapest" })
    expect(directive).toContain("Sol reads a curated view of this session")
    expect(directive).toContain("each costs real time and money")
    expect(directive).toContain("a stale-knowledge / high-consequence risk or severity call")
    expect(directive).toContain("GPT-5.6 Sol (200K/high)")
    expect(directive).toContain("All roles run at a 200K context window")
  })

  test("cheapest2 still names its upgraded consultant", () => {
    const snippet = buildPeerAwarenessSnippet({
      ...availability(),
      profile: "cheapest2",
    } as never)
    const summary = buildPeerAwarenessSummary({
      ...availability(),
      profile: "cheapest2",
    } as never)
    expect(snippet).toContain("GPT-6.1 Sol (200K/high)")
    expect(summary).toContain("GPT-6.1 Sol (200K/high)")
    expect(buildOperatingDefaultsDigest({ profile: "cheapest2", sweEnabled: false })).toContain(
      "`advisor` (GPT-6.1 Sol/high, lead and `reviewer`, capped)",
    )
  })

  test("local2 keeps its consultants on Copilot", () => {
    const snippet = buildPeerAwarenessSnippet({
      ...availability({ workerToolsAvailable: false }),
      profile: "local2",
    } as never)
    expect(snippet).toContain("GPT-6.1 Sol (200K/high)")
  })
})
