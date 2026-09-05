# Experimental Claude Code env-var and picker injection

How `github-router claude` auto-enables five Anthropic-internal feature gates that
default off for non-Anthropic users, derives a safe compaction window, and adds
catalog-gated non-Claude `/model` rows through the supported `modelPicker`
settings surface.
See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Auto-enabled features

`github-router claude` auto-enables five experimental Anthropic env-var feature gates that default off for non-Anthropic users (gated by GrowthBook flags that don't fire outside Anthropic). Same leverage rationale as the beta-header policy: users running `github-router claude` opted into the proxy precisely to get the Claude Code feature surface.

The injection uses a **presence-based guard** in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts`): if the parent env has set ANY value for these keys (including `0`, `false`, `no`, `off`, or any unrecognized value), the proxy preserves the user's intent — it only injects `1` when the key is unset. The parent env survives `buildLaunchCommand`'s sanitize because none of these keys are in `STRIPPED_PARENT_ENV_KEYS`.

Every `github-router claude` launch also presence-guards `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with a catalog-derived **decimal integer**. It derives the complete client window for each reachable `[1m]` active/tier/custom/gateway model — `floor(max_prompt_tokens * 0.85) + min(max_output_tokens, 20_000) + 13_000` — and exports the minimum. This is not fast-only. `/model` does not mutate the process env, but Claude Code resolves the effective value as `Math.min(locallyRecognizedModelWindow, launchValue)`, so one launch-global minimum remains safe after a switch. Native subagents inherit it; 1M roles use the launch value, true 200K roles remain about 200K, and Grok's bare 500K id is conservatively treated as about 200K because Claude Code has no 500K declaration. The value must be a plain integer: that env path is `parseInt`-based, not the suffix-aware `/config` parser, so `"1m"` would parse to `1`, be floored to the client's 100,000 minimum, and compact a 1M session roughly every 52K tokens. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately not set. See the "Context-window safety" section of [`default-models.md`](default-models.md).

This closes the failure observed on 2026-08-26: a top-level (`isSidechain:false`) Luna turn reached about 919,814 input tokens, then Copilot rejected the `/responses` request because Luna's 1.05M total window exposes only a 922K prompt ceiling after reserving 128K output. The failing call was not a planner/reviewer/scout/critic or `/responses/compact` request. Current live Opus/Sonnet rows expose 1M total / 936K prompt, while Gemini 3.8 exposes 1,048,576 total / 983,040 prompt. The defect class is any locally 1M-accounted model whose provider prompt ceiling lies below Claude Code's uncorrected ~967K trigger; Gemini 3.8 is above that trigger but still participates in the launch-wide minimum.

| Env var | Feature |
|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | Transcript-aware Advisor (standard selection is unchanged; `-m fast` fixes both the client identity and proxy dispatch to GPT-5.6 Sol 1M/high; see [`unsupported-features.md`](unsupported-features.md) ADVISOR section) |
| `CLAUDE_CODE_FORK_SUBAGENT` | Forked subagents inherit the full conversation context (vs starting fresh). **Headless mode (`claude --print`) silently no-ops the fork** (`Z8()` precondition in the binary) — don't expect forked context in `-p` runs |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `TeamCreate` + inter-teammate `SendMessage` primitives. **Requires the CLAUDE_CONFIG_DIR snapshot mirror** — see [`auth-isolation.md`](auth-isolation.md). The teammate-spawn allowlist drops `ANTHROPIC_AUTH_TOKEN`, so spawned teammates can only authenticate by reading a credential from disk in a CONFIG_DIR they inherit. |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Tool inputs stream as the model generates them. Anthropic explicitly recommends this for proxy users at [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars): "Set to `1` to force on when routing through a proxy via `ANTHROPIC_BASE_URL`" |
| `CLAUDE_CODE_ENABLE_TASKS` | Task tracking in `claude -p` headless mode (already on in interactive) |

**Opt out per-feature** by setting the env to `0` / `false` / `no` / `off` / empty string in your shell — the presence-based guard preserves any value you set. ADVISOR has a documented hard opt-out (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`) that wins via `JI()` ordering.

## Adjacent proxy-side awareness injection

Independent of the Claude Code feature gates above, the proxy appends a short `--append-system-prompt` snippet introducing the model to the capabilities that actually resolved for this launch. `GH_ROUTER_PEER_AWARENESS` is intentionally no longer a behavioral opt-out: keeping the prompt and emitted tool/agent surface in sync is required for deterministic routing, so old values are accepted as a silent no-op for compatibility. The launch-specific builder omits every unavailable/droppable role rather than naming tools that do not exist.

**Race-surface coverage**: enabling FORK_SUBAGENT and FINE_GRAINED_TOOL_STREAMING by default amplifies the SSE frame distribution through `relayAnthropicStream`. Per the Review checklist in `CLAUDE.md`, `tests/integration/fork-fgts-cancel.test.ts` exercises consumer cancels against fragmented `input_json_delta` streams to assert no smoking-gun warns surface.

## Curated `/model` rows through `modelPicker`

Claude Code 2.1.258 changed gateway discovery to run even when
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; 2.1.260 requests
`GET /v1/models?limit=1000`, filters the result to ids matching
`/(claude|anthropic)/i`, and replaces `cache/gateway-models.json` when that
filtered list differs. The former router-written cache seed is therefore not an
authoritative source for Sol, Luna, Gemini, or Grok rows. The router no longer
writes or clears that cache and no longer enables
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.

Instead, `src/lib/model-picker-settings.ts` uses Claude Code's supported
`modelPicker` setting (available since 2.1.243). After
`ensureClaudeConfigMirror()` snapshots the user's configuration and before the
child starts, the launcher atomically adds this object to the mirror's
`settings.json`:

```json
{
  "modelPicker": {
    "options": [
      {
        "model": "gpt-5.6-sol[1m]",
        "label": "GPT-5.6 Sol",
        "behavesAs": "claude-opus-5"
      }
    ],
    "replaceBuiltInOptions": false
  }
}
```

Rows are ordered and gated on the live Copilot catalog. Standard and Fast offer
Sol, Luna, Gemini 3.8 Flash, and Grok 4.6. Max offers Sol, Luna, Gemini 3.8
Flash, and Opus 5, matching its allowed lead set. The model value receives
`[1m]` only when the exact catalog entry advertises at least 1M and the user has
not set `CLAUDE_CODE_DISABLE_1M_CONTEXT`; Grok stays bare.

Claude Code 2.1.260 filters an otherwise-unknown `modelPicker` id from `/model`
unless its row has `behavesAs` pointing at a model this client knows. The router
therefore maps Sol/Luna to `claude-opus-5` and Gemini/Grok to
`claude-sonnet-5`, the closest available client-side prompt/capability/effort
profiles. The setting changes neither the row label nor the model id sent, and
the profile request preprocessors remain authoritative for actual upstream
effort. The `[1m]` marker remains the explicit context-accounting signal; Grok
has no marker and stays conservatively budgeted below its 500K backend.

The write is additive (`replaceBuiltInOptions: false`) and preserves unrelated
settings. If the mirrored user settings already define `modelPicker`, that value
wins wholesale and the router does not merge into or relabel the user's curated
lineup. The launcher still parses valid model ids from that effective picker and
includes every `[1m]` row whose live catalog limits are known in the one
launch-global `CLAUDE_CODE_AUTO_COMPACT_WINDOW` minimum. Invalid settings are
never clobbered. Writes use a same-directory temp file, mode `0o600`, atomic
rename, and bounded retry for transient Windows `EPERM`/`EBUSY`/`EACCES`
contention.

This lifecycle applies to `github-router claude` even with `--no-codex-mcp`, and
to `github-router serve`. Serve is intentionally Standard-profile only: its
`fast` and `max` aliases are rejected rather than launching the corresponding
lead with a mismatched Standard roster/ACL; pass an explicit model id to retain
the Standard serve surface. `start --cc` deliberately remains env-only because
it generates a command without owning an isolated mirror lifecycle; use explicit
`-m <id>` there when selecting a non-built-in row. The raw `/models` and
`/v1/models` APIs remain profile-independent Copilot catalog views.

**Fast profile.** The literal raw `-m fast` profile additionally uses private
Luna aliases where the same catalog model needs different fixed efforts
(lead/general-purpose max versus Explore high); those aliases are accepted only
on an authenticated Fast request and never reach Copilot. Retired role aliases
are rejected. See [`default-models.md`](default-models.md).
