# Experimental Claude Code env-var injection

How `github-router claude` auto-enables five Anthropic-internal feature gates that
default off for non-Anthropic users, plus the gateway-model discovery gate it now
CONDITIONALLY enables (cache-seeded) — and why that gate's network-fetch path
stays closed.
See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Auto-enabled features

`github-router claude` auto-enables five experimental Anthropic env-var feature gates that default off for non-Anthropic users (gated by GrowthBook flags that don't fire outside Anthropic). Same leverage rationale as the beta-header policy: users running `github-router claude` opted into the proxy precisely to get the Claude Code feature surface.

The injection uses a **presence-based guard** in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts`): if the parent env has set ANY value for these keys (including `0`, `false`, `no`, `off`, or any unrecognized value), the proxy preserves the user's intent — it only injects `1` when the key is unset. The parent env survives `buildLaunchCommand`'s sanitize because none of these keys are in `STRIPPED_PARENT_ENV_KEYS`.

| Env var | Feature |
|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | gpt-5.5/xhigh advisor tool (Phase I server-side wiring; see [`unsupported-features.md`](unsupported-features.md) ADVISOR section) |
| `CLAUDE_CODE_FORK_SUBAGENT` | Forked subagents inherit the full conversation context (vs starting fresh). **Headless mode (`claude --print`) silently no-ops the fork** (`Z8()` precondition in the binary) — don't expect forked context in `-p` runs |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `TeamCreate` + inter-teammate `SendMessage` primitives. **Requires the CLAUDE_CONFIG_DIR snapshot mirror** — see [`auth-isolation.md`](auth-isolation.md). The teammate-spawn allowlist drops `ANTHROPIC_AUTH_TOKEN`, so spawned teammates can only authenticate by reading a credential from disk in a CONFIG_DIR they inherit. |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Tool inputs stream as the model generates them. Anthropic explicitly recommends this for proxy users at [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars): "Set to `1` to force on when routing through a proxy via `ANTHROPIC_BASE_URL`" |
| `CLAUDE_CODE_ENABLE_TASKS` | Task tracking in `claude -p` headless mode (already on in interactive) |

**Opt out per-feature** by setting the env to `0` / `false` / `no` / `off` / empty string in your shell — the presence-based guard preserves any value you set. ADVISOR has a documented hard opt-out (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`) that wins via `JI()` ordering.

## Adjacent proxy-side opt-out: `GH_ROUTER_PEER_AWARENESS`

Independent of the Claude Code feature gates above, the proxy appends a short (~100-token) `--append-system-prompt` snippet introducing Claude to the peer-review MCP tools, the `peer-review-coordinator` fan-out subagent, and Claude Code's built-in `advisor` tool. Non-prescriptive — the prescriptive auto-invocation triggers live in each MCP tool's own `description` (see [`peer-mcp-design.md`](peer-mcp-design.md) Phase 2A). Default-on; opt out per-launch with `GH_ROUTER_PEER_AWARENESS=0` (also accepts `false` / `off` / `no` / empty string, case-insensitive — same surface as the CLAUDE_CODE_* opt-outs). Built by `buildPeerAwarenessSnippet` in `src/lib/peer-mcp-personas.ts`; size-pinned by tests in `tests/peer-mcp-personas.test.ts` to stay under 700 bytes minimal / 900 bytes maximal so it doesn't bloat the system prompt.

**Race-surface coverage**: enabling FORK_SUBAGENT and FINE_GRAINED_TOOL_STREAMING by default amplifies the SSE frame distribution through `relayAnthropicStream`. Per the Review checklist in `CLAUDE.md`, `tests/integration/fork-fgts-cancel.test.ts` exercises consumer cancels against fragmented `input_json_delta` streams to assert no smoking-gun warns surface.

## Conditionally auto-enabled: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`

Gateway model discovery would let the `/model` picker auto-populate from a
proxy-served model list, but Claude Code's hardcoded slug registry maps slugs to
**capabilities** (computer tool support, prompt caching, context window sizes,
tool-use dialects), not just display labels. Copilot's slugs (`claude-opus-4.6-1m`,
with dots) don't match Anthropic's registry entries (`claude-opus-4-6`, with
dashes). Discovery has two code paths and only one of them carries that hazard:

- The **network-FETCH path** would discover Copilot's dotted `claude-*` slugs and
  silently degrade advanced tool use to lowest-common-denominator fallback. It is
  **never trusted** — and here it is permanently inert anyway: it bails when
  nonessential traffic is disabled, and the proxy ALWAYS sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (and it never reads the synthetic
  OAuth credential). So the fetch cannot run, cannot discover Copilot's Claude
  slugs, and cannot overwrite anything.
- The **cache-READ path** applies NO id filter (the `/^(claude|anthropic)/i`
  filter lives only on the fetch path). So a pre-seeded cache can carry real
  non-Claude Copilot ids and the picker builder APPENDS them as rows, leaving the
  opus/sonnet/haiku tier rows untouched.

Phase 3 of the Anthropic-translation shim exploits exactly that asymmetry.
`getClaudeCodeEnvVars` (`src/lib/server-setup.ts`) pre-seeds
`<CLAUDE_CONFIG_DIR>/cache/gateway-models.json` with the non-Claude models present
in the live catalog (`gpt-5.5`, `gpt-5.3-codex`, `gemini-3.5-flash`,
`gemini-3.1-pro-preview`) via `seedGatewayModelCache`, then enables
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` — but ONLY when the seed actually
landed AND the key is unset in both the parent env and the injected `vars` (a
user-set value always wins, same presence guard as the five features above). When
no target model is in the catalog, any prior seed is cleared
(`clearGatewayModelCache`) so a user-pinned flag can't surface stale rows.

This is safe precisely because the capability-mapping hazard lived entirely on the
blocked fetch path, and the cache-read path appends real ids without a filter and
without degrading the Claude tiers. It is coupled to Claude Code's cache
path/schema (verified against build 2.1.201); if a future build changes them, the
seed is ignored and the rows simply don't appear (graceful degradation) — the
models still run via explicit selection (`github-router claude -m <id>`), routed
by the `/v1/messages` translation shim. Full mechanism and non-regression argument
in [`anthropic-translation-shim.md`](anthropic-translation-shim.md).
