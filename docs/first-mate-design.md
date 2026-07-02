# First-mate — durable GitHub cloud-agent controller

> Status: **shipped v1, gated behind `--agents` / `GH_ROUTER_ENABLE_AGENTS=1`.**
> This document describes the implementation in this repo today.

## Goal

Run a single long-lived Claude "first mate" as the operator-facing brain for a
fleet of GitHub CLOUD coding agents (Copilot / Anthropic / OpenAI), while
protecting Claude's own context. The first mate coordinates the outer loop —
research → plan → implement → test/review → merge — but the mechanism lives in
github-router, not in chat scrollback.

The shipped shape is a control inversion: Claude is a thin judgment oracle and
human-choice relay; the deterministic server-side controller owns durable state,
GitHub I/O, dispatch, retries, decision packets, and merge gates. If Claude
compacts, restarts, or clears context, the next controller wake rehydrates from
ledgers and continues from handles.

## MCP surface and gating

The scoped server is `first-mate` (`GROUP_META` / `MCP_GROUPS` in
`src/lib/peer-mcp-personas.ts`; route scope in `src/routes/mcp/route.ts`). The
preferred tool names are:

- `mcp__first-mate__start_mission` — persist a mission: goal, repos, acceptance
  criteria, optional priority, optional house rules.
- `mcp__first-mate__advance` — wake the deterministic controller once; apply
  submitted model/human answers; return compact `board`, `needsModel`,
  `needsHuman`, `applied_count`, `nextWakeAt`, and `nextWakeSeconds` (the
  ready-to-use self-wake delay; `null` when idle).
- `mcp__first-mate__board` — read the active board without a wake.
- `mcp__first-mate__mission_status` — read compact status for all missions, or
  one mission id.

So the operational surface is the start/advance/board triad plus the status read.
All four entries are created in `src/lib/first-mate/tools.ts`, carry
`capability: "agents"`, and are filtered at BOTH `tools/list` and `tools/call` by
`agentToolsEnabled()` (`src/lib/mcp-capabilities.ts`, `src/routes/mcp/handler.ts`).
That predicate requires:

1. operator opt-in: `--agents` or `GH_ROUTER_ENABLE_AGENTS=1`; and
2. `state.githubAgentToken` populated by the second GitHub login.

`src/claude.ts` only registers the `first-mate` MCP server when the predicate
passes, and only writes the `/gh-first-mate` skill when the surface is available.
On MCP-name collision, `resolveGroupKeysFromMirror()` in
`src/lib/codex-mcp-config.ts` gives the group a `gh-router-first-mate`-style key
rather than dropping or hijacking a user server.

## Controller: model as oracle, `advance()` as mechanism

`src/lib/first-mate/controller.ts` is the load-bearing engine. One `advance()`
wake does the mechanism in code:

1. `applySubmittedAnswers()` consumes prior `model_answers` and
   `human_decisions`.
2. `loadAllUnits()` + `readMissions()` rebuild the board from disk.
3. `observeUnit()` reads GitHub/Task state for each active, unblocked unit.
4. T0 classifiers distill fuzzy text signals into booleans/excerpts.
5. `classify()` + `nextAction()` run the pure decision table.
6. The engine executes the action: follow-up, ask model, human packet,
   verifier intent, cancel, mark done, or merge-gate attempt.
7. `dispatchWave()` starts eligible undispatched units within the per-provider
   capacity cap.
8. The wake returns compact queues and the next suggested wake time.

Claude does not own the state machine. It answers only bounded `needsModel`
requests: `review_plan`, `answer_agent_question`, `author_fix`, and
`judge_review`. The `/gh-first-mate` skill (`src/lib/injected-skills/first-mate-skill.ts`)
therefore tells Claude to run a thin loop: start a mission, call `advance`, answer
model requests with small typed verdicts, surface human requests, and report from
the board/ledger rather than rereading full diffs or logs.

## Self-driving loop (push-based, durable heartbeat)

