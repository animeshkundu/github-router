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

  test("sets MCP_TIMEOUT=2100000 (legacy belt-and-suspenders) and MCP_TOOL_TIMEOUT=2100000 (the load-bearing per-tool-call timeout on v2.1.141)", () => {
    // Two distinct env vars at play (per binary inspection of v2.1.141
    // `y13()`, 2026-05-14):
    //
    //   - MCP_TIMEOUT — historical/general MCP timeout, may apply to
    //     server-startup or initial-handshake but NOT confirmed to reach
    //     the per-tool-call HTTP wait on v2.1.138-141 (regressions
    //     #50289 / #52137 documented this as silently-ignored on the
    //     per-call path). Kept as belt-and-suspenders.
    //
    //   - MCP_TOOL_TIMEOUT — load-bearing on v2.1.141: `y13()` reads
    //     `parseInt(process.env.MCP_TOOL_TIMEOUT)` for the per-tool-call
    //     timeout passed to `client.callTool({...}, schema, {timeout:W})`.
    //     Default `1e8` ms (~27.7 hours) when the env is unset. Setting
    //     a finite-but-large value (10 min) surfaces regressions where
    //     the SDK silently caps lower AND prevents long-tail runaway
    //     calls from holding resources indefinitely.
    //
    // SDK detail: the `resetTimeoutOnProgress` opt-in in MCP SDK v1.29.0
    // is required for SSE notifications/progress to reset the per-call
    // timer. Claude Code v2.1.141 does NOT pass it, so SSE heartbeats
    // alone don't help — MCP_TOOL_TIMEOUT is the actual lever.
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.MCP_TIMEOUT).toBe("2100000")
    expect(vars.MCP_TOOL_TIMEOUT).toBe("2100000")
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

  test("defaults ANTHROPIC_SMALL_FAST_MODEL to claude-sonnet-4-6 with presence-based guard", () => {
    const prior = process.env.ANTHROPIC_SMALL_FAST_MODEL
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-4-6")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
      else process.env.ANTHROPIC_SMALL_FAST_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_SMALL_FAST_MODEL (presence guard preserves user's custom Copilot mapping)", () => {
    // Symmetric with launch.ts's STRIPPED_PARENT_ENV_KEYS comment that
    // intentionally does NOT strip ANTHROPIC_SMALL_FAST_MODEL — users
    // with custom Copilot mappings legitimately set this to a value
    // other than our claude-sonnet-4-6 default (gemini-2.0-flash,
    // gpt-5.5-mini, etc.).
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

  test("defaults CLAUDE_CODE_PLAN_V2_AGENT_COUNT to 7 with presence-based guard", () => {
    // Claude Code's getPlanModeV2AgentCount() (v2.1.158 binary, minified
    // fn `bGK`) reads CLAUDE_CODE_PLAN_V2_AGENT_COUNT first and, when set
    // to an int in 1..10, returns it unconditionally — ahead of the
    // subscription-tier branch. The synthetic credential's
    // max+default_claude_max_20x tier would yield 3 on the natural path;
    // this env override pins it to 7 regardless of tier.
    const prior = process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT
    delete process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.CLAUDE_CODE_PLAN_V2_AGENT_COUNT).toBe("7")
    } finally {
      if (prior === undefined)
        delete process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT
      else process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT = prior
    }
  })

  test("does NOT override a parent-set CLAUDE_CODE_PLAN_V2_AGENT_COUNT (presence guard preserves user's chosen count)", () => {
    const prior = process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT
    process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT = "3"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("CLAUDE_CODE_PLAN_V2_AGENT_COUNT")
    } finally {
      if (prior === undefined)
        delete process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT
      else process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT = prior
    }
  })

  test("defaults ANTHROPIC_DEFAULT_SONNET_MODEL to claude-sonnet-4-6 (NO [1m] — Copilot has no sonnet-1m backend)", () => {
    // Sonnet 4.6 has no -1m variant in Copilot's catalog as of 2026-05-22,
    // and Anthropic-side modelSupports1M (cc-backup context.ts:43-49) does
    // list sonnet-4*, but the Copilot proxy can't route there. A bracketed
    // default would either 400 upstream or silently over-account context
    // locally. Bare slug — explicit, safe.
    const prior = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6")
      expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toContain("[1m]")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_DEFAULT_SONNET_MODEL", () => {
    const prior = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3.1-pro-preview"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = prior
    }
  })

  test("defaults ANTHROPIC_DEFAULT_HAIKU_MODEL to claude-haiku-4-5 (NO [1m] — Haiku has no 1M variant on either side)", () => {
    // Anthropic-side modelSupports1M (cc-backup context.ts:43-49) does NOT
    // list any haiku at all. There is no 1M haiku in existence; bracketing
    // would be nonsense.
    const prior = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5")
      expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).not.toContain("[1m]")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_DEFAULT_HAIKU_MODEL", () => {
    const prior = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.5-mini"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = prior
    }
  })

  test("defaults ANTHROPIC_DEFAULT_OPUS_MODEL to bare claude-opus-4-8 (NO [1m] — the active default's [1m] decoration lives on ANTHROPIC_MODEL via pickClaudeDefault, which is cap-aware)", () => {
    // The picker-row tier default is the bare slug; the *active* default
    // (ANTHROPIC_MODEL) is cap-aware (pickClaudeDefault adds [1m] only
    // when the catalog actually signals 1M capability — either via a
    // sibling -1m slug or via base-slug max_context_window_tokens).
    // Keeping the picker row bare lets the user manually flip to 1M via
    // /model selection (Claude Code's picker shows "opus[1m]" as a
    // separate entry — see cc-backup aliases.ts MODEL_ALIASES).
    const prior = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-8")
      expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).not.toContain("[1m]")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_DEFAULT_OPUS_MODEL", () => {
    const prior = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-5"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prior
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
