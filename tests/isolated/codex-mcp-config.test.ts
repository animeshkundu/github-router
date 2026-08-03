import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

import {
  buildAgentMd,
  buildPeerAgentDefinitions,
  buildPeerMcpConfig,
  BUILTIN_SUBAGENT_DEFINITIONS,
  injectPeerMcpIntoMirror,
  resolveCodexCliBackend,
  resolveGroupKeysFromMirror,
  writePeerMcpRuntimeFiles,
} from "../../src/lib/codex-mcp-config"
import { PEER_AGENT_MD_FILENAME } from "../../src/lib/paths"
import { MCP_GROUPS } from "../../src/lib/peer-mcp-personas"

const NONCE = "0".repeat(64)
const URL = "http://127.0.0.1:18787"

// Use a fixed `/tmp` prefix instead of `os.tmpdir()`. This file and
// `tests/isolated/lib-paths.test.ts` (which mocks `node:os` to stub
// `homedir()`) each run in their own process under `tests/isolated/`, so
// that mock can no longer leak here — the fixed root is just for a
// predictable, TMPDIR-overridable path, not a cross-file workaround.
const TEST_TMP_ROOT = process.env.TMPDIR?.replace(/\/$/, "") ?? "/tmp"

async function makeTempDir(prefix: string): Promise<string> {
  const suffix = randomBytes(8).toString("hex")
  const dir = path.join(TEST_TMP_ROOT, `github-router-${prefix}-${suffix}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function withTempRuntimeDir<T>(
  fn: (runtimeDir: string, codexHome: string, agentsDir: string) => Promise<T>,
): Promise<T> {
  const runtimeDir = await makeTempDir("mcp-cfg")
  await fs.chmod(runtimeDir, 0o700)
  const codexHome = await makeTempDir("codex-home")
  // Phase 2.5: writePeerMcpRuntimeFiles also writes .md files into an
  // agents dir (default ~/.claude/agents). Tests MUST pass an explicit
  // tempdir so they don't pollute the user's real agents directory.
  const agentsDir = await makeTempDir("agents")
  try {
    return await fn(runtimeDir, codexHome, agentsDir)
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {})
    await fs.rm(agentsDir, { recursive: true, force: true }).catch(() => {})
  }
}

describe("buildAgentMd", () => {
  test("emits model frontmatter only when model is set", () => {
    const withModel = buildAgentMd({
      name: "implementer",
      description: "Implementation agent",
      prompt: "Implement the change.",
      model: "gpt-5.5",
    })
    expect(withModel).toContain(
      "---\nname: implementer\ndescription: \"Implementation agent\"\nmodel: \"gpt-5.5\"\n---\n",
    )

    const withoutModel = buildAgentMd({
      name: "codex-critic",
      description: "Review agent",
      prompt: "Review the change.",
    })
    expect(withoutModel).toContain(
      "---\nname: codex-critic\ndescription: \"Review agent\"\n---\n",
    )
    expect(withoutModel).not.toContain("\nmodel:")
  })

  test("mcpServers emits a parseable inline-map YAML list (claude-code#30280 workaround)", () => {
    const md = buildAgentMd({
      name: "worker-implement",
      description: "Dispatch worker",
      prompt: "Call the tool.",
      tools: ["mcp__workers__*"],
      mcpServers: {
        "gh-router-workers": {
          type: "http",
          url: "http://127.0.0.1:18787/mcp/workers",
          headers: { Authorization: `Bearer ${NONCE}` },
          headersHelper: `"C:${String.fromCharCode(92)}node.exe" internal-workspace-header`,
        },
      },
    })
    const yamlSrc = md.split("---")[1]!
    const fm = parseYaml(yamlSrc) as {
      tools: Array<string>
      mcpServers: Array<Record<string, {
        type: string
        url: string
        headers: { Authorization: string }
        headersHelper: string
      }>>
    }
    // Inline-map SEQUENCE form (a bare-name reference would re-trigger #30280).
    expect(Array.isArray(fm.mcpServers)).toBe(true)
    expect(Object.keys(fm.mcpServers[0]!)).toEqual(["gh-router-workers"])
    const entry = fm.mcpServers[0]!["gh-router-workers"]!
    expect(entry.type).toBe("http")
    expect(entry.url).toBe("http://127.0.0.1:18787/mcp/workers")
    expect(entry.headers.Authorization).toBe(`Bearer ${NONCE}`)
    // Windows-path headersHelper survives the round-trip intact.
    expect(entry.headersHelper).toContain("internal-workspace-header")
    // tools + mcpServers compose (connect-then-restrict).
    expect(fm.tools).toEqual(["mcp__workers__*"])
  })
})

describe("buildPeerMcpConfig", () => {
  test("HTTP backend emits one scoped http entry per group in groupKeys", () => {
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: false,
      geminiAvailable: true,
      groupKeys: { peers: "peers", search: "search", workers: "workers", decide: "decide" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    // One mcpServers entry per group present in groupKeys, keyed by the
    // resolved (here bare) key, each pointing at its scoped /mcp/<group>.
    expect(Object.keys(cfg.mcpServers).sort()).toEqual([
      "decide",
      "peers",
      "search",
      "workers",
    ])
    for (const group of ["peers", "search", "workers", "decide"]) {
      const entry = cfg.mcpServers[group] as {
        type: "http"
        url: string
        headers: Record<string, string>
        headersHelper?: string
      }
      expect(entry.type).toBe("http")
      expect(entry.url).toBe(`${URL}/mcp/${group}`)
      expect(entry.headers.Authorization).toBe(`Bearer ${NONCE}`)
      expect(entry.headersHelper).toBeUndefined()
    }
  })

  test("workspaceHeaderCmd is emitted on each HTTP entry but not the codex-cli stdio entry", () => {
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: true,
      geminiAvailable: true,
      groupKeys: { peers: "peers", search: "search" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
      workspaceHeaderCmd: "workspace-header-cmd",
    })
    const peers = cfg.mcpServers.peers as { type: "http"; headersHelper?: string }
    const search = cfg.mcpServers.search as { type: "http"; headersHelper?: string }
    const cli = cfg.mcpServers["codex-cli"] as { command: string; headersHelper?: string }
    expect(peers.headersHelper).toBe("workspace-header-cmd")
    expect(search.headersHelper).toBe("workspace-header-cmd")
    expect(cli.command).toBe("codex")
    expect(cli.headersHelper).toBeUndefined()
  })

  test("collision fallback key still maps to the canonical scoped URL", () => {
    // resolveGroupKeysFromMirror hands back a `gh-router-<group>` key when
    // the bare key collided with a user entry. The url suffix is ALWAYS
    // the canonical group name regardless of the resolved config key.
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: false,
      geminiAvailable: true,
      groupKeys: { peers: "gh-router-peers", browser: "gh-router-browser" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(cfg.mcpServers).sort()).toEqual([
      "gh-router-browser",
      "gh-router-peers",
    ])
    const peers = cfg.mcpServers["gh-router-peers"] as { url: string }
    expect(peers.url).toBe(`${URL}/mcp/peers`)
    const browser = cfg.mcpServers["gh-router-browser"] as { url: string }
    expect(browser.url).toBe(`${URL}/mcp/browser`)
  })

  test("CLI backend adds codex-cli stdio entry with provider flags + env", () => {
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: true,
      geminiAvailable: true,
      groupKeys: { peers: "peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex-isolated",
    })
    expect(Object.keys(cfg.mcpServers).sort()).toEqual([
      "codex-cli",
      "peers",
    ])
    const cli = cfg.mcpServers["codex-cli"] as {
      command: string
      args: Array<string>
      env: Record<string, string>
    }
    expect(cli.command).toBe("codex")
    expect(cli.args[0]).toBe("mcp-server")
    // Provider config flags follow.
    expect(cli.args).toContain("-c")
    expect(cli.args).toContain("model_provider=github_router")
    const providerCfg = cli.args.find((a) =>
      a.startsWith("model_providers.github_router="),
    )
    expect(providerCfg).toContain(`base_url="${URL}/v1"`)
    expect(providerCfg).toContain('wire_api="responses"')

    expect(cli.env).toEqual({
      OPENAI_BASE_URL: `${URL}/v1`,
      OPENAI_API_KEY: "dummy",
      CODEX_HOME: "/tmp/codex-isolated",
    })
  })
})

describe("buildPeerAgentDefinitions", () => {
  test("HTTP backend with gemini = 5 personas + coordinator + 4 always-on native subagents (10 total)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      groupKeys: { peers: "peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "brainstorm",
      "codex-critic",
      "codex-reviewer",
      "gemini-critic",
      "gemini-reviewer",
      "implementer",
      "opus-critic",
      "peer-review-coordinator",
      "reviewer",
      "scribe",
    ])
    // Each persona prompt routes to the HTTP MCP server name; the
    // coordinator prompt does NOT route to mcp tools directly (it
    // delegates to the persona subagents instead).
    for (const name of ["codex-critic", "codex-reviewer", "gemini-critic", "gemini-reviewer", "opus-critic"]) {
      expect(agents[name]!.prompt).toContain("mcp__peers__")
      expect(agents[name]!.description.length).toBeGreaterThan(0)
    }
    expect(agents["peer-review-coordinator"]!.description).toContain("Use proactively")
    // Cold-start contract: the coordinator's load-bearing sentence
    // ("peers are fresh-context") is the ONLY place that explains *why*
    // artifacts must be passed verbatim. Per-persona descriptions only
    // carry the bare imperative; this is where the reasoning lives.
    // Cross-lab smoke-test feedback flagged this assertion as missing.
    expect(agents["peer-review-coordinator"]!.description).toContain("verbatim")
    expect(agents["peer-review-coordinator"]!.description).toContain("fresh-context")
    expect(agents["peer-review-coordinator"]!.prompt).toContain("codex-critic")
    expect(agents["peer-review-coordinator"]!.prompt).toContain("opus-critic")
  })

  test("HTTP backend without gemini drops gemini-critic but keeps coordinator", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "brainstorm",
      "codex-critic",
      "codex-reviewer",
      "implementer",
      "opus-critic",
      "peer-review-coordinator",
      "reviewer",
      "scribe",
    ])
    expect(agents["gemini-critic"]).toBeUndefined()
    // Coordinator prompt should NOT reference gemini-critic when not registered.
    expect(agents["peer-review-coordinator"]!.prompt).toContain("NOT REGISTERED")
    // opus-critic is always registered (Anthropic models always present),
    // so the coordinator's routing-rules block must mention it regardless
    // of whether gemini is available.
    expect(agents["peer-review-coordinator"]!.prompt).toContain("opus-critic")
  })

  test("CLI backend with gemini = 6 personas + coordinator + 4 native subagents (11 total)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: true,
      geminiAvailable: true,
      groupKeys: { peers: "peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "brainstorm",
      "codex-critic",
      "codex-implementer",
      "codex-reviewer",
      "gemini-critic",
      "gemini-reviewer",
      "implementer",
      "opus-critic",
      "peer-review-coordinator",
      "reviewer",
      "scribe",
    ])
    // codex-* personas point at the stdio server; gemini-critic stays HTTP.
    expect(agents["codex-critic"]!.prompt).toContain("mcp__codex-cli__codex")
    expect(agents["gemini-critic"]!.prompt).toContain(
      "mcp__peers__gemini_critic",
    )
    expect(agents["codex-implementer"]!.prompt).toContain('"workspace-write"')
    // opus-critic.requiresHttp = true (codex-cli stdio bridge can't run
    // claude-opus-4-6 — gpt-5/codex models only). Even in CLI mode, opus
    // routes via HTTP. Verify the prompt routes to the HTTP backend tool
    // and does NOT mention codex-cli for this persona.
    expect(agents["opus-critic"]).toBeDefined()
    expect(agents["opus-critic"]!.prompt).toContain(
      "mcp__peers__opus_critic",
    )
    expect(agents["opus-critic"]!.prompt).not.toContain("mcp__codex-cli__codex")
  })

  test("collision-fallback peers key threads into the persona routing string", () => {
    // When the user already has a `peers` MCP, resolveGroupKeysFromMirror
    // hands back `gh-router-peers` for the peers group. That resolved key
    // MUST appear in the routing string so the subagent calls OUR server,
    // not the user's.
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      groupKeys: { peers: "gh-router-peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(agents["codex-critic"]!.prompt).toContain(
      "mcp__gh-router-peers__codex_critic",
    )
    expect(agents["opus-critic"]!.prompt).toContain(
      "mcp__gh-router-peers__opus_critic",
    )
  })

  test("workerToolsAvailable adds the 5 core worker-* dispatchers, each pinned to its one tool", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "workers" },
      workerToolsAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    for (const mode of ["explore", "implement", "review", "plan", "test"]) {
      const name = `worker-${mode}`
      expect(agents[name]).toBeDefined()
      // Pinned to the workers server wildcard (no Agent/Read/Bash → no recursion).
      expect(agents[name]!.tools).toEqual(["mcp__workers__*"])
      expect(agents[name]!.prompt).toContain(`mcp__workers__${mode}`)
      expect(agents[name]!.description).toContain("Use proactively")
    }
    // No browse dispatcher unless browseAvailable.
    expect(agents["worker-browse"]).toBeUndefined()
  })

  test("with serverUrl, dispatchers inline the workers server and personas inline peers (claude-code#30280)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "workers" },
      workerToolsAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
      serverUrl: URL,
    })
    // Worker dispatcher: inline `workers` HTTP server + restrictive tools.
    const wImpl = agents["worker-implement"]!
    expect(wImpl.tools).toEqual(["mcp__workers__*"])
    expect(wImpl.mcpServers).toBeDefined()
    const wEntry = wImpl.mcpServers!["workers"]!
    expect(wEntry.type).toBe("http")
    expect(wEntry.url).toBe(`${URL}/mcp/workers`)
    expect(wEntry.headers.Authorization).toBe(`Bearer ${NONCE}`)
    // Peer persona: inline `peers` HTTP server, no restrictive tools allowlist.
    const critic = agents["codex-critic"]!
    expect(critic.tools).toBeUndefined()
    expect(critic.mcpServers!["peers"]!.url).toBe(`${URL}/mcp/peers`)
    expect(critic.mcpServers!["peers"]!.headers.Authorization).toBe(`Bearer ${NONCE}`)
    // Coordinator also gets peers.
    expect(agents["peer-review-coordinator"]!.mcpServers!["peers"]!.url).toBe(`${URL}/mcp/peers`)
  })

  test("without serverUrl, no mcpServers frontmatter is emitted (backward-compatible)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "workers" },
      workerToolsAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(agents["worker-implement"]!.mcpServers).toBeUndefined()
    expect(agents["codex-critic"]!.mcpServers).toBeUndefined()
  })

  test("collision-fallback workers key is the inline mcpServers key too", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "gh-router-peers", workers: "gh-router-workers" },
      workerToolsAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
      serverUrl: URL,
    })
    const wImpl = agents["worker-implement"]!
    // Map key is the RESOLVED fallback key; the URL still targets /mcp/workers.
    expect(Object.keys(wImpl.mcpServers!)).toEqual(["gh-router-workers"])
    expect(wImpl.mcpServers!["gh-router-workers"]!.url).toBe(`${URL}/mcp/workers`)
  })

  test("no worker-* dispatchers when workerToolsAvailable is falsy (default)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "workers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).some((k) => k.startsWith("worker-"))).toBe(false)
  })

  test("native subagents are always injected (except scout); models set per agent", () => {
    const withNative = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers" },
      nativeSubagentModel: "gpt-5.5",
      reviewerModel: "gemini-3.1-pro-preview",
      brainstormModel: "gemini-3.1-pro-preview",
      scoutModel: "gemini-3.6-flash",
      scribeModel: "gpt-5.6-terra",
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    const expected = {
      implementer: { description: "Bounded implementation", model: "gpt-5.5", readOnly: false },
      // Cross-lab by design: reviewer must NOT resolve to implementer's model,
      // or a review of implementer-produced work is one model checking itself.
      reviewer: { description: "Feedback subagent", model: "gemini-3.1-pro-preview", readOnly: false },
      brainstorm: { description: "Divergent-options", model: "gemini-3.1-pro-preview", readOnly: true },
      scout: { description: "Read-only exploration", model: "gemini-3.6-flash", readOnly: true },
      scribe: { description: "Documentation subagent", model: "gpt-5.6-terra", readOnly: false },
    }
    for (const [name, want] of Object.entries(expected)) {
      const def = withNative[name]!
      expect(def).toBeDefined()
      expect(def.model).toBe(want.model)
      expect(def.description).toContain(want.description)
      expect(def.description).toContain("Model is overridable at spawn")
      // Only the read-only pair carries a `tools:` allowlist; the rest inherit
      // the parent's full toolset (see the cc-backup schema-parity test below).
      expect("tools" in def).toBe(want.readOnly)
      if (want.readOnly) {
        expect(def.tools).toContain("Read")
        expect(def.tools).toContain("Bash")
        expect(def.tools).not.toContain("Edit")
        expect(def.tools).not.toContain("Write")
      }
    }

    // No model in the catalog → the natives are STILL injected (no gating) but
    // omit the `model` frontmatter so they inherit the lead's model. `scout` is
    // the deliberate exception: it is dropped entirely rather than silently
    // answering cheap-tier questions on the lead's expensive model.
    const withoutModel = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers" },
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    for (const name of ["implementer", "reviewer", "brainstorm", "scribe"]) {
      const def = withoutModel[name]!
      expect(def).toBeDefined()
      expect("model" in def).toBe(false)
      expect(def.description).toContain("Model is overridable at spawn")
    }
    expect(withoutModel.scout).toBeUndefined()
  })

  test("brainstorm's prompt carries the sounding-board contract (verdicts + feasibility screen)", () => {
    // These three properties are the whole reason brainstorm differs from a
    // generic ideation prompt, and each is load-bearing for a measured reason.
    //
    // Verdict vocabulary: the caller may pass its leading approach, and the
    // agent must return a neutral verdict rather than reflexive dissent.
    // Explicit devil's-advocate framing reliably produces >99% disagreement,
    // which measures instruction compliance, not judgment, so `retain` has to
    // be a first-class answer. This mirrors CRITIC_RUBRIC's existing stance.
    //
    // Feasibility screen: across four observed runs, two recommendations had a
    // sound mechanism but an unexecutable concrete path (a TTY guard that
    // refuses the proposed command; an npm package that does not exist on this
    // machine). Screening every candidate, not just the winner, is what catches
    // that and avoids selection bias in the ranking.
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers" },
      brainstormModel: "gemini-3.1-pro-preview",
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    const prompt = agents.brainstorm!.prompt
    for (const verdict of ["`replace`", "`retain`", "`insufficient evidence`"]) {
      expect(prompt).toContain(verdict)
    }
    expect(prompt).toContain("Manufactured disagreement")
    expect(prompt).toContain("EVERY candidate")
    expect(prompt).toContain("cannot execute is worse than no recommendation")
    // The caller has to know what to pass, or the agent cannot target the
    // lead's blind spot; that contract lives in the description.
    expect(agents.brainstorm!.description).toContain("leading approach")
  })

  test("reviewer never resolves to implementer's model (cross-lab invariant)", () => {
    // The defect this pins: `reviewer` used to share `nativeSubagentModel()` with
    // `implementer`, so whenever `implementer` produced the artifact the default
    // review path was one model checking its own output. Not same lab, the same
    // model. Two independent blind audits flagged it, and the repo already
    // applies the opposite rule to `worker-review`.
    //
    // The guard is deliberately about the RESOLVER wiring, not a hardcoded slug:
    // a future model refresh may move both, and this still fails if they are ever
    // pointed at one resolver again.
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      groupKeys: { peers: "peers" },
      nativeSubagentModel: "gpt-5.6-sol",
      reviewerModel: "gemini-3.1-pro-preview",
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(agents.implementer!.model).toBe("gpt-5.6-sol")
    expect(agents.reviewer!.model).toBe("gemini-3.1-pro-preview")
    expect(agents.reviewer!.model).not.toBe(agents.implementer!.model)
    // The description has to say WHY it is the right pick over a peer critic,
    // because a live session picked `codex_reviewer` for an assess-this task.
    expect(agents.reviewer!.description).toContain("DIFFERENT lab")
    expect(agents.reviewer!.description).toContain("can RUN things")
    // And the stale same-model disclosure must be gone: it would now be false.
    expect(agents.reviewer!.prompt).not.toContain("same model as the `implementer`")
  })

  test("sweep allowlist covers every emitted subagent definition", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: true,
      geminiAvailable: true,
      groupKeys: { peers: "peers", workers: "workers" },
      workerToolsAvailable: true,
      browseAvailable: true,
      nativeSubagentModel: "gpt-5.5",
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    for (const name of Object.keys(agents)) {
      expect(PEER_AGENT_MD_FILENAME.test(`peer-123-${"a".repeat(8)}-${name}.md`)).toBe(true)
    }
  })

  test("browseAvailable adds worker-browse", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "workers" },
      workerToolsAvailable: true,
      browseAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(agents["worker-browse"]).toBeDefined()
    expect(agents["worker-browse"]!.tools).toEqual(["mcp__workers__*"])
  })

  test("collision-fallback workers key threads into the dispatcher tool + prompt", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      groupKeys: { peers: "peers", workers: "gh-router-workers" },
      workerToolsAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(agents["worker-implement"]!.tools).toEqual(["mcp__gh-router-workers__*"])
    expect(agents["worker-implement"]!.prompt).toContain("mcp__gh-router-workers__implement")
  })
})

describe("resolveCodexCliBackend", () => {
  test("not requested → http", () => {
    expect(
      resolveCodexCliBackend({ requested: false, codexInfo: null }),
    ).toBe("http")
  })

  test("requested but codex missing → http (with warning)", () => {
    expect(
      resolveCodexCliBackend({ requested: true, codexInfo: { ok: false } }),
    ).toBe("http")
  })

  test("requested with codex 0.129+ → cli", () => {
    expect(
      resolveCodexCliBackend({
        requested: true,
        codexInfo: { ok: true, version: "0.129.0" },
      }),
    ).toBe("cli")
  })

  test("requested with codex 0.128.x → http (downgraded)", () => {
    expect(
      resolveCodexCliBackend({
        requested: true,
        codexInfo: { ok: false, version: "0.128.5" },
      }),
    ).toBe("http")
  })
})

describe("writePeerMcpRuntimeFiles", () => {
  test("writes mcp-config + agents tempfiles with mode 0o600 and PID+random-suffix names + .md subagent files", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers", search: "search" },
        runtimeDir,
        codexHome,
        agentsDir,
      })

      // Filenames are PID-prefixed (so the boot sweep can identify them)
      // and random-suffixed (so concurrent in-process calls can't collide).
      expect(runtime.mcpConfigPath).toMatch(
        new RegExp(
          `peer-mcp-${process.pid}-[0-9a-f]{8}\\.json$`,
        ),
      )
      expect(runtime.agentsPath).toMatch(
        new RegExp(
          `peer-agents-${process.pid}-[0-9a-f]{8}\\.json$`,
        ),
      )
      expect(path.dirname(runtime.mcpConfigPath)).toBe(runtimeDir)
      expect(path.dirname(runtime.agentsPath)).toBe(runtimeDir)

      // Phase 2.5: .md subagent files written into agentsDir, one per
      // registered agent (5 personas + peer-review-coordinator + 4 always-on
      // native subagents implementer/reviewer/brainstorm/scribe = 10; `scout`
      // needs a cheap-tier model, which this call does not supply).
      expect(runtime.agentMdPaths.length).toBe(10)
      for (const p of runtime.agentMdPaths) {
        expect(path.dirname(p)).toBe(agentsDir)
        expect(p).toMatch(
          new RegExp(`peer-${process.pid}-[0-9a-f]{8}-[a-z-]+\\.md$`),
        )
        const stat = await fs.stat(p)
        if (process.platform !== "win32") {
          expect(stat.mode & 0o777).toBe(0o600)
        }
      }

      // The coordinator .md must contain the "Use proactively" trigger
      // and the canonical agent name in frontmatter.
      const coordPath = runtime.agentMdPaths.find((p) =>
        p.endsWith("peer-review-coordinator.md"),
      )!
      const coordBody = await fs.readFile(coordPath, "utf8")
      expect(coordBody).toMatch(/^---\nname: peer-review-coordinator\n/)
      expect(coordBody).toContain("Use proactively")

      // Files exist + permissions
      const mcpStat = await fs.stat(runtime.mcpConfigPath)
      const agentsStat = await fs.stat(runtime.agentsPath)
      if (process.platform !== "win32") {
        expect(mcpStat.mode & 0o777).toBe(0o600)
        expect(agentsStat.mode & 0o777).toBe(0o600)
      }

      // Nonce is 32-byte hex (64 chars) and embedded as Bearer header
      expect(runtime.nonce).toMatch(/^[0-9a-f]{64}$/)
      const cfg = JSON.parse(
        await fs.readFile(runtime.mcpConfigPath, "utf8"),
      ) as {
        mcpServers: Record<string, { url: string; headers: { Authorization: string } }>
      }
      // One scoped entry per group we passed in groupKeys.
      expect(Object.keys(cfg.mcpServers).sort()).toEqual(["peers", "search"])
      expect(cfg.mcpServers["peers"]!.url).toBe(`${URL}/mcp/peers`)
      expect(cfg.mcpServers["search"]!.url).toBe(`${URL}/mcp/search`)
      expect(cfg.mcpServers["peers"]!.headers.Authorization).toBe(
        `Bearer ${runtime.nonce}`,
      )

      // Cleanup unlinks both JSON tempfiles AND all .md files
      await runtime.cleanup()
      await expect(fs.stat(runtime.mcpConfigPath)).rejects.toThrow()
      await expect(fs.stat(runtime.agentsPath)).rejects.toThrow()
      for (const p of runtime.agentMdPaths) {
        await expect(fs.stat(p)).rejects.toThrow()
      }
    })
  })

  test("builtinSubagents (serve) registers Explore/Plan/general-purpose .md files with capitalized names", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      // Base run WITHOUT builtinSubagents — the peer/coordinator/native-subagent
      // set (its size grows as master adds native subagents, so compute it).
      const base = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers", search: "search" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      const baseCount = base.agentMdPaths.length
      await base.cleanup()

      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers", search: "search" },
        runtimeDir,
        codexHome,
        agentsDir,
        builtinSubagents: BUILTIN_SUBAGENT_DEFINITIONS,
      })
      const names = runtime.agentMdPaths.map((p) => path.basename(p))
      // builtinSubagents adds EXACTLY the 3 built-ins on top of the base set.
      expect(runtime.agentMdPaths.length).toBe(baseCount + 3)
      expect(names.some((n) => n.endsWith("-Explore.md"))).toBe(true)
      expect(names.some((n) => n.endsWith("-Plan.md"))).toBe(true)
      expect(names.some((n) => n.endsWith("-general-purpose.md"))).toBe(true)
      // The frontmatter `name:` must equal the exact `subagent_type` the model
      // calls (capitalized) — otherwise the Task enum wouldn't resolve it.
      const explore = runtime.agentMdPaths.find((p) => p.endsWith("-Explore.md"))!
      const body = await fs.readFile(explore, "utf8")
      expect(body).toMatch(/^---\nname: Explore\n/)
      await runtime.cleanup()
      for (const p of runtime.agentMdPaths) {
        await expect(fs.stat(p)).rejects.toThrow()
      }
    })
  })

  test("two consecutive invocations produce distinct nonces", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const a = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      // Cleanup not strictly required now (random suffix prevents collision)
      // but kept to exercise the cleanup path.
      await a.cleanup()
      const b = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      await b.cleanup()
      expect(a.nonce).not.toBe(b.nonce)
    })
  })

  test("re-runs in the same PID produce DIFFERENT files (random-suffix collision avoidance)", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const a = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      // Don't cleanup. Second call must NOT collide with first call's
      // files — random-suffix guarantees uniqueness within a process.
      const b = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      expect(a.mcpConfigPath).not.toBe(b.mcpConfigPath)
      expect(a.agentsPath).not.toBe(b.agentsPath)
      expect(b.nonce).not.toBe(a.nonce)
      // .md paths also distinct
      expect(a.agentMdPaths).not.toEqual(b.agentMdPaths)
      // Both sets of files exist and are independently cleanupable.
      await fs.access(a.mcpConfigPath)
      await fs.access(b.mcpConfigPath)
      await a.cleanup()
      await b.cleanup()
    })
  })

  test("invalid agent name (Phase 2.6 path-traversal/YAML defense) → throws + cleans up partials", async () => {
    // Defense against a future contributor wiring in a dynamic agent name
    // from outside (--agent flag, MCP tool registration, etc.). The
    // VALID_AGENT_NAME regex is the load-bearing protection; this test
    // pins the contract.
    await withTempRuntimeDir(async (_runtimeDir, _codexHome, agentsDir) => {
      const { writePeerAgentMdFiles } = await import(
        "../../src/lib/codex-mcp-config"
      )
      // First valid agent succeeds and writes; second has an invalid
      // name (contains "/" — would be a path-traversal vector). The
      // function must throw AND clean up the first file (no orphans).
      const ok = path.join(
        agentsDir,
        `peer-${process.pid}-cafef00d-codex-critic.md`,
      )
      await expect(
        writePeerAgentMdFiles(
          {
            "codex-critic": { description: "ok", prompt: "ok" },
            "../../etc/passwd": { description: "bad", prompt: "bad" },
          },
          { agentsDir, fileSuffix: `${process.pid}-cafef00d` },
        ),
      ).rejects.toThrow(/invalid agent name/)
      // Validator runs BEFORE any file is written — orphan check is
      // moot for the all-invalid case, but the test ensures we don't
      // even start writing when validation fails.
      await expect(fs.stat(ok)).rejects.toThrow()
    })
  })

  test("YAML escape extends to CR, tab, control chars (Phase 2.6)", async () => {
    // Strict YAML 1.2 parsers reject raw \r in double-quoted scalars;
    // most parsers tolerate it but we shouldn't depend on tolerance.
    // Same for \t and other C0 controls.
    const { writePeerAgentMdFiles } = await import(
      "../../src/lib/codex-mcp-config"
    )
    await withTempRuntimeDir(async (_runtimeDir, _codexHome, agentsDir) => {
      const result = await writePeerAgentMdFiles(
        {
          "codex-critic": {
            // intentionally pathological — CR, tab, BEL, DEL all in description
            description: "line1\rline2\twith\x07bell\x7Fand\x00null",
            prompt: "system prompt",
          },
        },
        { agentsDir, fileSuffix: `${process.pid}-deadbeef` },
      )
      const body = await fs.readFile(result.paths[0]!, "utf8")
      expect(body).toContain("\\r")
      expect(body).toContain("\\t")
      expect(body).toContain("\\x07")
      expect(body).toContain("\\x7f")
      expect(body).toContain("\\x00")
      // Raw CR/tab/control chars MUST NOT appear inside the
      // double-quoted YAML scalar.
      const frontmatter = body.split("---")[1] ?? ""
      expect(frontmatter).not.toMatch(
        // The regex deliberately matches the control-char range we just
        // proved is escaped above; no-control-regex doesn't apply here.
        // eslint-disable-next-line no-control-regex
        /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/,
      )
      // Real CR/tab in body lines OUTSIDE frontmatter are fine — the
      // body is not YAML, just markdown.
      await result.cleanup()
    })
  })

  test("concurrent proxy launches: A's cleanup() does NOT touch B's .md files", async () => {
    // Critical isolation invariant raised by user + cross-lab review:
    // when two `github-router claude` processes run simultaneously,
    // closing/cleaning up proxy A MUST NOT delete proxy B's .md files.
    //
    // Mechanism: each call to writePeerAgentMdFiles closes over a local
    // `paths` array containing only THAT launch's files; cleanup() does
    // `fs.unlink(p)` for each path in its own closure, never iterates
    // the directory. So A's cleanup is physically incapable of touching
    // B's files. This test pins that contract.
    const { writePeerAgentMdFiles } = await import(
      "../../src/lib/codex-mcp-config"
    )
    await withTempRuntimeDir(async (_runtimeDir, _codexHome, agentsDir) => {
      // Two distinct fileSuffix values simulate two concurrent proxies
      // (different PIDs and/or different random suffixes — same agents
      // dir, same agent NAMES, but different filenames).
      const a = await writePeerAgentMdFiles(
        {
          "codex-critic": { description: "A's persona", prompt: "A's prompt" },
          "peer-review-coordinator": {
            description: "A's coordinator",
            prompt: "A's prompt",
          },
        },
        { agentsDir, fileSuffix: `${process.pid}-aaaa1111` },
      )
      const b = await writePeerAgentMdFiles(
        {
          "codex-critic": { description: "B's persona", prompt: "B's prompt" },
          "peer-review-coordinator": {
            description: "B's coordinator",
            prompt: "B's prompt",
          },
        },
        { agentsDir, fileSuffix: `${process.pid}-bbbb2222` },
      )
      // Sanity: both sides wrote their own files.
      expect(a.paths.length).toBe(2)
      expect(b.paths.length).toBe(2)
      for (const p of [...a.paths, ...b.paths]) {
        await fs.access(p)
      }
      expect(new Set([...a.paths, ...b.paths]).size).toBe(4) // all distinct

      // Close proxy A. Verify A's files gone, B's files survive.
      await a.cleanup()
      for (const p of a.paths) {
        await expect(fs.stat(p)).rejects.toThrow()
      }
      for (const p of b.paths) {
        await expect(fs.stat(p)).resolves.toBeDefined()
      }

      // Close proxy B. Verify clean exit.
      await b.cleanup()
      for (const p of b.paths) {
        await expect(fs.stat(p)).rejects.toThrow()
      }
    })
  })

  test("personas list reflects mode (codexCli adds implementer)", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const httpMode = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      const cliMode = await writePeerMcpRuntimeFiles(URL, {
        codexCli: true,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      const httpNames = httpMode.personas.map((p) => p.agentName).sort()
      const cliNames = cliMode.personas.map((p) => p.agentName).sort()
      expect(httpNames).toEqual([
        "codex-critic",
        "codex-reviewer",
        "gemini-critic",
        "gemini-reviewer",
        "opus-critic",
      ])
      expect(cliNames).toEqual([
        "codex-critic",
        "codex-implementer",
        "codex-reviewer",
        "gemini-critic",
        "gemini-reviewer",
        "opus-critic",
      ])
      await httpMode.cleanup()
      await cliMode.cleanup()
    })
  })
})

// --- Phase C P0.3: Zod-validation against cc-backup loadAgentsDir.ts schema ---

/**
 * Mirror of cc-backup/src/tools/AgentTool/loadAgentsDir.ts's MINIMUM
 * frontmatter requirements for `parseAgentFromMarkdown` (the function
 * Claude Code calls when scanning ~/.claude/agents/*.md at session start).
 *
 * Required fields (returns null + logs error if missing):
 *   - `name` (non-empty string) — line 547-549 of loadAgentsDir.ts
 *   - `description` (non-empty string) — line 552-558
 *
 * Optional fields are silently defaulted or warn-and-default. The cc-
 * backup schema is NOT .strict() — unknown frontmatter keys are ignored.
 * This test validates the router's emission against the REQUIRED set so
 * we don't regress into a "subagent silently fails to load" state.
 *
 * The body (post-frontmatter content) becomes `systemPrompt` after
 * trimming. Must be non-empty for the agent to function — line 712
 * `const systemPrompt = content.trim()`.
 */
const ClaudeCodeAgentMdFrontmatterSchema = z.object({
  name: z.string().min(1, "name field is required and must be non-empty"),
  description: z
    .string()
    .min(1, "description field is required and must be non-empty"),
  // Optional fields — schema documents them so we don't accidentally
  // emit a typo'd key (e.g. `permission_mode` instead of `permissionMode`).
  // cc-backup parser ignores unknown keys (not .strict()) so unknown keys
  // wouldn't break loading, but typos are still a maintenance hazard.
  model: z.string().optional(),
  effort: z.union([z.string(), z.number()]).optional(),
  permissionMode: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  hooks: z.unknown().optional(),
  maxTurns: z.number().int().positive().optional(),
  initialPrompt: z.string().optional(),
  memory: z.enum(["user", "project", "local"]).optional(),
  background: z.boolean().optional(),
  isolation: z.enum(["worktree", "remote"]).optional(),
  color: z.string().optional(),
})

/**
 * Parse a router-emitted .md file: split frontmatter from body, parse
 * frontmatter as YAML, return both. Mirrors what cc-backup's
 * loadMarkdownFilesForSubdir does (it uses gray-matter under the hood
 * but the format is the standard YAML-frontmatter convention).
 */
function parseAgentMd(body: string): {
  frontmatter: unknown
  content: string
} {
  // Format: "---\n<yaml>\n---\n<body>"
  const match = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    throw new Error("Body does not have valid YAML frontmatter delimiters")
  }
  const yamlSrc = match[1] ?? ""
  const content = match[2] ?? ""
  const frontmatter = parseYaml(yamlSrc) as unknown
  return { frontmatter, content }
}

describe("subagent .md frontmatter — cc-backup schema parity (Phase C P0.3)", () => {
  test("every emitted agent file passes cc-backup's required-field validation", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        // Each emitted .md file must:
        //   1. Have a parseable YAML frontmatter delimited by ---/---
        //   2. Pass the cc-backup schema (name + description required,
        //      optional fields use the documented enums)
        //   3. Have a non-empty body (becomes systemPrompt)
        for (const filePath of runtime.agentMdPaths) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter, content } = parseAgentMd(body)

          const result = ClaudeCodeAgentMdFrontmatterSchema.safeParse(
            frontmatter,
          )
          if (!result.success) {
            throw new Error(
              `Agent .md file ${path.basename(filePath)} fails cc-backup schema:\n`
                + JSON.stringify(result.error.format(), null, 2),
            )
          }
          expect(content.trim().length).toBeGreaterThan(0)
        }
      } finally {
        await runtime.cleanup()
      }
    })
  })

  test("frontmatter `name` matches the canonical agent name in the filename suffix", async () => {
    // Defense-in-depth: cc-backup uses frontmatter `name` as the agent
    // identifier (the filename is incidental — only matters for our boot
    // sweep). If the two ever drift, Claude Code would route to a name
    // the user can't predict from the file. Lock them in step.
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        for (const filePath of runtime.agentMdPaths) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter } = parseAgentMd(body)
          const fm = frontmatter as { name: string }

          // Filename pattern: peer-<pid>-<rand>-<agentName>.md
          // Extract agentName: everything between last <hex>- and .md
          const filename = path.basename(filePath, ".md")
          const segments = filename.split("-")
          // peer-<pid>-<8hex>-<name parts joined by ->
          const agentNameFromFile = segments.slice(3).join("-")

          expect(fm.name).toBe(agentNameFromFile)
        }
      } finally {
        await runtime.cleanup()
      }
    })
  })

  test("emitted .md files include the canonical persona names (peer-review-coordinator + each enabled persona)", async () => {
    // The .md set must include peer-review-coordinator (always) plus one
    // file per active persona. Locks in the contract that the .md
    // emission set tracks the active personas list — drift here means
    // a persona is registered in MCP but not delegable as a subagent
    // (or vice versa).
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        const names = new Set<string>()
        for (const filePath of runtime.agentMdPaths) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter } = parseAgentMd(body)
          names.add((frontmatter as { name: string }).name)
        }
        // Expected when geminiAvailable=true:
        expect(names.has("peer-review-coordinator")).toBe(true)
        expect(names.has("codex-critic")).toBe(true)
        expect(names.has("codex-reviewer")).toBe(true)
        expect(names.has("gemini-critic")).toBe(true)
        expect(names.has("opus-critic")).toBe(true)
      } finally {
        await runtime.cleanup()
      }
    })
  })

  test("frontmatter MUST NOT include a `tools:` field, except the read-only natives (subagents otherwise inherit the parent's full toolset incl. MCPs)", async () => {
    // Load-bearing pin for the holistic subagent MCP/tool-inheritance
    // fix (plans/in-this-code-base-cryptic-dove.md, Part 3). Claude Code
    // subagent semantics: omitting `tools:` from the frontmatter inherits
    // the parent's full toolset — built-ins AND every MCP tool the parent
    // can see. Adding a `tools:` allowlist *restricts* the subagent to
    // exactly that list, EXCLUDING user-scope MCPs and built-ins not
    // listed. Adding the field (even with a "comprehensive-looking" list)
    // would silently regress the "all abilities" goal — every user-side
    // MCP would vanish from subagents the moment we forgot to enumerate it.
    //
    // `scout` and `brainstorm` are the two DELIBERATE exceptions: they are
    // read-only by contract, and a prompt asking an agent not to write is not
    // enforcement while Edit/Write/Bash are inherited. They accept the cost this
    // comment describes (no user-scope MCPs, no tools added by future Claude
    // Code releases) in exchange for the restriction actually holding. That
    // trade is only worth making for an agent whose read-only-ness is the point;
    // every other emitted agent must still omit the field.
    //
    // If a future contributor genuinely needs to restrict subagent tools,
    // do so on a per-persona basis at the Claude-Code config layer, NOT
    // by adding `tools:` to the proxy-emitted frontmatter.
    const READ_ONLY_NATIVES = ["scout", "brainstorm"]
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: true,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        scoutModel: "gemini-3.6-flash",
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        let sawReadOnly = 0
        for (const filePath of runtime.agentMdPaths) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter } = parseAgentMd(body)
          const fm = frontmatter as Record<string, unknown>
          const isReadOnlyNative = READ_ONLY_NATIVES.some((n) =>
            filePath.endsWith(`-${n}.md`),
          )
          if (isReadOnlyNative) {
            sawReadOnly++
            expect(Array.isArray(fm.tools)).toBe(true)
            expect(fm.tools as Array<string>).not.toContain("Edit")
            expect(fm.tools as Array<string>).not.toContain("Write")
            continue
          }
          expect(fm.tools).toBeUndefined()
          // Defense-in-depth at the raw-bytes layer too (in case a future
          // change emits `tools:` outside the parsed YAML somehow):
          const fmText = body.split("---")[1] ?? ""
          expect(fmText).not.toMatch(/^tools\s*:/m)
        }
        // Guard the guard: if a rename made the suffix match stop firing, the
        // loop above would vacuously pass by checking nothing.
        expect(sawReadOnly).toBe(READ_ONLY_NATIVES.length)
      } finally {
        await runtime.cleanup()
      }
    })
  })

  test("worker-* dispatcher .md emits a `tools:` array (server wildcard) that passes the cc-backup schema", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
        groupKeys: { peers: "peers", workers: "workers" },
        workerToolsAvailable: true,
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        const workerFiles = runtime.agentMdPaths.filter((p) => /-worker-[a-z]+\.md$/.test(p))
        expect(workerFiles.length).toBe(5) // explore/implement/review/plan/test
        for (const filePath of workerFiles) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter } = parseAgentMd(body)
          const result = ClaudeCodeAgentMdFrontmatterSchema.safeParse(frontmatter)
          expect(result.success).toBe(true)
          const fm = frontmatter as { tools?: unknown }
          // tools MUST parse as an array of strings = the workers server wildcard.
          expect(Array.isArray(fm.tools)).toBe(true)
          expect(fm.tools).toEqual(["mcp__workers__*"])
        }
      } finally {
        await runtime.cleanup()
      }
    })
  })

  test("frontmatter description is non-empty (cc-backup logs warning + returns null if empty)", async () => {
    // Per cc-backup loadAgentsDir.ts:552-558 — empty description means
    // the parser returns null (agent silently doesn't load). The min(1)
    // assertion in our Zod schema covers this; this test makes the
    // requirement explicit so future code changes that empty out a
    // description will trip the check.
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const runtime = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        runtimeDir,
        codexHome,
        agentsDir,
      })
      try {
        for (const filePath of runtime.agentMdPaths) {
          const body = await fs.readFile(filePath, "utf8")
          const { frontmatter } = parseAgentMd(body)
          const fm = frontmatter as { description: string }
          expect(fm.description.length).toBeGreaterThan(0)
          // Sanity: description should be substantive (real persona
          // descriptions are several sentences). Catch a bug where a
          // refactor accidentally truncates to a placeholder.
          expect(fm.description.length).toBeGreaterThan(20)
        }
      } finally {
        await runtime.cleanup()
      }
    })
  })
})

describe("injectPeerMcpIntoMirror", () => {
  async function withMirrorDir<T>(
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = await makeTempDir("mirror")
    try {
      return await fn(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  test("creates .claude.json with one entry per group when the file does not yet exist", async () => {
    await withMirrorDir(async (dir) => {
      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers", search: "search" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect([...result.serversAdded].sort()).toEqual(["peers", "search"])

      const target = path.join(dir, ".claude.json")
      const stat = await fs.stat(target)
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600)
      }
      const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
        mcpServers: Record<string, { headers: { Authorization: string } }>
      }
      expect(Object.keys(parsed.mcpServers).sort()).toEqual(["peers", "search"])
      expect(parsed.mcpServers["peers"]!.headers.Authorization).toBe(
        `Bearer ${NONCE}`,
      )
      expect(parsed.mcpServers["search"]!.headers.Authorization).toBe(
        `Bearer ${NONCE}`,
      )
    })
  })

  test("preserves user's existing top-level fields AND other mcpServers entries", async () => {
    await withMirrorDir(async (dir) => {
      // Plant a realistic snapshot-shaped .claude.json
      const seed = {
        numStartups: 42,
        userID: "abc123",
        projects: { foo: { lastSeen: 999 } },
        mcpServers: {
          "user-redis": {
            type: "http",
            url: "http://localhost:6379/mcp",
            headers: {},
          },
        },
      }
      const target = path.join(dir, ".claude.json")
      await fs.writeFile(target, JSON.stringify(seed, null, 2), {
        mode: 0o600,
      })

      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)

      const after = JSON.parse(await fs.readFile(target, "utf8")) as {
        numStartups: number
        userID: string
        projects: { foo: { lastSeen: number } }
        mcpServers: Record<string, unknown>
      }
      // Top-level user fields preserved untouched
      expect(after.numStartups).toBe(42)
      expect(after.userID).toBe("abc123")
      expect(after.projects.foo.lastSeen).toBe(999)
      // User's mcpServers entry preserved untouched
      expect(after.mcpServers["user-redis"]).toBeDefined()
      // Our entry added alongside
      expect(after.mcpServers["peers"]).toBeDefined()
      // Exact key set: user-redis + peers (no codex-cli, codexCli=false)
      expect(Object.keys(after.mcpServers).sort()).toEqual([
        "peers",
        "user-redis",
      ])
    })
  })

  test("codexCli=true also injects the codex-cli stdio entry", async () => {
    await withMirrorDir(async (dir) => {
      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: true,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex-isolated",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect([...result.serversAdded].sort()).toEqual([
        "codex-cli",
        "peers",
      ])

      const parsed = JSON.parse(
        await fs.readFile(path.join(dir, ".claude.json"), "utf8"),
      ) as { mcpServers: Record<string, { command?: string }> }
      expect(parsed.mcpServers["codex-cli"]?.command).toBe("codex")
      expect(parsed.mcpServers["peers"]).toBeDefined()
    })
  })

  test("defensive: refuses to overwrite a user-side entry whose key matches a resolved groupKey", async () => {
    // Keys handed to inject are pre-resolved collision-free by
    // resolveGroupKeysFromMirror, so this branch should never fire in
    // normal flow. But if a racing mutation of the mirror reintroduces a
    // same-named entry between resolution and inject, the merge must
    // refuse rather than clobber the user's server. Simulate that race by
    // passing a resolved key (`peers`) that the mirror already holds.
    await withMirrorDir(async (dir) => {
      const userEntry = {
        type: "http",
        url: "https://evil.example.com/mcp",
        headers: { "X-Custom": "user-controlled" },
      }
      const seed = {
        numStartups: 7,
        mcpServers: { peers: userEntry, "another-server": {} },
      }
      const target = path.join(dir, ".claude.json")
      await fs.writeFile(target, JSON.stringify(seed, null, 2), {
        mode: 0o600,
      })
      const beforeBody = await fs.readFile(target, "utf8")

      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("user-has-conflicting-entry")
      expect(result.conflictingServers).toEqual(["peers"])

      // File MUST be unchanged byte-for-byte — we refused, no clobber.
      const afterBody = await fs.readFile(target, "utf8")
      expect(afterBody).toBe(beforeBody)
    })
  })

  test("collision detection also fires for a user-side codex-cli when codexCli=true", async () => {
    await withMirrorDir(async (dir) => {
      const seed = {
        mcpServers: {
          "codex-cli": { command: "user-codex", args: [], env: {} },
        },
      }
      const target = path.join(dir, ".claude.json")
      await fs.writeFile(target, JSON.stringify(seed, null, 2), { mode: 0o600 })
      const beforeBody = await fs.readFile(target, "utf8")

      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: true,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.conflictingServers).toContain("codex-cli")

      const afterBody = await fs.readFile(target, "utf8")
      expect(afterBody).toBe(beforeBody)
    })
  })

  test("malformed JSON in existing .claude.json → starts fresh (warn + overwrite)", async () => {
    await withMirrorDir(async (dir) => {
      const target = path.join(dir, ".claude.json")
      await fs.writeFile(target, "{ not valid json", { mode: 0o600 })

      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)

      const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
        mcpServers: Record<string, unknown>
      }
      expect(parsed.mcpServers["peers"]).toBeDefined()
    })
  })

  test("idempotent re-run on the SAME mirror does NOT spuriously collide (peers we wrote ourselves)", async () => {
    // Edge case: if a future caller invokes injectPeerMcpIntoMirror twice
    // in the same proxy lifetime (e.g. internal relaunch) with the same
    // pre-resolved keys, the second call would see OUR previously-written
    // `peers` entry and refuse. Document this as the current behavior —
    // the collision branch is intentionally conservative ("any same-named
    // entry → refuse") and we don't try to fingerprint "did we write
    // this?". The fix if this ever bites is to delete the entry before
    // re-injecting; for now assert the current behavior so any future
    // refactor is explicit about the trade-off. (In the real launch flow
    // resolveGroupKeysFromMirror reads the mirror fresh each time, so a
    // second resolution would fall back to `gh-router-peers` and avoid
    // this — the collision only appears when the SAME pre-resolved key is
    // reused without re-resolving.)
    await withMirrorDir(async (dir) => {
      const first = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(first.ok).toBe(true)

      const second = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.conflictingServers).toEqual(["peers"])
    })
  })

  test("mcpServers field set to a non-object value gets replaced (warn + clobber)", async () => {
    await withMirrorDir(async (dir) => {
      const seed = { numStartups: 1, mcpServers: "this is wrong" }
      const target = path.join(dir, ".claude.json")
      await fs.writeFile(target, JSON.stringify(seed), { mode: 0o600 })

      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)

      const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
        numStartups: number
        mcpServers: Record<string, unknown>
      }
      expect(parsed.numStartups).toBe(1) // other fields preserved
      expect(parsed.mcpServers["peers"]).toBeDefined()
    })
  })

  test("creates the parent dir if it does not exist (lazy mkdir)", async () => {
    // The per-launch CLAUDE_CONFIG_DIR is normally created by
    // ensureClaudeConfigMirror BEFORE injectPeerMcpIntoMirror runs.
    // But if a future caller flips that order, we should not ENOENT-fail.
    const parent = await makeTempDir("mirror-parent")
    const dir = path.join(parent, "nonexistent-subdir")
    try {
      const result = await injectPeerMcpIntoMirror(URL, {
        codexCli: false,
        geminiAvailable: true,
        groupKeys: { peers: "peers" },
        nonce: NONCE,
        codexHome: "/tmp/codex",
        claudeConfigDir: dir,
      })
      expect(result.ok).toBe(true)
      const stat = await fs.stat(path.join(dir, ".claude.json"))
      expect(stat.isFile()).toBe(true)
    } finally {
      await fs.rm(parent, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("resolveGroupKeysFromMirror", () => {
  async function withMirrorDir<T>(
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = await makeTempDir("resolve-mirror")
    try {
      return await fn(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function seedMirror(
    dir: string,
    mcpServers: Record<string, unknown>,
  ): Promise<void> {
    const target = path.join(dir, ".claude.json")
    await fs.writeFile(target, JSON.stringify({ mcpServers }, null, 2), {
      mode: 0o600,
    })
  }

  test("empty / missing mirror → every enabled group gets its bare key", async () => {
    await withMirrorDir(async (dir) => {
      // No .claude.json planted — readMcpServersSnapshot treats this as {}.
      const { keys, skipped } = await resolveGroupKeysFromMirror(
        MCP_GROUPS,
        dir,
      )
      expect(skipped).toEqual([])
      expect(keys).toEqual({
        peers: "peers",
        search: "search",
        workers: "workers",
        orchestrate: "orchestrate",
        browser: "browser",
        decide: "decide",
        fleet: "fleet",
        "first-mate": "first-mate",
      })
    })
  })

  test("a user-side bare `browser` entry → browser resolves to the gh-router-browser fallback", async () => {
    await withMirrorDir(async (dir) => {
      await seedMirror(dir, {
        browser: { type: "http", url: "http://localhost:9/mcp", headers: {} },
      })
      const { keys, skipped } = await resolveGroupKeysFromMirror(
        MCP_GROUPS,
        dir,
      )
      expect(skipped).toEqual([])
      // The collided group falls back to the prefixed key…
      expect(keys.browser).toBe("gh-router-browser")
      // …while every other group keeps its bare key.
      expect(keys.peers).toBe("peers")
      expect(keys.search).toBe("search")
      expect(keys.workers).toBe("workers")
      expect(keys.decide).toBe("decide")
    })
  })

  test("both `search` AND `gh-router-search` taken → numbered fallback (never skip, never route at user's server)", async () => {
    await withMirrorDir(async (dir) => {
      await seedMirror(dir, {
        search: { type: "http", url: "http://localhost:1/mcp", headers: {} },
        "gh-router-search": {
          type: "http",
          url: "http://localhost:2/mcp",
          headers: {},
        },
      })
      const { keys, skipped } = await resolveGroupKeysFromMirror(
        MCP_GROUPS,
        dir,
      )
      // Never skip: search walks past the two taken names to a free,
      // proxy-owned key. The capability stays available and the model is
      // never routed at the user's `search` or `gh-router-search` servers.
      expect(skipped).toEqual([])
      expect(keys.search).toBe("gh-router-search-2")
      // Other groups unaffected.
      expect(keys.peers).toBe("peers")
      expect(keys.browser).toBe("browser")
    })
  })

  test("walks the numbered sequence until a free key is found", async () => {
    await withMirrorDir(async (dir) => {
      await seedMirror(dir, {
        peers: { type: "http", url: "http://localhost:1/mcp", headers: {} },
        "gh-router-peers": { type: "http", url: "http://localhost:2/mcp", headers: {} },
        "gh-router-peers-2": { type: "http", url: "http://localhost:3/mcp", headers: {} },
      })
      const { keys } = await resolveGroupKeysFromMirror(["peers"], dir)
      // peers is load-bearing — it ALWAYS gets a key we own, even past
      // three user collisions.
      expect(keys.peers).toBe("gh-router-peers-3")
    })
  })

  test("only resolves the enabled groups it is asked about", async () => {
    await withMirrorDir(async (dir) => {
      const { keys, skipped } = await resolveGroupKeysFromMirror(
        ["peers", "search"],
        dir,
      )
      expect(skipped).toEqual([])
      expect(Object.keys(keys).sort()).toEqual(["peers", "search"])
      expect(keys.workers).toBeUndefined()
      expect(keys.browser).toBeUndefined()
      expect(keys.decide).toBeUndefined()
    })
  })
})
