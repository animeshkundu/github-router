# Review: `mcp__browser__download`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__browser__download` |
| Group / server | `browser` (serverInfo `github-router-browser`) |
| Wire tool name | `browser_download` |
| Definition | `src/lib/browser-mcp/index.ts:335` |
| Always-on? | gated — off by default; needs `--browse` AND `--power-browse` |
| Capability gate | `browser_power` → `browserToolsEnabled() && browserPowerToolsEnabled()` (`src/routes/mcp/handler.ts:351`) |
| Backing model / endpoint | server-side fn — dispatches to the MV3 extension over the native-messaging bridge (`toolDownload`, `src/browser-ext/background.js:1622`) |
| Write-capable | yes — writes a file to disk (Chrome's Downloads dir) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/browser-mcp/index.ts:336-337`):

> Trigger a download by URL and wait for it to complete. Returns {downloadId, path, bytes, mimeType}. The file lands in Chrome's default Downloads dir unless saveAs is given.

Input schema (`src/lib/browser-mcp/index.ts:338-354`), `required: ["tabId", "url"]`, `additionalProperties: false`:

- `tabId` (number): "Tab id is logged but the download itself is window-scoped, not tab-scoped."
- `source` (string, enum `["url"]`): "Download source. Only 'url' supported in v1; click-then-wait awaits Phase 5."
- `url` (string): "Direct URL to download. Max 8 KB."
- `saveAs` (string): "Optional filename / relative subdir under Downloads. Conflicts auto-uniquify."

### 2b. System prompt (`--append-system-prompt`)

`browser_download` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-637`).

The browser paragraph (`peer-mcp-personas.ts:634-635`) names only the six lead-surface tools verbatim:

> `mcp__browser__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` for any click / fill / type / scroll-to (an inner fast model resolves intent), `__observe(intent?)` for a 2-4 sentence natural-language page description, `__extract(schema, instruction)` for typed extraction, `__navigate` / `__open_tab` / `__screenshot` for state and visuals. The lead never sees raw DOM: refs and bboxes stay internal.

The `powerNote` (`peer-mcp-personas.ts:631-632`), appended only when `powerBrowseAvailable`, names the power primitives but **omits `download`**:

> Power mode adds the L0/L1 primitives (`mcp__browser__mouse`, `__drag`, `__type`, `__keyboard`, `__scroll`, `__eval_js`, `__read_page`, `__diagnostics`, `__find`) for direct DOM / coordinate control.

So the group `mcp__browser__*` is named, but this specific tool is surfaced ONLY through its `tools/list` description. Not a persona, so there is no subagent system prompt.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness block** (same text as 2b — the mirrored CLAUDE.md carries the `buildPeerAwarenessSnippet` output). Same omission: the group is named, `download` is not, and it is absent from the `powerNote` primitive list.

Checked-in root `CLAUDE.md` "Browser-control MCP (`--browse`)" (`CLAUDE.md:145-147`) DOES name it in the full MCP-facing list:

> MCP-facing tool names (prefix dropped): `list_tabs / open_tab / close_tab / navigate / read_page / scroll / screenshot / keyboard / wait / eval_js / download / mouse / drag / type / diagnostics / find / act / observe / extract`.

`docs/browser-mcp-design.md:93` documents the row: "Trigger a download by URL and wait for completion." and `:371` lists `download` under the `browser_power` gate — both agree with the code. The root CLAUDE.md says "19 browser-control tools" (`CLAUDE.md:147`); the list it enumerates has 19 entries, consistent.

## 3. Assessment

### 3a. Description quality

- **Clarity / routing**: good. "Trigger a download by URL and wait for it to complete" is unambiguous, the return shape is stated, and the destination (Chrome Downloads dir) is disclosed — a rare and welcome instance of a disk-write side effect being named in the description. `source` enum + "click-then-wait awaits Phase 5" correctly steers the model away from an unsupported mode. No explicit when-NOT-to-use, but the single-purpose framing makes misroute unlikely.
- **Accuracy vs implementation**: mostly accurate. The handler (`background.js:1622-1664`) does `chrome.downloads.download({url, filename: saveAs, conflictAction: "uniquify"})`, waits for terminal state, then returns `{downloadId, path, bytes, mimeType}` from `chrome.downloads.search`. Two accuracy gaps: (1) the description implies success always, but on a non-`complete` terminal state the handler THROWS `browser_download: download <state>` (`background.js:1654-1655`) — the model isn't told the failure shape; (2) the internal completion wait is hardcoded to `60_000` ms (`background.js:1649-1652`) while the dispatcher advertises `maxMs: 300_000` for this tool (`src/lib/browser-mcp/dispatch.ts:169`) — a download legitimately taking 60-300s is killed by the extension with a `timeout` throw even though the wire budget would allow it. See findings.
- **Schema minimality**: 4 fields, all defensible. `url`/`tabId` required. `saveAs` is model-tunable and actionable. `source` is a single-value enum (`["url"]`) whose only current job is to reject anything else with a clear message — arguably it costs a field for no branching value today (the tool only supports one source), but it documents the Phase-5 roadmap and future-proofs the shape; borderline, lean keep. `tabId` is marked required yet the description itself says the download is "window-scoped, not tab-scoped" and the tabId is only "logged" — it's a near-echoed/diagnostic input the handler never uses for routing. Minor minimality smell.

### 3b. System-prompt coverage

- **Omitted.** By the snippet's own construction this is defensible: the browser paragraph deliberately names only the lead surface, and the `powerNote` enumerates the DOM/coordinate primitives. `download` is neither a lead-surface intent tool nor a DOM-manipulation primitive, so it falls between the two buckets and gets no name. The model still discovers it via `tools/list`.
- **Coverage gap**: `download` is the one power tool that performs a filesystem write, yet the `powerNote` — which claims to add "the L0/L1 primitives" — silently drops it. A reader of the snippet who never scans the full tools/list would not know a browser-driven disk-write capability exists in power mode. This is the coverage finding the brief asked me to investigate: real, low severity (the tool is still listed and callable), best fixed by appending `__download` to the `powerNote` list.
- **Framing compliance**: N/A for the tool itself (unnamed). The surrounding snippet is descriptive, no imperatives/anchors.

### 3c. CLAUDE.md coverage

- Root CLAUDE.md and `docs/browser-mcp-design.md` both name and correctly gate `download` (`browser_power`), agree with the code, and the 19-tool count matches. No drift.
- The mirrored (injected) CLAUDE.md inherits the same system-prompt omission as 3b — consistent with the snippet, inconsistent with the checked-in root doc which DOES list it. That divergence is inherent to the two docs having different jobs (root = complete inventory, injected = routing hints), not a defect.

### 3d. Cross-surface consistency

- Description ↔ code: the two accuracy gaps in 3a (60s vs 300s wait, undisclosed throw-on-failure).
- System prompt ↔ description: the tool is in the description surface but absent from both the lead-surface and power-note enumerations. Not a contradiction, a gap.
- CLAUDE.md (root) ↔ code: consistent.

## 4. Findings

- **[Important]** `src/browser-ext/background.js:1649-1652` — the internal completion wait is hardcoded `60_000` ms, but `src/lib/browser-mcp/dispatch.ts:169` advertises `browser_download: { defaultMs: 60_000, maxMs: 300_000 }`. A download that terminates between 60s and 300s is aborted by the extension with `browser_download: download timeout` even though the wire/dispatcher budget still had up to 5 minutes left, and the description ("wait for it to complete") gives no hint of a 60s internal ceiling. Repro: `browser_download` a large asset on a slow link that finishes at ~90s → the tool throws `timeout` at 60s while the file continues downloading in Chrome. Fix: derive the extension's timeout from the per-call/dispatcher budget (thread `timeoutMs` through to `toolDownload`) instead of the hardcoded `60_000`, so the internal wait matches the advertised `maxMs`.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:336-337` — description implies success-only; on `interrupted`/`timeout` the handler throws `browser_download: download <state>` (`background.js:1654-1655`). Add one clause on the failure shape (e.g. "errors if the download is interrupted or does not complete in time") so the model can plan a retry.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:631-632` — the `powerNote` enumerates the power primitives but omits `download`, the only power tool with a filesystem-write side effect. A model relying on the snippet (not the full tools/list) won't know browser-driven disk writes exist in power mode. Fix: append `` `__download` `` to the `powerNote` list (and note it writes to the Downloads dir), keeping the enumeration honest to the `browser_power` gate.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:343` — `tabId` is `required` but per its own description is "logged but the download itself is window-scoped, not tab-scoped"; the handler (`background.js:1622-1664`) never reads it for routing. It's a near-diagnostic input. Consider making it optional or dropping it to keep the surface minimal, unless the bridge relies on it for slot/attach bookkeeping.

- **[Suggestion]** `src/lib/browser-mcp/index.ts:352` — `saveAs` is described as a "relative subdir under Downloads" with no note on path-traversal handling. In practice `chrome.downloads.download` rejects absolute paths and `..` segments at the browser layer, so there's no proxy-side traversal exposure; a one-line note that the browser enforces relative-only would remove the ambiguity for the reader. Non-blocking (mitigation is real, just undocumented).

## 5. Verdict

N (for the injected surface as a whole): the description is clear and honestly discloses the disk-write destination, but two facts drift from code — the 60s internal wait undercuts the advertised 300s `maxMs`, and failure is a throw the description hides — and the tool is the sole filesystem-write power primitive absent from the system-prompt `powerNote`. Single most important fix: make the extension's download-completion timeout track the dispatcher's `maxMs` (300s) instead of the hardcoded 60s (`background.js:1649` vs `dispatch.ts:169`).
