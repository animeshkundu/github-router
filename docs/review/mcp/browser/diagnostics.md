# Review: `mcp__browser__diagnostics`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__diagnostics` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_diagnostics` |
| Definition | `src/lib/browser-mcp/index.ts:489` |
| Always-on? | gated by `--browse` AND `--power-browse` (capability `browser_power`) |
| Capability gate | `browser_power` → `browserPowerToolsEnabled()` (`src/lib/mcp-capabilities.ts:148`), ANDed with `browserToolsEnabled()` (`:167`) |
| Backing model / endpoint | server-side fn (dispatches to the bridge/extension over a per-call WS; no LLM) |
| Write-capable | no (drains console/network streams read-only; the underlying `browser_console_logs`/`browser_network_log` don't mutate page state) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:490-491`), verbatim:

> Drain console messages or network responses for a tab, with filtering. Replaces the prior browser_console_logs / browser_network_log primitives. `kind` selects the stream; remaining params filter the result before it ships to the model so the response carries only what the caller asked for instead of a raw 1000-entry array dump. Lazy-attach behavior: first call for a tab attaches chrome.debugger; very-early-load events from before the first call are missed.

Input-schema fields (`src/lib/browser-mcp/index.ts:492-517`):

- `tabId` (number, required) — no field `description`.
- `kind` (string, required, enum `["console","network"]`) — "Which stream to drain."
- `level` (string, enum `["log","info","warn","error","debug","all"]`) — "Console only. Default 'all'. Ignored when kind=network."
- `regex` (string) — "Optional JS-regex string. Console: matches the message body. Network: matches the request URL."
- `limit` (number) — "Max entries to return after filtering. Default 100. Hard cap 1000."

`additionalProperties: false`; `required: ["tabId", "kind"]`.

### 2b. System prompt (`--append-system-prompt`)

`diagnostics` is named ONLY in power mode. In `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:631-632`) the `powerNote` — appended to the browser sentence only when `opts.powerBrowseAvailable` — reads, verbatim:

