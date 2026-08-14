import { afterEach, describe, expect, test } from "bun:test"

import {
  buildAgentPrompt,
  buildPeerAwarenessSnippet,
  buildPeerAwarenessSummary,
  enumerateInjectedMcpToolNames,
  NON_PERSONA_MCP_TOOLS,
  PERSONAS_READ,
  PERSONAS_WRITE,
  personasFor,
} from "../src/lib/peer-mcp-personas"
import { state } from "../src/lib/state"

const realModels = state.models

afterEach(() => {
  state.models = realModels
})

function setCatalog(data: Array<unknown>): void {
  state.models = { data, object: "list" } as unknown as typeof state.models
}

function pricedModel(id: string, input: number = 20, output: number = 120): Record<string, unknown> {
  return {
    id,
    capabilities: { supports: { tool_calls: true } },
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        input_price: input * 1_000_000_000,
        output_price: output * 1_000_000_000,
      },
    },
  }
}

describe("worker tool descriptions point at the worker-* dispatcher", () => {
  test("each raw workers-group tool description leads with its worker-<mode> agent + Agent-tool dispatch", () => {
    for (const mode of ["explore", "implement", "review", "plan", "test", "browse"]) {
      const tool = NON_PERSONA_MCP_TOOLS.find(
        (t) => t.group === "workers" && t.toolNameHttp === mode,
      )
      expect(tool, `workers/${mode} tool should exist`).toBeDefined()
      const desc = tool!.description
      expect(desc).toContain(`worker-${mode}`)
      expect(desc).toContain("Agent tool")
      expect(desc.toLowerCase()).toContain("completion notification")
    }
  })
})

describe("PERSONAS_READ", () => {
  test("exposes the five load-bearing read personas", () => {
    expect(PERSONAS_READ).toHaveLength(5)
    const names = PERSONAS_READ.map((p) => p.agentName)
    expect(names).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
      "gemini-reviewer",
      "opus-critic",
    ])
  })

  test("each persona has the correct model + endpoint binding", () => {
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.model).toBe("gpt-5.6-sol")
    expect(byName["codex-critic"]?.endpoint).toBe("/v1/responses")
    expect(byName["codex-critic"]?.requiresHttp).toBe(false)
    expect(byName["codex-critic"]?.writeCapable).toBe(false)

    expect(byName["gemini-critic"]?.model).toBe("gemini-3.1-pro-preview")
    expect(byName["gemini-critic"]?.endpoint).toBe("/v1/chat/completions")
    expect(byName["gemini-critic"]?.requiresHttp).toBe(true)

    expect(byName["codex-reviewer"]?.model).toBe("gpt-5.3-codex")
    expect(byName["codex-reviewer"]?.endpoint).toBe("/v1/responses")
    expect(byName["codex-reviewer"]?.requiresHttp).toBe(false)

    expect(byName["gemini-reviewer"]?.model).toBe("gemini-3.1-pro-preview")
    expect(byName["gemini-reviewer"]?.endpoint).toBe("/v1/chat/completions")
    // gemini routes only via HTTP (codex-cli stdio can't run it).
    expect(byName["gemini-reviewer"]?.requiresHttp).toBe(true)
    // Same gemini-3.x-pro catalog gate as gemini-critic (both run on
    // gemini-3.1-pro-preview; reviewer prompt vs. critic prompt).
    expect(byName["gemini-reviewer"]?.requiresGeminiCatalog).toBe(true)

    expect(byName["opus-critic"]?.model).toBe("claude-opus-5")
    expect(byName["opus-critic"]?.endpoint).toBe("/v1/messages")
    // opus-critic must route via HTTP (codex-cli stdio bridge can't run
    // claude-opus-5 — it speaks gpt-5/codex only)
    expect(byName["opus-critic"]?.requiresHttp).toBe(true)
    expect(byName["opus-critic"]?.requiresGeminiCatalog).toBeUndefined()
    expect(byName["opus-critic"]?.writeCapable).toBe(false)
  })

  test("HTTP tool names are snake_case (matches MCP convention)", () => {
    for (const p of PERSONAS_READ) {
      expect(p.toolNameHttp).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test("baseInstructions contain the calibrated 1-5 grading rubric for critics", () => {
    const critic = PERSONAS_READ.find((p) => p.agentName === "codex-critic")
    expect(critic?.baseInstructions).toContain("1–5")
    expect(critic?.baseInstructions).toContain("no material objection")
    // The end-of-prompt self-reminder is what produces sustained behavior.
    expect(critic?.baseInstructions).toContain("Self-reminder")
  })

  test("descriptions surface load-bearing routing signal (model identity)", () => {
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.description).toContain("gpt-5.6-sol")
    expect(byName["gemini-critic"]?.description).toContain("gemini-3.1-pro")
    expect(byName["codex-reviewer"]?.description).toContain("gpt-5.3-codex")
    expect(byName["gemini-reviewer"]?.description).toContain("gemini-3.1-pro")
    expect(byName["opus-critic"]?.description).toContain("Opus 5")
    for (const p of PERSONAS_READ) {
      // codex-reviewer AND gemini-reviewer are framed as code-specialists /
      // "magnifying glass" line-level reviewers, not adversarial critics —
      // their baseInstructions even redirect architecture briefs away. Skip
      // the adversarial check for both; the other read personas are critics.
      if (p.agentName !== "codex-reviewer" && p.agentName !== "gemini-reviewer") {
        expect(p.description.toLowerCase()).toContain("adversarial")
      }
      // Cold-start contract: peers have no scrollback, so the lead must
      // pass the artifact verbatim. Cross-lab smoke-test feedback (codex +
      // opus independently flagged this regression after the trim landed).
      expect(p.description.toLowerCase()).toContain("verbatim")
      // Per Anthropic's tool-use guidance: descriptions should be 3-4+
      // sentences for complex tools, explaining scope, when-to-use, and
      // when-not-to-use. Keep these substantive but bounded enough for
      // frontmatter and tool-selection prompts.
      expect(p.description.length).toBeLessThan(900)
    }
  })

  test("each persona declares allowedEfforts and a defaultEffort within it", () => {
    for (const p of PERSONAS_READ) {
      expect(p.allowedEfforts.length).toBeGreaterThan(0)
      expect(p.allowedEfforts).toContain(p.defaultEffort)
    }
  })

  test("codex-critic / codex-reviewer accept all four effort tiers", () => {
    // SSE-streamed /mcp responses (handler.ts:handleToolsCallSSE) bypass
    // Claude Code's ~60s tools/call ceiling, so the codex personas expose xhigh.
    const allFour = ["low", "medium", "high", "xhigh"] as const
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.allowedEfforts).toEqual(allFour)
    expect(byName["codex-reviewer"]?.allowedEfforts).toEqual(allFour)
  })

  test("opus-critic caps allowedEfforts at high (dynamic fallback to opus-4.6 lacks xhigh)", () => {
    // opus_critic's EFFECTIVE model is resolved at call time to claude-opus-5
    // (which advertises xhigh) OR a claude-opus-4.6 fallback (which does not).
    // The /v1/messages dispatch does not clamp effort, so the static allowlist
    // stays capped at high — a caller-supplied xhigh rejects cleanly instead of
    // 400ing off Copilot on a non-opus-5 tier.
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["opus-critic"]?.allowedEfforts).toEqual(["low", "medium", "high"])
  })

  test("codex-critic / codex-reviewer default to xhigh; opus-critic defaults to high", () => {
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.defaultEffort).toBe("xhigh")
    expect(byName["codex-reviewer"]?.defaultEffort).toBe("xhigh")
    expect(byName["opus-critic"]?.defaultEffort).toBe("high")
  })

  test("gemini-critic defaults to high (Copilot's gemini route 400s on xhigh — see allowedEfforts test below)", () => {
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["gemini-critic"]?.defaultEffort).toBe("high")
  })

  test("gemini-critic accepts only low/medium/high (Copilot's gemini route 400s on xhigh)", () => {
    // Copilot rejects xhigh on gemini-3.x with HTTP 400:
    // "reasoning_effort 'xhigh' is not supported by model
    // gemini-3.1-pro-preview; supported values: [low medium high]"
    // — empirically verified 2026-05-14.
    const gem = PERSONAS_READ.find((p) => p.agentName === "gemini-critic")
    expect(gem?.allowedEfforts).toEqual(["low", "medium", "high"])
  })
})

