# Peer-Model MCP Architecture & Phased Migration Plan

## Goal

Expose three peer models — `gpt-5.5` (codex_critic), `gpt-5.3-codex` (codex_reviewer), `gemini-3.1-pro-preview` (gemini_critic) — as cross-lab adversarial reviewers inside Claude Code, used per their strengths to improve quality and reduce blindspots/hallucinations. Capability injection must be auto-injected on `github-router claude` startup with no per-session user action. Reasoning effort must be configurable via the MCP tool args, defaulting to `high` (with `xhigh` available for explicit deep dives).

## Current Architecture (as of commit `d844623`)

The proxy at `src/routes/mcp/` already exposes three peer-MCP tools at `/mcp` on a loopback port:

- `mcp__gh-router-peers__codex_critic` (gpt-5.5) — adversarial design review
- `mcp__gh-router-peers__codex_reviewer` (gpt-5.3-codex) — line-level code review
- `mcp__gh-router-peers__gemini_critic` (gemini-3.1-pro-preview) — long-context cross-lab triangulation

Auto-injection: `github-router claude` writes per-launch `--mcp-config` + `--agents` JSON tempfiles into `~/.local/share/github-router/runtime/peer-{mcp,agents}-<pid>-<rand>.json` (mode 0o600, O_EXCL, symlink-refusing, boot-time orphan sweep on PID liveness). Auth: per-launch random 32-byte nonce as Bearer token + Host header check (loopback only).

## The Problem

