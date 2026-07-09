# Review: `mcp__browser__read_page`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__read_page` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_read_page` |
| Definition | `src/lib/browser-mcp/index.ts:185` |
| Always-on? | gated by capability `browser_power` |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`, `:1007-1008`) |
| Backing model / endpoint | server-side fn (dispatches to the MV3 extension via `dispatchBrowserTool`; no LLM) |
| Write-capable | no (read-only page snapshot) |

Gate detail: `browserToolsEnabled()` requires the `--browse` opt-in AND a Chromium-family browser on disk (`src/lib/mcp-capabilities.ts:148` region / `browserToolsEnabled` docstring at `:153`). `browserPowerToolsEnabled()` returns `state.powerBrowseEnabled === true`, set only by `--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1` (`src/lib/mcp-capabilities.ts:148-150`). So `read_page` is invisible in default `--browse` — it appears only when the operator additionally enables power mode. Enforced symmetrically at list-time (`handler.ts:351`) and call-time (`handler.ts:1005-1008`, wrong-scope/gated → -32601 `unknown tool`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:186-187`):

> "Compressed page snapshot for the model: visible text, interactive elements with stable refs, viewport metadata, and (when present) `visualSurfaces` listing canvas / svg regions that need vision. Each element entry carries `bbox: [x, y, w, h]` in CSS viewport pixels (same coord space as browser_mouse / drag / scroll-at-pointer). Refs (e.g. `e42`) are stable for the lifetime of one read_page snapshot and are the preferred input to follow-up actions over brittle CSS selectors. The `viewport` block (`width`, `height`, `devicePixelRatio`, `scrollX`, `scrollY`) lets you map CSS-px bbox to device-px pixels for browser_screenshot. Mode controls what ships back: `summary` (default, ~5-15 KB) returns only viewport-visible elements/text and drops nameless non-interactive nodes; `full` returns up to 200 elements + 256 KiB of innerText (the legacy behavior — use only when you need off-screen content unscrolled). PREFER browser_act / browser_find for intent-driven interaction; read_page is the lower-level snapshot when you need to enumerate."

Input-schema fields (`src/lib/browser-mcp/index.ts:188-200`):

- `tabId` (number, **required**): "Tab id from browser_list_tabs / browser_open_tab."
- `mode` (string enum `["summary","full"]`, optional): "Snapshot scope. Default 'summary' returns viewport-visible elements + text capped at 20 KiB. 'full' returns up to 200 interactive elements page-wide + 256 KiB of innerText."

`additionalProperties: false`.

### 2b. System prompt (`--append-system-prompt`)

`read_page` is named ONLY in the power-mode conditional (`powerNote`), never in the default lead surface. Verbatim (`src/lib/peer-mcp-personas.ts:631-633`):

> ` Power mode adds the L0/L1 primitives (\`mcp__${browserKey}__mouse\`, \`__drag\`, \`__type\`, \`__keyboard\`, \`__scroll\`, \`__eval_js\`, \`__read_page\`, \`__diagnostics\`, \`__find\`) for direct DOM / coordinate control.`

`powerNote` is appended only when `opts.powerBrowseAvailable` (`peer-mcp-personas.ts:631`), so a default `--browse` session never sees `read_page` named in the system prompt. The default browser clause that always ships when browse is on (`peer-mcp-personas.ts:634-636`) names only the six lead tools (`act` / `observe` / `extract` / `navigate` / `open_tab` / `screenshot`) and closes with: "The lead never sees raw DOM: refs and bboxes stay internal."

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness snippet (§2b, same `buildPeerAwarenessSnippet` text) is the injected block that covers this tool — same `powerNote`-gated single mention.