describe("PERSONAS_WRITE", () => {
  test("exposes exactly the codex-implementer persona", () => {
    expect(PERSONAS_WRITE).toHaveLength(1)
    const impl = PERSONAS_WRITE[0]
    expect(impl.agentName).toBe("codex-implementer")
    expect(impl.model).toBe("gpt-5.3-codex")
    expect(impl.endpoint).toBe("/v1/responses")
    expect(impl.writeCapable).toBe(true)
    expect(impl.requiresHttp).toBe(false)
  })

  test("baseInstructions tell the model the resilience rule", () => {
    const impl = PERSONAS_WRITE[0]
    expect(impl.baseInstructions).toContain("session terminates abnormally")
  })

  test("description carries the cold-start verbatim contract", () => {
    for (const p of PERSONAS_WRITE) {
      expect(p.description.toLowerCase()).toContain("verbatim")
    }
  })
})

describe("personasFor", () => {
  test("HTTP backend (codexCli=false) with gemini available returns 5 read personas", () => {
    const list = personasFor({ codexCli: false, geminiAvailable: true })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
      "gemini-reviewer",
      "opus-critic",
    ])
  })

  test("HTTP backend without gemini drops BOTH gemini personas", () => {
    const list = personasFor({ codexCli: false, geminiAvailable: false })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "codex-reviewer",
      "opus-critic",
    ])
  })

  test("CLI backend with gemini adds codex-implementer for 6 personas", () => {
    const list = personasFor({ codexCli: true, geminiAvailable: true })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
      "gemini-reviewer",
      "opus-critic",
      "codex-implementer",
    ])
  })

  test("CLI backend without gemini = 4 personas (no gemini personas, + codex-implementer)", () => {
    const list = personasFor({ codexCli: true, geminiAvailable: false })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "codex-reviewer",
      "opus-critic",
      "codex-implementer",
    ])
  })

  test("gemini-critic and gemini-reviewer gate together on geminiAvailable", () => {
    const on = personasFor({ codexCli: false, geminiAvailable: true }).map((p) => p.agentName)
    expect(on).toContain("gemini-critic")
    expect(on).toContain("gemini-reviewer")
    const off = personasFor({ codexCli: false, geminiAvailable: false }).map((p) => p.agentName)
    expect(off).not.toContain("gemini-critic")
    expect(off).not.toContain("gemini-reviewer")
  })

  test("both Gemini personas use the resolved Flash fallback model", () => {
    const gemini = personasFor({
      codexCli: false,
      geminiAvailable: true,
      geminiModel: "gemini-3.7-flash",
    }).filter((p) => p.requiresGeminiCatalog)
    expect(gemini).toHaveLength(2)
    expect(gemini.every((p) => p.model === "gemini-3.7-flash")).toBe(true)
    expect(gemini.every((p) => p.description.includes("gemini-3.7-flash"))).toBe(true)
    expect(gemini.every((p) => !p.description.includes("gemini-3.1-pro-preview"))).toBe(true)
  })
})