Claude Code v2.1.113+ introduced a regression — open issue [#50289](https://github.com/anthropics/claude-code/issues/50289) labeled `bug`, `regression`, `has repro`. The `.mcp.json` per-server `timeout` field is silently dropped for HTTP transport; a hardcoded ceiling (60s SDK default; field reports of ~5min on v2.1.138 are inconsistent) cancels long peer-model calls before the reasoning model produces its first token. Adversarial reviews of substantial diffs at high reasoning effort routinely take 5-30 minutes and fail every time.

The MCP-SDK constants `DEFAULT_TOOL_CALL_TIMEOUT_MS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, and `resetTimeoutOnProgress` are present in the v2.1.138 binary's symbol table, but field reports disagree on whether `MCP_TIMEOUT` actually extends the per-tool-call HTTP wait. Heartbeat `notifications/progress` reach the wire but **don't reset the client timer** in current builds.

For full investigation, see [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md).

## Phased Plan (cheapest experiment first)

### Phase 1 — Try `MCP_TIMEOUT=600000` env var (5 minutes; ship if works)

Inject `MCP_TIMEOUT=600000` into the spawned `claude` child's environment via `getClaudeCodeEnvVars` in `src/lib/server-setup.ts`. Empirical 5-minute test on v2.1.138 resolves the field-reports disagreement.

**Verification:**
1. `bun run build && kill <proxy-pid> && node dist/main.js claude`
2. Fire a long peer-review call that previously hit the timeout (e.g., a multi-page brief with ~50KB context)
3. Watch for: (a) call completes within 10 min, (b) no `Could not deliver error event` warns in `error.log`, (c) no client-side `tool call timeout` errors

**If Phase 1 succeeds:** ship and stop. Document the env var setting. The architectural debate is moot.

**If Phase 1 fails:** proceed to Phase 2. Note the negative result on issue #50289.

### Phase 2 — Tool-description engineering for auto-decomposition + auto-invocation triggers + effort plumbing (~1 hour)

No new code debt — pure prompt and tool-description work, plus a one-line cap raise.

#### Track 2A — Auto-invocation prompts (the "use peers proactively" lever)

Currently the persona tool descriptions say *what* the persona is. They need to say *when* to call. Three layered mechanisms, weakest to strongest:

1. **MCP tool descriptions** (passive, low-friction, ~85% confidence per claude-code-guide expert). Edit `src/lib/peer-mcp-personas.ts` so each persona's `description` includes prescriptive triggers:
   > "Adversarial second opinion from gpt-5.5. **CALL BEFORE: ExitPlanMode for any plan involving >2 files or new architecture; finalizing a major design choice; TeamCreate when the team's task is non-trivial.** **CALL AFTER: any commit touching concurrency, security, or streaming code paths.** Backed by a different model with different blind spots than Claude. Cost: minutes; use freely on important checkpoints."

2. **`--agents` JSON descriptions** (medium strength). Update each subagent's `description` field with the same trigger language.

3. **Add a `peer-review-coordinator` subagent** (strongest, no new code). Its description: *"Coordinates cross-lab adversarial review. **Use proactively before ExitPlanMode and after non-trivial commits.** Routes to codex-critic / codex-reviewer / gemini-critic in parallel based on artifact type and aggregates findings."* For agent teams: peer-review-coordinator is auto-added as a member of every TeamCreate-spawned team.

4. **Optional opt-in PreToolUse hook on `ExitPlanMode`** (strongest, only opt-in via env). Off by default. Opt-in via `GH_ROUTER_AUTO_PEER_REVIEW=1`.

**Empirical acceptance test (mandatory):** sample 10 non-trivial planning sessions and 10 non-trivial implementation sessions in a clean profile, count whether Opus delegated to `peer-review-coordinator` at the documented checkpoints. Target: ≥7/10 in each. If <7/10, flip the `PreToolUse` hook to default-on.

#### Track 2B — Decomposition guidance in tool descriptions

The 7-batch sweep documented in [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md) proved decomposition fully solves the timeout (each batch <3 min). Add to the persona tool descriptions:

> "If the artifact under review is large (>20 KB), prefer to break it into 2-4 focused batches and call this tool once per batch in parallel. Aggregate findings yourself. This avoids long single calls."

Lower the default `effort` from xhigh to high — xhigh-by-default is expensive; let callers opt up for explicit deep dives.

#### Track 2C — Reasoning effort plumbing

In `src/routes/mcp/handler.ts:callPersona`, accept `effort?: "low"|"medium"|"high"|"xhigh"`. Set `payload.output_config = { effort }` for `/responses` personas. For `/chat/completions` personas (gemini-critic), schema-test `payload.reasoning_effort`; if Copilot 400s, document `effort` as a no-op for gemini-critic in its tool description (don't silently pretend it works).

#### Track 2D — Raise concurrency cap so decomposition can actually parallelize

Track 2B tells Opus to fan out into 2-4 parallel batches; with the current `MAX_INFLIGHT_TOOLS_CALL = 2` (`src/routes/mcp/handler.ts:32`), the (3-4)th calls return `isError: "queue full"` immediately, defeating the recommendation. Raise to **8** to comfortably cover a 7-fork wave with one slot of headroom.

The cap was a defensive pre-launch guess (not derived from any measured Copilot rate-limit). Persona handlers hold no shared mutable state — there's no race the cap is hiding. Memory per call is ~MB (non-streamed response bodies) — 7 in-flight reviews are tens of MB total. Full justification in [research/peer-mcp-investigation.md § Concurrency cap investigation](research/peer-mcp-investigation.md#concurrency-cap).

**If Phase 1+2 satisfies the user's needs:** ship and stop. This is the most likely sufficient state.

### Phase 3 — Async MCP (kickoff + poll) — only if Phase 1+2 insufficient (4-6 hours)

Build the async pattern peers and researchers converged on, with the bug fixes both critics surfaced:

- **Merged tool surface**: add `async: boolean` parameter to existing 3 tools (default false). NOT 6 parallel tools — gemini's UX concern about Opus tool-routing confusion.
- **Utility tools**: `poll_review(job_id, max_wait_s?)`, `cancel_review(job_id)`, `free_review(job_id)`.
- **In-process job map** (`src/lib/peer-mcp-jobs.ts` new): `Map<jobId, JobState>` keyed by `crypto.randomUUID()`.
- **Hard 30-min execution TTL on RUNNING jobs** — gemini's deadlock-vector finding. AbortController auto-fires, transitions to `status: "timeout"`, allows GC sweep.
- **Cap = 6 in-flight** (codex said 32 too high for xhigh-reasoning cost), env-overridable.
- **Retention 30 min** (codex said 5 min too short), `free_review` to release explicitly.
- **`partial_output` 1 MB cap** (gemini's OOM finding); drop oldest chunks if exceeded.
- **Result via standard MCP `resources` protocol** — `review://job-<uuid>` URIs, not filesystem paths (gemini: filesystem-IPC breaks MCP location-transparency).
- **Auto-promote-to-sync** for fast jobs (gemini): if `async: true` request completes within 20s threshold, return result inline — skip polling overhead entirely.
- **`max_wait_s` server-validated ≤ 50** (under the 60s ceiling).
- **AbortSignal threading** via `AbortSignal.any` — proxy's own controller, NOT `c.req.raw.signal` per CLAUDE.md Bun-signal quirk.
- **IMPERATIVE tool descriptions**: "you MUST call poll_review until completed" (claude-code-guide expert: 85% confidence on this lever).
- **Standing instructions in CLAUDE.md** (compaction-safe).
- **SEP-1686 alignment** so the future-rename to `tasks/create`/`tasks/status`/`tasks/cancel` is a refactor not a rewrite. Spec accepted Nov 2025 — see [SEP-1686](https://modelcontextprotocol.io/community/seps/1686-tasks).
- **Adversarial test suite**: abandoned-job-hits-TTL, wrong-id, expired-completed, cancel-during-fetch, server-restart-loses-jobs, over-cap, polling-until-final.

## Files & Reused Utilities

**Phase 1:**
- `src/lib/server-setup.ts` — `getClaudeCodeEnvVars` adds `MCP_TIMEOUT: "600000"`
- `tests/launch.test.ts` (or wherever the env-vars are tested) — assert injection

**Phase 2:**
- `src/lib/peer-mcp-personas.ts` — descriptions + effort default
- `src/lib/codex-mcp-config.ts` — `buildAgentPrompt` for new auto-invoke language; new `peer-review-coordinator` agent
- `src/routes/mcp/handler.ts` — effort plumbing; `peer-review-coordinator` agent registration; raise `MAX_INFLIGHT_TOOLS_CALL` from 2 to 8 (line 32)
- `src/services/copilot/create-responses.ts` and `create-chat-completions.ts` — accept caller signal; pass `output_config.effort`
- Test files: `tests/peer-mcp-personas.test.ts`, `tests/routes-mcp.test.ts`, `tests/codex-mcp-config.test.ts`
- `CLAUDE.md` — document the auto-invocation triggers, effort default, and concurrency cap

**Phase 3 (only if reached):**
- New: `src/lib/peer-mcp-jobs.ts` — job map, GC, TTL, AbortController plumbing, MCP resource registration
- `src/routes/mcp/handler.ts` — `async: boolean`; `poll_review`/`cancel_review`/`free_review`; `resources/list` + `resources/read` for `review://` URIs; auto-promote-to-sync
- New: `tests/lib-peer-mcp-jobs.test.ts`
- `tests/routes-mcp.test.ts` — async path integration tests including resource fetch
- `CLAUDE.md` — polling-protocol section

**Reused (don't duplicate):**
- `callPersona` / `buildPersonaInstructions` (`src/routes/mcp/handler.ts:199`, `src/lib/peer-mcp-personas.ts`)
- `createResponses` / `createChatCompletions` (`src/services/copilot/`) — signal threaded through (Phase 2/3)
- `tryRefreshAndRetry` (`src/lib/token.ts`) — already wraps Copilot fetches
- `checkAuth` (`src/routes/mcp/handler.ts:69`) — auth applies to new tools transparently
- `MAX_INFLIGHT_TOOLS_CALL` cap pattern — clone for `MAX_INFLIGHT_REVIEWS = 6` in Phase 3

## Decision Log Pointer

The full multi-stage adversarial review process — including the 4-perspective team consultation that reshaped this plan three times (plugin/Bash → async-MCP → phased) — is documented in [research/peer-mcp-investigation.md](research/peer-mcp-investigation.md) for future contributors who want the rationale behind each Phase ordering decision.
