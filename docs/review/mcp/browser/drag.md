# Review: `mcp__browser__drag`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__drag` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_drag` |
| Definition | `src/lib/browser-mcp/index.ts:417` |
| Always-on? | gated |
| Capability gate | `browser_power` → `browserToolsEnabled()` AND `state.powerBrowseEnabled` (`--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`); see `src/lib/peer-mcp-personas.ts:717-721` |
| Backing model / endpoint | server-side fn (dispatched to the MV3 extension handler `toolDrag`, `src/browser-ext/background.js:1168`) |
| Write-capable | yes (mutates page state; in `MUTATES_PAGE` set per `docs/browser-mcp-design.md:338`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:418-419`):

> "Drag from a source to a destination. Auto-detects whether to use HTML5 native DnD (for elements with draggable='true', via CDP Input.setInterceptDrags + Input.dispatchDragEvent — the only path that triggers Chromium's native dragstart pipeline) or pointer-based DnD (for react-dnd / Sortable.js / mouse-event-based drag handlers — via CDP mouse events with buttons:1 held throughout). Each of from/to can be a ref (preferred), a CSS selector, or x+y coordinates. Returns { ok: true, mode_used: 'pointer'|'html5' } so you can verify which path ran."

Input-schema fields (`src/lib/browser-mcp/index.ts:420-456`), `required: ["tabId"]`, `additionalProperties: false`:

- `tabId` (number) — no description.
- `fromRef` (string) — "Source ref from browser_read_page (preferred)."
- `fromSelector` (string) — "Source CSS selector (fallback)."
- `fromX` (number) — "Source x in CSS viewport pixels. Pair with fromY."
- `fromY` (number) — "Source y in CSS viewport pixels. Pair with fromX."
- `toRef` (string) — "Destination ref from browser_read_page (preferred)."
- `toSelector` (string) — "Destination CSS selector (fallback)."
- `toX` (number) — "Destination x in CSS viewport pixels. Pair with toY."
- `toY` (number) — "Destination y in CSS viewport pixels. Pair with toX."
- `button` (enum `left|middle`) — "Mouse button held during drag. Default 'left'."
- `steps` (number) — "Intermediate mouseMoved events from→to with the button held. Drag-detect libraries need a trajectory to fire. Default 15. Clamped to [1, 100]."
- `stepDelayMs` (number) — "Pause between intermediate moves. Default 12. Clamped to [0, 50]."
- `mode` (enum `auto|pointer|html5`) — "Drag mode. 'auto' (default) picks html5 if the source has draggable='true', else pointer. Override only when auto detection misses."
- `force` (boolean) — "Skip the pre-press elementFromPoint hit-test on the source. Default false."

### 2b. System prompt (`--append-system-prompt`)

Named ONLY in Power mode, in the `powerNote` string of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-635`). Verbatim `powerNote`:

> " Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control."

