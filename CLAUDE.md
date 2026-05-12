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

Two modes controlled by `--extended-betas` flag:
- **Default (VS Code stealth)**: Only forward 3 beta prefixes the VS Code extension sends (`interleaved-thinking-`, `context-management-`, `advanced-tool-use-`). Traffic is indistinguishable from VS Code.
- **Extended (`--extended-betas`)**: Forward 14 additional beta prefixes for Claude CLI compatibility. Required when using `github-router claude --extended-betas`.

The router strips `context-1m-`, `skills-`, `files-api-`, and `code-execution-` from every outgoing `anthropic-beta` value — Copilot returns 400 ("unsupported beta header") on each. 1M context for Opus 4.7 is unlocked by selecting the `claude-opus-4.7-1m-internal` model id (enterprise tier only), not via a beta header.

### Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:

- `claude` → `ANTHROPIC_MODEL=claude-opus-4-7` (Anthropic-published dashed slug). The proxy's `resolveModel` (`src/lib/utils.ts`) translates this to Copilot's `claude-opus-4.7-1m-internal` on enterprise tokens or `claude-opus-4.7` on Pro+/Business/Max at request time, so the actual upstream call routes correctly. The `DEFAULT_CLAUDE_MODEL_FALLBACKS` chain (`claude-opus-4-6` → `claude-opus-4-5`) covers major.minor regressions only — the 1M↔200K downgrade is handled inside the resolver.

  Why the Anthropic slug instead of the Copilot slug: Claude Code 2.1.126's `/model` UI is backed by a hardcoded registry of Anthropic-published slugs. Setting `ANTHROPIC_MODEL=claude-opus-4.7-1m-internal` (Copilot's slug, with dots and `-internal` suffix) doesn't match any registry entry, so the menu falls back to "Opus 4" with a "Newer version available" hint instead of selecting "Opus 4.7 (1M context)". The Anthropic dashed slug fixes the UI without sacrificing routing — round-trip covered by `tests/lib-utils.test.ts:154`.

  Users can pass `--model claude-opus-4.7-1m-internal` (Copilot slug) for explicit pinning, but Claude Code's UI won't recognize it and will display "Opus 4" instead of "Opus 4.7 (1M context)". Use the Anthropic slug for correct UI labels.

- `codex` → `gpt-5.5` (dropped the `-codex` suffix; `/responses` is the discriminator). Falls back via `DEFAULT_CODEX_MODEL_FALLBACKS`: `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`. `resolveCodexModel`'s "best available `/responses` model" provides a final safety net beyond the named chain. Codex CLI's bundled catalog uses Copilot-style slugs directly, so no Anthropic-slug translation is needed.

Fallback chains only fire on the implicit-default path — explicit `-m`/`--model` is always respected as-is. Constants live in `src/lib/port.ts`.

### Peer-model MCP integration (auto-invocation, effort, decomposition)

The `claude` subcommand auto-injects three peer-model review tools as Claude Code subagents (`codex-critic` gpt-5.5, `codex-reviewer` gpt-5.3-codex, `gemini-critic` gemini-3.1-pro-preview) plus a `peer-review-coordinator` meta-subagent that fans out to them in parallel. Full architecture in [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md); rationale + multi-stage adversarial review log in [`docs/research/peer-mcp-investigation.md`](docs/research/peer-mcp-investigation.md).

**Auto-invocation triggers** (Phase 2A): each persona's MCP-tool description includes prescriptive **CALL BEFORE / CALL AFTER** wording so Opus naturally delegates at the right checkpoints (before `ExitPlanMode` for non-trivial plans, after commits touching concurrency/security/streaming, before `TeamCreate` for non-trivial team tasks). The `peer-review-coordinator` subagent's description uses the documented Claude Code "use proactively" idiom — Opus delegates to it without an explicit user request at the matching checkpoints. Empirical reliability is ~60% per claude-code-guide (the plan calls for an acceptance test ≥7/10; if <7/10 we flip an opt-in `PreToolUse(ExitPlanMode)` hook to default-on, env-disable-able via `GH_ROUTER_AUTO_PEER_REVIEW=0`).

