# First-mate: autonomous product agents — research + design brief

> Working brief (started 2026-07-13). Grounds two changes: (1) let the agent MCP answer Copilot cloud-agent plan-mode questions; (2) give first-mate role agents a real CEO/CTO/CPO operating protocol so they can drive products autonomously. Status: research in progress; design converging.

## Why

The `--agents` first-mate controller drives GitHub Copilot **cloud** coding agents. Two gaps block autonomous, human-free product delivery:

1. **Cloud agents stall in plan mode.** When a dispatched agent hits `waiting_for_user` and asks a question, first-mate detects it and computes an answer, but delivery (`applyModelAnswer` → `deps.postComment`, `controller.ts:1053-1061`) is hard-gated on `unit.pr !== null`. Plan/plan-refine tasks dispatch with `create_pull_request: false` (`controller.ts:963`, plan dispatch), so `unit.pr === null` and the answer is silently discarded — the agent blocks forever.
2. **Role agents have no operating protocol.** Scaffolded roles are generic dev roles only (`ROLE_AGENT_NAMES = [planner, implementer, reviewer, researcher, tester]`, `scaffold-spec.ts:83`). There is zero CEO/CTO/CPO, product-strategy, market-research, GTM, or marketing guidance anywhere. Agents don't know how to find a niche, validate a real pain, scope an MVP, launch, or iterate to traction.

## Code seams (verified)

**Problem 1 (detect works, deliver is the gap):**
- Detect: `observe.ts:322` sets `Observed.question` when `provider === "waiting_for_user"`; `state-machine.ts:168-174` → `ask_model: answer_agent_question`; payload `question` + `suggested_answer_from_ac` (`modelPayload`, `controller.ts:651-710`).
- Deliver: `applyModelAnswer` (`controller.ts:1053-1061`) posts `deps.postComment(repo, unit.pr, answer)` only if `unit.pr !== null`. Compare `author_fix` (`controller.ts:1002-1042`): steers via `deps.mentionCopilot` (@copilot wakes the agent) + `REQUEST_CHANGES`, also PR-gated.
- Dispatch: plan/plan-refine `create_pull_request: false`; approve→build flips `create_pull_request: true` (`controller.ts:916`). `startTask` (`tasks.ts:126-151`) POSTs task-centric — creates no issue. `followUpTask` (`tasks.ts:16,182-192`) is an UNWIRED stub, `FOLLOW_UP_TASK_PATH_SUFFIX = ""` — keep retired.
- GitHub write ops (`service.ts`): `postComment` (`:780`), `mentionCopilot` (`:800`), `submitReview` (`:808`).

**Problem 2 (attach points):**
- Roles built by `buildRoleAgent` (`scaffold-spec.ts:335-389`): a `specs` record → `---\nname/description/model\n---\n# Role` + Purpose / When to use / Method / Quality bar / Output contract. Mirrored to `.github/agents/<role>.md` + `.claude/agents/<role>.md` via the `ROLE_AGENT_NAMES.flatMap` loop (`scaffold-spec.ts:90-96`).
- File set: `buildScaffoldFiles` (`scaffold-spec.ts:87-113`). Enhance-eligible paths: `ENHANCEABLE_PATHS` (`scaffold-spec.ts:74-79`).
- Guidance reaches cloud agents via committed files (`buildGuidance`) AND task prompts (`planPrompt`/`buildPrompt`, `controller.ts:2236-2280` = goal + acceptance criteria + house rules + DoD).

## Prior art (confirmed — first-mate is novel)

- No third-party MCP drives Copilot CLOUD coding agents with mission + plan-answer + merge-gate. Closest: GitHub **Agent HQ / Mission Control** (Oct 2025) — a human dashboard, not a programmatic controller. `github/github-mcp-server` has thin dispatch (`assign_copilot_to_issue`, `create_pull_request_with_copilot`) but no observe/steer/answer/mission/gate.
- **Problem 1 external reality:** no API to answer a clarification distinct from **commenting on the issue/PR (optionally @copilot)**; "steering = commenting." `waiting_for_user` is first-class.
- **Two dispatch surfaces:** task-centric `POST /agents/repos/{owner}/{repo}/tasks` (current; no issue) vs. issue-centric assign `copilot-swe-agent[bot]` + `agent_assignment` (always an issue thread). REST api-version `2026-03-10`; task carries `artifacts[]` + `sessions[]`; USER token required (App-installation tokens unsupported — matches dual-token design).
- Differentiate on the governance/mission/scaffolding layer; interoperate with GitHub primitives; watch Fleet Mode / Copilot SDK.

