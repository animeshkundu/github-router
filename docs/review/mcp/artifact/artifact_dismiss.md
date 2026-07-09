# Review: `mcp__peers__artifact_dismiss`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_dismiss` |
| Group / server | `peers` (`ARTIFACT_GROUP` = `"peers"`, `src/lib/artifact/tools.ts:13`) |
| Wire tool name | `artifact_dismiss` (`src/lib/artifact/tools.ts:138`) |
| Definition | `src/lib/artifact/tools.ts:137-151` (factory `tool()` at `:31`) |
| Always-on? | gated by capability `"artifact"` |
| Capability gate | `"artifact"` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-218`) |
| Backing model / endpoint | server-side fn (HTTP POST to the ai-or-die tab API; `ArtifactClient.dismiss` → `POST /dismiss`, `src/lib/artifact/client.ts:235-242`) |
| Write-capable | no (idempotent panel-visibility toggle; no workspace/file write) |

Group prefix cross-check (the brief's Critical flag): the ARTIFACT_PANEL_DIRECTIVE hardcodes `mcp__peers__artifact_*` (`src/lib/claude-md-injection.ts:50,53`). The code registers the artifact tools under `ARTIFACT_GROUP = "peers"` (`src/lib/artifact/tools.ts:13,39`) and spreads `ARTIFACT_TOOLS` into the peers surface (`src/lib/peer-mcp-personas.ts:2058`). **Prefix matches — no mismatch.**

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/artifact/tools.ts:139`):

> Hide the ai-or-die Artifact panel UI while keeping the review alive (queued feedback preserved, channel open, re-openable). Only works inside an ai-or-die tab-backed Claude session.

Input schema (`src/lib/artifact/tools.ts:140`): `objectSchema({}, [])` — no properties, empty `required`, `additionalProperties: false`. **Zero input fields.**

Handler-synthesized output (`src/lib/artifact/tools.ts:141-150`): on success returns `ok({ ...response, ok: true, next_step: "The panel is hidden but the review is still live. Re-open the artifact or call artifact_await when ready." })`; the server response is `ArtifactSimpleResponse` = `{ ok: boolean, [key: string]: unknown }` (`src/lib/artifact/client.ts:67-70`). When the env trio is absent, returns `missingEnvResult()` (`isError: true`, code `NOT_IN_AIORDIE_TAB`, `src/lib/artifact/tools.ts:411-419`).

### 2b. System prompt (`--append-system-prompt`)

**Absent by design.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) names no artifact tool — not `artifact_dismiss`, not the group, nothing. Verified by reading the full function body: paragraph 1 covers the peer critics under `mcp__peers__*`, paragraph 2 covers search/workers/orchestrate/web/stand_in/browser; no artifact clause.

