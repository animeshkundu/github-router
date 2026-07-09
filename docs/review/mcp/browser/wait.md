# Review: `mcp__browser__wait`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__wait` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_wait` |
| Definition | `src/lib/browser-mcp/index.ts:282` |
| Always-on? | gated (opt-in `--browse`/`--power-browse`) |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`) |
| Backing model / endpoint | server-side fn (dispatched to the extension via `dispatchBrowserTool`; no LLM) |
| Write-capable | no (read-only observation; waits, does not mutate the page) |

Gate detail: `browserToolsEnabled()` requires the `--browse` opt-in AND a Chromium-family browser on disk; `browserPowerToolsEnabled()` (`src/lib/mcp-capabilities.ts:148`) additionally requires `state.powerBrowseEnabled` (set by `--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`). So `wait` is invisible in default `--browse` mode — it appears only when power mode is also on. Per-call timeout default 10s / cap 60s (`src/lib/browser-mcp/dispatch.ts:167`), matching the schema's `Default 10000, hard cap 60000`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/browser-mcp/index.ts:283-284`):

> Wait for an element to appear (until='selector'), the tab URL to match a regex (until='url'), or the network to go idle (until='networkIdle' - heuristic: tab status complete + 500ms quiet). Returns {ok: true, elapsedMs} on success, {ok: false, reason: 'timeout'} on miss.

Input-schema fields (`src/lib/browser-mcp/index.ts:285-302`):

- `tabId` (number, required) — no description.
- `until` (string, required, enum `["selector", "url", "networkIdle"]`) — `What to wait for.`
- `selector` (string) — `CSS selector when until=selector.`
- `urlPattern` (string) — `JS regex (string form) when until=url.`
- `timeoutMs` (number) — `Max wait. Default 10000, hard cap 60000.`

`required: ["tabId", "until"]`; `additionalProperties: false`.

### 2b. System prompt (`--append-system-prompt`)

`wait` is NOT named in the runtime awareness snippet. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`) names the browser group only when `opts.browseAvailable`, describing the lead surface (`__act`, `__observe`, `__extract`, `__navigate`, `__open_tab`, `__screenshot`) at line 635, then appends a `powerNote` when `opts.powerBrowseAvailable` (line 631-632):

> Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

That `powerNote` enumerates 9 power primitives and does NOT include `wait` (nor `download`, `close_tab`, `list_tabs`). So even in power mode the system prompt never names `wait`; it is surfaced to the model only via its `tools/list` description. The only place `wait` appears in this file is the capability-doc comment at line 719 (`list_tabs / wait / download`), which is a source comment, not injected text.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b (produced by `buildPeerAwarenessSnippet`), so it likewise does not name `wait`.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" (line 145-149) names `wait` once, inside the flat MCP-facing name list (line 147):

> MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / read_page / scroll / screenshot / keyboard / wait / eval_js / download / mouse / drag / type / diagnostics / find / act / observe / extract`.

This section says the `--browse` flag "adds 19 browser-control tools" and does not mention `--power-browse` or the power gate at all — so as written it implies `wait` (and the other 12 power tools) are available under plain `--browse`, which contradicts the code (`browser_power` requires `--power-browse` too, `src/routes/mcp/handler.ts:351`). `docs/browser-mcp-design.md:371` has the correct gate table: `browser_power | --browse AND --power-browse flag | list_tabs, close_tab, read_page, scroll, keyboard, wait, eval_js, download, mouse, drag, type, diagnostics, find`.

## 3. Assessment

### 3a. Description quality

- Clarity & routing signal: strong. The description states each of the three `until` modes inline, spells out the `networkIdle` heuristic (status complete + 500ms quiet), and gives the exact success/failure return shapes. A model reading it knows when to reach for `wait` (post-navigation settle, appearance of a dynamically-injected element, URL-change confirmation) and how to interpret the result. There is no explicit "when NOT to use" clause, but the three enumerated conditions are self-limiting.
- Accuracy vs implementation: accurate. `Default 10000, hard cap 60000` matches `PER_TOOL_TIMEOUTS.browser_wait = { defaultMs: 10_000, maxMs: 60_000 }` (`src/lib/browser-mcp/dispatch.ts:167`). The return shape and heuristic description match the tool's documented contract; no stale model id (there is no backing model), gate, or default detected in the description text.
- Schema minimality: every field is required, model-tunable, or actionable. `tabId`/`until` are required inputs; `selector`/`urlPattern` are the mode-specific operands; `timeoutMs` is a genuine tunable. No echoed-input or diagnostic-only fields. One structural limitation, not a violation: JSON Schema cannot express "`selector` required iff `until=selector`, `urlPattern` required iff `until=url`" — the three modes share one flat object and the conditional operands are optional. The field descriptions carry the `when until=…` guidance, which is the right mitigation given the schema can't encode the dependency. `tabId` has no description here (consistent with the other browser tools in this file), acceptable since the name is self-evident.

