import { test, expect, describe } from "bun:test"

import { PATHS } from "../src/lib/paths"
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
    expect(vars.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("does NOT set ANTHROPIC_AUTH_TOKEN — auth flows from synthetic .credentials.json in CLAUDE_CONFIG_DIR mirror", () => {
    // Pre-fix: the proxy set ANTHROPIC_AUTH_TOKEN="dummy" so Claude
    // Code's pre-flight had an auth source. Spawned teammates dropped
    // this env var (Claude Code v2.1.140's teammate-spawn allowlist),
    // landing them at "Not logged in · Run /login".
    //
    // Post-fix: `ensureClaudeConfigMirror` writes a synthetic
    // claudeAiOauth credential to PATHS.CLAUDE_CONFIG_DIR/.credentials.json.
    // CLAUDE_CONFIG_DIR IS in the teammate-spawn allowlist, so teammates
    // inherit the path, find the credential file, and authenticate.
    // No env-source auth is needed — and dropping it silences the
    // file-managed-key vs env auth-conflict warning.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN")
  })

  test("sets MCP_TIMEOUT=600000 to extend HTTP MCP per-tool-call wait beyond the v2.1.113+ regression", () => {
    // Regression context: GitHub issue
    // https://github.com/anthropics/claude-code/issues/50289 — open,
    // labeled `bug, regression, has repro`. The .mcp.json per-server
    // `timeout` field is silently dropped for HTTP transport since
    // Claude Code 2.1.113. The MCP_TIMEOUT env var symbol is in the
    // v2.1.138 binary's env-var allowlist; the empirical question is
    // whether it actually extends the per-tool-call HTTP wait (vs.
    // just server-startup). This test asserts we set it; whether it
    // works at runtime is what Phase 1 of the peer-MCP plan tests.
    // See docs/peer-mcp-design.md and docs/research/peer-mcp-investigation.md.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.MCP_TIMEOUT).toBe("600000")
  })

  test("sets CLAUDE_CONFIG_DIR to the router-owned snapshot mirror (not ~/.claude)", () => {
    // Per binary-grep of Claude Code 2.1.126 iN(): when CLAUDE_CONFIG_DIR
    // is set (to ANYTHING — even its default), the keychain service-name
    // gets a sha256-hash suffix. The user's existing /login credential is
    // stored under the no-suffix service "Claude Code", so the proxy's
    // hashed lookup misses → iCH() returns null.
    //
    // The PATH we point at is now PATHS.CLAUDE_CONFIG_DIR (router-owned
    // snapshot mirror in ~/.local/share/github-router/claude-config/),
    // NOT ~/.claude. ensureClaudeConfigMirror snapshot-copies the user's
    // ~/.claude into this path (excluding .credentials.json + volatile
    // state) and writes our synthetic claudeAiOauth credential. Spawned
    // teammates inherit CLAUDE_CONFIG_DIR via Claude Code's allowlist
    // and authenticate against the synthetic credential.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.CLAUDE_CONFIG_DIR).toBe(PATHS.CLAUDE_CONFIG_DIR)
    expect(vars.CLAUDE_CONFIG_DIR).toContain("github-router")
    expect(vars.CLAUDE_CONFIG_DIR).toContain("claude-config")
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

  test("defaults ANTHROPIC_SMALL_FAST_MODEL to claude-haiku-4-5 with presence-based guard", () => {
    const prior = process.env.ANTHROPIC_SMALL_FAST_MODEL
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-haiku-4-5")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
      else process.env.ANTHROPIC_SMALL_FAST_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_SMALL_FAST_MODEL (presence guard preserves user's custom Copilot mapping)", () => {
    // Symmetric with launch.ts's STRIPPED_PARENT_ENV_KEYS comment that
    // intentionally does NOT strip ANTHROPIC_SMALL_FAST_MODEL — users
    // with custom Copilot mappings legitimately set this to a non-haiku
    // value (gemini-2.0-flash, gpt-5.5-mini, etc.).
    const prior = process.env.ANTHROPIC_SMALL_FAST_MODEL
    process.env.ANTHROPIC_SMALL_FAST_MODEL = "gemini-2.0-flash"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("ANTHROPIC_SMALL_FAST_MODEL")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
      else process.env.ANTHROPIC_SMALL_FAST_MODEL = prior
    }
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

const EXPERIMENTAL_ENABLES = [
  "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL",
  "CLAUDE_CODE_FORK_SUBAGENT",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "CLAUDE_CODE_ENABLE_TASKS",
]

describe("experimental feature auto-enable", () => {
  test.each(EXPERIMENTAL_ENABLES)(
    "%s defaults to '1' when parent env is unset (auto-enable Anthropic experimental feature)",
    (key) => {
      const prior = process.env[key]
      delete process.env[key]
      try {
        const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
        expect(vars[key]).toBe("1")
      } finally {
        if (prior === undefined) delete process.env[key]
        else process.env[key] = prior
      }
    },
  )

  test.each(EXPERIMENTAL_ENABLES)(
    "%s does NOT override a parent-set '0' (literal opt-out honored by presence-based guard)",
    (key) => {
      const prior = process.env[key]
      process.env[key] = "0"
      try {
        const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
        expect(vars[key]).toBeUndefined()
      } finally {
        if (prior === undefined) delete process.env[key]
        else process.env[key] = prior
      }
    },
  )

  test.each(EXPERIMENTAL_ENABLES)(
    "%s does NOT override a parent-set 'false' (Anthropic SH() falsy semantics — value preserved by presence-based guard)",
    (key) => {
      const prior = process.env[key]
      process.env[key] = "false"
      try {
        const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
        expect(vars[key]).toBeUndefined()
      } finally {
        if (prior === undefined) delete process.env[key]
        else process.env[key] = prior
      }
    },
  )
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
