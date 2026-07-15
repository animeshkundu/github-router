# First-Mate Autonomy: Tooling & Ergonomics Audit + Backlog

> Consolidated register of what the first-mate CEO needs to drive a repo **autonomously, all the way to MERGE, and to the greatness bar** — and where the tools/ergonomics are missing or hard. Built from four parallel audits (2026-07-14): merge/governance, lifecycle-completeness, ergonomics, observability. Each row: status = **[THIS PASS]** (being built behind the honesty fix, same PR) or **[DEFERRED]** (recorded for a later pass).

## The root cause (one line)
The bar (Pillar D, EUXD, the greatness definition) was raised faster than the tools were built or **wired**. ~18 lifecycle service functions exist in `src/lib/agent/service.ts`, unit-tested, but are **dead code** — never surfaced as an MCP tool or wired into the `advance()` drive loop. The loop only observes units it dispatched + their PR + a CI *rollup*. So SCOPE→BUILD→REVIEW→MERGE is well-tooled; DISCOVER/LAUNCH/MEASURE/GROW and the entire verification layer are not. **Much of "make it complete" is wiring, not building.**

## Definition of complete (authoritative)
A task is complete only when its PR is **MERGED** (research → plan → plan-review → implement → code-review → PR → merge). Anything not merged must be drivable to merge or must **surface**. A mission is complete only when all required units are merged.

---

## Tier 1 — reliably reach MERGED  [THIS PASS]
| id | finding | file:line | fix |
|----|---------|-----------|-----|
| T1.1 | **Silent-no-op verdict** — `advance.model_answers.verdict` is untyped; a mis-shaped verdict for a request `kind` is dropped silently (only `consola.debug`) → the CEO loops on the same request forever. A correctness trap and a source of "nothing moves." | `tools.ts:337-341`, `applyModelAnswer` | Emit a per-kind `verdict_schema` inside each `needsModel` payload; make a malformed verdict a **visible reject** (push to `applied`/an `errors` field), never a silent drop. |
| T1.2 | **No update-branch** — a PR behind base under a strict/up-to-date ruleset (which the playbook mandates) can never merge; dead `{kind:"mark_rebase"}` stub proves it was designed. | `types.ts:393`, `controller.ts:2194`; svc `updateBranch` added | Wire `mark_rebase` action: on observed `BEHIND`, call `updateBranch(pr, headSha)`; count as verified progress. |
| T1.3 | **Conflict-blindness** — the drive loop never reads `mergeable`/`mergeable_state`; a conflicted PR is invisible and sits `noop`. | `observe.ts` (no mergeable in `Observed`) | Feed `mergeable` into `Observed`; add a `conflict` validation state + `author_fix` steer ("resolve the conflict"). |
| T1.4 | **Autonomous merge** (user: autonomous by default) — mechanism solid but human-policy-gated (`recordApproval` only from a human decision). | `state-machine.ts` floor_passed→escalate_human | On `floor_passed` + a **second cross-lab verifier's concurrence**, the controller issues the approval **through** `recordApproval`/`verifyAndConsumeApproval` (head/base-bound, single-use — never bypass). Human-gate = per-repo opt-out flag. |
| T1.5 | **CI failure detail collapses to `"failing"`** — `getRequiredChecksForSha` fetches failing job names/URLs but `observe.ts getCiSafe` discards them; `getWorkflowRun` is dead; no log/annotations reader. `author_fix` gets a bare enum. | `observe.ts getCiSafe`, `service.ts:856` (dead), `controller.ts:684` | Thread `failing[].name/url` through `Observed.ci` into the `author_fix` payload; add `getWorkflowRunLogs`/annotations reader (bounded/truncated). |
| T1.6 | **`merge_pr` get-then-merge dance** — requires `expected_head_sha` but the board carries no `headSha`, forcing a side-channel fetch. | `tools.ts:551`, `BoardUnitRow` | Add `headSha`/`baseRef` to board rows; note irreversibility in the `merge_pr` description. |

