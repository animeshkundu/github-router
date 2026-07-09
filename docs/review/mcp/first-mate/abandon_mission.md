# Review: `mcp__first-mate__abandon_mission`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__abandon_mission` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `abandon_mission` |
| Definition | `src/lib/first-mate/tools.ts:608` |
| Always-on? | gated by capability `agents` |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`) — opt-in (`--agents` / `GH_ROUTER_ENABLE_AGENTS=1`) AND a non-empty `state.githubAgentToken` |
| Backing model / endpoint | server-side fn (deterministic ledger mutation; no model call) |
| Write-capable | yes — mutates the durable mission/unit ledgers under `PATHS.FIRST_MATE_DIR` (no GitHub write) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/first-mate/tools.ts:610`):

> `Mark a first-mate mission abandoned so it drops from the active board. Existing units are marked terminal without merging.`

Input schema (`src/lib/first-mate/tools.ts:611-614`), `objectSchema` → `additionalProperties:false`, required `["mission_id"]`:

- `mission_id` (string, required): `Mission id to abandon.`
- `reason` (string, optional): `Optional short reason for the abandonment.`

Output on success (`:645`): `{ abandoned: true, missionId, terminalUnits: <count>, reason? }`.

### 2b. System prompt (`--append-system-prompt`)

`abandon_mission` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). No individual `first-mate` tool is named there. The only first-mate reference is the skill sentence, present only when `agentToolsAvailable === true` (`src/lib/peer-mcp-personas.ts:617-618`), verbatim:

> `Four injected skills (invoke by name): ... ; \`/gh-first-mate\` drives the durable GitHub cloud-agent loop. They suit non-trivial, role-separable work.`

So the system prompt names neither the tool nor the `first-mate` group — only the `/gh-first-mate` skill, which is the intended entry point. The tool's own `description` (2a) plus the `/gh-first-mate` skill body are the only routing signal the model gets.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block carries the same text as 2b (the `/gh-first-mate` skill sentence only); no marker block names `abandon_mission`.

Checked-in repo `CLAUDE.md` root section "First-mate cloud-agent controller (`--agents`)" (`CLAUDE.md:137-139`) enumerates the model-facing tools as "`start_mission`, `__advance`, `__board`, plus `__mission_status`, `__scaffold_repo`, and PR operator tools including `__mark_ready`" — it does NOT list `abandon_mission` or `add_units`. So the root CLAUDE.md tool inventory is stale relative to the code (both tools exist at `tools.ts:572` and `:608`).

`docs/first-mate-design.md:36-37` DOES document it accurately: "`mcp__first-mate__abandon_mission` — mark a mission abandoned via the durable registry CAS path and terminalize its live units so it drops from the active board," and `:46-47` frames it as "the explicit cleanup lever."

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The description states WHAT it does (mission → abandoned, drops from board, units terminal, no merge) but gives no when-to-use / when-NOT signal. For a terminal, irreversible-ish cleanup lever this is thin — the model learns the mechanism, not that this is the destructive end-state for a mission it should reach for only when giving up on the work. The `/gh-first-mate` skill is expected to carry the "when," which is defensible given the group is skill-gated.
- **Accuracy vs implementation — the load-bearing gap.** "Existing units are marked terminal without merging" is accurate about the LOCAL ledger (`:633-643` sets `terminal=true`, `phase="done"`, `cancelledBy="external"`, clears `blockingDecisionId`, resolves any pending blocking decision). But abandon does NOT touch GitHub: the handler never calls `deps.closePullRequest` (available in the same file, `tools.ts:527`) and there is NO cloud-agent cancel/stop primitive anywhere in `MergeCloseDeps`. So a mission with open PRs and in-flight cloud-agent runs keeps ALL of them live on GitHub after abandon — only the local board forgets them. Unlike the `close_pr` path (`:520-529`) and the reconcile paths, abandon sets no `artifact` (e.g. `pr_closed`), so the terminalized units carry no record that their PR was left open. The description's "without merging" reads as "cleanly wound down," but the true post-condition is "board-hidden while remote work continues unmanaged." A model calling this to "cancel" a mission will believe it stopped the work; it did not.
- **Terminal-consequence signalling.** The description does not flag that abandon is a one-way transition for the mission's board visibility, nor that `done` missions are rejected (`:623-624`, `MISSION_TERMINAL`) while re-abandoning an already-`abandoned` mission is idempotent (`:626` guards the status write; units are re-swept). Neither behavior is discoverable from the surface.
- **Schema minimality.** `{mission_id, reason}` is minimal and clean. `mission_id` is required and load-bearing. `reason` is optional, is echoed back in the result (`:645`) but — verify — is otherwise unused: it is NOT persisted to the mission/unit ledger or to the resolved decision (the decision is answered with the fixed literal `"abandoned"`, `:641`). So `reason` is effectively a no-op audit string that only round-trips to the caller. Per the "ruthlessly minimal MCP tool surface" principle it is borderline: either persist it (mission ledger / decision note) so it has an effect, or its presence is cosmetic. Low severity because it is optional and cheap.

