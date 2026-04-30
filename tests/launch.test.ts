import { describe, expect, test } from "bun:test"

import { buildLaunchCommand, type LaunchTarget } from "../src/lib/launch"
import { DEFAULT_CODEX_MODEL } from "../src/lib/port"

describe("buildLaunchCommand", () => {
  describe("claude-code", () => {
    test("returns correct command and env vars", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: {
          ANTHROPIC_BASE_URL: "http://localhost:12345",
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: "dummy",
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        },
        extraArgs: [],
      }

      const result = buildLaunchCommand(target)

      expect(result.cmd).toEqual([
        "claude",
        "--dangerously-skip-permissions",
        "--teammate-mode",
        "auto",
      ])
      expect(result.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12345")
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
      expect(result.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
      expect(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
      expect(result.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1")
      expect(result.env.ANTHROPIC_MODEL).toBeUndefined()
    })

    test("removes inherited ANTHROPIC_API_KEY when env var value is undefined", () => {
      const original = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = "real-key"
      try {
        const target: LaunchTarget = {
          kind: "claude-code",
          envVars: {
            ANTHROPIC_BASE_URL: "http://localhost:12345",
            ANTHROPIC_API_KEY: undefined,
            ANTHROPIC_AUTH_TOKEN: "dummy",
          },
          extraArgs: [],
        }

        const result = buildLaunchCommand(target)

        expect(result.env.ANTHROPIC_API_KEY).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = original
      }
    })

    test("includes ANTHROPIC_MODEL when model is provided", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: {
          ANTHROPIC_BASE_URL: "http://localhost:12345",
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: "dummy",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
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
        "--teammate-mode",
        "auto",
        "--verbose",
        "--debug",
      ])
    })

    test("uses overridden teammate mode when provided", () => {
      const target: LaunchTarget = {
        kind: "claude-code",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:12345", ANTHROPIC_AUTH_TOKEN: "dummy" },
        extraArgs: [],
        teammateMode: "in-process",
      }

      const result = buildLaunchCommand(target)

      expect(result.cmd).toEqual([
        "claude",
        "--dangerously-skip-permissions",
        "--teammate-mode",
        "in-process",
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
})