## Tier 2 — verify, discover, and wire the dead code  [THIS PASS]
| id | finding | fix |
|----|---------|-----|
| T2.1 | **Verify-by-browsing untooled under `--agents`** — browser tools are a separate `--browse` opt-in + need local Chrome; Pillar D + EUXD mandate rendered-pixel proof with no runtime warning. | Make `--agents` imply `--browse` (with the install-fallback message) **or** have the CEO assert browser availability and escalate when absent; document the coupling. |
| T2.2 | **No journey-capture/baseline tool** — even with `--browse`, only raw `navigate`/`screenshot`; the eval's before/after pinned-journey comparison is model-memory. | Add a `capture_journey`/baseline-pair tool (store before/after screenshots + a diff verdict) as an evaluator-owned affordance. |
| T2.3 | **PR diff content invisible** — `getPullRequestDiffSummary` drops the per-file `patch`; `judge_review`/`review_plan` (non-delegable) can't see changed lines. | Add a bounded diff-content reader (per-file `patch` up to a byte cap). |
| T2.4 | **Human review bodies filtered out** — `observe.ts verifierReviewSafe` only surfaces the Copilot bot's review body; a human's `CHANGES_REQUESTED` prose never reaches the CEO. No inline-comment reader. | Drop the author filter (or add a parallel path); add a bounded inline-comment reader. |
| T2.5 | **No deploy/live-site verify tool** — `BUILD_SHA==HEAD` is a shell instruction; no Pages/deployment status read. | Add `verify_live_deploy(url, expectedSha)` (curl + compare → structured verdict) + surface Pages/deployment status in observe. |
| T2.6 | **Inbound discovery missing** — nothing lists inbound issues/Dependabot PRs/community PRs (why #70-79 sit). Service `listInboundIssues/PRs` added. | Add `list_inbound` MCP tool surfaced in `board`/`advance`; optional lightweight triage units. |
| T2.7 | **~18 dead-code service fns unwired** — releases, branch-protection, repo-settings, environments, Pages, workflow-run, inbound (incl. the 9 just added). | Wire each into an MCP tool (governance group) and/or the drive loop with a verification-evidence handle for the greatness checklist. |
| T2.8 | **Repo-health evidence hand-rolled** — ruleset read, code-scanning/Dependabot alerts, scorecard, community profile, dependents are raw `gh api`. | Add typed bounded read tools (ruleset state, alert counts, community-profile completeness, dependents count). |

## Tier 3 add — greenfield  [THIS PASS]
| id | finding | fix |
|----|---------|-----|
| T3.0 | **No greenfield repo creation** — `scaffold_repo` assumes an existing repo (`getRepositoryDetails` throws on 404); no `POST /user/repos` or `/orgs/.../repos` anywhere. Can't go zero-to-one. | Add `createRepo(owner?, name, opts)` service fn + a `create_repo` tool (or fold into `start_mission`/`scaffold_repo` greenfield path). |

---

## DEFERRED — recorded comprehensively for a later pass
### Outcome measurement (the "measure" phase — currently a total blind spot)
- **D1. Analytics/metrics reader.** No tool reads activation/retention/funnel/Sean-Ellis; `GC_lagging` ("the thing that means great") is structurally unprovable. Needs a thin GA4/PostHog Data API client + a durable metric store (the strategy store's `greatnessChecklist`/`decisionLog` has the shape but nothing populates it from a real source). External-vendor auth is the hard part.
- **D2. Aha/activation instrumentation affordance** — a way for the CEO to define + verify the activation event without a full analytics build.

### Project management
- **D3. GitHub Projects v2 / milestones / labels.** Zero surface: no `projectsV2`, no milestones, labels read-only, `createIssue` sets only title/body (no labels/assignee/milestone). The CEO can't organize a backlog, link issues↔PRs, or track a milestone — only fan out local-ledger units.

### Deploy/launch → measure observability
- **D4. Pages/deployment status observation** — `setPagesSource` is write-only + dead; no `GET /pages`, no `/deployments` read; the drive loop is blind to whether a deploy succeeded. (Partly addressed by T2.5's verify tool; full observation deferred.)

### Iterate/grow
- **D5. Changelog regeneration** (scaffolded once, no regen tool). **D6. Opportunity-tree/RICE** structure (prose-only). **D7. Launch-channel artifacts** (Show HN/PH/badges — prose; external posting stays human-gated).

### Ergonomic polish (edges; happy path is sound)
- **D8. `abandon_mission` doesn't abandon** — local-ledger-only; open PRs stay open, cloud agents keep running. Reword AND/OR make it sweep-and-close correlated PRs + cancel tasks.
- **D9. Look-alike tool descriptions** — `board`/`advance`/`mission_status` indistinguishable from the surface; one differentiating clause each.
- **D10. `add_units` deps are same-batch-only + silent-drop** — add `dependsOnUnitIds` (stable ids, cross-batch) + document the silent-drop.
- **D11. Heartbeat 3-tool order-sensitive dance** — a compound `ensure_heartbeat(cadenceSeconds)` primitive (create-fresh-then-reap) collapses it to one call.
- **D12. `scaffold_repo` `detection_overrides` untyped blob** vs a `.strict()` validator → 400 on a guessed key. Emit the real object schema.
- **D13. On-demand session-log read tool** — the excerpt only reaches the CEO inside an escalation payload; add an independent read + expose `finished`/`tools[]`.
- **D14. `write_strategy.decisionLog` unbounded** — cap server-side (last N + rolled-up summary) or add `read_strategy` `since`/`limit` so continuity doesn't cost growing context.
- **D15. Discovery-skill wiring** — `mcp__search__web`/`worker-explore` exist + reach the CEO but no first-mate skill instructs their use for DISCOVER/NICHE/POSITION (one-line skill fix — cheap; could move to THIS PASS).
- **D16. Ownership wording** on merge/close/mark_ready looser than the code's unit-PR correlation → surprising `UNOWNED_PR`. Align wording.
- **D17. Conductor CEO spawn-brief is dense prose** — no structured/validated handoff; a slip silently degrades the fleet. Structured brief + return-shape validation.

## Genuinely good (keep — for calibration)
`nextWakeSeconds` (no CEO-side math), sane `start_mission` defaults validated at input time, Tier1 auto-answer shadow routing, the drain-then-arm-then-yield loop shape, `parseSessionLog` distillation, `submitReview(APPROVE)` already wired for a passing judge_review. The friction is at the edges, not the core happy path.
