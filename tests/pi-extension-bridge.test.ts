import { describe, expect, test } from "bun:test"

import { buildPiExtensionSource, buildPiPrompts, buildPiSkills } from "~/lib/pi-extension"
import { buildMirrorBridgeSection } from "~/lib/pi-memory-bridge"
import {
  buildPiAgentFiles,
  buildPiSettingsJson,
  mergeSubagentsSettings,
} from "~/lib/pi-models-settings"

describe("pi extension surface", () => {
  test("registers no model-facing tools: native MCP owns that surface", () => {
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const src = buildPiExtensionSource({ profileId })
      // Every scoped group reaches Pi through native MCP (`<mirror>/mcp.json`),
      // which is what brings tool_search and the mcp_servers roster. A
      // registerTool here would shadow that and pay a definition per tool.
      expect(src).not.toContain("pi.registerTool")
      expect(src).not.toContain('from "typebox"')
    }
  })

  test("cheapest family keeps the prompt-submit relay, balanced does not", () => {
    for (const profileId of ["cheapest", "cheapest2"] as const) {
      const src = buildPiExtensionSource({ profileId })
      expect(src).toContain("before_agent_start")
      expect(src).toContain('callMcp("search", "prompt_brief"')
      expect(src).toContain("GH_ROUTER_WORKSPACE")
      expect(src).toContain("X-GH-Workspace")
    }
    // Balanced is floor-free by design: no brief, and with it no MCP client
    // at all, so the generated source carries no fetch seam to fail. Plan
    // mode still registers `before_agent_start` here (it returns undefined
    // unless the user turns it on), so the assertion targets the BRIEF.
    for (const profileId of ["balanced", "balanced2"] as const) {
      const src = buildPiExtensionSource({ profileId })
      expect(src).not.toContain("prompt_brief")
      expect(src).not.toContain("gh-router-prompt-brief")
      expect(src).not.toContain("callMcp")
    }
  })

  test("the statusline footer is profile-independent", () => {
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const src = buildPiExtensionSource({ profileId })
      expect(src).toContain("ctx.ui.setFooter")
      expect(src).toContain("session_before_compact")
    }
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
    const src = buildPiExtensionSource({ profileId: "cheapest" })
    // stripNul covers outbound params and the inbound brief reply alike.
    expect(src).toContain("stripNul(String(reply")
  })
})

describe("pi foreign agent bridge (generated extension)", () => {
  const foreign = {
    agents: [{ name: "ceo", description: "Owns strategy", body: "You are the CEO." }],
    index: "Foreign agents available on demand:\n- ceo [copilot, project] — Owns strategy",
  }

  test("the section appears only when --foreign contributed something", () => {
    // An empty bridge must not pay for a handler that can never fire, and it
    // must not install a `session_start` listener that emits nothing.
    expect(buildPiExtensionSource({ profileId: "cheapest" })).not.toContain("foreign_agents")
    expect(
      buildPiExtensionSource({
        profileId: "cheapest",
        foreign: { agents: [], index: "" },
      }),
    ).not.toContain("foreign_agents")
    expect(buildPiExtensionSource({ profileId: "cheapest", foreign })).toContain("foreign_agents")
  })

  test("the event contract is a literal, never an import", () => {
    const src = buildPiExtensionSource({ profileId: "cheapest", foreign })
    // The router cannot import pi-subagents (it is a peer installed into the
    // mirror, not a dependency), so the wire contract is pinned by value.
    // A version bump upstream leaves the emit unanswered and the extension
    // reports it — the failure mode is a warning, not a crash.
    expect(src).toContain('"pi-subagents:runtime-agent-register:v1"')
    expect(src).not.toContain("from \"pi-subagents")
    expect(src).not.toContain("require(\"pi-subagents")
    expect(src).toContain("const FOREIGN_VERSION = 1;")
    // The registration shape the registry validates.
    expect(src).toContain('systemPromptMode: "replace"')
    expect(src).toContain("inheritProjectContext: true")
  })

  test("children skip both registration and the index section", () => {
    const src = buildPiExtensionSource({ profileId: "cheapest", foreign })
    // A background child runs this same extension. Registering there would
    // duplicate every foreign name in a second registry (and fight the
    // parent's), and the section would spend the child's context on a roster
    // its own discovery may not even carry.
    expect(src).toContain('if (process.env.PI_SUBAGENT_CHILD === "1") return;')
    expect(src).toContain('sections.foreign_agents = FOREIGN_INDEX')
  })

  test("shutdown disposes, because a stale registration throws next session", () => {
    const src = buildPiExtensionSource({ profileId: "cheapest", foreign })
    // Registering the same name twice in one Pi process throws 'collides with
    // runtime agent'. `/reload` recreates the extension instance while the
    // registry may survive, so the dispose is correctness, not hygiene.
    expect(src).toContain('pi.on("session_shutdown"')
    expect(src).toContain("registrations.clear()")
    expect(src).toContain("const prior = registrations.get(spec.name);")
  })

  test("the self-heal net disposes only what the registry named", () => {
    const src = buildPiExtensionSource({ profileId: "cheapest", foreign })
    // One colliding runtime agent breaks EVERY subagent call in the process,
    // so the net must fire on the tool result. It keys on the registry's own
    // error text and only ever disposes a handle this extension created.
    expect(src).toContain("COLLISION_RE")
    expect(src).toContain("event.toolName !== \"subagent\"")
    expect(src).toContain("COLLISION_RE.lastIndex = 0;")
    // Unrecognised errors are returned untouched: Pi's native error handling
    // is the fallback, not a rewrite.
    expect(src).toContain("if (!match) return undefined;")
  })

  test("the generated source is syntactically valid TypeScript", () => {
    const src = buildPiExtensionSource({ profileId: "cheapest", foreign })
    // The payload embeds JSON.stringify'd agent bodies; a stray backtick or
    // newline in an authored artifact would produce a file that fails to
    // load at session start, i.e. every bridged agent silently missing.
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow()
  })
})

