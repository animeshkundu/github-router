# Review: `mcp__browser__navigate`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Cite `file:line`. Verified against code.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__navigate` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_navigate` |
| Definition | `src/lib/browser-mcp/index.ts:135` (entry), handler dispatches to `dispatchBrowserTool("browser_navigate", …)` at `:159` |
| Always-on? | gated by `--browse` opt-in (default OFF) |
| Capability gate | `capability: "browser"` (`src/lib/browser-mcp/index.ts:157`) → `browserToolsEnabled()` (`src/lib/mcp-capabilities.ts:167`) |
| Backing model / endpoint | server-side fn — MV3 extension `toolNavigate()` (`src/browser-ext/background.js:133`), no model call |
| Write-capable | yes (mutates browser tab state: navigates, reloads, history) |

Notes on the gate. `browser_navigate` carries the base `capability: "browser"` tag (`:157`), NOT `browser_power`. So it is one of the six lead-model tools always present whenever `--browse` is on (`act`, `observe`, `extract`, `navigate`, `screenshot`, `open_tab`), and is NOT dropped when power mode is off (`browserPowerToolsEnabled()`, `src/lib/mcp-capabilities.ts:148`). `browserToolsEnabled()` requires BOTH the opt-in AND `hasSupportedBrowserInstalled()` (`:167-172`), fired symmetrically at list-time and call-time.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:137-138`):

> "Navigate an existing tab: goto a URL, go back, go forward, or reload. Same URL-blocking policy as browser_open_tab."

Input schema (`:139-156`): `required: ["tabId", "action"]`, `additionalProperties: false`.

- `tabId` (number) — "Tab id from browser_list_tabs / browser_open_tab."
- `action` (string, enum `["goto","back","forward","reload"]`) — "The navigation action."
- `url` (string) — "Required when action=goto. Max 8 KB."
- `hard` (boolean) — "Reload only: bypass cache (Ctrl+Shift+R behavior). Default false."

### 2b. System prompt (`--append-system-prompt`)

`navigate` IS named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:634-636`), inside the `opts.browseAvailable` block. Exact clause:

> "`mcp__${browserKey}__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal."

`navigate` is named as a member of the lead surface, grouped with `open_tab` / `screenshot` as "for state and visuals." It is named, not described — no action list, no schema, no URL-policy note. That is the intended altitude for the awareness snippet (routing signal, not spec). The clause is only emitted when `browseAvailable` is true, matching the `--browse` gate.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The injected marker block covering this tool is peer-awareness — the SAME text as 2b (the snippet from `buildPeerAwarenessSnippet` is mirrored into the config-dir CLAUDE.md). No separate directive covers `navigate`.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-149`) documents the tool set and the dual-layer navigation block:

- `:147` lists the MCP-facing names ("prefix dropped"): `… navigate …`, and states the rename is MCP-facing only (wire name stays `browser_navigate`). Matches `src/lib/browser-mcp/index.ts:66-70`.
- `:149` documents the dual-layer block: bridge-side `preflightUrlPolicy()` (`src/lib/browser-mcp/policy.ts`) checks `browser_open_tab` / `browser_navigate` URL args before forwarding, AND the extension `webNavigation.onBeforeNavigate` listener cancels in-page-initiated nav to about:blank. Both claims verified against code (`policy.ts:78-86` gates exactly those two tool names; `background.js:2159-2168` routes blocked top-level nav to `about:blank`).

`docs/browser-mcp-design.md` agrees and adds the `file://` detail: `:227` — "`file://` is blocked by default; set `GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1` to enable" (verified at `policy.ts:54-60`), and `:231-232` describe the two-layer block precisely.

## 3. Assessment

### 3a. Description quality

