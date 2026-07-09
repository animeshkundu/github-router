# Review: `mcp__browser__mouse`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__mouse` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_mouse` |
| Definition | `src/lib/browser-mcp/index.ts:362` |
| Always-on? | gated — power tier |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`, `:1005-1009`) |
| Backing model / endpoint | server-side fn (extension handler `toolMouse`, `src/browser-ext/background.js:1079`; dispatch via `dispatchBrowserTool`, `index.ts:412-414`) |
| Write-capable | yes (mutates the page — dispatches real CDP `Input.dispatchMouseEvent`) |

The gate is a two-clause AND: the `--browse` opt-in plus a detected browser (`browserToolsEnabled()`, `src/lib/mcp-capabilities.ts:167-172`) AND the `--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1` flag (`browserPowerToolsEnabled()`, `src/lib/mcp-capabilities.ts:148-150`). Default `--browse` HIDES this tool; only `--power-browse` exposes it (`src/routes/mcp/handler.ts:348-351`). Setting power implies browse (`src/lib/server-setup.ts:85`). Gate fires symmetrically at `tools/list` (`:351`) and `tools/call` (`:1005-1012`), and because the capability starts with the `browser` literal it also triggers the bridge-readiness pre-flight ahead of the inflight-slot acquire (`isBrowserCapability`, `handler.ts:443-447`, `:1110-1112`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:363-364`), verbatim:

> Move / click / hover / press / release the mouse via real CDP input events (Input.dispatchMouseEvent). Use this when you need behavior that synthetic .click() can't trigger: hover-to-reveal menus, canvas / map / image-map clicks, sites that check event.isTrusted, or precise coordinate targeting. Target with ref (from browser_read_page), CSS selector, or (x, y) in CSS viewport pixels — exactly one. action='move' is the hover (single mouseMoved fires :hover and pointerover reliably). action='dblclick' sends two press/release cycles with incrementing clickCount (a real double-click, not one cycle with clickCount=2). By default the target is hit-tested with elementFromPoint and the call fails with `target_obscured` if the topmost element isn't the target or a descendant — pass force:true to bypass when you know an overlay forwards events.

Input-schema fields (`index.ts:365-410`). `required: ["tabId", "action"]`, `additionalProperties: false`:

- `tabId` (number) — no description.
- `action` (string, enum `move|click|dblclick|down|up`) — "What to do. move=position cursor (hover). click=press+release. dblclick=two press+release with clickCount 1 then 2. down=press only. up=release only."
- `ref` (string) — "Element ref from browser_read_page (preferred). Resolves to bbox center. Exactly one of ref / selector / (x+y) required."
- `selector` (string) — "CSS selector (fallback). Resolves to bbox center."
- `x` (number) — "Target x in CSS viewport pixels. Pair with y. Use when working from a screenshot or eval_js output."
- `y` (number) — "Target y in CSS viewport pixels. Pair with x."
- `button` (string, enum `left|right|middle`) — "Mouse button for click / dblclick / down / up. Default 'left'. Ignored for action=move."
- `steps` (number) — "Humanlike trajectory. >1 interpolates the cursor approach over N mouseMoved events. Default 1 (teleport). Clamped to [1, 100]."
- `stepDelayMs` (number) — "Pause between interpolated mouseMoved events when steps > 1. Default 8. Clamped to [0, 50]."
- `force` (boolean) — "Skip the pre-click elementFromPoint hit-test (ref/selector mode only). Default false."

### 2b. System prompt (`--append-system-prompt`)

`browser_mouse` is named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-636`) ONLY in the power-mode branch. The `powerNote` string is appended to the browser sentence iff `opts.powerBrowseAvailable` (`:631`), verbatim (`:632`):

> Power mode adds the L0/L1 primitives (`mcp__browser__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

When power mode is off the note is `""` (`:633`) and the base browser sentence (`:634-635`) names only the six lead tools (`__act`, `__observe`, `__extract`, `__navigate`, `__open_tab`, `__screenshot`) — `mouse` is not mentioned. `powerBrowseAvailable` is threaded from `state.powerBrowseEnabled` (`src/claude.ts:1025`), so the snippet names `__mouse` exactly when the tool is actually served. Correct gating.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness** block — the same `buildPeerAwarenessSnippet` text as 2b, so the mirrored CLAUDE.md names `mcp__browser__mouse` only under power mode. Consistent with 2b.

Checked-in repo `CLAUDE.md` (project root) documents the tool under `### Browser-control MCP (--browse)` (`CLAUDE.md:145-147`). Line 147 lists `mouse` in the MCP-facing tool-name set and describes the humanlike-input invariants:

