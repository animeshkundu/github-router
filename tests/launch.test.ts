import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildLaunchCommand,
  isExecutableAvailable,
  sanitizeParentEnv,
  windowsLaunchNeedsShell,
  type LaunchTarget,
} from "../src/lib/launch"
import { DEFAULT_CODEX_MODEL } from "../src/lib/port"

// buildLaunchCommand now resolves the top-level CLI to an absolute path
// (anti-shadow) when it is installed on the host, so cmd[0] may be e.g.
// "C:\\...\\codex.CMD" instead of the bare name. Assert on the basename
// so the tests are deterministic across machines.
function baseCmd(cmd: string[]): string {
  return (
    cmd[0]
      .replace(/\\/g, "/")
      .split("/")
      .pop() ?? cmd[0]
  ).replace(/\.(cmd|exe)$/i, "")
}

describe("isExecutableAvailable", () => {
  // Regression: buildLaunchCommand resolves the CLI to an ABSOLUTE path
  // (anti-shadow). The launcher's pre-flight must accept that path —
  // `where.exe`/`which` reject a full-path argument, which previously
  // aborted every launch with a spurious "not found on PATH".
  test("absolute path that exists → true (resolved CLI can launch)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-exec-"))
    try {
      const bin = path.join(
        dir,
        process.platform === "win32" ? "claude.cmd" : "claude",
      )
      await fs.writeFile(bin, "")
      expect(isExecutableAvailable(bin)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("absolute path that does not exist → false", () => {
    const missing = path.join(os.tmpdir(), `definitely-missing-${Date.now()}.bin`)
    expect(isExecutableAvailable(missing)).toBe(false)
  })
})

describe("buildLaunchCommand", () => {
  describe("claude-code", () => {
    test("returns correct command and env vars", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: {
          ANTHROPIC_BASE_URL: "http://localhost:12345",
          ANTHROPIC_AUTH_TOKEN: "dummy",
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        extraArgs: [],
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("claude")
      expect(result.cmd.slice(1)).toEqual(["--dangerously-skip-permissions"])
      expect(result.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12345")
      expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
      expect(result.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
      expect(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
      expect(result.env.ANTHROPIC_MODEL).toBeUndefined()
    })

    test("includes ANTHROPIC_MODEL when model is provided", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: {
          ANTHROPIC_BASE_URL: "http://localhost:12345",
          ANTHROPIC_AUTH_TOKEN: "dummy",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        extraArgs: [],
        model: "claude-sonnet-4-20250514",
      }

      const result = buildLaunchCommand(target)

      expect(result.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514")
    })

    test("appends extra args after base command", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:12345", ANTHROPIC_AUTH_TOKEN: "dummy" },
        extraArgs: ["--verbose", "--debug"],
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("claude")
      expect(result.cmd.slice(1)).toEqual([
        "--dangerously-skip-permissions",
        "--verbose",
        "--debug",
      ])
    })
  })

  describe("codex", () => {
    test("returns correct command with default model (no serverUrl = no provider config)", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: {
          OPENAI_BASE_URL: "http://localhost:12345/v1",
          OPENAI_API_KEY: "dummy",
        },
        extraArgs: [],
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("codex")
      expect(result.cmd.slice(1)).toEqual([
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-m",
        DEFAULT_CODEX_MODEL,
      ])
      expect(result.env.OPENAI_BASE_URL).toBe("http://localhost:12345/v1")
      expect(result.env.OPENAI_API_KEY).toBe("dummy")
    })

    test("uses overridden model when provided", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: {
          OPENAI_BASE_URL: "http://localhost:12345/v1",
          OPENAI_API_KEY: "dummy",
        },
        extraArgs: [],
        model: "gpt-4o",
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("codex")
      expect(result.cmd.slice(1)).toEqual([
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-m",
        "gpt-4o",
      ])
    })

    test("appends extra args after base command", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: {
          OPENAI_BASE_URL: "http://localhost:12345/v1",
          OPENAI_API_KEY: "dummy",
        },
        extraArgs: ["--debug"],
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("codex")
      expect(result.cmd.slice(1)).toEqual([
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-m",
        DEFAULT_CODEX_MODEL,
        "--debug",
      ])
    })

    test("injects -c model_provider override when serverUrl is provided (Codex 0.129+ ignores OPENAI_BASE_URL)", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: { OPENAI_API_KEY: "dummy" },
        extraArgs: [],
        serverUrl: "http://127.0.0.1:18787",
      }

      const result = buildLaunchCommand(target)

      expect(baseCmd(result.cmd)).toBe("codex")
      // The provider config must come BEFORE the sandbox/model args so
      // Codex parses it as a root flag and the spawned model_provider
      // points at our proxy.
      expect(result.cmd).toContain("-c")
      const providerCfgIdx = result.cmd.findIndex((s) =>
        s.startsWith("model_providers.github_router="),
      )
      expect(providerCfgIdx).toBeGreaterThan(0)
      expect(result.cmd[providerCfgIdx]).toContain(
        'base_url="http://127.0.0.1:18787/v1"',
      )
      expect(result.cmd[providerCfgIdx]).toContain('wire_api="responses"')
      const useProviderIdx = result.cmd.indexOf("model_provider=github_router")
      expect(useProviderIdx).toBeGreaterThan(providerCfgIdx)
    })
  })

  describe("parent-env sanitization", () => {
    // We're going to mutate process.env to verify the sanitizer; restore after.
    const SAVED_KEYS = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CONFIG_DIR",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "CODEX_HOME",
    ] as const
    const saved: Record<string, string | undefined> = {}

    afterEach(() => {
      for (const key of SAVED_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
        delete saved[key]
      }
    })

    test("strips every auth-related key from a fixture parent env", () => {
      const fixture: NodeJS.ProcessEnv = {
        // Auth-related — should be stripped
        ANTHROPIC_API_KEY: "sk-real-leaked-key",
        ANTHROPIC_AUTH_TOKEN: "real-token",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar",
        ANTHROPIC_MODEL: "claude-opus-4.5",
        CLAUDE_CODE_OAUTH_TOKEN: "ot-...",
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "5",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        CLAUDE_CONFIG_DIR: "/some/alt/profile",
        OPENAI_API_KEY: "sk-openai-real",
        OPENAI_BASE_URL: "https://api.openai.com",
        CODEX_HOME: "/Users/x/.codex",
        // Unrelated — must be preserved
        PATH: "/usr/bin:/bin",
        HOME: "/Users/x",
        TERM: "xterm-256color",
        SOMETHING_UNRELATED: "keep-me",
      }

      const sanitized = sanitizeParentEnv(fixture)

      // Every auth-related key gone:
      for (const key of SAVED_KEYS) {
        expect(sanitized).not.toHaveProperty(key)
      }
      // Unrelated keys preserved:
      expect(sanitized.PATH).toBe("/usr/bin:/bin")
      expect(sanitized.HOME).toBe("/Users/x")
      expect(sanitized.TERM).toBe("xterm-256color")
      expect(sanitized.SOMETHING_UNRELATED).toBe("keep-me")
    })

    test("buildLaunchCommand env contains proxy overrides only — no inherited shell ANTHROPIC_API_KEY", () => {
      // Simulate a user shell that has a real key exported.
      for (const k of SAVED_KEYS) saved[k] = process.env[k]
      process.env.ANTHROPIC_API_KEY = "sk-real-shell-key-MUST-NOT-LEAK"
      process.env.CLAUDE_CODE_USE_BEDROCK = "1"
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "ot-shell"
      process.env.OPENAI_API_KEY = "sk-openai-shell"

      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
          ANTHROPIC_AUTH_TOKEN: "dummy",
        },
        extraArgs: [],
      }
      const { env } = buildLaunchCommand(target)

      // Shell-exported ANTHROPIC_API_KEY does NOT flow through.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      // Cloud-provider toggles do NOT flow through.
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      // OAuth token does NOT flow through.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // Codex parent OPENAI_API_KEY does NOT flow through.
      expect(env.OPENAI_API_KEY).toBeUndefined()
      // Proxy overrides DO flow through.
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
    })

    test("proxy override beats sanitized parent (e.g. ANTHROPIC_BASE_URL is the proxy URL even if shell had Anthropic upstream)", () => {
      for (const k of SAVED_KEYS) saved[k] = process.env[k]
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com" // shell pre-set
      process.env.OPENAI_BASE_URL = "https://api.openai.com"

      const claudeTarget: LaunchTarget = {
        kind: "claude-code",
        envVars: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_AUTH_TOKEN: "dummy" },
        extraArgs: [],
      }
      const { env: claudeEnv } = buildLaunchCommand(claudeTarget)
      expect(claudeEnv.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")

      const codexTarget: LaunchTarget = {
        kind: "codex",
        envVars: { OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", OPENAI_API_KEY: "dummy" },
        extraArgs: [],
      }
      const { env: codexEnv } = buildLaunchCommand(codexTarget)
      expect(codexEnv.OPENAI_BASE_URL).toBe("http://127.0.0.1:8787/v1")
    })

    // --- Phase A P1.3: bridge / remote-session env strips ---

    test("bridge / remote-session env keys are stripped (Claude Code Bridge)", () => {
      // If any of these is set in the parent shell, the spawned Claude Code
      // would activate remote-session mode and start hitting endpoints
      // (POST /v1/code/sessions, POST /v1/environments/bridge, etc.) the
      // proxy does not implement (Copilot has no equivalent). Source:
      // cc-backup/src/bridge/* + WorkSecret schema in src/bridge/types.ts.
      const fixture: NodeJS.ProcessEnv = {
        CLAUDE_BRIDGE_OAUTH_TOKEN: "bridge-oauth-leaked",
        CLAUDE_BRIDGE_BASE_URL: "https://bridge.example.com",
        CLAUDE_BRIDGE_SESSION_INGRESS_URL: "https://ingress.example.com",
        SESSION_INGRESS_URL: "https://alt-ingress.example.com",
        CLAUDE_CODE_REMOTE: "1",
        CLAUDE_CODE_CONTAINER_ID: "container-abc",
        CLAUDE_CODE_REMOTE_SESSION_ID: "remote-session-xyz",
        CLAUDE_CODE_SESSION_ID: "session-resume-123",
        CLAUDE_CODE_ADDITIONAL_PROTECTION: "true",
        // Unrelated — must be preserved
        PATH: "/usr/bin:/bin",
      }
      const sanitized = sanitizeParentEnv(fixture)

      expect(sanitized).not.toHaveProperty("CLAUDE_BRIDGE_OAUTH_TOKEN")
      expect(sanitized).not.toHaveProperty("CLAUDE_BRIDGE_BASE_URL")
      expect(sanitized).not.toHaveProperty("CLAUDE_BRIDGE_SESSION_INGRESS_URL")
      expect(sanitized).not.toHaveProperty("SESSION_INGRESS_URL")
      expect(sanitized).not.toHaveProperty("CLAUDE_CODE_REMOTE")
      expect(sanitized).not.toHaveProperty("CLAUDE_CODE_CONTAINER_ID")
      expect(sanitized).not.toHaveProperty("CLAUDE_CODE_REMOTE_SESSION_ID")
      expect(sanitized).not.toHaveProperty("CLAUDE_CODE_SESSION_ID")
      expect(sanitized).not.toHaveProperty("CLAUDE_CODE_ADDITIONAL_PROTECTION")
      expect(sanitized.PATH).toBe("/usr/bin:/bin")
    })

    test("ANTHROPIC_SMALL_FAST_MODEL is intentionally NOT stripped (gemini-critic finding)", () => {
      // Users with custom Copilot mappings legitimately rely on this env
      // var to route the haiku-tier "small fast" model. Stripping would
      // be an unforced error — we trust resolveModel's family-fallback
      // (Phase A P0.4) to translate unknown haiku slugs.
      const fixture: NodeJS.ProcessEnv = {
        ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001",
      }
      const sanitized = sanitizeParentEnv(fixture)
      expect(sanitized.ANTHROPIC_SMALL_FAST_MODEL).toBe(
        "claude-haiku-4-5-20251001",
      )
    })
  })
})

describe("windowsLaunchNeedsShell — drop the cmd.exe intermediary", () => {
  test("batch shims (.cmd/.bat) still need cmd.exe", () => {
    expect(windowsLaunchNeedsShell("C:/path/claude.cmd")).toBe(true)
    expect(windowsLaunchNeedsShell("C:/path/codex.CMD")).toBe(true)
    expect(windowsLaunchNeedsShell("C:/path/tool.bat")).toBe(true)
  })
  test("a real .exe is spawned directly (no shell, no cmd.exe wrapper)", () => {
    // The native-installer claude.exe case: direct child → tree-kill/guard
    // target the real process, not an orphan-leaking cmd.exe.
    expect(windowsLaunchNeedsShell("C:/Users/me/.local/bin/claude.exe")).toBe(false)
    expect(windowsLaunchNeedsShell("C:/path/claude.EXE")).toBe(false)
  })
})
