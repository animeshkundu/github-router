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
  test("returns proxy URL plus auth-bypass shims", () => {
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
    expect(vars.ANTHROPIC_API_KEY).toBe("dummy")
    expect(vars.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("clears every non-proxy auth path Claude Code might inherit", () => {
    // Auth precedence per https://code.claude.com/docs/en/iam:
    // (1) cloud provider, (2) ANTHROPIC_AUTH_TOKEN, (3) ANTHROPIC_API_KEY,
    // (4) apiKeyHelper, (5) CLAUDE_CODE_OAUTH_TOKEN, (6) subscription OAuth.
    // We override (1)/(2)/(3)/(5) and beat (4)/(6) by env-var precedence.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.CLAUDE_CODE_USE_BEDROCK).toBe("")
    expect(vars.CLAUDE_CODE_USE_VERTEX).toBe("")
    expect(vars.CLAUDE_CODE_USE_FOUNDRY).toBe("")
    expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe("")
    expect(vars.ANTHROPIC_CUSTOM_HEADERS).toBe("")
  })

  test("ANTHROPIC_API_KEY is set to dummy (regression — without this, an inherited real key leaks via x-api-key)", () => {
    // Verified live: Claude Code 2.1.126 sends BOTH `Authorization: Bearer
    // <ANTHROPIC_AUTH_TOKEN>` AND `x-api-key: <ANTHROPIC_API_KEY>` when both
    // env vars are set. If we don't shadow ANTHROPIC_API_KEY, a real key
    // exported in the user's shell flows through the proxy.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.ANTHROPIC_API_KEY).toBe("dummy")
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

  test("isolates CODEX_HOME to mask cached ChatGPT login (openai/codex#2733)", () => {
    // Codex caches a ChatGPT subscription login in $CODEX_HOME/auth.json
    // which can override OPENAI_API_KEY per the upstream bug. Pointing at
    // an isolated dir under our app data makes the proxy's dummy key
    // authoritative.
    const vars = getCodexEnvVars("http://127.0.0.1:8787")
    expect(vars.CODEX_HOME).toBeDefined()
    expect(vars.CODEX_HOME).not.toBe("")
    // Path lives under the github-router app dir, not the user's ~/.codex.
    expect(vars.CODEX_HOME).toContain("github-router")
    expect(vars.CODEX_HOME).not.toBe(`${process.env.HOME}/.codex`)
  })
})
