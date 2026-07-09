# Review: `mcp__browser__screenshot`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__screenshot` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_screenshot` |
| Definition | `src/lib/browser-mcp/index.ts:162` (entry), handler `dispatchBrowserTool("browser_screenshot", …)` at `:180`; extension impl `toolScreenshot` at `src/browser-ext/background.js:162` |
| Always-on? | gated by capability `browser` (the `--browse` lead surface) |
| Capability gate | `browser` → `browserToolsEnabled()` (`src/lib/mcp-capabilities.ts:167`): opt-in (`--browse` / `GH_ROUTER_ENABLE_BROWSE=1`) AND `hasSupportedBrowserInstalled()` |
| Backing model / endpoint | server-side fn (extension `chrome.tabs.captureVisibleTab`; no model) |
| Write-capable | no (read-only capture; but see 3a — it silently activates the target tab as a side effect) |

`screenshot` sits in the **basic** lead tier (`capability: "browser"`), not `browser_power`. It is one of the 6 default lead-surface tools (`act, observe, extract, navigate, screenshot, open_tab`) exposed by plain `--browse`, per `docs/browser-mcp-design.md:373` and the capability note at `src/lib/peer-mcp-personas.ts:708`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:164-165`), verbatim:

> Capture a PNG screenshot of the visible area of a tab. Returns base64-encoded image bytes plus contentType. The tab must be active in its window; this tool auto-activates if needed.

Input schema (`src/lib/browser-mcp/index.ts:166-178`), `required: ["tabId"]`, `additionalProperties: false`:

- `tabId` (number, required): "Tab id from browser_list_tabs / browser_open_tab."
- `format` (string enum `png` | `jpeg`, optional): "Image format. Default 'png'."

### 2b. System prompt (`--append-system-prompt`)

`screenshot` IS named in the lead-surface clause built by `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:634-636`). Exact clause, verbatim:

> `mcp__browser__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

