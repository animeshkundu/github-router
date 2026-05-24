# github-router

A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.

## Primary deployment target

The primary deployment target for this project is **Windows 11**. macOS and Linux are supported and tested, but Windows is the canonical user environment — every PR must pass the `windows-latest` CI job before merge. A Windows CI failure is treated as a merge blocker, not as flake. If Windows behavior diverges from POSIX, the Windows path is the authoritative one to fix; do not POSIX-skip a Windows failure to land a change.

## Design docs

- [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md) — current architecture and phased migration plan for the peer-model MCP integration (codex_critic gpt-5.5, codex_reviewer gpt-5.3-codex, gemini_critic gemini-3.1-pro), plus the deployed-state section covering auto-invocation triggers, allowedEfforts, the latency-by-effort matrix, and the predictedTooLong cap. Read this before changing anything in `src/routes/mcp/`, `src/lib/peer-mcp-personas.ts`, or `src/lib/codex-mcp-config.ts`.
- [`docs/research/peer-mcp-investigation.md`](docs/research/peer-mcp-investigation.md) — multi-stage adversarial-review log behind the design: GitHub-issue refs (#50289 etc.), peer-critic verdicts at each iteration, the 7-batch sweep that proved decomposition works, and the concurrency-cap investigation. Read this when you want to know *why* a particular Phase ordering or specific value (cap=8, retention=30min, partial-buffer cap=1MB) was chosen.
- [`docs/publishing.md`](docs/publishing.md) — npm/Docker release flow (OIDC trusted publishing), upgrade procedure for a running proxy, and the `UPSTREAM_FETCH_TIMEOUT_MS` / `UPSTREAM_INACTIVITY_TIMEOUT_MS` tunables.
- [`docs/beta-headers.md`](docs/beta-headers.md) — `anthropic-beta` allowlist (3 stealth vs 20 leverage prefixes), the `EXPLICITLY_STRIPPED_BETA_PREFIXES` deny-list, body-field strips (`budget`, `output_config.schema`, `betas`, `eager_input_streaming`), and the stealth-vs-leverage policy rationale.
- [`docs/claude-env-injection.md`](docs/claude-env-injection.md) — the five experimental `CLAUDE_CODE_*` env vars `github-router claude` auto-enables (presence-based guard), per-feature opt-out, and why `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is intentionally NOT auto-enabled.
- [`docs/unsupported-features.md`](docs/unsupported-features.md) — Files API 404, ADVISOR Phase I server-side wiring, `mcp_servers` fail-fast 400, Bridge/CCR strip, and other Anthropic surfaces with no Copilot equivalent.
- [`docs/default-models.md`](docs/default-models.md) — `claude` → `claude-opus-4-7` (Anthropic dashed slug, NOT the Copilot dotted slug — `/model` UI registry mismatch), `codex` → `gpt-5.5`, fallback chains, and the `ANTHROPIC_SMALL_FAST_MODEL` default.
- [`docs/auth-isolation.md`](docs/auth-isolation.md) — `STRIPPED_PARENT_ENV_KEYS` parent-env sanitize, `CLAUDE_CONFIG_DIR` snapshot mirror (ISOLATED / SHARED / MIRRORED policy), synthetic `claudeAiOauth` credential schema, keychain isolation, no-401 invariant, agent-teams fix, and trade-offs.
- [`docs/web-search.md`](docs/web-search.md) — Copilot `/mcp` wire flow with `X-MCP-Toolsets: web_search`, GitHub PAT auth, model-agnostic out-of-band fulfilment, and the `COPILOT_HOST_ALLOWLIST` PAT-exfiltration safeguard.
- [`docs/pi-vendor-sync.md`](docs/pi-vendor-sync.md) — vendor-sync protocol for `src/vendor/pi/` (Pi agent runtime backing `worker_explore` / `worker_implement`): how to refresh from upstream, which files MUST stay in sync, which slices were deliberately omitted, and the MIT-attribution invariant.

## Review checklist (read before submitting / approving any PR)

- **Stream lifecycle**: every `controller.enqueue` / `controller.close` / `reader.read` call site must have a regression test that intentionally races consumer cancel against the call. Cooperative-mock tests are insufficient — they cannot reproduce the microsecond window where Bun's HTTP layer closes the controller while a `pull()` is mid-`await`. See `tests/integration/chaos.test.ts` for the test pattern.
- **The smoking gun**: a new `Could not deliver error event` warn-log is a bug, not a routine warning. Open an issue and treat as a regression.
- **Author responsibility**: PR descriptions must list the failure modes the author considered and tested, not just the happy path. Reviewers can only check what they're asked about — narrow prompts produce narrow reviews. The class of bug we missed in the manual `ReadableStream({pull})` rollout was an enqueue-after-cancel race that the catch block was clearly intended to handle, but no test ever reproduced it. The catch-handler's existence is not a substitute for an actual race-triggering test.
- **Spec ≠ runtime**: WHATWG/Anthropic spec compliance is necessary but not sufficient. Verify what Bun (and Node undici when relevant) actually throw at runtime. Don't reason "the spec says close is idempotent" — verify "Bun throws `TypeError: Invalid state: Controller is already closed` if you enqueue after close."
- **Bun request-signal quirk**: `c.req.raw.signal` from a Bun/srvx HTTP handler is aborted as soon as the request body is fully consumed (i.e., right after `await c.req.json()`), even when the consumer is still happily reading the response. Do NOT propagate it into upstream `fetch()` calls — every such call would fail immediately with "This operation was aborted." `/v1/responses` and `/mcp` both intentionally drop it; tear-down on consumer cancel is handled at the `ReadableStream.cancel()` callback for streaming responses, and is a no-op for non-streaming responses (the upstream call completes regardless). If a future change truly needs to propagate consumer cancel, verify with a real Bun.serve listener — unit tests with `app.request(new Request(...))` do not reproduce the quirk.
- **Compatibility probe rule**: every field, header, body shape, or tool type that any client (Claude Code, Codex, raw API users) emits MUST have a probe row in `scripts/probe-copilot-compat.sh` AND a row in `docs/copilot-compat-matrix.md` — with an explicit accept-or-reject expectation. Discovery sources: real traffic (`bun run discover:fields` after launching with `GH_ROUTER_LOG_FIELDS=1`), code changes that emit new shapes, exploratory probing. The probe set grows monotonically; removing a row requires written justification in the matrix doc. Run `bun run probe:copilot` (strict mode) before merging changes that touch request shaping. Symmetric: both `❌ 400` and `✅ 200` rows are asserted, so drift in either direction surfaces immediately rather than after users hit it.
- **Strip-rule probe rule**: adding (or removing) a strip rule in `stripAnthropicOnlyFields` / `sanitizeCacheControl` / equivalent requires (a) an end-to-end probe in `scripts/probe-copilot-compat.sh` asserting the user-facing behavior the strip enables (typically a `200` where without the strip Copilot would 400), AND (b) a row in `docs/copilot-compat-matrix.md` documenting the upstream truth. The probe id should be referenced in the strip's code comment so a future contributor following a breadcrumb lands on the empirical evidence.
- **Windows-first CI**: `windows-latest` CI must be green before merge. Any test that skips on `process.platform === "win32"` requires an explicit written justification (e.g., the symlink-confused-deputy probe at `tests/lib-paths.test.ts:67` is justified because file-typed symlinks legitimately require admin/Developer Mode). Adding new `win32 return` guards to existing tests is a regression of CI coverage on the primary deployment target.
- **Zero-tolerance for flaky / failing CI**: every PR must have a fully green CI run across the entire matrix before merge — no exceptions, no "rerun until green," no "the failing test is unrelated to my change." Flakes and pre-existing failures are merge blockers for whoever is next to land a PR, regardless of who introduced them. If you encounter a flaky test, root-cause it and either fix the underlying race / resource leak / timing bug, OR delete the test with a written justification in the PR description (suppressing via `.skip` or retry-loops is not acceptable — those convert visible bugs into invisible ones). The cost of pausing to fix a flake is bounded; the cost of a green-rate that creeps below 100% compounds into "CI doesn't mean anything" and bugs ship.
- **MCP tool surface minimality**: every input/output field of every MCP tool (the personas under `PERSONAS_READ`/`PERSONAS_WRITE` and the utility tools under `NON_PERSONA_MCP_TOOLS` in `src/lib/peer-mcp-personas.ts`) must be required to call the tool, model-tunable in a way that improves outcomes, OR directly actionable feedback the model can act on next call. Echoed inputs, diagnostic-only fields, and non-actionable failure metadata cost the model's context for no return. When adding or extending a tool, write "what would the model do with this?" for each proposed field; if the answer is "nothing," cut it. See [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md) "Design principle: ruthlessly minimal MCP tool surface" for the worked example and the per-field rationale.

## Commands

```bash
bun run build        # Build for distribution (tsdown → dist/)
bun run dev          # Dev server with hot reload
bun run lint:all     # Lint entire project
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
bun run start        # Production server (port 8787)
```

## Publishing & runtime ops

See [`docs/publishing.md`](docs/publishing.md) for npm/Docker release flow, the upgrade procedure for a running proxy, and the `UPSTREAM_FETCH_TIMEOUT_MS` / `UPSTREAM_INACTIVITY_TIMEOUT_MS` tunables (default 5 min — do NOT lower without re-reading the 134-163k mid-stream abort history).

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

### Beta header filtering & stealth-vs-leverage

`github-router claude` defaults to **leverage** (extended-betas ON; 20 prefixes forwarded, `EXPLICITLY_STRIPPED_BETA_PREFIXES` deny-list catches anything Copilot 400s on); `start`/`codex` default to **VS Code stealth** (3 prefixes only). Body-level `budget`, `output_config.schema`, `betas`, and per-tool `eager_input_streaming` are stripped on `/v1/messages` and `/v1/messages/count_tokens`. Full allowlist + strip-list + opt-out flags in [`docs/beta-headers.md`](docs/beta-headers.md).

### Experimental Claude Code features auto-enabled

`github-router claude` auto-enables five `CLAUDE_CODE_*` env-var feature gates via a presence-based guard (any user-set value is preserved — set to `0`/`false`/`off` to opt out per-feature): `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`, `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`, `CLAUDE_CODE_ENABLE_TASKS`. **Note**: FORK_SUBAGENT silently no-ops in `claude --print` headless mode (`Z8()` precondition). **Not auto-enabled**: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` (slug-registry mismatch silently degrades to lowest-common-denominator fallback — see [`docs/claude-env-injection.md`](docs/claude-env-injection.md) before changing). Full table + rationale in [`docs/claude-env-injection.md`](docs/claude-env-injection.md).

### Unsupported features (Copilot can't serve)

Files API (`/v1/files/*`) → 404; ADVISOR (`advisor-tool-2026-03-01`) → Phase I server-side wiring (proxy injects `__anthropic_advisor`, dispatches to gpt-5.5 xhigh, streams `advisor_tool_result` back); `mcp_servers` non-empty → fail-fast 400; Bridge / CCR remote-session env stripped from spawned-child env. Full surface + opt-out paths in [`docs/unsupported-features.md`](docs/unsupported-features.md).

### `apiKeyHelper` and external credential scripts

The user's `settings.json` is mirror-copied into `CLAUDE_CONFIG_DIR` at startup so any `apiKeyHelper` / `awsCredentialExport` / `awsAuthRefresh` / `gcpAuthRefresh` defined there still fires inside the proxy session. The proxy supplies auth via the synthetic `claudeAiOauth` blob in `<CLAUDE_CONFIG_DIR>/.credentials.json`; if a user's helper mints an additional `x-api-key` header it's sent alongside our Bearer (Copilot ignores `x-api-key`). See [`docs/auth-isolation.md`](docs/auth-isolation.md).

**MCPs**: user-scope and local-scope MCPs are stored in `~/.claude.json`, which is MIRRORED (snapshot-copied at proxy startup). To register MCPs that persist across `github-router claude` launches, add them via plain `claude mcp add` (or edit `~/.claude.json` directly) *outside* a proxy session — the next launch's snapshot will pick them up. MCPs added inside a proxy session are session-scoped and lost when that session ends; this is by design (the mirror is one-way snapshot, not write-back, to keep the proxy's session state isolated from the user's real config). **Subagent MCP visibility**: `gh-router-peers` (and the `codex-cli` stdio entry when `--codex-cli` is in effect) are merged into the mirrored `.claude.json`'s `mcpServers` so Agent-tool subagents, forks, and agent-teams subprocesses inherit them. Project-scope `<workspace>/.mcp.json` is untouched — spawned `claude` inherits the parent's cwd and reads it directly. Subagent `.md` frontmatter intentionally omits `tools:` (omission inherits the parent's full toolset; adding `tools:` would *restrict*). On collision with a user-side `gh-router-peers` entry, inject is refused and the proxy falls back to ephemeral `--mcp-config` for the parent session only (subagents in that degraded mode do not see the peer tools — visible at startup in the `subagent-INVISIBLE` banner).

