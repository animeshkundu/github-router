# Review: `mcp__peers__artifact_update`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_update` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `artifact_update` |
| Definition | `src/lib/artifact/tools.ts:78` (factory `tool()` at `:31`; registered via `ARTIFACT_TOOLS` spread at `src/lib/peer-mcp-personas.ts:2058`) |
| Always-on? | gated |
| Capability gate | `artifact` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212`) |
| Backing model / endpoint | server-side fn (HTTP `POST /update` to the ai-or-die tab API via `ArtifactClient.update`, `src/lib/artifact/client.ts:199`) |
| Write-capable | yes (replaces the review's on-disk content) |

**Group verification (Critical flag from brief — RESOLVED, no mismatch).** The brief flagged that `ARTIFACT_PANEL_DIRECTIVE` hardcodes `mcp__peers__artifact_*` and asked to confirm the actual group. The tool factory sets `const ARTIFACT_GROUP: McpGroup = "peers"` (`src/lib/artifact/tools.ts:13`) and every artifact tool is built with `group: ARTIFACT_GROUP` (`:39`). So the real group IS `peers`, and the directive's `mcp__peers__artifact_update` path is correct. No mismatch. (Caveat, not a defect: the config key is bare `peers` by default but `resolveGroupKeysFromMirror` can walk to `gh-router-peers`/`-2` on a user collision; the directive text is hardcoded and would NOT reflect that fallback — but `buildPeerAwarenessSnippet` threads `groupKeys` for exactly this reason, and the artifact directive does not. This is a shared trait of all artifact tools, tracked once at the group level, and low-probability since a user rarely owns a `peers` MCP; noting for completeness, not scoring per-tool.)

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/artifact/tools.ts:80`):

> Replace the current Artifact review's content in place. Provide EXACTLY ONE of file (a workspace file path) or html (raw HTML the server writes to the review's sandboxed file). html requires an already-open review. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`objectSchema({...}, [])` at `:81-85` — `required: []`, `additionalProperties: false`):

| Field | Type | Description (verbatim) |
|---|---|---|
| `file` | string | "Workspace-relative or absolute file path to become the review's new content." |
| `html` | string | "Raw HTML to write into the review's existing sandboxed file, then reload." |
| `idempotencyKey` | string | "Optional stable key so a retried update is de-duplicated by the server." |

No field is in the JSON-schema `required` array. The `file` XOR `html` constraint is NOT expressed in the schema; it is enforced only in the handler (`:91`): `if ((file === undefined) === (html === undefined)) throw ArtifactToolInputError("INVALID_ARGUMENT", "artifact_update requires EXACTLY ONE of arguments.file or arguments.html")`. The prose "EXACTLY ONE of" carries the constraint to the model.

### 2b. System prompt (`--append-system-prompt`)