**Phase 2.5 — agent registration surface** (critical for Track 2A actually working): Claude Code v2.1.138's `--agents <json>` flag does NOT populate the Task `subagent_type` enum (per claude-code-guide expert verification — confirmed by the documented separation in code.claude.com/docs/en/cli-reference.md). Subagents passed via `--agents` are only reachable via natural-language delegation; explicit `Task(subagent_type=...)` calls fail with "Agent type 'X' not found". The fix is to write per-launch markdown subagent files into `~/.claude/agents/peer-<pid>-<rand>-<name>.md` — that's the canonical surface Claude Code reads at session start. The spawned `claude` is no longer launched with `--agents`; the `.md` files are. A boot-time sweep (`sweepStalePeerAgentMdFiles` in `src/lib/paths.ts`) drops stale files matching `peer-<deadpid>-*-*.md` from `~/.claude/agents/`; the regex's required digit-PID prefix protects user-authored files (e.g. `peer-reviewer.md` is preserved because there's no PID segment).

**Decomposition guidance** (Phase 2B): each persona description tells Opus "if the artifact is large (>20 KB), split into 2-4 focused batches and call in parallel" — necessary because Claude Code v2.1.113+ regression [#50289](https://github.com/anthropics/claude-code/issues/50289) caps HTTP MCP per-tool-call wait at the bundled MCP-SDK default (~30 s in `cc-backup/src/services/mcp/client.ts:457`; field reports of "5 min" / "60 s" elsewhere are a different SDK constant or older binary). The `MCP_TIMEOUT=600000` env var injected by `getClaudeCodeEnvVars` is "belt-and-suspenders" — it works on versions where the regression is fixed and is silently ignored on regressed versions. Decomposition is the load-bearing fix; the env injection is harmless insurance. The 7-batch sweep documented in `docs/research/peer-mcp-investigation.md` proved decomposition completes every per-batch call in <3 min.

**Reasoning effort** (Phase 2C): each persona MCP tool accepts an `effort?: "low"|"medium"|"high"|"xhigh"` argument, default **`high`** (cost-conscious; raise to `xhigh` for explicit deep dives, drop to `medium` for quick sanity checks). For `/v1/responses` personas (codex-critic, codex-reviewer) the effort is set as `payload.reasoning.effort`. For `/v1/chat/completions` (gemini-critic) it's set as `payload.reasoning_effort` and may be silently ignored by Copilot's gemini route — gemini-3.x reasoning is largely auto-applied. Invalid effort values are rejected with JSON-RPC `-32602`.

**Concurrency cap** (Phase 2D): `MAX_INFLIGHT_TOOLS_CALL = 8` in `src/routes/mcp/handler.ts` (raised from the original defensive 2). 9th in-flight `tools/call` returns clean isError `"queue full"`. Cap exists to bound runaway clients; persona handlers are stateless. Decomposition fan-out of 4-7 parallel batches now fits comfortably under the cap.

### Spawned-CLI auth isolation

When `github-router claude` (or `codex`) launches its child CLI, the parent `process.env` is sanitized of every auth-related key listed in `STRIPPED_PARENT_ENV_KEYS` (`src/lib/launch.ts`) BEFORE the proxy's overrides are merged in. Stripped keys: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CONFIG_DIR`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME`.

This serves two purposes: (1) prevents shell-exported real credentials from leaking through the proxy (e.g. an `ANTHROPIC_API_KEY` in the user's shell would otherwise flow through as `x-api-key`), and (2) avoids Claude Code's `Auth conflict` warnings that fire whenever both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are present (regardless of value — even dummy values trip the check). Because of the strip, `getClaudeCodeEnvVars` only needs to set the positive overrides; it deliberately does NOT set `ANTHROPIC_API_KEY`.

To silence the third auth-conflict warning (the "/login managed key" detection from a persisted `claude /login`), `getClaudeCodeEnvVars` also sets `CLAUDE_CONFIG_DIR=$HOME/.claude`. This activates Claude Code's per-config-dir keychain isolation: the spawned child queries Keychain service `Claude Code-<sha256-hash>` instead of the user's actual `Claude Code` entry (no suffix). The probe misses → the credential is invisible to the proxy session → all three auth-conflict warnings silenced. The path resolves to the default config-dir, so `settings.json`/skills/MCP/plugins/hooks/CLAUDE.md/custom agents all still load from `~/.claude` as normal — **zero feature loss**.

The persisted Console OAuth credential is **never modified** — it stays exactly where the user's `claude /login` placed it (Keychain or `~/.claude/.credentials.json`), fully accessible to `claude` invoked outside the proxy. No `claude /logout` is required.

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
