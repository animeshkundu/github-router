import { test, expect, describe } from "bun:test"

import {
  parseSharedArgs,
  getClaudeCodeEnvVars,
  getCodexEnvVars,
} from "../src/lib/server-setup"

describe("parseSharedArgs", () => {
  test("valid port parsed correctly", () => {
    const result = parseSharedArgs({ port: "8080" })
    expect(result.port).toBe(8080)
  })

  test("port 0 rejected", () => {
    expect(() => parseSharedArgs({ port: "0" })).toThrow(
      "Invalid port. Must be between 1 and 65535.",
    )
  })

  test("port -1 rejected", () => {
    expect(() => parseSharedArgs({ port: "-1" })).toThrow(
      "Invalid port. Must be between 1 and 65535.",
    )
  })

  test("port 65535 accepted (max valid)", () => {
    const result = parseSharedArgs({ port: "65535" })
    expect(result.port).toBe(65535)
  })

  test("port 65536 rejected", () => {
    expect(() => parseSharedArgs({ port: "65536" })).toThrow(
      "Invalid port. Must be between 1 and 65535.",
    )
  })

  test("non-numeric port 'abc' rejected", () => {
    expect(() => parseSharedArgs({ port: "abc" })).toThrow(
      "Invalid port. Must be between 1 and 65535.",
    )
  })

  test("invalid account type 'bogus' rejected", () => {
    expect(() => parseSharedArgs({ "account-type": "bogus" })).toThrow(
      "Invalid account type. Must be individual, business, or enterprise.",
    )
  })

  test("negative rate limit '-1' rejected", () => {
    expect(() => parseSharedArgs({ "rate-limit": "-1" })).toThrow(
      "Invalid rate limit. Must be a positive integer.",
    )
  })

  test("GH_TOKEN env var used as fallback", () => {
    const origToken = process.env.GH_TOKEN
    try {
      process.env.GH_TOKEN = "env-token-123"
      const result = parseSharedArgs({})
      expect(result.githubToken).toBe("env-token-123")
    } finally {
      if (origToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = origToken
    }
  })

  test("explicit --github-token takes precedence over GH_TOKEN", () => {
    const origToken = process.env.GH_TOKEN
    try {
      process.env.GH_TOKEN = "env-token"
      const result = parseSharedArgs({ "github-token": "explicit-token" })
      expect(result.githubToken).toBe("explicit-token")
    } finally {
      if (origToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = origToken
    }
  })
})

describe("getClaudeCodeEnvVars", () => {
  test("returns ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, DISABLE_* keys", () => {
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    })
  })

  test("includes ANTHROPIC_MODEL when model provided", () => {
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787", "claude-sonnet-4-20250514")
    expect(vars.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514")
  })

  test("omits ANTHROPIC_MODEL when not provided", () => {
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("ANTHROPIC_MODEL")
  })
})

describe("getCodexEnvVars", () => {
  test("returns OPENAI_BASE_URL with /v1 suffix", () => {
    const vars = getCodexEnvVars("http://127.0.0.1:8787")
    expect(vars.OPENAI_BASE_URL).toBe("http://127.0.0.1:8787/v1")
  })

  test("returns OPENAI_API_KEY as 'dummy'", () => {
    const vars = getCodexEnvVars("http://127.0.0.1:8787")
    expect(vars.OPENAI_API_KEY).toBe("dummy")
  })
})
