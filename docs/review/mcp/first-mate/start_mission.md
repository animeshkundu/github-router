# Review: `mcp__first-mate__start_mission`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__start_mission` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `start_mission` |
| Definition | `src/lib/first-mate/tools.ts:220-265` (via the `tool(...)` factory at `:189-217`) |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196-202`), plus a per-call `hasAgentToken()` re-check in the factory wrapper (`tools.ts:201-209`) |
| Backing model / endpoint | server-side fn (persists a `Mission` row; no model call at registration — see `tools.ts:236-264`) |
| Write-capable | no (writes only local durable state via `upsertMission`; it does NOT touch GitHub — GitHub work happens on later `advance()` wakes) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:222`):

> Register a first-mate mission for one or more GitHub repositories. Unit decomposition is handled by later controller/model wakes.

Input-schema fields (`tools.ts:223-235`), required set = `["goal","repos","acceptance_criteria"]`:

- `goal` (string, **required**): "Mission goal."
- `repos` (array of strings, **required**): "Repositories as owner/name strings."
- `acceptance_criteria` (string, **required**): "User-blessed acceptance criteria for the mission."
- `priority` (number, optional): "Optional numeric priority; higher values are handled by controller policy."
- `house_rules` (string, optional): "Optional repository or operator constraints."
- `default_model` (string, optional): "Model the GitHub cloud coding agent uses for this mission's tasks; defaults to gpt-5.6-sol, with gpt-5.5 as fallback."
- `plan_gate` (enum `["hard","soft"]`, optional): "Plan-review gate. hard (default) requires the flow's review before build and re-plans on a rejecting review; soft auto-advances a passing plan review to build without human approval but escalates a rejecting review to a human."
- `ci_required` (boolean, optional): "When true, refuse merge approval if the repository reports no CI for the PR head."

Schema shape confirmed from the helpers: `objectSchema` emits `type:"object"`, `required`, `additionalProperties:false` (`tools.ts:1458-1465`); so unknown fields are rejected at the JSON-schema layer.

### 2b. System prompt (`--append-system-prompt`)

`start_mission` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). No first-mate *tool* is named there. The group is surfaced only via a single skill sentence, gated on `agentToolsAvailable` (`peer-mcp-personas.ts:617-620`), verbatim the `agentToolsAvailable === true` branch:

> Four injected skills (invoke by name): `/gh-research` saturates an ask's unknowns into a confidence-tagged, root-cause brief that grounds planning; `/gh-orchestrate` right-sizes a blind-spot-elimination pipeline whose nodes delegate to these tools; `/gh-floor-keeper` is the done-checkpoint cross-lab verification, where different-lab reviewers propose and the executable gate decides; `/gh-first-mate` drives the durable GitHub cloud-agent loop. They suit non-trivial, role-separable work. Only executable checks are deterministic; they do not catch a wrong spec, so user-blessed acceptance criteria plus the checkpoint are the defense.

So the model learns first-mate exists (the `/gh-first-mate` clause) and the acceptance-criteria/spec framing, but reaches `start_mission` and its schema only through the skill and `tools/list`. This is by design (`peer-mcp-personas.ts:546-547` docstring: "Conditionally lists gh-first-mate only when `agentToolsAvailable` (mirrors `agentToolsEnabled()`)"). Note the skill clause depends on BOTH `workerToolsAvailable` (the enclosing `if` at `:616`) AND `agentToolsAvailable` — so if the worker backend is gated out but agents are on, the `/gh-first-mate` sentence does not appear at all (see finding).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** — the mirrored CLAUDE.md carries the same `buildPeerAwarenessSnippet` text as 2b, so the only first-mate mention in the injected CLAUDE.md is the `/gh-first-mate` skill sentence. `start_mission` and its schema are not re-documented there.

Checked-in repo CLAUDE.md: the root `CLAUDE.md` "First-mate cloud-agent controller (`--agents`)" section documents the loop ("Claude starts missions, wakes `advance()`, answers compact `needsModel` requests"), the gate ("`agentToolsEnabled()` also sees the second GitHub write token"), durable state, and the human-gated merge. It agrees with the code: the `agents` capability, the `--agents`/`GH_ROUTER_ENABLE_AGENTS=1` opt-in plus agent-token requirement, and mission registration are all consistent. `docs/first-mate-design.md:26-28` describes `start_mission` field-for-field (goal, repos, acceptance criteria, optional priority/house rules/default_model, gpt-5.6-sol default (gpt-5.5 fallback)) and `:286` / `:414` confirm "registration only; unit decomposition happens on later wakes" — matching `tools.ts:236-264`. The design doc does **not** mention `plan_gate` or `ci_required` anywhere (`grep` for both returns no matches) — a doc gap, not a code contradiction (see 3c/findings).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The description tells the model WHAT the tool does ("Register a first-mate mission") and sets expectation on decomposition timing ("handled by later controller/model wakes"), which correctly steers the model away from expecting immediate GitHub work. There is no explicit "when to use / when NOT to use" clause, but the group-level skill (`/gh-first-mate`) carries the routing, so the per-tool description carrying only the registration semantics is acceptable. The one-liner is honest that this is a registration primitive, not the whole flow.
- **Accuracy vs implementation.** Verified accurate:
  - `default_model` "defaults to gpt-5.6-sol (gpt-5.5 fallback)" matches `DEFAULT_CODEX_MODEL = "gpt-5.6-sol"` (first fallback `gpt-5.5`) (`src/lib/port.ts:155`), resolved via `resolveCloudAgentModel` (`tools.ts:245`, `task-model.ts:32-59`). An explicit invalid model throws FAST at input time inside the tool try/catch (`tools.ts:240-245`), so the "defaults to gpt-5.6-sol" wording (with gpt-5.5 fallback) plus fail-fast behavior are consistent.
  - `plan_gate` semantics match the controller: `planGateOf` treats absent/`"hard"` as hard and `"soft"` as soft (`controller.ts:2184-2185`); on a rejecting (`refine`) review, `soft` escalates to a human decision (`controller.ts:936-941`) while `hard` re-plans autonomously; an `approve` verdict re-dispatches build in both modes (`controller.ts:894-929`). The description's "hard (default)" and "soft escalates a rejecting review to a human" are correct.
  - `ci_required` matches `evaluateMergeSafety`: when `mission.ciRequired === true` and the head reports no check runs, merge is refused (`controller.ts:861-866`). The description's "refuse merge approval if the repository reports no CI for the PR head" is accurate.
  - `acceptance_criteria` is genuinely consumed downstream (definition-of-done and the agent-question classifier: `controller.ts:2240/2247/2255/2278`, `classifier.ts:130-135`, `dod.ts:11-14`), so requiring it is justified, not decorative.
