# Review: `mcp__fleet__stop_session`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__stop_session` |
| Group / server | `fleet` (serverInfo `github-router-fleet`, `src/lib/peer-mcp-personas.ts:118`) |
| Wire tool name | `stop_session` (no prefix rename — `toolNameHttp` is used verbatim, `src/lib/fleet/tools.ts:588`) |
| Definition | `src/lib/fleet/tools.ts:587-607` (factory `tool()` at `:283`) |
| Always-on? | gated — opt-in only |
| Capability gate | `fleet` (`src/lib/fleet/tools.ts:294`) → `fleetToolsEnabled()` = `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"` (`src/lib/mcp-capabilities.ts:182-184`); list-time filter `src/routes/mcp/handler.ts:341`, call-time reject `handler.ts:961-965` |
| Backing model / endpoint | server-side fn — no model call. Forwards to the ai-or-die control plane `POST /api/control/sessions/{id}/stop` via `FleetClient.stopSession` (`src/lib/fleet/client.ts:377-399`) |
| Write-capable | yes (destructive: terminates a remote agent session) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:589`):

> Stop a fleet session.

Input schema (`src/lib/fleet/tools.ts:590-595`) — `required: ["sessionId"]`, `additionalProperties: false` (`objectSchema` at `:1192-1199`):

- `sessionId` (string, required): "Global session id in the form instanceId:localSessionId."
- `instance` (string, optional): "Optional instance id/label; when supplied it must agree with sessionId."
- `idempotencyKey` (string, optional): "Optional caller idempotency key; auto-generated when omitted."
- `mode` (string, optional): "Optional stop mode understood by the remote instance."

Handler behavior (`src/lib/fleet/tools.ts:596-606`): resolves the session (decodes `sessionId` → instance + local id, and if `instance` is passed cross-checks it, `resolveSession` at `:223-240`), auto-generates `idempotencyKey` when omitted (`:598`), forwards `{mode, idempotencyKey}` to `clientFor(instance).stopSession(localId, …)` and returns `{resolvedInstance, sessionId, ...response}` where the upstream response is `{stopped: boolean, lifecycle: string}` (`StopSessionResponse`, `src/lib/fleet/client.ts:226-229`). Any thrown error is caught by the factory wrapper and returned as `{error:{code,message}}` with `isError:true` (`tool()` at `:295-301`, `errorResult` at `:1125-1129`).

### 2b. System prompt (`--append-system-prompt`)

`stop_session` is **NOT named** — and neither is the `fleet` group. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) has no fleet branch at all: `para2Parts` covers only search/workers/orchestrate/web/decide/browser (`:595-637`), and the group inventory README confirms fleet is "not named at all in the snippet" (`docs/review/mcp/README.md:23`). Nothing in the appended system prompt references fleet, sessions, or `stop_session`. The only model-facing surface for this tool is its `tools/list` description (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

- **Mirrored peer-awareness block**: inherits the 2b omission verbatim. `appendPeerAwarenessToMirroredClaudeMd` writes the same `buildPeerAwarenessSnippet` output into the mirror (`src/claude.ts:1019-1042`), which has no fleet clause — so the mirrored CLAUDE.md does not name `stop_session` either. The other injected mirror blocks (toolbelt awareness, artifact-panel directive, style directive, operating-defaults) name no fleet tool.
- **Checked-in root CLAUDE.md**: zero fleet references (grep for `fleet|stop_session|ai-or-die|session-control` over `CLAUDE.md` → no matches). The `fleet` group is undocumented in the project root CLAUDE.md; it lives only in the developer-facing `docs/aiordie-fleet.md` (not an injected surface), whose tool inventory lists `stop_session` (`docs/aiordie-fleet.md:64`) and states `create`/`stop` forward an `idempotencyKey` the control plane dedupes (`:70-71`).

So across ALL injected surfaces the model sees exactly one string for this tool: "Stop a fleet session." plus the four schema field descriptions. There is no system-prompt or CLAUDE.md reinforcement.

## 3. Assessment

### 3a. Description quality

- **Routing signal**: too thin for a destructive tool. "Stop a fleet session." tells the model WHAT the verb does but nothing about (i) irreversibility — a stop terminates the remote agent session and its in-flight turn; there is no companion `resume`/`restart` tool in the suite (`src/lib/fleet/tools.ts:305-781` lists create/stop but no un-stop), so this is a one-way door; (ii) when NOT to call it — e.g. do not stop a session mid-turn to "unstick" it (that is `send_keys op:"interrupt"`, `:459-460`); (iii) the return shape `{stopped, lifecycle}` (`client.ts:226-229`), so the model cannot tell a confirmed stop from a no-op. By contrast the sibling `send_message` description is exhaustive about delivery/confirmation semantics (`:364`) and `drive_task` about recovery (`:694`); `stop_session` gets four words. For a tool whose side effect is terminating a remote process, the description should at minimum signal irreversibility so the model treats it with the care a destructive op warrants.
- **Accuracy vs implementation**: what little the description says is accurate — it does stop a session, and each schema field matches the handler (`sessionId` decoded and required `:591/:597`; `instance` cross-checked `:592/:229-238`; `idempotencyKey` auto-generated `:593/:598`; `mode` forwarded opaque `:594/:602`). No stale model id, default, or gate. `mode` is honestly described as "understood by the remote instance" — the client forwards it uninspected (`client.ts:386/:390`), so the vagueness reflects a genuinely open-ended upstream field, not a doc gap.
- **Schema minimality**: passes. `sessionId` is required to address the session; `instance` is an optional safety cross-check (guards against a `sessionId` typo routing the stop to the wrong instance, `:231-238`); `idempotencyKey` makes a retried stop safe (auto-generated, so the model normally never passes it — matching the `send_message` idempotency treatment); `mode` is an optional upstream passthrough. No echoed-input, diagnostic-only, or non-actionable field. `additionalProperties: false` is set (`:1196`). No minimality violation.

### 3b. System-prompt coverage

- **Omitted** — the whole `fleet` group is absent from `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:595-637`).
- **By design or gap?** Defensible as by-design, and consistent with the group-level policy (README `:23` records fleet as intentionally snippet-absent, same as `artifact`). Fleet is an opt-in operator surface (`--fleet`), niche relative to the always-on peers/search/workers, and adding a fleet paragraph to the default snippet would name tools missing from most sessions' `tools/list`. Leaving fleet to its tool descriptions is a reasonable line. The cost lands entirely on the description: because there is NO system-prompt or CLAUDE.md backstop, the description is the sole carrier of routing intent, which sharpens the 3a finding — a four-word description is the only thing standing between the model and a destructive call.
- **Framing-constraint compliance**: not applicable to an absent clause. If a fleet clause were ever added it must be a neutral capability mention (no imperative, hedge, or anchor) per the rules pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Mirrored peer block**: absent (inherits 2b — single builder output, no independent drift).
- **Root CLAUDE.md**: does not document the fleet group at all. This is a group-level documentation gap, not `stop_session`-specific: every other injected MCP group (peers, search, workers, orchestrate, browser, decide, first-mate) has a checked-in CLAUDE.md section, but fleet has none, so a contributor reading the root CLAUDE.md would not know the tool exists. The developer doc `docs/aiordie-fleet.md` covers it, but that is not the injected/checked-in convention the other groups follow.

### 3d. Cross-surface consistency

- description ↔ code: consistent. The four schema fields and their handler use agree (`tools.ts:590-606` ↔ `client.ts:377-399`); the return shape `{stopped, lifecycle}` is in code but not surfaced in the description (documentation gap, not a contradiction). No claim the code rejects.
- description ↔ system prompt / mirrored CLAUDE.md: no contradiction — both simply omit the tool. The asymmetry is total (description-only), which is the point of concern above, not an inconsistency.
- code ↔ root CLAUDE.md: the root CLAUDE.md is silent on fleet, so there is nothing to contradict — a coverage gap, not a drift.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:589` — the description "Stop a fleet session." does not signal that the operation is destructive and irreversible (it terminates a remote agent session and its in-flight turn; the suite has no `resume`/`restart` companion, `:305-781`), and gives no when-NOT-to-use routing. This is the tool's ONLY model-facing surface (2b/2c confirm no system-prompt or CLAUDE.md backstop), so the omission is the whole signal. A model reaching for a way to unstick a busy session could pick `stop_session` over the correct `send_keys op:"interrupt"` (`:459-460`) and irreversibly kill the session. Fix: expand to name the side effect and the boundary, e.g. "Terminate a fleet session (irreversible — ends the session and any in-flight turn; there is no resume). To interrupt a busy turn without killing the session, use `send_keys op:'interrupt'`. Returns `{stopped, lifecycle}`." Keep it a plain capability description (no imperative), consistent with the framing rules. (Important over Suggestion: destructive + irreversible + sole surface; the higher-classification default applies since a wrong route here is a data-loss-class outcome — a lost session, per the severity ladder.)

