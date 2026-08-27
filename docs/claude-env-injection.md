# Experimental Claude Code env-var injection

How `github-router claude` auto-enables five Anthropic-internal feature gates that
default off for non-Anthropic users, plus the gateway-model discovery gate it now
CONDITIONALLY enables (cache-seeded) — and why that gate's network-fetch path
stays closed.
See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Auto-enabled features

`github-router claude` auto-enables five experimental Anthropic env-var feature gates that default off for non-Anthropic users (gated by GrowthBook flags that don't fire outside Anthropic). Same leverage rationale as the beta-header policy: users running `github-router claude` opted into the proxy precisely to get the Claude Code feature surface.

The injection uses a **presence-based guard** in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts`): if the parent env has set ANY value for these keys (including `0`, `false`, `no`, `off`, or any unrecognized value), the proxy preserves the user's intent — it only injects `1` when the key is unset. The parent env survives `buildLaunchCommand`'s sanitize because none of these keys are in `STRIPPED_PARENT_ENV_KEYS`.

Every `github-router claude` launch also presence-guards `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with a catalog-derived **decimal integer**. It derives the complete client window for each reachable `[1m]` active/tier/custom/gateway model — `floor(max_prompt_tokens * 0.85) + min(max_output_tokens, 20_000) + 13_000` — and exports the minimum. This is not fast-only. `/model` does not mutate the process env, but Claude Code resolves the effective value as `Math.min(locallyRecognizedModelWindow, launchValue)`, so one launch-global minimum remains safe after a switch. Native subagents inherit it; 1M roles use the launch value, true 200K roles remain about 200K, and Grok's bare 500K id is conservatively treated as about 200K because Claude Code has no 500K declaration. The value must be a plain integer: that env path is `parseInt`-based, not the suffix-aware `/config` parser, so `"1m"` would parse to `1`, be floored to the client's 100,000 minimum, and compact a 1M session roughly every 52K tokens. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately not set. See the "Context-window safety" section of [`default-models.md`](default-models.md).

This closes the failure observed on 2026-08-26: a top-level (`isSidechain:false`) Luna turn reached about 919,814 input tokens, then Copilot rejected the `/responses` request because Luna's 1.05M total window exposes only a 922K prompt ceiling after reserving 128K output. The failing call was not a planner/reviewer/scout/critic or `/responses/compact` request. Current live Opus/Sonnet/Gemini rows expose 1M total / 936K prompt; the defect class is any locally 1M-accounted model whose provider prompt ceiling lies below Claude Code's uncorrected ~967K trigger.

| Env var | Feature |
|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | gpt-5.6-sol/xhigh advisor tool (Phase I server-side wiring; see [`unsupported-features.md`](unsupported-features.md) ADVISOR section) |
| `CLAUDE_CODE_FORK_SUBAGENT` | Forked subagents inherit the full conversation context (vs starting fresh). **Headless mode (`claude --print`) silently no-ops the fork** (`Z8()` precondition in the binary) — don't expect forked context in `-p` runs |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `TeamCreate` + inter-teammate `SendMessage` primitives. **Requires the CLAUDE_CONFIG_DIR snapshot mirror** — see [`auth-isolation.md`](auth-isolation.md). The teammate-spawn allowlist drops `ANTHROPIC_AUTH_TOKEN`, so spawned teammates can only authenticate by reading a credential from disk in a CONFIG_DIR they inherit. |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Tool inputs stream as the model generates them. Anthropic explicitly recommends this for proxy users at [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars): "Set to `1` to force on when routing through a proxy via `ANTHROPIC_BASE_URL`" |
| `CLAUDE_CODE_ENABLE_TASKS` | Task tracking in `claude -p` headless mode (already on in interactive) |

**Opt out per-feature** by setting the env to `0` / `false` / `no` / `off` / empty string in your shell — the presence-based guard preserves any value you set. ADVISOR has a documented hard opt-out (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`) that wins via `JI()` ordering.

## Adjacent proxy-side awareness injection

Independent of the Claude Code feature gates above, the proxy appends a short `--append-system-prompt` snippet introducing the model to the capabilities that actually resolved for this launch. `GH_ROUTER_PEER_AWARENESS` is intentionally no longer a behavioral opt-out: keeping the prompt and emitted tool/agent surface in sync is required for deterministic routing, so old values are accepted as a silent no-op for compatibility. The launch-specific builder omits every unavailable/droppable role rather than naming tools that do not exist.

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
`<CLAUDE_CONFIG_DIR>/cache/gateway-models.json` with the current fast-profile
non-Claude rows present in the live catalog (`gpt-5.6-sol`, `gpt-5.6-luna`,
`gemini-3.7-flash`, `grok-4.6`) via `seedGatewayModelCache`, then enables
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

**Fast profile.** The seeded gateway rows are now exactly `gpt-5.6-sol`,
`gpt-5.6-luna`, `gemini-3.7-flash`, and `grok-4.6`, gated on the live catalog.
The cache-read-vs-fetch asymmetry, presence guard, and version-coupling caveat are
unchanged. The literal raw `-m fast` profile additionally seeds private Luna
role aliases for fixed effort; those aliases are accepted only on an
authenticated fast request and never reach Copilot. See [`default-models.md`](default-models.md).
