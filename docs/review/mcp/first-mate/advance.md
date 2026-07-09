# Review: `mcp__first-mate__advance`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__advance` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `advance` |
| Definition | `src/lib/first-mate/tools.ts:330` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`) — opted in via `--agents` / `GH_ROUTER_ENABLE_AGENTS=1` AND a non-empty `state.githubAgentToken`. Handler re-checks `hasAgentToken()` (`tools.ts:202,686`) |
| Backing model / endpoint | server-side fn (deterministic controller `advance()` in `src/lib/first-mate/controller.ts:2627`; no per-call model unless Tier1 live-offload fires) |
| Write-capable | yes — drives GitHub cloud agents, dispatches tasks, applies model/human answers, mutates durable ledgers |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`tools.ts:332`):

> Wake the first-mate controller once, applying model answers or human decisions, then return the compact board and pending requests.

Input-schema fields (`tools.ts:333-354`):

- `model_answers` — "Optional model judgments to apply before the wake." Array of objects with:
  - `requestId` — "Request id from a previous needsModel entry."
  - `verdict` — "Structured verdict for the request kind." (`anyProp`)
- `human_decisions` — "Optional human choices to apply before the wake." Array of objects with:
  - `requestId` — "Request id from a previous needsHuman entry."
  - `choice` — "Chosen option id or short decision text."
- `top_k` — "Maximum model and human requests to return."
- `max_in_flight_per_provider` — "Maximum active units per cloud-agent provider."
- `mission_id` — "Optional mission id to scope the drive to a single mission. Absent → global sweep across all missions."
- `include_all` — "When true, include inactive missions in the board. Default returns active missions only and summarizes inactive counts."

Required fields: none (`[]` at `tools.ts:354`).

Output object (not schema-declared, built at `tools.ts:397-408`): `board`, `inactiveSummary`, `needsModel`, `needsHuman`, `applied_count`, `nextWakeAt`, `nextWakeSeconds`, `drove`.

### 2b. System prompt (`--append-system-prompt`)

`advance` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555`). Only the group is reached indirectly, via one skill sentence emitted when both `workerToolsAvailable` and `agentToolsAvailable` are true (`peer-mcp-personas.ts:617-618`):

> Four injected skills (invoke by name): `/gh-research` … `/gh-orchestrate` … `/gh-floor-keeper` … `/gh-first-mate` drives the durable GitHub cloud-agent loop. They suit non-trivial, role-separable work. Only executable checks are deterministic; …

No individual first-mate tool (`advance`, `board`, `start_mission`, …) appears in the snippet. The routing signal for this tool lives entirely inside the `/gh-first-mate` skill body, which is injected but not part of this snippet.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b — it names only `/gh-first-mate`, not `advance`.

Checked-in repo `CLAUDE.md:137-139` (section "First-mate cloud-agent controller (`--agents`)") documents the group and names `__advance` in the tool list: "adds the `first-mate` scoped MCP server (`mcp__first-mate__start_mission`, `__advance`, `__board`, …)" and "The model-facing loop is thin: Claude starts missions, wakes `advance()`, answers compact `needsModel` requests, and relays human choices."