### 3b. System-prompt coverage

- Omitted. `wait` is not named in `buildPeerAwarenessSnippet`'s runtime output — neither the lead surface (line 635) nor the `powerNote` (line 632). This is the coverage finding.
- Whether by design: partly. The awareness snippet deliberately foregrounds the 6 lead-surface tools and, in power mode, the DOM/coordinate-control primitives. `wait` is a settle/synchronization helper rather than a DOM-control primitive, so its omission from the `powerNote`'s "direct DOM / coordinate control" framing is defensible in spirit. But the `powerNote` presents itself as naming "the L0/L1 primitives" and lists 9 of the 13 power tools; `wait` is a first-class power tool by the same gate, so a reader can reasonably infer the list is the power set and miss that `wait` exists. The gap is low-severity because the tool description fully covers routing, and the model still sees `wait` in `tools/list` whenever power mode is on.
- Accuracy & non-redundancy: N/A (not named).
- Framing-constraint compliance: N/A for `wait` specifically. The surrounding `powerNote` is descriptive ("Power mode adds …"), no imperatives/hedges, consistent with the framing constraints pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- Injected block: same as 2b — does not name `wait`.
- Checked-in root CLAUDE.md: names `wait` in the flat tool list (line 147) but the section is drifted from code on the gate. It attributes all listed tools (including the 13 `browser_power` ones) to plain `--browse` ("adds 19 browser-control tools under … `--browse`") and never mentions `--power-browse`. The code gates `wait` behind `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`), and `docs/browser-mcp-design.md:371` documents the two-flag split correctly. So the root CLAUDE.md is internally inconsistent with the design doc and the code on which flag exposes `wait`. This is a section-level drift affecting all power tools, surfaced here because `wait` is one of them.

### 3d. Cross-surface consistency

- description ↔ code: consistent (timeout, modes, return shape all verified).
- system prompt ↔ code: `wait` omitted from injected text; not a contradiction, a coverage gap.
- root CLAUDE.md ↔ code / design doc: contradiction on the gate — CLAUDE.md implies `--browse` alone exposes `wait`; code + `docs/browser-mcp-design.md:371` require `--power-browse` too.
- capability-doc comment (`src/lib/peer-mcp-personas.ts:719`) ↔ runtime `powerNote` (line 632): the comment correctly lists `wait` in the `browser_power` set; the runtime snippet omits it. Not user-facing, but shows the omission is an enumeration gap, not intentional exclusion.

## 4. Findings

- **[Important]** `CLAUDE.md:147` — the "Browser-control MCP (`--browse`)" section states `--browse` "adds 19 browser-control tools" and lists `wait` among them, with no mention of `--power-browse`; but `wait` (a `browser_power` tool) is gated behind `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`), i.e. `--browse` AND `--power-browse`. The doc contradicts the code and the correct gate table in `docs/browser-mcp-design.md:371`, and can mislead an operator into expecting `wait` under plain `--browse`. Fix: split the tool list into the default-`--browse` set vs the `--power-browse`-only set (or add a sentence naming the power gate), matching the design-doc table. (Note: this is a section-wide drift covering all 13 power tools, not unique to `wait`.)

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:632` — the power-mode `powerNote` enumerates 9 of the 13 `browser_power` tools and omits `wait` (also `download`, `close_tab`, `list_tabs`), so `wait` is surfaced to the model only via its `tools/list` description. Because `wait` is the primary synchronization primitive (post-nav settle, dynamic-element appearance), a model relying on the awareness snippet may not know to reach for it. Fix: either add `__wait` to the `powerNote` list, or reframe the note (e.g. "adds the raw power primitives including …") so it doesn't read as an exhaustive set. Low severity — the description fully covers routing and the model sees `wait` in `tools/list` whenever the gate is on.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:285-302` — the flat schema cannot express that `selector` is required iff `until=selector` and `urlPattern` iff `until=url`; a model could send `until=selector` with no `selector`. Current per-field `when until=…` descriptions are the right mitigation given JSON-Schema limits; optionally the handler could return a clearer `reason` than a generic timeout/error when the operand for the chosen `until` is missing. Non-blocking.

## 5. Verdict

Y — the description is accurate, minimal, and well-routed, and the gate is correct in code. The single most important fix is the root `CLAUDE.md:147` gate drift: it lists `wait` (and the other power tools) as `--browse` tools without mentioning the required `--power-browse` flag, contradicting `docs/browser-mcp-design.md:371`.