> Power mode adds the L0/L1 primitives (`mcp__${browserKey}__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

When power mode is off (`powerNote = ""`, `:633`), the browser sentence names only the six lead tools (`__act`, `__observe`, `__extract`, `__navigate`, `__open_tab`, `__screenshot`) and `__diagnostics` is not mentioned at all. This matches the gate: with `--browse` but no `--power-browse`, `browser_diagnostics` is filtered out of `tools/list`, so the snippet correctly does not name it.

The snippet gives `__diagnostics` no per-tool routing sentence of its own — it appears only inside the flat parenthetical list of power primitives. There is no imperative or when-to-use guidance in the system prompt; that lives entirely in the description (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The covering injected block is **peer-awareness** — the mirrored CLAUDE.md carries the same `buildPeerAwarenessSnippet` text as 2b, so `__diagnostics` is named there only in power mode, inside the same L0/L1 parenthetical.

Checked-in repo root `CLAUDE.md` "Browser-control MCP (`--browse`)" section (`CLAUDE.md:147`) lists `diagnostics` in the flat 19-tool MCP-facing name list ("... `wait / eval_js / download / mouse / drag / type / diagnostics / find / act / observe / extract`"). It does not, in that sentence, flag `diagnostics` as power-gated — the power/lead split is documented separately in `docs/browser-mcp-design.md:371` (the `browser_power` capability-tag row lists "... type, diagnostics, find"). `docs/browser-mcp-design.md:101` names it in the tool table ("`diagnostics` | `browser_diagnostics` | Combined diagnostics log (network/console).") and `:292` documents the merge ("`browser_console_logs`, `browser_network_log` → merged into `browser_diagnostics(kind, level?, regex?, limit?)`. One MCP tool, filtered response, lower context cost than the prior 1000-entry raw dumps."). All agree with the code.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Good. The description states what it drains (console messages / network responses per tab), how to select the stream (`kind`), and that filter params shrink the response. It gives a positive "when to use" (surface console/network diagnostics for a tab) and a subtle "when NOT" via the lazy-attach caveat (very-early-load events before the first call are missed) — which correctly warns the model not to trust it for pre-attach page-load traffic. It names the merged predecessors so a model primed on the old names re-routes here.
- **Accuracy vs implementation.** Verified against the handler (`src/lib/browser-mcp/index.ts:519-557`):
  - `kind` routes to `browser_network_log` vs `browser_console_logs` (`:520-521`) — matches.
  - `level` is forwarded to the underlying tool for both kinds (`:523`, `:526` passes `{ tabId, level }`), but the description and schema both say "Console only ... Ignored when kind=network." The forward is harmless (network handler ignores `level`), and the model-facing contract (ignored for network) is honest.
  - `regex` filters `text` for console, `url` for network (`:546`, `field` selection) — matches the description exactly.
  - `limit` default 100, hard cap 1000, applied after filtering (`:525` clamps to `[1,1000]`, `:555` slices) — matches "Max entries to return after filtering. Default 100. Hard cap 1000."
  - The response envelope is `{kind, total, returned, entries}` (`:556`), where `total` is the pre-filter entry count and `returned` is post-filter/limit — not described, but these are lightweight and actionable (tell the model whether the filter/limit hid entries, so it can widen `limit` or loosen `regex`). No stale model id / default / gate.
- **Schema minimality (per "ruthlessly minimal MCP tool surface").** All five fields earn their place: `tabId` + `kind` are required to call; `level`, `regex`, `limit` are model-tunable filters that materially change the response. No echoed-input or diagnostic-only fields in the schema. One minor gap: `tabId` has no field `description` (it's the only required field lacking one) — the other browser tools also leave `tabId` undescribed, so this is a consistent house style, not a defect. No minimality violation.
- **Actionability of the diagnostic OUTPUT (bridge-miss path).** This is the load-bearing question for a diagnostic-style tool, and it passes. `browser_diagnostics` delegates to `dispatchBrowserTool` (`:526`), which runs `ensureBridgeReady()` first and, on a bridge/extension miss, returns `installRequiredToolResult(ready)` (`src/lib/browser-mcp/dispatch.ts:394-397`). That envelope is a structured `install_required` JSON block (`isError: true`) carrying `manual_steps.load_unpacked_dir`, `expected_extension_id`, optional store URLs, `proxy_version`, and free-text `instructions` telling the model exactly how to load/reload the extension and retry (`src/lib/browser-mcp/install-check.ts:53-83`, `:277-291`). So on the one failure mode where a diagnostic tool would otherwise dead-end, the output tells the model what to do next. Its own error paths are also actionable: `invalid regex: <pattern>` (`:552`) and a passthrough of the underlying bridge error (`:527`, returns `env` when `isError`).

### 3b. System-prompt coverage

- **Named or omitted?** Named, but only in power mode, and only inside the L0/L1 parenthetical (`peer-mcp-personas.ts:632`). By design: the tool is `browser_power`-gated, so naming it only when `powerBrowseAvailable` keeps the snippet from advertising a tool absent from `tools/list`. Correct.
- **Accurate & non-redundant.** The snippet says nothing about diagnostics beyond grouping it under "direct DOM / coordinate control" primitives — arguably a loose fit (draining console/network logs is neither DOM manipulation nor coordinate control), but it is not wrong, and the per-tool contract lives in the description, so the snippet stays non-redundant. No when-to-use detail is duplicated.
- **Framing-constraint compliance.** Compliant. The `powerNote` is a flat descriptive list with no imperative ("Lead with X"), no hedge, and no anchor disguised as description. It merely enumerates which tools power mode adds. Consistent with the framing constraint pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted.** The mirrored peer-awareness block is identical to 2b (same generator), so it inherits the same power-mode gating and is accurate. The checked-in root `CLAUDE.md:147` lists `diagnostics` in the MCP-facing name list and agrees with the code; the power/lead split is documented in `docs/browser-mcp-design.md:371` rather than restated at `:147`, which is a reasonable separation, not drift.
- **Injected block vs checked-in root consistency.** Consistent. The injected snippet (power-gated mention) and the root doc (flat list + separate power-tier table) describe the same surface at different altitudes and do not contradict each other.

### 3d. Cross-surface consistency

No contradictions found. Description ↔ system prompt ↔ CLAUDE.md ↔ code all agree that `browser_diagnostics` is a power-gated, read-only console/network drain with `kind`/`level`/`regex`/`limit` filtering and a default limit of 100 / hard cap 1000. The power-mode gating in the snippet matches the `browserPowerToolsEnabled()` gate and the design-doc capability table.

## 4. Findings

Ranked, most severe first.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:490-491` — the description does not document the response envelope fields (`total` vs `returned`), so a model that gets `returned: 100` can't immediately tell it hit the `limit` cap vs the true tail. Minor, because the field names are self-evident and the model can re-issue with a higher `limit`. Fix (optional): one clause — "Response reports `total` (pre-filter count) and `returned` (post-filter/limit); if `returned` equals `limit`, raise `limit` to see the tail." Only worth it if context budget allows; otherwise leave as-is.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:632` — `__diagnostics` is filed under "direct DOM / coordinate control" in the power-note, which is a loose category label for a console/network-log drain (it's observability, not DOM/coordinate manipulation). Non-blocking: the description carries the real contract and the mislabel can't misroute a call. Fix (optional): the note could say "direct DOM / coordinate control and page diagnostics" — but this lengthens the always-loaded snippet, so leaving it is defensible.

No Critical or Important findings. No case where the description tells the model to do something the code rejects; the bridge-miss output is actionable; the schema is minimal; the gate is consistent across all surfaces.

## 5. Verdict

Y — the injected surface for `mcp__browser__diagnostics` is correct, minimal, consistent, and well-routed: a read-only console/network drain, power-gated on all three surfaces in agreement with the code, with an actionable `install_required` output on the one bridge-miss failure mode. Single most useful (optional) fix: document `total`/`returned` in the description so the model can tell a `limit`-truncated result from the true tail.
