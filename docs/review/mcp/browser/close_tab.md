# Review: `mcp__browser__close_tab`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__close_tab` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_close_tab` |
| Definition | `src/lib/browser-mcp/index.ts:115-134` |
| Always-on? | gated by `--browse` opt-in + `--power-browse` + a Chromium browser on disk |
| Capability gate | `browser_power` (`index.ts:130`) → `browserToolsEnabled() && browserPowerToolsEnabled()` (list-time `src/routes/mcp/handler.ts:351`; call-time `handler.ts:1005-1008`) |
| Backing model / endpoint | server-side fn — `dispatchBrowserTool` (WS → local bridge → MV3 extension `toolCloseTab`, `src/browser-ext/background.js:124-131`); no model call |
| Write-capable | yes (destructive: `chrome.tabs.remove()` closes real browser tabs) |

Note on tier: `close_tab` is a POWER-tier tool. It carries `capability: "browser_power"` (`index.ts:130`), so it is hidden under the default `--browse` surface (the 6 lead-tier tools: `act`, `observe`, `extract`, `navigate`, `screenshot`, `open_tab`) and appears only when `--power-browse` (or `GH_ROUTER_ENABLE_POWER_BROWSE=1`) is also set. Its sole schema cross-reference, `browser_list_tabs`, is likewise `browser_power` (`index.ts:84`), so both surface together — the "from browser_list_tabs" hint is never dangling.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:117`):

> Close one or more tabs by tab id.

Input schema (`index.ts:118-129`) — `required: ["tabIds"]`, `additionalProperties: false`:

- `tabIds` (array of number, required): "Array of tab ids to close (from browser_list_tabs)."

Handler behavior (`src/browser-ext/background.js:124-131`): rejects an empty/missing array with `browser_close_tab: tabIds[] is required`, filters to numeric entries, calls `chrome.tabs.remove(tabIds)`, returns `{ closed: <tabIds.length> }`.

### 2b. System prompt (`--append-system-prompt`)

`close_tab` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:630-636`). The `browseAvailable` clause names the 6 lead-tier tools inline (`__act` / `__observe` / `__extract` / `__navigate` / `__open_tab` / `__screenshot`), and the conditional `powerNote` (`peer-mcp-personas.ts:631-633`, gated on `opts.powerBrowseAvailable`) enumerates the power primitives:

> Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

That list is 9 tools: `mouse, drag, type, keyboard, scroll, eval_js, read_page, diagnostics, find`. The `browser_power` tier actually holds 13 (`docs/browser-mcp-design.md:371`): those 9 **plus `close_tab`, `list_tabs`, `wait`, `download`**. So `close_tab` (and 3 siblings) is surfaced to the model ONLY via its `tools/list` description — not via the system prompt at any tier.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Two covering surfaces:

1. **Mirrored peer-awareness block** — identical text to 2b. `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653`) writes the same `buildPeerAwarenessSnippet` output into the mirror's CLAUDE.md, so descendant agents see the same clause — which means the `close_tab` omission in 2b propagates here verbatim (one source string, no independent drift). `close_tab` is absent from the mirrored block too.

2. **Checked-in root CLAUDE.md** — "Browser-control MCP (`--browse`)" section (`CLAUDE.md:147`). `close_tab` IS named here, in the MCP-facing rename list: "MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / …`". This is the only injected/checked-in prose that names the tool. The same line's "adds 19 browser-control tools under the `browser` MCP server" framing overstates the default surface (only 6 ship under bare `--browse`; the other 13 including `close_tab` require `--power-browse`) — a group-level staleness already flagged on the `open_tab` review, not `close_tab`-specific.

Design doc `docs/browser-mcp-design.md:371` lists `close_tab` correctly in the `browser_power` row (13 tools) and states the 6-vs-power split accurately (line 373).

## 3. Assessment

### 3a. Description quality

