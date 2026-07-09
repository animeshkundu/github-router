# Review: `mcp__browser__open_tab`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__open_tab` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_open_tab` |
| Definition | `src/lib/browser-mcp/index.ts:89-114` |
| Always-on? | gated by `--browse` opt-in + a Chromium browser on disk |
| Capability gate | `browser` → `browserToolsEnabled()` (`src/lib/mcp-capabilities.ts:167-172`): `(state.browseEnabled OR GH_ROUTER_ENABLE_BROWSE=1) AND hasSupportedBrowserInstalled()` |
| Backing model / endpoint | server-side fn (WS dispatch to local bridge → MV3 extension `toolOpenTab`); no model |
| Write-capable | yes (opens/navigates a real tab — side-effectful) |

Note on tier: `open_tab` carries `capability: "browser"` (`index.ts:110`), one of the 6 LEAD-tier tools exposed by the default `--browse` surface (`act`, `observe`, `extract`, `navigate`, `screenshot`, `open_tab`). The other 13 `browser_*` tools carry `capability: "browser_power"` and appear only under `--power-browse` (`browserPowerToolsEnabled()`, `mcp-capabilities.ts:148-150`). So `open_tab` is available whenever `--browse` is on; it does NOT require power mode.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:91-92`):

> Open a URL in a new browser tab and wait for the page to finish loading. Returns the new tab's id, final URL after redirects, and HTTP status. Refuses to navigate to browser-internal settings / preferences / extensions / flags pages (returns {blocked: true, reason}); devtools://* is allowed.

Input schema (`index.ts:93-109`) — `required: ["url"]`, `additionalProperties: false`:

- `url` (string, required): "The URL to load. Maximum 8 KB. Settings / preferences / extensions / flags pages are blocked."
- `reuseActive` (boolean, optional): "When true, navigate the currently active tab instead of opening a new one. Default false."

### 2b. System prompt (`--append-system-prompt`)

`open_tab` IS named in the lead-surface clause of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:634-635`), gated on `opts.browseAvailable`. Verbatim:

> `mcp__${browserKey}__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

`__open_tab` is grouped with `__navigate` / `__screenshot` as "for state and visuals." `browserKey` resolves to `browser` unless a user-side `mcpServers` collision forces a numbered fallback (`resolveGroupKeysFromMirror`). No per-tool imperative, no URL-block or 8 KB detail here (correctly deferred to the description).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Two covering surfaces:

1. **Mirrored peer-awareness block** — identical text to 2b. `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653-663`) writes the same `buildPeerAwarenessSnippet` output into the mirror's CLAUDE.md between the peer-awareness fence, so descendant agents (Agent subagents, agent-teams teammates) see the same `__open_tab` clause. No drift by construction (one source string).

2. **Checked-in root CLAUDE.md** — "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-149`). Relevant text (line 147): "adds 19 browser-control tools under the `browser` MCP server … MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / …`". The navigation block is documented at line 149: "the bridge-side `preflightUrlPolicy()` in `src/lib/browser-mcp/policy.ts` checks `browser_open_tab` / `browser_navigate` URL args before forwarding … `chrome://settings`, `chrome://extensions`, `chrome://flags`, password / management / policy pages, and `chrome-extension://*/options.html` blocked; `devtools://*` explicitly allowed." Matches `policy.ts:20-27` and `dispatch.ts:355-362`.

Design doc `docs/browser-mcp-design.md` has the tool table (`open_tab` → `browser_open_tab` → "Open a new tab at a URL and wait for load", line 84), the full block list (line 227), and the correct default-tier note (lines 369-373: "Lead-model-facing surface (default `--browse`): 6 tools (act, observe, extract, navigate, screenshot, open_tab)").

## 3. Assessment

### 3a. Description quality