describe("buildAgentPrompt — HTTP mode", () => {
  test("codex-critic prompt routes to mcp__peers__codex_critic", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "codex-critic")!
    const prompt = buildAgentPrompt(persona, { codexCli: false, peersKey: "peers" })
    expect(prompt).toContain("mcp__peers__codex_critic")
    expect(prompt).not.toContain("mcp__codex-cli__codex")
    // Persona text is inlined.
    expect(prompt).toContain("adversarial reviewer")
    // Cold-start contract is inlined.
    expect(prompt).toContain("Cold-start contract")
  })

  test("gemini-critic always routes to HTTP even with codex-cli mode", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "gemini-critic")!
    const cliPrompt = buildAgentPrompt(persona, { codexCli: true, peersKey: "peers" })
    expect(cliPrompt).toContain("mcp__peers__gemini_critic")
    expect(cliPrompt).not.toContain("mcp__codex-cli__codex")
  })
})

describe("buildAgentPrompt — codex-cli mode", () => {
  test("codex-critic prompt routes to mcp__codex-cli__codex with model + base-instructions", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "codex-critic")!
    const prompt = buildAgentPrompt(persona, { codexCli: true, peersKey: "peers" })
    expect(prompt).toContain("mcp__codex-cli__codex")
    expect(prompt).toContain('"gpt-5.6-sol"')
    expect(prompt).toContain("base-instructions")
    expect(prompt).toContain('"read-only"')
  })

  test("codex-implementer prompt routes to codex-cli with workspace-write sandbox", () => {
    const persona = PERSONAS_WRITE[0]
    const prompt = buildAgentPrompt(persona, { codexCli: true, peersKey: "peers" })
    expect(prompt).toContain("mcp__codex-cli__codex")
    expect(prompt).toContain('"gpt-5.3-codex"')
    expect(prompt).toContain('"workspace-write"')
  })
})

describe("prompt-cache stability", () => {
  test("baseInstructions are byte-identical across calls (no timestamps / random ids)", () => {
    const a = PERSONAS_READ.map((p) => p.baseInstructions)
    const b = PERSONAS_READ.map((p) => p.baseInstructions)
    expect(a).toEqual(b)
  })

  test("buildAgentPrompt output is deterministic for same inputs", () => {
    const persona = PERSONAS_READ[0]
    const a = buildAgentPrompt(persona, { codexCli: false, peersKey: "peers" })
    const b = buildAgentPrompt(persona, { codexCli: false, peersKey: "peers" })
    expect(a).toBe(b)

    const aCli = buildAgentPrompt(persona, { codexCli: true, peersKey: "peers" })
    const bCli = buildAgentPrompt(persona, { codexCli: true, peersKey: "peers" })
    expect(aCli).toBe(bCli)
  })
})

