# Peer-MCP Architecture Investigation Log

This document captures the multi-stage adversarial-review process behind the phased plan in [../peer-mcp-design.md](../peer-mcp-design.md). It exists for future contributors who want to know *why* each design decision was made — not just *what* was decided.

## TL;DR Decision Tree

1. **Does Claude Code's MCP HTTP client time out long peer-review calls?** Yes (regression #50289 in v2.1.113+).
2. **Does an env-var bypass exist?** Maybe (`MCP_TIMEOUT` symbol exists in the binary but field reports disagree). Empirical 5-min test resolves it → **Phase 1**.
3. **If the env-var doesn't help, can we make calls shorter?** Yes — decomposition into smaller batches works (proven by the 7-batch sweep in this investigation). Combined with auto-invocation triggers and effort plumbing → **Phase 2**.
4. **If decomposition isn't enough?** Async MCP (kickoff + poll) per SEP-1686, but with the bug fixes peer reviewers surfaced → **Phase 3**.

## Research Sources

| Source | Investigation | Key finding |
|---|---|---|
| `researcher-timeouts` | Read v2.1.138 binary symbols + 6 GitHub issues | Regression #50289 is real, open, has-repro; SDK constants present in binary; field reports on `MCP_TIMEOUT` mixed; SEP-1686 standardizes kickoff+poll |
| `researcher-alternatives` | Web research + local Claude Code install inspection | Plugin / Bash / hooks / settings.json injection — comparison table of auto-injection surfaces |
| `researcher-cap` | Source-level investigation of `MAX_INFLIGHT_TOOLS_CALL` | Cap=2 is defensive guess (commit 4317a25), no shared-state race behind it, safe to raise to 8 |
| `claude-code-guide` (×2) | Authoritative Claude Code knowledge | Tool descriptions are the strongest reliability lever (~85% confidence); MCP rate-limit / tool-cache deduplication / SEP-1686 client support all undocumented |
| `codex_critic` (gpt-5.5, ×3 stages) | Adversarial design review | Killed plugin/Bash plan; bug-found async-MCP draft (5-min retention too short, 32 cap too high, deadlock vector, race, etc.); blessed phased plan |
| `gemini_critic` (gemini-3.1-pro, ×3 stages) | Cross-lab triangulation | Killed plugin/Bash plan independently; flagged filesystem-IPC as MCP location-transparency violation → use MCP `resources` instead; flagged 6-tools UX → merge to async:bool |
| `strategist` (general-purpose) | Strategic challenge | Phase 1 first; decomposition pattern already works; async-MCP is "real and likely throwaway debt" |

## Stage 1: The Timeout Investigation

### Initial symptom

`mcp__gh-router-peers__codex_critic` calls with multi-page briefs + ~50KB diff context started timing out around the 5-minute mark from inside Claude Code. The proxy itself has a 300s upstream-inactivity timer (env-overridable via `UPSTREAM_INACTIVITY_TIMEOUT_MS`) and no fetch-phase cap (`UPSTREAM_FETCH_TIMEOUT_MS=0`). So the timeout must be on the Claude Code client side, not the server.

### `researcher-timeouts` findings

Read the v2.1.138 native Mach-O binary at `~/.local/share/claude/versions/2.1.138`. Key extracted strings:

- `DEFAULT_TOOL_CALL_TIMEOUT_MS` (constant; numeric value not extractable without RE tooling)
- `getToolCallTimeoutMs` (resolver function name)
- `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MCP_CONNECT_TIMEOUT_MS` — all in the env-var allowlist
- `MAX_MCP_OUTPUT_TOKENS` — caps OUTPUT tokens, not call latency
- `_setupTimeout`, `_resetTimeout`, `_cleanupTimeout`, `maxTotalTimeout`, `resetTimeoutOnProgress`, `notifications/progress` — canonical `@modelcontextprotocol/sdk` Protocol-class members; the SDK plumbing for progress-notification keepalive is shipped
- Log literal: `"] Tool call timeout: "` — confirms a single resolved value gets logged per call

