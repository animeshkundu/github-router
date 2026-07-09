# Review: `mcp__first-mate__close_pr`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__close_pr` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `close_pr` |
| Definition | `src/lib/first-mate/tools.ts:487` |
| Always-on? | gated by `--agents` opt-in + write token |
| Capability gate | `capability: "agents"` (`tools.ts:200`) → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`); plus a per-call `hasAgentToken()` guard (`tools.ts:202`) |
| Backing model / endpoint | server-side fn (deterministic GitHub REST via `deps.closePullRequest`, `tools.ts:527`) |
| Write-capable | yes (closes a live GitHub PR; mutates first-mate unit ledger via `reconcileClosedPr`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:488-489`):

> `Close a GitHub pull request WITHOUT merging it. Ownership-scoped identically to merge_pr (agent-authored or active first-mate mission repo, else requires allow_unowned).`

Input schema (`tools.ts:490-494`), required `["repo", "pr"]`:

- `repo` — `Repository as an owner/name string.`
- `pr` — `Pull request number.`
- `allow_unowned` — `Set true to close a PR that is neither agent-authored nor part of an active first-mate mission. Explicit opt-in; audit-logged.`

### 2b. System prompt (`--append-system-prompt`)

`close_pr` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`). No first-mate *tool* is named there. The only first-mate mention is a single skill-pointer clause, emitted only when `agentToolsAvailable === true` (`peer-mcp-personas.ts:617-618`), verbatim:

> `/gh-first-mate` drives the durable GitHub cloud-agent loop.

(Appearing inside the "Four injected skills" sentence; the fallback three-skill sentence at `:619` omits it entirely.) So the model learns the tool exists only via the group appearing in `tools/list` and the `/gh-first-mate` skill body — not from the system prompt.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block carries the same `/gh-first-mate` skill sentence as 2b (single source: `buildPeerAwarenessSnippet`). `close_pr` is not named there.

Checked-in repo root `CLAUDE.md:139` (the first-mate section) enumerates the surface as:

> `... adds the `first-mate` scoped MCP server (`mcp__first-mate__start_mission`, `__advance`, `__board`, plus `__mission_status`, `__scaffold_repo`, and PR operator tools including `__mark_ready`) only when `agentToolsEnabled()` also sees the second GitHub write token.`

`close_pr` is folded into the unnamed "PR operator tools" phrase — only `__mark_ready` is called out by name. The gate description ("only when `agentToolsEnabled()` also sees the second GitHub write token") matches the code (`mcp-capabilities.ts:196-200`).

`docs/first-mate-design.md` enumerates tool entries at `:28-44` but has NO dedicated `close_pr` (or `merge_pr`) entry; both names appear only inside `mark_ready`'s ownership clause (`:42-44`): "the same fail-closed ownership scope as `merge_pr` / `close_pr` (bot-authored or correlated to a first-mate unit, else explicit `allow_unowned`)." That ownership description agrees with `resolveOwnership` (`tools.ts:706-738`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Strong on WHAT and on the ownership scope. "WITHOUT merging it" cleanly separates it from `merge_pr`; the ownership clause plus the `allow_unowned` field description together signal the scope and the override. No explicit when-NOT-to-use, but the ownership scope implicitly bounds it (don't reach for it on arbitrary human PRs).
- **Accuracy vs implementation**: The description says "active first-mate mission repo," but the code's ownership signal is TIGHTER than that phrase implies. `resolveOwnership` (`tools.ts:717-727`) owns a PR only when a first-mate UNIT correlates to `unit.pr === thisPr` in the repo; merely having an active mission that targets the repo is explicitly NOT sufficient (`tools.ts:700-704`, `717-719`). So "active first-mate mission repo" over-states ownership vs the actual unit-correlation test. The `allow_unowned` field description is more precise ("part of an active first-mate mission"). Not a correctness bug (the code fails closed regardless), but the top-line description's scope wording is looser than the code.
- **Behavior not surfaced**: `close_pr` on an already-CLOSED PR is idempotent-success + reconciles units (`tools.ts:523-526`); an already-MERGED PR is rejected `ALREADY_MERGED` (`tools.ts:502-506`). Neither is in the description; acceptable since both are actionable error messages the model gets at call time.
- **Schema minimality**: `repo`, `pr` are required and load-bearing. `allow_unowned` is model-tunable and directly actionable (it flips the fail-closed override, and the error message tells the model to pass it — `tools.ts:513-515`). All three fields pass the "what would the model do with this?" test. No echoed-input or diagnostic-only fields. Minimal.

### 3b. System-prompt coverage

- **Omitted, by design.** Consistent with the whole first-mate surface: no individual tool is named in the snippet, only the `/gh-first-mate` skill pointer (gated on `agentToolsAvailable`, `peer-mcp-personas.ts:616-620`). This matches the design-doc statement that the model-facing loop is thin and steered through the banner + skill (`CLAUDE.md:139`; `first-mate-design.md:56-57`). Naming every operator tool in the always-on snippet would bloat context for an opt-in surface most sessions never enable.
- **Framing-constraint compliance**: The one clause ("`/gh-first-mate` drives the durable GitHub cloud-agent loop") is descriptive, no imperative/hedge/anchor. Compliant.

### 3c. CLAUDE.md coverage

- **Accurate, lightly under-specified.** Root `CLAUDE.md:139` correctly gates the surface and lists it, but folds `close_pr` into "PR operator tools including `__mark_ready`" without naming it. Design doc `first-mate-design.md:28-44` gives named entries for nine tools but none for `merge_pr` or `close_pr` — the two most consequential (PR-mutating) operator tools are the only ones without their own doc entry, surfacing only inside `mark_ready`'s cross-reference. Not drifted from code (nothing stated is wrong), but the highest-impact side-effecting tools have the thinnest documentation.

### 3d. Cross-surface consistency

- No contradictions. Description ↔ skill sentence ↔ CLAUDE.md ↔ code all agree on the gate and on the ownership-plus-`allow_unowned` model.
- The one seam is wording precision: the tool description's "active first-mate mission repo" is looser than `resolveOwnership`'s unit-correlation test and looser than the design doc's own "correlated to a first-mate unit" phrasing (`first-mate-design.md:43-44`). The doc is the accurate version; the description should match it.

## 4. Findings

- **[Suggestion]** `src/lib/first-mate/tools.ts:489` — the description's ownership phrase "active first-mate mission repo" overstates scope vs the code, which requires a PR-to-unit correlation, not just a mission that targets the repo (`tools.ts:700-704`, `717-727`). Fix: align the wording with the design doc, e.g. "agent-authored or correlated to a first-mate unit, else requires allow_unowned" — matching `first-mate-design.md:43-44` and the more-precise `allow_unowned` field text. Also mirror this fix into `merge_pr` (`tools.ts:489` shares the same phrasing) and `mark_ready` (`tools.ts:534`).
- **[Suggestion]** `docs/first-mate-design.md:28-44` — `close_pr` (and `merge_pr`) have no dedicated tool entry in the enumeration; they appear only inside `mark_ready`'s ownership cross-reference. Root `CLAUDE.md:139` likewise names only `__mark_ready` under "PR operator tools." The two PR-mutating tools are the highest-impact operator tools and the least documented. Fix: add explicit bullets for `merge_pr` and `close_pr` in the design-doc list and name `close_pr` in the CLAUDE.md operator-tools phrase.

No Critical or Important findings: the gate is correct and defense-in-depth (`tools.ts:200` list-time capability + `tools.ts:202` call-time `hasAgentToken()`), ownership fails closed on ledger-read errors (`tools.ts:728-731`), the override is audit-logged (`tools.ts:518-520`), an already-merged PR is refused, and the schema is minimal.

## 5. Verdict

**Y** — the injected surface is correct, minimal, consistently gated, and appropriately thin (steered via the `/gh-first-mate` skill rather than a per-tool system-prompt clause). Single most important fix: tighten the description's "active first-mate mission repo" phrase to match the code's actual unit-correlation ownership test (`tools.ts:489`).
