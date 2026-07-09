# Review: `mcp__first-mate__add_units`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__add_units` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `add_units` |
| Definition | `src/lib/first-mate/tools.ts:572` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`): opt-in (`--agents` / `GH_ROUTER_ENABLE_AGENTS=1`) AND a non-empty `state.githubAgentToken` |
| Backing model / endpoint | server-side fn (`addUnitsToMission`, `src/lib/first-mate/controller.ts:1339`) — no model call |
| Write-capable | yes (persists new `UnitRow`s via `deps.upsertUnit` + mutates the mission; no GitHub write on this call itself — dispatch happens later in the controller loop) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/first-mate/tools.ts:574`):

> `Add dispatchable units to an existing active first-mate mission. DependsOn entries are 0-based indices within the submitted units list.`

Input schema (`src/lib/first-mate/tools.ts:575-588`):

- `mission_id` (string, **required**): `Mission id to add units to.`
- `units` (array of objects, **required**): `Units to add to the mission.` Each item (`title` required):
  - `title` (string, **required**): `Unit title.`
  - `repo` (string, optional): `Optional owner/name repo. Defaults to the mission's first repo.`
  - `agent` (enum `copilot|anthropic|openai`, optional): `Optional cloud-agent provider. Defaults to copilot.`
  - `dependsOn` (array of number, optional): `Optional 0-based dependency indices into this units list.`
  - `model` (string, optional): `Optional model override for this unit.`

### 2b. System prompt (`--append-system-prompt`)

`add_units` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555`). No individual first-mate tool is named. The only first-mate reference is the skill sentence, emitted only when `agentToolsAvailable === true` (`src/lib/peer-mcp-personas.ts:617-618`), verbatim:

> ``/gh-first-mate` drives the durable GitHub cloud-agent loop.``

(embedded in the "Four injected skills (invoke by name): …" sentence). The snippet defers all first-mate tool detail to the `/gh-first-mate` skill — consistent with the design that the model-facing loop is thin and skill-driven.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b, so the injected CLAUDE.md names `add_units` **nowhere** — only the `/gh-first-mate` skill sentence.

Checked-in root `CLAUDE.md` "First-mate cloud-agent controller (`--agents`)" section (`CLAUDE.md:137-139`) enumerates the first-mate tool surface: `start_mission`, `__advance`, `__board`, `__mission_status`, `__scaffold_repo`, and "PR operator tools including `__mark_ready`". `add_units` is **not** in that list and is not a PR operator tool, so the root CLAUDE.md's tool enumeration silently omits it.

`docs/first-mate-design.md` DOES document it: the tool list at `docs/first-mate-design.md:38-39` (`append dispatchable units to an active mission using the same unit-creation path as decompose`) and the accuracy note at `docs/first-mate-design.md:289-291` ("Operators can append more units later with `add_units`; dependency indices in that call are local to the submitted unit list and are resolved to stable unit ids before dispatch"). Both agree with the code.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Good. "Add dispatchable units to an existing active first-mate mission" states the action and the precondition (mission must exist AND be active — enforced at `tools.ts:593-598`, returning `MISSION_NOT_FOUND` / `MISSION_NOT_ACTIVE`). The `dependsOn` clause pins the one non-obvious semantic (0-based, local to the submitted list). There is no explicit "when NOT to use" signal, but the surface is small and the precondition is stated, so misroute risk is low.
- **Accuracy vs implementation**:
  - "0-based indices within the submitted units list" is accurate: `dependsOnIndices` (`controller.ts:1287-1300`) filters to integer indices that are `!== rawIndex` (self excluded) and present in `validRawUnitIndices`, then `addUnitsToMission` maps them through `idByRawIndex` to stable unit ids (`controller.ts:1400-1402`).
  - **Undocumented behavior**: out-of-range, self-referential, non-integer, and titleless-target `dependsOn` entries are **silently dropped**, not rejected (`controller.ts:1293-1299`). Only a *cyclic* graph throws (`controller.ts:1393-1394`, `hasDependsOnCycle`). So a bad index is a silent no-op dependency, which the description does not warn about.
  - **Indices span only the submitted list, not existing units**: `dependsOn` cannot reference units already on the mission — it resolves purely against the current `units[]` payload's raw indices (`idByRawIndex` is populated only from `rawUnits`, `controller.ts:1367-1391`). Pre-existing units participate only via goal-hash dedup (duplicate spec → maps to the existing id), not as addressable dependency targets. The phrase "within the submitted units list" implies this but does not state that a cross-batch dependency is impossible.
  - **Silent dedup**: a `(title, repo)` pair whose `goalHash` already exists on the mission (or repeats within the batch) is skipped and **not counted** in the returned `added` (`controller.ts:1375-1380`). So `added` can be less than `units.length` with no per-unit reason surfaced. Not stated in the description; low-impact but can confuse a caller that expects `added === units.length`.