## Problem 1 — FINALIZED design (grounded in docs.github.com, api-version 2026-03-10)

External reality (documented):
- Prompt-based Agent Tasks (our `startTask`) default `create_pull_request: false` → plan-mode units have a **branch** (`copilot/…`, once the agent starts; captured as `sessionLog.branch` → `getTask().branch`, `tasks.ts:178`) but **no PR and no issue**. Issue-assignment ALWAYS creates a PR, but we don't use that path.
- **No follow-up/resume endpoint and no session-log write path exist.** The documented "continue" is: re-`POST /agents/repos/{owner}/{repo}/tasks` with `head_ref`=existing branch, `base_ref`=base, `prompt`=answer → new session that commits to `head_ref` instead of branching. Pre-PR (branch-only) behavior is inferred, not guaranteed, but it is the documented continue mechanism.
- `@copilot` **new top-level PR comment** is the documented wake trigger (write access, PR open, not fork; async ack via 👀 + "Copilot started work"). A **bare** comment (what `answer_agent_question` posts today) is NOT the documented trigger — must @-mention. Post-assignment **issue** comments are explicitly ignored by the agent. Session hard timeout 59 min.
- Prevention is documented: a direct "implement and open a PR" prompt avoids the research/plan pause; `AGENTS.md`/`copilot-instructions.md` can instruct "proceed on best judgment, document assumptions, do not pause for clarification" (supported extensibility; exact wording is convention). A custom `.agent.md` (selectable only via issue-assignment `agentAssignment.customAgent`) is a stronger but path-limited lever.

Three-layer fix (prevention first):
1. **Prevent** (highest leverage, serves "no human intervention"): add an autonomy directive to `planPrompt`/`buildPrompt` (`controller.ts:2236-2280`) AND to scaffolded guidance (`buildGuidance` conventions) + the C-suite/dev role agents — "proceed on best judgment; do not pause to ask; state assumptions explicitly in the plan/PR body and continue." Reduces `waiting_for_user` frequency.
2. **Deliver** the residual `waiting_for_user` answer in `applyModelAnswer`'s `answer_agent_question` branch (`controller.ts:1053-1061`):
   - If `unit.pr !== null` → post the answer as an **@copilot mention** (`deps.mentionCopilot`, the documented wake trigger) rather than the current bare `deps.postComment`.
   - Else if the unit has a **branch** → **continue the task**: a correctly-implemented `continueTask` that re-POSTs `startTask`-style to `repoTasksPath` with `head_ref`=branch, `base_ref`=base, `prompt`=answer (retire the `/tasks/{id}` suffix stub in `tasks.ts:16,182-192`). Update `unit.taskId`/provider to the new session (mirror the review_plan re-dispatch bookkeeping; guard idempotency like `dispatchWithOutbox`).
   - Else (no PR, no branch yet — rare early research phase) → keep re-emitting; the existing retry/҂escalation + 59-min timeout resolve it.
   - Keep the `waiting_for_user` re-ask guarded so we don't spam (mirror `lastSteer`/blockingDecisionId handling).
3. Tests: unit-test each delivery branch (PR→mention, branch→continue re-POST, neither→noop) with mocked `deps`; assert no bare-comment path remains; assert `continueTask` posts to `repoTasksPath` with `head_ref`.

Risk notes: the Agent Tasks API is "public preview, subject to change"; the branch-only continue is inferred. Gate the continue path defensively (best-effort, never throw into the sweep) and prefer prevention. This is exactly the "detect `waiting_for_user` → answer" clean mechanism the prior-art flagged as an unsolved differentiator.

## Problem 2 — FINALIZED design (playbook content + wiring)

Grounded in the methodology research: a phased, LLM-geared operating protocol with **externally-verifiable checkpoints** at every phase (the defense against the documented ~70% autonomous-task failure rate and hallucinated "done"). Two loops: OODA (daily) inside Build-Measure-Learn (phase).

