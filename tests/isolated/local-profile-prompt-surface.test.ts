// Prompt-surface guard for the `-m local` / `-m local2` launch profiles.
//
// A local launch knows three things: there is a local inference endpoint, it
// speaks Anthropic Messages, and the profile configures a 200K client window.
// It does not know which model family answers, how fast it is, or what it
// costs. So every injected surface (the mirrored CLAUDE.md directive, the
// `--append-system-prompt` digest, the peer-awareness snippet and summary,
// the `--swe` pipeline skills, and the advisor tool descriptions) may say
// "the local model" or "the local endpoint" and nothing else. It also may
// name only the agents and tools this mode actually emits.
//
// Each gate is checked in BOTH directions. Removing a true statement from
// cheapest/balanced (their models ARE known, so their cost framing is
// accurate) would be just as silent a regression as leaking a stack guess
// into local, and the gating lives in shared builders where an over-broad
// `isLocalFamily` condition would do exactly that.

import { describe, expect, test } from "bun:test"

import {
  buildOperatingDefaultsDigest,
  buildOperatingDefaultsDirective,
} from "~/lib/claude-md-injection"
import {
  buildPeerAwarenessSnippet,
  buildPeerAwarenessSummary,
} from "~/lib/peer-mcp-personas"
import {
  getPipelineSkills,
  injectedSkillsForLaunch,
} from "~/lib/injected-skills"
import { buildImplementSkill } from "~/lib/injected-skills/implement-skill"
import {
  CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
  LOCAL_ADVISOR_TOOL_INSTRUCTIONS,
  LOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
} from "~/services/advisor/advisor"

type LocalProfile = "local" | "local2"

const LOCAL_PROFILES: ReadonlyArray<LocalProfile> = ["local", "local2"]

/** Availability as a realistic local launch reports it. Both local profiles
 *  drop the `workers` group: a Pi worker answers on a Copilot model, and the
 *  point of these profiles is that no subagent does. So the worker surface,
 *  the Oracle peer on `local`, and every standard-only native are absent.
 *  `local`/`local2` enable exactly the cheapest groups, so anything not listed
 *  here is genuinely absent from the session. */
function availability(profile: LocalProfile, overrides: Record<string, unknown> = {}) {
  return {
    codexCli: false,
    geminiAvailable: false,
    workerToolsAvailable: false,
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
    profile,
    ...overrides,
  }
}

type SurfaceName = "directive" | "digest" | "snippet" | "summary"

function text(profile: LocalProfile, overrides: Record<string, unknown> = {}): Record<SurfaceName, string> {
  const opts = availability(profile, overrides)
  return {
    directive: buildOperatingDefaultsDirective({ ...opts, sweEnabled: true }),
    digest: buildOperatingDefaultsDigest({ profile, sweEnabled: true }),
    snippet: buildPeerAwarenessSnippet(opts),
    summary: buildPeerAwarenessSummary(opts),
  }
}

function joined(profile: LocalProfile, overrides: Record<string, unknown> = {}): string {
  const surfaces = text(profile, overrides)
  return [surfaces.directive, surfaces.digest, surfaces.snippet, surfaces.summary].join("\n")
}

const SURFACE_NAMES: ReadonlyArray<SurfaceName> = ["directive", "digest", "snippet", "summary"]

/** Word-boundary match: a plain `toContain("Sol")` would fire on "Solution",
 *  and a scrub assertion that can fail on an unrelated word is worse than no
 *  assertion at all. */
function word(name: string): RegExp {
  return new RegExp(`\\b${name}\\b`)
}

/** Blocks (blank-line separated paragraphs) that name `Sol` without also
 *  describing a Copilot-served peer. `local2`'s Oracle and Advisor really do
 *  run on Sol, so naming it beside them is a fact about that tool. A block
 *  that says "Sol" with no Oracle/Advisor in it is a claim about the local
 *  endpoint, which this profile cannot make. `local` has no Copilot-served
 *  surface at all, so it may not name Sol anywhere. */
function straySolBlocks(surface: string): Array<string> {
  return surface
    .split(/\n{2,}/)
    .filter((block) => /\bSol\b/.test(block) && !/oracle|advisor/i.test(block))
}

