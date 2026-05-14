import { describe, expect, test } from "bun:test"

import {
  buildAgentPrompt,
  PERSONAS_READ,
  PERSONAS_WRITE,
  personasFor,
} from "../src/lib/peer-mcp-personas"

describe("PERSONAS_READ", () => {
  test("exposes the four load-bearing read personas", () => {
    expect(PERSONAS_READ).toHaveLength(4)
    const names = PERSONAS_READ.map((p) => p.agentName)
    expect(names).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
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

    expect(byName["opus-critic"]?.model).toBe("claude-opus-4-7")
    expect(byName["opus-critic"]?.endpoint).toBe("/v1/messages")
    // opus-critic must route via HTTP (codex-cli stdio bridge can't run
    // claude-opus-4-7 — it speaks gpt-5/codex only)
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

  test("descriptions teach the lead what to pass (cold-start contract)", () => {
    // codex-critic, gemini-critic, codex-reviewer use the "Always pass"
    // language explicitly; opus-critic uses "fits comfortably in one shot"
    // framing for its same-lab gut-check use case (the cold-start
    // contract is delivered via baseInstructions instead). Both forms
    // surface the "no scrollback access" warning.
    for (const p of PERSONAS_READ) {
      expect(p.description.toLowerCase()).toContain("scrollback")
    }
    for (const p of PERSONAS_READ) {
      if (p.agentName !== "opus-critic") {
        expect(p.description).toContain("Always pass")
      }
    }
  })

  test("each persona declares allowedEfforts and a defaultEffort within it", () => {
    for (const p of PERSONAS_READ) {
      expect(p.allowedEfforts.length).toBeGreaterThan(0)
      expect(p.allowedEfforts).toContain(p.defaultEffort)
    }
  })

  test("codex-critic and codex-reviewer reject xhigh (60s ceiling)", () => {
    const byName = Object.fromEntries(PERSONAS_READ.map((p) => [p.agentName, p]))
    expect(byName["codex-critic"]?.allowedEfforts).not.toContain("xhigh")
    expect(byName["codex-reviewer"]?.allowedEfforts).not.toContain("xhigh")
  })

  test("opus-critic only allows low/medium (thinking-budget math)", () => {
    const opus = PERSONAS_READ.find((p) => p.agentName === "opus-critic")
    expect(opus?.allowedEfforts).toEqual(["low", "medium"])
    expect(opus?.defaultEffort).toBe("medium")
  })

  test("gemini-critic still accepts all four effort tiers", () => {
    const gem = PERSONAS_READ.find((p) => p.agentName === "gemini-critic")
    expect(gem?.allowedEfforts).toEqual(["low", "medium", "high", "xhigh"])
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
})

describe("personasFor", () => {
  test("HTTP backend (codexCli=false) with gemini available returns 4 read personas", () => {
    const list = personasFor({ codexCli: false, geminiAvailable: true })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
      "opus-critic",
    ])
  })

  test("HTTP backend without gemini drops gemini-critic only", () => {
    const list = personasFor({ codexCli: false, geminiAvailable: false })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "codex-reviewer",
      "opus-critic",
    ])
  })

  test("CLI backend with gemini adds codex-implementer for 5 personas", () => {
    const list = personasFor({ codexCli: true, geminiAvailable: true })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "gemini-critic",
      "codex-reviewer",
      "opus-critic",
      "codex-implementer",
    ])
  })

  test("CLI backend without gemini = 4 personas (codex-critic, codex-reviewer, opus-critic, codex-implementer)", () => {
    const list = personasFor({ codexCli: true, geminiAvailable: false })
    expect(list.map((p) => p.agentName)).toEqual([
      "codex-critic",
      "codex-reviewer",
      "opus-critic",
      "codex-implementer",
    ])
  })
})

describe("buildAgentPrompt — HTTP mode", () => {
  test("codex-critic prompt routes to mcp__gh-router-peers__codex_critic", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "codex-critic")!
    const prompt = buildAgentPrompt(persona, { codexCli: false })
    expect(prompt).toContain("mcp__gh-router-peers__codex_critic")
    expect(prompt).not.toContain("mcp__codex-cli__codex")
    // Persona text is inlined.
    expect(prompt).toContain("adversarial reviewer")
    // Cold-start contract is inlined.
    expect(prompt).toContain("Cold-start contract")
  })

  test("gemini-critic always routes to HTTP even with codex-cli mode", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "gemini-critic")!
    const cliPrompt = buildAgentPrompt(persona, { codexCli: true })
    expect(cliPrompt).toContain("mcp__gh-router-peers__gemini_critic")
    expect(cliPrompt).not.toContain("mcp__codex-cli__codex")
  })
})

describe("buildAgentPrompt — codex-cli mode", () => {
  test("codex-critic prompt routes to mcp__codex-cli__codex with model + base-instructions", () => {
    const persona = PERSONAS_READ.find((p) => p.agentName === "codex-critic")!
    const prompt = buildAgentPrompt(persona, { codexCli: true })
    expect(prompt).toContain("mcp__codex-cli__codex")
    expect(prompt).toContain('"gpt-5.5"')
    expect(prompt).toContain("base-instructions")
    expect(prompt).toContain('"read-only"')
  })

  test("codex-implementer prompt routes to codex-cli with workspace-write sandbox", () => {
    const persona = PERSONAS_WRITE[0]
    const prompt = buildAgentPrompt(persona, { codexCli: true })
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
    const a = buildAgentPrompt(persona, { codexCli: false })
    const b = buildAgentPrompt(persona, { codexCli: false })
    expect(a).toBe(b)

    const aCli = buildAgentPrompt(persona, { codexCli: true })
    const bCli = buildAgentPrompt(persona, { codexCli: true })
    expect(aCli).toBe(bCli)
  })
})
