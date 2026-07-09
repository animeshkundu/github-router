# Review: `mcp__browser__extract`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__extract` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_extract` (MCP prefix stripped at `peer-mcp-personas.ts:2079`; wire literal unchanged so the extension needs no reload) |
| Definition | `src/lib/browser-mcp/index.ts:783` (entry), handler `:803`; compressor `src/lib/browser-mcp/compressor.ts:609` (`extractStructured`) |
| Always-on? | gated by `browser_compound` |
| Capability gate | `capability: "browser_compound"` (index.ts:802) → `browserToolsEnabled() && browserCompoundToolsEnabled()` (handler.ts:347, 996-997) |
| Backing model / endpoint | inner compressor: catalog-picked from `gpt-5.4-mini → claude-sonnet-4.6 → claude-haiku-4.5` (`compressor.ts:61-65`), `/responses` or `/chat/completions` per `pickEndpoint` |
| Write-capable | no (read-only extraction; no page mutation) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`index.ts:785-786`):

> "Structured extraction from the current page into a JSON object matching the provided schema. The inner compressor reads the page snapshot (text + elements) and synthesizes the typed object. Use this instead of browser_read_page + lead-model parsing when you know the shape you want (e.g. a list of {title, author, url} rows from a PR list)."

Input-schema fields (`index.ts:787-800`), `required: ["tabId", "schema", "instruction"]`, `additionalProperties: false`:

- `tabId` — (no description) `{ type: "number" }`
- `schema` — "JSON schema (or schema-shaped descriptor) for the desired output shape." (no `type` constraint — accepts any JSON value)
- `instruction` — "What to extract, in plain language ('the visible PR list')."

### 2b. System prompt (`--append-system-prompt`)

`extract` IS named, in `buildPeerAwarenessSnippet` paragraph 2, gated on `opts.browseAvailable` (`peer-mcp-personas.ts:630-636`). Exact clause:

> "`mcp__browser__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal."

Descriptive form ("`__extract(schema, instruction)` for typed extraction") — no imperative, consistent with the framing constraint pinned by `tests/peer-mcp-personas.test.ts:536` (`not.toMatch(/^Lead with /im)`). Presence/absence pinned by `tests/peer-mcp-personas.test.ts:443,458`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: peer-awareness (same text as 2b — the mirrored CLAUDE.md carries the identical `buildPeerAwarenessSnippet` string).

Checked-in repo root `CLAUDE.md` documents it in "Browser-control MCP (`--browse`)" (`CLAUDE.md:147`): `extract` is listed in the 19-tool prefix-stripped set, and `browser_compound` (find / act / extract) is the compressor-gated tier. The gate description agrees with `handler.ts` and `mcp-capabilities.ts`. `docs/browser-mcp-design.md` carries the full architecture.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. It states what it does (structured extraction into a caller schema via the inner compressor) AND gives an explicit when-to-use vs the alternative ("instead of `browser_read_page` + lead-model parsing when you know the shape you want"), with a concrete example. This is the clearest when-not signal of the three lead tools — it directly names the tool it replaces.
- **Accuracy vs implementation**: accurate. The compressor does read `snapshot.text + snapshot.elements` (`compressor.ts:617-623`) and force a typed tool-call whose `result` parameter IS the caller schema (`compressor.ts:624-635`), so "synthesizes the typed object" is faithful. One nuance the description omits: the tool pre-validates the schema (`validateExtractSchema`, `compressor.ts:556`) and post-validates the result shape (`ResultShapeError`, `compressor.ts:645-650`), returning clean `isError` envelopes on failure (`index.ts:819-824`) — this is actionable behavior the model would benefit from knowing (it can fix a bad schema on retry), but its omission is not wrong, only incomplete.
- **Schema minimality**: passes. All three fields are `required` and load-bearing: `tabId` selects the tab, `instruction` is the extraction ask, `schema` is the output shape the compressor is forced to fill. No echoed-input or diagnostic-only field. `additionalProperties: false` is set. The `schema` field intentionally carries no JSON-Schema `type` on the MCP field itself (it accepts a schema-shaped descriptor), which is correct — constraining it would reject valid `$ref`/combinator schemas the inner validator accepts.