- **Routing signal**: Good. "Open a URL in a new browser tab and wait for the page to finish loading" is unambiguous; the `reuseActive` field gives the navigate-active-tab alternative. The when-NOT signal (blocked page classes) is stated inline with the exact `{blocked: true, reason}` return shape, and `devtools://*` is called out as allowed — actionable. No when-not for choosing `navigate` over `open_tab`, but the two descriptions are self-distinguishing (open-new vs act-on-existing).
- **Accuracy vs implementation**: two gaps.
  - "Returns the new tab's id, final URL after redirects, and **HTTP status**." The extension returns `statusCode: t.status === "complete" ? 200 : 0` (`src/browser-ext/background.js:117-121`). That is a synthetic value derived from `chrome.tabs.get().status` (the tab's load state, "complete"/"loading"), NOT the page's HTTP response code — Chrome's `tabs` API does not expose HTTP status. The model will read "HTTP status" and may treat a `0` as a network/HTTP failure or a `200` as an HTTP success when the page actually 404'd. Misleading label.
  - "final URL **after redirects**": the returned `finalUrl` is `t.url` after `waitForTabComplete` (`background.js:116-119`), which does reflect the post-redirect URL for server redirects, so this part is accurate.
  - "Maximum 8 KB" (url field): no code enforces an 8 KB (or any) URL length cap. `policy.ts:37` and `background.js:85` only reject the empty string; there is no `maxLength` in the schema, no length check in `checkUrlPolicy`, and no `maxPayload` in the bridge WS (`src/browser-bridge/index.ts`). The claim is documentary only — a URL over 8 KB would be forwarded, not rejected. Low practical impact (URLs are rarely that long) but it is a stated constraint the code does not honor.
- **Schema minimality**: clean. Both fields pass the "ruthlessly minimal" bar — `url` is required to call; `reuseActive` is model-tunable and materially changes behavior (reuse active vs create new). No echoed-input or diagnostic-only fields. `additionalProperties: false` is set.

### 3b. System-prompt coverage

- **Named**: yes, as `__open_tab` in the lead-surface list — appropriate (it is a lead-tier tool). By design.
- **Accurate & non-redundant**: yes. The snippet frames it at group level ("for state and visuals") and defers the URL-block / return-shape detail to the description, which is the right division of labor — the snippet is a routing map, not a spec.
- **Framing-constraint compliance**: compliant. No imperative ("Lead with X"), no hedge, no anchor. The clause is a neutral capability inventory. Consistent with the framing rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Mirrored peer block**: accurate — byte-identical to 2b (same builder output), no independent drift risk.
- **Root CLAUDE.md**: the `open_tab`-specific claims (navigation block, blocked page classes, `devtools` allowed, MCP-facing rename) all match the code. One group-level (not `open_tab`-specific) inaccuracy: line 147 says `--browse` "adds 19 browser-control tools" and lists all 19 by name as though all are exposed by the opt-in. In fact only the 6 lead-tier tools ship under bare `--browse`; the remaining 13 need `--power-browse` (`browserPowerToolsEnabled()`). `open_tab` is one of the 6, so it is correctly available, but the surrounding "19 tools under `--browse`" framing overstates the default surface. The design doc (lines 369-373) states the 6-vs-power split correctly, so root CLAUDE.md is the stale one. Flagging as context; it is a group-doc issue, not an `open_tab` surface defect.

### 3d. Cross-surface consistency

- description ↔ system prompt ↔ mirrored CLAUDE.md: consistent (snippet defers detail to description; no contradiction).
- description ↔ code: the "HTTP status" and "8 KB" claims are the only description↔code mismatches (see 3a). Everything else (blocked pages, `{blocked,reason}` shape, `reuseActive` default false, wait-for-load) matches `background.js:83-122`, `policy.ts:20-62`, and `dispatch.ts:390-397`.
- root CLAUDE.md ↔ code: the group-level "19 tools under --browse" overstates the default tier (see 3c), but this is not `open_tab`-specific.

## 4. Findings

- **[Important]** `src/lib/browser-mcp/index.ts:92` — description says the tool "Returns … HTTP status," but the returned `statusCode` is `t.status === "complete" ? 200 : 0` (`src/browser-ext/background.js:120`), a synthetic value from the tab's load state, not an HTTP response code. A page that 404s or 500s but finishes loading returns `200`; a still-loading/timed-out tab returns `0`. The model can misread this as HTTP success/failure. Fix: change the description to "and a load-complete flag (`statusCode` 200 when the tab finished loading, 0 otherwise — NOT the page's HTTP response code)", or rename the returned field to `loaded`/`status` and drop the "HTTP" wording.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:101` — url field description states "Maximum 8 KB," but no code enforces any URL length cap (`policy.ts:37` and `background.js:85` check only for empty string; no schema `maxLength`, no bridge `maxPayload`). Either add a real `maxLength: 8192` to the schema (and a `checkUrlPolicy` length guard) so the stated constraint is honored, or drop the "Maximum 8 KB" clause. Same unenforced claim appears on `navigate` (`index.ts:150`) and `download` (`index.ts:349`).

- **[Suggestion]** `CLAUDE.md:147` (root, group-level, not `open_tab`-specific) — "adds 19 browser-control tools under the `browser` MCP server" and the full 19-name list overstate the default `--browse` surface, which exposes only the 6 lead-tier tools; the other 13 require `--power-browse`. Align the root doc's framing with `docs/browser-mcp-design.md:369-373`. Does not affect `open_tab`'s own availability.

## 5. Verdict

**Y (with one Important fix).** `open_tab`'s injected surface is minimal, correctly gated, well-routed, and framing-compliant across all three surfaces. The single fix that matters: the description's "Returns … HTTP status" mislabels a synthetic load-complete flag as an HTTP status code (`index.ts:92` vs `background.js:120`) — correct the wording so the model does not treat `200`/`0` as an HTTP result.