### 3b. System-prompt coverage

- **Omitted — by design.** No individual first-mate tool is named in the snippet; only `/gh-first-mate`. Consistent with the stated contract (`src/lib/peer-mcp-personas.ts:546-547`: gh-first-mate listed only when `agentToolsAvailable`) and with how the other operator tools are handled. Not a gap: the skill is the intended router into this surface, and naming every first-mate tool in the always-injected snippet would bloat it for the common (non-`--agents`) case.
- **Accurate & non-redundant.** The one sentence is accurate and does not duplicate the description.
- **Framing-constraint compliance.** The skill sentence is a capability statement ("drives the durable GitHub cloud-agent loop"), no imperative / hedge / anchor. Compliant with the negative pins in `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Root CLAUDE.md is stale (inventory drift).** `CLAUDE.md:139` lists the first-mate tool set but omits `abandon_mission` and `add_units`, both of which are live in `tools.ts`. Not model-facing (the mirrored snippet, not the root doc, is injected), but it is a maintenance-accuracy miss for a reviewer/contributor reading the canonical doc.
- **Design doc is accurate.** `docs/first-mate-design.md:36-37,46-47` matches the code. But it, too, describes only the local "terminalize its live units" effect and does not call out that remote PRs / agent runs are left live — same blind spot as the description.

### 3d. Cross-surface consistency

- Description ↔ design doc agree on the LOCAL effect and share the same omission (no mention that remote PRs/agents survive abandon).
- Root CLAUDE.md tool inventory ↔ code: inconsistent (tool omitted from the enumerated list).
- No surface contradicts the code on what abandon DOES; the consistent defect is what every surface fails to say about what abandon does NOT do (stop remote work).

## 4. Findings

- **[Important]** `src/lib/first-mate/tools.ts:610` (description) + `:633-645` (handler). The description does not signal that abandon is purely a LOCAL ledger operation: open PRs and in-flight cloud-agent runs are left live on GitHub. Repro: start a mission with `--agents`, let it open a PR / dispatch a Copilot agent, call `abandon_mission`; the mission drops from the board and units go terminal, but the PR stays OPEN and the cloud agent keeps running — the operator believes the work was cancelled. Fix: amend the description to state the boundary, e.g. "Local cleanup only: the mission drops from the board and units go terminal, but any open PRs and running cloud agents are NOT closed/cancelled — close those separately (`close_pr`) if you want the remote work stopped." Optionally have the handler record which units had an open PR (an `artifact`/note) so the left-open state is auditable.
- **[Important]** `CLAUDE.md:139`. Root CLAUDE.md's first-mate tool inventory omits `abandon_mission` (and `add_units`), which exist in `tools.ts:608`/`:572`. Fix: add both to the enumerated list so the canonical doc matches the served surface.
- **[Suggestion]** `src/lib/first-mate/tools.ts:613,645`. `reason` is accepted and echoed but never persisted (the decision is resolved with the fixed literal `"abandoned"` at `:641`; nothing writes `reason` to a ledger). Either persist it (mission or decision note) so it has an effect, or accept that it is a cosmetic round-trip. Minor, since it is optional.
- **[Suggestion]** `src/lib/first-mate/tools.ts:610`. No when-to-use / terminality signal (rejects `done` missions, idempotent on already-`abandoned`). A one-clause "use to permanently retire a mission you are giving up on" plus the `done`-rejected note would sharpen routing; acceptable to defer to the `/gh-first-mate` skill body if that already covers it.

## 5. Verdict

N — the injected surface is minimal and framing-compliant, but the description materially under-signals the tool's terminal/no-merge consequence: it reads as "wind the mission down" while the code only hides it locally and leaves open PRs and running cloud agents live on GitHub. Single most important fix: state in the description that abandon is local-ledger-only and does NOT close PRs or cancel cloud agents.
