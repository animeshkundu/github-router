# Review: `mcp__peers__artifact_await`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_await` |
| Group / server | `peers` (serverInfo `github-router-peers`) — set by `ARTIFACT_GROUP: McpGroup = "peers"` at `src/lib/artifact/tools.ts:13`, applied at `:39` |
| Wire tool name | `artifact_await` (`src/lib/artifact/tools.ts:122`) |
| Definition | `src/lib/artifact/tools.ts:121-136` (factory `tool()` at `:31`) |
| Always-on? | gated — invisible unless in an ai-or-die tab |
| Capability gate | `capability: "artifact"` (`tools.ts:40`) → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-218`); filtered at `tools/list` (`src/routes/mcp/handler.ts:343`) AND rejected at `tools/call` (`handler.ts:983-987`) |
| Backing model / endpoint | server-side fn — HTTP GET to `/api/artifact/<sessionId>/await` on the ai-or-die loopback API (`src/lib/artifact/client.ts:252-281`, `:338-340`); no LLM |
| Write-capable | no (read/drain of human feedback; the reply verb is `artifact_reply`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`src/lib/artifact/tools.ts:123`):

> Wait for the human's next Artifact review events (typed drain: comments AND structured action-button/checkbox events) and return them with a cursor. Pass the returned cursor on the next call to receive only newer events. Supersedes artifact_poll. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`tools.ts:124-127`), both fields optional (`required: []`):

- `cursor` (string): "High-water cursor from the previous artifact_await response. Omit on the first call."
- `timeoutMs` (number): "Optional server long-hold budget in ms (default ~25000)."

Output (not in schema, but what the handler returns — `formatAwaitResponse` at `tools.ts:303-314`): `{ events, status, cursor, next_step }`, where `next_step` is action/comment-aware (`awaitNextStep`, `tools.ts:316-332`). Event objects carry a `kind` discriminator: `comment` (`prompt`, `text`, `selector`, optional `sourceLine`), `action` (`action`, optional `value`, `elementId`), `ended`, plus a forward-compat open `{ kind: string; id: string; ... }` (`src/lib/artifact/client.ts:93-119`).

### 2b. System prompt (`--append-system-prompt`)

ABSENT. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) names the critics, `code`, `web`, workers, orchestrate, `stand_in`, and browser tools, but never any `artifact_*` tool and never the `artifact` group. This is by design: the artifact tools are tab-scoped (only useful when `AIORDIE_SESSION_ID` is set), and the peer-awareness snippet is unconditionally appended to the main system prompt regardless of tab context. Steering them from the always-on system prompt would name a surface that is absent in the common (non-tab) case. Coverage is instead delivered by the conditionally-injected ARTIFACT_PANEL_DIRECTIVE (see 2c), gated on the same env at `src/claude.ts:807-811`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **artifact-panel directive** block (`ARTIFACT_PANEL_DIRECTIVE`, `src/lib/claude-md-injection.ts:48-58`), prepended to the mirrored CLAUDE.md only inside an ai-or-die tab (`src/claude.ts:807-811`, gated on `AIORDIE_SESSION_ID`). The clauses naming this tool, verbatim (`claude-md-injection.ts:52-53`):

> ... tell the user to review, then drain their feedback with `mcp__peers__artifact_await` (pass back the returned `cursor` each call), revise, `mcp__peers__artifact_reply`, and `mcp__peers__artifact_end` when done.
> `artifact_await` returns typed events: `comment` (free-text anchored by selector/text/sourceLine) and `action` (the human clicked a control you emitted). ... `mcp__peers__artifact_poll` is a frozen legacy alias (comments only).

Prefix check: the directive hardcodes `mcp__peers__artifact_*`. The code sets the group to `peers` (`tools.ts:13`), so the prefix is CORRECT — no mismatch. The `comment`/`action` event vocabulary in the directive matches the `ArtifactCommentEvent`/`ArtifactActionEvent` `kind`s in `client.ts:93-110`, and "anchored by selector/text/sourceLine" matches the comment event fields (`selector`, `text`, `sourceLine`).

Checked-in repo `CLAUDE.md` (project root): does NOT document the artifact tools at all (grep for `artifact`/`ai-or-die`/`aiordie` hits only unrelated build-"artifacts" prose at line 105 and the orchestrate `attest_step` design bullet). This is consistent — the artifact surface is a per-launch mirror injection, not a checked-in project fact. The user's global CLAUDE.md carries the same directive text (visible in this session's context), matching `ARTIFACT_PANEL_DIRECTIVE` byte-for-byte.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Strong. "Wait for the human's next Artifact review events (typed drain: comments AND structured action-button/checkbox events)" tells the model both WHAT it gets and WHY it differs from the legacy poll. "Supersedes artifact_poll" is an explicit when-NOT-to-use-the-other signal. "Only works inside an ai-or-die tab-backed Claude session" sets the precondition. What the description does NOT convey on its own is the multi-turn loop shape — that `events` may be empty and you re-call with the returned cursor. The `cursor` field description ("Pass the returned cursor on the next call to receive only newer events") plus the description sentence carry the loop, but the "empty drain → call again" case is only surfaced at runtime via `next_step` (`awaitNextStep`, `tools.ts:320-321`), not in the static description. Acceptable: the returned `next_step` is the actionable steer and it is precise.
- **Accuracy vs implementation**: Accurate. The `~25000` default matches `AWAIT_DEFAULT_TIMEOUT_MS = 25_000` (`client.ts:136`). "return them with a cursor" matches `formatAwaitResponse` echoing `response.cursor` (`tools.ts:311`). "typed drain" matches the `ArtifactEvent` union (`client.ts:115-119`). The event vocabulary (comment/action) matches the emitted `kind`s.
- **Schema minimality**: Clean. Both fields (`cursor`, `timeoutMs`) are model-tunable and actionable — `cursor` threads the drain loop, `timeoutMs` tunes the long-hold budget. No echoed-input or diagnostic-only fields. Per the "ruthlessly minimal MCP tool surface" principle this passes. The returned envelope is likewise minimal: `events` (the payload), `cursor` (thread into next call), `status` (loop-termination signal via `ended`), and `next_step` (the actionable steer) — no diagnostic noise forwarded.

### 3b. System-prompt coverage

- **Named or omitted?** Omitted from `buildPeerAwarenessSnippet`, by design (2b). The tab-conditional ARTIFACT_PANEL_DIRECTIVE is the correct injection point, and it IS gated on the same env trio as the tool itself (`src/claude.ts:807`, `mcp-capabilities.ts:212`), so the model is never told to use a tool that isn't served. Not a gap.
- **Framing-constraint compliance**: N/A for the system-prompt snippet (tool is absent there). The directive text in CLAUDE.md is prescriptive by design (it is an operating directive, not a tool `description`), so the persona-description framing constraints pinned by `tests/peer-mcp-personas.test.ts` do not apply to it.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted?** Yes. The directive's description of `artifact_await` (drain feedback, pass back cursor each call, typed comment/action events) matches the handler and client exactly. `artifact_poll` correctly labeled "frozen legacy alias (comments only)", matching its `tools.ts:186-197` description and the frozen `poll()` in `client.ts:324-336`.
- **Injected block vs checked-in root CLAUDE.md consistency**: The root CLAUDE.md is silent on artifact tools (correct — mirror-only surface). No contradiction.

### 3d. Cross-surface consistency

Description ↔ CLAUDE.md ↔ code all agree on: the `peers` group prefix, the cursor pass-back loop, the comment/action typed-event vocabulary, the ~25s default, and the supersedes-poll relationship. The one drift is confined to a code doc-comment, not the model-facing surface (see Findings).

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:736` — the `capability` doc-comment describes the `"artifact"` gate as covering "artifact_open / artifact_poll / artifact_reply", naming the FROZEN legacy `artifact_poll` and omitting the current primary `artifact_await` (and `artifact_update`/`artifact_refresh`/`artifact_dismiss`/`artifact_end`). This is a stale internal comment, not the model surface, so no routing impact. Fix: update the parenthetical to "artifact_open / artifact_await / artifact_reply / ..." or make it non-exhaustive ("the artifact_* review tools").

- **[Suggestion]** `src/lib/artifact/tools.ts:123` (description) — the description does not state that `events` can be empty on a long-hold timeout and that the correct response is to re-call with the same cursor. The runtime `next_step` covers this ("No feedback yet. Call artifact_await again, passing the returned cursor.", `tools.ts:321`), so it is non-blocking, but a first-call model that gets an empty `events` array without reading `next_step` could wrongly conclude the review is over. Optional fix: add a half-sentence ("returns an empty event list on a quiet long-hold; re-call with the cursor").

No Critical or Important findings. The prefix-mismatch risk the brief flagged does not exist: the tool's group is `peers`, matching the directive's hardcoded `mcp__peers__artifact_*`.

## 5. Verdict

Y — the injected surface is correct, minimal, consistent, and well-routed. Group prefix is `peers` on both the code and the directive (no mismatch), the schema is fully actionable, and the tab-conditional CLAUDE.md directive is the right (and correctly env-gated) coverage vehicle given the tool's absence from the always-on system prompt. Single most useful fix: refresh the stale `peer-mcp-personas.ts:736` capability comment to name `artifact_await` instead of the legacy `artifact_poll`.