The loop is push-based so it scales to many missions without a human babysitting
it. `advance()` never schedules itself server-side — the scheduling primitives
are lead-model tools — so the mechanism is split:

- **Server** returns `nextWakeSeconds`: a ready-to-use self-wake delay clamped to
  the scheduler's `[60, 3600]` range (derived from the same buckets as
  `nextWakeAt` — 90s while a unit is in-progress/CI-running, 900s while all units
  are queued/blocked, 300s otherwise), or `null` when the whole portfolio is idle
  (no active units). No client-side arithmetic; `null` is the explicit DISARM
  signal. A human-blocked unit stays active, so `nextWakeSeconds` is non-null
  while any `needsHuman` decision is pending.
- **Skill** drains all ready work each turn, then manages exactly ONE durable
  heartbeat identified by a stable `[fm-heartbeat]` marker token. It arms with a
  **create-fresh-then-reap** step: `CronCreate` a new `durable`/`recurring`
  heartbeat (cadence bucket chosen from `nextWakeSeconds` — ~2 min for imminent
  work, ~5 min mid, ~10 min when all queued/blocked, all fixed cron expressions
  so there is no client-side time math), then `CronDelete` every other
  `[fm-heartbeat]` job. Creating before deleting keeps at least one heartbeat
  live at all times; reaping the rest converges to exactly one, clears
  duplicate/old-version orphans, and — because it recreates each wake — resets
  the 7-day recurring-cron expiry so a long mission never silently stops. When
  `nextWakeSeconds` is `null` and no decision is pending, it disarms (deletes all
  `[fm-heartbeat]` jobs) and yields.

Disarm is safe against stranding by construction: work only ever becomes active
inside a turn (`start_mission` is a tool call; nothing activates a mission
server-side), and the skill's Start-a-mission invariant requires that same turn
to run advance + arm before yielding. So a disarmed idle portfolio can only be
reactivated by a turn that immediately re-arms.

Because the cron is durable (persisted to `.claude/scheduled_tasks.json`) and one
`advance()` sweeps the WHOLE registry, a single heartbeat drives every mission
across every repo, and the loop survives idle, compaction, restart, and `/clear`
— the ledger on disk is the only state that matters, and the heartbeat re-hydrates
it each wake. `CronCreate` is the primary primitive (available in any interactive
session, fires while the REPL is idle); `ScheduleWakeup` is used only for a
tighter one-shot wake when the session is a `/loop`. The recreate-each-wake arm
step keeps the recurring cron well inside its 7-day expiry.

## Dual-token auth

The existing Copilot login remains unchanged. `state.githubToken` is the original
GitHub App token path (`read:user`) used to fetch the Copilot token. First-mate
adds a second, write-capable identity:

- `GITHUB_AGENT_CLIENT_ID` and `GITHUB_AGENT_SCOPES` (`repo workflow read:org`) in
  `src/lib/api-config.ts`.
- `setupGitHubAgentToken()` in `src/lib/token.ts`.
- `PATHS.GITHUB_AGENT_TOKEN_PATH` in `src/lib/paths.ts`.

The second device-flow login uses the GitHub CLI OAuth client, stores
`~/.local/share/github-router/github_agent_token` with `0o600` best-effort mode,
and populates `state.githubAgentToken`. It never overwrites
`PATHS.GITHUB_TOKEN_PATH` or the Copilot App token. `githubAgentHeaders()` /
`githubAgentGraphQLHeaders()` are then used by the first-mate GitHub service
layer for reads and writes, including private repos. A best-effort scope check
warns if `repo` / `workflow` are absent.

## GitHub / Agent-Tasks service layer

The service layer under `src/lib/agent/` is intentionally agent-agnostic:

- `graphql.ts` / `rest.ts` wrap GitHub GraphQL and REST with the agent token,
  transient retry, compact `AgentError` codes, and per-call API versions.
- `service.ts` handles repo/actor discovery, issue creation, assignment, PR
  discovery/state, checks, reviews, workflow dispatch, reruns, merge, and
  ready-for-review.
