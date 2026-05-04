import os from "node:os"
import path from "node:path"

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
  test("returns minimal proxy override set", () => {
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
    expect(vars.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("sets CLAUDE_CONFIG_DIR to the default path to activate keychain isolation", () => {
    // Per binary-grep of Claude Code 2.1.126 iN(): when CLAUDE_CONFIG_DIR
    // is set (to ANYTHING — even its default), the keychain service-name
    // gets a sha256-hash suffix. The user's existing /login credential
    // is stored under the no-suffix service "Claude Code", so the proxy's
    // hashed lookup misses → iCH() returns null → all three auth-conflict
    // warnings silenced. Pointing at the default path preserves all
    // user customization (settings.json, skills, MCP, etc.).
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude"))
  })

  test("does NOT set ANTHROPIC_API_KEY (regression — Claude Code emits an Auth conflict warning when both AUTH_TOKEN and API_KEY are present, even with dummy values)", () => {
    // Verified live: claude 2.1.126 prints
    //   ⚠ Auth conflict: Both a token (ANTHROPIC_AUTH_TOKEN) and an API
    //     key (ANTHROPIC_API_KEY) are set. This may lead to unexpected
    //     behavior.
    // whenever both env vars exist. Stripping API_KEY from the parent env
    // (in launch.ts sanitizeParentEnv) AND not re-adding it here keeps
    // the warning silent. Inherited shell-exported real keys can't leak
    // because they're stripped at the parent level.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("ANTHROPIC_API_KEY")
  })

  test("does NOT set the empty-string clears (handled by parent-env sanitization)", () => {
    // CLAUDE_CODE_USE_*, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS
    // are stripped from process.env in launch.ts before the spread, so we
    // don't need to set them to "" here. Setting them to "" would also be
    // wrong — see the API_KEY case above; some Claude Code versions check
    // presence not value.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_USE_FOUNDRY")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN")
    expect(vars).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS")
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