The whole clause is gated on `opts.browseAvailable` (`:630`), so it appears only when `--browse` is active. `screenshot` is grouped with `navigate` / `open_tab` under the phrase "for state and visuals" — the only word tying it to visual capture is "visuals". This is a group-level mention, not a per-tool routing signal.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block carries the SAME text as 2b (both come from `buildPeerAwarenessSnippet`), so the mirrored CLAUDE.md names `__screenshot` only inside "`__navigate` / `__open_tab` / `__screenshot` for state and visuals."

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-147`) lists `screenshot` in the 19-tool inventory ("`list_tabs / open_tab / close_tab / navigate / read_page / scroll / screenshot / …`") and states the rename is MCP-facing only (wire string stays `browser_*`). It does not describe screenshot's per-tool behavior (no mention of auto-activation or the headless-surface caveat). Agreement with code: the tool-name inventory and gate description match; nothing in root CLAUDE.md contradicts the code.

`docs/browser-mcp-design.md` documents it in the tool table (`:89`: "Capture a base64 PNG of the visible tab area."), the read-only-pacing list (`:397`, screenshot skips inter-action delay), the lead-surface count (`:373`), and the device-px mapping note (`:117`, `read_page` viewport block → map CSS-px bbox to device-px for screenshot). None of these mention auto-activation either.

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal.** The description states the mechanics (visible area, base64 + contentType, auto-activate) but gives the model no explicit "use screenshot WHEN" / "prefer observe when text is enough" signal. The when-to-use routing lives entirely on the sibling side: `browser_observe`'s description (`src/lib/browser-mcp/index.ts:760`) says "Cheaper than screenshots when text is enough. Does not include canvas/SVG content — those surface as a `hasVisualSurfaces` flag; switch to browser_screenshot for visuals." So the observe/screenshot split is documented — but only from observe's entry. A model that lands on `screenshot` first learns nothing about when to prefer text-based `observe`, nor that screenshot is the canvas/SVG/visuals escape hatch. The routing is one-directional.

**Accuracy vs implementation.**
- "PNG screenshot" in the opening sentence is slightly narrow given `format` also accepts `jpeg` (`:172-176`); the returned `contentType` is derived from the actual data URL (`background.js:186-190`), so a `jpeg` request returns `image/jpeg`. Minor wording mismatch, not a functional bug.
- "The tab must be active in its window; this tool auto-activates if needed" — VERIFIED accurate. `toolScreenshot` (`background.js:167-176`) calls `chrome.tabs.get(tabId)`, and if `!tab.active` runs `chrome.tabs.update(tabId, { active: true })` + a 150ms paint pause, because `captureVisibleTab` is window-scoped and snapshots the active tab of the named window.
- NOT stated anywhere in the model-facing surface: on Chrome-for-Testing launched headed without `--headless=new`, `captureVisibleTab` hangs indefinitely (no OS rendering surface — `background.js:178-185`). This is a real-Chrome-works / CfT-headed-hangs caveat. It is an E2E-harness concern, not a normal end-user path (real Chrome/Edge with a visible window works), so omitting it from the description is defensible.
- The auto-activation SIDE EFFECT (screenshotting a background tab yanks it to the foreground and changes which tab is active) is stated as a mechanism but not flagged as a consequence the model should weigh. This is the one behavior most likely to surprise: a "read-only" capture mutates window focus.

**Schema minimality.** Both fields pass the ruthlessly-minimal bar (`docs/peer-mcp-design.md`): `tabId` is required to call, `format` is model-tunable and changes output. No echoed-input or diagnostic-only fields. Clean.

### 3b. System-prompt coverage

**Named or omitted?** Named — but only as part of the grouped phrase "`__navigate` / `__open_tab` / `__screenshot` for state and visuals" (`peer-mcp-personas.ts:635`). By design the awareness snippet is a compact lead-surface map, not a per-tool manual, so a group-level mention is appropriate. The single word "visuals" is the only screenshot-specific hint.

**Accurate & non-redundant.** Accurate (screenshot does serve visuals) and non-redundant with the description (the snippet gives the map, the description gives the mechanics). No drift.

**Framing-constraint compliance.** The clause is declarative — "Lead surface: … for state and visuals" — with no imperatives ("Lead with X"), no hedges, no anchors disguised as description. Compliant with the framing constraint pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

**Accurate, non-drifted.** The mirrored block is byte-identical to 2b (same generator), so it inherits 2b's accuracy. Root CLAUDE.md's inventory + gate description match the code (`browserToolsEnabled()`, 19 tools, `browser` server, MCP-facing rename). No drift detected.

**Injected block vs checked-in root consistency.** Consistent: both name `screenshot` under the `browser` server; neither contradicts the tool description. Root CLAUDE.md is inventory-level (correctly does not restate per-tool mechanics).

### 3d. Cross-surface consistency

No contradictions. Description ↔ system prompt ↔ CLAUDE.md ↔ code all agree that screenshot is a `browser`-gated, base64-image capture on the lead surface. The one asymmetry is a coverage gap, not a conflict: the observe/screenshot decision boundary (text-vs-visuals, canvas/SVG → screenshot) is stated on observe's description but absent from screenshot's, so the routing signal is one-directional rather than contradictory.

## 4. Findings

- **[Suggestion]** `src/lib/browser-mcp/index.ts:164-165` — screenshot's description carries no "when to use / when NOT to use" routing signal; the observe-vs-screenshot split (prefer `observe` when text suffices; use `screenshot` for canvas/SVG/visuals) is documented only on `browser_observe` (`:760`), so a model that reaches for screenshot first never learns the cheaper text path exists. Fix: add one clause, e.g. "Prefer browser_observe when page text is enough; use screenshot for canvas / SVG / visual layout." Makes the routing symmetric.
- **[Suggestion]** `src/lib/browser-mcp/index.ts:164` — "Capture a PNG screenshot …" understates the schema, which also accepts `jpeg`. Fix: "Capture a screenshot (PNG by default, or JPEG) of the visible area of a tab."
- **[Suggestion]** `src/lib/browser-mcp/index.ts:165` — auto-activation is described as a mechanism but not flagged as a side effect: capturing a background tab pulls it to the foreground and changes the active tab (`background.js:170-176`). A model treating screenshot as side-effect-free could reorder the user's tabs unexpectedly. Fix: append "(note: capturing a background tab activates it, changing which tab is focused)."

No Critical or Important findings. The surface is correct and does not tell the model to do anything the code rejects.

## 5. Verdict

Y — the injected surface is correct, minimal, consistent, and safely gated; the schema is tight and the auto-activation claim is verified against the extension. Single most valuable fix: add the symmetric observe-vs-screenshot routing clause so the model reliably picks the cheap text path and reserves screenshot for canvas/SVG/visuals (Suggestion 1).
