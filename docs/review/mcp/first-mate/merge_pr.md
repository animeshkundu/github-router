# Review: `mcp__first-mate__merge_pr`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__merge_pr` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `merge_pr` |
| Definition | `src/lib/first-mate/tools.ts:426` |
| Always-on? | gated by `--agents` opt-in + write token |
| Capability gate | `capability: "agents"` (`tools.ts:200`) → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`); plus a per-call `hasAgentToken()` guard (`tools.ts:202`) |
| Backing model / endpoint | server-side fn (deterministic GitHub REST via `deps.mergePullRequest`, `tools.ts:479` → `src/lib/agent/service.ts:879`) |
| Write-capable | yes — IRREVERSIBLE: merges a live GitHub PR (raw REST `PUT /pulls/{pr}/merge`, `service.ts:883-892`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:428`):

> `Merge a GitHub pull request the operator has reviewed. Head-guarded (rejects a moved head), ownership-scoped (agent-authored or an active first-mate mission repo, else requires allow_unowned), and gated on a pre-merge safety check (OPEN, not draft, MERGEABLE, CI green).`

Input schema (`tools.ts:429-436`), required `["repo", "pr", "expected_head_sha"]`:

- `repo` — `Repository as an owner/name string.`
- `pr` — `Pull request number.`
- `expected_head_sha` — `The exact head commit SHA the operator reviewed. The merge is REJECTED if the live head has moved from this value; re-review the new head before merging.`
- `expected_base` — `Optional base branch name the operator reviewed against. When set, the merge is rejected if the live base ref differs.`
- `method` — enum `["merge","squash","rebase"]`, `Merge method. Defaults to squash.`
- `allow_unowned` — `Set true to merge a PR that is neither agent-authored nor part of an active first-mate mission. Dangerous, explicit opt-in; the override is audit-logged.`

### 2b. System prompt (`--append-system-prompt`)