`docs/first-mate-design.md:29-32` documents the output contract precisely and agrees with the code: "wake the deterministic controller once; apply submitted model/human answers; return compact `board`, `needsModel`, `needsHuman`, `applied_count`, `nextWakeAt`, and `nextWakeSeconds` (… `null` when idle)." The `[60, 3600]s` clamp and `null`-when-idle claims match `wakeSeconds` (`controller.ts:2597-2606`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The one-line description accurately names the mechanism (wake once, apply answers, return board + pending requests). It is a faithful summary of the handler. But it gives no *when-to-use / when-NOT-to-use* signal and no mention of the self-wake loop (`nextWakeSeconds`) that is the whole point of the tool — that lives only in the `/gh-first-mate` skill. Standalone (skill not loaded), a model cannot learn from the description that this is a poll-until-idle heartbeat driven by `nextWakeSeconds`, nor that `board` exists as the read-only alternative when no answers are pending. Acceptable given the design decision to carry the loop protocol in the skill, but the description is thin on routing.
- **Accuracy vs implementation.** No stale facts. `mission_id` absent → global sweep is correct (`tools.ts:363` → `optionalString`, controller scopes when present). `include_all` default-false and always-returns-`inactiveSummary` is correct (`tools.ts:364,399`). The undocumented `drove` output field (false when a daemon holds the lease) is real (`tools.ts:407`) and not misdescribed — just unmentioned in the schema, which is consistent with the repo's "outputs are not schema-declared" pattern.
- **Schema minimality.** Mostly clean. `top_k`, `max_in_flight_per_provider`, `mission_id`, `include_all` are all model-tunable and actionable. The gap is `verdict: anyProp("Structured verdict for the request kind")` — see 3d and Findings. The description tells the model to send a "structured verdict for the request kind" but the schema surfaces neither the kinds nor the required verdict shape per kind, and the `needsModel` request payload the model receives (`controller.ts:652-710`) carries the domain data (goal, plan_excerpt, question, …) but NOT the expected verdict schema. `requestId`/`choice` are required and actionable.

### 3b. System-prompt coverage

- **Omitted by design.** Individual first-mate tools are deliberately not named in the snippet (`peer-mcp-personas.ts:546-547` documents "Conditionally lists gh-first-mate only when `agentToolsAvailable`"). The snippet points at the skill, and the skill carries the loop. This matches the pattern used for the other skill-fronted capabilities. Reasonable — naming eight first-mate tools in the always-loaded snippet would bloat it.
- **Accurate & non-redundant.** The one skill sentence is accurate ("drives the durable GitHub cloud-agent loop") and non-redundant with the description.
- **Framing-constraint compliance.** The snippet sentence is descriptive, no imperatives/hedges/anchors. Compliant.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted.** Both the checked-in root `CLAUDE.md:139` and `docs/first-mate-design.md:29-32` describe `advance` correctly and match the code, including the output field set and the `nextWakeSeconds` semantics. No drift found.
- **Injected vs checked-in consistency.** The injected mirror block only names `/gh-first-mate` (thin), while the checked-in root section is richer (names `__advance`, describes the thin model loop). This is the intended split — the injected snippet is deliberately minimal and defers to the skill; the checked-in doc is the reference. Consistent, not contradictory.

### 3d. Cross-surface consistency

- No contradictions between description ↔ snippet ↔ CLAUDE.md ↔ code on the *mechanism*.
- The one cross-surface weakness is the **verdict-shape contract**. Three surfaces reference "answer the needsModel requests" (description, root CLAUDE.md, design doc) but none of the model-facing surfaces (`advance` schema, the `needsModel` request payload) expose the per-kind verdict schema that `isValidVerdictShape` (`src/lib/first-mate/scheduler/shadow.ts:392-421`) and `applyModelAnswer` (`controller.ts:859`) actually require. The shapes (`review_plan` → `{decision:"approve"|"refine"}`, `judge_review` → `{pass:boolean}`, `author_fix` → `{instruction:string}`, `answer_agent_question` → `{answer:string}`, `decompose` → `{units:[{title,…}]}`) live only in server-side code and the `/gh-first-mate` skill. A model driving `advance` directly without the skill loaded has no in-band way to produce a correctly-shaped verdict.

## 4. Findings

- **[Important]** `src/lib/first-mate/controller.ts:878-930` (and siblings) — a malformed `review_plan` verdict is a **silent no-op**, not an error. `applyModelAnswer` reads `stringValue(verdict.decision)`; if it is neither `"approve"` nor `"refine"` (e.g. the model sends `{decision:"yes"}` or `{approved:true}`), neither branch fires, the unit stays blocked awaiting a plan review, and the only feedback is a `consola.debug` line the model never sees. The `applied` array (surfaced as `applied_count`) does not increment for the skipped answer, but the model gets no signal *which* answer was dropped or *why*. Combined with `verdict: anyProp("Structured verdict for the request kind")` giving the model no schema, a skill-less caller can loop indefinitely submitting wrong-shaped verdicts. Repro: with `--agents` + a decomposed mission awaiting plan review, call `advance` with `model_answers:[{requestId:"<review_plan id>", verdict:{decision:"yes"}}]` → response `applied_count` unchanged, same `needsModel` entry re-returned next wake, no error. Fix: either (a) enrich each `needsModel` request payload with a compact `verdict_schema` hint per `kind` (the model then has the contract in-band), or (b) have `advance` push a diagnostic into `applied` / a new field when a submitted `model_answers` verdict is unknown-shaped for its kind (reuse `isValidVerdictShape`), so the drop is visible and actionable rather than silent.

- **[Suggestion]** `src/lib/first-mate/tools.ts:337-341` — `verdict` description "Structured verdict for the request kind" is the weakest field text on the tool. Even without full schemas, listing the kinds and their one-key shape inline (e.g. "review_plan → {decision: approve|refine}; judge_review → {pass: bool}; author_fix → {instruction}; answer_agent_question → {answer}; decompose → {units:[{title,repo?,agent?,dependsOn?}]}") would make the tool self-describing and remove the hard dependency on the skill being loaded. This is the single highest-leverage minimality/routing improvement.

- **[Suggestion]** `src/lib/first-mate/tools.ts:332` — the description omits the self-wake-loop purpose and the `board` read-only sibling. Adding a clause like "returns `nextWakeSeconds` to schedule the next wake; use `board` for a read-only status check with no drive" would give a skill-less model the routing signal for when to call `advance` vs `board`. Non-blocking; the skill covers it today.

## 5. Verdict

**Y (with one Important fix).** The injected surface is accurate, consistent across description / snippet / CLAUDE.md / design doc, and correctly gated; the deliberate skill-fronted omission from the system prompt is sound. The single most important fix: make the per-kind verdict contract visible in-band — surface a `verdict_schema` hint (or at minimum enumerate the shapes in the `verdict` field description) and stop silently dropping unknown-shaped `review_plan` (and sibling) verdicts, so a model driving the wake-loop cannot loop blind against a contract it can't see.
