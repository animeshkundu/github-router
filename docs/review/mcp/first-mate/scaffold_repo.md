# Review: `mcp__first-mate__scaffold_repo`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__first-mate__scaffold_repo` |
| Group / server | `first-mate` (serverInfo `github-router-first-mate`) |
| Wire tool name | `scaffold_repo` |
| Definition | `src/lib/first-mate/tools.ts:266` |
| Always-on? | gated by `agents` capability |
| Capability gate | `agents` → `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196`); the tool wrapper ALSO re-checks `hasAgentToken()` at call time (`tools.ts:202`) |
| Backing model / endpoint | server-side fn (deterministic file generation + GitHub API; no LLM) |
| Write-capable | yes (creates a `scaffold/*` branch, commits files, opens a PR via `commitFiles` / `createScaffoldPullRequest`, `tools.ts:306-326`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Top-level description (`tools.ts:268`):

> `Seed deterministic agentic-dev convention files into a GitHub repository on a pull-request branch.`

Input-schema fields (`tools.ts:269-277`), top-level object is closed (`additionalProperties:false`, `objectSchema` at `tools.ts:1462`); required: `["repo"]`:

- `repo` (string, required) — `Repository as an owner/name string.`
- `mode` (string enum `add-missing-only|overwrite-approved|enhance`) — `How to handle files that already exist. add-missing-only skips tuned files; overwrite-approved replaces; enhance appends missing ## sections to guidance/history foundation files. Defaults to add-missing-only.`
- `base_ref` (string) — `Optional base branch name. Defaults to the repository default branch.`
- `detection_overrides` (untyped — `anyProp` emits `{description}` only, no `type`/`properties`; `tools.ts:1499`) — `Optional object of detection overrides: tech_stack, primary_os, package_manager, *_command, ui_evidence_required.`

### 2b. System prompt (`--append-system-prompt`)

`scaffold_repo` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). No first-mate tool is named individually. The only first-mate mention is a single skill-sentence clause, gated on BOTH `workerToolsAvailable` and `agentToolsAvailable === true` (`peer-mcp-personas.ts:616-620`):

> `…; \`/gh-first-mate\` drives the durable GitHub cloud-agent loop.`

The `first-mate` MCP server/group itself is not enumerated in the capability-inventory paragraph either — only the skill is surfaced. So at the system-prompt layer the model learns a skill exists, not that a `scaffold_repo` tool exists.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Injected marker block: peer-awareness (same text as 2b). The mirrored CLAUDE.md carries the identical `/gh-first-mate` skill sentence and nothing tool-specific for `scaffold_repo`.

Checked-in repo CLAUDE.md (`CLAUDE.md:139`, "First-mate cloud-agent controller (`--agents`)") documents `scaffold_repo` in prose and agrees with the code:

> `\`scaffold_repo\` is the foundation-first tool: it always works through a scaffold branch + PR, detects the target repo's stack/commands/tests/CI/default branch/primary OS where possible, seeds guidance + mirrored role agents + ADR/changelog/learnings/history/plans/research/PR/test/CI files, supports \`add-missing-only\`/\`enhance\`/\`overwrite-approved\`, reports each file as seeded/skipped/enhanced, and deliberately does not seed factory-protocol or \`docs/factory/\` files because first-mate remains the external orchestrator.`

Verified against `buildScaffoldFiles` (`src/lib/first-mate/scaffold-spec.ts:87-113`): seeds `GUIDANCE_PATHS` (AGENTS/CLAUDE/GEMINI/copilot-instructions), mirrored role agents under `.github/agents/` + `.claude/agents/`, test instructions, `copilot-setup-steps.yml`, `ci.yml`, PR template, ADR template + index, history template, plans/research READMEs, LEARNINGS, CHANGELOG. No factory-protocol / `docs/factory/` path appears. The non-seeding claim is also asserted in the PR body (`tools.ts:1323`: "No factory protocol files are seeded; orchestration remains external to the repository"). `docs/first-mate-design.md:84-106` carries the fuller matching writeup (branch-not-default-branch, repo-geared content, three-way non-clobber policy, `seeded`/`skipped(present)`/`enhanced(appended: ...)` reporting). All consistent with code.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The one-sentence top-level description conveys WHAT (seed convention files) and one safety fact (on a PR branch), but not WHEN to use it, WHEN NOT to, or what it detects. The three-mode semantics live in the `mode` field description, which is accurate and well-scoped. There is no "when not to use" signal: the model isn't told this is owned-repo/foundation-first and one-shot per repo, so nothing steers it away from re-running it or running it on an arbitrary third-party repo. Given the tool WRITES to a repo (branch + commit + PR), a stronger routing/guard signal in the top-level description is warranted.
- **The three deliberate design properties are under-surfaced in the description.** (1) PR-branch mechanism: present ("on a pull-request branch") but not that it never pushes to the default branch. (2) Three modes: only in the `mode` field, not the top-level description — acceptable since the model reads field descriptions, but the DEFAULT (add-missing-only, non-destructive) is not surfaced where a model deciding whether to call the tool would see it. (3) The deliberate NON-seeding of factory files is absent from every model-facing string; it appears only in the generated PR body, root CLAUDE.md, and the design doc. That is arguably fine (it is a property of the output, not a decision the model makes), so this is a note, not a defect.
- **Accuracy vs implementation.** Description strings match behavior. `mode` enum + default (`add-missing-only`, `tools.ts:295`) match `ScaffoldRepoArgsSchema` (`tools.ts:178`) and `planScaffoldFiles` (`scaffold-spec.ts:115-157`). `base_ref` default-to-default-branch matches `tools.ts:281-284`.
- **Schema minimality.** `repo`, `mode`, `base_ref` are all required-or-model-tunable and actionable. `detection_overrides` is legitimately useful (lets the operator correct misdetection), but its MODEL-FACING schema is a bare untyped blob (`anyProp` → `{description}` with no `type`/`properties`, `tools.ts:1499-1501`), while the RUNTIME validator `ScaffoldDetectionOverridesSchema` IS a typed `.strict()` object (`tools.ts:164-174`). The model must reconstruct the sub-shape from a prose list ("tech_stack, primary_os, package_manager, *_command, ui_evidence_required") and cannot see which `*_command` keys are valid (`build_command`/`typecheck_command`/`lint_command`/`test_command`/`dev_command`) — a malformed key that trips `.strict()` will 400 the call. This is a real minimality/usability defect: the typed structure already exists in code but isn't exposed.

