import { describe, expect, test } from "bun:test"

import { buildPiExtensionSource, buildPiPrompts, buildPiSkills } from "~/lib/pi-extension"
import { buildMirrorBridgeSection } from "~/lib/pi-memory-bridge"
import {
  buildPiAgentFiles,
  buildPiSettingsJson,
  mergeSubagentsSettings,
} from "~/lib/pi-models-settings"

describe("pi bridge MCP contracts", () => {
  test("code_search carries workspace with launch-env fallback", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: false,
    })
    expect(src).toContain("GH_ROUTER_WORKSPACE")
    expect(src).toContain("X-GH-Workspace")
    // Explicit arg wins, env is the fallback, empty refuses locally.
    expect(src).toContain("params.workspace")
    expect(src).toContain("PI_WORKSPACE")
    expect(src).toContain("a workspace is required")
  })

  test("oracle/advisor send query+context only", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(src).toContain('callMcp("peers", "oracle", { query, context }')
    expect(src).not.toContain("model: ORACLE_MODEL")
    expect(src).not.toContain("thinking: ORACLE_THINKING")
    expect(src).not.toContain("model: ADVISOR_MODEL")
    // Decision/options are merged into the MCP brief, not forwarded raw.
    expect(src).toContain("Options considered:")
    expect(src).toContain("Review this plan (advisory)")
  })

  test("browser uses stripped MCP names with tabId schemas", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: true,
    })
    for (const name of ["open_tab", "navigate", "screenshot", "act", "observe", "extract"]) {
      expect(src).toContain(`"${name}"`)
      expect(src).toContain(`callMcp("browser", "${name}"`)
    }
    expect(src).not.toContain("browser_open_tab")
    expect(src).not.toContain("parameters: BrowserParams")
    expect(src).toContain("tabId is required")
  })
})

describe("pi bridge NUL sanitization", () => {
  test("mirror bridge section strips NUL bytes", () => {
    const { section } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "a.md", content: "hel\0lo" }],
        unscopedRules: [],
        userGlobal: [],
        scopedRules: [],
        imports: [],
        skipped: [],
      },
      { repoRoot: "/re\0po" },
    )
    expect(section).not.toContain("\0")
    expect(section).toContain("hello")
  })

  test("generated bridge strips NUL on the return path", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: false,
    })
    // stripNul covers outbound params and the inbound toolText join alike.
    expect(src).toContain("stripNul(text)")
  })
})

describe("pi native agent files (pi-subagents contract)", () => {
  for (const profileId of ["cheapest", "balanced"] as const) {
    test(`${profileId}: every agent advertises, pins context, drops dead keys`, () => {
      const files = buildPiAgentFiles(profileId)
      for (const content of Object.values(files)) {
        expect(content).toContain("advertise: true")
        expect(content).toContain("inheritProjectContext: true")
        expect(content).toContain("defaultContext: fresh")
        expect(content).toContain("systemPromptMode: replace")
        // max_turns is not a known pi-subagents field (silently inert).
        expect(content).not.toContain("max_turns")
      }
    })
  }

  test("nesting grants back every allowedAgents edge", () => {
    const cheapest = buildPiAgentFiles("cheapest")
    const gp = cheapest["agents/general-purpose.md"]!
    // General-Purpose delegates to reviewer + oracle: grant required.
    expect(gp).toContain("allowNestedSubagents: true")
    expect(gp).toContain("allowedAgents: [reviewer, oracle]")
    expect(gp).toContain("tools: [read, grep, find, ls, bash, edit, write, subagent, contact_supervisor]")
    expect(gp).toContain("acceptanceRole: writer")
    const balancedReviewer = buildPiAgentFiles("balanced")["agents/reviewer.md"]!
    expect(balancedReviewer).toContain("allowNestedSubagents: true")
    expect(balancedReviewer).toContain("allowedAgents: [Explore]")
    // The grant is inert without `subagent` in the same tools list.
    expect(balancedReviewer).toContain("contact_supervisor, subagent]")
    // Cheapest reviewer is a leaf: no dangling edge, no nesting tool.
    expect(cheapest["agents/reviewer.md"]!).not.toContain("allowedAgents")
    expect(cheapest["agents/reviewer.md"]!).not.toContain("subagent]")
    expect(cheapest["agents/explore.md"]!).not.toContain("allowedAgents")
  })

  test("aliases absorb disabled-builtin invocations deterministically", () => {
    const files = buildPiAgentFiles("cheapest")
    expect(files["agents/explore.md"]!).toContain("aliases: [scout]")
    expect(files["agents/general-purpose.md"]!).toContain(
      "aliases: [worker, developer, coder, implementer, develop]",
    )
  })

  test("reviewer carries the diff-anchored review contract, honestly tool-scoped", () => {
    const reviewer = buildPiAgentFiles("cheapest")["agents/reviewer.md"]!
    expect(reviewer).toContain("watchdog_diff")
    expect(reviewer).toContain("contact_supervisor")
    expect(reviewer).toContain("Merge verdict")
    // No shell on reviewer: body must not promise reproduction it can't run.
    expect(reviewer).toContain("You have no shell")
    expect(reviewer).not.toContain("Reproduce failures before diagnosing")
  })

  test("no file bindings: handoff is inline, runs write nothing to the repo", () => {
    // Single-shot launches resolve relative `output:` under per-run artifact
    // dirs while `defaultReads` resolves against the child cwd and skips
    // missing files silently — a lead-mediated file handoff never fires.
    // `defaultProgress` additionally defaults into the repo cwd (litter).
    // So no emitted agent carries output:/defaultReads:/defaultProgress:.
    for (const profileId of ["cheapest", "balanced"] as const) {
      const files = buildPiAgentFiles(profileId)
      for (const content of Object.values(files)) {
        expect(content).not.toContain("output:")
        expect(content).not.toContain("defaultReads:")
        expect(content).not.toContain("defaultProgress:")
      }
      // ...which restores Explore to pure read-only (the write grant existed
      // only for the reverted bindings — observed failure otherwise).
      expect(files["agents/explore.md"]!).toContain("tools: [read, grep, find, ls, bash]")
      expect(files["agents/explore.md"]!).toContain("Never modify files.")
    }
  })

  test("delegate skill names only canonical roster agents", () => {
    const delegate = buildPiSkills({ profileId: "cheapest", peers: true, swe: true }).find(
      (s) => s.dir === "gh-delegate",
    )!
    expect(delegate.content).toContain("`Explore`")
    expect(delegate.content).toContain("`General-Purpose`")
    expect(delegate.content).toContain("`reviewer`")
    expect(delegate.content).toContain("`oracle`/`advisor`")
    expect(delegate.content).toContain("`subagent` tool")
    // Inline handoff (paste excerpts), not the reverted file chain.
    expect(delegate.content).toContain("paste the brief excerpts")
    expect(delegate.content).not.toContain("context.md")
    // Old phrasing mapped builtins parenthetically ("scout (Explore)"),
    // inviting literal invocation of agents that no longer exist. The only
    // remaining builtin mentions are the explicit disabled-note.
    expect(delegate.content).not.toContain("scout (Explore)")
    expect(delegate.content).not.toContain("(General-Purpose) to implement")
    expect(delegate.content).toContain("are disabled in this session")
  })

  test("balanced delegate omits the nonexistent advisor", () => {
    const delegate = buildPiSkills({ profileId: "balanced", peers: true, swe: true }).find(
      (s) => s.dir === "gh-delegate",
    )!
    expect(delegate.content).toContain("`oracle` for consults")
    expect(delegate.content).not.toContain("advisor")
  })

  test("peerless+swe emits no pipeline skills", () => {
    expect(buildPiSkills({ profileId: "cheapest", peers: false, swe: true })).toEqual([])
    expect(buildPiSkills({ profileId: "balanced", peers: false, swe: true })).toEqual([])
  })

  test("peerless+swe emits no review prompts", () => {
    expect(buildPiPrompts({ profileId: "cheapest", swe: true, peers: false })).toEqual([])
    // Omitted peers preserves the legacy default (emit).
    expect(buildPiPrompts({ profileId: "cheapest", swe: true }).length).toBeGreaterThan(0)
  })
})

