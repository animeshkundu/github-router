# Review: `mcp__peers__artifact_open`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_open` (default key; becomes `mcp__gh-router-peers__artifact_open` on a `peers` config-key collision) |
| Group / server | `peers` (serverInfo `github-router-peers`) — assigned via `ARTIFACT_GROUP` |
| Wire tool name | `artifact_open` |
| Definition | `src/lib/artifact/tools.ts:54` (factory `tool()` at `:31`; `ARTIFACT_GROUP = "peers"` at `:13`) |
| Always-on? | gated by capability `artifact` |
| Capability gate | `artifact` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212`) — true iff `AIORDIE_BASE_URL` + `AIORDIE_TOKEN` + `AIORDIE_SESSION_ID` all set |
| Backing model / endpoint | server-side fn (POSTs to ai-or-die `<AIORDIE_BASE_URL>/…/open`; no LLM) |
| Write-capable | no (opens a review panel; does not mutate the workspace) |

**Group-assignment verification (the team lead's headline concern).** `McpGroup` is the 8-value union `peers | search | workers | orchestrate | browser | decide | fleet | first-mate` (`src/lib/peer-mcp-personas.ts:81`); there is no `"artifact"` group, and `GROUP_META` has no artifact entry (`:111-120`). The team lead's premise is correct. But the resolution is not a bug: `ARTIFACT_GROUP` is deliberately set to `"peers"` (`tools.ts:13`), and the tools are spread into the tool array with that `group` field intact (`peer-mcp-personas.ts:2058`, NOT remapped the way `BROWSER_TOOLS` are at `:2076-2080`). The `tools/list` scope filter keeps a tool when `scope === "all"` OR `t.group === scope` (`src/routes/mcp/handler.ts:336`), so artifact tools surface under `POST /mcp/peers` and the union `/mcp`. So the directive's `mcp__peers__artifact_*` prefix is correct **at the default key** — the suspected Critical inverts to a confirmation. The real defect is one level down (see Findings): the directive hardcodes `peers` where the rest of the surface threads a resolved key.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/artifact/tools.ts:56`):

> Open a workspace file in ai-or-die's Artifact review panel for human review. Pass mode:"interactive" when the HTML carries data-aod-* action controls. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`:57-63`), `additionalProperties: false`, required `["file"]`:

- `file` (string, required): "Workspace-relative or absolute file path to show in the Artifact panel."
- `mode` (string enum `["static","interactive"]`, optional): "Advisory. \"interactive\" signals the HTML contains data-aod-* action controls the panel should wire; \"static\" (default) is a read-and-annotate artifact."

Handler returns (on success) `{viewUrl, sessionId, key, next_step}` where `next_step` = "Tell the user to review at the Artifact panel, then call artifact_await to receive their feedback." (`:70-75`). Missing env → `{error:{code:"NOT_IN_AIORDIE_TAB", message}}` with `isError:true` (`:411-419`).

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) does NOT name `artifact_open` or any artifact tool. Its inventory covers only the critics (`mcp__peers__*`), `code`/`web`, workers, orchestrate, `stand_in`, and browser. The artifact tools are non-persona tools spread into `NON_PERSONA_MCP_TOOLS` (`:2058`), and this snippet enumerates a fixed hand-written list, not the full non-persona set — so their omission here is **by design** (they are covered by the separate artifact-panel directive + skill, which only make sense inside an ai-or-die tab). The `peers` group heading is named at `:642` (`Cross-lab peer critics under \`mcp__${peersKey}__*\``), and critically that path uses the RESOLVED `peersKey` (`:568-569`), not a hardcoded literal.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **artifact-panel directive** block (marker fence `ARTIFACT_MARKER_OPEN/CLOSE`, `src/lib/claude-md-injection.ts:36-38`), prepended to the top of the mirrored CLAUDE.md by `prependArtifactPanelDirectiveToMirroredClaudeMd()` (`:731-741`), wired in `src/claude.ts:807-811` **only when `AIORDIE_SESSION_ID` is set**. The directive body (`ARTIFACT_PANEL_DIRECTIVE`, `:48-58`) names this tool verbatim:

> Author a self-contained `.html` (inline CSS, no external deps, readable typography) and open it with `mcp__peers__artifact_open` (pass `mode:"interactive"` if it carries `data-aod-*` action controls); …

The `mcp__peers__` prefix here is a **hardcoded string literal** in the directive constant. It is NOT threaded through `resolveGroupKeysFromMirror`, unlike `buildPeerAwarenessSnippet` (which takes `groupKeys` and resolves `peersKey`). Pinned by `tests/claude-md-injection.test.ts:603` (`expect(d).toContain("mcp__peers__artifact_open")`), so the literal is asserted, not the resolved key.

