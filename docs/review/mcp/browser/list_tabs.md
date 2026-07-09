# Review: `mcp__browser__list_tabs`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__list_tabs` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_list_tabs` |
| Definition | `src/lib/browser-mcp/index.ts:75-88` |
| Always-on? | gated |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`, `:1005-1008`) |
| Backing model / endpoint | server-side fn (dispatches to the MV3 extension via `dispatchBrowserTool`, `index.ts:86`) |
| Write-capable | no |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/browser-mcp/index.ts:77-78`):

> List all open tabs across all browser windows. Returns each tab's id (used by other browser_* tools), URL, title, active flag, and window id.

Input schema (`index.ts:79-83`): `{ type: "object", additionalProperties: false, properties: {} }` — **no arguments**.

### 2b. System prompt (`--append-system-prompt`)

`list_tabs` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:630-637`). Only the `browser` group is described. The two relevant clauses:

Lead surface sentence (`peer-mcp-personas.ts:635`):
> `mcp__browser__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

Power-mode note (`peer-mcp-personas.ts:631-633`), appended only when `powerBrowseAvailable`:
> Power mode adds the L0/L1 primitives (`mcp__browser__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

`list_tabs` appears in **neither** enumeration. The lead surface list omits it (correct — it is a power tool, not a default tool), and the `powerNote` list that enumerates the power primitives also omits it (along with `close_tab`, `wait`, `download`). So in power mode the snippet promises "the L0/L1 primitives" and then lists a strict subset that leaves out tab enumeration. `list_tabs` is discoverable ONLY via its own `tools/list` description.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored per-launch CLAUDE.md carries the peer-awareness block — the same text as 2b (produced by `buildPeerAwarenessSnippet`), so `list_tabs` is likewise unnamed there.

The checked-in repo root `CLAUDE.md` (`CLAUDE.md:147`, "Browser-control MCP (`--browse`)") lists all 19 tools by MCP name including `list_tabs`, and correctly documents the rename ("prefix dropped … the wire `tool` string … stays `browser_*`"). The design doc `docs/browser-mcp-design.md:83` documents `list_tabs → browser_list_tabs → "Enumerate open tabs across all windows"`, and the gate table at `:371` correctly places `list_tabs` under `browser_power` (`--browse` AND `--power-browse`). Both repo docs agree with the code. This root/design coverage is developer-facing reference, not part of the model's injected instruction surface — it does not remedy the awareness-snippet omission.

## 3. Assessment

### 3a. Description quality
- **Clarity & routing signal**: Strong. The one-line description states exactly what it returns and, critically, flags that the id is "(used by other browser_* tools)" — the load-bearing routing signal, since `tabId` is a required input to nearly every other browser tool. A model that reads this description learns both what the tool does and why it matters. No explicit when-NOT signal, but for a pure enumeration tool that is not needed.
- **Accuracy vs implementation**: Accurate. The handler is a thin passthrough to `dispatchBrowserTool("browser_list_tabs", …)` (`index.ts:85-87`); the returned fields (id, URL, title, active, window id) are what the extension produces. No stale model id, default, or behavior claim.
- **Schema minimality**: Ideal. Empty `properties: {}` with `additionalProperties: false` (`index.ts:79-83`) — zero args, so nothing to trim. This is the minimal-surface bar the "ruthlessly minimal MCP tool surface" principle asks for.

### 3b. System-prompt coverage
- **Named or omitted?** Omitted. Omission from the *lead-surface* list is by design — `list_tabs` is a power tool, so it should not appear in the 6-tool default enumeration. Omission from the *power-mode* `powerNote` is a genuine gap: the note claims to add "the L0/L1 primitives" but enumerates 9 of the 13 power tools, silently dropping `list_tabs` (plus `close_tab`, `wait`, `download`).
- **Accurate & non-redundant**: The clauses present are accurate; nothing in them contradicts `list_tabs`. The issue is coverage, not correctness.
- **Framing-constraint compliance**: The snippet is descriptive, no imperatives or anchors — adding `list_tabs` to the `powerNote` enumeration would not breach the framing constraint (it is already a bare backtick list of tool names).

**Coverage question (per the brief): can the lead learn tab ids without `list_tabs` being named?** Partially. `open_tab`'s description (`index.ts:91-92`) says "Returns the new tab's id", so a tab the lead *opens itself* yields an id it can thread into later calls. But `list_tabs` is the only enumeration of **pre-existing** tabs (tabs the user already had open, or opened out-of-band). In power mode a model that wants to act on an already-open tab has no snippet-level pointer to `list_tabs` and must discover it from `tools/list`. Since Claude Code does surface tool descriptions from `tools/list`, this is a degradation of discoverability, not a hard capability loss — hence Suggestion/Important, not Critical.

### 3c. CLAUDE.md coverage
- **Accurate, non-redundant, not drifted**: The injected block matches 2b (unnamed). The repo root `CLAUDE.md:147` and `docs/browser-mcp-design.md:83,371` name `list_tabs`, place it correctly under `browser_power`, and agree with the code. No drift.
- **Injected vs checked-in consistency**: Consistent in the sense that neither the injected block nor the model-facing surface *contradicts* the code; the checked-in reference is more complete than the injected snippet, which is expected (reference docs enumerate; the injected snippet summarizes).

### 3d. Cross-surface consistency
No contradictions. Description ↔ code agree; the awareness snippet ↔ code agree on gating (both treat it as power-only). The only cross-surface issue is an asymmetry in *completeness*: the `powerNote` enumerates a subset of the power tools it claims to introduce, and `list_tabs` falls in the omitted remainder.

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:631-633` — the power-mode `powerNote` claims to add "the L0/L1 primitives" but enumerates only 9 of the 13 `browser_power` tools, omitting `list_tabs` (and `close_tab`, `wait`, `download`). For `list_tabs` specifically this is the higher-value omission because `tabId` is the foundational input to every other browser tool and `list_tabs` is the ONLY way to enumerate pre-existing tabs. Fix: add `__list_tabs` (at minimum) to the `powerNote` backtick list, or reword to "primitives including `__mouse`, `__drag`, … `__list_tabs`" so the note stops implying a complete set it does not deliver. This stays Suggestion rather than Important because (a) the tool's own `tools/list` description is clear and self-routing, (b) `open_tab` already returns ids for lead-opened tabs so the common flow is covered, and (c) power mode is an opt-in expert surface where the operator has already accepted lower-level tooling. Argument for escalating to Important: `list_tabs` is conceptually foundational (id-provider for the whole browser suite) and the powerNote's "the L0/L1 primitives" phrasing is an implicit completeness claim that a model may rely on; if the reviewer weights the completeness-claim mismatch over the tools/list fallback, Important is defensible. I file it as Suggestion given the description-level self-routing and the `open_tab` id path.

## 5. Verdict

Y — the injected surface is correct, minimal (zero-arg schema), and self-routing at the description level. Single most important fix: add `list_tabs` (and ideally the other omitted power tools) to the `powerNote` enumeration in `peer-mcp-personas.ts:631-633` so the power-mode snippet stops implying a complete primitive set while silently dropping the tab-enumeration tool.