describe("pi settings builtin disables", () => {
  test("peers launches disable shadowed/confusable builtins, keep delegate", () => {
    for (const profileId of ["cheapest", "balanced"] as const) {
      const settings = buildPiSettingsJson({ profileId, searchEnabled: false, browseEnabled: false })
      const overrides = settings.subagents?.agentOverrides
      expect(overrides?.["scout"]).toEqual({ disabled: true })
      expect(overrides?.["worker"]).toEqual({ disabled: true })
      expect(overrides?.["researcher"]).toEqual({ disabled: true })
      expect(overrides?.["evidence-auditor"]).toEqual({ disabled: true })
      // delegate stays enabled (append-mode cheap path); reviewer/oracle
      // need no entry (our same-named files shadow them).
      expect(overrides?.["delegate"]).toBeUndefined()
      expect(overrides?.["reviewer"]).toBeUndefined()
      expect(overrides?.["oracle"]).toBeUndefined()
    }
  })

  test("peerless launches emit no subagents key", () => {
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      peers: false,
    })
    expect(settings.subagents).toBeUndefined()
  })

  test("mergeSubagentsSettings deep-merges overrides, user wins", () => {
    // No inputs -> undefined (no key emitted).
    expect(mergeSubagentsSettings(undefined, undefined)).toBeUndefined()
    // Built-only passes through.
    expect(
      mergeSubagentsSettings(undefined, { agentOverrides: { scout: { disabled: true } } }),
    ).toEqual({ agentOverrides: { scout: { disabled: true } } })
    // User entries win per-agent; unrelated user subkeys survive.
    expect(
      mergeSubagentsSettings(
        { agentOverrides: { scout: { disabled: false } }, defaultModel: "x" },
        { agentOverrides: { scout: { disabled: true }, worker: { disabled: true } } },
      ),
    ).toEqual({
      defaultModel: "x",
      agentOverrides: { scout: { disabled: false }, worker: { disabled: true } },
    })
    // Corrupt user input degrades to built-only.
    expect(
      mergeSubagentsSettings("nope", { agentOverrides: { scout: { disabled: true } } }),
    ).toEqual({ agentOverrides: { scout: { disabled: true } } })
  })
})

describe("pi/claude isolation", () => {
  test("claude/serve/codex entry points never import lib/pi-*", async () => {
    // Guardrail: Pi alignment work must stay in the Pi surface. Shared
    // modules (launch registry, MCP handler, personas) are consumed, never
    // modified, by Pi changes.
    for (const entry of ["src/claude.ts", "src/serve.ts", "src/codex.ts"]) {
      const text = await Bun.file(entry).text()
      expect(text).not.toContain("lib/pi-")
    }
  })
})