`merge_pr` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`). No first-mate *tool* is named there. The only first-mate mention is a single skill-pointer clause, emitted only when `agentToolsAvailable === true` (`peer-mcp-personas.ts:617-618`), verbatim:

> `/gh-first-mate` drives the durable GitHub cloud-agent loop.

(Appearing inside the "Four injected skills" sentence; the fallback three-skill sentence at `:619` omits it entirely.) So the model learns this irreversible tool exists only via the group appearing in `tools/list`, its own `description`, and the `/gh-first-mate` skill body — never from the system prompt.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block carries the same `/gh-first-mate` skill sentence as 2b (single source: `buildPeerAwarenessSnippet`). `merge_pr` is not named there.

Checked-in repo root `CLAUDE.md:139` (the first-mate section) enumerates the surface as "PR operator tools including `__mark_ready`" — `merge_pr` is folded into that unnamed phrase and never called out. The same paragraph makes the load-bearing claim (verbatim):

> `Merge is human-gated: approval is recorded in `decisions.json`, bound to the live PR head/base, single-use, and re-validated by `verifyAndConsumeApproval()` immediately before `mergePullRequest()`.`

`docs/first-mate-design.md` enumerates tool entries at `:26-44` but has NO dedicated `merge_pr` entry; the name appears only inside `mark_ready`'s ownership clause (`:42-44`): "the same fail-closed ownership scope as `merge_pr` / `close_pr` (bot-authored or correlated to a first-mate unit, else explicit `allow_unowned`)." The design doc's `verifyAndConsumeApproval` walkthrough (`:388-396`) describes `maybeMergeWithApproval()` — a step in the autonomous controller loop — not this tool.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: The description enumerates the four enforced gates well (head guard, ownership scope, pre-merge safety) and they all verify against the handler: head guard `tools.ts:450-457`, ownership `tools.ts:459-472`, safety `evaluateMergeSafety` `tools.ts:474-477` / `776-`. A model reading it learns WHEN it will be rejected.
- **The human-approval binding does NOT apply to this tool.** This is the load-bearing finding. The root `CLAUDE.md:139` states "Merge is human-gated ... re-validated by `verifyAndConsumeApproval()` immediately before `mergePullRequest()`." That is TRUE of the autonomous controller path (`controller.ts:1515` calls `verifyAndConsumeApproval` before `deps.mergePullRequest` at `:1527`), but the `merge_pr` TOOL handler (`tools.ts:437-485`) NEVER calls `verifyAndConsumeApproval` and never reads the `decisions.json` approval ledger. `deps.mergePullRequest` (`service.ts:879-908`) is a raw REST merge with only a `sha` guard — no approval check. So a model that has read the project docs may believe an approval-ledger gate protects every merge; for THIS tool it does not. The tool merges on the model's say-so once head matches, ownership resolves, and CI is green.
- **"the operator has reviewed" is an unenforced precondition, not a gate.** Nothing in the handler verifies a human reviewed anything. The phrase reads as a caller precondition, but when the caller is an LLM the model can satisfy it by deciding it has "reviewed" the PR. `expected_head_sha` binds the merge to a *specific commit*, but not to a *human having looked at that commit* — the model can read the live head itself and pass it. So the only real human-in-the-loop is procedural (the human tells the operator to merge), never code-enforced.
- **"CI green" overstates the guarantee.** `evaluateMergeSafety` refuses on `failing`/`pending` (`tools.ts:836-842`) but a genuinely CI-less repo (zero check-runs, no workflows, `mission.ciRequired !== true`) PASSES on human review alone (`tools.ts:843-`, comment at `:748-750`). "CI green" and "no CI configured, merging on review alone" are different model-facing guarantees; the description conflates them.
- **Accuracy vs implementation**: The ownership phrase "an active first-mate mission repo" overstates scope vs the code. `resolveOwnership` (`tools.ts:717-727`) owns a PR only when a first-mate UNIT correlates to `unit.pr === thisPr` in the repo; a mission that merely targets the repo is explicitly NOT sufficient (`tools.ts:700-704`). The `allow_unowned` field text ("part of an active first-mate mission") and the design doc ("correlated to a first-mate unit", `:43-44`) are the accurate versions.
- **Schema minimality**: All six fields pass the "what would the model do with this?" test. `expected_head_sha` (required) is the concurrency/staleness guard — model-supplied, load-bearing, and its own field description tells the model how to react to a `HEAD_MOVED` reject. `expected_base` is an optional tighter guard the model can opt into. `method` is a genuine choice. `allow_unowned` is the actionable fail-closed override (the `UNOWNED_PR` error tells the model to pass it, `tools.ts:465`). No echoed-input or diagnostic-only fields. Minimal.

### 3b. System-prompt coverage

- **Omitted.** Consistent with the whole first-mate surface (no individual tool named; only the `/gh-first-mate` skill pointer, `peer-mcp-personas.ts:616-620`). For most operator tools this thinness is by design. For `merge_pr` specifically — the single irreversible, non-approval-gated tool on the surface — the omission means the ONLY place the model can learn "this merge is real and immediate" is the tool's own `description`, which (per 3a) does not say so. This raises the bar on the description getting the irreversibility + no-ledger signal right, and it currently does not.
- **Framing-constraint compliance**: The one skill clause is descriptive, no imperative/hedge/anchor. Compliant.

### 3c. CLAUDE.md coverage

- **Drifted for this tool.** The `CLAUDE.md:139` sentence "Merge is human-gated ... re-validated by `verifyAndConsumeApproval()` immediately before `mergePullRequest()`" is accurate for the controller's `maybeMergeWithApproval()` but reads as a blanket claim over all merges. A reader (human or model) cannot tell from that sentence that the operator-facing `merge_pr` tool bypasses the ledger entirely. The design doc's `verifyAndConsumeApproval` section (`first-mate-design.md:388-396`) is likewise scoped to the controller step without disclaiming the tool. Neither doc has a dedicated `merge_pr` entry, so the most consequential tool on the surface has the thinnest and most misleading documentation.

### 3d. Cross-surface consistency

- **Contradiction: docs claim an approval-ledger gate the tool does not enforce.** Root `CLAUDE.md:139` + design-doc `:388-396` describe `verifyAndConsumeApproval` as the merge gate; the `merge_pr` handler (`tools.ts:437-485`) does not call it. The two merge paths (autonomous controller vs operator tool) have DIFFERENT gates, and no surface tells the model which one `merge_pr` is.
- Secondary seam: description "active first-mate mission repo" is looser than the code's unit-correlation test and looser than the design doc's own "correlated to a first-mate unit" wording (same drift noted for `close_pr`).

## 4. Findings

Ranked, most severe first.

- **[Important]** `src/lib/first-mate/tools.ts:428` + `CLAUDE.md:139` — the `merge_pr` description omits that the merge is IRREVERSIBLE and that the `verifyAndConsumeApproval`/`decisions.json` approval binding described in CLAUDE.md does NOT apply to this tool (only to the controller path, `controller.ts:1515`). A model that read the project docs can believe an approval-ledger gate protects the merge; it does not (`tools.ts:437-485` never calls `verifyAndConsumeApproval`; `service.ts:879` is a raw REST merge). Repro: operator session with `--agents`; the model, having read "Merge is human-gated ... re-validated by verifyAndConsumeApproval," calls `merge_pr` on a green, owned PR at the live head expecting the tool to refuse absent a recorded human approval. The tool merges — no ledger is consulted. A careful human who knew this path skips the ledger would have required explicit approval first. Not Critical because real gates remain (head guard, ownership, CI) so it will not silently merge an *arbitrary* PR — but the human-approval guarantee the docs advertise is absent, which is a material safety-signal gap on the one irreversible tool. Fix: (a) add to the description that merge is immediate/irreversible and that the operator must have explicit human authorization to merge (the tool does not enforce one); AND (b) fix `CLAUDE.md:139` + `first-mate-design.md:388-396` to scope the `verifyAndConsumeApproval` claim to the CONTROLLER path and state that the operator `merge_pr` tool relies on head+ownership+CI guards plus the operator's out-of-band human authorization, not the ledger. (Stronger alternative, if the intended guarantee really is ledger-gated merge everywhere: wire `verifyAndConsumeApproval` into the tool handler — text is the wrong control for a merge gate.)

- **[Important]** `src/lib/first-mate/tools.ts:428` — "CI green" overstates the safety check. A genuinely CI-less repo passes `evaluateMergeSafety` on human review alone (`tools.ts:843-`, `:748-750`), so the tool will merge a repo with NO passing CI. Fix: reword to "CI green where CI exists (a repo with no configured workflows merges on the operator's review alone)" so the model does not treat every successful merge as CI-verified.

- **[Suggestion]** `src/lib/first-mate/tools.ts:428` — the ownership phrase "an active first-mate mission repo" overstates scope vs the code, which requires a PR-to-unit correlation, not just a mission targeting the repo (`tools.ts:700-704`, `717-727`). Fix: align with the design doc — "agent-authored or correlated to a first-mate unit, else requires allow_unowned" (`first-mate-design.md:43-44`), matching the more-precise `allow_unowned` field text. Same fix applies to `close_pr` (`tools.ts:489`) and `mark_ready` (`tools.ts:534`).

- **[Suggestion]** `docs/first-mate-design.md:26-44` + `CLAUDE.md:139` — `merge_pr` has no dedicated entry in either enumeration; it surfaces only inside `mark_ready`'s ownership cross-reference. The single irreversible operator tool is the least documented. Fix: add an explicit `merge_pr` bullet to the design-doc tool list (naming its actual gates: head guard, ownership, pre-merge safety) and name it in the CLAUDE.md "PR operator tools" phrase.

## 5. Verdict

**N** — the injected surface is minimal and correctly gated, but it is NOT consistent: the description omits the irreversibility + no-approval-ledger reality, and the project docs affirmatively advertise a `verifyAndConsumeApproval` human-approval gate that this tool does not enforce (it exists only on the controller path). Single most important fix: make the `merge_pr` description and `CLAUDE.md:139` state plainly that this tool merges immediately on head+ownership+CI guards plus the operator's out-of-band human authorization — the `decisions.json`/`verifyAndConsumeApproval` ledger gate applies to the autonomous controller path, not to `merge_pr`.