- **Schema minimality** (per `docs/peer-mcp-design.md` "ruthlessly minimal MCP tool surface"): all fields pass. `mission_id` + `title` are required to act; `repo` (multi-repo mission targeting), `agent` (provider choice), `dependsOn` (ordering), `model` (per-unit override, validated eagerly at `controller.ts:1386` via `resolveCloudAgentModel`) are each model-tunable and change dispatch outcomes. No echoed-input or diagnostic-only fields. Return shape `{missionId, added}` (`tools.ts:605`) is minimal and actionable.

### 3b. System-prompt coverage

- **Omitted** — by design. `add_units` is a low-frequency operator tool; the thin-loop philosophy (root CLAUDE.md:139, `docs/first-mate-design.md`) routes all first-mate detail through the `/gh-first-mate` skill rather than the always-on snippet. Naming every first-mate tool in the snippet would violate the snippet's own economy. Acceptable gap, not a defect.
- **Accurate & non-redundant**: the skill sentence is generic ("drives the durable GitHub cloud-agent loop") and does not contradict the tool.
- **Framing-constraint compliance**: the skill sentence is descriptive, no imperatives/hedges/anchors. Compliant.

### 3c. CLAUDE.md coverage

- **Injected block**: covers `add_units` only transitively via the `/gh-first-mate` skill sentence (same as 2b) — no drift, because it asserts nothing tool-specific.
- **Checked-in root CLAUDE.md**: `CLAUDE.md:139` enumerates the first-mate tools but **omits `add_units`** from the list (it is not a PR operator tool, so "PR operator tools including `__mark_ready`" does not cover it). This is a documentation completeness gap in the repo doc, not a model-facing-surface defect — the mirrored CLAUDE.md the model sees never names individual first-mate tools anyway.
- **`docs/first-mate-design.md`**: accurately documents `add_units` and its dependency-index semantics (`:38-39`, `:289-291`); agrees with the code.

### 3d. Cross-surface consistency

- Description ↔ code: consistent on the stated facts; the description under-specifies the silent-drop, silent-dedup, and same-batch-only behaviors (see 3a).
- System prompt ↔ description: no conflict (snippet is silent on the tool).
- Root CLAUDE.md ↔ design doc: the root section's tool enumeration omits `add_units`; the design doc includes it. Minor internal inconsistency between the two checked-in docs.

## 4. Findings

- **[Suggestion]** `CLAUDE.md:139` — the first-mate tool enumeration omits `add_units` (not a PR operator tool, so not covered by "PR operator tools including `__mark_ready`"). Fix: add `__add_units` to the parenthetical list so the root doc matches the served surface and `docs/first-mate-design.md:38`.
- **[Suggestion]** `src/lib/first-mate/tools.ts:574` — the description does not say that invalid `dependsOn` indices (out-of-range, self, non-integer, pointing at a titleless entry) are **silently dropped** while a *cycle* is rejected (`controller.ts:1293-1299`, `:1393-1394`). A caller cannot tell a dropped dependency from a honored one. Fix: append a short clause, e.g. "Invalid or self indices are ignored; a cyclic dependsOn graph is rejected."
- **[Suggestion]** `src/lib/first-mate/tools.ts:574` — the description does not note that `dependsOn` targets only the submitted `units[]` (raw indices), so a new unit cannot depend on a unit already on the mission, and that duplicate `(title, repo)` specs are silently deduped and excluded from `added` (`controller.ts:1375-1380`). Fix: clarify "indices reference only this call's units" and that "`added` may be less than `units.length` when a unit duplicates an existing one." Low-impact; the return value already surfaces the true count.

No Critical or Important findings: the gate is correct, the precondition ("active mission") is both stated and enforced, the schema is minimal, and the only inaccuracies are omissions of edge-case behavior, not wrong claims.

## 5. Verdict

**Y** — the injected surface is correct, minimal, consistently gated, and well-routed; `dependsOn`'s 0-based/same-batch semantics are clear and the active-mission precondition is stated and enforced. Single most valuable fix: add the silent-drop / same-batch-only clause to the description (`tools.ts:574`) so the model knows an invalid `dependsOn` index is ignored rather than rejected.
