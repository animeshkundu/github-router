# Review: `mcp__browser__scroll`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__scroll` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_scroll` |
| Definition | `src/lib/browser-mcp/index.ts:206` (entry), handler `src/browser-ext/background.js:761` (`toolScroll`) |
| Always-on? | gated by `browser_power` capability |
| Capability gate | `browser_power` → `browserPowerToolsEnabled()` (`src/lib/mcp-capabilities.ts:148`), ANDed with `browserToolsEnabled()` in the handler filter chain |
| Backing model / endpoint | server-side fn (extension dispatch — no LLM) |
| Write-capable | yes (mutates page scroll position; in `MUTATES_PAGE`, invalidates the read_page cache per `docs/browser-mcp-design.md:338`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/browser-mcp/index.ts:208-209`):

> "Scroll a tab. Five modes: top / bottom of the page, by an absolute pixel delta, to a specific element (by ref), or wheel-scroll a sub-region at a pointer location ('at-pointer' — the path that works for chat windows / infinite-scroll lists / modal bodies that don't respond to window.scrollTo because they have their own scroll container)."

Input-schema fields (`src/lib/browser-mcp/index.ts:210-253`), `required: ["tabId", "target"]`:

- `tabId` (number) — no description.
- `target` (string, enum `top|bottom|pixels|element|at-pointer`) — "Scroll target type."
- `pixels` (number) — "Pixel delta when target=pixels. Positive scrolls down, negative scrolls up."
- `ref` (string) — "Element ref. For target=element, scrolls so the element is centered. For target=at-pointer, resolves to the bbox center as the wheel position."
- `selector` (string) — "CSS selector. For target=at-pointer, fallback when no ref. Resolves to bbox center."
- `x` (number) — "Pointer x (CSS viewport px) for target=at-pointer. Pair with y. Exactly one of (ref, selector, or x+y) is required for at-pointer."
- `y` (number) — "Pointer y (CSS viewport px) for target=at-pointer. Pair with x."
- `deltaX` (number) — "Wheel delta x (CSS px) for target=at-pointer. Default 0. Clamped to |10000|."
- `deltaY` (number) — "Wheel delta y (CSS px) for target=at-pointer. Positive scrolls down. Default 0. Clamped to |10000|. At least one of deltaX/deltaY must be non-zero."
- `force` (boolean) — "Skip the pre-wheel elementFromPoint hit-test for target=at-pointer. Default false. Set true when an overlay covers the target but forwards wheel events."

### 2b. System prompt (`--append-system-prompt`)

`scroll` is named ONLY in POWER mode, via `powerNote` in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-633`), verbatim:

> " Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control."

