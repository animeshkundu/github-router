# Peer-Model MCP Architecture & Phased Migration Plan

## Goal

Expose five peer-model review tools - `gpt-5.6-sol` (codex_critic), `gpt-5.3-codex` (codex_reviewer), `gemini-3.1-pro-preview` (gemini_critic and gemini_reviewer), and `claude-opus-5` (opus_critic) - inside Claude Code, used per their strengths to improve quality and reduce blind spots. Capability injection must be auto-injected on `github-router claude` startup with no per-session user action. Reasoning effort is configurable via the MCP tool args within each persona's allowed tiers.

### Five-Server Split

As of the latest architectural change, the original single `gh-router-peers` MCP server was split into **five intent-named MCP servers** to prevent monolithic server congestion and enforce isolation. Each is a distinct `mcpServers` entry pointing at a path-scoped `/mcp/<group>` endpoint (instead of the single `/mcp` union path, which is kept as a fallback for BYO clients).

The five scoped servers and their public MCP surfaces are:
- `peers`   → `/mcp/peers` (the critics: `codex_critic`, `codex_reviewer`, `gemini_critic`, `gemini_reviewer`, `opus_critic` + `codex_implementer` in `--codex-cli` mode)
- `search`  → `/mcp/search` (`code` [was `code_search`], `web` [was `web_search`])
- `workers` → `/mcp/workers` (`explore` [was `worker_explore`], `implement` [was `worker_implement`])
- `browser` → `/mcp/browser` (the browser tools with the `browser_` prefix dropped: `navigate`, `open_tab`, `read_page`, `act`, …; loaded only under `--browse`)
- `decide`  → `/mcp/decide` (`stand_in` [unchanged name])

Under this new topology, the lead model sees names prefixed as `mcp__<group>__<newname>`, e.g., `mcp__search__code`, `mcp__browser__navigate`, `mcp__peers__codex_critic`, `mcp__workers__explore`, `mcp__decide__stand_in`.

Config keys are bare by default (`peers`, `search`, etc.). To prevent a user's own servers from silently hijacking or dropping ours, the proxy performs active collision checking: if a key collides with a user-side `mcpServers` entry, it falls back to `gh-router-<group>` (e.g., `gh-router-browser`). This resolved key is threaded into BOTH the `mcpServers` map entries AND the persona `.md` routing files. On repeated collision it walks the numbered sequence `gh-router-<group>-2`, `-3`, … to the first free name - it never skips and never reuses a user-owned key (`resolveGroupKeysFromMirror` in `src/lib/codex-mcp-config.ts`).

---

## Current Architecture

The proxy at `src/routes/mcp/` exposes five scoped MCP servers on loopback ports:

- `mcp__peers__codex_critic` (gpt-5.6-sol) - adversarial design review
- `mcp__peers__codex_reviewer` (gpt-5.3-codex) - line-level code review
- `mcp__peers__gemini_critic` (gemini-3.1-pro-preview) - long-context cross-lab triangulation
- `mcp__peers__gemini_reviewer` (gemini-3.1-pro-preview) - second-lab line-level code review

Auto-injection: `github-router claude` registers these servers by **merging them into the per-launch mirrored `<CLAUDE_CONFIG_DIR>/.claude.json`'s `mcpServers` map** (`injectPeerMcpIntoMirror` in `src/lib/codex-mcp-config.ts`). This is the load-bearing fix for subagent MCP visibility - subagents (Agent-tool, forks, agent-teams subprocesses) discover MCP servers from `CLAUDE_CONFIG_DIR/.claude.json` user-scope, NOT from a parent-process-only CLI flag, so the mirror approach makes the peer tools visible to every spawned tier. The merge is non-destructive (the user's pre-existing user-scope MCPs are preserved). On collision, we dynamically resolve the server keys using a fallback name (`gh-router-<group>`) as described above; subagents inherit the fallback keys identically. Subagent persona prompts are written to `<CLAUDE_CONFIG_DIR>/agents/peer-<pid>-<rand>-<name>.md` and pass an `--agents`-style discovery path; the frontmatter has **no `tools:` field** so the subagent inherits the parent's full toolset (built-ins + every MCP visible to the parent, incl. our injected tools). Per-launch mirror dir (`<pid>-<rand>` under `~/.local/share/github-router/claude-config/`) means two concurrent launches never race on the `.claude.json` write or share an MCP nonce; orphan dirs from SIGKILL'd proxies are reclaimed by a boot-time PID-alive sweep. Project-scope MCPs (`<workspace>/.mcp.json`) are untouched - the spawned `claude` inherits the parent's cwd via `launchChild`'s no-`cwd:` spawn, so Claude Code reads them directly from the workspace; the proxy never mirrors or sanitizes project-scope. Auth: per-launch random 32-byte nonce as Bearer token + Host header check (loopback only); the proxy validates against the launch nonce regardless of which channel - mirror or `--mcp-config` fallback - the request came through.

Awareness layer: a short (~100-token) `--append-system-prompt` snippet (built by `buildPeerAwarenessSnippet` in `src/lib/peer-mcp-personas.ts`) tells Claude that the peer critics, the `peer-review-coordinator` fan-out subagent, and Claude Code's built-in `advisor` tool are available - non-prescriptive (the prescriptive auto-invocation triggers live in each MCP tool's own `description`). Default-on; opt out per-launch with `GH_ROUTER_PEER_AWARENESS=0` (also accepts `false` / `off` / `no` / empty string, case-insensitive).

## The Problem

