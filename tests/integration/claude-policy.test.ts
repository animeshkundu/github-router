import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../../src/lib/state"
import { server } from "../../src/server"
import { filterBetaHeader } from "../../src/lib/utils"
import { sanitizeParentEnv } from "../../src/lib/launch"
import { getClaudeCodeEnvVars } from "../../src/lib/server-setup"

/**
 * Phase F regression gate (P2.4): two-layer per codex-critic.
 *
 * Layer 1 — durable contract test (THIS file): asserts the router's
 * allow/deny POLICY rather than a historical fingerprint snapshot.
 * If a future change regresses ANY of the empirically-validated
 * transformations from the plan's empirical appendix (2026-05-11
 * against api.enterprise.githubcopilot.com), this test fails.
 *
 * Layer 2 — drift canary (tests/canaries/*.snapshot.json): informational
 * snapshot of the current Claude Code wire shape for future diff
 * visibility.
 */

const originalFetch = globalThis.fetch
const savedExtendedBetas = state.extendedBetas
let savedModels: typeof state.models

function makeClaudeModel(id: string) {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model",
      supports: {},
      tokenizer: "claude",
      type: "chat",
    },
  }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "enterprise"
  state.extendedBetas = true // exercise the leverage path
  savedModels = state.models
  state.models = {
    object: "list",
    data: [
      makeClaudeModel("claude-opus-4.7"),
      makeClaudeModel("claude-sonnet-4.5"),
      makeClaudeModel("claude-sonnet-4.6"),
      makeClaudeModel("claude-haiku-4.5"),
    ] as unknown as NonNullable<typeof state.models>["data"],
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.extendedBetas = savedExtendedBetas
  state.models = savedModels
})

function emptyMessageResponse() {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.7",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
  )
}

