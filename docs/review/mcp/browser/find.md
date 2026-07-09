# Review: `mcp__browser__find`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__find` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_find` |
| Definition | `src/lib/browser-mcp/index.ts:559` (entry), `:560` `toolNameHttp`, `:561` description, `:576` handler |
| Always-on? | no — gated |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`) — NOT `browser_compound` |
| Backing model / endpoint | server-side fn + inner compressor (`pickMatchingElements`, `src/lib/browser-mcp/compressor.ts:487`); fast model from the `gpt-5.4-mini → claude-sonnet-4.6 → claude-haiku-4.5` chain, deterministic cascade short-circuits when confident |
| Write-capable | no (read-only: returns element refs, mutates nothing) |

Note on the assignment brief: the brief stated the gate is `browser_compound`. The code sets `capability: "browser_power"` at `src/lib/browser-mcp/index.ts:575`. `find` is a **power-mode** tool, not a default-`--browse` compound tool. This is central to the findings below.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:561-562`), verbatim:

> Find up to 5 elements matching a natural-language intent ('the search box at the top', 'the Submit button at the bottom of the login form'). Returns ranked candidates with stable refs the model can pass to browser_act (ref mode) or browser_mouse. Cheaper than browser_read_page when you know what you're looking for — the inner compressor (a small fast model) filters the snapshot for you instead of sending the full element list to the lead model.

Input schema (`:563-573`) — `required: ["tabId", "intent"]`, `additionalProperties: false`:

- `tabId` (`number`) — no `description`.
- `intent` (`string`) — description: "Natural-language description of what to find."

Handler output (`:584-590`): `{ matches: Array<{ ref, role?, name?, bbox?, reason }> }` — each match expands the picked ref against the snapshot element index; refs the index can't resolve degrade to `{ ref, reason }`.

### 2b. System prompt (`--append-system-prompt`)

`find` is named ONLY in the **power-mode** clause of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-632`), verbatim:

> Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

This clause is emitted only when `opts.powerBrowseAvailable` is truthy (`:631` ternary). The default-`--browse` inventory sentence (`:634-635`) names `__act` / `__observe` / `__extract` / `__navigate` / `__open_tab` / `__screenshot` and closes with "The lead never sees raw DOM: refs and bboxes stay internal." — it does **not** name `__find`. So in default `--browse` (no `--power-browse`) `find` is not named anywhere in the snippet, which is correct: the tool is also not registered in that mode (same gate).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The injected marker block covering this tool is **peer-awareness** — the mirrored CLAUDE.md carries the same `buildPeerAwarenessSnippet` text as 2b, so `find` appears there only inside the `powerNote` clause, and only when power mode is on. No other injected block (artifact-panel, operating-defaults, toolbelt) names it.

Checked-in repo `CLAUDE.md` (project root), "Browser-control MCP (`--browse`)" section, `CLAUDE.md:147`:

> `github-router start --browse` (…) opt-in flag adds 19 browser-control tools under the `browser` MCP server (…). MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / read_page / scroll / screenshot / keyboard / wait / eval_js / download / mouse / drag / type / diagnostics / find / act / observe / extract`. (…) Element refs returned by `read_page` are the primary input to subsequent act / mouse / drag calls — preferred over CSS selectors because refs survive dynamic class names.

This root-doc paragraph lists all 19 tools (including `find`) as though `--browse` alone surfaces them, and never mentions `--power-browse`. That disagrees with the code (see Finding 2).

The authoritative gate table lives in `docs/browser-mcp-design.md:371`, which correctly places `find` under `browser_power` ("`--browse` AND `--power-browse` flag"), and `:373` states the default surface is the 6 lead tools (act, observe, extract, navigate, screenshot, open_tab). The design doc agrees with the code on the gate; its two secondary references do not (Finding 3).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. "Find up to 5 elements matching a natural-language intent" plus two worked examples give a clear use-signal, and the when-NOT-to comparison ("Cheaper than browser_read_page when you know what you're looking for") routes the model between `find` and `read_page`. The ref-as-input-to-act contract is stated explicitly: "Returns ranked candidates with stable refs the model can pass to browser_act (ref mode) or browser_mouse." Both named consumers (`browser_act` REF mode, `browser_mouse`) are themselves power-gated, so within power mode the contract is coherent and reachable.
- **Accuracy vs implementation**: the description is faithful. "up to 5" matches `matches.slice(0, 5)` (`compressor.ts:526`). "inner compressor (a small fast model)" matches `callCompressor` (`compressor.ts:521`) and is honest about the deterministic-cascade short-circuit not being surfaced (an internal optimization, correctly hidden). The returned shape carries `ref` / `role` / `name` / `bbox` / `reason` — the description mentions refs and (implicitly) ranked candidates; it does not over-promise.
- **Schema minimality**: minimal and compliant. Two fields, both `required`, both load-bearing (`tabId` targets the tab, `intent` is the query). `additionalProperties: false` is correct. One nit: `tabId` has no `description` here, whereas sibling tools (`navigate`, `screenshot`, `read_page`) annotate it as "Tab id from browser_list_tabs / browser_open_tab." Harmless, but see Finding 4 — with `list_tabs`/`open_tab` split across gates, a `tabId` provenance hint is more valuable here, not less.

### 3b. System-prompt coverage

