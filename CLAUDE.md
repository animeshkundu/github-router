# github-router

A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.

## Design docs

- [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md) — current architecture and phased migration plan for the peer-model MCP integration (codex_critic gpt-5.5, codex_reviewer gpt-5.3-codex, gemini_critic gemini-3.1-pro). Read this before changing anything in `src/routes/mcp/`, `src/lib/peer-mcp-personas.ts`, or `src/lib/codex-mcp-config.ts`.
- [`docs/research/peer-mcp-investigation.md`](docs/research/peer-mcp-investigation.md) — multi-stage adversarial-review log behind the design: GitHub-issue refs (#50289 etc.), peer-critic verdicts at each iteration, the 7-batch sweep that proved decomposition works, and the concurrency-cap investigation. Read this when you want to know *why* a particular Phase ordering or specific value (cap=8, retention=30min, partial-buffer cap=1MB) was chosen.

## Review checklist (read before submitting / approving any PR)

- **Stream lifecycle**: every `controller.enqueue` / `controller.close` / `reader.read` call site must have a regression test that intentionally races consumer cancel against the call. Cooperative-mock tests are insufficient — they cannot reproduce the microsecond window where Bun's HTTP layer closes the controller while a `pull()` is mid-`await`. See `tests/integration/chaos.test.ts` for the test pattern.
- **The smoking gun**: a new `Could not deliver error event` warn-log is a bug, not a routine warning. Open an issue and treat as a regression.
- **Author responsibility**: PR descriptions must list the failure modes the author considered and tested, not just the happy path. Reviewers can only check what they're asked about — narrow prompts produce narrow reviews. The class of bug we missed in the manual `ReadableStream({pull})` rollout was an enqueue-after-cancel race that the catch block was clearly intended to handle, but no test ever reproduced it. The catch-handler's existence is not a substitute for an actual race-triggering test.
- **Spec ≠ runtime**: WHATWG/Anthropic spec compliance is necessary but not sufficient. Verify what Bun (and Node undici when relevant) actually throw at runtime. Don't reason "the spec says close is idempotent" — verify "Bun throws `TypeError: Invalid state: Controller is already closed` if you enqueue after close."
- **Bun request-signal quirk**: `c.req.raw.signal` from a Bun/srvx HTTP handler is aborted as soon as the request body is fully consumed (i.e., right after `await c.req.json()`), even when the consumer is still happily reading the response. Do NOT propagate it into upstream `fetch()` calls — every such call would fail immediately with "This operation was aborted." `/v1/responses` and `/mcp` both intentionally drop it; tear-down on consumer cancel is handled at the `ReadableStream.cancel()` callback for streaming responses, and is a no-op for non-streaming responses (the upstream call completes regardless). If a future change truly needs to propagate consumer cancel, verify with a real Bun.serve listener — unit tests with `app.request(new Request(...))` do not reproduce the quirk.
- **Compatibility probe rule**: every field, header, body shape, or tool type that any client (Claude Code, Codex, raw API users) emits MUST have a probe row in `scripts/probe-copilot-compat.sh` AND a row in `docs/copilot-compat-matrix.md` — with an explicit accept-or-reject expectation. Discovery sources: real traffic (`bun run discover:fields` after launching with `GH_ROUTER_LOG_FIELDS=1`), code changes that emit new shapes, exploratory probing. The probe set grows monotonically; removing a row requires written justification in the matrix doc. Run `bun run probe:copilot` (strict mode) before merging changes that touch request shaping. Symmetric: both `❌ 400` and `✅ 200` rows are asserted, so drift in either direction surfaces immediately rather than after users hit it.
- **Strip-rule probe rule**: adding (or removing) a strip rule in `stripAnthropicOnlyFields` / `sanitizeCacheControl` / equivalent requires (a) an end-to-end probe in `scripts/probe-copilot-compat.sh` asserting the user-facing behavior the strip enables (typically a `200` where without the strip Copilot would 400), AND (b) a row in `docs/copilot-compat-matrix.md` documenting the upstream truth. The probe id should be referenced in the strip's code comment so a future contributor following a breadcrumb lands on the empirical evidence.

## Commands

```bash
bun run build        # Build for distribution (tsdown → dist/)
bun run dev          # Dev server with hot reload
bun run lint:all     # Lint entire project
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
bun run start        # Production server (port 8787)
```

## Publishing

The canonical npm package is the **unscoped** `github-router` (NOT `@animeshkundu/github-router`).
Users install via `npm install -g github-router`. The scoped name in package.json is for
GitHub Packages compatibility only.

**CI publishing** (preferred): Every push to `master` triggers the Release workflow
(`.github/workflows/release.yml`), which auto-bumps the version, publishes to npmjs.org
via OIDC trusted publishing (no token needed), creates a GitHub release, and builds Docker
images. Uses Node 24 (npm 11.11.0) for OIDC support.

**Manual publishing** (fallback):
```bash
export NPM_TOKEN=npm_...
./publish/release.sh          # auto-bump patch
./publish/release.sh 0.4.0    # explicit version
```

The release script builds, tests, temporarily rewrites package.json to the unscoped name,
publishes, and restores. See `publish/release.sh` for details.

## Upgrading a running proxy

A running proxy (`npx github-router@latest claude` from earlier) is **pinned to its
installed version** and will NOT auto-update when a new release is published. To pick up
a new release:

```bash
# 1. Confirm the new version is live on npm
npm view github-router version

# 2. Identify the running proxy(ies). Each `claude` session spawns one.
ps aux | grep -E 'github-router|bun.*dist/main' | grep -v grep

# 3. WAIT for any in-flight Claude Code request to settle, then kill the
#    proxy. Killing mid-stream loses the current request only — the Claude
#    Code session itself reconnects on the next prompt, but the in-flight
#    response is lost.
kill <PID>

# 4. Force re-fetch (npm 11 prefers-online by default; this is belt-and-suspenders
#    for stale npx caches):
rm -rf ~/.npm/_npx/*github-router*

# 5. Restart
npx github-router@latest claude

# 6. Verify the new build is serving by hitting the /version endpoint with
#    the proxy's actual port (visible in `ps` output as `--port` or implied
#    from the random port the proxy chose):
curl http://localhost:<PORT>/version
# → {"name":"github-router","version":"0.3.X","gitSha":"..."}
```

Tunable env vars (set before launching `claude`):

- `UPSTREAM_FETCH_TIMEOUT_MS` — overall fetch-phase timeout in ms. Default `0` = no
  timeout. Set a positive integer if you need a hard ceiling on Copilot fetches.
- `UPSTREAM_INACTIVITY_TIMEOUT_MS` — body-phase inactivity timeout in ms. Default `300000`
  (5 min — sits well above Copilot's ~60s idle cut and accommodates reasoning models'
  long thinking-pauses between token bursts; the previous 75s default aborted live
  `/v1/messages` requests at bytes=134k–163k mid-stream when gpt-5.5/opus-4.7-xhigh
  went quiet to think). Lower this only if you specifically want to reap stalled
  connections faster than 5 minutes.

## Architecture

- **Stack**: TypeScript / Bun / Hono / SSE streaming
- **Import alias**: `~/` maps to `src/`
- **Token storage**: `~/.local/share/github-router/github_token`

### Two patterns

1. **Passthrough**: Forward directly to Copilot API:
   - `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`
   - Service: `src/services/copilot/create-*.ts` → handler → route

2. **Passthrough with sanitization**: Forward to Copilot, stripping unsupported fields:
   - `/v1/messages` (Anthropic) → strip `cache_control.scope`, filter beta headers → Copilot `/v1/messages?beta=true`
   - `/v1/messages/count_tokens` → same sanitization → Copilot `/v1/messages/count_tokens?beta=true`

### Beta header filtering

The `--extended-betas` shared flag controls VS Code stealth vs Claude CLI leverage. The **`claude` subcommand defaults to leverage mode** (extended-betas ON; see "Stealth vs leverage policy" below) — opt back into stealth via `claude --stealth`. The `start` and `codex` subcommands default to stealth.

- **Default for `start`/`codex` (VS Code stealth)**: Only forward 3 beta prefixes the VS Code extension sends (`interleaved-thinking-`, `context-management-`, `advanced-tool-use-`). Wire fingerprint matches VS Code Copilot Chat.
- **Extended/leverage (`--extended-betas`, default for `claude`)**: Forward 20 beta prefixes covering the full Claude CLI feature surface (`claude-code-`, `effort-`, `prompt-caching-`, `computer-use-`, `pdfs-`, `max-tokens-`, `token-counting-`, `compact-`, `structured-outputs-`, `fast-mode-`, `mcp-client-`, `mcp-servers-`, `redact-thinking-`, `web-search-`, `task-budgets-`, `token-efficient-tools-`, plus 4 Anthropic-internal flags). Empirically validated against `api.enterprise.githubcopilot.com` 2026-05-11 — every prefix returns 200 from Copilot.

The router strips `context-1m-`, `skills-`, `files-api-`, `code-execution-`, `output-128k-`, and **`advisor-tool-`** from every outgoing `anthropic-beta` value — Copilot returns 400 ("unsupported beta header") on each. The strip list lives in `EXPLICITLY_STRIPPED_BETA_PREFIXES` (`src/lib/utils.ts`) — defensive deny-list that catches even future allowlist broadenings. 1M context for Opus 4.7 is unlocked by selecting the `claude-opus-4.7-1m-internal` model id (enterprise tier only), not via a beta header.

The router also strips body-level `budget`, `output_config.schema`, and `betas` array from `/v1/messages` and `/v1/messages/count_tokens` (Phase B; Copilot 400s on each — verified live). The corresponding `anthropic-beta` headers (`task-budgets-`, `structured-outputs-`) are preserved so the *intent* still flows; only the per-request enforcement field is dropped.

The router strips per-tool `eager_input_streaming` from `tools[i]` (Fine-Grained Tool Streaming). Auto-emitted by Claude Code under `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` (proxy-default in `getClaudeCodeEnvVars`); Copilot 400s on `tools.0.custom.eager_input_streaming`. Strip disables only the chunk-size optimization — `input_json_delta` events still flow normally with `partial_json:""` instead of populated chunks. End-to-end coverage in probes `eager_input_streaming_stripped` / `eager_input_streaming_with_type_custom_stripped` (`scripts/probe-copilot-compat.sh`).

### Stealth vs leverage policy

`github-router claude` defaults to **leverage** (extended-betas ON, all stripped/preserved fields per the "Beta header filtering" section). Rationale: the spawned Claude Code already identifies itself via UA, editor-version, and Claude-specific request headers — partial stealth doesn't meaningfully reduce the wire-fingerprint diff, and stealth's cost is losing the features the user explicitly chose to install Claude Code for (cost-budget enforcement, prompt caching, MCP, structured outputs, etc.).

Opt-out: `claude --stealth` reverts to the 3-prefix VS Code-only filter for users who specifically prioritize wire similarity over feature surface.

The `start` and `codex` subcommands continue to default to VS Code stealth — they're for raw API users / Codex users who don't need the Claude CLI feature set.

### Experimental Claude Code features auto-enabled

`github-router claude` auto-enables five experimental Anthropic env-var feature gates that default off for non-Anthropic users (gated by GrowthBook flags that don't fire outside Anthropic). Same leverage rationale as the beta-header policy above: users running `github-router claude` opted into the proxy precisely to get the Claude Code feature surface.

The injection uses a **presence-based guard** in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts`): if the parent env has set ANY value for these keys (including `0`, `false`, `no`, `off`, or any unrecognized value), the proxy preserves the user's intent — it only injects `1` when the key is unset. The parent env survives `buildLaunchCommand`'s sanitize because none of these keys are in `STRIPPED_PARENT_ENV_KEYS`.

| Env var | Feature |
|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | gpt-5.5/xhigh advisor tool (Phase I server-side wiring; see ADVISOR bullet above) |
| `CLAUDE_CODE_FORK_SUBAGENT` | Forked subagents inherit the full conversation context (vs starting fresh). Headless mode (`claude --print`) silently no-ops the fork (`Z8()` precondition in the binary) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `TeamCreate` + inter-teammate `SendMessage` primitives. **Requires the CLAUDE_CONFIG_DIR snapshot mirror** — see "Spawned-CLI auth isolation" below. The teammate-spawn allowlist drops `ANTHROPIC_AUTH_TOKEN`, so spawned teammates can only authenticate by reading a credential from disk in a CONFIG_DIR they inherit. |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Tool inputs stream as the model generates them. Anthropic explicitly recommends this for proxy users at [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars): "Set to `1` to force on when routing through a proxy via `ANTHROPIC_BASE_URL`" |
| `CLAUDE_CODE_ENABLE_TASKS` | Task tracking in `claude -p` headless mode (already on in interactive) |

**Opt out per-feature** by setting the env to `0` / `false` / `no` / `off` / empty string in your shell — the presence-based guard preserves any value you set. ADVISOR has a documented hard opt-out (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`) that wins via `JI()` ordering.

**Not auto-enabled (deferred — capability-mapping concern)**: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` would let the `/model` picker auto-populate from the proxy's `/v1/models` endpoint, but Claude Code's hardcoded slug registry maps slugs to **capabilities** (computer tool support, prompt caching, context window sizes, tool-use dialects), not just display labels. Copilot's slugs (`claude-opus-4.6-1m`, with dots) don't match Anthropic's registry entries (`claude-opus-4-6`, with dashes), so dynamic discovery would silently degrade to lowest-common-denominator fallback — quietly breaking advanced tool use. Enable it intentionally only after the proxy's `/v1/models` response is normalized to Anthropic-registry slugs.

**Race-surface coverage**: enabling FORK_SUBAGENT and FINE_GRAINED_TOOL_STREAMING by default amplifies the SSE frame distribution through `relayAnthropicStream`. Per the "Review checklist" below, `tests/integration/fork-fgts-cancel.test.ts` exercises consumer cancels against fragmented `input_json_delta` streams to assert no smoking-gun warns surface.

### Unsupported features (Copilot can't serve)

Some Anthropic API surfaces have no Copilot equivalent. The proxy returns explicit Anthropic-format errors so users see the limitation surfaced clearly:

- **Files API** (`/v1/files/*`): Copilot has no equivalent storage backend (verified via `cc-backup/src/services/api/filesApi.ts`). The proxy returns 404 with a descriptive error pointing users at the real Anthropic API for file uploads/downloads.
- **ADVISOR** (`advisor-tool-2026-03-01`): Copilot returns 400 "unsupported beta header" on this prefix. **Phase I (shipped, auto-enabled for `github-router claude`)**: the proxy injects a `__anthropic_advisor` tool into the body, intercepts the model's `tool_use` blocks for that tool name, runs an advisor model server-side (default **`gpt-5.5` at `xhigh` reasoning effort** via `/v1/responses` for cross-lab "second set of eyes"), and emits translated `server_tool_use{name:"advisor"}` + `advisor_tool_result` blocks back to the client on the same SSE connection. Per gemini-critic streaming-during-loop design — keeps Claude Code's `AdvisorMessage.tsx` UI responsive (no buffered hang), continues the conversation through up to 16 advisor turns. The `claude` subcommand sets `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` automatically (without it, Claude Code's `JI()` gate falls back to the `tengu_sage_compass2` GrowthBook flag, which is off for non-Anthropic users). Three opt-out paths, all honored: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` (documented Anthropic opt-out, checked first in `JI()`), `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=0` (proxy uses presence-based guard — any user-set value preserved), or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (global beta opt-out — proxy intentionally doesn't strip this from your shell). The advisor model is dispatched to `/v1/responses` with `reasoning.effort` for gpt-5.x / o-series / codex models, falls back to `/v1/messages` for claude-* models. If a future Claude Code version stops emitting `advisor-tool-` despite our inject, check whether Anthropic rotated the env name. See `src/services/advisor/advisor.ts`.
- **`mcp_servers` body field** (inline remote-managed MCP): Copilot 400s on this field. Phase G's planned proxy-side translate-path was deferred (codex-critic: structural design holes — continuation-after-pool-TTL not implementable from request alone, streaming buffer-and-resume creates incoherent SSE if any assistant deltas already forwarded, tool-name namespace `server:tool` regex unverified against Copilot). The proxy now **fail-fast 400**s requests with non-empty `mcp_servers` and points users at local stdio MCP via `~/.claude/mcp.json` (which works without the translate path). Empty `mcp_servers: []` arrays pass through (Copilot 400s but not the proxy's concern).
- **Bridge / CCR (Remote Sessions)**: requires `CLAUDE_CODE_REMOTE`/`CLAUDE_BRIDGE_*` env vars. Stripped from the spawned-child env (`STRIPPED_PARENT_ENV_KEYS`) so the remote-session code path never activates. Local sessions only.
- **Files API OAuth, account/settings, team-memory sync, user-settings sync, etc.**: gated by `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + `DISABLE_TELEMETRY=1` (all set by `getClaudeCodeEnvVars`). Suppressed at the source.

### `apiKeyHelper` and external credential scripts

Claude Code's settings.json supports `apiKeyHelper`, `awsCredentialExport`, `awsAuthRefresh`, `gcpAuthRefresh` — external scripts that mint credentials. The user's `settings.json` is mirror-copied into our `CLAUDE_CONFIG_DIR` at startup (see "Spawned-CLI auth isolation" below), so any helper they defined still fires inside the proxy session. The proxy supplies auth via the synthetic `claudeAiOauth` blob in `<CLAUDE_CONFIG_DIR>/.credentials.json` (Bearer header sourced from its `accessToken`); if a user's `apiKeyHelper` mints an additional `x-api-key` header, that header is sent alongside our Bearer — Copilot ignores `x-api-key`, so requests still work. The legacy "Auth conflict" warning is silenced because the spawned child has only one env-source-of-auth (none — we removed `ANTHROPIC_AUTH_TOKEN=dummy`) and the keychain probe misses by hashed service name. External-script credentials beyond apiKeyHelper are out of the proxy's scope.

### Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:

- `claude` → `ANTHROPIC_MODEL=claude-opus-4-7` (Anthropic-published dashed slug). The proxy's `resolveModel` (`src/lib/utils.ts`) translates this to Copilot's `claude-opus-4.7-1m-internal` on enterprise tokens or `claude-opus-4.7` on Pro+/Business/Max at request time, so the actual upstream call routes correctly. The `DEFAULT_CLAUDE_MODEL_FALLBACKS` chain (`claude-opus-4-6` → `claude-opus-4-5`) covers major.minor regressions only — the 1M↔200K downgrade is handled inside the resolver.

  Why the Anthropic slug instead of the Copilot slug: Claude Code 2.1.126's `/model` UI is backed by a hardcoded registry of Anthropic-published slugs. Setting `ANTHROPIC_MODEL=claude-opus-4.7-1m-internal` (Copilot's slug, with dots and `-internal` suffix) doesn't match any registry entry, so the menu falls back to "Opus 4" with a "Newer version available" hint instead of selecting "Opus 4.7 (1M context)". The Anthropic dashed slug fixes the UI without sacrificing routing — round-trip covered by `tests/lib-utils.test.ts:154`.

  Users can pass `--model claude-opus-4.7-1m-internal` (Copilot slug) for explicit pinning, but Claude Code's UI won't recognize it and will display "Opus 4" instead of "Opus 4.7 (1M context)". Use the Anthropic slug for correct UI labels.

- `codex` → `gpt-5.5` (dropped the `-codex` suffix; `/responses` is the discriminator). Falls back via `DEFAULT_CODEX_MODEL_FALLBACKS`: `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`. `resolveCodexModel`'s "best available `/responses` model" provides a final safety net beyond the named chain. Codex CLI's bundled catalog uses Copilot-style slugs directly, so no Anthropic-slug translation is needed.

`getClaudeCodeEnvVars` also defaults `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5` (Anthropic-published dashed slug; Claude Code uses this tier for status text, auto-compact summaries, session titles, and other background ops). Presence-based guard preserves any user-set value — symmetric with `STRIPPED_PARENT_ENV_KEYS`'s intentional pass-through of `ANTHROPIC_SMALL_FAST_MODEL` for users with custom Copilot mappings.

Fallback chains only fire on the implicit-default path — explicit `-m`/`--model` is always respected as-is. Constants live in `src/lib/port.ts`.

### Peer-model MCP integration (auto-invocation, effort, decomposition)

The `claude` subcommand auto-injects three peer-model review tools as Claude Code subagents (`codex-critic` gpt-5.5, `codex-reviewer` gpt-5.3-codex, `gemini-critic` gemini-3.1-pro-preview) plus a `peer-review-coordinator` meta-subagent that fans out to them in parallel. Full architecture in [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md); rationale + multi-stage adversarial review log in [`docs/research/peer-mcp-investigation.md`](docs/research/peer-mcp-investigation.md).

**Auto-invocation triggers** (Phase 2A): each persona's MCP-tool description includes prescriptive **CALL BEFORE / CALL AFTER** wording so Opus naturally delegates at the right checkpoints (before `ExitPlanMode` for non-trivial plans, after commits touching concurrency/security/streaming, before `TeamCreate` for non-trivial team tasks). The `peer-review-coordinator` subagent's description uses the documented Claude Code "use proactively" idiom — Opus delegates to it without an explicit user request at the matching checkpoints. Empirical reliability is ~60% per claude-code-guide (the plan calls for an acceptance test ≥7/10; if <7/10 we flip an opt-in `PreToolUse(ExitPlanMode)` hook to default-on, env-disable-able via `GH_ROUTER_AUTO_PEER_REVIEW=0`).

**Phase 2.5 — agent registration surface** (critical for Track 2A actually working): Claude Code v2.1.138's `--agents <json>` flag does NOT populate the Task `subagent_type` enum (per claude-code-guide expert verification — confirmed by the documented separation in code.claude.com/docs/en/cli-reference.md). Subagents passed via `--agents` are only reachable via natural-language delegation; explicit `Task(subagent_type=...)` calls fail with "Agent type 'X' not found". The fix is to write per-launch markdown subagent files into `~/.claude/agents/peer-<pid>-<rand>-<name>.md` — that's the canonical surface Claude Code reads at session start. The spawned `claude` is no longer launched with `--agents`; the `.md` files are. A boot-time sweep (`sweepStalePeerAgentMdFiles` in `src/lib/paths.ts`) drops stale files matching `peer-<deadpid>-*-*.md` from `~/.claude/agents/`; the regex's required digit-PID prefix protects user-authored files (e.g. `peer-reviewer.md` is preserved because there's no PID segment).

**Decomposition guidance** (Phase 2B): each persona description tells Opus "if the artifact is large (>20 KB), split into 2-4 focused batches and call in parallel" — necessary because Claude Code v2.1.113+ regression [#50289](https://github.com/anthropics/claude-code/issues/50289) caps HTTP MCP per-tool-call wait at the bundled MCP-SDK default (~30 s in `cc-backup/src/services/mcp/client.ts:457`; field reports of "5 min" / "60 s" elsewhere are a different SDK constant or older binary). The `MCP_TIMEOUT=600000` env var injected by `getClaudeCodeEnvVars` is "belt-and-suspenders" — it works on versions where the regression is fixed and is silently ignored on regressed versions. Decomposition is the load-bearing fix; the env injection is harmless insurance. The 7-batch sweep documented in `docs/research/peer-mcp-investigation.md` proved decomposition completes every per-batch call in <3 min.

**Reasoning effort** (Phase 2C): each persona MCP tool accepts an `effort?: "low"|"medium"|"high"|"xhigh"` argument, default **`high`** (cost-conscious; raise to `xhigh` for explicit deep dives, drop to `medium` for quick sanity checks). For `/v1/responses` personas (codex-critic, codex-reviewer) the effort is set as `payload.reasoning.effort`. For `/v1/chat/completions` (gemini-critic) it's set as `payload.reasoning_effort` and may be silently ignored by Copilot's gemini route — gemini-3.x reasoning is largely auto-applied. Invalid effort values are rejected with JSON-RPC `-32602`.

**Concurrency cap** (Phase 2D): `MAX_INFLIGHT_TOOLS_CALL = 8` in `src/routes/mcp/handler.ts` (raised from the original defensive 2). 9th in-flight `tools/call` returns clean isError `"queue full"`. Cap exists to bound runaway clients; persona handlers are stateless. Decomposition fan-out of 4-7 parallel batches now fits comfortably under the cap.

### Spawned-CLI auth isolation

When `github-router claude` (or `codex`) launches its child CLI, the parent `process.env` is sanitized of every auth-related key listed in `STRIPPED_PARENT_ENV_KEYS` (`src/lib/launch.ts`) BEFORE the proxy's overrides are merged in. Stripped keys: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CONFIG_DIR`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME`.

This serves two purposes: (1) prevents shell-exported real credentials from leaking through the proxy, and (2) avoids Claude Code's `Auth conflict` warnings that fire whenever multiple auth sources are present (regardless of value — even dummy values trip the check).

#### CLAUDE_CONFIG_DIR snapshot mirror — gives spawned teammates a credential they can find on disk

`getClaudeCodeEnvVars` sets `CLAUDE_CONFIG_DIR=PATHS.CLAUDE_CONFIG_DIR` (a router-owned dir at `~/.local/share/github-router/claude-config/`). At the start of every `github-router claude` session, `ensureClaudeConfigMirror` (`src/lib/paths.ts`) classifies each top-level entry under `~/.claude/` per `CLAUDE_HOME_POLICY` (three buckets) and acts accordingly:

1. **ISOLATED** (skipped from the mirror entirely): `.credentials.json` (we write a synthetic one), `.credentials.json.lock`, `.oauth_refresh.lock`, `.github-router-managed`, `statsig/` (write-heavy contention), `cache/`, `logs/`, `paste-cache/` (sensitive clipboard data). Lock files would otherwise couple refresh loops across proxy/plain-`claude` sessions.
2. **SHARED** (directory symlink `<mirror>/X → ~/.claude/X`, created via atomic temp+rename so two concurrent proxy startups can't race to EEXIST): `projects/`, `sessions/`, `tasks/`, `todos/`, `transcripts/`, `shell-snapshots/`, `shell_snapshots/`, `plans/`, `file-history/`, `backups/`. This is the load-bearing fix for chat-history continuity — Claude Code's per-session JSONL files in `projects/<cwd-hash>/<session-uuid>.jsonl` now flow between proxy and plain-`claude` sessions, and a proxy session shows up in plain `claude`'s `/resume` list. **Directories only.** Never symlink individual files: Node's `fs.rename()` does NOT follow symlinks, so Claude Code's atomic-write pattern (`writeFile(temp); rename(temp, target)`) would silently sever a file symlink — gemini-critic finding in the 3-lab review.
3. **MIRRORED** (snapshot copy with mtime skip — current behavior): everything else, including `settings.json`, `agents/`, `plugins/`, `policy-limits.json`, `downloads/`, `telemetry/`, `.last-cleanup`, `.claude.json`, `history.jsonl`, `teams/`, `session-env/`. The default for any unlisted name is MIRRORED so a future Claude-Code-side addition flows through as a snapshot copy rather than being silently lost. `agents/` MUST stay MIRRORED — the proxy itself writes per-launch `peer-<pid>-<rand>-<name>.md` files into it and `sweepStalePeerAgentMdFiles` deletes them; a symlink would route those writes/deletes into the user's real `~/.claude/agents/` and destroy their custom subagent files. A `policyFor("agents") === "MIRRORED"` regression test in `tests/lib-paths.test.ts` hard-pins this.

Then `ensureClaudeConfigMirror`:

4. **Writes a synthetic `claudeAiOauth` credential** (schema verbatim from v2.1.140 binary function `guH`): `accessToken`, `refreshToken` (synthetic strings), `expiresAt: 4070908800000` (2099-01-01 ms — sidesteps Claude Code's proactive refresh path `nH8`/`R8H`), `scopes: ["user:inference", "user:profile"]` (passes `tB()` so `Hq()` is true → full feature surface), `subscriptionType: "max"` (highest client-side gating; pure label, no server validation). Atomic temp+rename write so Claude Code's `EZ1()` mtime watcher never sees a partial write.

**Why this fixes agent teams**: Claude Code v2.1.140's teammate-spawn code rebuilds the child process env from a fixed allowlist (visible in the spawned tmux pane's command line: `CLAUDECODE`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`) — and **drops `ANTHROPIC_AUTH_TOKEN`**. Pre-fix the proxy set `ANTHROPIC_AUTH_TOKEN=dummy`; teammates dropped it and landed at "Not logged in · Run /login", silently consuming mailbox messages without producing turns. Post-fix the proxy sets nothing on the env; auth flows from the synthetic creds file in `CLAUDE_CONFIG_DIR/.credentials.json`. `CLAUDE_CONFIG_DIR` IS in the teammate-spawn allowlist, so teammates inherit the path, find the credential, and authenticate.

**Keychain isolation still active**: per binary-grep of v2.1.126's `iN()`, when `CLAUDE_CONFIG_DIR` is set the keychain service name becomes `Claude Code-<sha256(path)[0..8]>` instead of `Claude Code` (no suffix). The user's persisted `claude /login` credential is stored under the no-suffix name and is invisible to the proxy session — even if their normal `claude` would find it. The mirror dir's hash misses, file fallback hits our synthetic blob.

**No-401 invariant**: Claude Code's reactive refresh path (`SZ1` → `D3(0,true,...)` in v2.1.140) fires on any 401 from upstream and tries to refresh the OAuth token. Refreshing the synthetic token would fail and degrade the session. `forwardError` in `src/lib/error.ts` remaps upstream 401 → 503 (Anthropic `overloaded_error` type) to maintain the invariant on the Anthropic-shape boundary, regardless of whether the upstream Copilot returned 401 with a plain or Anthropic-shaped body.

**Trade-offs**:
- **Stale snapshot for MIRRORED entries**: if the user updates `~/.claude/settings.json` (or any other MIRRORED file: `.claude.json`, `history.jsonl`, `teams/`, `session-env/`, `agents/`, `plugins/`, etc.) via plain `claude` while a github-router session is running, the proxy session won't pick up the change until next restart. Mtime-based re-sync at startup handles between-session updates.
- **Proxy-session writes to MIRRORED entries don't flow back**: when Claude Code writes during a proxied session to a MIRRORED file (e.g., `/config` edits `settings.json`, the session updates `history.jsonl`), those writes land in the mirror dir, NOT the user's real `~/.claude/`. Deliberate: `.claude.json`, `history.jsonl`, `teams/`, `session-env/` are classified MIRRORED on purpose. `history.jsonl` and `.claude.json` *cannot* be SHARED — symlinks on files are severed by atomic-rename (see Approach above). `teams/` and `session-env/` are conservatively MIRRORED until their contents are empirically verified to be safe to share across credential domains.
- **SHARED entries DO flow both ways**: chat-history dirs (`projects/`, `sessions/`, `tasks/`, `todos/`, `plans/`, `file-history/`, `transcripts/`, `shell-snapshots/`, `backups/`) are symlinks, so proxy-session writes land in the user's real `~/.claude/` and a proxy session's `.jsonl` appears in plain `claude`'s `/resume` list. Concurrent `github-router claude` + plain `claude` sessions in the same project are safe — different session UUIDs mean different files, no lock contention.
- **Migration from older github-router**: a user upgrading from a version that mirrored `projects/`, `sessions/`, etc. as snapshot copies will have real (stale) dirs at those mirror slots. `ensureSharedSymlink` refuses to clobber them; instead it logs a warn naming the exact path and instructing the user to move contents into `~/.claude/<name>/` (or delete `<mirror>/<name>/` if empty). After the user follows the warn once, subsequent runs find the symlink already in place and no-op. No auto-deletion of user data.

The persisted Console OAuth credential at `~/.claude/.credentials.json` is **never modified** — it stays exactly where the user's `claude /login` placed it, fully accessible to `claude` invoked outside the proxy. No `claude /logout` is required.

### Thinking-mode translation

Copilot rejects Anthropic's `thinking:{type:"enabled", budget_tokens:N}` shape on adaptive-thinking models with HTTP 400. The router translates to Copilot's `thinking:{type:"adaptive"}` + `output_config:{effort}` automatically when the resolved model declares `adaptive_thinking: true`. Bucket: `<2k → low`, `<8k → medium`, `<24k → high`, else `xhigh`. Clamps to `model.capabilities.supports.reasoning_effort` allowlist when present (lower-tier preference for ties). Client-supplied `output_config.effort` always wins. No-op when the model lacks `adaptive_thinking` (passthrough). Implemented in `src/routes/messages/handler.ts` (`translateThinking`).

### Web search

The `/search` route fulfils web-search tool calls via Copilot's MCP (Model Context Protocol) endpoint at `${copilotBaseUrl}/mcp`, the same path Copilot CLI uses for its `web_search` tool. **Auth is the GitHub PAT directly** (`state.githubToken`), not the Copilot-exchanged token — `/mcp` validates a Copilot seat against the OAuth token rather than the short-lived CAPI bearer.

Wire flow (in `src/services/copilot/web-search.ts`): `initialize` → capture `Mcp-Session-Id` → `notifications/initialized` → `tools/call` `{name:"web_search", arguments:{query}}` over SSE-framed JSON-RPC. The required `X-MCP-Toolsets: web_search` header is what makes the tool appear in `tools/list`; without it the default toolset omits `web_search`. Best-effort `DELETE /mcp` teardown closes the session.

This path is **model-agnostic** — the proxy fulfils the search out-of-band before forwarding the assistant's `tool_use` to the model. Works regardless of whether the user's enterprise has the `github_chat` policy enabled (the legacy `/github/chat/threads` wrapper required it; that entitlement silently flipped from Enabled-default to Disabled-default per the [Nov 4 2025 changelog](https://github.blog/changelog/2025-11-04-github-copilot-policy-update-for-unconfigured-policies/)).

For OpenAI-shaped clients on GPT-5.x clients can also use `tools:[{type:"web_search_preview"}]` on `/v1/responses` directly — Copilot fulfils that natively without going through the proxy's MCP path. For Anthropic-shape `web_search_*` tools on `/v1/messages`, Copilot returns 400 "use of the web search tool is not supported"; the proxy strips them via the existing `injectWebSearchIfNeeded` path and substitutes MCP-fetched search context in the system prompt.

PAT-bearing requests are sent only to hosts in `COPILOT_HOST_ALLOWLIST` (`src/services/github/get-copilot-token.ts`) — `endpoints.api` from the token-exchange response is rejected if it points elsewhere, so a tampered response can't exfiltrate the PAT.

### Error format

Errors use Anthropic SDK format: `{type:"error",error:{type:"<category>",message:"..."}}`.
Upstream Anthropic-format errors from Copilot are forwarded as-is.

### Key directories

```
src/routes/<name>/     # route.ts (Hono router) + handler.ts (business logic)
src/services/copilot/  # API clients for Copilot endpoints
src/services/github/   # GitHub OAuth + token management
src/lib/               # Shared utilities (state, config, rate-limit, etc.)
```

### Model → endpoint mapping

- gpt-5-codex models ONLY work via `/responses` (NOT `/chat/completions`)
- Models report `supported_endpoints` in their metadata

## Testing

- Framework: `bun:test` with `mock()` for fetch, Zod for schema validation
- Tests live in `tests/` directory
- Pattern: mock `globalThis.fetch`, call service, validate calls and response shapes