This is correct: `artifactToolsEnabled()` is env-gated (`AIORDIE_*`), not catalog-gated, and the awareness snippet is built without that signal. Artifact coverage is delivered instead through the ARTIFACT_PANEL_DIRECTIVE, which reaches BOTH the mirrored CLAUDE.md and (per the user's global CLAUDE.md) the operating context — see 2c.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **artifact-panel directive** (`ARTIFACT_PANEL_DIRECTIVE`, `src/lib/claude-md-injection.ts:48-58`), prepended to the mirrored CLAUDE.md by `prependArtifactPanelDirectiveToMirroredClaudeMd()` (`:731-741`), fired only when `AIORDIE_SESSION_ID` is set (`src/claude.ts:807-811`) — so the injection condition matches the tool's runtime gate.

Verbatim clause naming this tool (`src/lib/claude-md-injection.ts:53`):

> Use `mcp__peers__artifact_update`/`artifact_refresh` to change the shown content and `mcp__peers__artifact_dismiss` to hide the panel while keeping the review alive.

`artifact_end` is named separately in the happy-path sentence (`:52`): "... `mcp__peers__artifact_reply`, and `mcp__peers__artifact_end` when done." So the directive draws the dismiss-vs-end line implicitly: end = "when done" (close the loop); dismiss = "hide the panel while keeping the review alive."

Checked-in repo `CLAUDE.md` (project root): **does not document the artifact tools at all** — the two "artifact" hits (`CLAUDE.md:105`, `:161`) are unrelated (build-artifact / workflow-artifact prose). Expected: the artifact suite is ai-or-die-tab-scoped tooling, not a core proxy feature, so its documentation lives in the injected directive + the `gh-artifact-review` skill, not the repo CLAUDE.md. No drift, because there is nothing in the repo doc to drift from.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. The description states the effect ("Hide the ... panel UI"), the invariant that makes it distinct ("while keeping the review alive"), and three concrete guarantees ("queued feedback preserved, channel open, re-openable"). A model reading it learns exactly when to reach for dismiss vs end: dismiss when it wants the panel out of the way but intends to come back; end when the review is over. The `next_step` reinforces the re-entry path ("Re-open the artifact or call artifact_await when ready").
- **Accuracy vs implementation.** Accurate. "Keeping the review alive / channel open / re-openable" matches the server contract (`POST /dismiss` returns `ArtifactSimpleResponse`; no teardown, distinct from `end`'s `POST /end`). The env-gate sentence ("Only works inside an ai-or-die tab-backed Claude session") matches `readArtifactEnv()` + `missingEnvResult()` behavior. No model id, default, or version to go stale (server-side fn).
- **Schema minimality.** Optimal — zero input fields (`objectSchema({}, [])`). Nothing echoed, nothing diagnostic. There is no tunable knob a dismiss could accept, and none is offered. Fully compliant with the ruthlessly-minimal principle.

### 3b. System-prompt coverage

- **Omitted — by design, not a gap.** The snippet is built without the `AIORDIE_*` signal, so naming an env-gated tab-only tool there would risk advertising a tool absent from `tools/list` in the common (non-tab) case. Coverage is correctly relocated to the tab-conditional CLAUDE.md directive.
- **Non-redundant.** Since it is absent from the system prompt, there is no duplication to assess against the description.
- **Framing-constraint compliance.** N/A for the system prompt (not named). The CLAUDE.md directive clause is descriptive ("Use ... to hide the panel while keeping the review alive"), not an imperative anchor, and carries no hedges or attribution.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted.** The directive text ("hide the panel while keeping the review alive") is a faithful one-line paraphrase of the tool description and the server semantics. The injection gate (`AIORDIE_SESSION_ID`, `src/claude.ts:807`) matches the tool gate (`artifactToolsEnabled()` checks `AIORDIE_BASE_URL`/`TOKEN`/`SESSION_ID`), so the directive never appears without the tool being live, and vice versa.
- **Injected block vs checked-in root CLAUDE.md.** No conflict: the root repo CLAUDE.md is silent on the artifact suite, so the injected directive is the sole documentation surface. Consistent.

### 3d. Cross-surface consistency

No contradictions. Description ↔ CLAUDE.md directive ↔ code all agree: dismiss hides UI, preserves feedback, keeps the channel open, is re-openable, and is env-gated to an ai-or-die tab. The dismiss-vs-end distinction is coherent across every surface (dismiss = hide-but-alive; end = close-the-loop-when-done). Group prefix `mcp__peers__` is consistent between the directive and the code registration.

## 4. Findings

- **[Suggestion]** `src/lib/artifact/tools.ts:144` — `dismiss()` sends `POST /dismiss` with `TRANSIENT_RETRIES = 2` on `{UNREACHABLE, TIMEOUT}` (default retryable set, `src/lib/artifact/client.ts:141-145`), yet the code comment at `client.ts:140` explicitly groups dismiss with the "single-shot ops (reply/refresh/dismiss) get 0" retry class. The comment says 0 retries for dismiss but the method does not pass a narrowed retry policy, so it inherits the default 2. This is a comment-vs-code mismatch, not a model-facing surface defect (the model can't observe retry count), so it is out of scope for this per-tool surface audit — flagged only as a breadcrumb for the client owner. No action required for the injected surface.

No Critical, Important, or surface-level Suggestion findings. The prefix Critical the brief asked to rule out is confirmed absent (peers matches peers).

## 5. Verdict

**Yes** — the injected surface for `artifact_dismiss` is correct, minimal (zero args), consistent across description / CLAUDE.md / code, and well-routed with a clear dismiss-vs-end distinction. No fix required; the single (out-of-scope) note is a client-layer comment/retry mismatch, not a model-facing issue.