### Default models

`claude` → `ANTHROPIC_MODEL=claude-opus-4-7` (Anthropic-published dashed slug — Claude Code 2.1.126's `/model` UI is backed by a registry of Anthropic-published slugs; setting Copilot's dotted `claude-opus-4.7-1m-internal` slug falls back to "Opus 4" with a "Newer version available" hint instead of selecting "Opus 4.7 (1M context)"). On enterprise tiers (catalogue contains `opus-4.7-1m`), `pickClaudeDefault` upgrades the default to `claude-opus-4-7[1m]` — the literal-bracket suffix that cc-backup `src/utils/context.ts:35-40` recognizes to unlock 1M-context accounting locally; the proxy's `resolveModel` strips the bracket before talking to Copilot. The proxy's `resolveModel` translates Anthropic slugs (with or without `[1m]`) to Copilot's dotted slug at request time. `codex` → `gpt-5.5`. `ANTHROPIC_SMALL_FAST_MODEL` defaults to `claude-haiku-4-5`; `/model` picker tier rows are seeded via `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL` (bare slugs — Copilot has no `-1m` backend for sonnet/haiku, and Anthropic-side `modelSupports1M` doesn't list haiku). Opt out of 1M locally with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (HIPAA). Fallback chains fire only on the implicit-default path. Full rationale + slug-translation walkthrough in [`docs/default-models.md`](docs/default-models.md).