**Project-root repo `CLAUDE.md`:** no artifact coverage found. The only `panel` hit (`CLAUDE.md:103`) is the Windows keep-awake display panel, unrelated. So this tool's documentation lives entirely in the injected mirror directive, the user's global operating instructions, and the `gh-artifact-review` skill — there is no root-project section to agree or disagree with.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** strong. "Open a workspace file … for human review" plus the hard precondition "Only works inside an ai-or-die tab-backed Claude session" tells the model both when to use it and when it is inert. The `mode:"interactive"` guidance is tied to a concrete trigger (`data-aod-*` controls).
- **Accuracy vs implementation:** accurate. `mode` really is advisory — the client forwards it as metadata and notes "ignored if unknown" (`src/lib/artifact/client.ts:166-167`, forwarded only `if (opts.mode)` at `:178`); the actual interactivity comes from the served HTML markup. `file` is passed verbatim to the server (`client.ts:177`), so "workspace-relative or absolute" describes server-side resolution honestly rather than over-claiming client-side path handling. No stale model id or default (there is no backing model).
- **Schema minimality:** compliant. Two fields, both actionable: `file` is required to call the tool; `mode` is model-tunable and changes panel behavior. No echoed-input or diagnostic-only fields. The success return adds `viewUrl`/`sessionId`/`key` + a `next_step` string; `next_step` is directly actionable (routes the model to `artifact_await`), and the ids are usable by follow-up calls. This stays within the "ruthlessly minimal" bar.

### 3b. System-prompt coverage

- **Omitted, by design.** `buildPeerAwarenessSnippet` intentionally does not enumerate the artifact tools; they are session-conditional and covered by the dedicated directive + skill. Not a gap.
- **Non-redundant & framing-compliant:** the snippet makes no imperative claim about artifact tools (it says nothing), so there is no anchoring or hedge to flag.

### 3c. CLAUDE.md coverage

- **Accurate and current** in content: the directive correctly describes the open → await → reply → end loop, the HTML-by-default posture, and `mode:"interactive"`.
- **One drift from code:** the `mcp__peers__` prefix is hardcoded while the config key is dynamically resolvable. Under the default (no collision) they agree; under a `peers` collision they diverge (Finding [Critical] below).
- **Injected vs root consistency:** consistent — the root project CLAUDE.md is silent, so there is nothing to contradict.

### 3d. Cross-surface consistency

- description ↔ code: consistent.
- system prompt ↔ code: consistent (absent by design; the group path it does emit uses the resolved key).
- CLAUDE.md directive ↔ code: **inconsistent under collision only.** The directive's hardcoded `mcp__peers__artifact_open` diverges from the client-visible `tools/list` name whenever `resolveGroupKeysFromMirror` renames the `peers` server. Every other surface that emits `mcp__peers__*` paths (the awareness snippet) threads the resolved key; the directive is the lone hardcoder.

## 4. Findings

- **[Critical]** `src/lib/claude-md-injection.ts:48-53` (+ wiring `src/claude.ts:807-811`) — the `ARTIFACT_PANEL_DIRECTIVE` hardcodes the model-facing MCP paths `mcp__peers__artifact_open` / `_update` / `_await` / `_reply` / `_end` / `_dismiss` / `_refresh` / `_poll`, but the `peers` config key is not fixed: `resolveGroupKeysFromMirror` (`src/lib/codex-mcp-config.ts:621-633`) renames the router's own server to `gh-router-peers` (then `gh-router-peers-2`, …) whenever a user-side `mcpServers.peers` entry already owns the bare key. On that path the tools are listed as `mcp__gh-router-peers__artifact_open`, so the directive instructs the model to call a tool at a server it does not own.
  - **Repro:** user has `mcpServers.peers` in the canonical/mirrored `~/.claude.json`; launch `github-router claude` inside an ai-or-die tab. `resolveGroupKeysFromMirror` resolves the router's peers group to `gh-router-peers` and threads it into both the `mcpServers` entries and `buildPeerAwarenessSnippet` (so the critics still route correctly). The artifact tools list as `mcp__gh-router-peers__artifact_*`. The prepended directive still says "open it with `mcp__peers__artifact_open`". The model follows the directive, calls `mcp__peers__artifact_open`, which targets the user's own `peers` server (no such tool) → unknown-tool failure; the panel never opens.
  - **Fix:** thread the resolved `peersKey` into the directive the same way `buildPeerAwarenessSnippet` does. Make `prependArtifactPanelDirectiveToMirroredClaudeMd` accept the resolved `peers` key (from the same `resolveGroupKeysFromMirror` result the launcher already computes) and build the `mcp__<peersKey>__artifact_*` paths dynamically, rather than baking `peers` into the constant. Update `tests/claude-md-injection.test.ts:603` to assert the resolved-key path rather than the bare literal.
  - **Severity rationale:** classified Critical per the team lead's stated standard (a model-facing instruction routing to a non-owned/wrong server under a concrete supported collision path). Precondition is low-probability (requires a user-owned `peers` key), but the repo's collision machinery exists precisely to guarantee "a capability is never dropped and the model is never routed at the user's same-named server" (`codex-mcp-config.ts:598-602`) — this directive is the one surface that silently breaks that guarantee, so downgrading would contradict the invariant the surrounding code enforces.

- **[Suggestion]** `src/lib/artifact/tools.ts:56` — the description omits that a successful open replaces any currently-open review for the session (the client method is documented "Open (or replace) the review for this session", `client.ts:165-166`). A one-clause note ("replaces the current review if one is open") would prevent a model from assuming `artifact_open` stacks panels. Non-blocking.

## 5. Verdict

**N.** The `artifact_open` description and schema are accurate, minimal, and well-routed, and the code's `peers`-group assignment is correct (disproving the suspected group-mismatch). But the injected CLAUDE.md directive hardcodes `mcp__peers__artifact_*` while every other surface threads the collision-resolved key, so under a user-owned `peers` config-key collision the model is steered to a non-existent path. Single most important fix: thread the resolved `peers` key into `ARTIFACT_PANEL_DIRECTIVE` instead of hardcoding it.