**Wiring (reuse existing scaffold machinery):**
1. **Three C-suite role agents** added to `ROLE_AGENT_NAMES` + `buildRoleAgent` specs (`scaffold-spec.ts:83,335`): `ceo`, `cto`, `cpo`. Same template shape (frontmatter + Purpose / When to use / Method / Quality bar / Output contract), mirrored to `.github/agents/*.md` + `.claude/agents/*.md`, committed by the scaffold PR, read by cloud agents. Models: cpo/ceo → `claude-opus-4.8` (strategy/judgment); cto → `claude-opus-4.8` or omit. They frame the operator hats; the existing planner/implementer/reviewer/researcher/tester remain the execution roles they delegate to.
2. **Durable playbook docs** via `buildScaffoldFiles` (`scaffold-spec.ts:98-113`): `docs/playbook/README.md` (the phased operating protocol + the governance loop + the checkpoints), and role-facing sections. Register the playbook README in `ENHANCEABLE_PATHS` so `enhance` mode appends missing `##` sections.
3. **Autonomy directive in guidance** (`buildGuidance`, `scaffold-spec.ts:219-317`): a "Operating autonomously" section — proceed on best judgment, state assumptions in the PR, do not pause for clarification; and pointers to the playbook + C-suite agents. This is ALSO the Problem-1 prevention layer (documented `AGENTS.md`/`copilot-instructions.md` lever).
4. Update the enumerations that list the 5 roles: `first-mate-setup-skill.ts` "what it seeds", `docs/first-mate-design.md` scaffolding section.

**Playbook backbone (content):** Phase 0 Discover (JTBD, ≥3 corroborated struggling moments) → 1 Niche/beachhead (Aulet segmentation, 1000-true-fans floor, go/no-go table) → 2 Position (Dunford 10-step, competitive-alternatives table, 1-sentence pitch) → 3 Scope (riskiest-assumption test + pre-set kill/pivot threshold, Kano must-be/perf/delight, frozen v0.1 cut list) → 4 Build (ADRs, trunk-based + flags, test pyramid, DORA, <5-min quickstart, perf/a11y budgets) → 5 Launch (README-as-landing-page, Diataxis docs, Show HN / Product Hunt / dev.to sequenced to where the persona lives) → 6 Measure (Sean Ellis 40% AND cohort retention, AARRR, stars≠activation) → 7 Iterate (Torres opportunity-solution-tree weekly from issues, RICE only to sequence validated options, changelog every release) → 8 Grow (shareable-artifact growth loops, community infra, docs-as-SEO). Governance: OODA daily + every decision logged hypothesis→experiment→metric→threshold→outcome (ADR-style, auditable). Anti-patterns section: over-build w/o distribution test, hallucinated progress (require real HTTP 200 / green CI / real survey N), viral≠PMF, manipulation/economic-judgment limits, demo≠reality.

## Holistic synthesis — how the two halves make an autonomous product loop

Problem 1 is the **enabling mechanic** (agents never silently stall; they proceed autonomously or get answered). Problem 2 is the **operating intelligence** (agents know what to build, for whom, how to launch and iterate). Together: a first-mate mission can carry a product from niche-discovery through MVP, launch, and iteration with the cloud agents self-driving and the controller answering the rare block — the differentiated "mission/governance layer above Copilot cloud agents" that no competitor ships. Both land through the existing scaffold + controller machinery; no new subsystem.

## Research status: COMPLETE (prior-art, reply-API, methodology all in).

## Problem 1 — exact edit set (execute after the playbook pass lands, on a clean tree)

Rename the dead `followUpTask` (points at non-existent `/tasks/{id}` suffix, returns `{ok:true}`) → `continueTaskOnBranch` (re-POST to the tasks endpoint with `head_ref`). Affected sites (compiler will enumerate; pre-listed to make the sweep exact):