### Primary GitHub Issues

- **[#50289](https://github.com/anthropics/claude-code/issues/50289)** (open, `bug`, `regression`, `has repro`) — `.mcp.json` per-server `timeout` no longer honored for HTTP MCP since 2.1.113. OP gives clean A/B: 36 long calls succeeded in 2.1.107 (max 188s), all timed out at ~60s in 2.1.114 with identical config. Comments confirm regression is platform-agnostic. `cleask` confirms heartbeat progress notifications **don't reset the client timer**, contradicting the spec.
- **[#52441](https://github.com/anthropics/claude-code/issues/52441)** (closed as duplicate of #50289) — Add `--timeout` flag for HTTP MCP. No CLI flag exists.
- **[#17662](https://github.com/anthropics/claude-code/issues/17662)** (closed-stale) — `MCP_TOOL_TIMEOUT` not respected for long-running HTTP tool calls. Env var name recognized but does not extend HTTP per-call wait.
- **[#52137](https://github.com/anthropics/claude-code/issues/52137)** (open) — Implement SEP-1686 (Tasks) for long-running MCP. References `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (60s SDK default) explicitly.
- **[#53641](https://github.com/anthropics/claude-code/issues/53641)** — MCP per-server timeout not enforced on individual tool calls (stdio).
- **[#44032](https://github.com/anthropics/claude-code/issues/44032)** — Claude Desktop MCP tool calls silently timeout after 4 minutes (Windows). Matches the "around the 5-minute mark" symptom shape.
- **[#424](https://github.com/anthropics/claude-code/issues/424)** — `MCP_TIMEOUT` env var origin. Documented as ms-valued, "applies to all transports". Per-strategist this is the lever to test first.

### MCP Spec — SEP-1686 ("Tasks")

[SEP-1686](https://modelcontextprotocol.io/community/seps/1686-tasks) standardizes async-task semantics for long-running MCP tool calls. Accepted into MCP in November 2025. Defines `tasks/create`, `tasks/status`, `tasks/cancel`, `tasks/result`. FastMCP v2.14.0 ships server-side support. Claude Code client adoption is unscheduled.

### CHANGELOG Verification

Fetched `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`. **No entry between 2.1.113 and 2.1.138** mentions restoring per-server timeout, adding `--timeout`, or implementing SEP-1686. The fix is not in.

## Stage 2: Architecture Alternatives Investigation

### `researcher-alternatives` comparison table

| Surface | Auto-inject at spawn? | Bypasses MCP timeout? | Large I/O OK? | Streamable? | Migration cost |
|---|---|---|---|---|---|
| MCP HTTP (current) | Yes (`--mcp-config`) | **No — ~60s cap** | Request OK / **response NO** | Cancelled at 60s | n/a (status quo) |
| MCP stdio | Yes | **Partial** — also has bug #53641 | Yes | Yes | Low |
| Skills (`SKILL.md`) | Yes (via `--plugin-dir`) | **Yes** — Bash-orchestrated | Yes (50KB+ via heredoc) | Yes | Medium |
| Slash commands (`commands/*.md`) | Yes (via `--plugin-dir`) | Yes — same Bash runtime | Yes | Yes | Medium |
| Hooks (PreToolUse/PostToolUse/Stop) | Yes (settings.json) | Yes (separate process) | Yes via stdin/stdout JSON | No (single batch reply) | High — fires reactively, doesn't fit "Opus chooses to consult" pattern |
| `--agents` (current) | Yes | **Depends on inner tool** | Yes | Inherits inner tool | Low |
| Plugins (`--plugin-dir`) | **Yes — single flag, ephemeral** | Container only | Yes | Yes | Low |
| `--settings <path>` JSON | Yes | n/a (knob) | n/a | n/a | Trivial |
| Custom statusline | Yes | n/a | No | No | Not relevant |
| Memory injection (CLAUDE.md) | Yes | Yes (instructions only) | Yes | Yes (orchestrator runs Bash) | Low — but pollutes user's persistent config dir |
| Direct Bash + curl pattern | Yes (taught via memory/plugin) | **Yes — completely** | Yes | Yes | Medium |

The first attempt at a plan picked the **plugin + Bash/curl** path. Both peer critics shot it down (next stage).

## Stage 3: Plan v1 — Plugin + Bash/curl (REJECTED)

### codex_critic verdict on v1

> The load-bearing flaw is that the plan treats Bash/curl bypass of MCP timeout as equivalent to async behavior, but it has not covered the realistic failure modes where the result is lost, abandoned, expired, or never surfaced.

Specific issues raised:
- 30-min blocking Bash freezes the UI
- Bash tool stdout truncation will corrupt 30-min reasoning outputs
- Nonce-in-command-body leaks via process list, plugin file contents, log captures
- `--plugin-dir` precedence with user's own `~/.claude/plugins` is unverified
- `BASH_MAX_TIMEOUT_MS` not proven to extend per-call wait on v2.1.113+
- Recommendation: **stay with MCP, refactor to async (kickoff+poll)**

### gemini_critic verdict on v1

> A 30-minute blocking `curl` execution via Claude Code's Bash tool will likely fail due to standard tool-output truncation limits and UI lockup, making the synchronous migration fundamentally flawed.

Specific issues raised:
- Bash tool truncates large stdout → corrupted reviews
- Blocking the agent's run loop for 30 minutes provides catastrophic UX (UI freeze)
- Standard architectural alternative: **Asynchronous Polling**
- Recommendation: keep `/mcp`, refactor to `start_review` → `{job_id}` + `poll_job(job_id)` pattern

**Both labs converged on async MCP. Plan revised.**

## Stage 4: Plan v2 — Async MCP (kickoff + poll) — bug-found

### codex_critic verdict on v2

> The load-bearing gap is that the proposal treats "background job in an in-memory Map + agent remembers to poll" as equivalent to reliable async peer review, but it has not covered the realistic failure modes where the result is lost, abandoned, expired, over-parallelized, or never surfaced back into Claude's reasoning.

Bugs in v2:
1. **5-min retention too short** — user may follow up after running tests; prefer 30-60 min + explicit `free_review`
2. **32 in-flight cap arbitrary and probably too high** — start lower (global 4-8, per-persona 2-4) for xhigh-reasoning-cost calls
3. **Reasoning effort plumbing under-specified** — verify Copilot accepts the fields
4. **partialBuffer is empty promise unless upstream actually streams**
5. **Validate `max_wait_s` server-side** to stay below the MCP cap
6. **Server-restart job loss** must be documented; structured logging
7. **Tool descriptions need explicit polling protocol** — not just "use start+poll for >60s"

### gemini_critic verdict on v2

> The in-memory job management creates a trivial deadlock vector because the garbage collector only purges completed or failed jobs, leaving abandoned *running* jobs to permanently exhaust the 32-job concurrency cap.

Bugs in v2:
1. **Deadlock vector** — GC only purges completed/failed; abandoned RUNNING jobs permanently exhaust the cap → need hard 30-min execution TTL on running jobs
2. **partial_output OOM** — needs MAX BYTE LIMIT (e.g., 1 MB); drop oldest chunks if exceeded
3. **Race**: `start_review` must SYNC create the Map entry in "running" before returning
4. **Cancellation**: freeze partial_output, status:"cancelled", subject to standard GC
5. **Effort plumbing for /chat/completions** (gemini-critic): `reasoning_effort` may NOT be a valid Copilot field for non-OpenAI models — sanitize per target model
6. **Major UX concern**: 6 overlapping tools (3 single-shot + 3 async) confuse Opus's tool-routing → **merge to 3 tools with `async: boolean` parameter**

### `strategist` strategic challenge on v2

> Don't ship the async MCP plan yet. The 4-6h refactor is strategically premature.

Key strategic findings:
1. **Try `MCP_TIMEOUT=600000` first** — issue #424 documents this env var; researcher-timeouts confirmed the binary symbol but did NOT empirically test it. **A 5-minute test resolves it.**
2. **Smaller-reviews pattern fully satisfies user goal** — the 7-batch sweep this session (each call <3 min) is exactly this pattern. ~30 min of prompt engineering on tool descriptions, zero new code.
3. **Downgrade to 2.1.107 is bad** — loses Opus 4.7 registry entry (regression in CLAUDE.md docs).
4. **Async MCP debt is real and likely throwaway** — SEP-1686 will standardize the protocol shape; bespoke `start_review`/`poll_review` we build now will need rewriting.
5. **Filesystem-as-IPC** is the right shape if we DO go async — `poll_review` returns `{status, file_path}`, agent uses native Read tool. (But gemini later flagged this breaks MCP location-transparency.)

### `claude-code-guide` v2 review

> Your plan is sound. The kickoff+poll pattern matches Claude's agentic philosophy.

Key gaps with confidence levels:
- Loop reliability: 60% — model may forget to poll; tool descriptions must be IMPERATIVE
- MCP rate-limiting between tool calls: 20% — undocumented
- Tool result deduplication: 30% — undocumented; assume model sees all results
- SEP-1686 client support in v2.1.138: 10% — implement as ordinary tools
- Subagent context isolation + polling: 70% — empirically untested
- partial_output UI rendering: 25% — undocumented; omit until proven useful
- Tool description guidance: 85% — imperative wording works
- Tool routing with 6 similar tools: 40% — use `disable-model-invocation` or `(Deprecated)` text

## Stage 5: Plan v3 — Phased

The plan was reshaped into 3 phases ordered by cost. Phase 1 = the cheapest empirical test the strategist proposed; Phase 2 = the prompt-engineering layer; Phase 3 = async MCP (only if needed) with all bug fixes from Stage 4.

### Final blessing pass

Both critics blessed v3 with two pinpoint additions:

**codex_critic (3/4/4)**: Phase ordering right, merged `async:bool` right, default `high` right. **Add: empirical acceptance test for Track 2A** — without it, "auto-invocation" is hopeful, not guaranteed. Filesystem-IPC paths must be workspace-scoped.

**gemini_critic (3/3/3)**: Plan systematically addresses prior concerns. **Critical**: filesystem-IPC breaks MCP location-transparency — use standard MCP `resources` protocol (`review://job-<uuid>` URIs read via `ReadResource`) instead. Also: missing — what if `async:true` completes faster than threshold? Auto-promote to sync response.

Both folded into the final plan.

## Concurrency Cap Investigation

The `MAX_INFLIGHT_TOOLS_CALL = 2` in `src/routes/mcp/handler.ts:32` was originally raised by codex_reviewer in an early review as "bounded concurrency cap of 2 per proxy with isError 'queue full' response". Investigated by `researcher-cap`:

### Where the "2" lives

- **Constant**: `src/routes/mcp/handler.ts:32` — `const MAX_INFLIGHT_TOOLS_CALL = 2`
- **Counter**: `src/routes/mcp/handler.ts:33` — `let inFlightToolsCall = 0` (module-scoped, single Bun process)
- **Enforcement gate**: `src/routes/mcp/handler.ts:314-326` — pre-flight check returning the `isError: true` overflow result
- **Inc/dec**: lines 328 and 362 (`finally` block — counter is leak-safe on throw)

### Why "2" was chosen (commit `4317a25`)

> "Reviewers flagged Opus's natural pattern with three critics is parallel invocation — without a cap that's 3× upstream Copilot QPS per delegation. Cap at 2 in-flight tools/call across the whole proxy and surface overflow as `isError: 'queue full'` instead of silent serialization."

So "2" was a pre-launch defensive guess based on the assumption that Opus would naturally fan out to all three critics at once. **Not derived from any measured Copilot rate-limit response** — there's no 429 telemetry feeding it.

### Failure mode on overflow

The (N+1)th call returns a clean JSON-RPC `result` object (HTTP 200) with `isError: true` and the text `"Peer MCP queue full (2 in-flight). Retry shortly..."` (`handler.ts:317-325`). Does **not** queue, hang, 429, or 503.

### Safety of raising to 8

The persona handlers (`callPersona`, `handler.ts:199-259`) hold no shared mutable state — each builds its own payload, awaits an isolated `createResponses`/`createChatCompletions` call, and returns. There's no race the cap is hiding. Memory per call is dominated by the (non-streamed, `stream: false`) response body; 7 in-flight reviews are tens of MB total, trivial.

The only real risk is **upstream Copilot rate-limiting** — but Copilot answers with its own 429 if you exceed its quota, and the proxy already surfaces upstream errors as `isError`. Clean failure on the affected call, not a proxy crash.

### Recommendation

Raise to **8** to comfortably cover a 7-fork wave with one slot of headroom. One-line change at `src/routes/mcp/handler.ts:32`. Tests reference `MAX_INFLIGHT_TOOLS_CALL` indirectly via `__getInFlightForTests`/`__resetInFlightForTests` — they don't hardcode the value, so they continue to pass.

## The 7-Batch Sweep (Decomposition Proof)

This investigation included a real-world test of the decomposition pattern. The branch `harden-streaming-pipe-followup` had a single commit `d844623` with a ~52KB diff that codex_critic timed out on as one giant call. We split it into 7 narrower batches by file-group:

- batch 1: stream-relay + tests (~25 KB)
- batch 2: route iterators + diagnose helper (~20 KB)
- batch 3: token + rate-limit + services (~12 KB)
- batch 4: chaos tests (~13 KB)
- batch 5: misc plumbing (~21 KB)
- batch 6: /mcp handler + tests (~38 KB)
- batch 7: personas + codex-mcp-config + paths + claude.ts (~60 KB)

Plus 7b focused on personas + codex-mcp-config alone (~39 KB).

Run as 4 sequential waves of 2 parallel forks each (proxy concurrency cap = 2). Every per-batch call returned in <3 minutes. **All 8 calls succeeded** (vs. 0/3 on the same total content as monolithic calls).

Findings consolidated:
- **HIGH (3 — 3 lab confirmation)**: upstream iterator/reader leak in stream-relay + handlers (gemini whole-branch, codex batch 1, codex batch 2)
- **HIGH (1)**: rateLimitChain queue-timeout still mutates state (codex batch 3)
- **HIGH (1)**: sweepStaleRuntimeFiles deletes live tempfiles after 24h (codex batch 7 + gemini whole-branch)
- **HIGH (1)**: --codex-cli wrongly reroutes read-only personas (codex batch 7b) — INTENTIONAL per user
- **HIGH (1)**: file-log-reporter fd leak on writeSync (codex batch 5)
- **HIGH (1)**: chaos test wall-clock abort timing (codex batch 4)
- **MEDIUM (8)**: scope-narrowing of isControllerClosedError, refresh cooldown stamp before attempt, /mcp null body misclassified, JSON-RPC notifications get response bodies, defensive {done:false,value:undefined} guard, chaos-test error allowlist, chaos-test consumer-cancel-no-log assertion, PID-only filenames could collide, envInt permissive parse
- **LOW (3)**: isLoopbackHost parsing, upstream_rst is JS-land error not real RST, model IDs hardcoded
- **Suspected hallucination (1)**: callerSignal propagated to upstream fetch — not in actual diff

Most fixes shipped in commit `d844623` (HIGH+MEDIUM). Remaining as deferred follow-ups in [../peer-mcp-design.md § Deferred follow-up](../peer-mcp-design.md).

This proves decomposition is a working pattern for the user's stated goal — and is the foundation of Plan Phase 2 Track 2B.
