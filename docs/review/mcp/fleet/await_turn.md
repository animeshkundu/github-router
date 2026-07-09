# Review: `mcp__fleet__await_turn`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__await_turn` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `await_turn` |
| Definition | `src/lib/fleet/tools.ts:608` (factory `tool()` at `tools.ts:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`): `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"`; `state.fleetEnabled` set from the `--fleet` arg at `src/lib/server-setup.ts:356`. List-time drop + call-time -32601 at `src/routes/mcp/handler.ts:341` and `:963`. |
| Backing model / endpoint | server-side fn (no LLM); fans `waitEvents` (HTTP long-poll) out to each resolved fleet instance via `FleetClient` |
| Write-capable | no (read-only: long-polls session events, mutates only the module-level per-watcher cursor map) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:609-610`):

> Long-poll session events across fleet instances. The server owns per-target opaque cursors, so callers do not pass cursor tokens. Distinct concurrent watchers over the same instance set should pass a distinct watcherId so they do not share a cursor.

Input schema (`tools.ts:611-617`, all fields optional — `required: []`):

- `instances` (array of string) — "Instance ids or labels to poll. Omit with sessionIds to target those session instances; omit both to poll every registered instance."
- `sessionIds` (array of string) — "Global session ids to filter to."
- `timeoutMs` (number) — "Long-poll timeout per instance in milliseconds."
- `kinds` (array of string) — "Optional event kinds to filter to."
- `watcherId` (string) — "Optional stable id for this watcher. Use a distinct value for concurrent watchers over the same target set to keep cursors isolated."

Output (not schema-declared, assembled at `tools.ts:678-689`): `resolvedInstances[]` (each `{id,label}` via `publicInstance`), merged `events[]` (each stamped with `{instance,sessionId}` and time-sorted), `gaps[]` (each `{instance,...gap}`), optional `settled[]` (per-session `{sessionId,status,reliable}` from `classifyTurnEvents`, present only when non-empty), `cursors[]` (`{instance,cursor}` per reachable instance), `more` (boolean, true if any instance has more), optional `errors[]` (`{instance,error,hint?}`, present only when non-empty).

### 2b. System prompt (`--append-system-prompt`)

**Not named.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) emits clauses only for the `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` groups (`para2Parts`, `:595-637`). There is no `fleet` branch and no `mcp__fleet__*` path anywhere in the snippet — neither the tool nor the group is named. The only model-facing surface for this tool is its `tools/list` `description`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

**No covering block.** The mirrored CLAUDE.md carries the same peer-awareness text as 2b (which omits fleet), so no injected marker block covers `await_turn`. The checked-in repo root `CLAUDE.md` also has zero fleet/`await_turn`/ai-or-die mentions (grep clean). Fleet is documented only in standalone design docs (`docs/aiordie-fleet.md`, `docs/fleet-control-plane-contract.md`, `docs/first-mate-design.md`), which Opus does not receive at runtime. `docs/aiordie-fleet.md:62-65` describes `await_turn` as "server-managed per-client cursor; epoch/gap-safe; merges events across instances" — consistent with the code (`awaitTurnCursors` keyed by `watcherId` at `tools.ts:979`, `compareStampedEvents` epoch-ms sort at `:961`, cross-instance flat-merge at `:667`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The one-line description states the job (long-poll session events across instances) and two operational facts (server owns cursors; distinct watchers need distinct `watcherId`). It is accurate but thin on *routing*: it gives no "when to use / when NOT to use" signal, and — because fleet is absent from the system prompt (2b) — this description is the *sole* place Opus can learn the tool exists and how it relates to its siblings. The critical routing relationship (send with `awaitMs:0` then `await_turn` to observe real completion; `drive_task` composes both) is stated in `send_message` (`tools.ts:364`) and `drive_task` (`:694`) but not echoed here, so a model reading `await_turn` in isolation does not learn it is the completion-observation half of that pattern.
- **Accuracy vs implementation.** Description claims verified true: server-owned opaque cursors (callers never pass a cursor token — `cursor` is not a schema field; the handler reads/writes `cursorByInstance` internally at `tools.ts:622,649`); `watcherId` isolates cursors (`awaitTurnCursorKey` keys on `watcherId` ALONE, `tools.ts:973-982`). No stale model id, default, or behavior. `timeoutMs` default (30s) lives in `AWAIT_TURN_DEFAULT_TIMEOUT_MS` (`tools.ts:43`) but is not surfaced in the field description (minor — see 4).
- **Schema minimality.** All five fields are optional and each is either model-tunable or a documented targeting selector: `instances`/`sessionIds` are the target selectors (with an explicit omit-both = poll-all semantics), `timeoutMs` tunes the long-poll window, `kinds` filters events, `watcherId` isolates concurrent-watcher cursors. No echoed-input or diagnostic-only field. Output is likewise lean: `events`/`gaps`/`cursors`/`more` are the raw long-poll payload the model needs to continue, `settled` is an actionable reliability-classified completion signal, and `errors`/`settled` are omitted when empty (`:682,688`) so absent state costs no context. `resolvedInstances` and per-item `instance` stamps are load-bearing (they disambiguate which instance an event/gap/cursor came from in a merged multi-instance result) rather than echoed input. Minimal.

### 3b. System-prompt coverage

- **Omitted — consistent with the group.** No fleet tool is named in `buildPeerAwarenessSnippet`; the whole `fleet` group is absent, not just `await_turn`. This is defensible: fleet is an opt-in operator surface (`--fleet`), off by default, and the peer-awareness snippet is emitted unconditionally regardless of the fleet gate (`buildPeerAwarenessSnippet` takes no `fleetAvailable` flag, `personas.ts:555-567`), so a fleet clause would name tools missing from `tools/list` on the common (no-`--fleet`) path — the snippet's own stated invariant is "never names a tool missing from the live tools/list" (`:592-594`). Adding a *gated* fleet clause would be the consistent way to surface it when enabled; leaving it description-only is acceptable but see 4.
- **Accuracy & non-redundancy.** N/A (absent).
- **Framing-constraint compliance.** N/A (absent) — no imperative/anchor risk since there is no clause.

### 3c. CLAUDE.md coverage

- **No injected block covers it**, matching 2b. The checked-in root CLAUDE.md does not document fleet at all, so there is no code-vs-doc drift to check in the runtime-injected surface. The standalone `docs/aiordie-fleet.md` description of `await_turn` agrees with the code (see 2c).
- **Consistency.** Injected block (none) vs checked-in root CLAUDE.md (none) are consistent — both silent.

### 3d. Cross-surface consistency

No contradictions. The description is the only surface; it matches the handler (cursors server-owned, `watcherId` isolation, per-instance long-poll). The design doc (`docs/aiordie-fleet.md`) is consistent but is not a model-facing surface. The one cross-surface *gap* (not a contradiction) is that the send→await_turn→completion pattern is described in `send_message`/`drive_task` but not surfaced from `await_turn`'s own description, and fleet is absent from the system prompt — so a model that lands on `await_turn` cold has less routing context than for a peer-group tool.

## 4. Findings

- **[Suggestion]** `src/lib/fleet/tools.ts:609` — the description gives no "when to use / when NOT to use" routing signal and, because fleet is absent from the system prompt (`peer-mcp-personas.ts:555`), this string is Opus's only pointer to the tool. Add one clause tying it to the sibling pattern, e.g. "Use after `send_message` (with `awaitMs:0`) to observe a session's real turn completion; `settled[].status` = `turn_ended`/`waiting_input` is the reliable signal, a bare `became_idle` is surfaced as `idle_flicker`/`reliable:false` and is never completion." This mirrors the reliable-vs-flicker contract already implemented in `classifyTurnEvents` (`driver.ts:218-238`) and referenced from `drive_task` (`tools.ts:694`), so it is documenting existing behavior, not adding surface.

- **[Suggestion]** `src/lib/fleet/tools.ts:614` — `timeoutMs` field description omits the 30s default (`AWAIT_TURN_DEFAULT_TIMEOUT_MS`, `tools.ts:43`). Naming the default (as `drive_task`'s `timeoutMs` does at `:699` via template literal) lets the model reason about how long the call blocks before returning. Append "(default 30000)".

- **[Suggestion]** `src/lib/fleet/tools.ts:678` — the output includes a `settled[]` classification whose semantics (`reliable:false` for `idle_flicker` must never be read as completion) are not discoverable from the tool surface at all; they live only in a code comment (`tools.ts:673-676`) and the `driver.ts` type. Folding the reliability contract into the description (as in the first finding) is the single highest-value change, because a model that misreads `idle_flicker` as "done" is the concrete failure mode this classification exists to prevent.

No Critical or Important findings: the injected surface is accurate, the schema and output are minimal, the gate is correctly wired list-time and call-time, and the system-prompt omission is consistent with the group's opt-in design rather than an accidental gap.

## 5. Verdict

**Y** — the injected surface is correct, minimal, and internally consistent; the tool is well-behaved and its schema/output carry no waste. The single most valuable fix is a Suggestion: since fleet is (by design) absent from the system prompt, fold the send→`await_turn` routing pattern and the `settled`/`reliable` completion contract into the description so the tool's only model-facing surface teaches when to use it and how to read its most important output field.