describe.each(LOCAL_PROFILES)("%s injects no claim about the endpoint", (profile) => {
  test("no cost, speed, or strength vocabulary reaches any surface", () => {
    const all = joined(profile)
    for (const phrase of [
      "fast, cost-efficient",
      "lowest cost",
      "expensive models",
      "cheapest-first",
      "cheapest first",
      "cheap breadth",
      "cheap broad",
      "cost several times",
      "a stronger",
      // Strength appositives inherited from cheapest. With three different tier
      // ids they read as a ranking across the ids, which only the server knows.
      "the heavy execution tier",
      "the heavy verification tier",
      "heavy execution to",
    ]) {
      expect(all).not.toContain(phrase)
    }
  })

  test("no Copilot model or serving-stack name reaches any surface", () => {
    const all = joined(profile)
    for (const name of ["Luna", "Gemini", "Grok", "GPT-OSS", "Qwen", "LM Studio", "Ollama", "llama.cpp", "vLLM"]) {
      expect(all).not.toMatch(word(name))
    }
    expect(all).not.toContain("6x")
    // `Sol` is allowed only where the text is describing the Copilot-served
    // Oracle or Advisor, never as a name for the lead or its subagents.
    for (const surface of SURFACE_NAMES) {
      expect(straySolBlocks(text(profile)[surface])).toEqual([])
    }
  })

  test("names no agent the local roster does not emit", () => {
    const all = joined(profile)
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

  test("names the roster it does emit", () => {
    const all = joined(profile)
    expect(all).toContain("`Explore`")
    expect(all).toContain("`General-Purpose`")
    expect(all).toContain("`reviewer`")
    expect(all).toContain("200K")
  })

  test("the Oracle is named only where the launch can reach it", () => {
    const surfaces = text(profile)
    if (profile === "local2") {
      expect(surfaces.directive).toContain("mcp__peers__oracle")
      expect(surfaces.digest).toContain("`oracle`")
      expect(surfaces.snippet).toContain("mcp__peers__oracle")
      expect(surfaces.summary).toContain("mcp__peers__oracle")
    } else {
      // `local` admits no `peers` persona and, with the artifact panel off,
      // registers no `peers` group at all, so naming Oracle would point the
      // lead at a tool the session lacks.
      for (const surface of SURFACE_NAMES) {
        expect(surfaces[surface].toLowerCase()).not.toContain("oracle")
      }
    }
  })

  test("`local` names no Copilot model anywhere", () => {
    if (profile !== "local") return
    const all = joined(profile)
    expect(all).not.toMatch(/\bSol\b/)
    expect(all.toLowerCase()).not.toContain("copilot")
  })

  test("no stale `code_search` tool name", () => {
    expect(joined(profile)).not.toContain("`code_search`")
  })
})

describe("advisor vocabulary follows the profile", () => {
  test("local names no Advisor anywhere", () => {
    expect(joined("local").toLowerCase()).not.toContain("advisor")
  })

  test("local2 names the Advisor it carries", () => {
    for (const surface of SURFACE_NAMES) {
      expect(text("local2")[surface].toLowerCase()).toContain("advisor")
    }
  })

  test("the local advisor descriptions name a Copilot-served model, not a stronger one", () => {
    for (const description of [LOCAL_ADVISOR_TOOL_INSTRUCTIONS, LOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS]) {
      expect(description).toContain("Sol")
      expect(description).toContain("Copilot-served")
      expect(description).not.toContain("stronger")
    }
    // The cheapest variants keep the comparison, because those launches can
    // observe both models. This half is what stops a future edit from
    // silencing both sides by deleting the phrase everywhere.
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("stronger")
    expect(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS).toContain("stronger")
  })
})

describe("search guidance matches the launch's backend", () => {
  test("lexical-only launches describe lexical search and never name ColBERT", () => {
    const surfaces = text("local")
    expect(surfaces.directive).toContain("LEXICAL `code` search")
    expect(surfaces.directive).not.toContain("LOCAL LEXICAL")
    expect(surfaces.directive).not.toContain("ColBERT")
    expect(surfaces.snippet).toContain("local lexical")
    expect(surfaces.snippet).not.toContain("ColBERT")
    expect(surfaces.summary).toContain("local lexical")
    expect(surfaces.summary).not.toContain("ColBERT")
  })

  test("semantic launches describe ColBERT and never claim a lexical label", () => {
    const surfaces = text("local", { semanticSearchAvailable: true })
    expect(surfaces.directive).toContain("local ColBERT SEMANTIC")
    expect(surfaces.directive).not.toContain("LOCAL LEXICAL")
    expect(surfaces.snippet).toContain("local ColBERT")
    expect(surfaces.summary).toContain("local ColBERT")
  })
})

describe("worker-browse is named only when the launch can reach it", () => {
  test("absent from every surface when browse is off", () => {
    expect(joined("local")).not.toContain("worker-browse")
    expect(joined("local2")).not.toContain("worker-browse")
  })

  // `worker-browse` is a Pi worker, and both local profiles drop the workers
  // group. The builder therefore has to ignore a `browseAvailable: true` it is
  // handed by a caller that reports the process-wide browse gate rather than
  // this launch's groups; otherwise the prose names an agent with no `.md`.
  test("absent from the delegation graphs even when browse is on", () => {
    for (const profile of LOCAL_PROFILES) {
      const surfaces = text(profile, { browseAvailable: true })
      expect(surfaces.directive).not.toContain("worker-browse")
      expect(surfaces.snippet).not.toContain("worker-browse")
      expect(surfaces.summary).not.toContain("worker-browse")
    }
  })

  test("still named for a non-local profile with browse on", () => {
    const opts = { ...availability("local"), profile: "cheapest2", browseAvailable: true }
    const snippet = buildPeerAwarenessSnippet(opts as never)
    const summary = buildPeerAwarenessSummary(opts as never)
    expect(buildOperatingDefaultsDirective({ ...opts, profile: "cheapest2" } as never)).toContain("worker-browse")
    expect(snippet).toContain("worker-browse")
    expect(summary).toContain("worker-browse")
  })
})

describe.each(LOCAL_PROFILES)("%s pipeline skills describe the local roster", (profile) => {
  test("injects exactly the four pipeline skills", () => {
    const skills = injectedSkillsForLaunch({
      profileId: profile,
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    })
    expect(skills.map((skill) => skill.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
    ])
  })

  test("the concatenated skill text names no Copilot model and no absent agent", () => {
    const skills = injectedSkillsForLaunch({
      profileId: profile,
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    })
    const md = skills.map((skill) => skill.md).join("\n")

    for (const name of ["Luna", "Sol", "Gemini"]) {
      expect(md).not.toMatch(word(name))
    }
    expect(md).not.toContain("6x")
    expect(md).not.toContain("cheapest")
    expect(md).not.toContain("implementer")
    expect(md).not.toContain("`Plan`")
    expect(md).not.toContain("subagent_type Plan")
    expect(md).not.toContain("Plan subagent")
    expect(md).not.toContain("Plan dispatch")

    // The roster line the orchestrator renders is exactly what local emits.
    expect(md).toContain("Explore, General-Purpose, reviewer")
  })
})

describe("non-local profiles keep their own wording", () => {
  test("cheapest still describes a cost-efficient lead", () => {
    expect(buildOperatingDefaultsDirective({ profile: "cheapest" })).toContain(
      "fast, cost-efficient model",
    )
  })

  test("balanced still optimizes for lowest cost", () => {
    expect(buildOperatingDefaultsDirective({ profile: "balanced" })).toContain("lowest cost")
  })

  test("cheapest's gather skill still names and prices Luna", () => {
    const gather = getPipelineSkills(false, false, "cheapest")[0]
    expect(gather?.md).toContain("Luna")
    expect(gather?.md).toContain("6x")
  })

  test("a profile-less implement skill still names Plan dispatches and implementer", () => {
    const legacy = buildImplementSkill(true)
    expect(legacy.md).toContain("Plan dispatches")
    expect(legacy.md).toContain("implementer")
  })
})
