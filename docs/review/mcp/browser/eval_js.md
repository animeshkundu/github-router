# Review: `mcp__browser__eval_js`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Cite `file:line`. Verified against code.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__eval_js` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_eval_js` |
| Definition | `src/lib/browser-mcp/index.ts:310` (entry), handler dispatches to `dispatchBrowserTool("browser_eval_js", …)` at `:331` |
| Always-on? | gated by `--browse` opt-in AND `--power-browse` (both default OFF) |
| Capability gate | `capability: "browser_power"` (`src/lib/browser-mcp/index.ts:329`) → `browserToolsEnabled()` AND `browserPowerToolsEnabled()` |
| Backing model / endpoint | server-side fn — MV3 extension `toolEvalJs()` (`src/browser-ext/background.js:1594`) via CDP `Runtime.evaluate`, no model call |
| Write-capable | yes — arbitrary JS in the page's main world; can mutate the DOM, storage, cookies, issue fetches, and set `window.location` |

Notes on the gate. `browser_eval_js` carries `capability: "browser_power"` (`:329`), so it is NOT one of the six lead-model tools present under a plain `--browse`. It appears only when `state.powerBrowseEnabled` is set (`--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`; `browserPowerToolsEnabled()` at `src/lib/mcp-capabilities.ts:148`), ANDed with `browserToolsEnabled()` (`:167`, the opt-in plus `hasSupportedBrowserInstalled()`). Both are fired symmetrically at list-time and call-time. This is the correct tier: eval_js is the highest-capability tool in the suite and is hidden from the default lead surface.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:311-312`):

> "Evaluate a JavaScript expression in the tab's main world (equivalent to typing in the DevTools console). Returns {result} or {error}. Awaits promises returned by the expression. Single narrowly-named escape hatch for behaviors the other tools don't cover."

Input schema (`:313-327`): `required: ["tabId", "expression"]`, `additionalProperties: false`.

- `tabId` (`:318`): `{ type: "number" }` — no description.
- `expression` (`:319-322`): `"JS expression. Max 100 KB. Top-level await NOT supported - wrap in (async () => ...)()."`
- `timeoutMs` (`:323-326`): `"Max evaluation time. Default 5000, hard cap 30000."`

### 2b. System prompt (`--append-system-prompt`)

`eval_js` is named ONLY in the power-mode addendum of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-632`), emitted iff `opts.powerBrowseAvailable`:

> " Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control."

The base browse clause (`:634-635`) describes only the six lead tools (`act` / `observe` / `extract` / `navigate` / `open_tab` / `screenshot`) and never names `eval_js`. So under a plain `--browse` the snippet is silent on eval_js, matching the fact that the tool isn't listed then. The mention is a bare inventory item inside a parenthetical — no scope guidance, no when-to-use, no risk framing. That is framing-constraint compliant (no imperatives / anchors), but see 3b.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b — the power-mode parenthetical is the only place eval_js is named for the model.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:147-149`) lists `eval_js` in the 19-tool inventory (`:147`) and documents the navigation block (`:149`):

> "Navigation block is dual-layered: the bridge-side `preflightUrlPolicy()` in `src/lib/browser-mcp/policy.ts` checks `browser_open_tab` / `browser_navigate` URL args before forwarding, AND the extension's `webNavigation.onBeforeNavigate` listener cancels in-page-initiated nav (JS redirects, meta-refresh) to about:blank. `chrome://settings`, `chrome://extensions`, `chrome://flags`, password / management / policy pages, and `chrome-extension://*/options.html` blocked; `devtools://*` explicitly allowed."

`docs/browser-mcp-design.md:92` documents the tool ("Evaluate a JS expression in the page's main world (CDP `Runtime.evaluate`)") and `:371` places it under the `browser_power` tier. Both agree with the code on where the tool lives. The `:149` claim about which URLs are "blocked" is imprecise once eval_js is in play — see Finding 1.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Good. "equivalent to typing in the DevTools console" is an accurate, instantly-legible mental model, and "single narrowly-named escape hatch for behaviors the other tools don't cover" correctly steers the model to prefer the structured tools and reach for eval_js last. The return shape (`{result}` or `{error}`) and promise-awaiting behavior are stated. The top-level-await caveat and the `(async () => ...)()` workaround are exactly the two things a model gets wrong first.
- **Accuracy vs implementation.** Verified against `toolEvalJs` (`background.js:1594-1620`): main world ✓ (`Runtime.evaluate`, `:1608`), awaits promises ✓ (`awaitPromise: true`, `:1611`), `{result}`/`{error}` shape ✓ (`:1616`, `:1619`), returnByValue strip ✓ (`:1618-1619`). The `timeoutMs` default 5000 / cap 30000 matches both the handler (`Math.min(..., 30000)`, default 5000, `:1597`) and the dispatch table (`browser_eval_js: { defaultMs: 5_000, maxMs: 30_000 }`, `dispatch.ts:168`). The "Max 100 KB" claim on `expression` is NOT enforced anywhere I can find in `toolEvalJs` or the schema — see Finding 3.
- **Schema minimality.** All three fields pass the bar: `tabId` (required target — no stateful cursor by invariant), `expression` (required payload), `timeoutMs` (model-tunable safety knob, actionable). No echoed-input or diagnostic-only fields. `tabId` lacks a `description` but its meaning is unambiguous and consistent with siblings.

