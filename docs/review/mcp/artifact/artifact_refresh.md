# Review: `mcp__peers__artifact_refresh`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_refresh` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `artifact_refresh` |
| Definition | `src/lib/artifact/tools.ts:106` (factory `tool()` at :31) |
| Always-on? | gated by capability `artifact` |
| Capability gate | `artifact` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212`) |
| Backing model / endpoint | server-side fn → `ArtifactClient.refresh()` → `POST /api/artifact/<sessionId>/refresh` (`src/lib/artifact/client.ts:225`) |
| Write-capable | no (forces a panel reload; does not change artifact content) |

Group confirmation (the team-lead's flagged concern): the tool factory hard-sets `group: ARTIFACT_GROUP` where `const ARTIFACT_GROUP: McpGroup = "peers"` (`tools.ts:13`, `:39`). `tools/list` emits the name verbatim as `name: t.toolNameHttp` with no prefix strip (`handler.ts:356`), unlike browser tools. So the live MCP path is `mcp__peers__artifact_refresh`, and the directive's hardcoded `mcp__peers__artifact_*` (`claude-md-injection.ts:51`) MATCHES the code. No prefix mismatch. (The skill `artifact-review-skill.ts:44` and the pin `tests/injected-skills.test.ts:65` also use `mcp__peers__artifact_refresh`, consistent.)

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`tools.ts:108`):

> Force the ai-or-die Artifact panel to reload the current artifact from disk (no content change). Only works inside an ai-or-die tab-backed Claude session.

Input schema (`tools.ts:109`): `objectSchema({}, [])` → `{ type: "object", required: [], additionalProperties: false, properties: {} }`. No input fields.

Handler (`tools.ts:110-119`): reads the env trio; on absence returns `missingEnvResult()` (`NOT_IN_AIORDIE_TAB`, `isError: true`); otherwise calls `client.refresh(signal)` and returns `{ ...response, ok: true, next_step: "The panel reloaded the artifact. Call artifact_await for feedback." }`.

### 2b. System prompt (`--append-system-prompt`)

ABSENT. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) names only the critics, `advisor`, `peer-review-coordinator`, the search/worker/orchestrate/decide/browser tools, and the subagent-inheritance fact. It does not name any `artifact_*` tool, nor the artifact group. A repo-wide grep of the snippet's body confirms no `artifact` mention. This is BY DESIGN: the artifact surface is covered by its own dedicated injected block (the artifact-panel directive, 2c) rather than the peer-awareness snippet, and that directive is gated on the ai-or-die env trio at the caller — so it appears only inside a tab where the tools are live, whereas the peer-awareness snippet ships unconditionally.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **artifact-panel directive** (`ARTIFACT_PANEL_DIRECTIVE`, `src/lib/claude-md-injection.ts:48-58`), injected at the top of the mirrored CLAUDE.md by `prependArtifactPanelDirectiveToMirroredClaudeMd` (`:731`) under its own marker fence (`:36-38`). The clause naming `artifact_refresh` (`:53`):

> `artifact_await` returns typed events: `comment` (free-text anchored by selector/text/sourceLine) and `action` (the human clicked a control you emitted). Use `mcp__peers__artifact_update`/`artifact_refresh` to change the shown content and `mcp__peers__artifact_dismiss` to hide the panel while keeping the review alive. `mcp__peers__artifact_poll` is a frozen legacy alias (comments only).

Root repo `CLAUDE.md` (the user's private global instructions, "Review in the artifact panel" section) carries the same sentence verbatim. The `gh-artifact-review` skill (`src/lib/injected-skills/artifact-review-skill.ts:44`) also mentions it:

> Optionally `mcp__peers__artifact_update({file})` or `({html})` to replace the artifact content in place, or `mcp__peers__artifact_refresh` to reload it from disk.

The skill's framing ("reload it from disk") is precise. The directive's framing ("Use `.../artifact_update`/`artifact_refresh` to **change the shown content**") lumps refresh under "change the shown content", which is imprecise for refresh (see 3c/Findings).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong and self-contained. "Force the panel to reload the current artifact from disk (no content change)" states both the effect and the crucial non-effect. The refresh-vs-update distinction is clear AT THE DESCRIPTION LEVEL: refresh = reload from disk (content unchanged); update (`tools.ts:80`) = replace content in place. A model reading both descriptions can route correctly — refresh is for when the file changed on disk out-of-band and you want the panel to pick it up without re-supplying content. The "Only works inside an ai-or-die tab-backed Claude session" tail is the shared when-not signal across the whole family and matches the gate.
- **Accuracy vs implementation.** Accurate. The handler does exactly one `POST /refresh` (`client.ts:225`, verified by `tests/artifact/tools.test.ts:473-484`), no content mutation. `refresh()` is single-shot (0 retries) per `client.ts:141`/`:225`, consistent with "force a reload" being cheap and idempotent — the description does not over-promise retry behavior.
- **Schema minimality.** Optimal. Empty schema (`objectSchema({}, [])`) — no args to tune, none echoed, none diagnostic-only. Fully compliant with the "ruthlessly minimal MCP tool surface" principle. The response adds only `ok` + `next_step` (an actionable pointer to `artifact_await`), no diagnostic noise.

### 3b. System-prompt coverage

- **Omitted — by design, not a gap.** The peer-awareness snippet is the wrong carrier: it is injected unconditionally, but the artifact tools are live only inside an ai-or-die tab. Putting artifact guidance there would name a surface that is absent from `tools/list` on the vast majority of launches. The tab-gated artifact-panel directive is the correct, non-redundant home. No action needed.
- **Framing-constraint compliance** (of the directive that does cover it): the directive uses imperative "Use ... to change the shown content", which is the artifact-panel directive's own register (a soft steer), NOT the peer-awareness snippet whose no-imperatives pins (`tests/peer-mcp-personas.test.ts`) apply. Since `artifact_refresh` is absent from the pinned snippet, those constraints do not bind it. No violation.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted.** The directive and skill both name the live path `mcp__peers__artifact_refresh` and pair it correctly with `artifact_update`. Consistent with code.
- **One imprecision.** The directive (`claude-md-injection.ts:53`) says "Use `mcp__peers__artifact_update`/`artifact_refresh` to **change the shown content**". For `artifact_update` that is exactly right; for `artifact_refresh` it is loose — refresh explicitly makes NO content change (it re-reads the same on-disk file), whereas update replaces content. The `code` description itself and the skill both draw the distinction cleanly ("no content change" / "reload it from disk"), so a model has the correct signal from those two surfaces; the directive's shared verb is the only place the two verbs are conflated. Low-impact (the model still learns the right behavior from the tool description), but it slightly dulls the update-vs-refresh routing signal.

### 3d. Cross-surface consistency

- Group/path: consistent across code (`peers`), directive, skill, and test pin — no mismatch.
- Behavior: description ("no content change"), client (`POST /refresh`, single-shot), and test all agree.
- The only cross-surface friction is the directive's "change the shown content" verb grouping refresh with update (3c). Description ↔ skill ↔ client are internally consistent and precise.

## 4. Findings

- **[Suggestion]** `src/lib/claude-md-injection.ts:53` — the directive groups `artifact_refresh` under "Use ... to **change the shown content**", but refresh is a no-content-change reload; only `artifact_update` changes content. Split the verbs so the routing signal stays sharp, e.g. "Use `mcp__peers__artifact_update` to replace the shown content and `mcp__peers__artifact_refresh` to reload the current file from disk after an out-of-band edit; `mcp__peers__artifact_dismiss` hides the panel while keeping the review alive." This mirrors the (correct) `gh-artifact-review` skill wording at `artifact-review-skill.ts:44`. Non-blocking: the tool's own `description` already carries the precise distinction.

No Critical or Important findings. The flagged prefix/group concern is a false alarm — the directive's `mcp__peers__artifact_*` matches the code's `group: "peers"` and verbatim wire name.

## 5. Verdict

Y — the injected surface is correct, minimal (empty schema), consistently routed as `mcp__peers__artifact_refresh`, and the refresh-vs-update distinction is clear in the tool description and skill. Single most important (non-blocking) fix: split the shared "change the shown content" verb in the CLAUDE.md directive so refresh reads as a disk-reload, not a content change.
