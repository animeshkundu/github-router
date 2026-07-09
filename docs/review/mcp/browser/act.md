# Review: `mcp__browser__act`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__act` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_act` (MCP-facing name strips the `browser_` prefix; wire string unchanged so the extension keeps dispatching) |
| Definition | `src/lib/browser-mcp/index.ts:593` (entry), handler `:623-755` |
| Always-on? | gated by `--browse` opt-in |
| Capability gate | `capability: "browser"` → `browserToolsEnabled()` (`src/lib/mcp-capabilities.ts:167`). List-time `src/routes/mcp/handler.ts:340`; call-time `:952`. Bridge pre-flight (`browserPreflight`) runs before the inflight slot (`:1110`) |
| Backing model / endpoint | server-side fn `dispatchBrowserTool` (extension over WS). INTENT-mode escalation ALSO calls the inner compressor: `gpt-5.4-mini` → `claude-sonnet-4.6` → `claude-haiku-4.5` via `/responses` or `/chat/completions` (`src/lib/browser-mcp/compressor.ts:61-65`) |
| Write-capable | no repo writes; MUTATES page state (click / fill / type / select / scroll) in a live browser |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:595-596`):

> Preferred for any click / fill / type / scroll-to action against a tab. Two modes: (1) INTENT mode — pass `intent` as natural language ('click the submit button'); the inner compressor (a small fast model) maps it to an element + action. Auto-escalates to visual fallback (screenshot + multimodal model + pixel-coord click) when the intent points into a canvas / svg region the a11y tree can't see. (2) REF mode — pass `ref` (from a prior browser_find or browser_read_page) and optionally `value`; dispatches directly with zero compressor latency. This is the fold-in path for the now-removed browser_click and browser_fill. Returns {ok, action_taken, target_ref, navigated}.

Input schema (`src/lib/browser-mcp/index.ts:597-621`), `required: ["tabId"]`, `additionalProperties: false`:

- **`tabId`** (number): no description.
- **`intent`** (string): "Natural-language description of the action. Triggers INTENT mode. Mutually exclusive with `ref`."
- **`ref`** (string): "Element ref from browser_find / browser_read_page. Triggers REF mode (no compressor round-trip)."
- **`action`** (enum `click|fill|type|select|scroll_into_view`): "REF mode only. Defaults to 'click'. In INTENT mode, the compressor picks the action."
- **`value`** (string): "For fill / type / select: the string value to set. In INTENT mode the compressor uses this when an action requires a value."

Returned envelope (verified against handler + `dispatchActionByRef` `:936-942` and `runAtomicIntentStep` `:881-888`):
- REF mode / single-step INTENT (text match): `{ok, action_taken, target_ref, navigated?}`.
- INTENT visual fallback: `{ok, action_taken:"click_visual", x, y, confidence, reason}` — NO `target_ref` (coord click, `:881-888`).
- Multi-step compound INTENT: `{ok, summary, template, steps_completed, navigated}` — NO `target_ref`, NO `action_taken` (`:748-754`); on failure `{ok:false, summary, template, steps_completed, failed_step, ...}` (`:687-694`, `:733-739`).

### 2b. System prompt (`--append-system-prompt`)

`act` IS named as the browser lead-surface primary in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:634-635`), verbatim (emitted only when `opts.browseAvailable`):

