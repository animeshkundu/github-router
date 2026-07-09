# Review: `mcp__browser__type`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Cite `file:line`. Verified against code.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__type` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_type` |
| Definition | `src/lib/browser-mcp/index.ts:463` (entry), handler dispatches to `dispatchBrowserTool("browser_type", …)` at `:485` |
| Always-on? | gated by `--browse` opt-in AND `--power-browse` (both default OFF) |
| Capability gate | `capability: "browser_power"` (`src/lib/browser-mcp/index.ts:483`) → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351` list-time, `:1007-1008` call-time) |
| Backing model / endpoint | server-side fn — MV3 extension `toolType()` (`src/browser-ext/background.js:1337`), no model call |
| Write-capable | yes (mutates page: per-keystroke input into the focused element) |

Notes on the gate. `browser_type` is a POWER tool, NOT a base-`browser` lead tool. It carries `capability: "browser_power"` (`:483`), so it is dropped unless BOTH `--browse` (or `GH_ROUTER_ENABLE_BROWSE=1`) AND `--power-browse` (or `GH_ROUTER_ENABLE_POWER_BROWSE=1`, `src/lib/mcp-capabilities.ts:148-150`) are on. The gate fires symmetrically at list-time (`handler.ts:351`) and call-time (`handler.ts:1007-1008`), both ANDing `browserToolsEnabled()` with `browserPowerToolsEnabled()` (defense-in-depth per the comment at `handler.ts:348-350`). Confirmed the L0/L1 primitives (list_tabs, close_tab, read_page, scroll, keyboard, wait, eval_js, download, mouse, drag, `type`, diagnostics, find) all live behind this gate per the table at `docs/browser-mcp-design.md:371`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:465-466`):

> "Type a string into the currently-focused element per-keystroke via CDP Input.dispatchKeyEvent. Each character fires keydown + keypress + input — this is the tool for keystroke-driven autocomplete, chips, search-as-you-type, and any site whose handlers listen on keydown rather than just reading element.value. For plain form-value entry use browser_fill (faster, sets value directly). For chord shortcuts (Control+L, etc) use browser_keyboard. Special characters in text: \n→Enter, \t→Tab, \b→Backspace (dispatched as the named key, not as a literal control char). Other control chars (< 0x20) are rejected with an actionable error. Uppercase letters come from the natural code point — event.shiftKey is false but the typed value is correct."

Input schema (`:467-482`): `required: ["tabId", "text"]`, `additionalProperties: false`.

- `tabId` (number) — no field description.
- `text` (string) — "The text to type. Max 4096 chars. Iterates as Unicode code points (surrogate pairs handled correctly)."
- `delayMs` (number) — "Pause between characters. Default 0. Clamped to [0, 50]. Set > 0 when typing into search-as-you-type inputs that debounce."

### 2b. System prompt (`--append-system-prompt`)

`type` IS named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:630-636`), but ONLY in the `powerNote` branch, which is emitted iff `opts.powerBrowseAvailable` (`:631`). Exact clause (`:632`):

> "Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control."

This is the correct altitude and correct gating: `type` is named (not described) and appears only when power mode is on, so the snippet never advertises a tool absent from the live `tools/list`. The base `browseAvailable` sentence at `:635` names only the six lead tools and uses lowercase "type" as an ACTION verb ("for any click / fill / type / scroll-to") describing `__act`, not the `__type` tool — no collision, since the power clause disambiguates with the backticked `__type`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The injected marker block covering this tool is peer-awareness — the SAME text as 2b (the `buildPeerAwarenessSnippet` output is mirrored into the config-dir CLAUDE.md). No separate directive covers `type`.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-149`):

- `:147` lists the MCP-facing names ("prefix dropped"): `… mouse / drag / type / …`, states the rename is MCP-facing only (wire name stays `browser_*`, matching `index.ts:64-70`), and describes the humanlike-input set: "The humanlike-input set (`mouse / drag / type`) routes through CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` for trusted events … and per-keystroke typing." Matches `toolType()` (`background.js:1337-1423`).
- `:147` documents invariant (2): "`withTabInputLock(tabId, fn)` serialises mouse / drag / type / keyboard / scroll(at-pointer) per tab (CDP mouse state is global per attachment)." Verified: `toolType()` wraps its body in `withTabInputLock(tabId, async () => {…}, TYPE_TAB_INPUT_LOCK_HOLD_CAP_MS)` (`background.js:1366`, `:1422`), and the mutex is documented as per-tab at `background.js:889-894`. `browser_type` gets a larger hold cap (`TYPE_TAB_INPUT_LOCK_HOLD_CAP_MS = 240_000` vs default `60_000`, `:920-921`) because per-keystroke typing is legitimately slow — a nuance not in any model-facing surface, but correctly internal.

