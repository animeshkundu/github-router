# Review: `mcp__first-mate__board`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__board` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `board` |
| Definition | `src/lib/first-mate/tools.ts:411` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`) |
| Backing model / endpoint | server-side fn (`buildBoard` at `src/lib/first-mate/controller.ts:2492`) |
| Write-capable | no |

Gate detail: `agentToolsEnabled()` requires `(state.agentsEnabled || GH_ROUTER_ENABLE_AGENTS=1)` AND a non-empty `state.githubAgentToken` (`src/lib/mcp-capabilities.ts:196-202`). The whole `first-mate` group is registered only under `--agents` with the second GitHub write token; there is no per-tool sub-gate for `board`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/first-mate/tools.ts:413`):

> Read compact board status. Defaults to active missions only; pass include_all to include inactive missions.

Input schema (`src/lib/first-mate/tools.ts:414-416`) — one optional field, none required:

- `include_all` (boolean): "When true, include inactive missions in the board. Default returns active missions only and summarizes inactive counts."

Return shape (`src/lib/first-mate/tools.ts:420-423`): `{ board: buildBoard(units, missions, { includeAll }), inactiveSummary: summarizeInactiveMissions(missions) }`. `board` is an array of per-mission rows (`missionId`, `title`, `status`, `repos`, per-phase `counts`, `blocked`, `units[]`, terminal `summary: {done, failed}`) built at `controller.ts:2492-2538`; `inactiveSummary` is `{done, abandoned, failed}` from `controller.ts:2540-2550`.

### 2b. System prompt (`--append-system-prompt`)