function captureUpstream(): {
  body: () => unknown
  headers: () => Record<string, string>
} {
  const captured: { body?: string; headers?: Record<string, string> } = {}
  const fetchMock = mock(
    (
      url: string,
      opts?: { body?: string; headers?: Record<string, string> },
    ) => {
      if (url.includes("/v1/messages")) {
        captured.body = opts?.body
        captured.headers = opts?.headers
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    },
  )
  // @ts-expect-error - override fetch
  globalThis.fetch = fetchMock
  return {
    body: () => JSON.parse(captured.body ?? "{}"),
    headers: () => captured.headers ?? {},
  }
}

// ─────────────────────────────────────────────────────────────────────
//  POLICY: anthropic-beta filter (Phase A P0.1)
// ─────────────────────────────────────────────────────────────────────

describe("contract: anthropic-beta allow/deny policy", () => {
  test("default-stealth mode strips ALL Claude-CLI extended prefixes (regression guard)", () => {
    state.extendedBetas = false
    // Synthetic unknown future prefix — must be dropped (only the 3
    // VS Code prefixes survive).
    expect(
      filterBetaHeader(
        "interleaved-thinking-2025-05-14,hypothetical-future-2027-01-01",
      ),
    ).toBe("interleaved-thinking-2025-05-14")
    // Each of the 17 extended prefixes must be dropped.
    for (const prefix of [
      "claude-code-",
      "effort-",
      "prompt-caching-",
      "computer-use-",
      "pdfs-",
      "max-tokens-",
      "token-counting-",
      "compact-",
      "structured-outputs-",
      "fast-mode-",
      "mcp-client-",
      "mcp-servers-",
      "redact-thinking-",
      "web-search-",
      "task-budgets-",
      "token-efficient-tools-",
    ]) {
      expect(filterBetaHeader(`${prefix}2999-01-01`)).toBeUndefined()
    }
  })

  test("extended/leverage mode allows every empirically-verified prefix (Phase A baseline)", () => {
    state.extendedBetas = true
    // Each prefix that Copilot returned 200 on (verified live 2026-05-11).
    for (const value of [
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "advanced-tool-use-2025-11-20",
      "claude-code-20250219",
      "effort-2025-11-24",
      "prompt-caching-2024-07-31",
      "prompt-caching-scope-2026-01-05",
      "computer-use-2024-10-22",
      "pdfs-2024-09-25",
      "max-tokens-2024-08-08",
      "token-counting-2024-11-01",
      "compact-2025-04-08",
      "structured-outputs-2025-12-15",
      "fast-mode-2026-02-01",
      "mcp-client-2025-04-04",
      "mcp-servers-2025-04-04",
      "redact-thinking-2026-02-12",
      "web-search-2025-03-05",
      "task-budgets-2026-03-13",
      "token-efficient-tools-2026-03-28",
      "summarize-connector-text-2026-03-13",
      "afk-mode-2026-01-31",
      "cli-internal-2026-02-09",
      "oauth-2025-04-20",
    ]) {
      expect(filterBetaHeader(value)).toBe(value)
    }
  })

  test("extended/leverage mode STRIPS advisor-tool-* (Copilot 400 verified)", () => {
    state.extendedBetas = true
    // Critical: ADVISOR is the user-named "leverage feature" that Copilot
    // doesn't support. Strip prevents the entire request from failing
    // with HTTP 400.
    expect(filterBetaHeader("advisor-tool-2026-03-01")).toBeUndefined()
    // Surgical: bundled with valid betas, only ADVISOR drops.
    expect(
      filterBetaHeader(
        "task-budgets-2026-03-13,advisor-tool-2026-03-01,interleaved-thinking-2025-05-14",
      ),
    ).toBe("task-budgets-2026-03-13,interleaved-thinking-2025-05-14")
  })

  test("extended/leverage mode STRIPS Copilot-incompatible older prefixes (regression guard)", () => {
    state.extendedBetas = true
    // These all return Copilot 400 per CLAUDE.md "Beta header filtering".
    for (const value of [
      "context-1m-2025-08-07",
      "skills-2025-10-02",
      "files-api-2025-04-14",
      "code-execution-2025-05-22",
      "output-128k-2025-02-19",
    ]) {
      expect(filterBetaHeader(value)).toBeUndefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
//  POLICY: body-field strip (Phase B P0.2)
// ─────────────────────────────────────────────────────────────────────

describe("contract: body-field strip policy on /v1/messages", () => {
  // Each of these MUST 400 from Copilot if forwarded as-is. The proxy
  // strips them so the request succeeds. Verified live 2026-05-11.

  const claudeBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      model: "claude-opus-4.7",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    })

  test("strips top-level `budget` regardless of shape", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({ budget: { total_tokens: 99999 } }),
    })
    const fwd = captured.body() as { budget?: unknown }
    expect(fwd.budget).toBeUndefined()
  })

  test("strips top-level `output_config.schema` (preserves output_config siblings)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        output_config: {
          schema: { type: "object", properties: { foo: { type: "string" } } },
        },
      }),
    })
    const fwd = captured.body() as { output_config?: { schema?: unknown } }
    // schema stripped; whole output_config dropped (no sibling fields)
    expect(fwd.output_config).toBeUndefined()
  })

  test("strips top-level `output_config: {type:'json_object'}` (Structured Outputs short form — Copilot 400s on `output_config: Extra inputs are not permitted`)", async () => {
    // Regression for the Stop hook / SDK structured-output path bug:
    // Claude Code's hook evaluator and the Anthropic SDK's
    // structured-output API send the short form
    // `output_config: {type: "json_object"}` without `.schema`. The
    // previous strip logic only triggered when `.schema` was present
    // and left this shape untouched, causing Copilot to 400.
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({ output_config: { type: "json_object" } }),
    })
    const fwd = captured.body() as { output_config?: unknown }
    expect(fwd.output_config).toBeUndefined()
  })

  test("preserves `output_config: {effort}` (set by translateThinking for adaptive-thinking models — must not be stripped)", async () => {
    // Defense-in-depth: prove the strip logic doesn't accidentally
    // remove the proxy's own adaptive-thinking translation output.
    // `effort` is in the PROXY_OWNED_FIELDS allowlist; everything
    // else gets stripped. (translateThinking would set this on
    // adaptive-thinking models; here we send it directly to test
    // the allowlist behavior in isolation.)
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({ output_config: { effort: "high" } }),
    })
    const fwd = captured.body() as {
      output_config?: { effort?: string }
    }
    expect(fwd.output_config?.effort).toBe("high")
  })

  test("strips Structured-Outputs siblings of `effort` (mixed shape: keeps effort, drops type/schema)", async () => {
    // If a client sends a hybrid `output_config: {effort, type,
    // schema}` (unusual but spec-allowed), the strip preserves
    // `effort` and removes the rest.
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        output_config: {
          effort: "medium",
          type: "json_object",
          schema: { type: "object" },
        },
      }),
    })
    const fwd = captured.body() as {
      output_config?: { effort?: string; type?: string; schema?: unknown }
    }
    expect(fwd.output_config?.effort).toBe("medium")
    expect(fwd.output_config?.type).toBeUndefined()
    expect(fwd.output_config?.schema).toBeUndefined()
  })

  test("appends Structured Outputs schema as system-prompt instruction when stripping `output_config.schema` (preserves the structured-output INTENT — Stop hook regression)", async () => {
    // Without this, Claude Code's hook evaluator fails with
    // `JSON validation failed` because the model produces
    // natural-language text after the proxy strips output_config.
    // The proxy injects the schema into the system prompt as a
    // natural-language instruction so the model still produces
    // conforming JSON (best-effort, no server-side enforcement).
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        system: "You are a helpful assistant.",
        output_config: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["ok", "reason"],
          },
        },
      }),
    })
    const fwd = captured.body() as {
      system?: string | Array<{ type: string; text: string }>
      output_config?: unknown
    }
    expect(fwd.output_config).toBeUndefined()
    expect(typeof fwd.system).toBe("string")
    expect(fwd.system as string).toContain("You are a helpful assistant.")
    expect(fwd.system as string).toContain("MUST be a single valid JSON object")
    expect(fwd.system as string).toContain('"ok"')
    expect(fwd.system as string).toContain('"reason"')
  })

  test("appends short-form output_config: {type:'json_object'} as system-prompt instruction (no schema)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        output_config: { type: "json_object" },
      }),
    })
    const fwd = captured.body() as {
      system?: string | Array<{ type: string; text: string }>
      output_config?: unknown
    }
    expect(fwd.output_config).toBeUndefined()
    // Body had no system; the instruction is added as the new system value.
    expect(typeof fwd.system).toBe("string")
    expect(fwd.system as string).toContain("MUST be a single valid JSON object")
    expect(fwd.system as string).toContain("Output type requested: json_object")
  })

  test("preserves array-shape `system` when appending schema instruction", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        system: [{ type: "text", text: "You are a careful assistant." }],
        output_config: {
          schema: { type: "object", properties: { x: { type: "number" } } },
        },
      }),
    })
    const fwd = captured.body() as {
      system?: Array<{ type: string; text: string }>
    }
    expect(Array.isArray(fwd.system)).toBe(true)
    expect(fwd.system!.length).toBe(2)
    expect(fwd.system![0]!.text).toBe("You are a careful assistant.")
    expect(fwd.system![1]!.text).toContain("MUST be a single valid JSON object")
  })

  test("strips top-level `betas` array (distinct from anthropic-beta header)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({ betas: ["interleaved-thinking-2025-05-14"] }),
    })
    const fwd = captured.body() as { betas?: unknown }
    expect(fwd.betas).toBeUndefined()
  })

  test("PRESERVES `metadata` (Copilot 200, ignored harmlessly — codex-critic preservation guidance)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({ metadata: { user_id: "test-user" } }),
    })
    const fwd = captured.body() as { metadata?: { user_id?: string } }
    expect(fwd.metadata).toEqual({ user_id: "test-user" })
  })

  test("REJECTS `mcp_servers` (Phase G fail-fast — translate path deferred per codex-critic)", async () => {
    const captured = captureUpstream()
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        mcp_servers: [{ type: "url", url: "https://example.com/mcp", name: "x" }],
      }),
    })
    // Phase G now fail-fast 400s instead of pass-through. The original
    // peer-review-driven policy was "preserve and let Copilot 400" but
    // codex-critic's design review DEFERRED the translate path due to
    // structural design holes (continuation-after-TTL not implementable;
    // streaming correctness fragile). Fail-fast with helpful error
    // pointing at ~/.claude/mcp.json is the better Pareto.
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.message).toContain("mcp_servers")
    expect(body.error.message).toContain("~/.claude/mcp.json")
    // Never forwarded to Copilot. captured.body() returns {} when the
    // mock fetch was never called (the helper falls back to JSON.parse("{}")).
    expect(captured.body()).toEqual({})
  })

  test("PRESERVES arbitrary tool definitions (TeamCreate / GOAL / etc. flow through)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: claudeBody({
        tools: [
          {
            name: "TeamCreate",
            description: "Create a team",
            input_schema: {
              type: "object",
              properties: { team_name: { type: "string" } },
            },
          },
          {
            name: "TaskCreate",
            description: "Create a task",
            input_schema: {
              type: "object",
              properties: { subject: { type: "string" } },
            },
          },
        ],
      }),
    })
    const fwd = captured.body() as { tools?: Array<{ name: string }> }
    expect(fwd.tools).toHaveLength(2)
    expect(fwd.tools?.map((t) => t.name).sort()).toEqual([
      "TaskCreate",
      "TeamCreate",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────
//  POLICY: legacy model fallback (Phase A P0.4)
// ─────────────────────────────────────────────────────────────────────

describe("contract: legacy model fallback (resolveModel Step 6)", () => {
  test("legacy Sonnet 3.7 → highest sonnet (would otherwise dead-end)", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const fwd = captured.body() as { model: string }
    expect(fwd.model).toBe("claude-sonnet-4.6")
  })

  test("legacy Sonnet 4.0 → highest sonnet", async () => {
    const captured = captureUpstream()
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-0",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const fwd = captured.body() as { model: string }
    expect(fwd.model).toBe("claude-sonnet-4.6")
  })
})

// ─────────────────────────────────────────────────────────────────────
//  POLICY: env strips (Phase A P1.3)
// ─────────────────────────────────────────────────────────────────────

describe("contract: parent-env strip policy", () => {
  test("strips every Bridge / remote-session key (would activate code paths the proxy can't serve)", () => {
    const fixture: NodeJS.ProcessEnv = {
      CLAUDE_BRIDGE_OAUTH_TOKEN: "x",
      CLAUDE_BRIDGE_BASE_URL: "x",
      CLAUDE_BRIDGE_SESSION_INGRESS_URL: "x",
      SESSION_INGRESS_URL: "x",
      CLAUDE_CODE_REMOTE: "1",
      CLAUDE_CODE_CONTAINER_ID: "x",
      CLAUDE_CODE_REMOTE_SESSION_ID: "x",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_ADDITIONAL_PROTECTION: "true",
      // PRESERVED — gemini-critic finding: stripping would be unforced error
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001",
      // Unrelated baseline
      PATH: "/usr/bin",
    }
    const sanitized = sanitizeParentEnv(fixture)
    for (const k of [
      "CLAUDE_BRIDGE_OAUTH_TOKEN",
      "CLAUDE_BRIDGE_BASE_URL",
      "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
      "SESSION_INGRESS_URL",
      "CLAUDE_CODE_REMOTE",
      "CLAUDE_CODE_CONTAINER_ID",
      "CLAUDE_CODE_REMOTE_SESSION_ID",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ADDITIONAL_PROTECTION",
    ]) {
      expect(sanitized[k]).toBeUndefined()
    }
    // ANTHROPIC_SMALL_FAST_MODEL preserved (codex-reviewer warned strip
    // would degrade legitimate use cases).
    expect(sanitized.ANTHROPIC_SMALL_FAST_MODEL).toBe(
      "claude-haiku-4-5-20251001",
    )
    expect(sanitized.PATH).toBe("/usr/bin")
  })
})

// ─────────────────────────────────────────────────────────────────────
//  POLICY: getClaudeCodeEnvVars sets the right defaults (Phase A P1.2)
// ─────────────────────────────────────────────────────────────────────

describe("contract: spawned-Claude env defaults", () => {
  test("sets DISABLE_TELEMETRY + DISABLE_NON_ESSENTIAL_MODEL_CALLS + CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
    const env = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(env.DISABLE_TELEMETRY).toBe("1")
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("sets MCP_TIMEOUT and MCP_TOOL_TIMEOUT to 600000ms (10 min — MCP_TOOL_TIMEOUT is the load-bearing per-tool-call lever on v2.1.141)", () => {
    const env = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(env.MCP_TIMEOUT).toBe("600000")
    expect(env.MCP_TOOL_TIMEOUT).toBe("600000")
  })

  test("sets CLAUDE_CONFIG_DIR to the router-owned snapshot mirror (per-config-dir keychain isolation, plus auth-substrate for spawned teammates)", () => {
    const env = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(env.CLAUDE_CONFIG_DIR).toBeDefined()
    // Post-fix: points at PATHS.CLAUDE_CONFIG_DIR (router-owned snapshot
    // mirror under ~/.local/share/github-router/claude-config/), not
    // ~/.claude. The mirror's .credentials.json provides synthetic OAuth
    // for spawned teammates that drop ANTHROPIC_AUTH_TOKEN from their
    // env (Claude Code v2.1.140 teammate-spawn allowlist gap).
    expect(env.CLAUDE_CONFIG_DIR).toContain("github-router")
    expect(env.CLAUDE_CONFIG_DIR).toContain("claude-config")
  })

  test("sets ANTHROPIC_BASE_URL to proxy URL; does NOT set ANTHROPIC_AUTH_TOKEN (auth flows from synthetic .credentials.json in CLAUDE_CONFIG_DIR mirror)", () => {
    const env = getClaudeCodeEnvVars("http://127.0.0.1:18787")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18787")
    // Post-fix: ANTHROPIC_AUTH_TOKEN no longer set. The synthetic
    // claudeAiOauth.accessToken from <CLAUDE_CONFIG_DIR>/.credentials.json
    // is sent as Bearer instead. Dropping the env-source eliminates the
    // env-vs-file auth-conflict warning and is a no-op for spawned
    // teammates (they would have dropped it anyway via the allowlist).
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    // Crucially does NOT set ANTHROPIC_API_KEY (would trigger Auth conflict)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
