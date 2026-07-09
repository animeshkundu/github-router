# Review: `mcp__browser__keyboard`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__keyboard` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_keyboard` |
| Definition | `src/lib/browser-mcp/index.ts:260-280` |
| Always-on? | gated (opt-in `--browse` AND `--power-browse`) |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`, call-time `:1005-1015`) |
| Backing model / endpoint | server-side fn (extension `toolKeyboard`, CDP `Input.dispatchKeyEvent`) |
| Write-capable | yes (mutates page / browser state; in `MUTATES_PAGE` set per `docs/browser-mcp-design.md:338`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:262-263`):

> Send a keystroke or chord to the focused element. Use 'Control+L' / 'Command+L' for browser shortcuts, single characters for typing. Uses chrome.debugger so browser-level shortcuts (Ctrl+T, Ctrl+W, etc) actually fire.

Input schema (`src/lib/browser-mcp/index.ts:264-275`), `required: ["tabId", "keys"]`, `additionalProperties: false`:

- `tabId` (number) — no description.
- `keys` (string) — "Key or chord. Modifiers (Control, Alt, Shift, Meta / Command) joined with '+'. Example: 'Control+L'."

### 2b. System prompt (`--append-system-prompt`)

Named ONLY in POWER mode, inside the `powerNote` clause of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-633`). Verbatim:

> Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

`powerNote` is empty (`""`) unless `opts.powerBrowseAvailable`, and the whole browser sentence only appears when `opts.browseAvailable` (`:630`). So in default `--browse` (non-power) mode the snippet names the lead surface (`act` / `observe` / `extract` / `navigate` / `open_tab` / `screenshot`) but NOT `keyboard`. The tool is named only by bare token `__keyboard` in a list; no per-tool routing sentence, no "when to use" guidance in the snippet — appropriate given the framing constraint (see 3b).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering injected block: **peer-awareness** — the same `buildPeerAwarenessSnippet` text as 2b is mirrored into `<CLAUDE_CONFIG_DIR>/CLAUDE.md`, so keyboard's mirrored coverage is identical (named only via `__keyboard` in the power-mode list, and only when power is on).

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:145-149`) documents the tool at the suite level:

- `:147` lists the MCP-facing names including `keyboard`, states "The humanlike-input set (`mouse / drag / type`)" (keyboard is NOT in that named triad) and invariant (2): "`withTabInputLock(tabId, fn)` serialises mouse / drag / type / keyboard / scroll(at-pointer) per tab (CDP mouse state is global per attachment)." This agrees with the code: `toolKeyboard` wraps its dispatch in `withTabInputLock` (`src/browser-ext/background.js:851`).

`docs/browser-mcp-design.md` documents keyboard directly:
- `:90` — table row: "`keyboard` | `browser_keyboard` | Send a chord (Control+L, etc) via CDP `Input.dispatchKeyEvent`."
- `:113` — the per-tab mutex serialises "mouse / drag / type / keyboard / scroll(at-pointer)".
- `:371` — gate table: `browser_power` = `--browse` AND `--power-browse`, member list includes `keyboard`.

All three agree with the code (gate, serialization, CDP path).

## 3. Assessment

### 3a. Description quality

- **Routing signal (keyboard vs type):** the description does distinguish the primary use ("browser shortcuts", "chords") and correctly explains WHY it exists — `chrome.debugger` so browser-level shortcuts "actually fire", which a JS-dispatched `KeyboardEvent` does not. This is the real differentiator from `browser_type` and it's stated. The handler comment confirms it (`src/browser-ext/background.js:840-842`).
- **Mixed steer on single-character typing:** the description says "single characters for typing." This partially competes with `browser_type` (per-keystroke text into a field) and with the extension's own routing hint, which pushes text INTO `keyboard` only for control sequences: `browser_type` rejects unsupported control chars with "Use browser_keyboard for other control sequences" (`src/browser-ext/background.js:1362`), and a code comment says non-whitelisted control chars "can route them through browser_keyboard" (`:1355`). So the intended split is: `type` for literal text (including `\n`/`\t`/`\b`), `keyboard` for chords and control keys. "single characters for typing" invites the model to type prose one char at a time via keyboard, which is slower and bypasses `type`'s field-focus semantics. Minor mis-routing risk (see Findings).
- **Accuracy vs implementation:** gate/behavior accurate. No stale model id (server-side fn). The handler supports the modifiers named in the schema — `Control`/`Ctrl`, `Alt`, `Shift`, `Meta`/`Cmd`/`Command` (`:836-839`); the schema lists "Control, Alt, Shift, Meta / Command" but omits the also-accepted `Ctrl` and `Cmd` aliases (harmless; the canonical forms are shown).
- **Schema minimality:** two fields, both required and both actionable — `tabId` (routing) and `keys` (the payload). No echoed-input or diagnostic-only fields. Passes the ruthless-minimality bar. `tabId` lacks a description but its meaning is self-evident and consistent with every sibling browser tool.