> `mcp__${browserKey}__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

Note the snippet advertises only the `__act(intent, value?)` INTENT signature; REF mode is not mentioned in the system prompt (it lives in the tool description). `browserKey` interpolates to `browser` on the no-collision path.

The snippet's `browseAvailable` is wired to `state.browseEnabled` at the actual `--append-system-prompt` call site (`src/claude.ts:1024`) — the RAW opt-in flag, NOT `browserToolsEnabled()` and NOT any compressor check. (`src/claude.ts:577` also passes `browseAvailable: browseAgentEnabled()`, but that call feeds `writePeerMcpRuntimeFiles` for the `worker-browse` dispatch-mode wiring, not this snippet.)

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering injected block: **peer-awareness** — the same `buildPeerAwarenessSnippet` bytes as 2b, appended to the mirror. The mirror and `--append-system-prompt` carry identical text; no `act`-specific mirror line beyond the shared browser sentence.

Checked-in root `CLAUDE.md` documents `act` in the "Browser-control MCP (`--browse`)" section (`CLAUDE.md:147`): it lists `act` among the 19 MCP-facing tool names and states "Element refs returned by `read_page` are the primary input to subsequent act / mouse / drag calls — preferred over CSS selectors because refs survive dynamic class names," plus the three load-bearing invariants (explicit-target, `withTabInputLock`, `elementFromPoint` hit-test → `target_obscured` / `force:true`). It does NOT describe `act`'s two-mode (INTENT/REF) split or that INTENT mode depends on the compressor. The fuller two-mode + tier description lives in `docs/browser-mcp-design.md:276-278` and the three-tier gate table `:368-371`.

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal — strong.** The description leads with the routing verb ("Preferred for any click / fill / type / scroll-to"), then cleanly separates the two modes with when-to-use signal for each (INTENT = natural language, REF = you already hold a stable ref from `find`/`read_page`, zero compressor latency). The visual-fallback escalation and the "fold-in path for the now-removed browser_click / browser_fill" note orient a model that was trained on the older surface. The returned-shape hint is present.

**Accuracy vs implementation — mostly accurate, one return-shape overstatement.** Verified:
- INTENT vs REF branching: `refIn` present ⇒ `dispatchActionByRef` (REF, no compressor, `:633-635`); else `intent` ⇒ decompose + `runAtomicIntentStep` (`:644-647`). Matches.
- REF `action` default `"click"`: `:634`. Matches "Defaults to 'click'".
- Visual fallback fires only when `snapshot.visualSurfaces` non-empty and text match failed/low-confidence (`:852-889`); uses `browser_screenshot` + `pickElementVisual` + coord `browser_mouse` click with `force:true`. Matches "when the intent points into a canvas / svg region the a11y tree can't see."
- "the compressor picks the action" (INTENT): action is actually chosen by `inferAction`/`deterministicResolve` local rules (`compressor.ts:401,416-436`; `matcher.ts:98`), and the element is picked by the deterministic cascade first, escalating to the fast model only on ambiguity (`pickElement` `compressor.ts:371-407`). So the compressor is the escalation matcher, not the universal action-picker — the description slightly over-credits the compressor, but this is model-facing simplification, not misrouting.
- Return shape: the description promises a fixed `{ok, action_taken, target_ref, navigated}`, but only REF mode and single-step text-match INTENT return that shape. Visual fallback and multi-step compound omit `target_ref` (and compound omits `action_taken`, returning `summary`/`steps_completed`/`template` instead). A model that hard-parses `target_ref` after a multi-step intent gets `undefined`. See [Important-2].

**Schema minimality — passes, with a mode-scoping caveat.** Against the three-way test in `docs/peer-mcp-design.md`:

| Field | Verdict | Test |
|---|---|---|
| `tabId` | keep | (a) required to call |
| `intent` | keep | (a) triggers INTENT mode; required unless `ref` |
| `ref` | keep | (a) triggers REF mode; required unless `intent` |
| `action` | keep | (b) model tunes REF-mode dispatch (fill vs type vs scroll) |
| `value` | keep | (b) required for fill/type/select |

No echoed-input or diagnostic-only field. `additionalProperties:false` is set. The two-mode design is inherently more schema than a single-mode tool, but each field earns its place. The one weakness is that `action`/`value` are documented as REF-mode-scoped ("REF mode only") yet the schema cannot express "required-together / mutually-exclusive-with" — enforcement is entirely in the handler prose + `typeof` guards. See 3d and [Suggestion-1].

### 3b. System-prompt coverage

**Named, correctly, as the lead primary.** The snippet foregrounds `__act` first in the browser lead surface and frames it as "for any click / fill / type / scroll-to (an inner fast model resolves intent)" — an accurate one-line capability statement.

**Framing-constraint compliance — passes.** "Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to" is a declarative capability/routing statement, not an imperative "Lead with act." No hedges, no rationale-as-description. Consistent with the framing rules pinned by `tests/peer-mcp-personas.test.ts`.

**Non-redundant with the description — yes.** The snippet gives only the INTENT signature and the "refs stay internal" framing; the description carries the REF mode, visual fallback, and return shape. Different altitude, no bloat.

**One coverage gap:** the snippet says "an inner fast model resolves intent" and is emitted whenever `state.browseEnabled` (`src/claude.ts:1024`), independent of whether any compressor backend exists in the catalog. On a catalog with no compressor model, the system prompt still promises intent-resolution for `__act`, but the escalation path throws (see [Important-1]).

### 3c. CLAUDE.md coverage

**Accurate, not drifted, but thin on `act` specifics.** The mirrored peer-awareness block equals 2b. The root CLAUDE.md browser section documents `act`'s existence, the ref-as-primary-input guidance, and the three humanlike-input invariants, all matching code (`elementFromPoint`/`target_obscured`/`force:true` at `src/browser-ext/background.js:1104,1200`; `withTabInputLock` at `:925`). It does not mention the INTENT/REF split or the compressor dependency; that is delegated to `docs/browser-mcp-design.md`. Not drift, just division of labor.

**Internal design-doc inconsistency (not code drift, but doc-vs-doc):** `docs/browser-mcp-design.md:369` places `act` in the `browser` tier ("`--browse` opt-in"), while `:290` and `:370` state INTENT mode "goes through the compressor" and define `browser_compound` precisely as "`--browse` AND compressor backend in catalog." The doc thus documents both that `act` needs the compressor and that `act` is gated at the tier that does not check for it. See [Important-1].

### 3d. Cross-surface consistency

- Description ↔ snippet ↔ code agree on the INTENT-mode capability and the lead-primary framing.
- **INTENT/REF exclusivity is stated but not schema-enforced.** The description says intent is "Mutually exclusive with `ref`," but the schema allows both. The handler resolves the ambiguity by precedence: if `ref` is present it takes REF mode and IGNORES `intent` (`:633-635`, the `intent` branch is unreachable once `refIn` is truthy). So passing both is silently accepted and `intent` is dropped — no error, no misroute, but the "mutually exclusive" contract is advisory only. The neither-provided case IS handled with a clean error (`:629-631`). See [Suggestion-1].
- **Gate vs runtime dependency mismatch** (the central finding): `act` is `capability: "browser"` (`:622`) so it is listed and callable whenever `browserToolsEnabled()`, but INTENT-mode escalation calls `callCompressor`, which THROWS when `compressorAvailable()` is false (`compressor.ts:147-150`). The compound siblings `find`/`observe`/`extract` are correctly `browser_compound`-gated (dropped from `tools/list` and -32601 at call-time when no backend). `act` is not. See [Important-1].

## 4. Findings

- **[Important-1]** `src/lib/browser-mcp/index.ts:622` — `act` is tagged `capability: "browser"`, so it is listed and callable whenever `--browse` is on, but its INTENT-mode escalation path depends on a compressor backend that `capability: "browser"` never checks. Repro: launch with `--browse` on a catalog where none of `gpt-5.4-mini` / `claude-sonnet-4.6` / `claude-haiku-4.5` is present with `tool_calls` + a reachable endpoint (`compressorAvailable()===false`). The model sees `act` in `tools/list` and the system prompt promises "an inner fast model resolves intent." An INTENT call whose target the deterministic cascade cannot resolve to a clear winner escalates to `pickMatchingElements` → `callCompressor`, which throws `no backend available in catalog` (`compressor.ts:147-150`) — a raw exception, not the clean -32601 the compound siblings return. REF-mode `act` and simple deterministic-cascade intents still work (no compressor), which is why the tool isn't fully dead, but the intent-resolution the surface advertises silently fails. This is documented-but-unfixed: `docs/browser-mcp-design.md:290,370` say INTENT mode goes through the compressor, yet `:369` gates `act` at the non-compressor tier. Fix: either (a) split `act` so INTENT mode is `browser_compound`-gated while REF mode stays `browser`-gated (two entries, or a runtime `browserCompoundToolsEnabled()` re-check inside the INTENT branch returning a clean isError envelope), or (b) if `act` must stay a single `browser` tool, catch the compressor-absent case in `runAtomicIntentStep`/`pickElement` and return `{ok:false, error:"intent resolution unavailable: no compressor backend; use ref mode"}` instead of throwing, and soften the description/snippet to note intent-resolution requires a compressor backend.

- **[Important-2]** `src/lib/browser-mcp/index.ts:596` — the description promises a single fixed return shape `{ok, action_taken, target_ref, navigated}`, but three of the tool's paths diverge: visual fallback returns `action_taken:"click_visual"` with `x/y/confidence` and NO `target_ref` (`:881-888`); multi-step compound INTENT returns `{ok, summary, template, steps_completed, navigated}` with NO `target_ref` and NO `action_taken` (`:748-754`); compound failure returns `{ok:false, summary, failed_step, steps_completed}` (`:687-694`). A model that keys off `target_ref` or `action_taken` after a multi-word intent will read `undefined`. Fix: describe the shape as mode-dependent, e.g. "Returns `{ok, action_taken, target_ref, navigated}` for a single action; multi-step intents return `{ok, summary, steps_completed}`; visual fallback returns `{ok, action_taken:'click_visual', x, y}`." No code change required — this is a description accuracy fix.

- **[Suggestion-1]** `src/lib/browser-mcp/index.ts:603-610` — the "Mutually exclusive with `ref`" contract on `intent` is advisory only; the schema permits both and the handler silently prefers `ref`, dropping `intent` (`:633-635`). Low-impact (deterministic, no misroute), but a model that expects an error on an accidental both-provided call gets a silent REF dispatch against a possibly-wrong element. Fix: either note in the `intent` description that "if both are passed, `ref` wins and `intent` is ignored," or reject both-provided with a clean isError envelope for symmetry with the neither-provided guard at `:629-631`.

- **[Suggestion-2]** `docs/browser-mcp-design.md:369` — the three-tier gate table lists `act` under `browser` without flagging that INTENT mode's compressor dependency is what `browser_compound` exists to gate. Align the doc with whatever [Important-1] resolves (either move INTENT-mode `act` to the `browser_compound` row, or footnote that `act` degrades to REF-only when the compressor is absent).

## 5. Verdict

**N — the injected surface is well-routed and framed, but the capability gate is inconsistent with the tool's own runtime dependency.** `act` advertises compressor-backed intent resolution in both its description and the system prompt, yet is gated at the `browser` tier that never verifies a compressor backend exists — so on a compressor-less catalog the INTENT escalation path throws a raw error instead of the clean -32601 its `browser_compound` siblings return ([Important-1]). Single most important fix: gate INTENT-mode `act` behind `browserCompoundToolsEnabled()` (or return a clean isError envelope + soften the description) so the advertised intent-resolution can never silently throw.