### 3b. System-prompt coverage

- **Omitted.** No first-mate tool is named in the snippet; only the `/gh-first-mate` skill is. This is by design and consistent with the reviewer's framing and the CLAUDE.md model (individual first-mate tools are steered through the skill, not the peer-awareness inventory). Consistent with how the snippet gates every tool mention on its live `tools/list` presence.
- **Accurate & non-redundant.** The skill sentence is accurate and does not restate any tool description. Because `scaffold_repo` is never named, there is no drift risk at this layer.
- **Framing-constraint compliance.** The skill clause is descriptive ("drives the durable GitHub cloud-agent loop"), no imperatives, no anchors. Compliant.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted.** The checked-in root CLAUDE.md (`CLAUDE.md:139`) and design doc (`docs/first-mate-design.md:84-106`) both describe `scaffold_repo` correctly and agree with `buildScaffoldFiles` / `planScaffoldFiles`. The three modes, the branch+PR mechanism, the seeded file set, the reporting vocabulary, and the deliberate factory non-seeding all match code.
- **`detection_overrides` is undocumented in prose.** Neither the CLAUDE.md tool list (`CLAUDE.md:139`) nor the design-doc tool entry (`first-mate-design.md:40-41`) mentions the `detection_overrides` argument, though the design doc DOES describe the detection heuristics themselves (`first-mate-design.md:87-91`). Minor doc gap, not a code discrepancy.
- **Injected block vs checked-in root CLAUDE.md.** Consistent — the injected block carries only the skill sentence; the tool-detail prose lives in the checked-in root CLAUDE.md, which the model also has in context.

### 3d. Cross-surface consistency

No contradictions between description, system prompt, CLAUDE.md, and code. The one asymmetry is depth, not conflict: `detection_overrides` is typed-and-validated in code, prose-only in the description, and absent from the docs' tool lists. The factory-non-seeding property is stated in the PR body + docs but not in any model-facing tool string (acceptable — it's an output property, not a model decision).

## 4. Findings

- **[Important]** `src/lib/first-mate/tools.ts:276` (+ `tools.ts:1499`) — `detection_overrides` is exposed to the model as an untyped `anyProp` blob (`{description}` only), while the runtime schema `ScaffoldDetectionOverridesSchema` (`tools.ts:164-174`) is a typed `.strict()` object. The model cannot see the valid sub-keys/types and must infer them from a prose list that abbreviates the five `*_command` keys as `*_command`; a wrong key name trips `.strict()` and 400s the call. Fix: emit a real object schema for `detection_overrides` (type `object`, `properties` for `tech_stack`/`primary_os`/`package_manager`/`build_command`/`typecheck_command`/`lint_command`/`test_command`/`dev_command`/`ui_evidence_required`, `additionalProperties:false`) so the model-facing surface matches the validator it will be checked against.
- **[Suggestion]** `src/lib/first-mate/tools.ts:268` — the top-level description omits any "when not to use" / one-shot-per-repo / owned-repo-foundation framing for a WRITE tool that opens a PR. Add a short clause conveying that it is the foundation-first setup step for a repo you own and that the default `add-missing-only` mode is non-destructive, so the model routes to it deliberately rather than speculatively.
- **[Suggestion]** `CLAUDE.md:139` and `docs/first-mate-design.md:40-41` — the `detection_overrides` argument is not mentioned in either tool list, though the detection heuristics are described. Add a one-line note that overrides can correct misdetection, so the documented arg surface matches the schema.

## 5. Verdict

Y (with one Important fix): the injected surface is accurate, consistent across description / system-prompt / CLAUDE.md / code, and the factory-non-seeding and PR-branch design claims all verify against the implementation. Single most important fix: give `detection_overrides` a real typed object schema (`tools.ts:276`) so the model-facing shape matches the `.strict()` validator that will reject malformed keys.