1. `src/lib/agent/types.ts`: remove `TaskFollowUpResult`; add `ContinueTaskInput { headRef: string; baseRef?: string; prompt: string; model?: string; idempotencyKey?: string }`.
2. `src/lib/agent/tasks.ts`: delete `FOLLOW_UP_TASK_PATH_SUFFIX`; replace `followUpTask(repo, taskId, prompt)` with `continueTaskOnBranch(repo, input: ContinueTaskInput): Promise<TaskStartResult>` → `POST repoTasksPath(repo)` body `{ prompt, head_ref: input.headRef, base_ref?, model? }`, `retry:false`, optional `Idempotency-Key`; parse `{taskId, state}` (reuse `startTask`'s field parsing). Drop the `TaskFollowUpResult` import.
3. `src/lib/first-mate/controller.ts`:
   - import (line 29) `followUpTask as realFollowUpTask` → `continueTaskOnBranch as realContinueTaskOnBranch`.
   - `ControllerDeps` (line 105) + `defaultDeps` (line 352): rename field.
   - `AUTONOMY_DIRECTIVE` const + append to `planPrompt` (after the "output the plan and stop" line) and `buildPrompt` (replace/strengthen the existing "if ambiguous, make a reasonable choice" line): "Work autonomously — do not stop to ask clarifying questions. If a requirement is ambiguous, choose the most reasonable interpretation, state the assumption explicitly (in the plan and the PR description), and continue. Surface open questions as notes, never block on them."
   - `answer_agent_question` branch (1053-1061): if `unit.pr !== null` → `deps.mentionCopilot(repo, unit.pr, answerText)` (documented wake trigger; replaces bare `postComment`) + `lastSteer`; else if `unit.branch` non-empty → resolve model (`resolveCloudAgentModel(unit.model ?? mission?.defaultModel)`, may throw → per-answer catch re-enqueues), `deps.continueTaskOnBranch(repo, { headRef: unit.branch, baseRef: unit.baseRef ?? undefined, prompt: answerText, model })`, then `unit.taskId = task.taskId`, `unit.provider = providerState(task.state, "in_progress")`, `lastSteer`; else no-op (re-emit / 59-min timeout terminalizes). Wrap GitHub calls in the existing `assertFenceHeld`.
4. Test/mocks to update (rename key; fix explicit-return mocks to `{ taskId, state }`): `tests/first-mate-controller.test.ts` (208 mock + 474-475/506 `not.toHaveBeenCalled` assertions → `continueTaskOnBranch`), `tests/first-mate-model-selection.test.ts:247`, `tests/first-mate-scoped-advance.test.ts:151`, `tests/first-mate-dod.test.ts:156`, `tests/first-mate/scheduler/{answer-inbox,advance-lease-gate,drive-gate}.test.ts`, `tests/first-mate/scheduler/e2e/{wired-path.test.ts,harness-daemon.ts}`, `scripts/first-mate-smoke.ts:37`.
5. New tests (`tests/first-mate-controller.test.ts` + `tests/agent-service`/tasks test): answer_agent_question with PR → `mentionCopilot` called (not `postComment`); with no PR + branch → `continueTaskOnBranch` called with `headRef`; with neither → no delivery. `continueTaskOnBranch` POSTs `repoTasksPath` with `head_ref` and returns `{taskId,state}`.
6. `docs/first-mate-design.md:424-425` + the answer-delivery section: update to describe the mention/continue delivery and the retired stub.
7. `package.json`: single patch bump (lead, at integration).

## Implementation status — DONE (2026-07-13)

Both halves implemented, cross-lab reviewed, and fixed:
- **Problem 2** (playbook): `ceo`/`cto`/`cpo` role agents + `docs/playbook/README.md` (phase-gated, externally-verifiable checkpoints, OODA+BML governance, anti-patterns, decision-log) + guidance "Operating autonomously" section, all via `scaffold-spec.ts`; skill enumeration + design-doc updated. 15 scaffold-spec tests pass.
- **Problem 1** (never stall): `continueTaskOnBranch` (retired the dead stub), `answer_agent_question` delivery = @copilot mention (PR) / branch task-continue (no PR) / noop, `AUTONOMY_DIRECTIVE` in both dispatch prompts, mock sweep across 10 sites. 4 new delivery tests + 1 guard test.
- **gemini-reviewer (cross-lab) findings, all fixed:** (1) Critical — unbounded mention spam while `waiting_for_user` → added dedicated `answerMentionSha` one-outstanding-per-head guard (mirrors `author_fix`). (2) High — missing idempotency on the continue re-POST → pass `idempotencyKey: continue:<unit>:<sourceTask>`. (3) Medium — poison-pill on an invalid pinned model → try/catch → fall back to provider default (delivery is best-effort).
- **Gate:** typecheck green, lint:all green, 388 first-mate + 64 agent/scaffold/state-machine/tier1 tests pass (0 fail), version bumped 0.3.204 → 0.3.205. Full-suite final run in progress.

## Follow-up — queryable operator skill (2026-07-13)

The operating protocol now also reaches the LOCAL first-mate operator (not just the cloud agents via scaffolded files): a new `gh-first-mate-operate` injected skill (`src/lib/injected-skills/first-mate-operate-skill.ts`) is the operator-facing CEO/CTO/CPO protocol — shape each mission from a struggling moment, set acceptance criteria = the phase's externally-verifiable checkpoint, sequence discover→grow, escalate launch/spend/pricing. Gated to `--agents` (added to `isFirstMateSkillName`; serve excludes it via the `gh-first-mate` prefix). Single source of truth: the condensed phase sequence lives in `src/lib/first-mate/operating-protocol.ts` (`CONDENSED_OPERATING_SEQUENCE`), consumed by BOTH `buildPlaybook()` (the scaffolded cloud-agent doc) and the skill — a test asserts both embed it so they can't drift. Final combined run of all touched areas: 433 pass, 0 fail.

## Follow-up 2 — concurrent builds for provably-independent units (2026-07-13)

The first CEO run (on `animeshkundu/sanger-viewer`) exposed a real ceiling: the controller's `hasActiveBuildUnit` gate allowed only ONE active build per mission, so the CEO's 4 conflict-free units serialized to 1 (verified board: `build:1, plan:3`) despite excellent decomposition. Two fixes shipped (do not affect running instances):
1. **Controller (`controller.ts`, `types.ts`, `registry.ts`):** `UnitRow.fileScopes?: string[]` (declared allowlist, threaded from the decompose spec via `parseFileScopes`) + `Mission.maxConcurrentBuilds?` (default `DEFAULT_MAX_CONCURRENT_BUILDS = 4`). Replaced `hasActiveBuildUnit` with `canDispatchBuild()` (used at both dispatch sites): a build runs CONCURRENTLY only when under the cap AND its `fileScopes` are non-empty and disjoint (`fileScopesDisjoint` — directory-prefix overlap) from every other active build. Unknown/overlapping scope → serialize (byte-for-byte the old behavior, so no-scope missions are unchanged). Deps orthogonal (`depsSatisfied`).
2. **Skills:** `gh-first-mate` decompose verdict now takes `fileScopes?`; both `gh-first-mate` and `gh-first-mate-operate` teach the two real parallelism levers — declare disjoint `fileScopes` for concurrent builds within a mission, and/or separate missions for independent streams — and correct the misconception that `max_in_flight_per_provider` is the build-concurrency lever (it is a global provider cap).
Tests: 4 new controller tests (disjoint→2 concurrent, overlap→serialize, no-scope→serialize, decompose threading) + design-doc note. Version 0.3.206.

## Follow-up 3 — CEO run 2 eval + failed-session fix (2026-07-13)

CEO run 2 (on `sanger-viewer`, full GitHub authority) was scored via `docs/first-mate-ceo-eval-framework.md` with the mandatory verify-against-real-state pass: EVERY load-bearing claim held (PR #62 merged @ `1fc3ef21`, PR #63 merged @ `e0c19460`, real non-draft **v1.0.0** release @ `e0c19460`, issue #56 closed, live site 200, README comparison table + CHANGELOG `[1.0.0]` present). No hard gate fired; truthfulness ~perfect; honest about the serial gate + no-scheduler limit. A clear step up from run 1 (which overstated "4 building") — run 2 drove to a verified SHIPPED outcome (first-ever release).

Issue surfaced + FIXED: a `failed`/`timed_out` cloud-agent SESSION hard-escalated even when it left a usable open PR (green CI + complete diff) — a session-status artifact, not a deliverable failure — forcing the CEO to merge manually. Fix (`state-machine.ts` `nextAction`): only escalate on `failed`/`timed_out` when `artifact !== "pr_open"`; a real open PR falls through to the normal validation path (CI/review/floor → the still-human-gated merge). Backward-compatible (no-PR failure still escalates; existing test unchanged) + a new test for the pr_open path. Version 0.3.207.

Other issues: parallelization ceiling (fixed, Follow-up 2, pending rebuild); empty-PR-judged-done (A6 guard exists — future auto-steer improvement); no-scheduler-in-subagent (harness-level cron-to-subagent limitation, not a source fix).

## Refinement — the local Claude IS the CEO (2026-07-13)

Clarified role layering: the LOCAL Claude that drives first-mate is the CEO; the GitHub cloud agents are its team (they carry the cto/cpo/execution role guides in-repo). The CEO's job is to get verified work OUT of the team, not shape missions passively. Delivered as framing/mindset (no new mechanism), in the behavior shapers:
- `gh-first-mate` skill (auto-invoked every heartbeat → default driving posture): a "You are the CEO" section — drive results not activity, hold deliverables to external evidence, keep the team unblocked/busy, own the outcome; points to `/gh-first-mate-operate`.
- `gh-first-mate-operate` skill: reframed from "operator shapes missions" to "you are the CEO driving your team"; added a "Drive the team (get work out of them)" discipline (verify never trust "done", keep unblocked, set the bar as acceptance criteria, own the P&L of attention); "you do not write the product code, you orchestrate".
- Awareness snippet (`peer-mcp-personas.ts`, `--agents` only): "you are the CEO of the product … get verified work out of the team, never a self-reported 'done'."
- Ties to Problem 1: "keep the team unblocked" is literally the answer-delivery fix — an unblocked agent is productive throughput.
Tests pin the CEO framing in both skills. Gate: typecheck + lint green; 187 tests pass (0 fail) across skills/persona/scaffold/controller.
