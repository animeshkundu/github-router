# Review: `mcp__fleet__respond`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__respond` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `respond` |
| Definition | `src/lib/fleet/tools.ts:509` (tool factory `tool()` at `:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`): `state.fleetEnabled || GH_ROUTER_ENABLE_FLEET === "1"` (opt-in via `--fleet`) |
| Backing model / endpoint | server-side fn — HTTP `POST /api/control/sessions/{id}/respond` on the resolved ai-or-die instance (`src/lib/fleet/client.ts:417`) |
| Write-capable | yes (side-effecting: submits a choice/keys into a remote interactive prompt) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:511`):

> `Answer an awaited prompt in a fleet session by choice, option value, or explicit key override.`

Input schema (`tools.ts:512-519`), `required: ["sessionId"]`, `additionalProperties: false`:

- `sessionId` (string) — "Global session id in the form instanceId:localSessionId."
- `instance` (string) — "Optional instance id/label; when supplied it must agree with sessionId."
- `choice` (string) — "Named or numbered choice to select."
- `optionValue` (string) — "Exact option value to select."
- `keys` (string) — "Explicit key override to send instead of a mapped choice."
- `idempotencyKey` (string) — "Optional caller idempotency key; auto-generated when omitted."

### 2b. System prompt (`--append-system-prompt`)

Not named. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) builds two paragraphs naming `peers`, `search`, `workers`, `orchestrate`, `decide`, and (conditionally) `browser`. Neither `respond` nor any other `mcp__fleet__*` tool, nor the `fleet` group itself, appears anywhere in the snippet — `para2Parts` (`:595-637`) has no fleet branch. In `peer-mcp-personas.ts`, `fleet` occurs ONLY as a `McpGroup` union member (`:81`), in `GROUP_META` (`:118`), in the `MCP_GROUP_ORDER`-style list (`:91`), and as a `capability` tag (`:731-732, :745`) — never in model-facing prose. So for the fleet group the ONLY model-facing surface is each tool's own `description` + schema. This is acceptable: the fleet group is an operator-opt-in (`--fleet`) remote-control surface with no analog in the always-on peer/search/worker workflow, and folding a rarely-enabled multi-tool session-control API into the shared awareness snippet would spend main-agent context on a capability most sessions never turn on. The per-tool descriptions carry the routing signal.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

None. The mirrored peer-awareness block is the same text as 2b (produced by `buildPeerAwarenessSnippet`), which omits fleet entirely, so no injected marker block (peer-awareness, artifact-panel, operating-defaults, toolbelt) covers `respond`.

The checked-in repo root `CLAUDE.md` also does not document fleet or `respond` (verified: the only `respond`-adjacent hit, `CLAUDE.md:161`, is the semantic-search section, unrelated). The dedicated design doc `docs/aiordie-fleet.md` documents the group; it lists `respond` at `:64` and states the gate/addressing model (`:59-74`) — accurate against the code (gate name, `instanceId:localId` addressing, group registration all match). So the tool is documented for a human reader, just not injected into the model's context beyond its own description.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** The one-liner states WHAT (answer an awaited prompt) and the three input modes, but gives no WHEN-to-use / WHEN-NOT signal. The model is not told that `respond` applies only when a session is in an `awaiting_other` / `waiting_input` prompt state (the distinction the driver encodes at `driver.ts:120-134`), nor how to discover that state first (`session_status` / `await_turn`). The sibling `send_message` description DOES cross-reference `respond` ("The session is awaiting a prompt — use `respond`, not a free-text message", `tools.ts:364` handler advice at `:394`), but `respond` gives no reciprocal signal, so a model reading `respond` in isolation cannot tell it apart from `send_message`.
- **Accuracy vs implementation:** No stale model id / default / gate. But the description implies delivery is the point of the tool while omitting that a failed delivery is NOT surfaced as an error (see 3d / Findings) — an accuracy-of-omission gap. It also says "by choice, option value, or explicit key override" without stating that exactly one is expected; the handler (`:520-530`) validates none of them and forwards all present via `definedObject`, so a call with zero of the three (only `sessionId`) is a well-formed tool call whose meaning is entirely deferred to the remote — unlike `send_keys`, which enforces exactly-one-of `op`/`keys` (`:473-478`).
- **Schema minimality:** Good. Every field is required, an addressing input, or a genuine tunable: `sessionId` (required target), `instance` (optional cross-check, mismatch-guarded at `:230-238`), `choice`/`optionValue`/`keys` (the three answer modes), `idempotencyKey` (retry-safety, auto-generated at `:526` so normally unset). No echoed-input or diagnostic-only field. `additionalProperties:false` is set. No minimality violation.

### 3b. System-prompt coverage

- **Omitted** — by design, acceptable (see 2b). Fleet is an operator opt-in with no place in the always-on workflow narrative; the per-tool description is the intended and sole routing surface.
- Because it is omitted, there is no redundancy-with-description and no framing-constraint concern in the snippet for this tool (the imperative/anchor prohibitions pinned by `tests/peer-mcp-personas.test.ts` apply to the snippet text, which does not mention this tool).

### 3c. CLAUDE.md coverage

- No injected block covers `respond`; consistent with 2b (same generator). Not drifted, because it says nothing.
- Checked-in root `CLAUDE.md` is silent on fleet; `docs/aiordie-fleet.md` is the human-facing record and agrees with the code on gate, addressing, and tool list. No injected-vs-checked-in contradiction (both effectively say nothing to the model).

### 3d. Cross-surface consistency

- No description ↔ system-prompt ↔ CLAUDE.md contradiction (the latter two are silent).
- **One description ↔ code inconsistency of behavior:** `respond` wraps its result in `ok(...)` unconditionally (`tools.ts:529`), so `isError` is never set even when the upstream returns `delivered:false` (`RespondResponse.delivered`, `client.ts:261-266`, flows through via `...response`). Its sibling `send_message` keys `isError` on `!delivered` (`tools.ts:438`). The `respond` description gives the model no cue that it must read the payload's `delivered` field itself to detect a failed answer, and the harness-level error flag it would normally rely on will not fire. The happy-path is the only path tested (`tests/fleet/tools.test.ts:363-378`, `delivered:true`); the failed-delivery branch is unexercised.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:529` — `respond` returns `ok(...)` unconditionally, so a failed answer (`delivered:false`) is reported to the harness as a successful tool call (`isError` absent), diverging from `send_message`'s `isError = !delivered` at `:438`. **Failure scenario:** the model answers an awaited interactive prompt on a remote session; the upstream fails to deliver the selection (stale prompt, session moved on); the remote terminal stays blocked awaiting input, but the MCP result is not flagged as an error, so the model's plan proceeds as if the prompt were answered. The `delivered` boolean is present in the JSON text, so a careful model can still detect it — that is what keeps this Important rather than Critical (independent cross-lab severity check concurred: Important, recovery is possible from the payload). **Fix:** mirror `send_message` — compute `const delivered = response.delivered !== false` and return `jsonResult({ ...response, ... }, /* isError */ !delivered)`, with a one-line "not delivered" message; add a `delivered:false` test case alongside `tests/fleet/tools.test.ts:363`.
- **[Suggestion]** `tools.ts:511` — description gives no when-to-use / when-NOT signal to disambiguate `respond` from `send_message`. Add a clause: use `respond` only when a session is awaiting a prompt (discoverable via `session_status` / `await_turn` `waiting_input`); for a free-text message to an idle session use `send_message`. This mirrors the cross-reference `send_message` already carries toward `respond`.
- **[Suggestion]** `tools.ts:520-530` — handler does not validate that at least one of `choice` / `optionValue` / `keys` is present (unlike `send_keys`'s exactly-one-of guard at `:473-478`), and the description does not state the expectation. Either note in the description that exactly one answer mode should be supplied, or reject an all-empty call with `INVALID_ARGUMENT` so a malformed answer fails locally with a clear message instead of deferring an ambiguous no-op to the remote.

## 5. Verdict

N — the injected surface is minimal and (given fleet's opt-in nature) the system-prompt omission is acceptable, but the description under-signals routing AND, more importantly, the tool silently drops the delivery-failure signal that its sibling `send_message` raises. Single most important fix: set `isError` on `delivered:false` in the `respond` handler (`tools.ts:529`) so a failed answer to a remote prompt is not reported as success.
