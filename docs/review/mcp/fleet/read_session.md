# Review: `mcp__fleet__read_session`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__read_session` |
| Group / server | `fleet` (serverInfo `github-router-fleet`, `src/lib/peer-mcp-personas.ts:118`) |
| Wire tool name | `read_session` (`src/lib/fleet/tools.ts:334`) |
| Definition | `src/lib/fleet/tools.ts:333-348` (factory `tool()` at `:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182-184`): `state.fleetEnabled` (set by `--fleet`) OR `GH_ROUTER_ENABLE_FLEET=1`. No catalog/model/local-dep check. |
| Backing model / endpoint | server-side fn — HTTP `GET /api/control/sessions/{id}/read` on the resolved ai-or-die instance (`src/lib/fleet/client.ts:355-362`). No LLM. |
| Write-capable | no (read-only session-output fetch) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:335`):

> Read recent text output from an addressed fleet session.

Input-schema fields (`src/lib/fleet/tools.ts:336-341`; `required: ["sessionId"]`):

- `sessionId` (string, required): "Global session id in the form instanceId:localSessionId."
- `instance` (string, optional): "Optional instance id/label; when supplied it must agree with sessionId."
- `lines` (number, optional): "Number of recent lines to read."
- `format` (string, optional): "Reserved for future formatting; results are JSON text today."

Schema is closed (`additionalProperties: false`, `objectSchema` at `:1192-1199`).

Output (handler, `src/lib/fleet/tools.ts:342-347`): `ok({ resolvedInstance: publicInstance(instance), ...response, sessionId: globalId })`. `response` is the upstream `ReadSessionResponse` = `{ sessionId, text, truncated, source, status }` (`src/lib/fleet/client.ts:180-186`); the handler overwrites `sessionId` with the caller's global id and adds `resolvedInstance` = `{ id, label }` (`publicInstance`, `:1086-1088`). So the model receives `{ resolvedInstance, text, truncated, source, status, sessionId }`.

### 2b. System prompt (`--append-system-prompt`)

`read_session` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). The snippet's inventory (`para2Parts`, `:595-637`) names only the `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` groups. **The `fleet` group is named nowhere in the snippet** — not the group, not any of its 14 tools. The only model-facing surface for this tool is its `tools/list` `description` (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No injected marker block covers this tool. The mirrored peer-awareness block is the same text as 2b (`buildPeerAwarenessSnippet` output), which omits fleet entirely; the artifact-panel directive, operating-defaults, and toolbelt blocks are unrelated. So the mirrored CLAUDE.md says nothing about `read_session`.

Checked-in root `CLAUDE.md` (project root): no `fleet` / `aiordie` / `ai-or-die` mention (grep returned no matches). The tool is documented only in `docs/aiordie-fleet.md:62-63`, which lists `read_session` in the `mcp__fleet__*` tool inventory. That doc agrees with the code (opt-in gate `--fleet` / `GH_ROUTER_ENABLE_FLEET=1` at `:13`; addressing by global `instanceId:localId` at `:59-61`; implementation pointers at `:72-74` match `fleetToolsEnabled()` and `src/lib/fleet/`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** the one-liner "Read recent text output from an addressed fleet session" is clear on *what* but weak on *when* — there is no when-NOT signal and no relation to sibling tools. In practice the sibling names (`list_sessions`, `session_status`, `await_turn`) disambiguate, and this is a low-stakes read, so a thin description is defensible. The `sessionId` field description ("Global session id in the form instanceId:localSessionId") is the load-bearing routing hint and it is precise.
- **Accuracy vs implementation:** accurate. It reads recent text (`GET .../read`, `src/lib/fleet/client.ts:355-362`), `lines` maps straight through as the recency bound, and the `instance` "must agree with sessionId" constraint is real and enforced (`resolveSession` at `:223-240` throws `INSTANCE_MISMATCH` when the explicit instance disagrees with the decoded one). No stale model id / default / behavior.
- **Schema minimality:** four fields; `sessionId` (required) and `lines` (tunable recency) and `instance` (optional disambiguation / registry-default override) are all justified. `format` is a **dead field**: its own description admits "Reserved for future formatting; results are JSON text today," and the handler never reads it (`src/lib/fleet/tools.ts:342-347` reads only `sessionId`, `lines`, `instance` via `resolveSession`). Per the "ruthlessly minimal MCP tool surface" principle (`docs/peer-mcp-design.md`), a schema field the model can pass but that does nothing spends context and invites a no-op call. This is the one minimality violation.

### 3b. System-prompt coverage

- **Omitted.** Fleet is entirely absent from `buildPeerAwarenessSnippet`. Given the whole `fleet` group is opt-in and off by default, and the snippet is built to name only live-gated surfaces, omitting a rarely-enabled operator surface is a reasonable design choice rather than a defect — the `tools/list` description carries the tool. Acceptability: acceptable for a read-only tool. The gap worth noting is consistency, not this tool specifically: sibling groups that ARE gated (workers, stand_in, browser) get a conditional snippet clause when enabled, but fleet gets none even when `--fleet` is on, so an operator who enables fleet gets zero system-prompt framing for the whole surface. Not `read_session`'s problem to fix alone.
- **Accuracy / non-redundancy / framing compliance:** N/A (not named). No imperative/hedge/anchor to violate.

### 3c. CLAUDE.md coverage

- Mirrored CLAUDE.md: absent (same omission as 2b). Consistent with the system prompt.
- Root CLAUDE.md: absent. `docs/aiordie-fleet.md` is the sole doc and is accurate and non-drifted (verified against `fleetToolsEnabled()`, `resolveSession`, and the client). No contradiction with code.

### 3d. Cross-surface consistency

No contradictions. All surfaces are mutually consistent: the description is the only place the tool is named for the model, the system prompt and CLAUDE.md are silent, and the external doc agrees with the code. The only internal inconsistency is *within* the description: `format` is advertised as an input but is inert.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:340` — the `format` schema field is a no-op: advertised to the model ("Reserved for future formatting; results are JSON text today") but never read by the handler (`:342-347`). It is a diagnostic/placeholder field that costs context and invites a no-op call, violating the ruthlessly-minimal-surface principle. Fix: drop the `format` prop from the schema until the formatting behavior actually ships; reintroduce it in the same PR that implements it.
- **[Suggestion]** `src/lib/fleet/tools.ts:335` — the description gives no when-NOT / sibling-relation signal. Consider one clause distinguishing it from `session_status` (lifecycle/interaction state) and `await_turn` (live event long-poll), e.g. "returns the transcript tail as text; use `session_status` for lifecycle and `await_turn` to watch for new output." Non-blocking — sibling names already carry most of the routing.
- **[Suggestion]** system prompt — the whole `fleet` group (not just `read_session`) is unnamed in `buildPeerAwarenessSnippet` even when `--fleet` is enabled, unlike the other gated groups. If operators are expected to lean on fleet, a single gated inventory sentence (mirroring the workers/stand_in/browser pattern) would raise discoverability. Cross-cutting; track at the group level, not here.

## 5. Verdict

**Y (with one Important fix).** The injected surface is accurate, consistent across all three surfaces, and correctly gated; the read is a thin, honest passthrough. The single blocking-adjacent issue is the inert `format` schema field, which should be removed until it does something. System-prompt omission of the fleet group is an acceptable design choice for an off-by-default operator surface, not a `read_session` defect.