- **Routing signal**: adequate but thin. "Close one or more tabs by tab id" is unambiguous about WHAT it does and the schema's "(from browser_list_tabs)" points the model at how to obtain ids. It is the shortest description in the browser suite. What is missing is (i) the return shape — `{ closed: N }` (`background.js:130`) is undocumented, so the model cannot know what a success looks like, and (ii) a note that `tabIds` must be non-empty (an empty array throws `tabIds[] is required`, `background.js:127`), which the schema's `required: ["tabIds"]` does not convey (a present-but-empty array satisfies `required`). Neither omission misroutes, but both cost the model a round-trip to learn by failure.
- **Accuracy vs implementation**: accurate. "Close one or more tabs" matches `chrome.tabs.remove(tabIds)` over an array (`background.js:129`); the plural is correct (unlike the team-lead brief's "closes a tab by id" / `{tabId}` framing, the real schema is `{tabIds: number[]}`). No stale model id, default, or gate. The description makes no claim the code contradicts.
- **Schema minimality**: clean and minimal. The single `tabIds` field is required to call and fully model-tunable; no echoed-input, diagnostic-only, or non-actionable field. `additionalProperties: false` is set. Passes the "ruthlessly minimal MCP tool surface" bar (`docs/peer-mcp-design.md`).

### 3b. System-prompt coverage

- **Omitted.** `close_tab` is named in neither the lead-surface clause nor the `powerNote` (`peer-mcp-personas.ts:630-636`). It is discoverable only through its `tools/list` description.
- **By design or gap?** Partly principled, partly a gap. The lead-surface omission is correct — `close_tab` is a power tool and MUST NOT appear in the always-on lead list, or the snippet would name a tool absent from a plain `--browse` `tools/list` (the snippet's invariant is "never name a tool missing from the live tools/list"). But the `powerNote` IS the power-tier routing map, gated on the exact same `powerBrowseAvailable` signal that makes `close_tab` visible, and it deliberately enumerates 9 of the 13 power tools while silently dropping `close_tab`, `list_tabs`, `wait`, and `download`. Those four are not lower-value: `list_tabs` is the discovery entry point the model needs to obtain the very `tabIds`/`tabId` every other power tool consumes, and `close_tab` is the only teardown primitive. The powerNote's own frame ("the L0/L1 primitives ... for direct DOM / coordinate control") reads as a curated subset, but nothing signals to the model that four more power tools exist — so the model may never form the intent to list or close tabs, and will lean on the description-only discovery path.
- **Framing-constraint compliance**: not applicable to an absent clause; were `close_tab` added, it must stay a neutral capability mention (no imperative, hedge, or anchor) per the rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Mirrored peer block**: inherits the 2b omission verbatim — `close_tab` is absent. No independent drift (single builder output), but the gap is faithfully reproduced.
- **Root CLAUDE.md**: names `close_tab` accurately in the rename list (`CLAUDE.md:147`); no `close_tab`-specific inaccuracy. The group-level "19 tools under `--browse`" overstatement (should be 6 lead + 13 power) is pre-existing and tracked on the `open_tab` review.

### 3d. Cross-surface consistency

- description ↔ code: consistent. `{tabIds: number[]}` schema, non-empty requirement, `chrome.tabs.remove`, plural wording all agree (`index.ts:117-129` ↔ `background.js:124-131`). The return shape `{ closed: N }` is in code but not in the description (documentation gap, not a contradiction).
- description ↔ system prompt: the description carries the tool; the system prompt does not mention it. No contradiction, but a coverage asymmetry — the powerNote names 9 siblings and omits this one.
- root CLAUDE.md ↔ code: `close_tab` rename entry matches; the group-level tool-count framing overstates the default tier (pre-existing, not `close_tab`-specific).

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:631-633` — the `powerNote` enumerates 9 of the 13 `browser_power` tools and omits `close_tab`, `list_tabs`, `wait`, and `download`. `list_tabs` is the discovery primitive that yields the `tabId`/`tabIds` every other power tool (including `close_tab`) consumes, and `close_tab` is the only teardown tool — dropping both from the one power-tier routing map the model reads leaves tab lifecycle (enumerate → close) surfaced by tool descriptions alone, so the model may never form the intent to use them. Because the powerNote fires on the exact `powerBrowseAvailable` gate that makes these four visible, naming them breaks no tools/list invariant. Fix: extend the powerNote list to the full 13 (add `__list_tabs`, `__close_tab`, `__wait`, `__download`) as a neutral capability mention, e.g. append "plus `__list_tabs` / `__close_tab` for tab lifecycle and `__wait` / `__download`." Keep it a plain inventory — no imperative. (Argument for Important over Suggestion: this is not one tool's polish but a systematic 4-of-13 undercount in the sole power-tier routing surface, and it hides the discovery entry point `list_tabs`; the framing rules make the fix zero-risk, so leaving it degrades routing for no reason. If scoped strictly to `close_tab` in isolation the omission alone is a Suggestion, but the shared root cause is the powerNote's incomplete list, which is Important to correct once.)

- **[Suggestion]** `src/lib/browser-mcp/index.ts:117` — the description omits the success return shape `{ closed: N }` (`src/browser-ext/background.js:130`) and the non-empty-array requirement (`background.js:127` throws `tabIds[] is required`). Add both so the model knows what success looks like and does not learn the empty-array constraint by a failed call, e.g. "Close one or more tabs by tab id. `tabIds` must be non-empty; returns `{closed: <count>}`."

- **[Suggestion]** `CLAUDE.md:147` (root, group-level, not `close_tab`-specific) — "adds 19 browser-control tools under the `browser` MCP server" and the full 19-name list overstate the default `--browse` surface (6 lead-tier); the other 13, `close_tab` among them, require `--power-browse`. Align with `docs/browser-mcp-design.md:369-373`. Does not affect `close_tab`'s gating.

## 5. Verdict

**Y (with one Important system-prompt fix).** `close_tab`'s description is accurate, minimal, correctly `browser_power`-gated, and free of any code contradiction; its schema is exemplary. The gap is coverage, not correctness: the power-tier `powerNote` (`peer-mcp-personas.ts:631-633`) names 9 of 13 power tools and silently drops `close_tab`, `list_tabs`, `wait`, and `download` — the single most important fix is to complete that list so the model can route to tab enumeration and teardown, not just discover them by reading tool descriptions.