describe("buildPeerAwarenessSnippet", () => {
  // Convenience: minimal opts (no gemini, no codex-cli, no worker tools,
  // no stand_in) — produces the smallest snippet.
  const MINIMAL = {
    codexCli: false,
    geminiAvailable: false,
    workerToolsAvailable: false,
    standInAvailable: false,
    browseAvailable: false,
    compoundBrowseAvailable: false,
  } as const
  // Maximal: all capabilities on — produces the largest snippet.
  const MAXIMAL = {
    codexCli: true,
    geminiAvailable: true,
    workerToolsAvailable: true,
    standInAvailable: true,
    browseAvailable: true,
    compoundBrowseAvailable: true,
    powerBrowseAvailable: true,
    fleetAvailable: true,
    agentToolsAvailable: true,
  } as const

  test("always advertises the three always-on critic tools, coordinator, and namespace prefix", () => {
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    expect(snippet).toContain("mcp__peers__")
    expect(snippet).toContain("codex_critic")
    expect(snippet).toContain("codex_reviewer")
    expect(snippet).toContain("opus_critic")
    expect(snippet).toContain("peer-review-coordinator")
    expect(snippet).toContain("## Peer review and advisor")
  })

  test("snippet stays under ~370 tokens (~2230 bytes) in the minimal case", () => {
    // Re-derived per peer-review I5 after the descriptive-only rewrite, then
    // bumped when the always-on orchestration tools (verify_workflow /
    // attest_step) were added to the minimal snippet, and again (2000 -> 2100)
    // when the always-on native subagents got their one-line inventory. The
    // roster later grew from three to five (implementer/reviewer/brainstorm/
    // scout/scribe) and the inventory sentence was TIGHTENED to absorb it, so
    // this cap did not move. It moved from 2100 -> 2230 for the original three
    // catch-alls, then to 2320 when `generic` became the longer specialist name
    // `implementer-fast` and gained its mechanical-vs-judgment role clause. It
    // tightened to 2300 when the two overlapping generic catch-alls became the
    // singular `general-purpose-fast` (measured 2293 bytes).
    // Each agent's own description carries its model and trade-offs, so nothing
    // further belongs in the always-in-context copy. The cap is the smallest
    // envelope the actual implementation fits inside, not a target driving copy
    // growth. If a future tightening shaves bytes, lower this cap too.
    const minimal = buildPeerAwarenessSnippet(MINIMAL)
    expect(Buffer.byteLength(minimal, "utf8")).toBeLessThan(2370)
  })

  test("snippet stays under ~930 tokens (~5580 bytes) in the maximal case", () => {
    // Maximal = EVERY gate on (gemini_reviewer, the `review`/`plan`/`test`
    // workers, the decompose/run_workflow orchestration pipeline, the three
    // floor-raising skills, browse + power). The cap tracks the smallest envelope
    // the implementation fits inside: it was bumped from 4600 when the
    // orchestration pipeline + skills + browser-power tools were added, again
    // (4900 -> 5300) for the always-on native-subagent inventory, again
    // (5300 -> 5400) when that roster went from three agents to five, again
    // (5400 -> 5520) for the former generic catch-alls, then
    // (5520 -> 5580, measured 5556) for `worker-browse`, which was emitted as a
    // subagent whenever browse was on but named in neither prose surface, then to
    // 5660 for the `implementer-fast` name and specialist role clause. The
    // singular `general-purpose-fast` roster now measures 5634 bytes, so the cap
    // tightens to 5640. If a future tightening shaves bytes, lower it again.
    const full = buildPeerAwarenessSnippet(MAXIMAL)
    expect(Buffer.byteLength(full, "utf8")).toBeLessThan(5730)
  })

  test("the system-prompt summary names every native and carries the reviewer-vs-critic tiebreak", () => {
    // Regression pin for a measured routing failure. This summary is the
    // always-in-context surface; it previously named the peer critics, the
    // workers and stand_in, and NOT one native subagent. The only agents the
    // lead was reminded of every turn were the ones the natives overlap with.
    //
    // The tiebreak sentence is pinned specifically because a live `claude -p`
    // session, asked to assess whether a function was safe, delegated to
    // `codex_reviewer` rather than the native `reviewer` that exists for exactly
    // that job. The differentiator is that natives can execute and read the
    // repo while the critics are stateless, so that has to be stated where the
    // routing decision is actually made, not only in CLAUDE.md.
    setCatalog([
      pricedModel("gpt-5.6-sol", 500, 3000),
      pricedModel("gpt-5.6-terra", 200, 1200),
      pricedModel("gemini-3.1-pro-preview", 200, 1200),
      pricedModel("gpt-5.6-luna", 20, 120),
    ])
    const summary = buildPeerAwarenessSummary({
      workerToolsAvailable: true,
      standInAvailable: true,
      browseAvailable: false,
      nativeAgentModels: {
        implementer: "gpt-5.6-sol",
        "implementer-fast": "gpt-5.6-terra",
        reviewer: "gemini-3.1-pro-preview",
        brainstorm: "gemini-3.1-pro-preview",
        scout: "gpt-5.6-luna",
        scribe: "gpt-5.6-terra",
        "general-purpose-fast": "gpt-5.6-luna",
      },
    })
    for (const n of [
      "implementer",
      "reviewer",
      "brainstorm",
      "scout",
      "scribe",
      "implementer-fast",
      "general-purpose-fast",
    ]) {
      expect(summary).toContain(`\`${n}\``)
    }
    expect(summary).toContain("can run things")
    expect(summary).toContain("already hold the artifact")
    expect(summary).toContain("Cost is per 1M tokens in/out, tok/s approximate")
    expect(summary).toContain("`implementer` 500/3000 ~75t/s")
    expect(summary).toContain("`implementer-fast` 200/1200 ~100t/s")
    expect(summary).toContain("`reviewer` 200/1200 ~33t/s")
    expect(summary).toContain("`brainstorm` 200/1200 ~33t/s")
    expect(summary).toContain("`scout` 20/120 ~120t/s")
    expect(summary).toContain("`scribe` 200/1200 ~100t/s")
    expect(summary).toContain("`general-purpose-fast` 20/120 ~120t/s")

    // This block is injected into the system prompt and paid on EVERY turn.
    // Keep it as a compact roster and cross-cutting tiebreak, not a third copy
    // of each agent's routing description. Measured at 1493 bytes with the
    // cost/speed annotations; the small envelope catches real growth.
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThan(1520)
    for (const removedRoleProse of [
      "coding changes needing judgment",
      "docs and ADRs that trail the code",
      "you do not yet know which approach",
      "work no specialist fits",
    ]) {
      expect(summary).not.toContain(removedRoleProse)
    }
    // The summary stays intentionally incomplete: expanded models, gating, and
    // routing guidance remain in CLAUDE.md rather than returning here.
    expect(summary).toContain("full per-tool inventory")
    expect(summary).toContain("CLAUDE.md project instructions")
  })

  // Found by a live smoke test, not by the suite. This surface's doc comment
  // claimed it was "gated identically to the full snippet so it never names a
  // surface the live tools/list dropped", but it took NO availability booleans
  // at all: `scout` was named unconditionally despite being dropped when no
  // cheap-tier model resolves, and the cheaper-tier conditional agents were
  // missing entirely. That matters more here than anywhere else, because this is the
  // always-in-context block where the routing decision is actually made — the
  // CLAUDE.md snippet and the operating-defaults directive are both consulted,
  // this one is resident.
  //
  // The positive assertions above pass whether or not the gating exists, so
  // only building with the flags false proves the omission actually happens.
  test("the summary omits price or speed annotations with either missing figure", () => {
    setCatalog([
      pricedModel("gpt-5.6-sol"),
      {
        id: "unmeasured",
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            input_price: 20_000_000_000,
            output_price: 120_000_000_000,
          },
        },
      },
    ])
    const summary = buildPeerAwarenessSummary({
      workerToolsAvailable: true,
      standInAvailable: true,
      browseAvailable: false,
      nativeAgentModels: {
        implementer: "gpt-5.6-sol",
        reviewer: "unmeasured",
        brainstorm: "missing-price",
      },
    })
    expect(summary).toContain("`implementer` 20/120 ~75t/s")
    expect(summary).toContain("`reviewer`")
    expect(summary).not.toContain("`reviewer` 20/120")
    expect(summary).toContain("`brainstorm`")
    expect(summary).not.toContain("`brainstorm` 0/")
  })

  test("the summary omits natives this launch dropped", () => {
    const none = buildPeerAwarenessSummary({
      workerToolsAvailable: true,
      standInAvailable: true,
      browseAvailable: false,
      scoutAvailable: false,
      implementerFastAvailable: false,
      reviewerFastAvailable: false,
      generalPurposeFastAvailable: false,
    })
    expect(none).not.toContain("`scout`")
    expect(none).not.toContain("`implementer-fast`")
    expect(none).not.toContain("`reviewer-fast`")
    expect(none).not.toContain("`general-purpose-fast`")
    // The unconditional natives survive: they inherit the lead's model rather
    // than being dropped, so they are always in the Task enum.
    for (const n of ["implementer", "reviewer", "brainstorm", "scribe"]) {
      expect(none).toContain(`\`${n}\``)
    }
    // The tiebreak sentence must survive the omission, not be swallowed by it.
    expect(none).toContain("already hold the artifact")

    // Each drops INDEPENDENTLY — losing one must not take the others out.
    const onlyCatchAll = buildPeerAwarenessSummary({
      workerToolsAvailable: true,
      standInAvailable: true,
      browseAvailable: false,
      implementerFastAvailable: false,
    })
    expect(onlyCatchAll).toContain("`general-purpose-fast`")
    expect(onlyCatchAll).not.toContain("`implementer-fast`")
    expect(onlyCatchAll).toContain("`reviewer-fast`")
    expect(onlyCatchAll).toContain("`scout`")

    const withoutReviewerFast = buildPeerAwarenessSummary({
      workerToolsAvailable: true,
      standInAvailable: true,
      browseAvailable: false,
      reviewerFastAvailable: false,
    })
    expect(withoutReviewerFast).not.toContain("`reviewer-fast`")
    expect(withoutReviewerFast).toContain("`reviewer`")
    expect(withoutReviewerFast).toContain("`implementer-fast`")
  })

  test("mentions Claude Code's advisor built-in tool", () => {
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    expect(snippet).toContain("`advisor`")
  })

  test("describes the code search tool with the ranked/BM25F framing + parallel-in-one-turn affordance", () => {
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    // The code search tool is now namespaced under the `search` server as
    // `mcp__search__code` (renamed from the flat `code_search`).
    expect(snippet).toContain("mcp__search__code")
    // Per peer-review I6, the previous "accurate" overclaim was
    // replaced with "ranked"; pin the new property word.
    expect(snippet.toLowerCase()).toContain("ranked")
    expect(snippet).toContain("BM25F")
    // "Multiple independent queries can run in a single turn" is the
    // capability statement that replaces the prior parallel-Grep
    // imperative. The paragraph 1 "fans out … in parallel" sentence
    // also keeps the substring satisfied for the lower-case check.
    expect(snippet.toLowerCase()).toContain("parallel")
    expect(snippet).toContain("in a single turn")
    // The orchestrator modes are surfaced holistically so Claude knows the
    // one-stop search can do AST + whole-workspace structure, not just rg.
    expect(snippet).toContain("ast_pattern")
    expect(snippet).toContain("scan")
    expect(snippet).toContain("complete")
  })

  test("code tool is described as semantic-first with transparent lexical fallback (no standalone semantic_search)", () => {
    // semantic_search is folded into the unified `code` tool — it is no
    // longer a separate, availability-gated tool, so the snippet describes
    // the merged behavior unconditionally and never names `semantic_search`.
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    expect(snippet).not.toContain("semantic_search")
    expect(snippet).toContain("ColBERT")
    expect(snippet).toContain("source")
  })

  test("describes the non-code fallback (per peer-review #4 — grep/glob still apply)", () => {
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    expect(snippet.toLowerCase()).toContain("unstructured")
    // Backticked lowercase `grep` is the new convention (the tool name,
    // not the capitalised proper-noun form).
    expect(snippet).toContain("`grep`")
    expect(snippet).toContain("`glob`")
  })

  test("mentions the web search tool (default-on) and stand_in (only when standInAvailable)", () => {
    const minimal = buildPeerAwarenessSnippet(MINIMAL)
    // Web search is now namespaced under the `search` server as
    // `mcp__search__web` (renamed from the flat `web_search`).
    expect(minimal).toContain("mcp__search__web")
    // stand_in is gated — its sentence must NOT appear in minimal.
    expect(minimal).not.toContain("stand_in")

    const withStandIn = buildPeerAwarenessSnippet({
      ...MINIMAL,
      standInAvailable: true,
    })
    // stand_in is now namespaced under the `decide` server.
    expect(withStandIn).toContain("mcp__decide__stand_in")
  })

  test("worker dispatcher mentions are gated on workerToolsAvailable", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: false,
    })
    expect(off).not.toContain("worker-explore")
    expect(off).not.toContain("worker-implement")
    expect(off).not.toContain("Workers themselves")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: true,
    })
    // Workers are presented as the NON-BLOCKING `worker-*` background
    // dispatcher subagents, never as a raw main-agent tool. The raw
    // `mcp__workers__*` tools appear only as the guarded plumbing the
    // dispatchers call, so the flat per-tool names must NOT surface here.
    expect(on).toContain("worker-explore")
    expect(on).toContain("worker-implement")
    expect(on).not.toContain("mcp__workers__explore")
    expect(on).not.toContain("mcp__workers__implement")
    expect(on).toContain("Workers themselves")
    expect(on).toContain("isolated git worktree")
  })

  test("native subagents are always named; scout is gated on its model and the worker-implement contrast on workers", () => {
    const STEER = "prefer the `implementer` subagent"
    const ALWAYS_ON = ["`implementer`", "`reviewer`", "`brainstorm`", "`scribe`"]
    // Workers on: the native inventory AND the worker-implement contrast appear.
    const withWorkers = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: true,
    })
    for (const name of ALWAYS_ON) expect(withWorkers).toContain(name)
    expect(withWorkers).toContain(STEER)
    expect(withWorkers).toContain("git-worktree isolation")
    // Workers off: the native subagents are STILL named (always injected, no
    // gating), but the worker-implement contrast is absent (nothing to contrast).
    const withoutWorkers = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: false,
    })
    for (const name of ALWAYS_ON) expect(withoutWorkers).toContain(name)
    expect(withoutWorkers).not.toContain(STEER)
    // `scout` is the one native that can be absent: it is dropped rather than
    // downgraded when no cheap-tier model resolves, so naming it then would
    // advertise an agent that is not in the Task enum.
    expect(buildPeerAwarenessSnippet({ ...MINIMAL, scoutAvailable: true })).toContain("`scout`")
    expect(buildPeerAwarenessSnippet({ ...MINIMAL, scoutAvailable: false })).not.toContain("`scout`")
    // The cheaper-tier full-toolset agents follow the same rule and drop
    // INDEPENDENTLY. The default fixtures leave these flags unset (= available),
    // so without an explicitly-false build nothing exercises the omission.
    const conditionalNatives = [
      ["implementerFastAvailable", "`implementer-fast`"],
      ["reviewerFastAvailable", "`reviewer-fast`"],
      ["generalPurposeFastAvailable", "`general-purpose-fast`"],
    ] as const
    for (const [flag, name] of conditionalNatives) {
      expect(buildPeerAwarenessSnippet({ ...MINIMAL, [flag]: true })).toContain(name)
      const dropped = buildPeerAwarenessSnippet({ ...MINIMAL, [flag]: false })
      expect(dropped).not.toContain(name)
      for (const [otherFlag, otherName] of conditionalNatives) {
        if (otherFlag === flag) continue
        expect(dropped).toContain(otherName)
      }
    }
    // The catch-all gone: its singular clause disappears cleanly.
    const noCatchAll = buildPeerAwarenessSnippet({
      ...MINIMAL,
      generalPurposeFastAvailable: false,
    })
    expect(noCatchAll).not.toContain("Catch-all on")
    expect(noCatchAll).not.toContain("general-purpose-fast")
  })

  // `worker-browse` is emitted as a subagent whenever browse is on
  // (`activeDispatchModes` returns six modes then), but BOTH prose surfaces
  // hardcoded a five-item worker list that omitted it and were gated only on
  // `workerToolsAvailable`. So an agent that was in the Task subagent_type enum
  // was named nowhere the lead reads. Lower severity than the inverse defect
  // (prose naming an agent that is NOT in the enum hard-fails on call), but the
  // same roster-vs-prose disagreement this file exists to prevent.
  test("names worker-browse in both surfaces iff browse is available", () => {
    const base = {
      codexCli: false,
      geminiAvailable: true,
      workerToolsAvailable: true,
      standInAvailable: true,
      compoundBrowseAvailable: false,
    }
    const on = buildPeerAwarenessSnippet({ ...base, browseAvailable: true })
    const off = buildPeerAwarenessSnippet({ ...base, browseAvailable: false })
    expect(on).toContain("`worker-browse`")
    expect(off).not.toContain("worker-browse")
    // The other five are unconditional on the worker gate, not the browse gate.
    for (const w of ["worker-explore", "worker-review", "worker-plan", "worker-implement", "worker-test"]) {
      expect(on).toContain(`\`${w}\``)
      expect(off).toContain(`\`${w}\``)
    }

    const sumOn = buildPeerAwarenessSummary({
      workerToolsAvailable: true, standInAvailable: true, browseAvailable: true,
    })
    const sumOff = buildPeerAwarenessSummary({
      workerToolsAvailable: true, standInAvailable: true, browseAvailable: false,
    })
    expect(sumOn).toContain("implement, test, browse)")
    expect(sumOff).toContain("implement, test)")
    expect(sumOff).not.toContain(", browse)")

    // Workers off entirely: neither surface names any dispatcher, browse or not.
    const noWorkers = buildPeerAwarenessSnippet({
      ...base, workerToolsAvailable: false, browseAvailable: true,
    })
    expect(noWorkers).not.toContain("worker-browse")
    expect(noWorkers).not.toContain("worker-explore")
  })

  test("gates browser lead and compound surfaces independently", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: false,
      compoundBrowseAvailable: false,
    })
    expect(off).not.toContain("__navigate")
    expect(off).not.toContain("__act")
    expect(off).not.toContain("__observe")
    expect(off).not.toContain("__extract")
    expect(off).not.toContain("__find")
    expect(off).not.toContain("mcp__browser__")

    const leadOnly = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      compoundBrowseAvailable: false,
    })
    expect(leadOnly).toContain("mcp__browser__*")
    expect(leadOnly).toContain("__navigate")
    expect(leadOnly).toContain("__open_tab")
    expect(leadOnly).toContain("__screenshot")
    expect(leadOnly).not.toContain("__act")
    expect(leadOnly).not.toContain("__observe")
    expect(leadOnly).not.toContain("__extract")
    expect(leadOnly).not.toContain("__find")

    const compound = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      compoundBrowseAvailable: true,
    })
    expect(compound).toContain("mcp__browser__act")
    expect(compound).toContain("__observe")
    expect(compound).toContain("__extract")
    expect(compound).toContain("__find")
  })

  test("mentions all power tools when powerBrowseAvailable is on", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      compoundBrowseAvailable: false,
      powerBrowseAvailable: false,
    })
    expect(off).not.toContain("Power browse surface")
    expect(off).not.toContain("__mouse")
    expect(off).not.toContain("__eval_js")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      compoundBrowseAvailable: true,
      powerBrowseAvailable: true,
    })
    expect(on).toContain("Power browse surface")
    expect(on).toContain("mcp__browser__mouse")
    for (const tool of ["mouse", "drag", "type", "keyboard", "scroll", "eval_js", "read_page", "diagnostics", "list_tabs", "close_tab", "wait", "download"]) {
      expect(on).toContain(`__${tool}`)
    }
  })

  test("mentions fleet tools only when fleetAvailable is on", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      fleetAvailable: false,
    })
    expect(off).not.toContain("mcp__fleet__")
    expect(off).not.toContain("REMOTE fleet instance")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      fleetAvailable: true,
    })
    expect(on).toContain("mcp__fleet__*")
    expect(on).toContain("REMOTE fleet instance")
    expect(on).toContain("read_file")
    expect(on).toContain("git_show")
  })

  test("omits gemini_critic when gemini is not in the catalog", () => {
    const snippet = buildPeerAwarenessSnippet(MINIMAL)
    expect(snippet).not.toContain("gemini_critic")
    expect(snippet).not.toContain("gemini-3.1-pro")
  })

  test("includes gemini_critic when gemini is in the catalog", () => {
    const snippet = buildPeerAwarenessSnippet({
      ...MINIMAL,
      geminiAvailable: true,
    })
    expect(snippet).toContain("gemini_critic")
    expect(snippet).toContain("gemini-3.1-pro")
  })

  test("includes codex-cli stdio bridge mention only when codexCli=true", () => {
    const without = buildPeerAwarenessSnippet({
      ...MINIMAL,
      geminiAvailable: true,
    })
    expect(without).not.toContain("mcp__codex-cli__codex")

    const withCli = buildPeerAwarenessSnippet({
      ...MINIMAL,
      codexCli: true,
      geminiAvailable: true,
    })
    expect(withCli).toContain("mcp__codex-cli__codex")
  })

  test("snippet is non-prescriptive (describes, doesn't dictate or hedge)", () => {
    const snippet = buildPeerAwarenessSnippet(MAXIMAL)
    // Per the Opus 4.8 guidance: tool descriptions carry the
    // routing signal; the awareness snippet should describe
    // capabilities and let the model decide. Pin "at your discretion"
    // as the non-prescriptive phrasing.
    expect(snippet).toContain("at your discretion")
    // Must NOT contain prescriptive arrows or forced routing.
    expect(snippet).not.toContain("→")
    expect(snippet).not.toContain("Pick by task shape")
    // Negative-pin hedges and anchors disguised as description — per
    // peer-review I1 the framing constraint covers both forms of
    // anchoring. If any of these slip in, the snippet has drifted out
    // of the descriptive register.
    expect(snippet).not.toMatch(/\byou might want to consider\b/i)
    expect(snippet).not.toMatch(/\bis usually the right\b/i)
    expect(snippet).not.toMatch(/\bcheapest first move\b/i)
    expect(snippet).not.toMatch(/\bsaves them\b/i)
    expect(snippet).not.toMatch(/\bkeeps them off\b/i)
    expect(snippet).not.toMatch(/\bwaste wall-clock\b/i)
    expect(snippet).not.toMatch(/^Lead with /im)
    expect(snippet).not.toMatch(/^Brief them /im)
    expect(snippet).not.toMatch(/^Reach for /im)
    // The over-constraining worker phrasing we explicitly reverted
    // (per peer-review #4 — workers should still use grep/glob for
    // non-code files).
    expect(snippet).not.toContain("the others are follow-ups for confirmed files")
    // Workflow dropped per peer-review I7 (main-session-only built-in;
    // out of scope for the "Peer review and advisor" fence). Negative-
    // pin against accidental re-introduction.
    expect(snippet).not.toContain("Workflow")
    // No em dashes — the style directive prepended to CLAUDE.md says
    // "Avoid em dashes", and the peer-awareness snippet must not
    // contradict its sibling injection. Pin against accidental
    // reintroduction (the old paragraph 1 used `— ... —` parentheticals).
    expect(snippet).not.toContain("—")
  })

  test("snippet is deterministic for the same inputs", () => {
    const a = buildPeerAwarenessSnippet(MAXIMAL)
    const b = buildPeerAwarenessSnippet(MAXIMAL)
    expect(a).toBe(b)
  })

  test("mentions the orchestration tools under mcp__orchestrate__, gated like the live tools/list", () => {
    // verify_workflow + attest_step are pure (no capability gate) → present even
    // in the minimal snippet; decompose/run_workflow share the worker backend
    // gate → only when workers are available.
    const minimal = buildPeerAwarenessSnippet(MINIMAL)
    expect(minimal).toContain("mcp__orchestrate__verify_workflow")
    expect(minimal).toContain("mcp__orchestrate__attest_step")
    // The CALLABLE composer/runner are namespaced only in the workers-on branch.
    // (The minimal branch may name them in prose to say they're unavailable.)
    expect(minimal).not.toContain("mcp__orchestrate__decompose")
    expect(minimal).not.toContain("mcp__orchestrate__run_workflow")
    const withWorkers = buildPeerAwarenessSnippet({ ...MINIMAL, workerToolsAvailable: true })
    expect(withWorkers).toContain("mcp__orchestrate__decompose")
    expect(withWorkers).toContain("mcp__orchestrate__run_workflow")
  })

  test("mentions subagent inheritance (the load-bearing UX claim)", () => {
    const snippet = buildPeerAwarenessSnippet({
      ...MINIMAL,
      geminiAvailable: true,
    })
    expect(snippet).toMatch(/subagents/i)
    expect(snippet).toMatch(/inherit/i)
  })
})

