# Subagent: `codex-implementer`

> Reviews the routing line as a DELEGATION TRIGGER. Tool-side review: `docs/review/mcp/peers/codex_implementer.md`.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `codex-implementer` |
| Backing peer model | `gpt-5.3-codex` `/v1/responses` with workspace-write (`src/lib/peer-mcp-personas.ts:426-427,433`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | `--codex-cli` only — in `PERSONAS_WRITE`, added by `personasFor` iff `opts.codexCli` (`peer-mcp-personas.ts:663-665`); also requires codex 0.129+ on PATH (`resolveCodexCliBackend`, `codex-mcp-config.ts:68-82`) |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:289-303`); routes through the `mcp__codex-cli__codex` stdio bridge, not the HTTP peers server (`buildAgentPrompt`, `peer-mcp-personas.ts:462-479`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:429-430`) |
| System prompt | `buildAgentPrompt` → `IMPLEMENTER_BASE` (`peer-mcp-personas.ts:296-320`) |
| Write-capable | **yes** (`writeCapable: true`, `peer-mcp-personas.ts:433`) — the only write-capable persona |

Verified present only under `--codex-cli`: `tests/codex-mcp-config.test.ts:222-238` (CLI backend → 6 personas incl. codex-implementer) vs `164-197` (HTTP backend → 5 personas, no implementer).

## 2. Description (verbatim)

`peer-mcp-personas.ts:429-430`:

> Targeted implementation of a self-contained coding task. Backed by gpt-5.3-codex with workspace-write access. Pass spec + files verbatim.

## 3. System-prompt summary

`IMPLEMENTER_BASE` (`peer-mcp-personas.ts:296-320`): identity ("codex-implementer, a focused implementation specialist running on gpt-5.3-codex with workspace-write access"), an anti-vagueness gate ("You are not a planner. If the brief is vague or missing acceptance criteria, ask the lead for the missing piece BEFORE editing anything"), the `COLD_START_CONTRACT`, a "what done looks like" contract (exactly the specified files changed, minimal, ran tests/typecheck/lint, enumerated summary), a Status/Files-changed/Verification/Notes reply format, and a resilience reminder about the retry-once semantics. The routing block (stdio branch, `peer-mcp-personas.ts:467-479`) invokes `mcp__codex-cli__codex` with `sandbox: "workspace-write"`, `approval-policy: "on-request"`, the model id, and `base-instructions` pasted verbatim.

## 4. Routing-trigger assessment

- **States trigger — thin.** "Targeted implementation of a self-contained coding task" is a scoped trigger, but at 3 sentences this description is by far the shortest of all injected subagents. It names WHAT (targeted implementation, workspace-write) but gives no anti-trigger (when NOT to use), no differentiation from the native `implementer` or `worker-implement`, and no scope boundary beyond "self-contained".
- **Specific not vague — weak.** "self-contained coding task" is the only scoping. Compared to the critics (which name artifact types + anti-scope) this is under-specified. It passes the >20-char test (`tests/codex-mcp-config.test.ts:976` applies to persona .md files) but is the least differentiated write surface.
- **Accurately previews the body — partially.** The body (`IMPLEMENTER_BASE`) is much richer than the description: it carries the "not a planner / ask before editing" gate and the done-contract, none of which the description hints at. A reader routing purely off the description would not know the implementer refuses vague briefs.
- **Overtrigger risk — LOW but for a different reason.** It is gated behind `--codex-cli`, so most sessions never see it. Within a `--codex-cli` session it competes directly with the native `implementer` (also injected when its model is present) and `worker-implement` — see README S3 (three-way implement overlap). The thin description makes the overlap worse: nothing tells the lead which of the three to pick.

## 5. Don't-nerf / right-balance

The write-capability and the "ask before editing" gate are good floor-raisers. The concern is not nerfing but ROUTING CLARITY: three write-capable implementation surfaces coexist (this, native `implementer`, `worker-implement`), and this description is too thin to steer among them. It does not overtrigger (gated + scoped), but it under-informs.

## 6. Findings + verdict

- **[Important] Part of S3 (three-way implement overlap).** codex-implementer, the native `implementer` (gpt-5.6-sol, gpt-5.5 fallback), and `worker-implement` are all write-capable and all injected (codex-implementer only under `--codex-cli`). The three descriptions do not cross-reference or differentiate: codex-implementer says "self-contained coding task", native implementer says "well-scoped coding tasks — edits, small features, fixes", worker-implement says "autonomous coding worker (read/write/bash, optional git worktree)… non-blocking". The lead has no description-level signal for when to pick codex-implementer over the native implementer (both gpt-family coders, both integrated, both foreground). See README S3 for the recommendation.
- **[Suggestion]** The description omits an anti-trigger. Add the body's own boundary ("self-contained tasks with acceptance criteria; asks before editing on a vague brief") so the routing line previews the "not a planner" gate.

**Verdict: N (blocked on S3 routing clarity).** The trigger is honest and non-overtriggering, but it is the thinnest injected subagent description and sits in an undifferentiated three-way write overlap. Differentiate it from the native implementer (or document when `--codex-cli` implementer is preferred) before treating the surface as clean.
