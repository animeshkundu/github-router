import { test, expect, describe } from "bun:test"
import type { ServerHandler } from "srvx"

import { PATHS } from "../src/lib/paths"
import {
  FAST_LEAD_MODEL,
  BUDGET_SMALL_FAST_SLUG,
  isBudgetClaudeLead,
  resolveLeadSlugArg,
} from "../src/lib/port"
import { state } from "../src/lib/state"
import {
  MAX_REQUEST_BODY_BYTES,
  buildServeOptions,
  parseSharedArgs,
  getClaudeCodeEnvVars,
  getCodexEnvVars,
  withBodyLimit,
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

  test("sets MCP_TIMEOUT / MCP_TOOL_TIMEOUT to the resolved default (22500000 = 6h15m) when the parent env is unset", () => {
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
    //     a finite-but-large value (6h15m, `resolveMcpToolTimeoutMs()`)
    //     surfaces regressions where the SDK silently caps lower AND
    //     prevents long-tail runaway calls from holding resources
    //     indefinitely, while leaving the 6h worker wall-clock a full
    //     15-min teardown headroom under it.
    //
    // SDK detail: the `resetTimeoutOnProgress` opt-in in MCP SDK v1.29.0
    // is required for SSE notifications/progress to reset the per-call
    // timer. Claude Code v2.1.141 does NOT pass it, so SSE heartbeats
    // alone don't help — MCP_TOOL_TIMEOUT is the actual lever.
    const origTimeout = process.env.MCP_TIMEOUT
    const origToolTimeout = process.env.MCP_TOOL_TIMEOUT
    const origOverride = process.env.GH_ROUTER_MCP_TOOL_TIMEOUT_MS
    delete process.env.MCP_TIMEOUT
    delete process.env.MCP_TOOL_TIMEOUT
    delete process.env.GH_ROUTER_MCP_TOOL_TIMEOUT_MS
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.MCP_TIMEOUT).toBe("22500000")
      expect(vars.MCP_TOOL_TIMEOUT).toBe("22500000")
    } finally {
      if (origTimeout === undefined) delete process.env.MCP_TIMEOUT
      else process.env.MCP_TIMEOUT = origTimeout
      if (origToolTimeout === undefined) delete process.env.MCP_TOOL_TIMEOUT
      else process.env.MCP_TOOL_TIMEOUT = origToolTimeout
      if (origOverride === undefined) delete process.env.GH_ROUTER_MCP_TOOL_TIMEOUT_MS
      else process.env.GH_ROUTER_MCP_TOOL_TIMEOUT_MS = origOverride
    }
  })

  test("MCP_TIMEOUT / MCP_TOOL_TIMEOUT presence guard: a parent-set value is preserved (not overridden)", () => {
    // Symmetric with the ANTHROPIC_SMALL_FAST_MODEL / tier-default guards:
    // when the parent env already set the key we omit our override entirely
    // so the parent value flows through naturally (neither key is stripped).
    const origTimeout = process.env.MCP_TIMEOUT
    const origToolTimeout = process.env.MCP_TOOL_TIMEOUT
    process.env.MCP_TIMEOUT = "123"
    process.env.MCP_TOOL_TIMEOUT = "456"
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars).not.toHaveProperty("MCP_TIMEOUT")
      expect(vars).not.toHaveProperty("MCP_TOOL_TIMEOUT")
    } finally {
      if (origTimeout === undefined) delete process.env.MCP_TIMEOUT
      else process.env.MCP_TIMEOUT = origTimeout
      if (origToolTimeout === undefined) delete process.env.MCP_TOOL_TIMEOUT
      else process.env.MCP_TOOL_TIMEOUT = origToolTimeout
    }
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

  test("defaults ANTHROPIC_SMALL_FAST_MODEL to claude-sonnet-5 with presence-based guard", () => {
    const prior = process.env.ANTHROPIC_SMALL_FAST_MODEL
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5")
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
      else process.env.ANTHROPIC_SMALL_FAST_MODEL = prior
    }
  })

  test("does NOT override a parent-set ANTHROPIC_SMALL_FAST_MODEL (presence guard preserves user's custom Copilot mapping)", () => {
    // Symmetric with launch.ts's STRIPPED_PARENT_ENV_KEYS comment that
    // intentionally does NOT strip ANTHROPIC_SMALL_FAST_MODEL — users
    // with custom Copilot mappings legitimately set this to a value
    // other than our claude-sonnet-5 default (gemini-2.0-flash,
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

  test("defaults ANTHROPIC_DEFAULT_SONNET_MODEL to claude-sonnet-5, with a bare paired label", () => {
    // Sonnet 5 is the newer, cheaper cheap-tier pick (200/1000 vs 4.6's
    // 300/1500) and is broadly available (pro..enterprise). With no catalog
    // loaded there is no 1M signal, so the row is bare — cap-awareness, not a
    // family rule. The paired _NAME seed keeps the picker label readable once
    // the catalog DOES make the row bracketed (see the next test).
    const prior = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    const priorName = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    const savedModels = state.models
    state.models = undefined
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
      expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("claude-sonnet-5")
    } finally {
      state.models = savedModels
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = prior
      if (priorName === undefined)
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = priorName
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

  test("defaults ANTHROPIC_DEFAULT_HAIKU_MODEL to claude-sonnet-5 (cheap-tier pick lands on Sonnet 5, matching SMALL_FAST_MODEL)", () => {
    // The Haiku picker tier row is seeded to claude-sonnet-5 (not a haiku
    // slug) so the cheap-tier pick lands on Sonnet 5 — newer and cheaper
    // than the prior claude-haiku-4-5 default.
    const prior = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    const priorName = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
    const savedModels = state.models
    state.models = undefined
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5")
      expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe("claude-sonnet-5")
    } finally {
      state.models = savedModels
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = prior
      if (priorName === undefined)
        delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = priorName
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

  test("defaults ANTHROPIC_DEFAULT_OPUS_MODEL to claude-opus-5, bare when the catalog shows no 1M signal", () => {
    const prior = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    const priorName = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
    const savedModels = state.models
    state.models = undefined
    try {
      const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
      expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5")
      expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe("claude-opus-5")
    } finally {
      state.models = savedModels
      if (prior === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prior
      if (priorName === undefined)
        delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
      else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = priorName
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

describe("buildServeOptions", () => {
  const noopFetch = (() => new Response("")) as never

  // Regression guard for a bug that reads as a network fault, not a config
  // one. `Bun.serve` defaults `idleTimeout` to 10s and applies it to a
  // STREAMING response, so a >10s gap with a ReadableStream body open makes
  // Bun kill the socket. Node's srvx adapter has no equivalent default, which
  // is why this only ever hit users running the proxy under bun.
  //
  // Upstream Copilot goes quiet for longer than 10s routinely — extended
  // thinking and prompt processing on a large accumulated context both do it.
  // The client surfaces the kill as `UND_ERR_SOCKET other side closed` and
  // Claude Code reports `Unable to connect to API (ECONNRESET)`. Every retry
  // replays the same context, hits the same gap, and burns the whole backoff.
  //
  // Nothing fails loudly if this option is dropped: the proxy still starts,
  // still serves, and short responses still work. It only misbehaves on slow
  // streams, which is exactly when it is hardest to attribute. Hence a test.
  test("disables Bun's idle reaper so slow streams are not killed", () => {
    const opts = buildServeOptions(noopFetch, true)
    expect(opts.bun.idleTimeout).toBe(0)
  })

  test("binds loopback only and forwards the silent flag", () => {
    expect(buildServeOptions(noopFetch, true).hostname).toBe("127.0.0.1")
    expect(buildServeOptions(noopFetch, true).silent).toBe(true)
    expect(buildServeOptions(noopFetch, false).silent).toBe(false)
  })

  // Same class of defect as the idleTimeout guard above, and equally silent.
  // `Bun.serve` defaults `maxRequestBodySize` to 128 MB; `node:http` (the srvx
  // node adapter) has no body limit at all. Left unset, the identical request
  // 413s under bun and succeeds under node, and nothing in either response
  // tells the user the runtime was the variable.
  //
  // Asserting the literal (rather than just "is defined") is the point: this
  // is the value that decides which requests the proxy accepts, it is a
  // deliberate choice documented on MAX_REQUEST_BODY_BYTES, and drifting it
  // silently changes behaviour for every client on every runtime.
  test("pins the accepted-body limit to a deliberate, explicit value", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(128 * 1024 * 1024)
  })

  // The ceiling must be TOP-LEVEL, so it reaches every adapter. srvx's
  // `bun` namespace is bun-only; a body limit set there would put the two
  // runtimes back on different thresholds, which is the defect this closes
  // rather than a fix for it. Bun's 128 MB default has to be displaced by
  // SOMETHING, though: bun enforces at header-parse time by replying and
  // closing while the client is still uploading, so the client never reads
  // the reply (measured on a real 64 MB post: "The socket connection was
  // closed unexpectedly"). Hence a transport ceiling well above the policy,
  // leaving withBodyLimit to answer first with an explained 413.
  test("pins one transport ceiling for both runtimes, above the policy", () => {
    const opts = buildServeOptions(noopFetch, true)
    expect(opts.maxRequestBodySize).toBeGreaterThan(MAX_REQUEST_BODY_BYTES)
    // Finite: "no limit at all" is never the state on either runtime.
    expect(Number.isFinite(opts.maxRequestBodySize)).toBe(true)
    // Not a per-runtime body limit, which is the bug being fixed.
    expect(
      (opts.bun as Record<string, unknown>).maxRequestBodySize,
    ).toBeUndefined()
  })
})

describe("withBodyLimit", () => {
  const ok = (() => new Response("ok")) as ServerHandler
  const post = (headers: Record<string, string>) =>
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers,
    }) as never

  // Without this wrapper the node adapter rejects the body READ, not the
  // request: `c.req.json()` throws ERR_BODY_TOO_LARGE, the app installs no
  // Hono `onError`, and the user gets `500 Internal Server Error` —
  // indistinguishable from a real proxy fault. That opaque failure is the
  // whole reason this layer exists, so it is worth a test.
  test("rejects an over-limit declared body with an explained 413", async () => {
    const res = await withBodyLimit(ok)(
      post({ "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }),
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as {
      type: string
      error: { type: string; message: string }
    }
    // Anthropic error envelope, same shape as every other error path, so a
    // client that parses ours elsewhere parses this too.
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("request_too_large")
    // Comprehensible, not an opaque socket error: it must name both the
    // actual size and the ceiling, or the user cannot tell how far over
    // they are or whether trimming would help.
    //
    // Asserted in EXACT BYTES, at exactly one byte over, because that is
    // where a rounded-MB-only message self-contradicts: an end-to-end run
    // of this case produced "128.0 MB, over the 128.0 MB limit", which
    // tells the user nothing. The MB gloss may stay; the precise figure
    // must be there too.
    expect(body.error.message).toContain(String(MAX_REQUEST_BODY_BYTES + 1))
    expect(body.error.message).toContain(String(MAX_REQUEST_BODY_BYTES))
    expect(body.error.message.length).toBeGreaterThan(40)
  })

  test("passes through a body at exactly the limit", async () => {
    const res = await withBodyLimit(ok)(
      post({ "content-length": String(MAX_REQUEST_BODY_BYTES) }),
    )
    expect(res.status).toBe(200)
  })

  // Absent or non-numeric Content-Length (chunked transfer encoding) must
  // NOT be treated as over-limit — that would reject every streamed request.
  // Enforcement in that case is srvx's streaming limit, which still bounds
  // memory; this wrapper only improves the message on the common path.
  test("passes through when Content-Length is absent or unparseable", async () => {
    expect((await withBodyLimit(ok)(post({}))).status).toBe(200)
    expect(
      (await withBodyLimit(ok)(post({ "content-length": "not-a-number" })))
        .status,
    ).toBe(200)
  })

  test("does not consume the request body", async () => {
    const req = new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      body: "hello",
    })
    const res = await withBodyLimit(
      (async (r) => new Response(await r.text())) as ServerHandler,
    )(req as never)
    expect(await res.text()).toBe("hello")
  })

  // Layer 2: a body that declares no length still has to be bounded, and
  // still has to fail legibly. Left to the runtimes this is where they
  // diverge worst — bun kills the socket, node turns the failed body read
  // into Hono's generic 500 (the app installs no onError). Enforcing it
  // here makes the chunked case return the same 413 as the declared one.
  test("rejects an over-limit chunked body with the same 413", async () => {
    const chunk = new Uint8Array(64 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_REQUEST_BODY_BYTES) return controller.close()
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const req = new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      body,
      // Required by undici for a streamed request body.
      duplex: "half",
    } as RequestInit)
    // No declared length, so layer 1 cannot see it.
    expect(req.headers.get("content-length")).toBeNull()

    const res = await withBodyLimit(
      (async (r) => new Response(await r.text())) as ServerHandler,
    )(req as never)
    expect(res.status).toBe(413)
    const body2 = (await res.json()) as { error: { type: string } }
    expect(body2.error.type).toBe("request_too_large")
  })

  // The overflow must not reach the app as a 500, and must not escape as
  // a raw ERR_BODY_TOO_LARGE either. This pins the catch arm: a handler
  // that lets the error propagate (rather than converting it to a 500 the
  // way Hono does) still yields the explained 413.
  test("maps a propagating ERR_BODY_TOO_LARGE to the same 413", async () => {
    const throwing = (() => {
      throw Object.assign(new Error("body too large"), {
        code: "ERR_BODY_TOO_LARGE",
      })
    }) as ServerHandler
    const res = await withBodyLimit(throwing)(post({}))
    expect(res.status).toBe(413)
  })

  // ...but an unrelated handler error must still propagate untouched,
  // rather than being laundered into a misleading 413.
  test("does not swallow unrelated handler errors", async () => {
    const boom = (() => {
      throw new Error("kaboom")
    }) as ServerHandler
    expect(withBodyLimit(boom)(post({}))).rejects.toThrow("kaboom")
  })
})

// Budget mode: `-m fast` and the Haiku small/fast tier.
describe("budget-mode lead and small/fast tier", () => {
  // Entries are either a bare id (no advertised window — the shape most of
  // these tests want, since they are about tier selection rather than context
  // accounting) or an `[id, maxContextWindowTokens]` pair for the tests that
  // are specifically about the `[1m]` decoration.
  type CatalogEntry = string | readonly [string, number]

  function withCatalog<T>(ids: Array<CatalogEntry>, fn: () => T): T {
    const saved = state.models
    state.models = {
      object: "list",
      data: ids.map((entry) => {
        const [id, ctx] = typeof entry === "string" ? [entry, undefined] : entry
        return {
          id,
          name: id,
          object: "model",
          preview: false,
          vendor: "anthropic",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: id,
            limits:
              ctx === undefined ? {} : { max_context_window_tokens: ctx },
            object: "model",
            supports: {},
            tokenizer: "o200k_base",
            type: "chat",
          },
        }
      }) as unknown as NonNullable<typeof state.models>["data"],
    }
    try {
      return fn()
    } finally {
      state.models = saved
    }
  }

  // Every tier key this block asserts on must be cleared, not just the ones it
  // expects to change: these tests run inside a proxy-launched session that
  // already exports the tier defaults, and the presence guard would otherwise
  // skip the assignment and make the assertion depend on the ambient shell.
  function withoutUserOverrides(fn: () => void): void {
    const keys = [
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
      "ANTHROPIC_CUSTOM_MODEL_OPTION",
      "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
      "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
    ] as const
    const prior = keys.map((k) => [k, process.env[k]] as const)
    for (const k of keys) delete process.env[k]
    try {
      fn()
    } finally {
      for (const [k, v] of prior) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  // The live Copilot catalog as measured on 2026-08-13: every current Claude
  // model advertises a 1M window except Haiku 4.5, which really is 200K. These
  // tests use it rather than a bare-id fixture because a fixture with no
  // advertised window cannot tell a correct "left bare" from the bug — it makes
  // every model look 200K, which is exactly why the gap below went unnoticed.
  const LIVE_SHAPED_CATALOG = [
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-haiku-4.5", 200_000],
  ] as const

  function withoutOneMOptOut(fn: () => void): void {
    const prior = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    try {
      fn()
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prior
    }
  }

  test("`-m fast` resolves to the fast (Luna) lead", () => {
    withCatalog([], () => {
      expect(resolveLeadSlugArg("fast")).toBe(FAST_LEAD_MODEL)
      expect(resolveLeadSlugArg("FAST")).toBe(FAST_LEAD_MODEL)
    })
  })

  test("`-m fast` carries [1m] when the catalog says gpt-5.6-luna serves 1M", () => {
    // gpt-5.6-luna ships a single slug advertising 1M, no `-1m` sibling — the
    // fast lead gets local 1M accounting exactly like every other branch.
    withoutOneMOptOut(() => {
      withCatalog(
        [...LIVE_SHAPED_CATALOG, ["gpt-5.6-luna", 1_000_000]],
        () => {
          expect(resolveLeadSlugArg("fast")).toBe("gpt-5.6-luna[1m]")
        },
      )
    })
  })

  test("`-m fast` and the explicit Luna slug agree, so both give the same session", () => {
    withoutOneMOptOut(() => {
      withCatalog(
        [...LIVE_SHAPED_CATALOG, ["gpt-5.6-luna", 1_000_000]],
        () => {
          // Identical STRING, not merely identical resolution: the context
          // budget is part of what "the same session" means.
          expect(resolveLeadSlugArg("fast")).toBe(
            resolveLeadSlugArg("gpt-5.6-luna"),
          )
          // gpt-5.6-luna is NOT a Claude model, so the fast profile is NOT a
          // "budget Claude lead" — that predicate/mechanism is unrelated to
          // the fast profile (see `resolveLeadSlugArg`'s doc).
          expect(isBudgetClaudeLead(resolveLeadSlugArg("fast"))).toBe(false)
          expect(isBudgetClaudeLead("gpt-5.6-luna")).toBe(false)
          expect(isBudgetClaudeLead("gpt-5.6-luna[1m]")).toBe(false)
        },
      )
    })
  })

  test("a full slug passes through, decorated only when the catalog backs it", () => {
    withoutOneMOptOut(() => {
      withCatalog([...LIVE_SHAPED_CATALOG], () => {
        expect(resolveLeadSlugArg("claude-opus-5")).toBe("claude-opus-5[1m]")
        // Haiku 4.5 genuinely is 200K, so it stays bare — the rule is the
        // catalog's advertised window, not a hardcoded family list.
        expect(resolveLeadSlugArg("claude-haiku-4-5")).toBe("claude-haiku-4-5")
        expect(isBudgetClaudeLead("claude-opus-5")).toBe(false)
        expect(isBudgetClaudeLead("claude-opus-5[1m]")).toBe(false)
      })
    })
  })

  test("a dashed Anthropic slug is decorated even though the catalog id is dotted", () => {
    // An exact-id match would answer "no 1M" here purely because it never found
    // `claude-sonnet-4-6` in a catalog that carries `claude-sonnet-4.6`. That
    // silent under-accounting is why the lead decorator resolves first.
    withoutOneMOptOut(() => {
      withCatalog([...LIVE_SHAPED_CATALOG], () => {
        expect(resolveLeadSlugArg("claude-sonnet-4-6")).toBe(
          "claude-sonnet-4-6[1m]",
        )
      })
    })
  })

  test("a hand-pinned [1m] slug is not double-decorated", () => {
    withoutOneMOptOut(() => {
      withCatalog([...LIVE_SHAPED_CATALOG], () => {
        expect(resolveLeadSlugArg("claude-sonnet-5[1m]")).toBe(
          "claude-sonnet-5[1m]",
        )
        expect(resolveLeadSlugArg("claude-opus-5[1m]")).toBe("claude-opus-5[1m]")
      })
    })
  })

  test("a 200K sonnet catalog leaves a pinned sonnet slug bare", () => {
    // Cap-awareness in the direction that matters: on a tier where sonnet-5 is
    // not 1M, claiming it would make Claude Code over-account and compact late.
    // (Not about `-m fast` — that's the Luna profile now, tested above.)
    withoutOneMOptOut(() => {
      withCatalog([["claude-sonnet-5", 200_000]], () => {
        expect(resolveLeadSlugArg("claude-sonnet-5")).toBe("claude-sonnet-5")
      })
    })
  })

  test("an unpopulated catalog leaves every branch bare", () => {
    withoutOneMOptOut(() => {
      const saved = state.models
      state.models = undefined
      try {
        expect(resolveLeadSlugArg("fast")).toBe(FAST_LEAD_MODEL)
        expect(resolveLeadSlugArg("claude-opus-5")).toBe("claude-opus-5")
      } finally {
        state.models = saved
      }
    })
  })

  test("tier rows carry [1m] when the catalog backs it, and the paired label stays bare", () => {
    // Selecting a tier row makes its env value the ACTIVE model id (Claude Code
    // `model.ts:456-465` returns `getDefaultSonnetModel()` verbatim), so a bare
    // row is the same 200K under-accounting the active default guards against,
    // one interaction later. The label is seeded bare because Claude Code falls
    // back to the RAW env value for a custom row's label
    // (`modelOptions.ts:76-90`), so an undecorated label keeps the picker
    // reading exactly as it does today while the value carries the bracket.
    withoutOneMOptOut(() => {
      withCatalog([...LIVE_SHAPED_CATALOG], () => {
        withoutUserOverrides(() => {
          const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
          expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
            "claude-sonnet-5[1m]",
          )
          expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe(
            "claude-sonnet-5",
          )
          expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5[1m]")
          expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe("claude-opus-5")
        })
      })
    })
  })

  test("fast Luna aliases declare their live effort/thinking capabilities", () => {
    withoutOneMOptOut(() => {
      withCatalog([["gpt-5.6-luna", 1_050_000]], () => {
        withoutUserOverrides(() => {
          const vars = getClaudeCodeEnvVars(
            "http://127.0.0.1:8787",
            "gh-router-luna-driver-max[1m]",
            "fast",
          )
          const expected =
            "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
          expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(expected)
          expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toBe(expected)
        })
      })
    })
  })

  test("the Haiku row stays bare on a budget lead, because Haiku 4.5 really is 200K", () => {
    // The decoration is cap-aware per model, not per family: the same call that
    // brackets the Sonnet row leaves this one alone. Asserting it on the budget
    // lead is the discriminating case, since that is when the row actually
    // holds a Haiku slug rather than following Sonnet.
    withoutOneMOptOut(() => {
      withCatalog([...LIVE_SHAPED_CATALOG], () => {
        withoutUserOverrides(() => {
          const vars = getClaudeCodeEnvVars(
            "http://127.0.0.1:8787",
            "claude-sonnet-5",
          )
          expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
            BUDGET_SMALL_FAST_SLUG,
          )
          expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).not.toContain("[1m]")
        })
      })
    })
  })

  test("a user-set tier model suppresses our label too, and a user-set label wins over ours", () => {
    // The NAME rides on the MODEL guard rather than its own. Seeding it
    // independently would print "claude-sonnet-5" as the label for a user's
    // pinned gemini model — a flatly wrong model name in the picker. When we DO
    // seed the model, a user-set label still wins.
    const priorModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    const priorName = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    try {
      withoutOneMOptOut(() => {
        withCatalog([...LIVE_SHAPED_CATALOG], () => {
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3.1-pro-preview"
          delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
          let vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
          expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL")
          expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME")

          delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = "My Sonnet"
          vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
          expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
            "claude-sonnet-5[1m]",
          )
          expect(vars).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME")
        })
      })
    } finally {
      if (priorModel === undefined)
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = priorModel
      if (priorName === undefined)
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = priorName
    }
  })

  test("CLAUDE_CODE_DISABLE_1M_CONTEXT suppresses the decoration on every branch", () => {
    const prior = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"
    try {
      withCatalog([...LIVE_SHAPED_CATALOG, ["gpt-5.6-luna", 1_000_000]], () => {
        expect(resolveLeadSlugArg("fast")).toBe("gpt-5.6-luna")
        expect(resolveLeadSlugArg("claude-opus-5")).toBe("claude-opus-5")
        expect(resolveLeadSlugArg("claude-sonnet-4-6")).toBe(
          "claude-sonnet-4-6",
        )
      })
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prior
    }
  })

  test("a budget lead drops the small/fast tier and the Haiku row to Haiku", () => {
    withCatalog(["claude-sonnet-5", "claude-haiku-4.5"], () => {
      withoutUserOverrides(() => {
        const vars = getClaudeCodeEnvVars(
          "http://127.0.0.1:8787",
          "claude-sonnet-5",
        )
        // The Anthropic DASHED slug, not Copilot's dotted catalog id: Claude
        // Code's /model registry is keyed on Anthropic slugs.
        expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe(BUDGET_SMALL_FAST_SLUG)
        expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(BUDGET_SMALL_FAST_SLUG)
        // The Sonnet tier row is untouched: it is not the cheap tier.
        expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
      })
    })
  })

  test("an opus lead keeps today's Sonnet small/fast tier", () => {
    withCatalog(["claude-opus-5", "claude-haiku-4.5"], () => {
      withoutUserOverrides(() => {
        const vars = getClaudeCodeEnvVars(
          "http://127.0.0.1:8787",
          "claude-opus-5",
        )
        expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5")
        expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5")
      })
    })
  })

  test("a catalog without Haiku falls back to Sonnet rather than naming an absent model", () => {
    withCatalog(["claude-sonnet-5"], () => {
      withoutUserOverrides(() => {
        const vars = getClaudeCodeEnvVars(
          "http://127.0.0.1:8787",
          "claude-sonnet-5",
        )
        expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5")
        expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5")
      })
    })
  })

  test("a user-set small/fast model survives budget mode", () => {
    withCatalog(["claude-sonnet-5", "claude-haiku-4.5"], () => {
      const prior = process.env.ANTHROPIC_SMALL_FAST_MODEL
      process.env.ANTHROPIC_SMALL_FAST_MODEL = "gemini-3.6-flash"
      try {
        const vars = getClaudeCodeEnvVars(
          "http://127.0.0.1:8787",
          "claude-sonnet-5",
        )
        expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
      } finally {
        if (prior === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
        else process.env.ANTHROPIC_SMALL_FAST_MODEL = prior
      }
    })
  })
})
