# Review: `mcp__first-mate__mark_ready`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__mark_ready` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `mark_ready` |
| Definition | `src/lib/first-mate/tools.ts:532` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`); also a per-call `hasAgentToken()` re-check at `src/lib/first-mate/tools.ts:202` |
| Backing model / endpoint | server-side fn (GitHub GraphQL `markPullRequestReadyForReview` via `markReadyForReview`, `src/lib/agent/service.ts:929`) |
| Write-capable | yes (mutates GitHub PR draft→ready) |

Gate detail: `agentToolsEnabled()` returns true iff (`state.agentsEnabled` OR `GH_ROUTER_ENABLE_AGENTS === "1"`) AND a non-empty `state.githubAgentToken` (`src/lib/mcp-capabilities.ts:196-202`). The `capability: "agents"` tag is attached to every first-mate tool by the local `tool()` factory (`src/lib/first-mate/tools.ts:197-200`), which the MCP handler filters on at both `tools/list` and `tools/call`. The handler additionally short-circuits with an `AGENT_TOKEN_REQUIRED` error if `hasAgentToken()` is false at call time (`tools.ts:202-208`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/first-mate/tools.ts:534`):

> Mark a draft GitHub pull request ready for review. Ownership-scoped identically to merge_pr/close_pr (agent-authored or active first-mate mission repo, else requires allow_unowned).

Input-schema fields (`src/lib/first-mate/tools.ts:535-539`), required set `["repo", "pr"]`:

- `repo` (string, required) — "Repository as an owner/name string."
- `pr` (number, required) — "Pull request number."
- `allow_unowned` (boolean, optional) — "Set true to mark a PR ready when it is neither agent-authored nor part of an active first-mate mission. Explicit opt-in; audit-logged."

### 2b. System prompt (`--append-system-prompt`)

`mark_ready` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). No first-mate tool is named there. The only first-mate mention is the skill sentence, emitted only when `agentToolsAvailable === true` (`src/lib/peer-mcp-personas.ts:617-618`), verbatim clause:

> `/gh-first-mate` drives the durable GitHub cloud-agent loop.

The group name `first-mate` itself is not narrated as an MCP server in the snippet either; only the skill is surfaced. So at the system-prompt layer the model learns "there is a `/gh-first-mate` skill" and nothing about `mark_ready` as a callable tool — discovery of the tool relies entirely on `tools/list` (section 2a) and the skill body.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b, so `mark_ready` is not individually named there either — only the `/gh-first-mate` skill sentence covers it.

The checked-in repo root `CLAUDE.md` (`CLAUDE.md:139`, "First-mate cloud-agent controller (`--agents`)" section) names the tool in an enumerated list:

> `--agents` (or `GH_ROUTER_ENABLE_AGENTS=1`) adds the `first-mate` scoped MCP server (`mcp__first-mate__start_mission`, `__advance`, `__board`, plus `__mission_status`, `__scaffold_repo`, and PR operator tools including `__mark_ready`) only when `agentToolsEnabled()` also sees the second GitHub write token.

This is a passing mention (naming, not behavior). The behavioral contract lives in `docs/first-mate-design.md:42-44`:

> `mcp__first-mate__mark_ready` — mark a draft PR ready for review, with the same fail-closed ownership scope as `merge_pr` / `close_pr` (bot-authored or correlated to a first-mate unit, else explicit `allow_unowned`).

