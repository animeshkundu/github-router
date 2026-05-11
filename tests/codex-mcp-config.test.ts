import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import {
  buildPeerAgentDefinitions,
  buildPeerMcpConfig,
  resolveCodexCliBackend,
  writePeerMcpRuntimeFiles,
} from "../src/lib/codex-mcp-config"

const NONCE = "0".repeat(64)
const URL = "http://127.0.0.1:18787"

// Use a fixed `/tmp` prefix instead of `os.tmpdir()` — `tests/lib-paths.test.ts`
// uses `mock.module("node:os", ...)` to stub homedir(), which globally
// replaces the os module and removes tmpdir(). Avoid that landmine.
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

describe("buildPeerMcpConfig", () => {
  test("HTTP backend (codexCli=false) registers only gh-router-peers", () => {
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: false,
      geminiAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(cfg.mcpServers)).toEqual(["gh-router-peers"])
    const entry = cfg.mcpServers["gh-router-peers"] as {
      type: "http"
      url: string
      headers: Record<string, string>
    }
    expect(entry.type).toBe("http")
    expect(entry.url).toBe(`${URL}/mcp`)
    expect(entry.headers.Authorization).toBe(`Bearer ${NONCE}`)
  })

  test("CLI backend adds codex-cli stdio entry with provider flags + env", () => {
    const cfg = buildPeerMcpConfig(URL, {
      codexCli: true,
      geminiAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex-isolated",
    })
    expect(Object.keys(cfg.mcpServers).sort()).toEqual([
      "codex-cli",
      "gh-router-peers",
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
  test("HTTP backend with gemini = 3 personas + peer-review-coordinator (4 agents total)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "codex-critic",
      "codex-reviewer",
      "gemini-critic",
      "peer-review-coordinator",
    ])
    // Each persona prompt routes to the HTTP MCP server name; the
    // coordinator prompt does NOT route to mcp tools directly (it
    // delegates to the persona subagents instead).
    for (const name of ["codex-critic", "codex-reviewer", "gemini-critic"]) {
      expect(agents[name]!.prompt).toContain("mcp__gh-router-peers__")
      expect(agents[name]!.description.length).toBeGreaterThan(0)
    }
    expect(agents["peer-review-coordinator"]!.description).toContain("Use proactively")
    expect(agents["peer-review-coordinator"]!.prompt).toContain("codex-critic")
  })

  test("HTTP backend without gemini drops gemini-critic but keeps coordinator", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: false,
      geminiAvailable: false,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "codex-critic",
      "codex-reviewer",
      "peer-review-coordinator",
    ])
    expect(agents["gemini-critic"]).toBeUndefined()
    // Coordinator prompt should NOT reference gemini-critic when not registered.
    expect(agents["peer-review-coordinator"]!.prompt).toContain("NOT REGISTERED")
  })

  test("CLI backend with gemini = 4 personas + coordinator (5 agents total)", () => {
    const agents = buildPeerAgentDefinitions({
      codexCli: true,
      geminiAvailable: true,
      nonce: NONCE,
      codexHome: "/tmp/codex",
    })
    expect(Object.keys(agents).sort()).toEqual([
      "codex-critic",
      "codex-implementer",
      "codex-reviewer",
      "gemini-critic",
      "peer-review-coordinator",
    ])
    // codex-* personas point at the stdio server; gemini-critic stays HTTP.
    expect(agents["codex-critic"]!.prompt).toContain("mcp__codex-cli__codex")
    expect(agents["gemini-critic"]!.prompt).toContain(
      "mcp__gh-router-peers__gemini_critic",
    )
    expect(agents["codex-implementer"]!.prompt).toContain('"workspace-write"')
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
      // registered agent (3 personas + peer-review-coordinator = 4).
      expect(runtime.agentMdPaths.length).toBe(4)
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
        mcpServers: { "gh-router-peers": { headers: { Authorization: string } } }
      }
      expect(cfg.mcpServers["gh-router-peers"].headers.Authorization).toBe(
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

  test("two consecutive invocations produce distinct nonces", async () => {
    await withTempRuntimeDir(async (runtimeDir, codexHome, agentsDir) => {
      const a = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
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
        runtimeDir,
        codexHome,
        agentsDir,
      })
      // Don't cleanup. Second call must NOT collide with first call's
      // files — random-suffix guarantees uniqueness within a process.
      const b = await writePeerMcpRuntimeFiles(URL, {
        codexCli: false,
        geminiAvailable: false,
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
        "../src/lib/codex-mcp-config"
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
      "../src/lib/codex-mcp-config"
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
      "../src/lib/codex-mcp-config"
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
        runtimeDir,
        codexHome,
        agentsDir,
      })
      const cliMode = await writePeerMcpRuntimeFiles(URL, {
        codexCli: true,
        geminiAvailable: true,
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
      ])
      expect(cliNames).toEqual([
        "codex-critic",
        "codex-implementer",
        "codex-reviewer",
        "gemini-critic",
      ])
      await httpMode.cleanup()
      await cliMode.cleanup()
    })
  })
})