- `tasks.ts` is the Agent-Tasks preview client.
- `capi.ts` is the Copilot-host (CAPI) session-log client — see below.
- `types.ts` defines compact DTOs.

Roster discovery uses `repository.suggestedActors(capabilities: [CAN_BE_ASSIGNED])`
and maps bot logins to `copilot`, `anthropic`, or `openai` via
`AGENT_LOGIN_MATCHERS`. The Agent-Tasks client uses preview API version
`2026-03-10` and returns compact handles (`taskId`, state, PR URL/number,
bounded tail log excerpt) instead of full transcripts. If `startTask()` fails,
the controller falls back to creating an issue and assigning the selected bot.

### Copilot-host session log (the agent's plan / progress / questions)

The cloud agent's plan, reasoning, progress, and any question it asks are NOT
on `api.github.com` — they live in its *session log* on the Copilot host, and
`capi.ts` is the read-only client for it. Three facts are load-bearing and were
established empirically (not from docs):

1. **Auth** is the raw `gho_` device-flow OAuth token (`state.githubAgentToken`)
   sent as `Bearer`. The structured `/copilot_internal/v2/token` output
   (`tid=…;exp=…:sig`) is rejected here as "invalid authorization header format".
2. **The host is discovered per-viewer** via GraphQL `viewer.copilotEndpoints.api`
   (memoised 10 min), not hard-coded.
3. Required headers `Copilot-Integration-Id: copilot-4-cli` +
   `X-GitHub-Api-Version: 2026-01-09`; the logs endpoint
   `GET {host}/agents/sessions/{sessionId}/logs` streams SSE
   `chat.completion.chunk` objects. There are **no** follow-up / steer / cancel
   endpoints — steering is via PR comments.

`getTask()` resolves the latest `sessions[].id` from the api.github.com task
detail, calls `getSessionLog()`, and folds the distilled excerpt (the
`report_progress.prDescription` plan + reasoning + progress + tool names, hard
truncated) into `logExcerpt`. `observeUnit()` surfaces it as `Observed.logExcerpt`
(and, when `provider === "waiting_for_user"`, `Observed.question`), so the
plan-ready / stuck / question micro-classifiers get real evidence and
`review_plan` / `answer_agent_question` carry the actual agent text. The client
is best-effort: any CAPI miss falls back to the api.github.com task text, and
all log content is treated as untrusted agent text.

## Durable registry and rehydration

Durable state lives under `PATHS.FIRST_MATE_DIR`
(`~/.local/share/github-router/first-mate`), outside the per-launch
`CLAUDE_CONFIG_DIR` mirror:

- `missions.json` — mission index (`src/lib/first-mate/registry.ts`).
- `<owner>__<repo>.json` — per-repo unit ledgers (`src/lib/first-mate/ledger.ts`).
- `decisions.json` — human decisions and approvals
  (`src/lib/first-mate/decisions.ts`, `approval.ts`).
- `packets/*.html` — generated decision packets (`controller.ts`,
  `decision-packet.ts`).

Writers use temp-file + atomic rename and tighten files to `0o600` where possible.
Readers validate shape and drop corrupt rows with debug logging. `loadAllUnits()`
rehydrates by reading missions, collecting all repos named by active/known
missions, then loading each repo ledger. Unit rows store handles and
classification — issue, PR, task id, bot login, SHAs, phase, validation,
dependencies, blocking decision id — not full diffs, logs, or transcripts.

Accuracy note for v1: `start_mission` registers a mission only. It does not yet
decompose the goal into `UnitRow`s. The controller dispatches undispatched units
once they exist; exact plan→unit creation is a follow-up.

## Orthogonal state model and pure decision table

`src/lib/first-mate/types.ts` defines the state axes:

- provider: GitHub/Task state (`none`, `queued`, `in_progress`,
  `waiting_for_user`, `completed`, `failed`, `timed_out`, `cancelled`).