> The humanlike-input set (`mouse / drag / type`) routes through CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` for trusted events, hover-to-reveal menus … Three load-bearing invariants: (1) every action takes an explicit target — no stateful cursor cache (MV3 SW dormancy would wipe it silently); (2) `withTabInputLock(tabId, fn)` serialises mouse / drag / type / keyboard / scroll(at-pointer) per tab (CDP mouse state is global per attachment); (3) pre-click `elementFromPoint` hit-test fails with `target_obscured` if an overlay covers the target, bypass via `force: true`.

The three invariants are accurate against the extension code (verified below). But the same line frames all "19 browser-control tools" as one flat set gated solely by `browserToolsEnabled()` (`CLAUDE.md:147`) and never states that `mouse` (and the other power primitives) are gated behind the separate `browser_power` tier — a drift from the code (see Findings). The dedicated design doc `docs/browser-mcp-design.md:371,373` documents the `browser_power` gate correctly (`--browse AND --power-browse flag`), so the drift is localized to the root CLAUDE.md summary.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. The "Use this when …" clause gives four concrete when-to-use triggers (hover-to-reveal menus, canvas/map/image-map, `event.isTrusted` gating, precise coordinate targeting) and implicitly the when-NOT: it names `synthetic .click()` as the thing this tool is for cases the fast path "can't trigger", steering the model to the compound `act` path for the common case. The three-way target selector with "exactly one" is unambiguous.
- **Accuracy vs implementation.** Every behavioral claim checks out against `src/browser-ext/background.js`:
  - `action='move'` = single mouseMoved → `toolMouse` returns after the mouseMoved loop with no press (`background.js:1120-1121`).
  - `action='dblclick'` = two press/release cycles with clickCount 1 then 2 (a real double-click, not one cycle with clickCount=2) → matches exactly (`background.js:1141-1144`), with the rationale in the code comment (`:1136-1140`).
  - `down`/`up` = press only / release only (`background.js:1123-1130`).
  - `elementFromPoint` hit-test defaulting to `target_obscured` unless `force:true` → `toolMouse` (`background.js:1102-1106`) plus `resolveMouseTarget` (`:1022-1040`); the "isn't the target or a descendant" wording matches `isTarget = top === el || el.contains(top)` (`:1030`), and the comment (`:1023-1029`) explains why `top.contains(el)` is deliberately NOT accepted.
  - `force` "ref/selector mode only" is accurate — coordinate mode sets `hitTest: null` (`:998`), so the `target.hitTest && !isTarget` guard never fires for (x,y) targets.
  - `steps`/`stepDelayMs` clamps `[1,100]`/`[0,50]`, defaults 1/8 → `background.js:1092-1093`.
  - `button` default `left`, ignored for `move` → `:1086-1091`; `move` passes `"none"`/0 to the mouseMoved dispatch (`:1117`), so button truly is ignored for move.
- **Schema minimality** (per "ruthlessly minimal MCP tool surface", `docs/peer-mcp-design.md`). Every field is model-tunable and required to drive a distinct behavior: `action` selects the gesture, the ref/selector/(x,y) trio is the target (mutually exclusive, enforced by `assertSingleTarget`, `background.js:1055-`), `button`/`steps`/`stepDelayMs`/`force` are behavior knobs. No echoed-input or diagnostic-only fields. The `steps`/`stepDelayMs` humanlike-trajectory knobs are a slight surface expansion for a niche (bot-detection) case, but they carry defaults that reduce to a teleport (steps=1), so they cost the model nothing when unused — acceptable.

### 3b. System-prompt coverage

- **Named**, and correctly — only in the power-mode branch (`peer-mcp-personas.ts:631-632`), matching the runtime gate. Omission in default `--browse` mode is by design (the tool isn't served there), so the snippet never names an unlisted tool.
- **Accurate & non-redundant.** The `powerNote` is a one-line inventory ("Power mode adds the L0/L1 primitives …"), not a re-description of the tool — the per-tool detail lives in the `tools/list` description. No overlap.
- **Framing-constraint compliance.** The note is a plain capability statement — no imperatives ("Lead with X"), no hedges, no anchors disguised as description. Consistent with the framing pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- The injected peer-awareness block (mirrored) is identical to 2b and therefore accurate and correctly gated.
- The checked-in root `CLAUDE.md:147` invariant descriptions are accurate, but the tool-count / gating framing has drifted: it presents `mouse` inside a flat "19 browser-control tools" set under `browserToolsEnabled()` and never mentions the `browser_power` sub-gate that hides it in default `--browse`. The authoritative design doc (`docs/browser-mcp-design.md:371,373`) has the correct gate. This is an internal-docs consistency gap, not a model-facing defect (the mirrored peer-awareness snippet the model actually reads is correct).

### 3d. Cross-surface consistency

- Description ↔ extension handler: consistent (3a).
- System prompt ↔ runtime gate: consistent — `__mouse` named iff `powerBrowseEnabled` (`claude.ts:1025` → `peer-mcp-personas.ts:631`).
- Root CLAUDE.md ↔ code: **inconsistent** on the gating tier (flat `browserToolsEnabled()` framing vs the actual `browser_power` AND-gate). Design doc ↔ code: consistent.

## 4. Findings

- **[Suggestion]** `CLAUDE.md:147` — the root CLAUDE.md's Browser-control section frames all "19 browser-control tools" as gated solely by `browserToolsEnabled()` and never states that `mouse` (with the other L0/L1 primitives) is gated behind the separate `browser_power` tier (`--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`); default `--browse` exposes only the 6 lead tools (`src/routes/mcp/handler.ts:348-351`, `docs/browser-mcp-design.md:371,373`). Fix: add one clause to line 147 noting the power sub-gate, e.g. "the L0/L1 primitives (`read_page / scroll / keyboard / eval_js / mouse / drag / type / diagnostics / find / …`) live behind `--power-browse`; default `--browse` exposes only `act / observe / extract / navigate / screenshot / open_tab`." Non-blocking: the mirrored peer-awareness snippet the model reads is already correct, and the design doc is authoritative — this is a summary-doc drift, not a runtime or model-facing bug.

No Critical or Important findings. The description is accurate against the extension code, the schema is minimal, and the system-prompt gating is correct.

## 5. Verdict

Y — the injected surface for `mcp__browser__mouse` is correct, minimal, consistent, and well-routed on every model-facing surface (description, mirrored peer-awareness snippet). Single most important fix: reconcile the root `CLAUDE.md:147` flat-19-tools framing with the actual `browser_power` sub-gate so the checked-in summary matches the code and the design doc (Suggestion-level).