### Peer-model MCP integration (auto-invocation, effort, decomposition)

The `claude` subcommand auto-injects three peer-model review tools as Claude Code subagents (`codex-critic` gpt-5.5, `codex-reviewer` gpt-5.3-codex, `gemini-critic` gemini-3.1-pro-preview) plus a `peer-review-coordinator` meta-subagent. Each persona accepts an `effort?: "low"|"medium"|"high"|"xhigh"` argument; per-persona `allowedEfforts` table, the SSE-streamed `/mcp` xhigh-default rationale, the latency-by-effort matrix, and the predictedTooLong pre-flight cap live in [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md). Concurrency cap `MAX_INFLIGHT_TOOLS_CALL = 8` (single shared counter in `src/lib/mcp-inflight.ts`; both MCP-boundary persona calls in `src/routes/mcp/handler.ts` AND nested `peer_review`/`advisor` calls inside the worker tools acquire from the same slot — so a worker can't fan out unboundedly and starve operator traffic). **Decomposition is the load-bearing fix for Claude Code v2.1.113+'s MCP per-tool-call timeout regression ([#50289](https://github.com/anthropics/claude-code/issues/50289)); the `MCP_TIMEOUT=600000` env injection is harmless insurance.** Two non-negotiables when touching `src/routes/mcp/handler.ts`: (1) the `predictedTooLong` cap MUST fire before the `acquireInFlightSlot()` call (don't reorder — leaks concurrency slots on every reject); (2) `sweepStalePeerAgentMdFiles`'s regex requires the digit-PID prefix — relaxing it would delete user-authored files like `peer-reviewer.md`.

The same `/mcp` surface also exposes two non-persona utility tools that all clients see: `web_search` (Copilot-backed) and `code_search`. `code_search` runs ripgrep with BM25F ranking (Robertson, Zaragoza, Taylor 2004) over four code-aware fields (matched line, surrounding context, file path tokens, symbol-definition heuristic), then refines the symbol-context field with tree-sitter AST analysis on the top hits (`structural: "full"` → top 50, `structural: "topN"` → top 10) so identifier definitions outrank incidental string matches. Tree-sitter passes are wrapped in a 200ms wall-clock budget; on exhaustion remaining hits drop back to the regex heuristic for that one file. The MCP response includes one optional `notice: string` field, present iff an actionable degradation fired — either the structural budget exhausted, or the 256KB response-size cap truncated the result set; the message text tells the model what to retry (`structural: "topN"`, narrow query, lower limit). Single-identifier queries in `ranked`/`literal` mode are auto-expanded across camelCase / snake_case / kebab-case / SCREAMING_SNAKE skeletons before being passed to ripgrep (`getUserName` also finds `get_user_name`). Workspace is any absolute path the proxy process can read — no allow-set, no secret-shape file denylist. The threat model is symmetric (Claude Code already has Read / Bash / Edit that reach the same paths), so gating one tool was inconsistency, not defense. Ripgrep itself comes from `@vscode/ripgrep` (per-platform binary via optionalDependencies) with system-PATH `rg` preferred when available. The MCP handler trims the rich internal `CodeSearchResponse` to `{file, line, snippet}` per hit plus a tiny envelope before stringifying — internal diagnostics (scores, field contributions, scanned-files, elapsed-ms, ranking-metadata block) are intentionally NOT forwarded; see the "Design principle: ruthlessly minimal MCP tool surface" section in [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md) for the per-field rationale. Implementation: `src/lib/code-search.ts`.

`/mcp` also exposes two **worker tools** (`worker_explore` read-only, `worker_implement` read+write) that delegate scoped work to an **autonomous Pi-runtime worker subagent** routed through Copilot's `gemini-3.5-flash` (the vendored Pi runtime lives at `src/vendor/pi/`; the sync protocol is in [`docs/pi-vendor-sync.md`](docs/pi-vendor-sync.md)). Dual gate: `workerToolsEnabled()` drops both tools from `tools/list` AND `tools/call` when `GH_ROUTER_DISABLE_WORKER_TOOLS=1` OR `gemini-3.5-flash` is missing from the Copilot catalog (or present but lacks `tool_calls`). The default model lives at `src/lib/worker-agent/engine.ts:DEFAULT_MODEL` and is re-imported by the handler — single source of truth, no parallel constant to drift. Budget caps (`Budget` in `src/lib/worker-agent/budget.ts`): max turns 30 (`GH_ROUTER_WORKER_MAX_TURNS`), max wall-clock 30min (`GH_ROUTER_WORKER_MAX_WALLCLOCK_MS`), max cumulative tool-output bytes 8 MiB (`GH_ROUTER_WORKER_MAX_TOOL_BYTES`), advisor transcript chars 720 000 (`GH_ROUTER_WORKER_ADVISOR_MAX_CHARS`, matches `ADVISOR_MAX_CONVERSATION_CHARS` in `src/services/advisor/advisor.ts`). **No token/cost accounting** — model-agnostic proxies hit the runaway-loop concern without per-model tokenizer duplication. `worker_implement` accepts `worktree: boolean` for git-worktree isolation (per-call auto-clean `finally` + session-end SIGINT/SIGTERM sweep + boot-time PID+UUID-gated sweep — the digit-PID prefix is load-bearing, do NOT relax). Worker `bash` runs through a **strict env allowlist** (NOT denylist) with POSIX `bash -c` (no `.profile`/`.bashrc`) and `taskkill /T /F` on Windows; **all `GH_ROUTER_*`, `GITHUB_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `COPILOT_TOKEN` are dropped** from the spawned bash env. Worker file IO (`read`/`write`/`edit`) caps at 10 MiB matching `MAX_STDOUT_BYTES` in `src/lib/code-search.ts`. Path denylist for `read`/`glob`/`grep`/`code_search`: `.env*`, `*.pem`, `id_rsa*`, `id_ed25519*`, `.git/` interior, `.ssh/`, `.gnupg/`, `.npmrc`, `.netrc`. Full architecture + per-cap table in [`docs/peer-mcp-design.md`](docs/peer-mcp-design.md) "Worker tools".

### Spawned-CLI auth isolation

`STRIPPED_PARENT_ENV_KEYS` (`src/lib/launch.ts`) sanitizes auth-related keys from the parent env BEFORE the proxy's overrides are merged in — prevents shell-exported credential leaks AND silences Claude Code's `Auth conflict` warnings. `getClaudeCodeEnvVars` sets `CLAUDE_CONFIG_DIR` to a router-owned mirror dir; `ensureClaudeConfigMirror` (`src/lib/paths.ts`) classifies each `~/.claude/` entry as **ISOLATED** (skipped — `.credentials.json`, lock files, `statsig/`, `cache/`, `paste-cache/`), **SHARED** (directory symlink, atomic temp+rename — `projects/`, `sessions/`, `tasks/`, `todos/`, `transcripts/`, `shell-snapshots/`, `plans/`, `file-history/`, `backups/`), or **MIRRORED** (snapshot copy — everything else). Two non-negotiable rules: **never symlink individual files** (Node's `fs.rename()` doesn't follow symlinks; Claude Code's atomic-write pattern severs them — gemini-critic finding) and **`agents/` MUST stay MIRRORED** (the proxy writes per-launch `peer-<pid>-<rand>-<name>.md` files there; a symlink would route writes/deletes into the user's real `~/.claude/agents/` and destroy custom subagent files — pinned by a `policyFor("agents") === "MIRRORED"` regression test). The proxy then writes a synthetic `claudeAiOauth` credential to the mirror so spawned teammates (whose env-allowlist drops `ANTHROPIC_AUTH_TOKEN`) can authenticate by reading the file. **Do NOT re-introduce `ANTHROPIC_AUTH_TOKEN=<anything>` to the spawned-child env — historical agent-teams silent-mailbox bug; teammates drop the token from spawn allowlist and land at "Not logged in".** Full mirror policy, synthetic-credential schema (verbatim from binary `guH`), keychain isolation, no-401 invariant (`forwardError` 401→503 remap), and migration-from-older-versions warning in [`docs/auth-isolation.md`](docs/auth-isolation.md).

### Thinking-mode translation

Copilot rejects Anthropic's `thinking:{type:"enabled", budget_tokens:N}` shape on adaptive-thinking models with HTTP 400. The router translates to Copilot's `thinking:{type:"adaptive"}` + `output_config:{effort}` automatically when the resolved model declares `adaptive_thinking: true`. Bucket: `<2k → low`, `<8k → medium`, `<24k → high`, else `xhigh`. Clamps to `model.capabilities.supports.reasoning_effort` allowlist when present (lower-tier preference for ties). Client-supplied `output_config.effort` always wins. No-op when the model lacks `adaptive_thinking` (passthrough). Implemented in `src/routes/messages/handler.ts` (`translateThinking`).

### Web search

`/search` fulfils web-search tool calls via Copilot's MCP endpoint at `${copilotBaseUrl}/mcp` with the GitHub PAT directly (NOT the Copilot-exchanged token). Required `X-MCP-Toolsets: web_search` header; SSE-framed JSON-RPC; model-agnostic out-of-band fulfilment. PAT-bearing requests are gated by `COPILOT_HOST_ALLOWLIST`. Wire flow + Anthropic-shape `web_search_*` substitution in [`docs/web-search.md`](docs/web-search.md).

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

- gpt-5-codex models ONLY work via `/responses` (NOT `/chat/completions`) — `/chat/completions` returns 4xx
- Models report `supported_endpoints` in their metadata

## Testing

- Framework: `bun:test` with `mock()` for fetch, Zod for schema validation
- Tests live in `tests/` directory
- Pattern: mock `globalThis.fetch`, call service, validate calls and response shapes