- **Schema minimality.** Every field is either required, model-tunable in a way that changes mission behavior, or actionable:
  - `goal`, `repos`, `acceptance_criteria` — required, load-bearing.
  - `priority`, `house_rules`, `default_model`, `plan_gate`, `ci_required` — each maps to a distinct persisted `Mission` field that changes controller behavior. No echoed-input or diagnostic-only fields. This is compliant with the "ruthlessly minimal MCP tool surface" principle.
  - Minor: `priority`'s description ("higher values are handled by controller policy") is vague on the actual ordering effect, but it is a genuine tunable, not surface bloat.

### 3b. System-prompt coverage

- **Named or omitted?** Omitted at the tool level; only the group is surfaced via the `/gh-first-mate` skill sentence. This is by design and consistent with how the snippet handles other groups (it names skills/servers, not individual first-mate tools). Acceptable — the skill is the documented entry point and it carries the acceptance-criteria framing that is the most important routing signal for this tool.
- **Accurate & non-redundant.** The skill sentence ("`/gh-first-mate` drives the durable GitHub cloud-agent loop") is accurate and does not duplicate the description. The trailing "user-blessed acceptance criteria plus the checkpoint are the defense" reinforces the `acceptance_criteria` field's importance without anchoring.
- **Framing-constraint compliance.** No imperatives, no hedges, no anchors disguised as description. Compliant.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted.** The injected peer-awareness block is the same text as 2b — one skill sentence, no drift. The checked-in root CLAUDE.md "First-mate cloud-agent controller" section agrees with the code on the gate, the loop, and registration semantics.
- **Design-doc gap.** `docs/first-mate-design.md:26-28` enumerates `start_mission`'s fields but omits `plan_gate` and `ci_required` entirely (both grep to zero matches in the doc), even though these two fields carry the richest, most consequential semantics (autonomous-vs-human plan escalation; merge-blocking on missing CI). The code and the tool description are the source of truth and both are correct, so this is a documentation completeness gap, not a correctness contradiction.

### 3d. Cross-surface consistency

No contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ code. All four agree that `start_mission` is registration-only, gated by `agents`, defaults model to gpt-5.6-sol (gpt-5.5 fallback), and defers decomposition. The only cross-surface asymmetry is completeness: `plan_gate`/`ci_required` live only in the tool description + code, absent from the design doc.

## 4. Findings

- **[Suggestion]** `docs/first-mate-design.md:26-28` — the `start_mission` field list omits `plan_gate` and `ci_required`, the two behaviorally richest optional fields. Fix: add one line each to the `start_mission` bullet (e.g. "optional `plan_gate` (hard|soft, default hard) and `ci_required`") so the design doc matches the shipped schema. Non-blocking: the tool description already carries the correct semantics.
- **[Suggestion]** `src/lib/peer-mcp-personas.ts:616-620` — the `/gh-first-mate` skill sentence is nested inside `if (opts.workerToolsAvailable)`, so on a tier where `agentToolsAvailable` is true but `workerToolsAvailable` is false (worker sentinel model absent from the catalog), the skill sentence is dropped and the model loses the only system-prompt pointer to first-mate, even though `start_mission` is still live in `tools/list`. Fix: emit the `/gh-first-mate` clause based on `agentToolsAvailable` independent of the worker gate (or add a standalone one-sentence agents pointer outside the worker `if`). Low likelihood in the canonical enterprise tier where both gates pass together, hence Suggestion, but it is a real surface-coverage hole worth closing.
- **[Suggestion]** `src/lib/first-mate/tools.ts:226` — `acceptance_criteria`'s description ("User-blessed acceptance criteria for the mission") does not convey that these criteria become the definition-of-done the cloud agent and plan reviewer verify against (`dod.ts:11-14`, `controller.ts:2247/2278`). A short addition ("used as the definition-of-done for planning, review, and the merge gate") would improve the routing signal for a field the model must get right. Non-blocking.

No Critical or Important findings: the description is accurate against the code, the schema is minimal, and the injected surfaces are mutually consistent.

## 5. Verdict

Y — `start_mission`'s injected surface is correct, minimal, and consistent; the description accurately conveys registration semantics, the gpt-5.6-sol default (gpt-5.5 fallback), and the plan-gate/CI-required semantics, all verified against the controller. Single most important fix: document `plan_gate` and `ci_required` in `docs/first-mate-design.md:26-28` so the design doc stops trailing the shipped schema.
