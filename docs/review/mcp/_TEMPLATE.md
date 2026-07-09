# Review: `mcp__<group>__<tool>`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__<group>__<tool>` |
| Group / server | `<group>` (serverInfo `github-router-<group>`) |
| Wire tool name | `<toolNameHttp>` |
| Definition | `src/lib/.../<file>.ts:<line>` |
| Always-on? | yes / gated by `<flag or capability>` |
| Capability gate | `<capability>` → `<predicate()>` (or "none") |
| Backing model / endpoint | `<model>` `<endpoint>` (personas/workers only; else "server-side fn") |
| Write-capable | yes / no |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)
> Paste the description string verbatim, plus each input-schema field name + its `description`.

### 2b. System prompt (`--append-system-prompt`)
> The exact clause naming this tool in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`), verbatim.
> If the tool is NOT named there, state that and say whether only the group is named, or nothing at all.
> For personas, also record the subagent system prompt (`baseInstructions` + `buildAgentPrompt`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)
> Which injected marker block covers this tool: peer-awareness (same text as 2b), artifact-panel directive, operating-defaults, toolbelt, or none. Quote the covering text.
> Also note the relevant section of the checked-in repo `CLAUDE.md` (project root) that documents this tool, and whether it agrees with the code.

## 3. Assessment

### 3a. Description quality
- Clarity & routing signal (does the model learn when to use / when NOT to use it?).
- Accuracy vs implementation (any stale/wrong model id, default, gate, behavior?).
- Schema minimality (every field required / model-tunable / actionable per the "ruthlessly minimal MCP tool surface" principle in `docs/peer-mcp-design.md`; flag echoed-input / diagnostic-only fields).

### 3b. System-prompt coverage
- Named or omitted? If omitted, is that by design or a gap?
- Accurate & non-redundant with the description?
- Framing-constraint compliance: no imperatives ("Lead with X"), no hedges, no anchors disguised as description (pinned by `tests/peer-mcp-personas.test.ts`).

### 3c. CLAUDE.md coverage
- Accurate, non-redundant, not drifted from code?
- Injected block vs checked-in root CLAUDE.md consistency.

### 3d. Cross-surface consistency
- Contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ actual code.

## 4. Findings

Ranked, most severe first. Use the repo severity ladder.

- **[Critical]** correctness / security / data-loss in the model-facing surface (e.g. description tells the model to do something the code rejects). Include a concrete repro/misroute scenario.
- **[Important]** should-fix: stale fact, wrong default, missing when-not signal, minimality violation.
- **[Suggestion]** non-blocking polish.

Each finding: `file:line` + one-line defect + concrete fix.

## 5. Verdict

One line: is this tool's injected surface correct, minimal, consistent, and well-routed? Y/N + the single most important fix.
