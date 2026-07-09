# Review: `mcp__browser__observe`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__observe` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_observe` |
| Definition | `src/lib/browser-mcp/index.ts:757` (handler → `observePage` at `src/lib/browser-mcp/observe.ts:58`) |
| Always-on? | gated — `--browse` opt-in AND a compressor backend in the live catalog |
| Capability gate | `browser_compound` → `browserToolsEnabled() && browserCompoundToolsEnabled()` (`src/routes/mcp/handler.ts:347`, `:996`) |
| Backing model / endpoint | server-side fn — inner compressor via `callCompressorPublic` (`gpt-5.4-mini` → `claude-sonnet-4.6` → `claude-haiku-4.5`, `/chat/completions` or `/responses`; `src/lib/mcp-capabilities.ts:113-114`) |
| Write-capable | no (read-only page describer; no page mutation) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:759-760`):

> Get a natural-language description of the current page's user-actionable state — what forms, buttons, links, and content sections are visible — in 2-4 sentences. Optional `intent` focuses the description on a region ('describe the login form', 'what's in the comments section'). Use this BEFORE browser_act when you don't know what's on the page, or AFTER navigation to confirm the page loaded. Cheaper than screenshots when text is enough. Does not include canvas/SVG content — those surface as a `hasVisualSurfaces` flag; switch to browser_screenshot for visuals.

Input schema (`src/lib/browser-mcp/index.ts:761-772`), `required: ["tabId"]`, `additionalProperties: false`:

- `tabId` — `number` (no `description`).
- `intent` — `string`, description: `"Optional natural-language focus ('describe the form', 'what's in the sidebar')."`

### 2b. System prompt (`--append-system-prompt`)

`observe` IS named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:635`), inside the `browseAvailable` clause. Exact text:

> `mcp__${browserKey}__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

The clause is descriptive-only (a run-on inventory of the lead surface). It carries no imperatives, no hedges, and no `hasVisualSurfaces → screenshot` escalation — that routing lives only in the tool `description` (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering marker block: **peer-awareness** — the mirrored CLAUDE.md carries the same snippet text as 2b (composed in `claude.ts` and written to the mirror alongside `--append-system-prompt`; `src/claude.ts:1019-1032`). So the `__observe(intent?)` clause quoted in 2b is the CLAUDE.md coverage verbatim.

Checked-in repo root CLAUDE.md (`CLAUDE.md:145-147`, "Browser-control MCP (`--browse`)") lists `observe` inside the flat 19-tool inventory under the `browser` server and describes the gate only as `browserToolsEnabled()` (opt-in + `hasSupportedBrowserInstalled()`). It does NOT record that `observe`/`extract` carry the stricter `browser_compound` tag that additionally requires a compressor backend. The per-tool detail and the three-tag table live in `docs/browser-mcp-design.md:100`, `:370`, `:377-379`.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. It states when to use (`BEFORE browser_act` when the page is unknown; `AFTER navigation` to confirm load), the cost trade ("Cheaper than screenshots when text is enough"), and one when-NOT signal (canvas/SVG → screenshot). The 2-4 sentence output bound is stated and matches the compressor system prompt (`observe.ts:32`).
- **Accuracy vs implementation**: accurate. `intent` focusing is honored (`observe.ts:71`, and the OBSERVE_SYSTEM "focus the description on the region most relevant to that intent" at `:32`). The `hasVisualSurfaces` flag is genuinely set from `snapshot.visualSurfaces` (`observe.ts:85`) and returned to the caller (`:83-89`). No stale model id or default in the surface (the compressor chain is internal and not named to the model).
- **Schema minimality**: clean. Only `tabId` (required, addressing the target tab — the no-stateful-cursor invariant means every tool takes an explicit target) and optional `intent` (model-tunable, changes the output focus). No echoed-input or diagnostic-only fields. Meets the "ruthlessly minimal MCP tool surface" bar. Minor: `tabId` has no `description`, but its meaning is unambiguous and consistent with every other browser tool's `tabId`.

### 3b. System-prompt coverage

- **Named or omitted**: named (`peer-mcp-personas.ts:635`), by design, as part of the lead-surface inventory.
- **Accurate & non-redundant**: the one-line gloss ("a 2-4 sentence natural-language page description") agrees with the tool description and the code. It intentionally omits the `hasVisualSurfaces`/screenshot escalation and the `intent` focusing detail — that lives in the fuller tool description, so the snippet stays a compact router, not a duplicate.
- **Framing-constraint compliance**: compliant. Pure noun-phrase inventory, no imperative ("Lead with…"), no hedge, no anchor. Consistent with the framing rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Accuracy / drift**: the mirrored peer-awareness block matches 2b exactly (same builder). The checked-in root CLAUDE.md is accurate as far as it goes but INCOMPLETE on the gate: it presents all 19 browser tools as uniformly gated by `browserToolsEnabled()`, whereas `observe` is additionally gated by `browserCompoundToolsEnabled()` (compressor presence). A reader of only the root CLAUDE.md would not learn that `observe` can be absent on a `--browse` session whose catalog lacks a compressor model.
- **Injected-block vs root consistency**: the injected snippet and the root doc agree on what `observe` does; they diverge only on gate granularity (root doc omits the `browser_compound` distinction).

### 3d. Cross-surface consistency

The one real inconsistency is **gate-vs-awareness**: the awareness snippet (2b/2c) is emitted whenever `state.browseEnabled` is true (`src/claude.ts:1024` passes `browseAvailable: state.browseEnabled`), so it names `__observe` on every `--browse` launch. But the tool itself is dropped from `tools/list` and rejected at `tools/call` when `browserCompoundToolsEnabled()` is false (no compressor backend in the catalog; `handler.ts:347`, `:996-997`). On such a session the model is told `__observe` exists but a call returns `-32601`. `__act` (INTENT mode) and `__extract` share this exposure since they are also compressor-backed, so this is a lead-surface-wide gap, not observe-specific. Descriptions ↔ code otherwise agree.

## 4. Findings

- **[Important]** `src/claude.ts:1024` — the peer-awareness snippet is gated on `state.browseEnabled` alone, so it names `__observe` (and `__act` INTENT / `__extract`) even when `browserCompoundToolsEnabled()` is false and those tools are absent from `tools/list`/`tools/call`. On a `--browse` session whose catalog has no compressor model (`gpt-5.4-mini` → `claude-sonnet-4.6` → `claude-haiku-4.5` all missing), the model is invited to call a tool that returns `-32601`. Fix: gate the compressor-backed portion of the browser clause on `browserCompoundToolsEnabled()` (mirror how `workerToolsAvailable`/`standInAvailable` gate their clauses per `claude.ts:1010-1013`), or split the sentence so only the always-available lead tools (`__navigate`/`__open_tab`/`__screenshot` — `capability: "browser"`) are named unconditionally.

- **[Suggestion]** `CLAUDE.md:147` — the root doc lists `observe` in the flat 19-tool `browser` inventory and describes the gate only as `browserToolsEnabled()`, omitting that `observe`/`extract` carry the stricter `browser_compound` tag. Add a one-line note that the compound tools additionally require a compressor backend, so the checked-in doc matches `docs/browser-mcp-design.md:370` and the code.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:766` — `tabId` has no schema `description` (every other field across the browser tools that carries semantic weight has one). A one-liner ("The tab id from browser_list_tabs / browser_open_tab") would remove any ambiguity about where the id comes from. Non-blocking; meaning is already clear from convention.

## 5. Verdict

Y (with one Important fix). The `observe` description is accurate, minimal, well-routed, and the `hasVisualSurfaces → screenshot` escalation is stated actionably; the system-prompt naming is framing-compliant. The single most important fix: gate the awareness snippet's compressor-backed browser clause on `browserCompoundToolsEnabled()` (`src/claude.ts:1024`) so the model is never told `__observe` exists on a session where it is gated out.