### 3b. System-prompt coverage

- **Named, in power mode only.** Correct by design — the tool isn't in `tools/list` without `--power-browse`, so naming it in the base clause would advertise a tool the model can't call.
- **Accurate & non-redundant.** The parenthetical is a plain inventory ("direct DOM / coordinate control"), not a duplicate of the description; fine.
- **Framing-constraint compliance.** Compliant (no imperatives, no hedges, no anchors) — but the flip side is that the single highest-capability, highest-blast-radius tool in the suite gets exactly one word of snippet real estate (`__eval_js`) with no signal that it is the last-resort escape hatch. The steering ("prefer structured tools, eval_js only when nothing else fits") lives solely in the `tools/list` description. That is arguably acceptable given the framing constraint bans prescriptive snippet text, and the description does carry the "escape hatch" framing. Noted, not a defect.

### 3c. CLAUDE.md coverage

- The injected block (2b/2c) is consistent with the code and with the description.
- The checked-in root `CLAUDE.md:149` navigation-block paragraph is the one drift point: it lists `chrome://extensions` among the "blocked" pages without qualifying that the block is tool-nav-only for that URL. eval_js (and any in-page JS) can still drive a tab there, because the extension-side listener deliberately omits `extensions` (`background.js:44-53`). The doc's own dual-layer description is otherwise correct; the imprecision is the flat word "blocked" applied uniformly across URLs that actually have two different enforcement scopes.

### 3d. Cross-surface consistency

Description ↔ system prompt ↔ code agree on capability, tier, return shape, and defaults. The only cross-surface friction is between the root `CLAUDE.md:149` "blocked" list and the actual per-URL enforcement scope, which eval_js exposes because it is the one power tool that can navigate without touching `preflightUrlPolicy`.

## 4. Findings

- **[Important]** `eval_js` bypasses the bridge-side URL policy entirely; the only backstop is the extension-side `onBeforeNavigate` regex, which omits `chrome://extensions`. Repro: with `--power-browse`, call `eval_js({tabId, expression: "window.location='chrome://extensions'"})`. The dispatch layer never URL-checks it — `preflightUrlPolicy` returns `{blocked:false}` for any tool other than `browser_open_tab`/`browser_navigate` (`policy.ts:82-85`, `dispatch.ts:390`, `:359`). The navigation then fires `webNavigation.onBeforeNavigate`, but the extension-side `BLOCKED_URL_RE` (`background.js:52-53`) deliberately excludes `extensions`, so the tab lands on `chrome://extensions`. This is not a full policy defeat: URLs that ARE in the extension-side regex (`settings` / `preferences` / `policy` / `management` / `password` / `flags`) get rerouted to `about:blank` by the listener (`:2161-2163`) even when eval_js initiates them, so eval_js can NOT reach `chrome://settings`. The residual gap is narrow (extensions page only; opening it grants no privilege, per `policy.ts:16-18`), which is why this is Important not Critical. Fix: none required in code if the residual is accepted — but the root `CLAUDE.md:149` claim that `chrome://extensions` is "blocked" should be corrected to "blocked for tool-initiated nav; reachable via in-page JS / eval_js by design (opening the page grants no privilege)", so a future contributor doesn't treat eval_js reaching it as a regression.

- **[Important]** Description advertises "Max 100 KB" on `expression` but no size cap is enforced. `toolEvalJs` (`background.js:1594-1614`) forwards `expression` straight to `Runtime.evaluate` with no length check, and the JSON schema (`index.ts:319-322`) has no `maxLength`. A model that trusts the stated limit and sends 100 KB will succeed; a stated-but-unenforced limit is a description-vs-code drift. Fix: either add a `maxLength: 102400` to the `expression` schema (or a length guard in `toolEvalJs` returning a structured error), or drop the "Max 100 KB" claim from the description so it stops asserting a constraint the code doesn't apply.

- **[Suggestion]** `tabId` has no `description` in the schema (`index.ts:318`), unlike most sibling tools that annotate it. Harmless given the name, but a one-liner ("Target tab id from list_tabs / open_tab.") would match the suite's convention and remove the only un-annotated field.

## 5. Verdict

Y (with two Important fixes). The injected surface is correctly tiered behind `browser_power`, minimal, and well-routed, with an accurate DevTools-console mental model and the right last-resort framing. Single most important fix: reconcile the navigation-block story — either accept the `chrome://extensions`-via-eval_js residual and correct the "blocked" wording in root `CLAUDE.md:149`, and separately make the "Max 100 KB" claim true (enforce it) or drop it.
