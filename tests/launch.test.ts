import { afterEach, describe, expect, test } from "bun:test"

import {
  buildLaunchCommand,
  sanitizeParentEnv,
  type LaunchTarget,
} from "../src/lib/launch"
import { DEFAULT_CODEX_MODEL } from "../src/lib/port"

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

      expect(result.cmd).toEqual(["claude", "--dangerously-skip-permissions"])
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

      expect(result.cmd).toEqual([
        "claude",
        "--dangerously-skip-permissions",
        "--verbose",
        "--debug",
      ])
    })
  })

  describe("codex", () => {
    test("returns correct command with default model", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: {
          OPENAI_BASE_URL: "http://localhost:12345/v1",
          OPENAI_API_KEY: "dummy",
        },
        extraArgs: [],
      }

      const result = buildLaunchCommand(target)

      expect(result.cmd).toEqual(["codex", "--full-auto", "-m", DEFAULT_CODEX_MODEL])
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

      expect(result.cmd).toEqual(["codex", "--full-auto", "-m", "gpt-4o"])
    })

    test("appends extra args after base command", () => {
      const target: LaunchTarget = {
        kind: "codex",
        envVars: {
          OPENAI_BASE_URL: "http://localhost:12345/v1",
          OPENAI_API_KEY: "dummy",
        },
        extraArgs: ["--full-auto"],
      }

      const result = buildLaunchCommand(target)

      expect(result.cmd).toEqual(["codex", "--full-auto", "-m", DEFAULT_CODEX_MODEL, "--full-auto"])
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
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
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
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
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
  })
})