### 3b. System-prompt coverage

- **Named**, as one clause of the browser lead-surface sentence. By design — the snippet describes the 6 lead tools compactly rather than one clause per tool.
- **Accurate & non-redundant**: the snippet frames extract as "typed extraction" and asserts "the lead never sees raw DOM" — both true (the compressor consumes the snapshot internally; the tool returns only the extracted object). Non-redundant with the description (the description carries the when-not-to-use detail; the snippet carries the lead-surface framing).
- **Framing-constraint compliance**: compliant. Pure noun-phrase description, no imperative, no hedge, no anchor.

### 3c. CLAUDE.md coverage

- Accurate and not drifted: root `CLAUDE.md:147` lists `extract` and correctly places it in the `browser_compound` compressor-gated tier; the mirrored block matches 2b.
- Injected block vs checked-in root are consistent (the injected peer-awareness is a compact lead-surface line; the root doc adds the full gate/architecture detail).

### 3d. Cross-surface consistency

One real gap (see Findings F1): the **awareness snippet advertises `__extract` under the plain `--browse` opt-in, but the tool is gated by the stricter `browser_compound` (compressor-backend) gate**. On a `--browse` session where no compressor backend is in the catalog, the snippet still names `__extract` (and `__act` intent-mode, `__find`) while `tools/list` omits them. The description ↔ code ↔ root-CLAUDE.md are otherwise consistent.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:630` + `src/claude.ts:1024` — the awareness snippet names `__extract` (and `__act`, whose intent mode also needs the compressor) whenever `opts.browseAvailable` is true, and the parent call site passes `browseAvailable: state.browseEnabled` — the plain `--browse` opt-in, NOT the compound gate. But `browser_extract` is dropped from `tools/list`/`tools/call` when `browserCompoundToolsEnabled()` (`compressorAvailable()`, `mcp-capabilities.ts:126-128`) is false — i.e. no `gpt-5.4-mini`/`sonnet-4.6`/`haiku-4.5` backend in the live catalog. Misroute scenario: a `--browse` session on a catalog lacking every compressor fallback model — the model reads "`__extract(schema, instruction)` for typed extraction" in its system prompt, calls `mcp__browser__extract`, and gets a -32601 "method not found" because the tool was filtered out. Fix: thread a `compoundBrowseAvailable` (= `browserCompoundToolsEnabled()`) flag into `buildPeerAwarenessSnippet` and gate the `__act`/`__extract` clauses on it, or split the snippet so only `__observe`/`__navigate`/`__open_tab`/`__screenshot` (the non-compressor lead tools) appear when the compressor is absent. Severity Important not Critical: the standard enterprise catalog always carries a fallback model, so the mismatch only bites a degraded/lesser-tier catalog; it is a stale-when-not signal, not a correctness bug on the primary target.

- **[Suggestion]** `src/lib/browser-mcp/compressor.ts:154` — the inflight-saturation error string says "cap 8" while the module comment at `compressor.ts:24` says "cap = 32" and the shared cap `MAX_INFLIGHT_TOOLS_CALL` defaults to 128 (`CLAUDE.md`). The three disagree. This string is internal (thrown from `callCompressor`; on the extract path it surfaces only as a re-thrown exception, not a model-facing field), so it does not corrupt the tool surface — but it is a stale literal worth correcting to the live cap for operator-log accuracy. Fix: interpolate the actual cap or drop the parenthetical.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:785-786` — the description omits that the tool validates the schema up front and the result shape after, surfacing `invalid schema: …` / `extraction produced wrong shape: …` as clean `isError` envelopes the caller can act on. Adding a half-sentence ("bad schema or wrong-shape result returns a fixable error") would make the retry loop legible to the model. Non-blocking polish.

## 5. Verdict

Y (with one fix). The injected surface is minimal, accurately described, well-routed (best when-not signal of the browser lead tools), and framing-compliant. The single most important fix: gate the awareness snippet's `__extract`/`__act` clauses on the compound (compressor-backend) availability rather than the plain `--browse` opt-in, so the system prompt never advertises a tool that `tools/list` has filtered out on a compressor-less catalog.