### 3b. System-prompt coverage

- **Named or omitted:** named in power mode only (`:632`), as a bare `__keyboard` token in the L0/L1 primitives list. Omitted from default `--browse` — correct, because the tool is gated off in that mode, and the snippet is built to never name a tool absent from the live `tools/list` (the conditional-sentence design at `:591-594` / `:630-637`).
- **Accurate & non-redundant:** the one-line power note describes the category ("direct DOM / coordinate control") without repeating the per-tool description. No drift.
- **Framing-constraint compliance:** the power note is a plain capability inventory — no imperatives ("Lead with…"), no hedges, no anchors. Compliant with the framing constraint pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Mirrored peer-awareness:** identical to 2b; accurate.
- **Root CLAUDE.md:** `:147` correctly excludes keyboard from the "humanlike-input set (`mouse / drag / type`)" (keyboard is a discrete-keystroke tool, not a per-keystroke text tool), and correctly includes it in the `withTabInputLock` serialization list. Consistent with `docs/browser-mcp-design.md:90,113,371` and the code. No drift found for keyboard specifically.

### 3d. Cross-surface consistency

- Gate is consistent everywhere: `browser_power` = `--browse` AND `--power-browse`, enforced symmetrically at list-time (`handler.ts:351`) and call-time (`handler.ts:1005-1015`, returns -32601 when off). Matches `docs/browser-mcp-design.md:371` and `mcp-capabilities.ts:130-150`.
- Serialization invariant consistent across description-adjacent docs and code (`withTabInputLock` at `background.js:851`).
- One soft inconsistency: the tool description's "single characters for typing" is not reflected in — and mildly contradicts — the surrounding docs/comments that route literal text to `browser_type` and reserve `keyboard` for chords/control keys.

## 4. Findings

- **[Suggestion]** `src/lib/browser-mcp/index.ts:263` — "single characters for typing" in the description weakly competes with `browser_type` and can nudge the model to type text char-by-char through `keyboard` (slower, no field-focus semantics). The extension's own hints reserve keyboard for chords/control sequences (`background.js:1355,1362`). Fix: reword to reserve keyboard for chords and non-printable/control keys, e.g. "Use 'Control+L' / 'Command+L' for browser shortcuts and named keys (Enter, Tab, Escape, ArrowDown); prefer `browser_type` for literal text into a focused field." This also adds a "when NOT to use" signal the current text lacks.
- **[Suggestion]** `src/lib/browser-mcp/index.ts:270-273` — the `keys` schema names modifiers "Control, Alt, Shift, Meta / Command" but the handler also accepts `Ctrl` and `Cmd` (`background.js:836-839`); conversely a bare/trailing `+` or empty segment isn't validated (`parts.pop()` can yield `""`). Low impact and not model-facing-critical; optionally note that a single named key without a modifier is valid (e.g. `keys: "Enter"`), since the only worked example is a chord (`'Control+L'`) and the model may not infer that lone keys are accepted.

No Critical or Important findings: the injected surface routes correctly, the gate is symmetric and accurate across all three surfaces, and the schema is minimal.

## 5. Verdict

**Y** — the injected surface for `browser_keyboard` is correct, minimal, and consistent across description, power-mode system-prompt note, and CLAUDE.md; the single most useful fix is rewording "single characters for typing" (`index.ts:263`) to steer literal text to `browser_type` and add a when-NOT-to-use signal.