ABSENT. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555`) builds the peer-awareness paragraph injected via `--append-system-prompt`, and it does not name `artifact_update` or any `artifact_*` tool (grep for `artifact` in that function's body returns nothing tool-facing; the only hits are unrelated — the critic "artifact under review" copy and the orchestrate `artifactHash`/`artifact?` fields). The peer group is named in the snippet for the critics, but the artifact tools are deliberately not surfaced there.

This is BY DESIGN: the artifact tools are only useful inside an ai-or-die tab, so their steer is delivered by a separate, tab-gated channel (`ARTIFACT_PANEL_DIRECTIVE`) rather than the always-on peer-awareness snippet. Surfacing them in `buildPeerAwarenessSnippet` would name a tool absent from `tools/list` on every non-tab launch.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **artifact-panel directive** block (`ARTIFACT_MARKER_OPEN`/`_CLOSE`), prepended to the mirrored CLAUDE.md by `prependArtifactPanelDirectiveToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:731`), gated on `AIORDIE_SESSION_ID` at the call site (`src/claude.ts:807-814`). The clause naming this tool (`src/lib/claude-md-injection.ts:53`):

> `artifact_await` returns typed events: `comment` (free-text anchored by selector/text/sourceLine) and `action` (the human clicked a control you emitted). Use `mcp__peers__artifact_update`/`artifact_refresh` to change the shown content and `mcp__peers__artifact_dismiss` to hide the panel while keeping the review alive. `mcp__peers__artifact_poll` is a frozen legacy alias (comments only).

The directive references the tool as `mcp__peers__artifact_update` — group matches code (`peers`, `tools.ts:13`). It describes the tool's ROLE ("change the shown content") but not the `file` XOR `html` mutual-exclusion or the `idempotencyKey` field; that detail lives only in the tool description. The fuller playbook is deferred to the `gh-artifact-review` skill (named at `:58`).

**Checked-in repo CLAUDE.md (project root):** does NOT document the artifact tools. `rg artifact` in `C:\Users\anikundu\Software\github-router\CLAUDE.md` hits only lines 105/161, which are the orchestrate tools' `artifactHash`/`artifact?` fields — unrelated. The artifact panel workflow is documented in the user's private global CLAUDE.md (line 14 "## Review in the artifact panel", which names `mcp__peers__artifact_update` identically) and in the `gh-artifact-review` skill, not in the repo-checked-in project CLAUDE.md. Consistent: no drift, because the repo CLAUDE.md makes no artifact claim to drift from.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. "Replace the current Artifact review's content in place" states the job; "html requires an already-open review" is a real when-NOT-to-call precondition; "Only works inside an ai-or-die tab-backed Claude session" tells the model the environment gate (matching `artifactToolsEnabled()` and the `missingEnvResult()` `NOT_IN_AIORDIE_TAB` envelope at `tools.ts:411`). The XOR is stated in prose ("EXACTLY ONE of file ... or html").
- **Accuracy vs implementation.** Accurate. `file`/`html`/`idempotencyKey` match the handler args (`:89`, `:90`, `:97`) and the client `update` opts (`client.ts:199-204`). The handler's XOR check (`:91`) enforces exactly what the description promises. `idempotencyKey` is optional in both description ("Optional stable key") and schema (not in `required`); when omitted the client mints a `randomUUID()` (`client.ts:205`), so a retried call WITHOUT the key is NOT de-duplicated — the description correctly frames the key as the opt-in for dedup ("so a retried update is de-duplicated"), consistent with that behavior.
- **Schema minimality.** All three inputs are call-tunable and actionable: `file` vs `html` are the two mutually-exclusive content sources; `idempotencyKey` is a model-supplied retry-safety token. No echoed-input or diagnostic-only INPUT fields. Minimal and clean on the input side. (The OUTPUT side spreads `...response` plus `ok: true` plus `next_step`; see 3d.)

### 3b. System-prompt coverage

- **Omitted — by design, not a gap.** Correct call: the tool is tab-gated, and the always-on peer-awareness snippet must not name tab-only tools. The tab-scoped `ARTIFACT_PANEL_DIRECTIVE` is the right channel.
- **Non-redundant.** Since it is absent from the system prompt, there is no redundancy to assess there.
- **Framing-constraint compliance.** N/A for the system prompt (absent). The tool `description` itself uses one imperative ("Provide EXACTLY ONE of ...") — this is a schema-usage instruction, not a behavioral anchor, and is the correct way to convey a hard input constraint that the JSON schema cannot express as a `oneOf`. Acceptable.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted.** The mirrored artifact-panel directive names the tool by its correct `peers` path and describes its role accurately ("change the shown content"). It intentionally omits the XOR / `idempotencyKey` detail, deferring to the tool description and the `gh-artifact-review` skill — appropriate layering, not a gap.
- **Injected block vs checked-in root CLAUDE.md consistency.** Consistent. The repo root CLAUDE.md makes no artifact claim, so there is nothing to contradict; the user's private global CLAUDE.md carries the same directive text with the same `mcp__peers__artifact_update` path.

### 3d. Cross-surface consistency

- description ↔ code: consistent (XOR, args, gate all match).
- description ↔ CLAUDE.md directive: consistent (both use `mcp__peers__artifact_update`; directive is a role summary, description is the full contract).
- CLAUDE.md directive ↔ code group: consistent (`peers`).
- No contradictions found. The only cross-surface note is the OUTPUT-shape spread (below), which is an internal-payload observation, not a contradiction.

## 4. Findings

- **[Suggestion]** `src/lib/artifact/tools.ts:99-104` — the success payload is `ok({ ...response, ok: true, next_step })`, spreading the raw `ArtifactUpdateResponse` (`client.ts:61-64`: `{ ok, viewUrl?, [key: string]: unknown }`) back to the model. `ArtifactUpdateResponse` carries a `[key: string]: unknown` index signature, so whatever the ai-or-die server returns is forwarded verbatim alongside the added `ok: true` and `next_step`. Per the "ruthlessly minimal MCP tool surface" principle (`docs/peer-mcp-design.md`), the model only needs `next_step` (the actionable "call artifact_await" instruction) and arguably a success signal; a passthrough `viewUrl`/`...response` is diagnostic-only unless the model is expected to act on it. Consider projecting to `{ ok: true, next_step }` (drop the `...response` spread) unless a specific returned field is model-actionable. Non-blocking; low context cost in practice since the update response is small. This is a shared trait of the `artifact_update`/`refresh`/`dismiss`/`reply`/`end` success paths, not unique to `update`.

- **[Suggestion]** `src/lib/artifact/tools.ts:81-85` — the `file` XOR `html` constraint is enforced only at runtime (`:91`) and conveyed to the model only in the description prose. JSON Schema can express this as a top-level `oneOf`/`not` so a schema-aware client surfaces the constraint pre-call. The current prose ("EXACTLY ONE of") is adequate for an LLM caller and the runtime `ArtifactToolInputError` is a clean, actionable rejection (`:92-95`), so this is polish, not a correctness gap. Deferring is reasonable given `objectSchema()` is a shared helper with no `oneOf` support today.

No Critical or Important findings. The brief's suspected group mismatch is confirmed NOT to exist (group is genuinely `peers`).

## 5. Verdict

Y. This tool's injected surface is correct, minimal on the input side, consistent across description / mirrored CLAUDE.md / code, and correctly tab-gated with the steer delivered through the right (tab-scoped) channel rather than the always-on snippet. The single most useful (non-blocking) fix: project the success payload to `{ ok: true, next_step }` instead of spreading `...response`, so no diagnostic-only server fields leak into the model's context.