Claude Code v2.1.113+ introduced a regression - open issue [#50289](https://github.com/anthropics/claude-code/issues/50289) labeled `bug`, `regression`, `has repro`. The `.mcp.json` per-server `timeout` field is silently dropped for HTTP transport; a hardcoded ceiling (60s SDK default; field reports of ~5min on v2.1.138 are inconsistent) cancels long peer-model calls before the reasoning model produces its first token. Adversarial reviews of substantial diffs at high reasoning effort routinely take 5-30 minutes and fail every time.

The MCP-SDK constants `DEFAULT_TOOL_CALL_TIMEOUT_MS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, and `resetTimeoutOnProgress` are present in the v2.1.138 binary's symbol table, but field reports disagree on whether `MCP_TIMEOUT` actually extends the per-tool-call HTTP wait. Heartbeat `notifications/progress` reach the wire but **don't reset the client timer** in current builds.

For full investigation, see [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md).

## Phased Plan (cheapest experiment first)

### Phase 1 - Try `MCP_TIMEOUT=600000` env var (5 minutes; ship if works)

Inject `MCP_TIMEOUT=600000` into the spawned `claude` child's environment via `getClaudeCodeEnvVars` in `src/lib/server-setup.ts`. Empirical 5-minute test on v2.1.138 resolves the field-reports disagreement.

**Verification:**
1. `bun run build && kill <proxy-pid> && node dist/main.js claude`
2. Fire a long peer-review call that previously hit the timeout (e.g., a multi-page brief with ~50KB context)
3. Watch for: (a) call completes within 10 min, (b) no `Could not deliver error event` warns in `error.log`, (c) no client-side `tool call timeout` errors

**If Phase 1 succeeds:** ship and stop. Document the env var setting. The architectural debate is moot.

**If Phase 1 fails:** proceed to Phase 2. Note the negative result on issue #50289.

### Phase 2 - Tool-description engineering for auto-decomposition + auto-invocation triggers + effort plumbing (~1 hour)

No new code debt - pure prompt and tool-description work, plus a one-line cap raise.

#### Track 2A - Auto-invocation prompts (the "use peers proactively" lever)

Currently the persona tool descriptions say *what* the persona is. They need to say *when* to call. Three layered mechanisms, weakest to strongest:

1. **MCP tool descriptions** (passive, low-friction, ~85% confidence per claude-code-guide expert). Edit `src/lib/peer-mcp-personas.ts` so each persona's `description` includes prescriptive triggers:
   > "Adversarial second opinion from gpt-5.6-sol. **CALL BEFORE: ExitPlanMode for any plan involving >2 files or new architecture; finalizing a major design choice; TeamCreate when the team's task is non-trivial.** **CALL AFTER: any commit touching concurrency, security, or streaming code paths.** Backed by a different model with different blind spots than Claude. Cost: minutes; use freely on important checkpoints."

2. **`--agents` JSON descriptions** (medium strength). Update each subagent's `description` field with the same trigger language.

3. **Add a `peer-review-coordinator` subagent** (strongest, no new code). Its description: *"Coordinates cross-lab adversarial review. **Use proactively before ExitPlanMode and after non-trivial commits.** Routes to codex-critic / codex-reviewer / gemini-critic in parallel based on artifact type and aggregates findings."* For agent teams: peer-review-coordinator is auto-added as a member of every TeamCreate-spawned team.

4. **Optional opt-in PreToolUse hook on `ExitPlanMode`** (strongest, only opt-in via env). Off by default. Opt-in via `GH_ROUTER_AUTO_PEER_REVIEW=1`.

**Empirical acceptance test (mandatory):** sample 10 non-trivial planning sessions and 10 non-trivial implementation sessions in a clean profile, count whether Opus delegated to `peer-review-coordinator` at the documented checkpoints. Target: ≥7/10 in each. If <7/10, flip the `PreToolUse` hook to default-on.

#### Track 2B - Decomposition guidance in tool descriptions

The 7-batch sweep documented in [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md) proved decomposition fully solves the timeout (each batch <3 min). Add to the persona tool descriptions:

> "If the artifact under review is large (>20 KB), prefer to break it into 2-4 focused batches and call this tool once per batch in parallel. Aggregate findings yourself. This avoids long single calls."

Lower the default `effort` from xhigh to high - xhigh-by-default is expensive; let callers opt up for explicit deep dives.

#### Track 2C - Reasoning effort plumbing

In `src/routes/mcp/handler.ts:callPersona`, accept `effort?: "low"|"medium"|"high"|"xhigh"`. Set `payload.output_config = { effort }` for `/responses` personas. For `/chat/completions` personas (gemini-critic), schema-test `payload.reasoning_effort`; if Copilot 400s, document `effort` as a no-op for gemini-critic in its tool description (don't silently pretend it works).

#### Track 2D - Raise concurrency cap so decomposition can actually parallelize

Track 2B tells Opus to fan out into 2-4 parallel batches; with the current `MAX_INFLIGHT_TOOLS_CALL = 2` (`src/routes/mcp/handler.ts:32`), the (3-4)th calls return `isError: "queue full"` immediately, defeating the recommendation. Raise to **8** to comfortably cover a 7-fork wave with one slot of headroom.

The cap was a defensive pre-launch guess (not derived from any measured Copilot rate-limit). Persona handlers hold no shared mutable state - there's no race the cap is hiding. Memory per call is ~MB (non-streamed response bodies) - 7 in-flight reviews are tens of MB total. Full justification in [research/peer-mcp-investigation.md § Concurrency cap investigation](research/peer-mcp-investigation.md#concurrency-cap).

**If Phase 1+2 satisfies the user's needs:** ship and stop. This is the most likely sufficient state.

### Phase 3 - Async MCP (kickoff + poll) - only if Phase 1+2 insufficient (4-6 hours)

Build the async pattern peers and researchers converged on, with the bug fixes both critics surfaced:

- **Merged tool surface**: add `async: boolean` parameter to existing 3 tools (default false). NOT 6 parallel tools - gemini's UX concern about Opus tool-routing confusion.
- **Utility tools**: `poll_review(job_id, max_wait_s?)`, `cancel_review(job_id)`, `free_review(job_id)`.
- **In-process job map** (`src/lib/peer-mcp-jobs.ts` new): `Map<jobId, JobState>` keyed by `crypto.randomUUID()`.
- **Hard 30-min execution TTL on RUNNING jobs** - gemini's deadlock-vector finding. AbortController auto-fires, transitions to `status: "timeout"`, allows GC sweep.
- **Cap = 6 in-flight** (codex said 32 too high for xhigh-reasoning cost), env-overridable.
- **Retention 30 min** (codex said 5 min too short), `free_review` to release explicitly.
- **`partial_output` 1 MB cap** (gemini's OOM finding); drop oldest chunks if exceeded.
- **Result via standard MCP `resources` protocol** - `review://job-<uuid>` URIs, not filesystem paths (gemini: filesystem-IPC breaks MCP location-transparency).
- **Auto-promote-to-sync** for fast jobs (gemini): if `async: true` request completes within 20s threshold, return result inline - skip polling overhead entirely.
- **`max_wait_s` server-validated ≤ 50** (under the 60s ceiling).
- **AbortSignal threading** via `AbortSignal.any` - proxy's own controller, NOT `c.req.raw.signal` per CLAUDE.md Bun-signal quirk.
- **IMPERATIVE tool descriptions**: "you MUST call poll_review until completed" (claude-code-guide expert: 85% confidence on this lever).
- **Standing instructions in CLAUDE.md** (compaction-safe).
- **SEP-1686 alignment** so the future-rename to `tasks/create`/`tasks/status`/`tasks/cancel` is a refactor not a rewrite. Spec accepted Nov 2025 - see [SEP-1686](https://modelcontextprotocol.io/community/seps/1686-tasks).
- **Adversarial test suite**: abandoned-job-hits-TTL, wrong-id, expired-completed, cancel-during-fetch, server-restart-loses-jobs, over-cap, polling-until-final.

## Files & Reused Utilities

**Phase 1:**
- `src/lib/server-setup.ts` - `getClaudeCodeEnvVars` adds `MCP_TIMEOUT: "600000"`
- `tests/launch.test.ts` (or wherever the env-vars are tested) - assert injection

**Phase 2:**
- `src/lib/peer-mcp-personas.ts` - descriptions + effort default
- `src/lib/codex-mcp-config.ts` - `buildAgentPrompt` for new auto-invoke language; new `peer-review-coordinator` agent
- `src/routes/mcp/handler.ts` - effort plumbing; `peer-review-coordinator` agent registration; raise `MAX_INFLIGHT_TOOLS_CALL` from 2 to 8 (line 32)
- `src/services/copilot/create-responses.ts` and `create-chat-completions.ts` - accept caller signal; pass `output_config.effort`
- Test files: `tests/peer-mcp-personas.test.ts`, `tests/routes-mcp.test.ts`, `tests/isolated/codex-mcp-config.test.ts`
- `CLAUDE.md` - document the auto-invocation triggers, effort default, and concurrency cap

**Phase 3 (only if reached):**
- New: `src/lib/peer-mcp-jobs.ts` - job map, GC, TTL, AbortController plumbing, MCP resource registration
- `src/routes/mcp/handler.ts` - `async: boolean`; `poll_review`/`cancel_review`/`free_review`; `resources/list` + `resources/read` for `review://` URIs; auto-promote-to-sync
- New: `tests/lib-peer-mcp-jobs.test.ts`
- `tests/routes-mcp.test.ts` - async path integration tests including resource fetch
- `CLAUDE.md` - polling-protocol section

**Reused (don't duplicate):**
- `callPersona` / `buildPersonaInstructions` (`src/routes/mcp/handler.ts:199`, `src/lib/peer-mcp-personas.ts`)
- `createResponses` / `createChatCompletions` (`src/services/copilot/`) - signal threaded through (Phase 2/3)
- `tryRefreshAndRetry` (`src/lib/token.ts`) - already wraps Copilot fetches
- `checkAuth` (`src/routes/mcp/handler.ts:69`) - auth applies to new tools transparently
- `MAX_INFLIGHT_TOOLS_CALL` cap pattern - clone for `MAX_INFLIGHT_REVIEWS = 6` in Phase 3

## Decision Log Pointer

The full multi-stage adversarial review process - including the 4-perspective team consultation that reshaped this plan three times (plugin/Bash → async-MCP → phased) - is documented in [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md) for future contributors who want the rationale behind each Phase ordering decision.

## Deployed state (auto-invocation, effort, decomposition)

This section documents what is actually shipped in the proxy today - the runtime
behavior `github-router claude` exposes - as distinct from the phased plan above.

The `claude` subcommand auto-injects five peer-model review tools as Claude Code subagents (`codex-critic` gpt-5.6-sol; `codex-reviewer` gpt-5.3-codex; `gemini-critic` gemini-3.1-pro-preview; `gemini-reviewer` gemini-3.1-pro-preview; `opus-critic` claude-opus-5) plus a `peer-review-coordinator` meta-subagent that fans out to them in parallel.

**Auto-invocation triggers** (Phase 2A): each persona's MCP-tool description includes prescriptive **CALL BEFORE / CALL AFTER** wording so Opus naturally delegates at the right checkpoints (before `ExitPlanMode` for non-trivial plans, after commits touching concurrency/security/streaming, before `TeamCreate` for non-trivial team tasks). The `peer-review-coordinator` subagent's description uses the documented Claude Code "use proactively" idiom - Opus delegates to it without an explicit user request at the matching checkpoints. Empirical reliability is ~60% per claude-code-guide (the plan calls for an acceptance test ≥7/10; if <7/10 we flip an opt-in `PreToolUse(ExitPlanMode)` hook to default-on, env-disable-able via `GH_ROUTER_AUTO_PEER_REVIEW=0`).

**Phase 2.5 - agent registration surface** (critical for Track 2A actually working): Claude Code v2.1.138's `--agents <json>` flag does NOT populate the Task `subagent_type` enum (per claude-code-guide expert verification - confirmed by the documented separation in code.claude.com/docs/en/cli-reference.md). Subagents passed via `--agents` are only reachable via natural-language delegation; explicit `Task(subagent_type=...)` calls fail with "Agent type 'X' not found". The fix is to write per-launch markdown subagent files into `~/.claude/agents/peer-<pid>-<rand>-<name>.md` - that's the canonical surface Claude Code reads at session start. The spawned `claude` is no longer launched with `--agents`; the `.md` files are. A boot-time sweep (`sweepStalePeerAgentMdFiles` in `src/lib/paths.ts`) drops stale files matching `peer-<deadpid>-*-*.md` from the router-owned mirror at `<CLAUDE_CONFIG_DIR>/agents/`, never from the user's real `~/.claude/agents/`; **the regex's required digit-PID prefix protects user-authored files (e.g. `peer-reviewer.md` is preserved because there's no PID segment) - do NOT relax it without auditing every file under the mirror**. Orphans a pre-mirror release left in the user's own directory are skipped at the copy step in `mirrorDirRecursive` rather than deleted, so they never register and nothing the user owns is removed.

**Decomposition guidance** (Phase 2B): each persona description tells Opus "if the artifact is large (>20 KB), split into 2-4 focused batches and call in parallel" - necessary because Claude Code v2.1.113+ regression [#50289](https://github.com/anthropics/claude-code/issues/50289) caps HTTP MCP per-tool-call wait at the bundled MCP-SDK default (~30 s in `cc-backup/src/services/mcp/client.ts:457`; field reports of "5 min" / "60 s" elsewhere are a different SDK constant or older binary). The `MCP_TIMEOUT=600000` env var injected by `getClaudeCodeEnvVars` is "belt-and-suspenders" - it works on versions where the regression is fixed and is silently ignored on regressed versions. **Decomposition is the load-bearing fix; the env injection is harmless insurance.** The 7-batch sweep documented in [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md) proved decomposition completes every per-batch call in <3 min.

**Reasoning effort** (Phase 2C): each persona MCP tool accepts an `effort?: "low"|"medium"|"high"|"xhigh"` argument, default **`high`** (cost-conscious; raise to `xhigh` for explicit deep dives, drop to `medium` for quick sanity checks). For `/v1/responses` personas (codex-critic, codex-reviewer) the effort is set as `payload.reasoning.effort`. For `/v1/chat/completions` (gemini-critic) it's set as `payload.reasoning_effort` and may be silently ignored by Copilot's gemini route - gemini-3.x reasoning is largely auto-applied. Invalid effort values are rejected with JSON-RPC `-32602`.

**Concurrency cap** (Phase 2D): `MAX_INFLIGHT_TOOLS_CALL = 32` in `src/routes/mcp/handler.ts` (raised from the original defensive 2). 9th in-flight `tools/call` returns clean isError `"queue full"`. Cap exists to bound runaway clients; persona handlers are stateless. Decomposition fan-out of 4-7 parallel batches now fits comfortably under the cap.

**Empirical latency-by-effort matrix** (Phase A3; probed live 2026-05-14 against `api.enterprise.githubcopilot.com` via the proxy on a ~600B representative review prompt with `max_output_tokens: 4096`):

| Persona | Model | Endpoint | Effort | Latency on ~600B prompt |
|---|---|---|---|---|
| codex_critic | gpt-5.6-sol | /v1/responses | xhigh (default) | gpt-5.5 probe (historical): 56.3s - fits inside SSE-streamed `/mcp/peers` (no MCP per-tool-call timeout) |
| codex_critic | gpt-5.6-sol | /v1/responses | high | gpt-5.5 probe (historical): 23.8s |
| codex_critic | gpt-5.6-sol | /v1/responses | medium | gpt-5.5 probe (historical): 26.3s |
| codex_reviewer | gpt-5.3-codex | /v1/responses | high | 16.0s |
| gemini_critic | gemini-3.1-pro-preview | /v1/chat/completions | high (default) | no empirical latency measurement yet |
| gemini_reviewer | gemini-3.1-pro-preview | /v1/chat/completions | high (default) | no empirical latency measurement yet |
| opus_critic | claude-opus-5 (else claude-opus-4.6-1m → claude-opus-4-6) | /v1/messages | high (default; xhigh available on Opus 5) | 30-90s on real reviews - fits inside SSE-streamed `/mcp/peers` |

**opus_critic model selection**: `activePersonas()` (`src/routes/mcp/handler.ts`) resolves opus_critic's model at call time. It prefers `claude-opus-5`, whose single base slug is natively 1M, when the live catalog carries it. On lesser tiers it falls back to the older 1M-context Opus 4.6 variant (`claude-opus-4.6-1m`, ≈936K-token prompt window), then to the 200K `claude-opus-4-6`. Opus 5 and codex_critic (gpt-5.6-sol, ~1M) are the two big-window peers that can take a large artifact whole. opus_critic exposes `low|medium|high|xhigh`; its `defaultEffort` remains `"high"` to preserve the prior latency profile, while callers can opt into Opus 5's `xhigh` tier.

`xhigh` is the default on codex_critic, codex_reviewer, and opus_critic because commit `d3491d6` shipped SSE-streamed `/mcp` responses (`handler.ts:handleToolsCallSSE`). Claude Code's MCP HTTP client honors `text/event-stream` and does NOT apply the ~60s per-tool-call timer to streamed responses, so the previous `xhigh` 60s-ceiling concern no longer applies on long-running personas. Probe coverage in `scripts/probe-copilot-compat.sh`: `opus_critic_low`, `opus_critic_medium`, `opus_critic_high_allowed`, `opus_critic_xhigh_allowed`, `codex_critic_xhigh_allowed`, `codex_reviewer_xhigh_allowed`, `gemini_critic_xhigh_rejected`. Matrix rows mirrored into [`copilot-compat-matrix.md`](copilot-compat-matrix.md).

**Per-persona allowedEfforts** (Phase A1; enforced by `persona.allowedEfforts` in `src/lib/peer-mcp-personas.ts`, gated in `handleToolsCall` BEFORE the `inFlightToolsCall` increment so a rejected effort doesn't burn a concurrency slot):

| Persona | low | medium | high | xhigh | Default |
|---|---|---|---|---|---|
| codex_critic | ✅ | ✅ | ✅ | ✅ (SSE-streamed) | xhigh |
| codex_reviewer | ✅ | ✅ | ✅ | ✅ (SSE-streamed) | xhigh |
| opus_critic | ✅ | ✅ | ✅ | ✅ (SSE-streamed) | xhigh |
| gemini_critic | ✅ | ✅ | ✅ | ❌ rejected `-32602 RPC_INVALID_PARAMS` | high |
| gemini_reviewer | ✅ | ✅ | ✅ | ❌ rejected `-32602 RPC_INVALID_PARAMS` | high |

`xhigh` is allowed on the three long-running personas because SSE-streamed `/mcp/peers` keeps the wall time off the MCP per-tool-call clock. The Gemini personas (`gemini_critic` and `gemini_reviewer`) are the exception: Copilot's gemini route returned 400 (`reasoning_effort "xhigh" is not supported by model gemini-3.1-pro-preview; supported values: [low medium high]`), so the gate rejects xhigh upstream of any Copilot call. The empirical 400 is captured in the proxy log for posterity.

**Pre-flight `predictedTooLong` cap** (Phase A2; defense-in-depth on top of the effort gate). Even `high` on the codex personas can bust the ceiling once the brief grows past ~8 KB (the 23.8s baseline scales roughly linearly with input). The cap rejects with `isError: true` (NOT an RPC error - the request is syntactically valid; the prediction is operational) and an actionable message telling the caller to drop to `medium` or split the brief into 2-4 parallel sub-calls per the decomposition guidance:

| Persona | Effort | Brief size cap (`prompt + context` bytes) |
|---|---|---|
| codex_critic | high | 8 KB → toolError |
| codex_reviewer | high | 12 KB → toolError (faster sibling, more headroom) |
| opus_critic | medium | 6 KB → toolError (conservative - opus thinking grows with input) |
| gemini_critic | (any) | (no cap - long-context strong, no empirical data yet to anchor) |
| gemini_reviewer | (any) | (no cap - long-context strong, no empirical data yet to anchor) |

**The cap fires BEFORE the AbortController + `inFlightToolsCall` increment**, so a rejected pre-flight is free of concurrency-slot cost and free of upstream call cost (no Copilot fetch issued). Don't reorder this - moving the cap after the increment leaks concurrency slots on every rejected pre-flight. Thresholds are constants in `src/routes/mcp/handler.ts` - easy to update as more empirical data arrives via the probe suite.

**Prompt-window guard** (distinct from `predictedTooLong` - that's a JSON-path *timeout* predictor in bytes; this is a *context-window* guard in exact tokens). `predictedWindowOverflow()` in `src/routes/mcp/handler.ts` runs inside `handleToolsCall` (so it covers BOTH the SSE and JSON paths), BEFORE `acquireInFlightSlot()`. It counts the EXACT o200k token count of the text actually sent to the peer (`baseInstructions` + `buildUserText(prompt, context)`) and compares against the persona model's live `max_prompt_tokens` (minus a 2K framing reserve). On overflow it returns `isError: true` with an actionable message telling the caller to route the full artifact to a larger-window peer (`codex_critic` gpt-5.6-sol ~1M, `opus_critic` Opus 5 1M) or split BY CONCERN - it does NOT truncate, because silently dropping lines from a review artifact is worse than a clear error. No-op when the model's `max_prompt_tokens` isn't in the catalog (lets the upstream call decide). This is the load-bearing enforcement behind the coordinator's window-aware routing guidance in `src/lib/codex-mcp-config.ts`: skip (don't downsize) a small-window peer like `gemini_critic` (≈136K) when the artifact won't fit. The token count uses the repo's existing exact o200k tokenizer (`gpt-tokenizer` via `src/lib/tokenizer.ts` - every adaptive Copilot model declares `o200k_base`), NOT a chars-per-token or word-count approximation; the same tokenizer backs the advisor transcript budget (`resolveAdvisorMaxTokens` in `src/services/advisor/advisor.ts`).

**`opus_critic` persona** (Phase B): adversarial same-lab second opinion from fresh-context Opus 5 routed via `/v1/messages`. It reviews plans, designs, and code tradeoffs for cognitive momentum, sunk-cost reasoning, and confabulated assumptions, returning a calibrated objection or `no material objection`. Use it as a quick same-lab sanity check before committing to a controversial decision when the artifact fits comfortably in one shot. **Limited blind-spot diversification** - same training data, same lab, same RLHF priors as the lead, so it does NOT substitute for cross-lab triangulation; reach for `codex_critic` (`high`) or `gemini_critic` for genuine adversarial coverage. Routing reflected in `peer-review-coordinator` (`src/lib/codex-mcp-config.ts`).

**Per-call telemetry log** (`logTelemetry` in `src/routes/mcp/handler.ts`): opt-in via `GH_ROUTER_LOG_PEER_MCP=1` (mirrors the strict `=== "1"` pattern of `GH_ROUTER_LOG_FIELDS`). When enabled, every `tools/call` writes one line directly to stderr - `[peer-mcp] name=<persona> model=<id> duration_ms=<n> result=<ok|isError|exception>` - so a maintainer can grep across sessions to see which personas earn their keep. Default off because the proxy shares a TTY with the Claude TUI under `github-router claude`, and an unconditional stderr write per call shows up as ambient UI noise.

## Code search (`code`)

Non-persona MCP tool exposed alongside `web` under `NON_PERSONA_MCP_TOOLS` (`src/lib/peer-mcp-personas.ts`). All clients (Claude Code, codex, gemini callers) see it via the same `/mcp/search` scoped surface (or `/mcp` union). Implementation: `src/lib/code-search.ts`.

### Ranking algorithm

**BM25F** (Robertson, Zaragoza, Taylor; *Simple BM25 Extension to Multiple Weighted Fields*; CIKM 2004). Multi-field extension of Okapi BM25 (Robertson & Zaragoza 2009 monograph, *Foundations and Trends in IR* 3(4):333-389). Lucene/Elasticsearch use BM25/BM25F as their default scorer; CodeSearchNet (Husain et al 2019, arxiv/1909.09436) uses BM25 as its classical IR baseline; Sourcegraph Zoekt's "weighted scoring signals (symbol match, file path, syntactic context, ...)" is BM25F-shaped multi-field scoring over a code-specific field set.

Formula (canonical CIKM 2004), applied at file granularity over the ripgrep hit set:

```
BM25F(q, f) = Σ_t  IDF(t) · w_t,f / (w_t,f + k1)
w_t,f       = Σ_field  b_field · tf_t,field,f /
              ((1 − l_field) + l_field · (len_field,f / avglen_field))
IDF(t)      = log( (M − df(t) + 0.5) / (df(t) + 0.5) )
```

Lucene defaults: `k1 = 1.2`. Per-call corpus statistics (M = number of files in the hit set, df, avglen) computed once per query - no persistent index needed; sub-second for hit sets ≤ a few hundred files.

### Fields

| Field | Source | `b_f` | `l_f` |
|---|---|---|---|
| `match_line` | The line ripgrep matched | 3.0 | 0.0 |
| `symbol_context` | Matched line if it's a definition-shape (`function`, `class`, `const X =`, etc.); empty otherwise | 2.5 | 0.0 |
| `file_path` | Path tokens (basename + dirs, space-joined) | 2.0 | 0.0 |
| `context` | Lines before+after the match (configurable `context_lines`) | 1.0 | 0.75 |

Tokenizer: rule-based identifier splitter per Vasilescu, Ray, Mockus, *How to Split Identifiers?* (ESEC/FSE 2021). Case-boundary splits with acronym-run lookahead (`HTTPSConnection` → `[https, connection]`), digit-boundary attaches trailing digits to letters (`parseV2Handler` → `[parse, v2, handler]`), lowercase, drop length-1 tokens.

### Shoulder pruning

After BM25F sort, truncate at the first hit below `0.5 × top_score` (Burges 2010 LTR convention). When the top score is 0 (no field had a query-token match), all hits are returned in tie-break order. The pruning is an internal optimization that surfaces the few viable answers; the count of omitted results is intentionally NOT exposed to the model (the model can re-issue in `literal` mode if it needs the full unranked set, and a numeric pruning count is diagnostic-only - see the minimality principle below).

### Workspace model

`workspace` is any absolute path the proxy process can `stat` and is a directory. The proxy runs as the user; reads are bounded by the user's own filesystem permissions, same as Claude Code's built-in Read / Bash / Edit tools. There is no allow-set, no marker-file walk, no secret-shape file denylist.

This was reconsidered after the initial design (which had a default-deny allow-set + a hardcoded secret-shape denylist for `*.env`, `*.pem`, `id_rsa*`, etc.). The earlier framing treated the tool as a potential "model-callable file-exfil oracle." That framing assumes a privilege gap between the proxy and the model - but there isn't one. The same model that can call the search tool can also issue `Bash cat ~/.ssh/id_rsa` or `Read /etc/passwd`. Gating only search was inconsistency, not defense. The simpler holistic answer: reach the same paths Claude Code already reaches, no special-cased boundary.

Validation kept:

- `workspace` must be an absolute path (relative paths are an integration-error footgun).
- `realpathSync` canonicalization (resolves symlinks; output paths are reported relative to this canonical root).
- Must exist AND be a directory (a file path or a missing path errors out cleanly).
- Errors do NOT echo the rejected path (output flows upstream to model providers; consistent with `COPILOT_HOST_ALLOWLIST`'s no-echo pattern).

### Hardened spawn (CVE-class fixes from peer review)

- **Argv injection** (`--`): ripgrep is invoked as `rg <flags> -- <query> .` - the positional separator prevents a query starting with `-` (e.g. `--no-ignore`) from being parsed as a flag.
- **TOCTOU**: rg spawns with `cwd: canonicalWorkspace, shell: false` and target `.` - the user-supplied workspace string is NEVER passed as an argv positional. The kernel-level cwd handle pins the directory at spawn time, closing most of the validate→spawn race window. Residual same-user races (an attacker who controls the same user account and can swap the directory between validation and spawn) are explicitly out of scope.
- **Cancel-race partial JSON**: on `signal.aborted`, the JSON parser short-circuits before reading further lines - a half-flushed truncated chunk never reaches `JSON.parse`. Three-lab confirmed fix.
- **Windows process-tree**: on `process.platform === "win32"`, abort uses `taskkill /T /F /PID <pid>` because `child.kill()` does NOT reliably terminate descendants on Windows.
- **Global limit**: `--max-count` is per-file in ripgrep. We enforce `limit` globally in the TS reader; relying on rg's flag would let a 500-file monorepo return 10,000 hits with `limit=20`.

### Ripgrep bundling

Tri-tier resolution (mirrors cc-backup `src/utils/ripgrep.ts:31-65`):

1. **System** - if PATH has `rg`, spawn as the literal command name `"rg"` (NOT the absolute path from `which`/`where` - using just the name leverages Windows' NoDefaultCurrentDirectoryInExePath to prevent PATH-hijacking via `./rg.exe` in the proxy's cwd).
2. **Bundled** - `@vscode/ripgrep@1.18.0+` which ships per-platform binaries via `optionalDependencies` (no postinstall script needed; the right binary lands at `node_modules/@vscode/ripgrep-{platform}-{arch}/bin/rg{.exe}`).
3. **Error** - clean MCP `isError: true` response only if BOTH fail.

`package.json` keeps `"trustedDependencies": ["@vscode/ripgrep"]` as forward-compatibility for older `@vscode/ripgrep` versions that used postinstall scripts (Bun does NOT run postinstall by default).

### Observability

Per-call breadcrumb logged via consola at info level (not sent off-host):

```
[code] mode=ranked results=14 truncated=false scanned_files=412 elapsed_ms=34 abort=false rg=system
```

Raw `query` and absolute workspace paths are NOT logged unless `GH_ROUTER_DEBUG_CODE_SEARCH=1` is set - query strings can leak intent and codebase shape.

### Upstream-snippet awareness

Snippets are sent upstream as tool-use-result content to the model. The proxy doesn't filter what gets returned - that's the same channel as `Read`'s tool result. If you wouldn't paste a directory's contents into a chat with the model provider, don't search it; the workspace surface here is no different from any other read tool.

### Structural-aware ranking

The default `ranked` mode does not stop at BM25F over text features. After scoring, the top-N hits are re-examined with tree-sitter so the `symbol_context` field can be lifted from a regex heuristic to a true AST signal - when the matched line is an identifier-definition node (function/class/method/interface/type/struct/trait/impl/enum/etc.) and the matched identifier sits at the node's "name" position, the field tokens are populated with that identifier and the hit's score rises accordingly. When the AST doesn't confirm a definition, the prior regex heuristic remains in place; this is purely a strict upgrade, never a downgrade.

Tree-sitter grammars (TypeScript, JavaScript, Python, Go, Rust, Java, C, C++) are pre-loaded at module init so the first ranked query of a session doesn't pay a cold-start cost. Files with extensions outside the covered set degrade silently to regex-only `symbol_context` for that one file (logged via consola, no user-facing notice).

The depth of the structural pass is controlled by the `structural` input:

| `structural` | Top-N parsed | When to pick |
|---|---|---|
| `full` (default) | 50 | Typical repos; best signal under the budget |
| `topN`           | 10 | Very large monorepos where latency matters more than tail-end ranking quality |

A hard **200ms wall-clock budget** wraps the structural pass. If the budget exceeds before all top-N files are parsed, parsing stops, remaining hits fall back to the regex `symbol_context`, and the response surfaces a `notice: string` field telling the model what happened and how to react (e.g. retry with `structural: "topN"` or narrow the query). The same `notice` field also surfaces when a **256KB response-size cap** truncates the result set - in that case the message tells the model to narrow its query or lower `limit`. Size-cap takes priority over structural-budget when both fire because size-cap means the model is missing results entirely. On the success path the field is omitted entirely - this is a "present iff actionable" field, not a "0 / null when fine" field.

Per-file results are cached by `(realpath, mtime)` so a repeated search over the same hit set doesn't re-parse files that already returned no structural signal.

### Cross-skeleton query expansion

Single-identifier queries in `ranked` and `literal` mode are auto-expanded across naming conventions before being handed to ripgrep: `getUserName` → `(getUserName|get_user_name|get-user-name|GetUserName|GET_USER_NAME)`. This fixes the live correctness bug where `rg getUserName` did not surface `get_user_name`. Expansion is skipped when:

- `mode === "regex"` - the user is being explicit about regex semantics; we do not silently rewrite.
- The query contains whitespace, dots, parens, or any other character that defeats skeleton-form derivation - falls through to current literal behavior.

## Design principle: ruthlessly minimal MCP tool surface

Every field in an MCP tool's **input** and **output** schema must be one of:

  (a) **Required to call the tool correctly** (e.g. `query`, `workspace` on the search tool - the tool cannot do its job without them).
  (b) **Tunable by the model in a way that improves outcomes** (e.g. `mode`, `structural`, `limit` - the model can reasonably decide "I need every hit, switch to literal" or "this is a large repo, drop to topN").
  (c) **Directly actionable feedback that helps the model self-correct on the next call** (e.g. `truncated: true` tells the model "raise `limit` or narrow the query"; `notice: "structural budget exceeded after 23/50 hits; retry with structural: \"topN\""` or `notice: "response size limit reached at 420 hits (~256KB); narrow your query or lower 'limit'"` tells it exactly what to do differently; a ripgrep regex-compile error surfaced as `isError: true` content tells it "your pattern is malformed").

### Worked example: `imagePaths` on the persona schema

The persona input schema is deliberately tiny — `prompt`, `context`, `effort` —
so a fourth field needs to earn its place against the three tests above.

`imagePaths?: string[]` passes **(b)**. Every persona's backing model reports
`vision: true`, and until this field existed there was no way to reach that
capability: the schema was string-only and `dispatchModelCall` built a single
text part, so a screenshot could only be described in prose. The field unlocks an
outcome — visual review of a UI, a chart, a diagram, a rendering bug — that is
otherwise unreachable, and the model decides per call whether it applies.

Two design points worth recording, because the obvious alternatives are worse:

- **Paths, not base64.** A base64 field would push megabytes across the MCP
  boundary and into the caller's context, which is the exact cost the
  browser-screenshot fix exists to remove, and it would trip the
  `predictedTooLong` pre-flight that sizes the brief before a slot is acquired.
  The proxy reads and encodes server-side; caller and proxy are the same host in
  this product.
- **No `imageDetail` / `imageCount` / echo fields.** Anything the caller already
  knows fails test (a) and (c). The per-model ceiling (10 images on the gemini
  lanes, 1 on the gpt and opus lanes) is stated in the field description rather
  than returned in the response, because the model needs it BEFORE the call, not
  after.

Failure feedback satisfies **(c)**: a rejected path names the position
(`imagePaths[1]`), what was wrong, and the fix — and identification is by magic
bytes, so "not a supported image" is a statement about the file's contents, not
its extension. One bad path fails the whole call rather than being skipped: a
reviewer that silently saw three of four attachments has misled the caller about
what it read.

If a proposed field fails all three tests, **cut it**. The model's context is finite and precious; echoing the model's own inputs back, exposing internal diagnostics for human eyeballs, and surfacing failures the model has no lever to fix all cost tokens for negative value. Negative value because every additional token in the tool response (i) reduces the budget left for the model's actual reasoning, and (ii) introduces noise the model has to filter through before reaching the actionable bits.

This rule applies to **all** MCP tools registered under `NON_PERSONA_MCP_TOOLS` (`code`, `web`, anything added later) and to the peer-critic persona tools (`codex_critic`, `codex_reviewer`, `gemini_critic`, `gemini_reviewer`, `opus_critic`).

### Worked example: `code`

The internal `CodeSearchResponse` type in `src/lib/code-search.ts` is rich on purpose - internal callers (tests, future in-process consumers) benefit from BM25F scores, per-field contributions, scanning stats, etc. The MCP handler in `src/lib/peer-mcp-personas.ts` trims aggressively before stringifying to `content[0].text`. The cuts, with the test each field failed:

| Field | Verdict | Why it failed |
|---|---|---|
| `ranking.algorithm: "BM25F"` | **cut** | The model cannot pick a ranking algorithm. Naming the algorithm is decorative. |
| `ranking.citation: "Robertson, Zaragoza, Taylor 2004"` | **cut** | Purely cosmetic - provenance for human readers. |
| `ranking.k1: 1.2` | **cut** | Internal tuning constant; not a knob the model is allowed to touch. |
| Per-hit `score: 0.7423` | **cut** | The model already sees ordering. Naming the score doesn't add a lever. |
| Per-hit `field_contributions: {match_line: 0.4, ...}` | **cut** | Diagnostic for ranker debugging. The model can't say "boost `match_line`." |
| Per-hit `match_byte_range: [12, 24]` | **cut** | Useful for highlighting in a UI; the model already has `snippet` for content and `line` for navigation. |
| `scanned_files: 412` | **cut** | Telemetry - belongs in the proxy log, not in the model's context. |
| `elapsed_ms: 34` | **cut** | Same - telemetry. |
| `truncated: true` | **kept** | Actionable: model can raise `limit` or narrow `query`. |
| `pruned_below_shoulder: 7` | **cut** | Initially kept on the theory that "the long tail was cut" helps the model. In practice the field is diagnostic - the model can't reasonably act on a numeric pruning count, and `0` on the success path violates the "absent iff non-actionable" principle. Pruning still happens internally; the count just doesn't surface. |
| `notice: "structural budget exceeded..."` or `notice: "response size limit reached..."` | **kept** (when present) | The textbook good field. Present **iff** actionable; absent (not `null`, not `""`) on the happy path so the model spends zero tokens noticing nothing went wrong. Two failure modes share one field because both are actionable strings the model just reads - splitting them into separate fields would mean more schema for no leverage. |
| `source` | **kept** | A 3-valued top-level field (`"semantic"`, `"lexical"`, `"lexical-fallback"`) that indicates which engine actually ran. |
| Per-hit `file`, `line`, `snippet` | **kept** | The actual payload. The model uses `file` and `line` to navigate, `snippet` to decide if the hit is relevant. |
| Per-hit `score` | **kept** (semantic only) | ColBERT relevance score. Kept because it is interpretable, unlike BM25F scores which are omitted for lexical hits. |

### Adding a new MCP tool

For each proposed input or output field, answer in one sentence: **"What would the model do with this?"** If the answer is "nothing" or "look at it for context but not act on it," cut it. Default to absent - adding back later is cheap; pulling out a field clients have already learned to expect is breaking.

## Worker tools (`explore`, `review`, `plan`, `implement`, `test`, `browse`)

The six mode tools `mcp__workers__explore`, `mcp__workers__review`, `mcp__workers__plan`, `mcp__workers__implement`, `mcp__workers__test`, and `mcp__workers__browse` delegate scoped work to an **autonomous worker subagent** backed by the **Pi agent runtime** (vendored at `src/vendor/pi/`); the seventh tool, `mcp__workers__worker_defaults`, inspects or changes their in-memory defaults. **Per-mode built-in defaults:** read-only `explore` → `gpt-5.6-luna` at `high`; read-only `review` → `gemini-3.1-pro-preview` at `xhigh` (clamped to `high` at call time because Gemini does not advertise xhigh); read-only `plan` → `claude-opus-5` at `high`; read+write `implement`/`test` → `gpt-5.6-sol` at `high`; browser-control `browse` → `gpt-5.6-luna` at `high`. Luna's full effort ladder makes explore's `high` a real choice rather than a clamp. The `high` plan/implement/test defaults favour time-to-outcome; a caller can restore a higher tier because thinking resolution is **per-call `thinking` > `worker_defaults` session override > built-in**. The worker plans its own tool calls, decides when it's done, and returns a single text answer (plus a unified diff for an implementation/test run that changed files). Implementation: `src/lib/worker-agent/engine.ts` (`runWorkerAgent`, which holds the `DEFAULT_MODEL_CHAIN`/`IMPLEMENT_DEFAULT_MODEL`/`BROWSE_DEFAULT_MODEL` constants) and `src/lib/worker-agent/tools.ts` (the worker-side `AgentTool` definitions).

These tools are exposed under the `workers` MCP server at `/mcp/workers` (or the `/mcp` union path).

### Tool surface

| Tool | Mode | Built-in model / thinking | Tools the worker can call | Worktree behavior | Description |
| --- | --- | --- | --- | --- | --- |
| `explore` | read-only | `gpt-5.6-luna` / `high` | `read`, `glob`, `grep`, `code_search`, `web_search`, `fetch_url`, `toolbelt`, `advisor`, `update_plan` (9) | n/a | Read-only investigation - the worker plans its own searches/reads and returns a single text answer. |
| `review` | read-only | `gemini-3.1-pro-preview` / `xhigh` (clamps to `high`) | same 9 read-only tools as `explore` | n/a | Same surface as `explore` with a reviewer ROLE frame (verify correctness, report findings with severity + `file:line`). |
| `plan` | read-only | `claude-opus-5` / `high` | same 9 read-only tools as `explore` | n/a | Read-only implementation planning with a planner ROLE frame; returns an ordered plan without editing files. |
| `implement` | read+write | `gpt-5.6-sol` / `high` | explore tools + `edit`, `write`, `bash`, `codex_review` (13) | `worktree` (retained, IGNORED — always `true`) | Scoped coding task; ALWAYS runs in a fresh git worktree and returns the diff via a saved `.patch` file (`--stat` + preview + path; small diffs inline). HARD ERROR if not a git repo. For in-place edits use the `implementer` subagent. |
| `test` | read+write | `gpt-5.6-sol` / `high` | same 13 tools as `implement` | `worktree` (retained, IGNORED — always `true`) | Independent adversarial test authoring in a fresh worktree; may change tests but not production code to make them pass. |
| `browse` | browser-control | `gpt-5.6-luna` / `high` | browser tools + terminal `submit_answer` / `report_insufficient` | n/a | Drives a real browser in a sandbox and returns the requested result or a specific blocker/insufficiency report. |

Workers stay strictly TERMINAL (no recursive sub-worker spawning is allowed). Implement mode is no longer forced agent-wide sequential; pure read/search batches (incl. `toolbelt`, which runs read-only CLIs with `shell:false` and carries no `executionMode`) run in parallel, while `edit`, `write`, `bash`, `codex_review`, and `update_plan` execute sequentially via per-tool `executionMode`.

Context management derives compaction, per-result capping, and the request-boundary overflow estimate from one per-run `ContextBudget`. A missing or invalid catalog context window uses a conservative 128k fallback so compaction and result capping never silently disengage. Because that fallback is only a guess, exceeding its request limit emits a diagnostic and proceeds; upstream remains authoritative. A known catalog window retains the hard local abort with an actionable message.

The `model` arg is a free-string Copilot catalog model id, not an enum; any selected model must advertise `tool_calls`. Defaults are per-mode: explore `gpt-5.6-luna` at `high`; review `gemini-3.1-pro-preview` at `xhigh`, which clamps to `high` at call time because Gemini does not advertise xhigh; plan `claude-opus-5` at `high`; implement/test `gpt-5.6-sol` at `high`; and browse `gpt-5.6-luna` at `high`. The general worker gate and unmatched-mode fallback use the ordered `DEFAULT_MODEL_CHAIN` (`gpt-5.6-luna` → `gpt-5.4-mini`): Luna wins where the live catalog grants access, while mini keeps individual-trial and education catalogs working. `browseAgentEnabled()` still separately gates the browse tool on Luna's catalog presence and a reachable endpoint; the engine validates every selected model at call time. The `worker_defaults` tool can set process-global, in-memory model/thinking overrides independently for all six modes; thinking precedence is **per-call `thinking` > session override > built-in**. The `high` plan/implement/test built-ins favour time-to-outcome, while either override layer can restore a higher tier. Workflow producer runs opt out of session overrides because verified cross-lab isolation must not be defeatable by mutable process-global settings. Gate discovery is advisory rather than a producer/checker and intentionally honors the explore session override. For `explore`, `implement`, and `review`, the recommended 1M override ladder is `gpt-5.6-sol` for heavy/deep work, `gpt-5.6-terra` for moderate work, and `gpt-5.6-luna` for light/cheap work, paired with `thinking: "high"`. `thinking` accepts `off|minimal|low|medium|high|xhigh` and is silently clamped to the resolved model's allowlist.

A zero-argument `worker_defaults` inspection additionally returns `catalog`: worker-usable models (tool calls, a requestable effort, and >=200k context) as `{id, vendor, ctx, maxOut?, efforts, in?, out?, tps?}` from `buildCatalogView()`. `in` and `out` are the live catalog's batch-sized `billing.token_prices`, normalized to per-1M-token relative units and omitted when absent or malformed. `tps` is an approximate, indicative output-tokens/sec hint present only for a small dated measurement table; it is not a per-call benchmark. The view does not expose quality, intelligence, or benchmark scores: those editorial characterizations decay silently and can misroute a caller. The one speed exception is labelled and recoverable because a caller can retry a slow selection. The catalog rides only on inspection, not mutations, so its bytes are paid only by the caller that requests discovery.

All six mode tools accept a `workspace` (absolute path) - the working directory the worker operates in. Resolution is **explicit argument > the per-connection `X-GH-Workspace` session header > refuse**. There is deliberately no launch-cwd default any more: the proxy is a long-lived process started once, from wherever the operator happened to be, while the agent calling the tool is not pinned there - a Claude Code session can move into a git worktree, and a sub-agent can be launched already inside one. Falling back to `process.cwd()` therefore ran workers against a tree that did not contain the files they were asked to work on, silently, and the model had no way to tell. A call carrying neither an argument nor a header now returns an actionable `isError` naming what to pass; operators running a raw MCP client that can send neither restore the old behaviour with `GH_ROUTER_ALLOW_PROXY_CWD_WORKSPACE=1`. That opt-out is **non-serve only**: a `serve` is one machine-wide daemon fronting many projects, so its launch cwd belongs to no client in particular, and honouring the hatch there would run a worker against an unrelated repository rather than restore a useful default. The `state.serveMode` refusal therefore outranks it, and the serve message does not offer it. Whenever the workspace was NOT chosen by the caller (header-derived, or the opted-in launch-cwd fallback), the result is prefixed with a `[workspace: <path> (<source>)]` note, so a wrong-tree run is visible rather than silent - the header is a per-CONNECTION value that tracks the session and cannot distinguish one sub-agent from another. `applySessionWorkspace` (in `src/routes/mcp/handler.ts`) returns that provenance precisely because it merges the header into `args.workspace`, after which the two sources are otherwise indistinguishable. The value is absolute-only - relative paths are rejected at the MCP boundary with an actionable error so a typo doesn't silently resolve against `process.cwd()` and land somewhere surprising. For `implement`/`test`, the workspace must be inside a git repository (the engine's `createWorktree` hard-errors otherwise). The `worker-*` dispatcher subagents - the only sanctioned callers, per the PreToolUse guard - are instructed to ALWAYS pass their own working directory, so the sanctioned path never depends on the header being fresh. Threat model matches code search: the proxy already runs as the user; no allowlist (the same operator could `Read` / `Bash` the same paths through Claude Code directly). The same reasoning roots persona `imagePaths` confinement at the session workspace when the connection supplies one. See `runWorkerToolCall` in `src/lib/peer-mcp-personas.ts` for the validation.

Worktree isolation is mandatory for `implement`/`test` and **opt-in for `review`** (`worktree: true`; default is in place). The engine and `buildWorkerTools` always supported an isolated review - it is what unlocks `edit`/`write` so a reviewer can author a throwaway probe test - but no caller ever set the flag, so the path was unreachable while the `worker-review` description advertised it. It stays opt-in rather than forced because `createWorktree` replays tracked-dirty and untracked-not-ignored files only: IGNORED build inputs (`node_modules`, `target/`, `.venv`) are not carried over, so an isolated reviewer frequently cannot run the very build or suite that makes a review a verification. Note that `review` holds `bash` in BOTH modes, so it is not a read-only worker and is not described as one.

### Catalog and opt-out gates

`workerToolsEnabled()` drops the five filesystem/repository worker modes (`explore`, `review`, `plan`, `implement`, `test`) plus `worker_defaults` from `tools/list` AND `tools/call` when EITHER:

1. The operator set `GH_ROUTER_DISABLE_WORKER_TOOLS=1`, OR
2. no member of `DEFAULT_MODEL_CHAIN` (`gpt-5.6-luna` → `gpt-5.4-mini`) is present in the live Copilot catalog with `tool_calls` support.

The chain is deliberately tier-adaptive. Luna is the cheaper, faster, larger-context preferred entry, but it is not offered on `individual_trial` or `edu`; mini remains available there. The live catalog is the entitlement signal. `billing.restricted_to` states what a model permits, not which tier the user has, so the resolver does not infer user entitlement from it. The browse worker has an additional, independent `browseAgentEnabled()` gate: the browser surface must be enabled and supported on disk, and `gpt-5.6-luna` must be present in the live catalog with a reachable chat or Responses endpoint. The browser's inner compound-tool **compressor is a different component**: its `COMPRESSOR_FALLBACK_CHAIN` still starts with `gpt-5.4-mini`; this change does not retune that resolver.

These checks are defense-in-depth - a client that hard-codes a tool name still fails at call-time rather than seeing a useless dormant registration. The general gate/fallback chain lives at `src/lib/worker-agent/engine.ts:DEFAULT_MODEL_CHAIN` and is re-imported by `mcp-capabilities.ts`, so there is no parallel constant to drift. Per-mode defaults are deliberately NOT general gate inputs: if `explore`'s Luna or `implement`/`test`'s `gpt-5.6-sol` is absent, that mode errors helpfully at call time without disabling the rest of the worker surface. Browse remains independently gated on Luna because it cannot fall back to mini.

### Non-blocking dispatch (`worker-*` subagents + PreToolUse guard)

A raw worker MCP call blocks the caller for up to the 6h wall-clock, and an MCP server cannot push a completion into Claude's conversation. So `github-router claude` makes the workers non-blocking on the MAIN thread by routing them through background **`worker-*` dispatcher subagents** (`worker-explore`/`implement`/`review`/`plan`/`test`, + `worker-browse` when the browse agent is enabled). Each is a per-launch `.md` subagent (generated in `buildPeerAgentDefinitions`, `src/lib/codex-mcp-config.ts`) that calls its one worker tool and relays the result; the lead invokes it via `Agent(subagent_type: "worker-<mode>")`, which returns immediately and delivers the worker's result as a completion notification. Each dispatcher is pinned by a `tools: [mcp__<workersKey>__*]` allowlist (the workers server wildcard — Claude Code `tools:` supports MCP at server granularity), so it has no `Agent`/`Bash`/`Read`: it cannot spawn further agents or do extra work.

The **PreToolUse guard** (`internal-worker-guard`, decision in `src/lib/worker-dispatch.ts:decideWorkerGuard`) enforces this: it DENIES a raw `mcp__<workersKey>__<mode>` call unless the payload's `agent_type` is exactly the matching `worker-<mode>` dispatcher, redirecting the main agent (and any non-dispatcher subagent — closing the transitive-blocking hole) to that dispatcher. It fails CLOSED on malformed input and is scoped by an exact-regex matcher (`guardToolMatcher`) so unrelated tools never invoke it. Registered per-launch into the mirrored `settings.json` (`src/claude.ts`), **only when subagent-visible MCP injection succeeded** (`injected.ok`) — otherwise `worker-*` dispatchers could not reach the workers server, so the guard is skipped and raw (blocking) workers stay usable rather than deadlocking.

Claude's own tools and every other MCP group are untouched; only the raw workers *invocation path* is guarded. The raw tool `description`s point at the matching `worker-*` agent so the model reaches for it first.

**Hybrid opt-out** — `GH_ROUTER_DISABLE_WORKER_GUARD=1` keeps the non-blocking guarantee ON by default but skips the guard registration, restoring the raw `mcp__workers__*` escape hatch on the main thread (for guaranteed structured-arg fidelity, or when a blocking call is acceptable). The `worker-*` agents remain the steered, non-blocking default, so the two surfaces complement rather than replace each other. `/gh-worker` documents the model to the agent.


### Budget caps (turns / wallclock / tool-bytes - NOT tokens or cost)

Every worker run gets a `Budget` (`src/lib/worker-agent/budget.ts`) wired through Pi's `beforeToolCall` (cap check, blocks the call with a clear reason) and `prepareNextTurn` (turn counter) hooks. The table below records the worker limits and related request bounds; all are env-overridable:

| Cap | Default | Env override | Where it fires |
| --- | --- | --- | --- |
| Max turns | 500 | `GH_ROUTER_WORKER_MAX_TURNS` | `beforeToolCall` → `block: true, reason: "[halted: turns]"` |
| Model call | 15 minutes | `GH_ROUTER_WORKER_MODEL_CALL_TIMEOUT_MS` | Whole `streamFunction` invocation: fetch plus SSE consumption; exactly one retry only when no model output was emitted |
| Max wall-clock | 6 hours (per-call `maxWallClockMs` override, clamped to `workerWallClockCeilingMs()` = the injected MCP tool-call timeout − 15 min headroom) | `GH_ROUTER_WORKER_MAX_WALLCLOCK_MS` | `beforeToolCall` + a `setTimeout(agent.abort)` belt-and-suspenders that tears down mid-bash |
| Max cumulative tool-output bytes | 16 MiB | `GH_ROUTER_WORKER_MAX_TOOL_BYTES` | `afterToolCall` records, `beforeToolCall` blocks |
| Max tool calls | 250 | `GH_ROUTER_WORKER_MAX_TOOL_CALLS` | `beforeToolCall` blocks after the run reaches the cap |
| Max consecutive identical tool calls | 3 | `GH_ROUTER_WORKER_MAX_REPEATED_CALLS` | Blocks the repeated call without halting the run |
| Clean empty-output nudges | 3 | `GH_ROUTER_WORKER_MAX_NUDGES` | Adds a follow-up user turn in the same run only after a clean stop with no usable text/tool call; `0` disables |
| Advisor transcript chars | 720 000 | `GH_ROUTER_WORKER_ADVISOR_MAX_CHARS` | `advisor` tool truncation (matches `ADVISOR_MAX_CONVERSATION_CHARS` in `src/services/advisor/advisor.ts`) |

**No token/cost accounting.** Counting tokens would require duplicating Anthropic/Copilot's tokenizer choices per model; the caps above are model-agnostic proxies that hit the same SRE concern (runaway loops, runaway resource use) without that complexity.

### File-size caps (read/write/ripgrep stdout)

All three are 10 MiB, matching `MAX_STDOUT_BYTES` in `src/lib/code-search.ts:106` so worker file IO and the `code_search` MCP tool share the same upstream-output bound. Worker `read` rejects files >10 MiB with a clean throw; `write` and `edit` reject results >10 MiB; `bash`'s ripgrep wrapper kills the child on >10 MiB stdout and resolves with truncated text + a flag. These are constants in `src/lib/worker-agent/tools.ts` (`READ_MAX_BYTES`, `WRITE_MAX_BYTES`, `RG_STDOUT_CAP`).

### Worktree mode (MANDATORY for implement/test; per-call auto-clean + crash-safe sweep)

`implement` and `test` ALWAYS run in a fresh git worktree — isolation is not caller-tunable. The `worktree` arg is retained in the schema for compatibility but ignored (forced `true`; a `worktree:false` is overridden with a note), so `runWorkerToolCall` always threads `worktree:true` into the engine; for in-place edits the native `implementer` subagent is the right tool. (The engine still honors the `worktree` param for its INTERNAL callers — the orchestration kernel manages its own per-producer worktrees and calls `runWorkerAgent` directly, bypassing the MCP boundary.) The engine provisions a fresh git worktree under `<repo>/.git/worktrees/worker-<pid>-<uuid>-<rand>` on a new branch, runs the worker isolated, and in `finalize()` (after `git add -N .` so untracked files appear) returns the diff **via a saved patch file**: the FULL `git diff --binary --full-index HEAD` patch is written to `PATHS.WORKER_DIFFS_DIR/<pid>-<8hex>.patch` and the inline return is a `git diff --stat` summary + a bounded UTF-8-safe preview (first `PREVIEW_CAP` = 8 KiB) + the patch path — the full diff never rides the 25k-token result relay. A small diff (`<= PREVIEW_CAP`) is inlined in full with no file. No-git is a HARD ERROR pointing at `implementer`. The worktree is removed in the per-call `finally`. Three layers of safety net against orphans:

1. **Per-call `finally`** - happy path, fires on success AND mid-loop throws.
2. **Session-end signal sweep** - `registerExitHandlers` in `src/lib/worker-agent/lifecycle.ts` installs SIGINT/SIGTERM/exit handlers that walk the per-process registry and `git worktree remove --force` everything. SIGINT/SIGTERM handlers re-raise (`process.kill(pid, sig)` after removing themselves) so the conventional `128 + signum` exit code is preserved.
3. **Boot-time sweep** - every proxy launch reads `.claude/worker-repos.json` (the per-proxy ledger of repos this proxy has ever touched), walks `git worktree list` for each, and removes entries whose name matches `worker-<PID>-...` AND whose PID is no longer alive AND whose instance UUID doesn't match this proxy's. The digit-PID prefix + UUID match is critical - a regex relaxation would risk deleting user-authored worktrees with similar names. Quota: 20 entries per repo; oldest LRU evicted.

### MCP in-flight cap participation

The worker's `advisor` and `codex_review` tools (which dispatch to the advisor responses endpoint / peer-model personas from inside the worker's Pi loop) acquire the **same** `MAX_INFLIGHT_TOOLS_CALL` slot as MCP-boundary persona calls (default 128, overridable with `GH_ROUTER_MAX_INFLIGHT_TOOLS_CALL`). (`peer_review` shares the same mechanism but is not wired into the worker surface.) Implementation: `src/lib/mcp-inflight.ts` exports `acquireInFlightSlot()`; both `src/routes/mcp/handler.ts` (for `tools/call` dispatch) and `src/lib/worker-agent/tools.ts` (for nested advisor/codex_review) acquire from it. Without this shared counter, a single worker could fan out unboundedly to peers and starve the operator's own MCP traffic; with it, nested calls return a clean `Peer MCP queue full` tool error and the worker model can back off.

### Bash hardening

Worker `bash` runs through `src/lib/worker-agent/bash.ts` with:

- **Strict env allowlist** (NOT denylist) - only `PATH`, `HOME`/`USERPROFILE`, locale (`LANG`/`LC_ALL`/`TZ`), temp dirs (`TMPDIR`/`TEMP`/`TMP`), and Windows essentials (`SystemRoot`, `ComSpec`, `PATHEXT`, `USERNAME`, `APPDATA`, `LOCALAPPDATA`, `windir`, `SystemDrive`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramData`) survive. **All `GH_ROUTER_*`, `GITHUB_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `COPILOT_TOKEN`** are dropped. Adding a key requires it to be (a) genuinely required for typical shell invocations AND (b) unable to carry the user's credentials.
- **POSIX `bash -c`** (not `-lc`) - skips `.profile`/`.bashrc` so the operator's shell aliases can't redefine `rm`, `git`, etc. under the worker's feet.
- **Windows `taskkill /T /F`** for descendant teardown; POSIX uses negative-PID process group kill. 2-second SIGTERM→SIGKILL grace on POSIX.
- **Per-stream 1 MiB output cap** + per-call configurable timeout.
- **Opt-in network deny** via `GH_ROUTER_WORKER_DISABLE_NETWORK=1` - a caller-side regex on the raw `cmd` string rejects obvious egress commands (`curl`, `wget`, `nc`, `npm install`, etc.) BEFORE `spawn`.

### Path-containment denylist (read/glob/grep/code_search)

The worker's read-only file tools refuse paths matching `.env*`, `*.pem`, `id_rsa*`, `id_ed25519*`, anything under `.git/` (interior, not the worktree root), `.ssh/`, `.gnupg/`, `.npmrc`, `.netrc`. The intent is "don't make it trivial for a confused worker to exfiltrate the operator's secrets via tool-result text"; the threat model is honest about not being defense against a determined caller (the same operator could run `implement` with `bash` and `cat` the file directly).

**The `toolbelt` tool is NOT covered by this path denylist** (its CLIs - `rg`/`fd`/`git show`/… - take patterns/refs/globs, not just file paths, so an arg-level denylist would be both leaky and easy to bypass). This is deliberate and consistent with the project-wide threat model: the worker is spawned by a Claude Code session that already has `Read`/`Bash`/`Edit` reaching the same paths, so a read-only CLI runner is not a new exfiltration surface relative to its parent. The denylist on the internal `read`/`grep`/`glob`/`code_search` tools is a low-effort "confused worker" guard, not a security boundary; `toolbelt` does not claim to extend it.

**`toolbelt` read-only enforcement** (`src/lib/worker-agent/tools.ts`): every CLI runs through `runManagedExeCapture` with `shell:false` (args are literal — no pipes / redirects / chaining / glob expansion), and the model-chosen `tool` is re-checked against the allowlist set (defense-in-depth on top of the schema enum). Per-tool the exec / file-write flags are rejected with a cluster-aware matcher so attached / combined short forms (`fd -Hx`, `sg -iU`) can't slip past an exact-token check: `fd -x/--exec`/`-X`, `rg --pre`/`--hostname-bin`, `sg --rewrite`/`-U`/`-i`, `yq -i`/`-s`, `scc -o`/`--output`/`--format-multi`. `sg`'s file-writing / server subcommands (`new`, `lsp`) are blocked positionally. `git` is locked to a read-only subcommand allowlist (`grep` and `reflog` are excluded — they hide exec / mutate modes), runs with forced `--no-pager --no-optional-locks` (so `status` can't write the index) and `--no-ext-diff --no-textconv` on diff-producing subcommands, and a write/exec flag denylist (`--output`, `--ext-diff`, `--textconv`, `--filters`, `--open-files-in-pager`) that also catches git's unambiguous long-option abbreviations (`--ext-d` ⇒ `--ext-diff`). **Accepted residual** (documented, within threat model): working-tree git subcommands (`status`, bare `diff`, `blame`) still apply configured clean/textconv filters to files an attacker-controlled `.gitattributes` maps to a driver — but that only runs filter commands the USER already configured (e.g. global git-lfs); the tree cannot introduce a NEW command (that needs a local `.git/config` write = full compromise), so no attacker-CHOSEN program executes. This is identical to what the user's own `git status` would run and is not a new capability over the parent session's `Bash`.

### Vendored Pi runtime

The Pi agent runtime (`@earendil-works/pi-agent-core` + a minimal `pi-ai` slice) is **vendored** at `src/vendor/pi/` rather than depended on via `package.json`. The vendor sync protocol - how to refresh the snapshot, what to keep in sync, and what to deliberately diverge on - is documented in [`pi-vendor-sync.md`](pi-vendor-sync.md). MIT attribution is preserved verbatim in `src/vendor/pi/LICENSE` and via comment headers on every vendored file.

### Compatibility probes (worker model + body-shape contracts)

Two probes assert that Copilot accepts the exact body shapes the worker-agent stream-fn emits:

- `worker_gemini_tools_reasoning` — `gemini-3.5-flash` on `/v1/chat/completions` with a `tools[]` array + `reasoning_effort:"high"` (a valid explicit-override and review-fallback tool+reasoning shape; explore now defaults to `gpt-5.6-luna`). The gate's catalog arm only checks "chain member present + `tool_calls` advertised"; it does NOT exercise every selectable request shape. If Copilot tightens the Gemini validator, explicit Gemini worker calls would 400 — this probe surfaces that regression upstream.
- `worker_gpt5_responses_tools_reasoning` — `gpt-5.5` on `/v1/responses` with function-shaped `tools[]` (flat `{type:"function",name,description,parameters}`) + `reasoning:{effort:"xhigh"}` (the retained-fallback `/responses` contract — `gpt-5.5` is the fallback for the codex CLI and the native implementer subagent; the primary `implement`/`test` worker default `gpt-5.6-sol` is probed by `worker_gpt56sol_responses_tools_reasoning`). `gpt-5.5` is NOT a dual-gate input, so a body-shape regression here breaks the OpenAI fallback path while explore/review keep working — only this probe catches it.

Probe ids in `scripts/probe-copilot-compat.sh`; matrix rows in `docs/copilot-compat-matrix.md` (see also [`docs/pi-vendor-sync.md`](pi-vendor-sync.md)).

## `stand_in` tool (away-mode advisor)

`stand_in` is a server-side, code-driven consensus advisor for **decision tiebreak when the user is unavailable**. Polls all three frontier peers - gpt-5.6-sol xhigh (OpenAI, with gpt-5.5 fallback), claude-opus-5 xhigh (Anthropic), gemini-3.1-pro-preview high (Google) - across two structured voting rounds and returns a ranked-choice verdict with per-model reasoning. Implementation lives at `src/lib/stand-in.ts`; the MCP tool entry and gate are in `src/lib/peer-mcp-personas.ts` / `src/routes/mcp/handler.ts` (`standInToolEnabled`).

### Scope: advisor, not decider

The tool *recommends*; the main agent still decides and executes. Dangerous actions (push, delete, drop, deploy) remain gated by the user-confirmation discipline in CLAUDE.md "Executing actions with care" - three-lab consensus does NOT unlock them. This is a deliberate scope choice: it captures the velocity win for judgment-stuck decisions while keeping the blast radius small.

### Protocol: blind R1 → informed R2 → abstain

Three reasons this specific shape is load-bearing:

1. **Blind round 1** - each model gets the decision + options + context with no peer input. Frontier models capitulate to each other under deliberation (sycophancy); the blind round is the anti-anchor mechanism.
2. **Informed round 2** - each model sees the other two models' R1 votes and reasoning, then votes again. They may keep or change their R1 vote. The system prompt explicitly forbids changing-just-to-agree.
3. **Abstain on disagreement** - if R2 doesn't produce a 2/3-or-better majority, the verdict is `no_consensus` and the main agent must defer to the user. The tool refuses to manufacture false agreement.

R1 short-circuits early in two cases: to `consensus` if all three models pick the same non-null option AND mean confidence ≥ 0.8; to `need_more_info` if **≥2 of 3** parsed R1 votes abstained citing a missing-context gap (at ≥2 gap-abstains no provided-option majority is reachable, so surfacing the specific gaps is strictly more actionable than running a doomed R2). Otherwise R2 runs. The same ≥2/3 gap-abstain → `need_more_info` check is applied **in both rounds** (a shared `gapAbstainVerdict` helper runs after R1 and again after R2, before the R2 tally) — so models that only switch to a context-gap abstention in the informed round still yield `need_more_info` rather than a bare `no_consensus`. A null-vote carries at most one escape channel: `need_more_info` takes precedence over `alternative` (a model lacking context can't reliably judge the options inadequate), enforced both in the prompt and by the parser (`alternative` survives only when `choice === null && !needMoreInfo`).

**Holistic alternative channel.** Each model may set `choice: null` and populate an `alternative` field to propose a concrete *unlisted* option — but only when a provided option is actively harmful or clearly dominated (the prompt hard-gates this so RLHF-helpful models don't dodge the tiebreak by inventing escape hatches). An `alternative` is null-equivalent in the tally: it never forms or suppresses a provided-option majority (`aggregateVotes` counts only non-null `choice`s). Any proposed alternatives are surfaced in `notes` on every verdict so the caller can re-invoke with a revised option set. This is deliberately distinct from `need_more_info` (missing context, not a better option).

**Hallucination guard.** `tryParseVote` validates each non-null `choice` against the caller's option ids; an unlisted id (a model inventing an option that wasn't offered) is treated as a malformed response — it fails the parse, so `callAndParse` retries once and a persistent bad id becomes a `VoteFailure` (excluded from the successful-vote set, never tallied). This both prevents a phantom-id majority and keeps the successful-vote accounting honest — a malformed vote is never miscounted as a deliberate abstention (which would inflate `successfulR1` and skew the `<2 → no_consensus` early-exit).

**Partial missing-context signals.** On any `no_consensus` verdict, individual `needMoreInfo` gaps from the freshest-round votes are aggregated into `notes` — so a 1-of-3 "I'm blocked on context" signal that falls below the ≥2/3 `need_more_info` threshold is still surfaced rather than buried.

### Verdicts

| Verdict           | Meaning                                                  | `recommendation` | Main agent action               |
| ----------------- | -------------------------------------------------------- | ---------------- | ------------------------------- |
| `consensus`       | 3/3 same option                                          | option.id        | Proceed with the recommendation |
| `majority`        | 2/3 same option (dissenter reasoning in `notes`)         | option.id        | Proceed, surface the dissent    |
| `no_consensus`    | 1/1/1 split, or insufficient successful votes            | `null`           | Defer to the user               |
| `need_more_info`  | ≥2 of 3 R1 votes flagged a specific missing-context gap  | `null`           | Gather context, call again      |

`isError` stays `false` for all four verdicts - `no_consensus` and `need_more_info` are valid protocol outcomes, not errors. `isError: true` is reserved for input-shape failures (bad arg types, missing required fields).

### Why code-driven, not model-driven

A small-model orchestrator (haiku / gemini-flash deciding when to escalate, when to call consensus, when to abstain) was considered and rejected. The abstain invariant and the blind-round anti-sycophancy property must hold **deterministically**, not "if the orchestrator model honors them." A model orchestrator is itself a model with RLHF priors and its own sycophancy pressure - it would be tempted to declare partial agreement to be helpful, or skip the abstain, or run extra rounds chasing convergence. For a tool that speaks for the user when they're absent, determinism and auditability are first-order requirements. The orchestrator is ~250 lines of TypeScript; that's the right complexity for a state machine.

### Input / output surface (ruthlessly minimal)

**Input** (`{decision, options[], context}`):
- `decision: string` - one-sentence framing of the choice.
- `options: Array<{id, summary, detail?}>` - 2-6 concrete options; caller-provided (NOT model-generated). The verdict cites the chosen option by `id`.
- `context: string` - **required**. The panel is cold-start (no repo, transcript, or memory), so context must carry every constraint, relevant code excerpt, prior decision not to relitigate, and success criterion the models need to judge. A missing/empty context is rejected at the tool boundary with `isError: true` (input-shape failure).

**Output** (JSON-stringified into a single MCP text block):
```typescript
{
  verdict: "consensus" | "majority" | "no_consensus" | "need_more_info",
  recommendation: string | null,
  confidence: number,
  votes: Record<ModelKey, { round1: Vote | VoteFailure, round2: Vote | VoteFailure | null }>,
  notes?: string
}
```

Every field is either (a) required for the caller to act, (b) directly actionable (per-model vote reasoning = "here's why, here's what to look for next"), or (c) the load-bearing verdict signal. No echoed inputs, no diagnostic-only fields, no per-vote latency, no token counts. `notes` additionally carries any panel-proposed unlisted `alternative`s (on every verdict) and, on `no_consensus`, any partial missing-context gaps. Per-model effort is **fixed** (not caller-tunable) - exposing knobs would invite callers to cheap out and muddy the consensus signal.

### Distinction from sibling tools

- vs `peer-review-coordinator` - coordinator is parallel **fan-out + aggregation** for code review (each peer reviews independently, coordinator deduplicates findings). `stand_in` is structured **voting with deliberation** for picking between concrete options. Don't conflate.
- vs `advisor` - advisor is "review my approach before I commit" (single model, auto-receives conversation, free-form review). `stand_in` is "tiebreak between options" (three models, structured caller input, ranked verdict).
- vs `codex_critic` / `gemini_critic` / `opus_critic` directly - those are single-model second opinions on artifacts. `stand_in` is the multi-model voting protocol layered on top of them.

The auto-invocation description on the `stand_in` tool entry is deliberately narrow ("when the user is unavailable and you are stuck between two or more concrete options"). Routine review, open-ended exploration, single-model second opinions, and irreversible-action confirmation all explicitly route elsewhere - don't relax the "Do NOT use for" clauses without checking the auto-routing impact.

### Catalog gating (`capability: "stand_in"`)

The MCP handler drops `stand_in` from `tools/list` AND fails-fast on `tools/call` with -32601 when any of the three required models is missing from Copilot's live catalog (`standInToolEnabled` in `src/routes/mcp/handler.ts`). The Anthropic-slot check requires `claude-opus-5`, whose single-segment slug exactly matches the catalog id. The gemini check shares the same regex as `geminiAvailable()` so a GA slug rename (`gemini-3.1-pro-preview` → `gemini-3.1-pro`) auto-resolves through both gates.

### Slot accounting & pre-flight cap

- **One slot per `stand_in` invocation**, NOT one per internal model call. The MCP boundary in `handleToolsCall` acquires the slot; `dispatchModelCall` (the shared per-endpoint wire helper extracted from `callPersona`) does NOT re-acquire. A single `stand_in` call making 6 internal upstream fetches (3 models × 2 rounds) consumes exactly 1 slot from the cap=32 budget. Regression test: `tests/routes-mcp.test.ts` "stand_in holds exactly ONE in-flight slot…".
- **`predictedTooLong` cap = 32KB** on `decision + options + context` byte-size, JSON-path only (raised from 6KB now that `context` is required and sufficiency-oriented — a real, code-bearing brief must fit). Fires BEFORE `acquireInFlightSlot` per the load-bearing invariant. Rationale: `stand_in` runs two sequential rounds across three frontier models, typical wall-clock 2-3 minutes; on the JSON path this always busts the 60s tools/call ceiling on non-trivial inputs. The cap surfaces "use SSE" as a fast actionable error instead of leaking a slot for the duration.

### Future: idle-trigger auto-invocation (out of scope for this PR)

A planned Phase B would add a Claude Code `Stop` / `UserPromptSubmit` hook layer that auto-invokes `stand_in` when the assistant has called `AskUserQuestion` and the user hasn't replied within ~3 minutes (configurable via `GH_ROUTER_STAND_IN_IDLE_MS`). The watcher would inject the consensus verdict via `claude --resume <sessionId> --print "[stand-in:<verdict>] ..."` on the `consensus` / `majority` paths and stay silent (preserving the abstain → wait-for-user invariant) on `no_consensus` / `need_more_info`. Default would be opt-out (on by default, disable with `GH_ROUTER_STAND_IN_AUTO=0`). Deferred until the model-invoked path proves consensus quality is good enough to merit the hook complexity (cross-platform detached-spawn, `claude --resume` injection validation, race-on-cancellation safety).