`powerNote` is the empty string unless `opts.powerBrowseAvailable` is true (`:631-633`), so with `--browse` but not `--power-browse` the tool is neither served nor named — consistent. The `browse`-tier sentence at `:634-636` lists only the six lead tools and names `__act(...)` for "scroll-to"; it does NOT name `__scroll`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness** marker block — identical text to 2b (the mirrored snippet is `buildPeerAwarenessSnippet`'s output). So the mirrored CLAUDE.md names `__scroll` only under the same power-mode `powerNote`.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:147`) lists `scroll` in the flat tool inventory ("`... read_page / scroll / screenshot ...`") and, in invariant (2), states `withTabInputLock(tabId, fn)` "serialises mouse / drag / type / keyboard / scroll(at-pointer) per tab" — which matches the code (`background.js:791` wraps only the at-pointer branch in `withTabInputLock`; the top/bottom/pixels/element branch at `:809-822` runs an unlocked `chrome.scripting.executeScript` and is correctly excluded). The design doc `docs/browser-mcp-design.md:88,113,129,371` documents scroll's five modes, the mutex-serialised at-pointer path, the delta clamp, and the `browser_power` gate consistently.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** Strong. The five modes are enumerated and the at-pointer clause explains *when* (own scroll container, chat/infinite-scroll/modal) — that is the non-obvious routing signal a model needs. What is missing is a *when-NOT* / relationship to `act`: at the lead tier, `browser_act` with `action: "scroll_into_view"` (or intent "scroll to X") already reaches an element by dispatching `browser_scroll {target:"element", ref}` (`src/lib/browser-mcp/index.ts:924-925`). The description doesn't tell the model that element-centering is also available via `act`, nor that `scroll` is the tool to reach for when you need page-level (top/bottom/pixels) or sub-container (at-pointer) scrolling that `act` cannot express.
- **Accuracy vs implementation:** Accurate. `top`/`bottom`/`pixels`/`element` map to `window.scrollTo`/`scrollBy`/`scrollIntoView({block:"center"})` (`background.js:812-818`); at-pointer positions the cursor then dispatches a CDP `mouseWheel` (`:795-805`); the |10000| clamp (`:781-782`), the both-deltas-zero rejection (`:783-785`), the `force` hit-test bypass (`:786-789`), and the single-target rule (`assertSingleTarget`, `:780`) all match the schema text. No stale model id or default.
- **Schema minimality:** All ten fields are call-shaping and mode-conditional — none are echoed inputs or diagnostic-only, so the surface passes the "ruthlessly minimal" bar. Two small gaps: (1) `tabId` is the only field with no `description` (every other field has one, and the peer tools' `tabId` carries "Tab id from browser_list_tabs / browser_open_tab" — see `read_page` at `:193`); harmless but inconsistent. (2) The `required: ["tabId","target"]` plus the "exactly one of (ref, selector, x+y)" at-pointer rule is enforced only at runtime (`assertSingleTarget`), not expressible in the flat JSON schema — acceptable (JSON Schema can't cleanly encode the conditional), and the `x`-field description does state the rule, so the model has the signal.

### 3b. System-prompt coverage

- **Named or omitted:** Named, correctly scoped to power mode only (`:632`). This is by design — `scroll` is a `browser_power` tool, so naming it only when `powerBrowseAvailable` keeps the snippet from advertising a tool absent from the live `tools/list`.
- **Accurate & non-redundant:** The `powerNote` is a bare inventory ("adds the L0/L1 primitives ... for direct DOM / coordinate control") — it does not restate the description, so no redundancy. It correctly frames the power tier as "direct DOM / coordinate control," which is the right mental model for `scroll`.
- **Framing-constraint compliance:** Clean. No imperatives, no "lead with," no hedges, no anchors — it is a capability inventory sentence, consistent with the framing rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Injected block (mirrored):** Accurate and non-redundant — same power-gated `powerNote` as 2b.
- **Checked-in root CLAUDE.md:** The tool-name inventory and the `withTabInputLock` invariant at `CLAUDE.md:147` are accurate. **Drift:** the root section frames `--browse` as a flat "19 browser-control tools" surface and never mentions the `--power-browse` / `browser_power` tier split that actually gates `scroll` (and mouse/drag/type/keyboard/read_page/eval_js/diagnostics/find/list_tabs/close_tab/wait/download). A reader of the checked-in doc would conclude `scroll` ships with `--browse` alone; the code (`capability: "browser_power"`, `browserPowerToolsEnabled()`) and the design doc (`docs/browser-mcp-design.md:371`, gate `browser_power` = `--browse` AND `--power-browse`) say otherwise. The design doc is correct; the root CLAUDE.md is stale on the tiering. This is not scroll-specific but scroll is one of the mis-described tools.

### 3d. Cross-surface consistency

- description ↔ code: consistent (3a).
- system prompt ↔ code: consistent — power-gated naming matches the `browser_power` capability.
- mirrored CLAUDE.md ↔ system prompt: identical text, consistent.
- **root CLAUDE.md ↔ code/design-doc:** inconsistent on the tier gate (3c) — the only cross-surface contradiction found, and it is a checked-in-doc-vs-code drift, not a model-facing (`tools/list` / system-prompt) one.

## 4. Findings

- **[Important]** `CLAUDE.md:147` — the "Browser-control MCP (`--browse`)" section describes a flat 19-tool surface and omits the `--power-browse` / `browser_power` gate that actually restricts `scroll` (and the other L0/L1 primitives) to power mode. A reader concludes `scroll` is available with `--browse` alone; it is not. Fix: add one sentence noting the two-tier split — `--browse` exposes the 6 lead tools (`act / observe / extract / navigate / screenshot / open_tab`), and `--power-browse` (or `GH_ROUTER_ENABLE_POWER_BROWSE=1`) adds the `browser_power` primitives (`scroll`, mouse, drag, type, keyboard, read_page, eval_js, diagnostics, find, list_tabs, close_tab, wait, download) — matching `docs/browser-mcp-design.md:371` and `browserPowerToolsEnabled()`.
- **[Suggestion]** `src/lib/browser-mcp/index.ts:215` — `tabId` is the only schema field lacking a `description`, unlike sibling browser tools (e.g. `read_page` at `:193`). Add "Tab id from browser_list_tabs / browser_open_tab." for consistency.
- **[Suggestion]** `src/lib/browser-mcp/index.ts:208-209` — the description omits the relationship to `browser_act`'s `scroll_into_view` (which reaches an element via this same tool at `:924-925`). Add a one-clause when-to-prefer signal: element-centering is also available through `act` at the lead tier; reach for `scroll` for page-level (top/bottom/pixels) or sub-container (at-pointer) scrolling that `act` cannot express. Overlap is functional-only (act delegates to scroll), not a true duplicate, so this is polish, not a correctness issue.

## 5. Verdict

**Y** — the model-facing surface (`tools/list` description + power-gated system-prompt naming) is correct, minimal, consistent, and well-routed; the at-pointer mutex participation is accurately documented. Single most important fix: update the checked-in root `CLAUDE.md:147` to document the `--power-browse` / `browser_power` tier split so `scroll` is not mis-described as a plain `--browse` tool.
