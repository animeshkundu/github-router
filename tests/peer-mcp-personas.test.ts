import { describe, expect, test } from "bun:test"

import {
  buildAgentPrompt,
  buildPeerAwarenessSnippet,
  PERSONAS_READ,
  PERSONAS_WRITE,
  personasFor,
} from "../src/lib/peer-mcp-personas"

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
    expect(byName["codex-critic"]?.model).toBe("gpt-5.5")
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

    expect(byName["opus-critic"]?.model).toBe("claude-opus-4-6")
    expect(byName["opus-critic"]?.endpoint).toBe("/v1/messages")
    // opus-critic must route via HTTP (codex-cli stdio bridge can't run
    // claude-opus-4-6 — it speaks gpt-5/codex only)
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
    expect(byName["codex-critic"]?.description).toContain("gpt-5.5")
    expect(byName["gemini-critic"]?.description).toContain("gemini-3.1-pro")
    expect(byName["codex-reviewer"]?.description).toContain("gpt-5.3-codex")
    expect(byName["gemini-reviewer"]?.description).toContain("gemini-3.1-pro")
    expect(byName["opus-critic"]?.description).toContain("Opus 4.6")
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
      // when-not-to-use. Cap at 400 chars to prevent bloat while allowing
      // the routing signal Opus 4.8 needs to pick the right tool.
      expect(p.description.length).toBeLessThan(400)
    }
  })

  test("each persona declares allowedEfforts and a defaultEffort within it", () => {
    for (const p of PERSONAS_READ) {
      expect(p.allowedEfforts.length).toBeGreaterThan(0)
      expect(p.allowedEfforts).toContain(p.defaultEffort)
    }
  })

  test("codex-critic / codex-reviewer accept all four effort tiers (SSE handles long calls); opus-critic caps at high (4.6 model doesn't advertise xhigh)", () => {
    // SSE-streamed /mcp responses (handler.ts:handleToolsCallSSE) bypass
    // Claude Code's ~60s tools/call ceiling, so the previous xhigh
    // constraints on these critics are lifted. Two exceptions:
    //   - gemini-critic — see the next test (Copilot's gemini route 400s
    //     on xhigh)
    //   - opus-critic — its model (claude-opus-4-6 / -1m) only advertises
    //     reasoning_effort ["low","medium","high","max"]; xhigh is absent.
    //     We omit xhigh from the allowlist so a caller-supplied xhigh
    //     rejects with RPC_INVALID_PARAMS rather than bouncing off Copilot
    //     at request time.
    const allFour = ["low", "medium", "high", "xhigh"] as const
    const threeNoXhigh = ["low", "medium", "high"] as const
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.allowedEfforts).toEqual(allFour)
    expect(byName["codex-reviewer"]?.allowedEfforts).toEqual(allFour)
    expect(byName["opus-critic"]?.allowedEfforts).toEqual(threeNoXhigh)
  })

  test("codex-critic / codex-reviewer default to xhigh; opus-critic defaults to high (deepest tier 4.6 advertises)", () => {
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
    expect(prompt).toContain('"gpt-5.5"')
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
  } as const
  // Maximal: all capabilities on — produces the largest snippet.
  const MAXIMAL = {
    codexCli: true,
    geminiAvailable: true,
    workerToolsAvailable: true,
    standInAvailable: true,
    browseAvailable: true,
    powerBrowseAvailable: true,
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

  test("snippet stays under ~280 tokens (~1700 bytes) in the minimal case", () => {
    // Re-derived per peer-review I5 after the descriptive-only rewrite.
    // The cap is the smallest envelope the actual implementation fits
    // inside, not a target driving copy growth. If a future tightening
    // shaves bytes, lower this cap too.
    const minimal = buildPeerAwarenessSnippet(MINIMAL)
    expect(Buffer.byteLength(minimal, "utf8")).toBeLessThan(1700)
  })

  test("snippet stays under ~540 tokens (~3300 bytes) in the maximal case", () => {
    // Maximal = EVERY gate on (gemini_reviewer, the `review` worker,
    // browse + power). The cap is the smallest envelope the implementation
    // fits inside; if a future tightening shaves bytes, lower it too.
    const full = buildPeerAwarenessSnippet(MAXIMAL)
    expect(Buffer.byteLength(full, "utf8")).toBeLessThan(3300)
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

  test("worker explore / implement mentions are gated on workerToolsAvailable", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: false,
    })
    expect(off).not.toContain("mcp__workers__explore")
    expect(off).not.toContain("mcp__workers__implement")
    expect(off).not.toContain("Workers themselves")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      workerToolsAvailable: true,
    })
    // Worker tools are now namespaced under the `workers` server as
    // `mcp__workers__explore` / `mcp__workers__implement` (renamed from
    // the flat `worker_explore` / `worker_implement`).
    expect(on).toContain("mcp__workers__explore")
    expect(on).toContain("mcp__workers__implement")
    expect(on).toContain("Workers themselves")
    expect(on).toContain("worktree: true")
  })

  test("conditionally mentions the browser tools when browseAvailable is on", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: false,
    })
    expect(off).not.toContain("__act")
    expect(off).not.toContain("__observe")
    expect(off).not.toContain("__extract")
    expect(off).not.toContain("mcp__browser__")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
    })
    // Browser tools are namespaced under the `browser` server; the lead
    // surface is described via the bare action suffixes (act / observe /
    // extract / navigate / open_tab / screenshot) under the
    // `mcp__browser__*` prefix. Power-tier tools (mouse / eval_js / find)
    // are NOT mentioned in default --browse mode.
    expect(on).toContain("mcp__browser__*")
    expect(on).toContain("__act")
    expect(on).toContain("__observe")
    expect(on).toContain("__extract")
    // Power tools NOT mentioned in default --browse mode.
    expect(on).not.toContain("__find")
    expect(on).not.toContain("__mouse")
    expect(on).not.toContain("__eval_js")
  })

  test("mentions power tools when powerBrowseAvailable is on", () => {
    const off = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      powerBrowseAvailable: false,
    })
    expect(off).not.toContain("Power mode")
    expect(off).not.toContain("__mouse")
    expect(off).not.toContain("__eval_js")

    const on = buildPeerAwarenessSnippet({
      ...MINIMAL,
      browseAvailable: true,
      powerBrowseAvailable: true,
    })
    expect(on).toContain("Power mode")
    expect(on).toContain("mcp__browser__mouse")
    expect(on).toContain("__eval_js")
    expect(on).toContain("__find")
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
    // Per Anthropic's Opus 4.8 guidance: tool descriptions carry the
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

  test("mentions subagent inheritance (the load-bearing UX claim)", () => {
    const snippet = buildPeerAwarenessSnippet({
      ...MINIMAL,
      geminiAvailable: true,
    })
    expect(snippet).toMatch(/subagents/i)
    expect(snippet).toMatch(/inherit/i)
  })
})