describe("enumerateInjectedMcpToolNames (plan-mode allowedTools seed)", () => {
  test("builds exact mcp__<key>__<tool> names using the RESOLVED group keys", () => {
    const names = enumerateInjectedMcpToolNames({ peers: "peers", search: "search" })
    // every peer critic + reviewer is present under the resolved peers key
    for (const p of PERSONAS_READ) expect(names).toContain(`mcp__peers__${p.toolNameHttp}`)
    // search-group tools present
    expect(names).toContain("mcp__search__code")
    expect(names).toContain("mcp__search__web")
    // exact names (canUseTool needs exact match — no bare-server wildcard)
    expect(names.every((n) => /^mcp__[^_]/.test(n) && n.split("__").length >= 3)).toBe(true)
    // groups NOT in groupKeys are absent
    expect(names.some((n) => n.startsWith("mcp__workers__"))).toBe(false)
    expect(names.some((n) => n.startsWith("mcp__browser__"))).toBe(false)
  })

  test("honors collision-resolved keys (gh-router-*) and adds codex-cli under --codex-cli", () => {
    const names = enumerateInjectedMcpToolNames({ peers: "gh-router-peers" }, { codexCli: true })
    expect(names).toContain("mcp__gh-router-peers__codex_critic")
    expect(names).toContain("mcp__codex-cli__codex")
    // no bare `peers` names when the resolved key is gh-router-peers
    expect(names.some((n) => n.startsWith("mcp__peers__"))).toBe(false)
  })

  test("dedupes and omits groups whose key is absent", () => {
    const names = enumerateInjectedMcpToolNames({ decide: "decide" })
    expect(names).toEqual([...new Set(names)])
    expect(names).toContain("mcp__decide__stand_in")
    expect(names.some((n) => n.startsWith("mcp__peers__"))).toBe(false)
    // no codex-cli entry without the flag
    expect(names).not.toContain("mcp__codex-cli__codex")
  })
})