- **Named or omitted?** Named only in the power-mode `powerNote` clause, and omitted from the default inventory. This is **by design and correct**: the awareness snippet names a tool iff it is in the live `tools/list`, and `find`'s `browser_power` gate means it is absent from default `--browse`. Naming it in default mode would violate the snippet's own invariant ("the snippet never names a tool missing from the live tools/list", `peer-mcp-personas.ts:593-594`).
- **Accurate & non-redundant**: the `powerNote` groups `__find` with the L0/L1 primitives for "direct DOM / coordinate control." Accurate — `find` returns refs/bboxes, which is the DOM-level surface power mode unlocks. Non-redundant with the description (snippet gives category placement; description gives behavior).
- **Framing-constraint compliance**: compliant. The clause is descriptive ("Power mode adds the L0/L1 primitives … for direct DOM / coordinate control"), no imperatives, no "lead with", no anchors. Consistent with the framing pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted?** The mirrored peer-awareness block is accurate (same text as 2b). The checked-in **root** CLAUDE.md drifted: `CLAUDE.md:147` presents `find` (and 12 other power tools) as part of the flat 19-tool `--browse` surface with no `--power-browse` gate mentioned, and states "Element refs returned by `read_page` are the primary input to subsequent act / mouse / drag calls" without noting that `read_page`, `mouse`, `drag`, and `find` are all power-gated. Under plain `--browse` none of those ref sources or consumers exist. See Findings 2 and 3.
- **Injected block vs root CLAUDE.md consistency**: inconsistent. The injected block correctly conditions `find` on power mode; the root doc does not. A reader of root CLAUDE.md would expect `find` under plain `--browse`.

### 3d. Cross-surface consistency

- Description ↔ code: consistent.
- System prompt ↔ code: consistent (power-gated everywhere).
- Root CLAUDE.md ↔ code: **inconsistent** — root doc implies default-`--browse` availability; code power-gates it (Finding 2).
- Design doc ↔ code: authoritative table (`:371`) consistent; two secondary references (`:98`, `:279`) stale — call `find` a "compound" / L2 tool as if compressor-gated (Finding 3).
- Description's REF-mode contract ↔ default lead surface: the wider surface has a latent gap — in default `--browse`, `browser_act` REF mode is advertised (`act` description at `index.ts:609`: "Element ref from browser_find / browser_read_page") but neither ref source is registered, so a default-mode lead can never obtain a ref to use it (Finding 1). This is an `act`/surface-level defect surfaced by auditing `find`, not a defect in `find`'s own text.

## 4. Findings

Ranked, most severe first.

- **[Important]** `src/routes/mcp/handler.ts:351` + `src/lib/browser-mcp/index.ts:609` — **default-`--browse` ref-acquisition gap.** Both ref-producing tools, `find` (`browser_power`, `index.ts:575`) and `read_page` (`browser_power`, `index.ts:201`), are power-gated. The default-`--browse` lead surface is 6 tools (act, observe, extract, navigate, screenshot, open_tab); none return a ref. Yet `browser_act`'s REF mode is present in default mode (`capability: "browser"`, `index.ts:622`) and its schema advertises `ref` "from browser_find / browser_read_page" (`:609`). Repro: launch `claude --browse` (no `--power-browse`); the lead sees `act` with a `ref` param but has no tool that returns a ref, so REF mode is unreachable and `mouse`/`drag` (ref/coord consumers) are absent too — INTENT mode is the only usable path. Not a bug in `find`'s surface, but a coverage gap the `find` audit exposes. Fix options: (a) move `find` (and/or `read_page` summary mode) to the `browser_compound` gate so refs are obtainable whenever a compressor exists, or (b) drop the `ref` param from `act`'s default-mode schema and reintroduce it only under power mode, or (c) document explicitly that REF mode is power-only. Recommend (a) or (c); (a) makes the description's ref contract honest in default mode.

- **[Important]** `CLAUDE.md:147` — **root doc omits the `--power-browse` gate.** The "Browser-control MCP" section lists all 19 tools (including `find`, `read_page`, `mouse`, `drag`, `type`) as what `--browse` "adds," with no mention of `--power-browse`, and asserts "Element refs returned by `read_page` are the primary input to subsequent act / mouse / drag calls" — all four of those are power-gated. A reader concludes `find` and ref-based flows work under plain `--browse`; they do not. Fix: add one clause noting the L0/L1 primitives (list here, incl. `find` / `read_page` / `mouse` / `drag` / `type` / …) live behind `--power-browse` and the default surface is the 6 lead tools, mirroring `docs/browser-mcp-design.md:373`.

- **[Suggestion]** `docs/browser-mcp-design.md:98` and `:279` — **stale "compound" label for `find`.** The tool table (`:98`) tags `find` as "Compound tool" and the L2 prose (`:279`) lists `browser_find` among the L2 compound tools "on top of" the primitives, implying the `browser_compound` gate. The authoritative gate table at `:371` correctly places `find` under `browser_power`. Fix: reword `:98`/`:279` to note `find` is a power-mode tool (it returns raw refs/bboxes — DOM-level output, which is exactly why it sits behind `--power-browse`, unlike `observe`/`extract` which hide DOM), or drop the "compound" framing for it.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:568` — **`tabId` lacks a description.** Sibling browser tools annotate `tabId` as "Tab id from browser_list_tabs / browser_open_tab." Since `list_tabs` is itself power-gated and a fresh power-mode session must call it (or `open_tab`) first, a provenance hint here has real value. Fix: add `description: "Tab id from browser_list_tabs / browser_open_tab."` to the `tabId` property.

## 5. Verdict

**Y (for `find`'s own text) with an Important cross-surface caveat.** `find`'s description and schema are accurate, minimal, and well-routed, and the awareness snippet names it correctly (power-mode only). The blocking-for-cleanup issues are outside `find`'s own string: the root CLAUDE.md omits the `--power-browse` gate, and — the single most important fix — in default `--browse` no tool returns a ref, so `browser_act`'s advertised REF mode is unreachable. Move `find`/`read_page` to the `browser_compound` gate (or document REF mode as power-only) so the ref contract holds in default mode.