`__drag` appears only as a bare name in a comma list. It is emitted only when `opts.powerBrowseAvailable` is true (`peer-mcp-personas.ts:631`); otherwise `powerNote` is `""` and the para2 line describes only the lead surface (`act` / `observe` / `extract` / `navigate` / `open_tab` / `screenshot`). No dedicated clause, behavior text, or when-to-use guidance for `drag` exists in the snippet — the description carries all of that. Pinned by `tests/peer-mcp-personas.test.ts:465-484` (power tools present iff `powerBrowseAvailable`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering injected block: **peer-awareness** (identical text to 2b — the same `buildPeerAwarenessSnippet` output is mirrored into `<CLAUDE_CONFIG_DIR>/CLAUDE.md`). So the mirrored coverage of `drag` is the same bare `__drag` name in the `powerNote` list, present only under power mode.

Checked-in repo `CLAUDE.md` (project root), "Browser-control MCP (`--browse`)", `CLAUDE.md:147`:

> "MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / read_page / scroll / screenshot / keyboard / wait / eval_js / download / mouse / drag / type / diagnostics / find / act / observe / extract`. … The humanlike-input set (`mouse / drag / type`) routes through CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` for trusted events, hover-to-reveal menus, drag-and-drop (auto-detects HTML5-DnD via `Input.setInterceptDrags` + `Input.dispatchDragEvent` when source has `draggable="true"`), and per-keystroke typing. Three load-bearing invariants: (1) every action takes an explicit target — no stateful cursor cache …; (2) `withTabInputLock(tabId, fn)` serialises mouse / drag / type / keyboard / scroll(at-pointer) per tab (CDP mouse state is global per attachment); (3) pre-click `elementFromPoint` hit-test fails with `target_obscured` … bypass via `force: true`."

The drag-specific claims (HTML5 auto-detect, `withTabInputLock` serialization, explicit-target invariant, `force`/`target_obscured`) all match the code. But this section frames `drag` as part of the plain `--browse` 19-tool surface and never mentions the `--power-browse` gate that actually governs it (see Finding [Important]). The fuller design doc `docs/browser-mcp-design.md:371-373` does document the gate correctly (`browser_power` = `--browse` AND `--power-browse`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. The description tells the model both mechanisms (HTML5 native DnD vs pointer DnD), names the concrete library families each path serves (react-dnd / Sortable.js for pointer), and gives a self-verification hook (`mode_used`). The `mode` field's "Override only when auto detection misses" is a good when-NOT-to-touch signal. Missing a "when NOT to use drag" (e.g. for a simple click use `mouse`/`act`), but the sibling `mouse` and `type` descriptions carry the cross-references, so routing between the input tools is discoverable.
- **Accuracy vs implementation**: mechanism claims verified against `toolDrag` / `dragHtml5` / `dragPointer` (`background.js:1168-1335`): `mode==="auto"` picks `html5` iff `from.draggable` (`background.js:1203`); html5 path uses `Input.setInterceptDrags` + `Input.dispatchDragEvent` (`background.js:1279,1309-1317`); pointer path holds `buttons:buttonBits` across intermediate `mouseMoved` (`background.js:1237-1239`). Defaults match: `steps` 15, `stepDelayMs` 12, `button` left, `mode` auto, `force` false (`background.js:1177-1180`). Clamps match ([1,100], [0,50]) (`background.js:1177-1178`). One inaccuracy: the description says the return is `{ ok: true, mode_used: 'pointer'|'html5' }`, but the handler returns `{ ok: true, mode_used, from: {x,y}, to: {x,y} }` (`background.js:1212`) — under-documented, not wrong (see Finding [Suggestion]).
- **Schema minimality**: all fourteen fields are model-tunable or required. `tabId` required; the three from-target descriptors + three to-target descriptors are the documented ref/selector/coords trichotomy enforced by `assertSingleTarget` (`background.js:1055-1069`); `button`, `steps`, `stepDelayMs`, `mode`, `force` each change behavior. No echoed-input or diagnostic-only fields. The `additionalProperties: false` guard is present. One minor gap: `tabId` alone in the schema has no `description` (consistent with sibling tools, so not a drift). Verdict: minimal.

### 3b. System-prompt coverage

- **Named or omitted**: named (bare `__drag`) only in `powerNote`, only when `powerBrowseAvailable`. Correct by design — drag is a `browser_power` tool, so the snippet must not advertise it when power mode is off, or the model would attempt a tool it can't call.
- **Accurate & non-redundant**: the snippet says nothing about drag beyond the name and the umbrella "direct DOM / coordinate control" framing, so it cannot drift from the description and adds a routing pointer (these are the power primitives) rather than duplicating behavior. Good separation of concerns.
- **Framing-constraint compliance**: `powerNote` is descriptive ("Power mode adds …"), no imperative ("Lead with"/"Use X first"), no hedges, no anchors. Consistent with the framing constraint pinned by `tests/peer-mcp-personas.test.ts:536` (`not.toMatch(/^Lead with /im)`).

### 3c. CLAUDE.md coverage

- **Injected block**: accurate and non-redundant (see 3b — it is the same snippet text).
- **Checked-in root CLAUDE.md**: the drag-mechanism prose is accurate against code, but the section presents `drag` as one of the plain-`--browse` 19 tools and omits the `--power-browse` gate. That is a real drift from `peer-mcp-personas.ts:717-721` and `docs/browser-mcp-design.md:371-373`, both of which put drag behind `browser_power`. A reader of root CLAUDE.md would conclude `claude --browse` alone exposes `drag`; it does not.

### 3d. Cross-surface consistency

- description ↔ code: consistent except the return-shape under-documentation (Suggestion).
- system prompt ↔ code: consistent; the `browser_power` gating in the snippet (name shown only under `powerBrowseAvailable`) matches the `capability: "browser_power"` on the tool (`src/lib/browser-mcp/index.ts:458`).
- root CLAUDE.md ↔ code / design doc: inconsistent on the gate — root CLAUDE.md omits `--power-browse` for the L0/L1 set including drag (Important).

## 4. Findings

- **[Important]** `CLAUDE.md:147` — the "Browser-control MCP" section lists `drag` (and the rest of the L0/L1 humanlike-input set) as part of the plain `--browse` 19-tool surface and never mentions the `--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1` gate that actually governs it (`src/lib/peer-mcp-personas.ts:717-721`, `src/lib/browser-mcp/index.ts:458` `capability: "browser_power"`). The fuller design doc `docs/browser-mcp-design.md:371-373` documents the gate correctly, so root CLAUDE.md is the drifted surface. Fix: add one clause to the section noting that `mouse / drag / type / keyboard / scroll / eval_js / read_page / diagnostics / find` are the `browser_power` L0/L1 primitives exposed only under `--power-browse` (default `--browse` exposes the 6-tool lead surface). This is doc-only; the model-facing gate itself is correct.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:419` — the description advertises the return as `{ ok: true, mode_used: 'pointer'|'html5' }`, but `toolDrag` also returns the resolved `from`/`to` coordinates (`{ ok: true, mode_used, from: {x,y}, to: {x,y} }`, `src/browser-ext/background.js:1212`). Harmless (extra fields the model can ignore), but for precision either document the coords or drop them. No functional impact.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:452-455` — the `force` field description ("Skip the pre-press elementFromPoint hit-test on the source") correctly scopes to the source only, but the description body does not mention that the destination is never hit-tested. `resolveMouseTarget` computes a `hitTest` for `to` (`background.js:1197`) yet `toolDrag` only checks `from.hitTest` (`background.js:1198`). Not a defect, but a one-line note ("only the source is hit-tested; the drop target is used as-is") would prevent the model from expecting a `target_obscured` on the destination.

## 5. Verdict

Y — the model-facing description and schema are accurate, minimal, and well-routed, and the system-prompt/mirrored coverage is correctly gated to power mode. Single most important fix: correct the root `CLAUDE.md:147` drift so it states `drag` (and the L0/L1 set) live behind `--power-browse`, not plain `--browse`.