`docs/browser-mcp-design.md` agrees:
- Tool table row (`:96`): "`type` | `browser_type` | Type a string per-keystroke via CDP `Input.dispatchKeyEvent` — fires keydown + keypress + input for search-as-you-type / autocomplete / chip inputs."
- Humanlike-input design notes (`:105-138`) and the gate table (`:371`) place `type` in the `browser_power` group and describe the CDP path. `:137` notes `browser_type` rejects pre-composed IME input upfront — an inherent gap, correctly documented.

## 3. Assessment

### 3a. Description quality

- Clarity & routing signal: strong on the WHEN-to-use axis. "the tool for keystroke-driven autocomplete, chips, search-as-you-type, and any site whose handlers listen on keydown rather than just reading element.value" is exactly the discoverability signal that tells the model when real keystrokes matter versus a value-set. The special-char whitelist (`\n`/`\t`/`\b`) and the "other control chars rejected" note are accurate to `toolType()` (`background.js:1358-1365`), and the uppercase/`shiftKey` note matches the implementation (the loop derives the value from the code point without a shift modifier).
- Accuracy vs implementation: the CDP mechanism (`Input.dispatchKeyEvent`, keydown+input per char) matches `background.js:1410-1418`; the 4096-char cap matches `:1342-1343`; "iterates as Unicode code points" matches the `for (const ch of text)` code-point loop (`:1369`). No stale model id or default.
- **Broken routing target — the description steers the model to a tool that does not exist on the MCP surface.** Twice the description names `browser_fill` ("For plain form-value entry use browser_fill (faster, sets value directly)"), but there is NO `toolNameHttp: "browser_fill"` in `BROWSER_TOOLS` (grep confirms only `browser_keyboard` among the three; `browser_fill` and `browser_click` were folded into `browser_act` — see `browser_act`'s own description at `index.ts:596`: "This is the fold-in path for the now-removed browser_click and browser_fill"). `browser_fill` survives ONLY as an internal wire dispatch inside the `act` REF handler (`index.ts:914`, `:922`). A model reading `browser_type` and following its advice would call `mcp__browser__fill` and get an unknown-tool `-32601`. The correct routing target for plain value entry is `browser_act` with `action: "fill"` (or intent mode). This is the load-bearing defect.
- By contrast the `browser_keyboard` reference IS valid: `browser_keyboard` exists (`index.ts:261`) and shares the same `browser_power` gate (`:276`), so whenever `type` is visible, `keyboard` is too. Only the `fill` references are broken.
- Schema minimality (per the ruthlessly-minimal principle): all three fields pass.
  - `tabId` — required, explicit target (invariant: no stateful cursor cache). Missing a field description, but `tabId` is self-explanatory across the whole browser suite; acceptable.
  - `text` — required, the payload. Model-tunable.
  - `delayMs` — model-tunable, clearly scoped to the debounce case, clamped `[0,50]` (matches `background.js` clamp). No echoed-input or diagnostic-only fields.

### 3b. System-prompt coverage

- Named, and correctly gated: `type` appears ONLY in the `powerNote` (`peer-mcp-personas.ts:632`), emitted iff `powerBrowseAvailable`, so the snippet never names it when the tool is gated out. This is the right behavior and mirrors the list-time gate.
- Accurate & non-redundant: the power clause names `__type` as one of the "L0/L1 primitives … for direct DOM / coordinate control" and defers all detail to the description. No duplication of the keystroke mechanics or schema.
- Framing-constraint compliance: no imperatives, no hedges, no anchors disguised as description. "for direct DOM / coordinate control" is a capability statement, not a directive. Compliant.

### 3c. CLAUDE.md coverage

- Accurate and not drifted (for `type` itself): root `CLAUDE.md:147` name list, the humanlike-input CDP claim, and the `withTabInputLock` serialization invariant all match code. The design doc's tool table and gate table agree.
- Injected peer-awareness block (= 2b) is consistent with the description — it names the tool at the power altitude and points at the description for detail.
- **Doc-side gate drift (shared with the sibling tools, surfaced here because `type` is a power tool):** root `CLAUDE.md:145-147` opens "adds 19 browser-control tools under the `browser` MCP server" and lists `type` inline, describing the gate as `browserToolsEnabled()` requiring "BOTH the opt-in AND a positive `hasSupportedBrowserInstalled()` check" — with NO mention that `type` (and the whole L0/L1 primitive set) is additionally hidden behind the separate `--power-browse` gate. A reader of root CLAUDE.md would believe `type` is available under a plain `--browse`; the design doc's own gate table (`browser-mcp-design.md:371-373`) contradicts this and is correct. The code is right (`capability: "browser_power"`); the root CLAUDE.md section is stale relative to the power-mode split.

### 3d. Cross-surface consistency

- The awareness snippet (power-gated) ↔ code gate ↔ design-doc gate table are consistent: `type` is named only in power mode, matching the `browser_power` capability.
- **Contradiction #1 (model-facing, Critical-adjacent):** description ↔ code. `browser_type`'s description tells the model to use `browser_fill`, which is not a callable MCP tool. See 3a.
- **Contradiction #2 (doc-side, Important):** root `CLAUDE.md:145-147` ("19 tools under `--browse`", gate = opt-in + browser-installed) ↔ `browser-mcp-design.md:371` + code (`type` requires `--power-browse`). See 3c.

## 4. Findings

- **[Important]** `src/lib/browser-mcp/index.ts:466`: the description twice routes the model to `browser_fill` ("For plain form-value entry use browser_fill (faster, sets value directly)"), a tool name that is NOT on the MCP surface — `browser_fill`/`browser_click` were folded into `browser_act` (`index.ts:596`, `:914`, `:922`) and only exist as internal wire dispatches. Repro: with `--power-browse` on, a model reads `browser_type`, decides its input is plain value entry, and calls `mcp__browser__fill` → `-32601` unknown tool. Fix: change the clause to point at the actual surface, e.g. "For plain form-value entry use `browser_act` with `action:"fill"` (faster, sets value directly)." Raised to the higher classification per the severity ladder because it is a wrong instruction the code rejects, not merely a stale fact; it stays Important (not Critical) only because the model can recover via `browser_act` and no data is lost.

- **[Important]** `CLAUDE.md:145-147`: the root "Browser-control MCP" section states `--browse` "adds 19 browser-control tools" with the gate described as opt-in + `hasSupportedBrowserInstalled()`, and lists `type` inline — omitting that `type` (and every L0/L1 primitive) is gated behind the separate `--power-browse` flag (`capability: "browser_power"`, `index.ts:483`; gate table `browser-mcp-design.md:371`). A reader concludes `type` is reachable under plain `--browse`. Fix: add one clause to `CLAUDE.md:147` noting the surface splits — six lead tools under `--browse`, the L0/L1 primitives (including `type`) behind `--power-browse` — as the design doc already documents.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:472`: `tabId` has no field description, unlike the sibling `read_page`/`navigate` tools that source it ("Tab id from browser_list_tabs / browser_open_tab"). Since `type` acts on the currently-focused element, a one-line "Tab id from browser_list_tabs / browser_open_tab; type targets whatever element currently has focus in that tab" would remind the model that focus is a precondition (the `act` `type` path click-focuses first, `index.ts:918`, but a direct `browser_type` call does not). Non-blocking.

## 5. Verdict

**N — one Important model-facing fix required.** The gate, the power-only awareness snippet, the CDP mechanism, and the per-tab serialization invariant all match code, and the description's when-to-use signal (keystroke-driven autocomplete / chips / search-as-you-type vs value-set) is exactly the discoverability the tool needs. But the description misroutes the model to `browser_fill`, a tool removed from the MCP surface, so the single most important fix is to repoint that clause at `browser_act` with `action:"fill"`. Secondarily, root `CLAUDE.md:147` should stop implying `type` is a plain-`--browse` tool and name the `--power-browse` gate.