Both agree with the code: the ownership scope is fail-closed and identical to merge/close (`resolveOwnership`, `src/lib/first-mate/tools.ts:706-738`), and `allow_unowned` is the override (`tools.ts:548-560`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The description states the action (mark a draft PR ready) and the ownership constraint. It gives a positive routing signal but no explicit "when NOT to use" and no statement of preconditions the handler enforces (PR must be OPEN; a non-draft returns `alreadyReady` rather than erroring). These are recoverable from error results, but a model reading only `tools/list` cannot predict the `PR_NOT_OPEN` rejection or the `alreadyReady` no-op path.
- **Accuracy vs implementation.** Accurate. "Ownership-scoped identically to merge_pr/close_pr" matches `resolveOwnership` being the shared scope function for all three (`tools.ts:508`, `547`, and merge/close call sites). "agent-authored or active first-mate mission repo" is slightly loose: the true correlation signal is a first-mate *unit that owns THIS PR in THIS repo* (`unit.pr === pr && repoMatchesTarget(...)`, `tools.ts:722-726`), NOT merely "the PR sits in a repo an active mission targets" — the code comment at `tools.ts:700-702` and `717-719` is explicit that repo-level targeting is deliberately insufficient. The `allow_unowned` field description repeats the same slightly-loose phrasing ("part of an active first-mate mission").
- **Schema minimality.** All three fields pass the minimality bar. `repo` + `pr` are required and load-bearing (they identify the PR). `allow_unowned` is model-tunable and directly actionable — it is the documented override, echoed back to the model in the `UNOWNED_PR` error message ("pass allow_unowned:true to override", `tools.ts:553`), so the model can act on it next call. No echoed-input or diagnostic-only fields. Consistent with the "ruthlessly minimal MCP tool surface" principle in `docs/peer-mcp-design.md`.

### 3b. System-prompt coverage

- **Omitted by design.** No first-mate tool is named in `buildPeerAwarenessSnippet`; the team-lead brief confirms only the `/gh-first-mate` skill sentence is present. This is consistent with the other operator tools in the group and is a deliberate choice — the skill body carries the operating guidance, and the peer-awareness snippet stays scoped to review/search/worker/orchestrate/browse/decide capabilities. Naming eight first-mate tools inline would bloat the always-on prompt for a capability most sessions don't have enabled (the snippet only emits the skill line when `agentToolsAvailable`).
- **Accurate & non-redundant.** The one clause ("`/gh-first-mate` drives the durable GitHub cloud-agent loop") is accurate and does not duplicate the tool description.
- **Framing-constraint compliance.** The skill clause is descriptive, not imperative — no "Lead with X", no hedges, no anchor. Compliant with the framing rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted.** Root `CLAUDE.md:139` names `__mark_ready` correctly as a PR operator tool and states the correct gate (`--agents`/env + second GitHub write token). `docs/first-mate-design.md:42-44` documents the ownership scope accurately and matches the code (`resolveOwnership` fail-closed, `allow_unowned` override).
- **Injected block vs checked-in root CLAUDE.md consistency.** Consistent. The injected mirror does not name the tool (skill-only), and the checked-in root CLAUDE.md names it only in passing — no contradiction between the two.

### 3d. Cross-surface consistency

No contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ code. The only cross-surface imprecision is the shared "active first-mate mission repo / part of an active first-mate mission" phrasing (description at `tools.ts:534` and `538`), which understates the tightness of the correlation check versus the code's own comment and logic (`tools.ts:700-726`). The design doc (`docs/first-mate-design.md:43`, "correlated to a first-mate unit") is the more precise wording and does not carry this imprecision.

## 4. Findings

- **[Suggestion]** `src/lib/first-mate/tools.ts:534,538` — the description and the `allow_unowned` field say "active first-mate mission repo" / "part of an active first-mate mission", but the code owns a PR only when a first-mate *unit* is correlated to THAT exact PR in THAT repo (`tools.ts:722-726`); repo-level mission targeting is deliberately NOT sufficient (`tools.ts:700-702`, `717-719`). A model could read the current wording to expect any PR in a mission's repo to be owned. Fix: align the wording with the design doc — e.g. "agent-authored or correlated to a first-mate unit, else requires allow_unowned".
- **[Suggestion]** `src/lib/first-mate/tools.ts:534` — the description omits two handler-enforced facts the model cannot otherwise predict from `tools/list`: only OPEN PRs are accepted (`PR_NOT_OPEN`, `tools.ts:561-562`) and a non-draft OPEN PR is a no-op returning `{ ready:true, alreadyReady:true }` (`tools.ts:564`). Optional one-clause add ("only OPEN PRs; a non-draft PR returns alreadyReady") would remove a round-trip of trial-and-error. Non-blocking; the error/return payloads already tell the model on the first call.

No Critical or Important findings: the tool rejects out-of-scope input fail-closed, the write path is gated (`agents` capability + live token re-check), and the ownership override is audit-logged (`tools.ts:557-559`).

## 5. Verdict

Y — the injected surface is correct, minimal, consistent, and adequately routed; the single most valuable fix is tightening the description's "active first-mate mission repo" wording to "correlated to a first-mate unit" so it matches the PR-level (not repo-level) ownership the code actually enforces.