describe("worker tool descriptions state their output contract", () => {
  const workerTools = ["explore", "review", "plan", "implement", "test", "browse"] as const
  /** The modes whose toolset is genuinely read-only (no edit/write/bash).
   *  `review` is NOT one of them: `buildWorkerTools` gives it `bash`
   *  unconditionally, so "changes nothing on disk" was never true of it. */
  const readOnlyModes = ["explore", "plan"] as const

  const describeOf = (name: string): string => {
    const tool = NON_PERSONA_MCP_TOOLS.find((t) => t.toolNameHttp === name)
    if (!tool) throw new Error(`worker tool ${name} not found`)
    return tool.description
  }

  test("every worker tool documents the oversized-result spill", () => {
    // `relaySafeText` already spilled an over-cap result to a file and returned
    // the path — but no description said so, so a model receiving a truncated
    // preview had to infer from the trailer alone that the path was real and
    // readable. On the read-only modes, whose transcript is never persisted,
    // guessing wrong loses the whole investigation.
    for (const name of workerTools) {
      const d = describeOf(name)
      expect(d).toContain("written to a file")
      expect(d).toContain("path")
    }
  })

  test("read-only workers say the returned text is their only artifact", () => {
    // "read-only toolset" describes what the WORKER may do; it does not tell a
    // caller what it GETS BACK. A model can read "it has read-only tools" and
    // still reasonably expect a report file to be left behind. These three
    // produce nothing but their return value.
    for (const name of readOnlyModes) {
      expect(describeOf(name)).toContain("Strictly read-only")
    }
  })

  test("write-capable workers are NOT labelled read-only", () => {
    // The discriminating half: a blanket append would satisfy the test above
    // while telling the model that `implement` cannot change files. `review`
    // belongs here too — it holds `bash`, which is a write primitive whatever
    // the edit/write tools do, so labelling it read-only was a false promise.
    for (const name of ["implement", "test", "browse", "review"] as const) {
      expect(describeOf(name)).not.toContain("Strictly read-only")
    }
  })
})