- phase: controller lifecycle (`plan`, `build`, `fix`, `review`, `merge`, `done`).
- artifact: PR artifact state (`no_pr`, `pr_open`, `pr_closed`, `pr_merged`,
  `multiple_prs`).
- validation: CI/review/floor state (`unknown`, `ci_running`, `ci_passed`,
  `ci_failed`, `no_ci`, `review_pending`, `changes_requested`, `floor_pending`,
  `floor_passed`, `floor_failed`). `no_ci` is a completed build whose PR has zero
  check runs AND whose base branch has no workflow files — the cross-lab review
  is then the gate, so it routes to `assign_verifier` like `ci_passed` (never a
  silent stall). Zero check runs WITH workflows present stays `ci_running` (the
  checks just haven't registered), so real CI is never skipped.

`src/lib/first-mate/state-machine.ts` is pure: no network, no filesystem, no LLM.
`classify(observed, row)` computes the orthogonal state and events.
`nextAction(classified, row, policy)` is the decision table. Model inference only
enters when the returned action is `ask_model`; human gating only enters through
`escalate_human`. At `floor_passed`, the table escalates for approval — it never
merges directly.

## Tiered LLM policy and micro-classification

Model-tier policy is centralized in `src/lib/first-mate/model-tiers.ts`. T0 is
fastest-first and catalog-verified:

`gemini-3.5-flash` → `gemini-3-flash-preview` → `gpt-5.4-mini` → `gpt-5-mini` →
`claude-haiku-4.5` → `gpt-4o-mini` → small-model regex fallback.

`resolveTierModel()` picks the first present model from the live Copilot catalog
and memoizes briefly. `src/lib/first-mate/classifier.ts` uses that T0 tier for
small JSON-only classifiers: `classifyPlanReady`, `classifyQuestionAnswerable`,
`classifyFixAddressed`, and `classifyStuck`. `microClassify()` calls the same
Copilot chat-completions backend (`copilotBaseUrl(state)`, `copilotHeaders(state)`),
with temperature 0, small token caps, JSON-object response format, schema
validation, and confidence ≥ 0.6. Failure or low confidence returns `null`; the
pure state machine never calls an LLM.

## Cross-model verification, not bake-off

The shipped invariant is producer≠checker, and it happens **on the GitHub portal**.
When a unit's PR reaches `ci_passed`/`no_ci`, `assignVerifier()` requests a
**Copilot code review** via the review-request API using the exact bot login
`copilot-pull-request-reviewer[bot]` (verified empirically: the bare `Copilot`
and `copilot-swe-agent` forms 201 but silently no-op; the other cloud agents
cannot be requested as reviewers at all — only Copilot code review is served).
Copilot posts a `COMMENTED` review (never approve/request-changes) whose findings
are the signal. `observe` reads it (`getPullRequestReviews`, matched by author),
surfaces `verifierReviewed` + `reviewExcerpt`; the state machine then routes to
`floor_pending` and emits `judge_review` carrying the findings + plan + AC. The
**lead** judges — a different lab (claude/anthropic + the peer critics) than the
copilot producer, so producer≠checker holds at the decision — and the verdict is
also posted back as a real PR review (`APPROVE`/`REQUEST_CHANGES`), making the
floor decision a portal artifact that can satisfy required-review protection.
`floor_passed` (bound to `floorSha`) → merge packet → human approval → the gate.
The controller is not doing a parallel bake-off; it is one producer plus a
different-lab checker, with the review on the portal and human approval deciding
release.

## Decision packets and merge approval gate

Human requests are durable `DecisionRecord`s, not chat-only state. For an
escalation, `createHumanRequest()` fingerprints the live context (PR, head/base,
validation, artifact, reason), creates or reuses a decision row, and writes an
HTML packet. `src/lib/first-mate/decision-packet.ts` HTML-escapes all strings via
`esc()` and only allows `http:` / `https:` links.

The merge path is the irreversible special case:

1. `floor_passed` emits a `merge_approval` packet.
2. Claude may relay the user's choice through `advance({ human_decisions })`.
3. `applyHumanDecision()` fetches the live PR state itself and records approval
   with repo, PR, live head SHA, and optional live base SHA.
4. `maybeMergeWithApproval()` fetches live PR state again, calls
   `verifyAndConsumeApproval()`, and only then calls `mergePullRequest()` with
   `expectedHeadSha`.
5. `verifyAndConsumeApproval()` rejects no approval, replay, moved head, or moved
   base; success flips `consumed:true` in the durable decisions ledger.

v1 guarantee: the model relays the human Approve, but the server-side engine binds
the approval to live head/base, makes it single-use, and re-validates before
merge. A stale or forged relay cannot merge arbitrary content. The hardening
follow-up is server-side ai-or-die panel read so the human approval path is no
longer model-relayed.

## Where learnings live

The first-mate ledger is operational memory: missions, units, handles, decisions,
SHAs, and controller state. Durable knowledge belongs in git. Repo-specific
learnings should be committed to instruction files/docs/ADRs/tests that GitHub
agents auto-read. Cross-repo or portfolio facts should live in a private memory
repo that agents can read by handle.

## Open items / v1 limitations

- **Plan→build via a two-task flow (resolved):** `start_mission` is registration,
  not automatic decomposition. Dispatch is **plan-first**: the initial task runs
  with `create_pull_request:false` and produces an implementation plan, which the
  controller reads from the CAPI session log and surfaces as `review_plan`. On
  `approve`, `applyModelAnswer` starts a FRESH build task (`create_pull_request:true`)
  carrying the stashed plan (`unit.planExcerpt`); on `refine`, a fresh plan task
  carrying the feedback. The plan task is never steered into building (POST
  `/tasks/{id}` → 405, one-shot), so the two-task flow sidesteps the steerability
  problem. If `startTask` is unavailable, dispatch falls back to issue-assignment,
  which implements directly (no plan phase) — a degraded path.
- **Agent-Tasks preview details:** `followUpTask()` and `cancelTask()` still have
  TODOs for endpoint suffix shape in `src/lib/agent/tasks.ts`. `followUpTask()` is
  no longer on any hot path (steering is via fresh tasks / PR reviews) because the
  task is one-shot.
- **Non-Copilot Tasks parity:** Anthropic/OpenAI cloud-agent task behavior is
  represented in the roster model but still needs live parity verification.
- **Server-side panel-read hardening:** merge approval is head/base-bound and
  single-use today, but the human choice is still relayed by the model.
- **Verifier dispatch:** `assignVerifier()` records different-lab verifier intent;
  actual verifier task/review dispatch is stubbed TODO in the controller.

### Cross-lab review — residual hardening (v1)

An independent review hardened the merge gate: a forged `judge_review` is now
ignored (only a unit the engine placed into verification receives a floor
verdict), floor verdicts are bound to the head they were judged against
(`UnitRow.floorSha`, preserved by `classify` only while the head is unchanged),
and a merge approval is refused for a non-`floor_passed` unit or a moved head.
These items remain open:

- **Model-relayed approval:** the human "approve" still reaches the engine via
  the model. It is bounded (only a `floor_passed` unit whose live head still
  matches the verdict, single-use, engine-bound to the live head/base), but a
  fully model-unforgeable path needs the server-side ai-or-die panel read
  (`ArtifactClient`).
- **PR ↔ issue correlation:** `findAgentPRs` matches by bot-author login; a unit
  should prefer the Agent-Tasks `getTask` PR and correlate the PR to its issue so
  an unrelated bot PR is never attached/merged. Treat ambiguous multi-PR cases as
  `multiple_prs` (escalate), never silently pick one.
- **Cross-process single-use:** the approval-consume serializer is in-process
  (v1 assumes a single router process); a file-CAS / lock would make it
  multi-process safe, and consume-after-merge-success avoids burning an approval
  on a transient failure.
- **Repo-qualified request ids:** request/decision ids are
  `missionId:issue:kind`; adding the repo prevents collisions when one mission
  spans two repos that share an issue number.
