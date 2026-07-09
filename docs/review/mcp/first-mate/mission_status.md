# Review: `mcp__first-mate__mission_status`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__mission_status` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `mission_status` |
| Definition | `src/lib/first-mate/tools.ts:648` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`): `(state.agentsEnabled || GH_ROUTER_ENABLE_AGENTS=1) AND state.githubAgentToken` present |
| Backing model / endpoint | server-side fn (no model; reads durable ledgers via `readMissions()` + `loadAllUnits()`) |
| Write-capable | no (pure read: `buildMissionStatus` + `summarizeInactiveMissions`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/first-mate/tools.ts:650`):

> Read compact status for all first-mate missions, or for one mission id. Defaults to active missions only; pass include_all for inactive missions too.

Input-schema fields (`src/lib/first-mate/tools.ts:651-654`, no required fields — `[]`):

- `mission_id` (string): "Optional mission id to filter to."
- `include_all` (bool): "When true, include inactive missions in the status list. Default returns active missions only and summarizes inactive counts."

### 2b. System prompt (`--append-system-prompt`)

`mission_status` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`). Neither is the `first-mate` group as a tool surface. The only first-mate mention in the snippet is one clause of the skill sentence, emitted only when `agentToolsAvailable === true` (`src/lib/peer-mcp-personas.ts:617-620`):

> `/gh-first-mate` drives the durable GitHub cloud-agent loop.

So the model learns about `mission_status` (and every sibling first-mate tool) only indirectly, by invoking the `/gh-first-mate` skill; the tool's own `description` in `tools/list` is the sole per-tool routing signal. This mirrors the other groups: the snippet names categories/skills, not individual first-mate tools.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored CLAUDE.md carries the **same** peer-awareness block as 2b (built by the same `buildPeerAwarenessSnippet`), so the only covering text is the `/gh-first-mate` skill sentence above — `mission_status` is not named in the mirror either.

Checked-in repo root `CLAUDE.md` documents the tool in the "First-mate cloud-agent controller (`--agents`)" section (`CLAUDE.md:137-139`). It lists `__mission_status` in the surface enumeration:

> `--agents` (or `GH_ROUTER_ENABLE_AGENTS=1`) adds the `first-mate` scoped MCP server (`mcp__first-mate__start_mission`, `__advance`, `__board`, plus `__mission_status`, `__scaffold_repo`, and PR operator tools including `__mark_ready`) only when `agentToolsEnabled()` also sees the second GitHub write token.

This agrees with the code: the gate (`agentToolsEnabled()`), the second-token requirement, and the tool's existence all match. The root CLAUDE.md does not describe `mission_status` behavior beyond naming it; the fuller description lives in `docs/first-mate-design.md:34-35` ("read compact status for all missions, or one mission id") and `:46` ("the operational surface is the start/advance/board triad plus the status read") and `:64` ("`advance`, `board`, and `mission_status` default to ACTIVE missions only"). Those all agree with the code.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The description is accurate and self-consistent: "compact status," active-by-default, `include_all` for inactive, `mission_id` to scope to one. It matches `buildMissionStatus` (`tools.ts:981-1004`) and `summarizeInactiveMissions` (`controller.ts:2540`) exactly. What it does NOT convey is *when to reach for `mission_status` vs `board`* — the two descriptions are near-identical ("Read compact status for all first-mate missions..." vs `board`'s "Read compact board status..." at `tools.ts:413`), and the only real behavioral difference is that `mission_status` accepts a `mission_id` filter while `board` does not. There is no when-NOT-to-use signal steering the model away from the overlapping tool.
- **Accuracy vs implementation.** Correct. No stale model id (server-side fn, no model). The active-only default is real (`buildMissionStatus` filters `includeAll || mission.status === "active"`, `tools.ts:990`). `inactiveSummary` is always returned regardless of `include_all` (`tools.ts:664`) — consistent with "summarizes inactive counts."
- **Schema minimality.** Both fields pass the "ruthlessly minimal" bar: `mission_id` is model-tunable (scope the read) and `include_all` is model-tunable (history vs active). Neither is echoed-input or diagnostic-only. Minimal and correct.

### 3b. System-prompt coverage

- **Omitted, by design.** No first-mate tool is individually named in the snippet; the group is surfaced through the `/gh-first-mate` skill, consistent with how the other groups defer detail to skills/descriptions. Omitting `mission_status` specifically is the right call — the operator drives first-mate through the skill, and the per-tool `description` carries the routing signal.
- **Accurate & non-redundant.** The one skill sentence is accurate and does not duplicate the description.
- **Framing-constraint compliance.** The skill sentence is declarative ("drives the durable GitHub cloud-agent loop"), no imperatives, no hedges, no anchors. Compliant.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted.** Root `CLAUDE.md:139` names `__mission_status` and the gate correctly; `docs/first-mate-design.md:34-35,46,64` describe it as a compact status read, matching the code. No drift found.
- **Injected block vs checked-in root CLAUDE.md.** The injected mirror block (peer-awareness) does not name the tool; the checked-in root CLAUDE.md does. That asymmetry is expected — the mirror is model-facing awareness (skill-level), the root doc is contributor-facing (tool-level). No contradiction.

### 3d. Cross-surface consistency

One consistency gap, and it is with the **review brief**, not between the shipped surfaces: the brief characterized `mission_status` as "Detailed status for a mission (deeper than board)." The code does not support "deeper." `buildMissionStatus` (`tools.ts:993`) builds each row by calling the **same** `buildBoard` used by the `board` tool, with `includeAll: true` per-mission, and copies `counts` / `blocked` / `units` / `summary` straight from that board row (`tools.ts:994-1002`). It actually **omits** the `repos` field that `buildBoard` rows include (`controller.ts:2530`), so a `mission_status` row is marginally *less* detailed than a `board` row, not more. The real differentiators are (1) `mission_status` supports a `mission_id` filter, `board` does not; (2) nothing else. The description ("compact status") and the design doc ("compact status," "the status read") are internally consistent and correctly say "compact"; only the brief's "deeper than board" framing is wrong.

## 4. Findings

- **[Important]** `src/lib/first-mate/tools.ts:650` (+ `:413`) — `mission_status` and `board` descriptions are near-duplicates with no differentiator, and the actual distinction (mission-id filtering, not depth) is invisible to the model. A model that wants one mission's status has no signal that `mission_status` is the mission-scoped read and `board` is the portfolio read. Fix: give `mission_status` a distinguishing clause, e.g. append "Use `mission_id` to scope to a single mission; use `board` for the whole active portfolio." (mirror-reference the sibling by name). This is the one substantive gap.
- **[Suggestion]** `src/lib/first-mate/tools.ts:994-1002` — `buildMissionStatus` rows drop the `repos` field that `buildBoard` rows carry (`controller.ts:2530`). If `mission_status` is meant to be the richer per-mission read (as the brief implied), it is currently a strict subset of a board row minus `repos`. Either intentionally add per-mission detail (e.g. `repos`, acceptance criteria, terminal-unit breakdown) so the tool earns a distinct identity, or accept that it is "board filtered by mission id" and make the description say exactly that. No correctness impact.
- **[Suggestion]** Review-brief accuracy (not a code defect) — the brief's "detailed status (deeper than board)" does not match the code; anyone using that framing to justify the tool's existence should note the tools are the same depth today.

No Critical findings: the surface is read-only, correctly gated (`agents` → `agentToolsEnabled()`, dual-signal opt-in + write token), and every description claim verifies against the implementation.

## 5. Verdict

**Y (with one fix).** The injected surface is correct, minimal (2 tunable fields, no echoed/diagnostic cruft), correctly gated, and honestly documented as "compact status." The single most important fix is the **[Important]** description overlap: `mission_status` vs `board` are indistinguishable to the model, so add a one-clause differentiator naming when to use each (`mission_id`-scoped read vs whole-portfolio board).