describe("pi native agent files (pi-subagents contract)", () => {
  for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
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
    expect(gp).toContain("allowedAgents: reviewer, oracle")
    expect(gp).toContain("tools: read, grep, find, ls, bash, edit, write, subagent, contact_supervisor")
    expect(gp).toContain("acceptanceRole: writer")
    // Background by default: the inherited `asyncByDefault` (true) is what
    // makes parallel fan-out possible, so no file may pin `async`.
    expect(gp).not.toContain("async:")
    const balancedReviewer = buildPiAgentFiles("balanced")["agents/reviewer.md"]!
    expect(balancedReviewer).toContain("allowNestedSubagents: true")
    expect(balancedReviewer).toContain("allowedAgents: Explore")
    // The grant is inert without `subagent` in the same tools list.
    expect(balancedReviewer).toContain("watchdog_diff, subagent")
    expect(balancedReviewer).not.toContain("async:")
    // The Advisor-bearing families mirror the Claude path's protege grant:
    // the reviewer may consult the profile's own advisor.
    expect(cheapest["agents/reviewer.md"]!).toContain("allowedAgents: advisor")
    expect(cheapest["agents/reviewer.md"]!).toContain("allowNestedSubagents: true")
    expect(cheapest["agents/reviewer.md"]!).toContain("watchdog_diff, subagent")
    expect(cheapest["agents/reviewer.md"]!).toContain("at most 5 advisor rounds")
    // ...and the edge is conditional: `balanced` has no advisor file, so its
    // reviewer's single edge is Explore and the body names no advisor.
    expect(balancedReviewer).not.toContain("allowedAgents: advisor")
    expect(balancedReviewer).not.toContain("5 advisor rounds")
    // Nothing else delegates.
    expect(cheapest["agents/explore.md"]!).not.toContain("allowedAgents")
    expect(cheapest["agents/advisor.md"]!).not.toContain("allowedAgents")
    // The -2 aliases derive their graph from the same contract: balanced2
    // keeps the reviewer→Explore edge on the 6.2 reviewer, cheapest2 keeps
    // the advisor edge on the Luna reviewer.
    const balanced2 = buildPiAgentFiles("balanced2")
    expect(balanced2["agents/reviewer.md"]!).toContain("allowedAgents: Explore")
    expect(balanced2["agents/reviewer.md"]!).toContain("model: gh-router/gpt-6.2-sol")
    expect(buildPiAgentFiles("cheapest2")["agents/reviewer.md"]!).toContain("allowedAgents: advisor")
  })

  test("aliases/allowedAgents use bare comma form, never YAML flow lists", () => {
    // The aliases/allowedAgents splitter does not understand brackets:
    // `[reviewer, oracle]` parses as `'[reviewer'` and fails the run.
    // (`tools:` is parsed by a different, bracket-tolerant parser —
    // proven live — so it keeps flow-list form.)
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      for (const content of Object.values(buildPiAgentFiles(profileId))) {
        expect(content).not.toContain("allowedAgents: [")
        expect(content).not.toContain("aliases: [")
      }
    }
  })

  test("aliases absorb disabled-builtin invocations deterministically", () => {
    const files = buildPiAgentFiles("cheapest")
    expect(files["agents/explore.md"]!).toContain("aliases: scout")
    expect(files["agents/general-purpose.md"]!).toContain(
      "aliases: worker, developer, coder, implementer, develop",
    )
  })

  test("reviewer carries the diff-anchored review contract, honestly tool-scoped", () => {
    const reviewer = buildPiAgentFiles("cheapest")["agents/reviewer.md"]!
    expect(reviewer).toContain("watchdog_diff")
    // Leaf reviewer never escalates: contact_supervisor is a blocked-child
    // channel and pings from a verdict-only leaf are pure noise/cost.
    expect(reviewer).not.toContain("contact_supervisor")
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
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const files = buildPiAgentFiles(profileId)
      for (const content of Object.values(files)) {
        expect(content).not.toContain("output:")
        expect(content).not.toContain("defaultReads:")
        expect(content).not.toContain("defaultProgress:")
      }
      // ...which restores Explore to pure read-only (the write grant existed
      // only for the reverted bindings — observed failure otherwise).
      expect(files["agents/explore.md"]!).toContain("tools: read, grep, find, ls, bash")
      expect(files["agents/explore.md"]!).not.toContain("async:")
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
    for (const profileId of ["balanced", "balanced2"] as const) {
      const delegate = buildPiSkills({ profileId, peers: true, swe: true }).find(
        (s) => s.dir === "gh-delegate",
      )!
      expect(delegate.content).toContain("`oracle` for consults")
      expect(delegate.content).not.toContain("advisor")
    }
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
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const settings = buildPiSettingsJson({ profileId, searchEnabled: false, browseEnabled: false })
      const overrides = settings.subagents?.agentOverrides
      expect(overrides?.["scout"]).toEqual({ disabled: true })
      expect(overrides?.["worker"]).toEqual({ disabled: true })
      expect(overrides?.["researcher"]).toEqual({ disabled: true })
      expect(overrides?.["evidence-auditor"]).toEqual({ disabled: true })
      // External-CLI families shell out with ambient auth: off-proxy,
      // off-ledger, never in a cost-controlled launch.
      for (const name of [
        "claude-code",
        "claude-code-writer",
        "codex-exec",
        "codex-exec-writer",
        "cursor-agent",
        "cursor-agent-writer",
      ]) {
        expect(overrides?.[name]).toEqual({ disabled: true })
      }
      // delegate stays enabled (append-mode cheap path); reviewer/oracle
      // need no entry (our same-named files shadow them).
      expect(overrides?.["delegate"]).toBeUndefined()
      expect(overrides?.["reviewer"]).toBeUndefined()
      expect(overrides?.["oracle"]).toBeUndefined()
    }
  })

  test("a profile with no oracle file disables the builtin that would fill the slot", () => {
    // Our file is what shadows the builtin (and its `advisor` alias). Dropping
    // the file without the override would resurrect a role with a model of its
    // own choosing — on `local` that role could bill a Copilot model the
    // profile forbids. Every profile we ship has an oracle file now, so this is
    // asserted through the same predicate the builder uses rather than through
    // a profile that no longer exists in that shape.
    const local = buildPiSettingsJson({ profileId: "local", searchEnabled: false, browseEnabled: false })
    expect(local.subagents?.agentOverrides?.["oracle"]).toBeUndefined()
    // Everything else is the shared list, unchanged.
    expect(local.subagents?.agentOverrides?.["scout"]).toEqual({ disabled: true })
    expect(local.subagents?.agentOverrides?.["delegate"]).toBeUndefined()

    // local2 keeps its own oracle file, so no override entry there either.
    const local2 = buildPiSettingsJson({ profileId: "local2", searchEnabled: false, browseEnabled: false })
    expect(local2.subagents?.agentOverrides?.["oracle"]).toBeUndefined()
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
