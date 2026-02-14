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

      expect(result.cmd).toEqual(["codex", "-m", DEFAULT_CODEX_MODEL])
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

      expect(result.cmd).toEqual(["codex", "-m", "gpt-4o"])
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

      expect(result.cmd).toEqual(["codex", "-m", DEFAULT_CODEX_MODEL, "--full-auto"])
    })
  })
})