Checked-in root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-149`) documents the tool at the suite level: lists `read_page` in the MCP-facing rename list (`:147`) and states "Element refs returned by `read_page` are the primary input to subsequent act / mouse / drag calls — preferred over CSS selectors because refs survive dynamic class names" (`:147`). The root doc claims "19 browser-control tools" and calls the whole suite the `--browse` surface; it does NOT mention that `read_page` is separately power-gated behind `--power-browse`. `docs/browser-mcp-design.md` is referenced for full architecture but the power-tier split is not surfaced in the root section.

## 3. Assessment

### 3a. Description quality

- Clarity & routing signal: strong. It states what ships back (text, refs, bbox, viewport, visualSurfaces), the coordinate contract (CSS viewport px, shared with mouse/drag/scroll), the ref-stability lifetime, and — critically — a clear when-NOT signal: "PREFER browser_act / browser_find for intent-driven interaction; read_page is the lower-level snapshot when you need to enumerate." Because `read_page` is power-gated, its natural competitors (`act`/`find`) are compound tools; the description correctly points the model away from `read_page` toward them for the common case.
- Accuracy vs implementation: mostly accurate, one stale numeric set. The structural claims all verify against `snapshot-types.ts` (ref, `bbox: [x,y,w,h]`, the five viewport fields, `visualSurfaces` canvas/svg) and the CDP extractor's `mode` semantics (`snapshot-cdp.js:305,308,317` — summary drops zero-bbox, out-of-viewport, and nameless leaf-interactive nodes). But the CAP numbers describe the LEGACY DOM-walker path, not the DEFAULT CDP path:
  - Default extractor is CDP (`background.js:205-217` tries `extractSnapshotCDP` first, falls back to legacy only on attach failure).
  - CDP caps (`snapshot-cdp.js:23-25`): `ELEMENT_CAP = 500` total (`PER_FRAME_CAP = 200`), single `TEXT_CAP = 32 KiB` that is NOT mode-split.
  - Legacy caps (`background.js:348,500,528`): `ELEMENT_CAP = 200`, summary `TEXT_CAP = 20 KiB`, full `MAX_FULL = 256 KiB`.
  - So the schema's "capped at 20 KiB" (summary) and "256 KiB of innerText" / "up to 200 elements page-wide" (full) hold only on the fallback path. On the default CDP path the element ceiling is 500 and the text cap is 32 KiB in both modes. The prose "~5-15 KB" summary figure is a soft estimate and defensible either way.
- Schema minimality: clean. Both fields pass the "ruthlessly minimal" bar — `tabId` is required to route, `mode` is model-tunable and materially changes the payload. No echoed-input or diagnostic-only fields. Note: `toolReadPage` also reads `args.refresh` (`background.js:197`), but `refresh` is absent from the schema and `additionalProperties: false` blocks it, so it can never reach the handler through MCP — a deliberate, coherent omission, not surface bloat.

### 3b. System-prompt coverage

- Named, but only in power mode — by design. The `powerNote` gate (`peer-mcp-personas.ts:631`) matches the tool's own `browser_power` capability gate, so the snippet never names `read_page` when the live `tools/list` wouldn't serve it. This is the correct symmetric-gating discipline.
- Accurate & non-redundant: the one-line power mention ("direct DOM / coordinate control") does not duplicate the description's detail; it just signals the tier exists.
- Framing-constraint compliance: compliant. `powerNote` is a flat capability statement ("Power mode adds the L0/L1 primitives … for direct DOM / coordinate control") — no imperative ("Lead with"), no hedge, no anchor. It states availability, not a usage directive.

### 3c. CLAUDE.md coverage

- Accurate and not drifted at the suite level: the ref-primacy claim in the root doc (`CLAUDE.md:147`) matches the code (`background.js:234-236,330-331` stable `data-gh-router-ref`) and the description.
- Gap: the root "Browser-control MCP" section frames all 19 tools as the flat `--browse` surface and never notes the power-tier split (that `read_page` + the L0/L1 primitives require `--power-browse`, while default `--browse` exposes only the six lead tools). A reader of the root doc alone would expect `read_page` to be present under `--browse`, which is false. The awareness snippet handles this correctly (power-gated mention); the root doc lags.

### 3d. Cross-surface consistency

- Coherent on the "lead never sees raw DOM" claim: in default `--browse` the awareness snippet asserts "refs and bboxes stay internal" (`peer-mcp-personas.ts:635`), and that holds precisely because `read_page` (the raw-DOM/ref enumerator) is power-gated OUT of the default surface. When `--power-browse` flips on, `powerNote` appears AND `read_page` is served — the raw-DOM tools and the "raw DOM is now exposed" signal light up together. The two surfaces move in lockstep; no contradiction.
- One cross-surface numeric drift: description/schema cap numbers (20 KiB / 256 KiB / 200 elements) describe the legacy fallback, while the default CDP path uses 500 elements / 32 KiB. Not a correctness hazard — both are honest ceilings and `truncated.{elements,text}` flags fire — but the stated numbers can mislead a model reasoning about payload size on the default path.

## 4. Findings

- **[Important]** `src/lib/browser-mcp/index.ts:186-187,197` — the description and `mode` schema cite the LEGACY extractor's caps (summary "20 KiB", full "up to 200 elements + 256 KiB"), but the DEFAULT path is CDP with `ELEMENT_CAP = 500` and a single mode-independent `TEXT_CAP = 32 KiB` (`snapshot-cdp.js:23-25`). A model sizing its reads against "200 elements / 20 KiB" underestimates the default payload. Fix: restate the caps to reflect the CDP path (element ceiling ~500, text ~32 KiB), or phrase them as "up to N" ranges that bound both extractors, and drop the implication that summary vs full changes the text cap on the default path (it doesn't — CDP applies one `TEXT_CAP` to both).
- **[Suggestion]** `CLAUDE.md:145-149` — the root "Browser-control MCP" section presents all 19 tools as the flat `--browse` surface and omits the `--power-browse` tier split, so `read_page` reads as available under plain `--browse` when it is not. Fix: add one sentence noting that `read_page` + the L0/L1 primitives are power-gated (`--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`) while default `--browse` exposes only the six lead tools, mirroring the awareness snippet.
- **[Suggestion]** `src/lib/browser-mcp/index.ts:187` — description says refs are "stable for the lifetime of one read_page snapshot," but the extension actually persists `data-gh-router-ref` across snapshots of the same document so `read_page → act(ref) → read_page` keeps the binding (`background.js:327-331`). The current wording understates ref durability and could push the model to re-read more often than needed. Fix: say refs persist across snapshots of the same document (until navigation/DOM replacement), not just for one snapshot.

## 5. Verdict

Y (with one important fix). The injected surface is correctly power-gated, symmetric across list-time/call-time, minimal in schema, framing-compliant in the system prompt, and coherent with the "lead never sees raw DOM" claim (raw-DOM tool and its awareness mention appear together only under `--power-browse`). Single most important fix: correct the cap numbers in the description/schema to match the DEFAULT CDP extractor (~500 elements, 32 KiB text, mode-independent), since the current numbers describe only the legacy fallback path.