- Clarity & routing signal: strong for its length. "Navigate an existing tab" cleanly separates it from `open_tab` (new tab), and the four actions are enumerated in the enum with a one-line each. The `hard` field correctly scopes itself to reload. `tabId` sourcing ("from browser_list_tabs / browser_open_tab") is actionable.
- Accuracy vs implementation: the action set (`goto/back/forward/reload`) exactly matches `toolNavigate()` (`background.js:138-156`); `hard` → `bypassCache` (`:153`); `url` required for goto is enforced both in the extension (`:139`) and implied by the schema note. No stale model id or default.
- **Gap — the URL-blocking policy is under-specified for a model that must act on a `blocked` result.** "Same URL-blocking policy as browser_open_tab" delegates to `open_tab`'s description (`:92`, `:101`), which lists "settings / preferences / extensions / flags pages" — but the actual bridge policy ALSO blocks `file://` by default (`policy.ts:54-60`) and extension `options`/`popup.html` pages (`policy.ts:47-52`). Neither `navigate`'s nor `open_tab`'s description mentions `file://`. A model told to `navigate(action:"goto", url:"file:///…")` gets `{blocked:true, reason:…}` with no forewarning, and the reason string ("file:// URLs are blocked by default. Set GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1") is actionable only at runtime. This is the one accuracy gap worth fixing.
- Schema minimality (per the ruthlessly-minimal principle): all four fields pass.
  - `tabId` — required, no default target (invariant: every action takes an explicit target).
  - `action` — required, enum-constrained, drives the branch.
  - `url` — conditionally required (goto only). The schema can't express "required iff action=goto" in plain JSON Schema, so the description carries it and the extension enforces it (`background.js:139`). Correct handling; not a violation.
  - `hard` — reload-only, model-tunable, clearly scoped. No echoed-input or diagnostic-only fields.

### 3b. System-prompt coverage

- Named, not omitted. Correct: `navigate` is a base-`browser` (always-on-when-browse) lead tool, so naming it in the lead-surface sentence is warranted and matches the gate — the clause is emitted iff `browseAvailable`.
- Accurate & non-redundant: the snippet groups `navigate` with `open_tab`/`screenshot` "for state and visuals" and defers all detail to the description. No duplication of the action list or policy.
- Framing-constraint compliance: no imperatives, no hedges, no anchors disguised as description. "The lead never sees raw DOM: refs and bboxes stay internal" is a capability statement, not a directive to the model. Compliant.

### 3c. CLAUDE.md coverage

- Accurate and not drifted: root `CLAUDE.md:147` name list and `:149` dual-layer description both match code. The MCP-facing/wire split is stated correctly and matches `index.ts:66-70`.
- Injected peer-awareness block (= 2b) is consistent with the description — it names the tool and points at the description for detail.
- One consistency nit across docs, not code: root `CLAUDE.md:145` and `docs/browser-mcp-design.md` describe the surface as "19 browser-control tools" and the awareness snippet's "Lead surface" framing implies the six base tools, but neither the description nor the awareness snippet mentions the `file://` default-block — that fact lives only in `browser-mcp-design.md:227`. Same gap as 3a, surfaced from the doc side.

### 3d. Cross-surface consistency

No contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ code. The action set, the wire/MCP name split, the `--browse` gate, and the dual-layer URL block are stated consistently everywhere they appear. The only divergence is an omission, not a contradiction: the `file://` (and extension-options-page) block is real in code and documented in the design doc, but absent from both model-facing surfaces (description + snippet).

## 4. Findings

- **[Important]** `src/lib/browser-mcp/index.ts:137-138` (and transitively `:92`,`:101`): the description's "Same URL-blocking policy as browser_open_tab" points the model at an `open_tab` description that omits two real block cases — `file://` (default-on, `policy.ts:54-60`) and extension `options`/`popup.html` (`policy.ts:47-52`). A model attempting `goto file://…` or an extension options page is blocked at runtime with no forewarning. Fix: add one clause to `browser_open_tab`'s description (which `navigate` inherits), e.g. "Also blocks `file://` by default (set `GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1`) and extension options/popup pages." Keeps `navigate`'s "same policy as" delegation honest without lengthening `navigate` itself.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:137-138`: the description doesn't state the return shape. `open_tab` documents its return ("Returns the new tab's id, final URL after redirects, and HTTP status"); `navigate` returns `{finalUrl, statusCode}` (`background.js:159`) or `{blocked, reason}` on policy hit, and neither is named. A short "Returns {finalUrl, statusCode}; {blocked, reason} on a blocked URL." would let the model parse the result without a probe. Non-blocking.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:150`: `url` description "Required when action=goto. Max 8 KB." — the "Max 8 KB" is asserted but not enforced anywhere in the `navigate` path (the 8 KB cap is a documented convention on `open_tab`/`download` URLs; `toolNavigate` does not length-check). Either enforce it or drop the claim so the description doesn't over-promise a limit the code doesn't apply. Non-blocking.

## 5. Verdict

**Y (with one Important fix).** The injected surface is correct, minimal, consistent, and well-routed: the action enum, the wire/MCP name split, the `--browse`/`browser`-capability gate, and the dual-layer URL block all match code, and the awareness snippet names `navigate` at the right altitude without anchoring. Single most important fix: extend `browser_open_tab`'s description (which `navigate` inherits via "same policy") to name the `file://` default-block and extension-options-page block, so the model isn't surprised by a runtime `{blocked}` the description never hinted at.