// Every cost/speed annotation is independently omitted when the live catalog
// has no price for that model or the speed table has no entry. So a launch
// whose catalog fetch failed, or has not landed yet at injection time, renders
// bare names — and an unconditional preamble would then promise "cost per 1M
// tokens, tok/s" and deliver none. A header describing a format the body does
// not use is worse than no header: it tells the model to look for data that is
// not there. Pin BOTH directions, since a fix to either alone re-opens the lie.
test("the cost/speed preamble appears only when figures actually rendered", () => {
  const nativeAgentModels = {
    implementer: "gpt-5.6-sol",
    "implementer-fast": "gpt-5.6-terra",
    reviewer: "gemini-3.1-pro-preview",
    "reviewer-fast": "gemini-3.7-flash",
    brainstorm: "gemini-3.1-pro-preview",
    scout: "gpt-5.6-luna",
    scribe: "gpt-5.6-terra",
    "general-purpose-fast": "gpt-5.6-luna",
  } as const
  const opts = {
    workerToolsAvailable: true,
    standInAvailable: true,
    browseAvailable: false,
    nativeAgentModels,
  }

  setCatalog([pricedModel("gpt-5.6-sol", 500, 3000)])
  const annotated = buildPeerAwarenessSummary(opts)
  expect(annotated).toContain("Cost is per 1M tokens in/out, tok/s approximate")
  expect(annotated).toMatch(/`implementer` \d+\/\d+ ~\d+t\/s/)

  // No catalog AND ids absent from FALLBACK_TOKEN_PRICES: nothing can be
  // priced, so no annotation can render. Unknown ids are required here —
  // an empty catalog alone is no longer enough, because the fallback table
  // answers for every model the roster actually routes to. That is the
  // fallback working, and it makes this the genuinely unpriceable case.
  setCatalog([])
  const bare = buildPeerAwarenessSummary({
    ...opts,
    nativeAgentModels: {
      implementer: "unpriceable-model-a",
      "implementer-fast": "unpriceable-model-b",
      reviewer: "unpriceable-model-c",
      "reviewer-fast": "unpriceable-model-e",
      brainstorm: "unpriceable-model-c",
      scout: "unpriceable-model-d",
      scribe: "unpriceable-model-b",
      "general-purpose-fast": "unpriceable-model-d",
    },
  })
  expect(bare).not.toContain("Cost is per 1M tokens")
  expect(bare).not.toMatch(/`implementer` \d/)
  // The roster itself must still be present; only the promise goes away.
  expect(bare).toContain("`implementer`")
  expect(bare).toContain("`general-purpose-fast`")
})