- **[Suggestion]** `src/lib/fleet/tools.ts:589` — the description omits the success return shape `{stopped: boolean, lifecycle: string}` (`src/lib/fleet/client.ts:226-229`), so the model cannot distinguish a confirmed stop (`stopped:true`) from a no-op and must learn the shape by calling. Folded into the Important fix above; listed separately in case that fix is scoped to the irreversibility wording only.

- **[Suggestion]** Root `CLAUDE.md` — the `fleet` group has no checked-in section, unlike every other injected MCP group. Add a short "Fleet session-control MCP (`--fleet`)" subsection (mirroring the browser/first-mate sections) so contributors know the opt-in surface exists and that `stop_session` is destructive; point at `docs/aiordie-fleet.md` for the wire contract. Group-level, not `stop_session`-specific.

## 5. Verdict

**N — one Important fix required.** The schema is minimal and correctly `fleet`-gated, and the snippet omission is a defensible group-level policy. But `stop_session` is destructive and irreversible while its ONLY model-facing surface is the four-word description "Stop a fleet session." with no irreversibility signal, no when-not-to-use, and no return shape — and there is no system-prompt or CLAUDE.md backstop to compensate. The single most important fix: rewrite the description to state the operation is irreversible, point the model at `send_keys op:'interrupt'` for the busy-session case, and name the `{stopped, lifecycle}` return.