`board` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555`). No individual `first-mate` tool is named. The only mention of the group is the `/gh-first-mate` skill clause, appended to the "injected skills" sentence and gated on `agentToolsAvailable === true` (`src/lib/peer-mcp-personas.ts:617-618`):

> `/gh-first-mate` drives the durable GitHub cloud-agent loop.

(Full sentence: "Four injected skills (invoke by name): `/gh-research` … ; `/gh-orchestrate` … ; `/gh-floor-keeper` … ; `/gh-first-mate` drives the durable GitHub cloud-agent loop. …")

So the model learns the group exists via a skill pointer only; it never sees `board` (or `advance` / `mission_status`) named in the system prompt. This is by design — the class comment at `src/lib/peer-mcp-personas.ts:546-547` states the snippet lists `gh-first-mate` only when `agentToolsAvailable`, and it deliberately does not enumerate the individual `first-mate` tools.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: peer-awareness (the same snippet text as 2b, mirrored into `CLAUDE.md`). At the injected level `board` is covered only by the `/gh-first-mate` skill sentence — not named individually.

Checked-in root `CLAUDE.md` section "First-mate cloud-agent controller (`--agents`)" (`CLAUDE.md:137-139`) names the tool once, inside the server-contents list:

> `--agents` (or `GH_ROUTER_ENABLE_AGENTS=1`) adds the `first-mate` scoped MCP server (`mcp__first-mate__start_mission`, `__advance`, `__board`, plus `__mission_status`, `__scaffold_repo`, and PR operator tools including `__mark_ready`) only when `agentToolsEnabled()` also sees the second GitHub write token.

This agrees with the code: gate (`agentToolsEnabled()` + second write token), group name, and `__board` membership all match. The root section does not describe `board`'s behavior beyond listing it, and does not differentiate it from `__advance` (which the same section describes as the wake loop: "Claude starts missions, wakes `advance()`, …"). The behavioral differentiation lives in `docs/first-mate-design.md:29-47, 64-65`, which is precise: `advance` = wake + return board; `board` = "read the active board without a wake"; `mission_status` = per-mission status; all three default to active-only.

## 3. Assessment

### 3a. Description quality

- Clarity & routing signal: The description is accurate but under-specifies the routing signal. The load-bearing distinction between `board` and `advance` is that `board` reads WITHOUT waking the controller (`docs/first-mate-design.md:33`), whereas `advance` "returns the compact board" as a side effect of a wake (`tools.ts:332`, return at `tools.ts:397-408`). The word "Read" implies read-only, but a model choosing between the two tools is not told that `board` is the no-side-effect path and `advance` is the one that drives state. Neither `board`'s nor `advance`'s description cross-references the other, so the model has no in-description signal for when to call `board` vs `advance` vs `mission_status`. In practice the `/gh-first-mate` skill is what teaches the loop (report from the board rather than rereading diffs — `docs/first-mate-design.md:127-130`), so the routing gap is mitigated but not closed at the description layer.
- Overlap with `advance`: `advance` returns the identical `board` value (both call `buildBoard`; `advance` at `tools.ts:398`, `board` at `tools.ts:421`) plus `needsModel`/`needsHuman`/`applied_count`/`nextWakeAt`. `board` is the strict read-only subset — its reason to exist is "observe without mutating/dispatching." That is a legitimate separation, but the descriptions do not state it, so a model could reasonably call `advance` when it only wanted to look (incurring a GitHub-observing, dispatch-capable wake) or call `board` in a loop expecting progress that only `advance` produces.
- Overlap with `mission_status`: `board` (per-mission phase counts + unit rows + blocked count) and `mission_status` (`tools.ts:648`, per-mission compact status, optional `mission_id` filter) are close cousins with different shapes. `mission_status` adds a `mission_id` filter that `board` lacks; `board` returns the richer per-unit rows. The two descriptions are near-parallel ("Read compact board status …" vs "Read compact status for all first-mate missions, or for one mission id …") and neither says how they differ in output, which is a mild discoverability cost.
- Accuracy vs implementation: Description matches the code exactly. Default is active-only (`includeAll ?? false` at `tools.ts:418`; filter at `controller.ts:2498`); `include_all` flips to include inactive (`controller.ts:2498`); inactive counts are summarized regardless (`inactiveSummary` always returned at `tools.ts:422`). No stale model id, default, or gate.
- Schema minimality: Compliant. The single `include_all` field is model-tunable and actionable (the model picks active-only vs full board). No echoed-input or diagnostic-only fields. The `inactiveSummary` return field is always present and gives the model an actionable "N done / abandoned / failed exist but are hidden" signal that pairs with `include_all`. Clean per the "ruthlessly minimal MCP tool surface" principle.

### 3b. System-prompt coverage

- Omitted by design. `board` is not named in `buildPeerAwarenessSnippet`; only the `/gh-first-mate` skill is pointed at (gated on `agentToolsAvailable`, `src/lib/peer-mcp-personas.ts:617-618`). The class comment at `peer-mcp-personas.ts:546-547` documents this as intentional. Given the group has 11 tools and a dedicated skill that carries the operating loop, not enumerating each tool in the always-loaded system prompt is the right minimality call — the skill is the routing surface for first-mate, and the description covers the field.
- Non-redundant: The skill sentence adds nothing the description repeats; it points at a workflow, not the tool. Good.
- Framing-constraint compliance: The `/gh-first-mate` clause is declarative ("drives the durable GitHub cloud-agent loop") with no imperative, hedge, or anchor. Compliant with the framing constraints pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- Accurate and not drifted: root `CLAUDE.md:139` names `__board` in the group's tool list and states the gate correctly (`agentToolsEnabled()` + second write token), matching `mcp-capabilities.ts:196-202`. No drift.
- The root section documents the group as a whole and the `advance` loop, but does not describe `board` beyond the list membership, nor differentiate it from `advance`/`mission_status`. The differentiation is fully covered in `docs/first-mate-design.md` (the canonical design doc the root section links to), so this is acceptable division of labor rather than a gap.
- Injected vs checked-in consistency: The mirrored peer-awareness block (skill pointer only) and the checked-in root section (group list + gate) are consistent with each other and with the code — neither over-claims about `board`.

### 3d. Cross-surface consistency

No contradictions. Description ↔ system prompt ↔ CLAUDE.md ↔ code all agree on: the gate (`agents` capability, `--agents` + second write token), read-only nature, active-only default, `include_all` semantics, and the always-present `inactiveSummary`. The only cross-surface weakness is an absence, not a contradiction: no single surface tells the model when to prefer `board` over `advance` or `mission_status` — the description omits it, the system prompt omits the tool entirely, and only `docs/first-mate-design.md` (not loaded into the model's context) spells it out.

## 4. Findings

- **[Important]** `src/lib/first-mate/tools.ts:413` — the `board` description does not signal its defining property versus `advance`: `board` reads without a controller wake, `advance` reads-as-a-side-effect-of-driving-state. A model choosing between them has no in-surface routing signal, and the two return the same `board` value. Fix: add a when-not clause to `board` ("Does not wake the controller or dispatch — use `advance` to drive state and get pending requests; use this only to observe.") and a reciprocal pointer in `advance`'s description. Low risk: the `/gh-first-mate` skill partially mitigates by teaching the loop.
- **[Suggestion]** `src/lib/first-mate/tools.ts:413,650` — `board` and `mission_status` have near-parallel descriptions and overlapping output with no stated difference (`board` = richer per-unit rows, no id filter; `mission_status` = per-mission status with optional `mission_id`). Fix: one differentiating clause each (e.g. `board` = "full active board with per-unit rows"; `mission_status` = "narrower per-mission status, filterable by `mission_id`") so the model can pick without trial calls.
- **[Suggestion]** `CLAUDE.md:139` — the root first-mate section lists `__board` but never describes it or contrasts it with `__advance`/`__mission_status`. Non-blocking since `docs/first-mate-design.md:29-47,64-65` carries the precise differentiation, but a one-line "read-only board (no wake) vs `advance` (wake) vs `mission_status` (per-mission)" in the root section would save a doc hop.

## 5. Verdict

Y — the injected surface is correct, minimal, gated properly, and framing-compliant; the single most valuable fix is adding a reciprocal when-not clause to `board`/`advance` so the model routes between "observe" (`board`) and "drive state" (`advance`) without relying on the skill alone.
