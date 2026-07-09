# Review: `mcp__fleet__session_status`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__session_status` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `session_status` |
| Definition | `src/lib/fleet/tools.ts:349` (factory `tool()` at `src/lib/fleet/tools.ts:283`) |
| Always-on? | gated by `capability:"fleet"` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`): `state.fleetEnabled || process.env.GH_ROUTER_ENABLE_FLEET === "1"` (operator opts in via `--fleet` or `GH_ROUTER_ENABLE_FLEET=1`) |
| Backing model / endpoint | server-side fn — no model; forwards to the remote ai-or-die control plane `GET /api/control/sessions/{id}/status` (`src/lib/fleet/client.ts:351-353`) |
| Write-capable | no (read-only status fetch) |

Gate is enforced symmetrically at both `tools/list` and `tools/call`: the list filter (`src/routes/mcp/handler.ts:341`) and the call path both consult `fleetToolsEnabled()`; `FLEET_TOOLS` are spread into `NON_PERSONA_MCP_TOOLS` at `src/routes/mcp/handler.ts:2059`, and the tool carries `capability: "fleet"` (`src/lib/fleet/tools.ts:294`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:351`):

> `Fetch lifecycle and interaction status for an addressed fleet session.`

Input schema (`src/lib/fleet/tools.ts:352-355`), `objectSchema(properties, required)` with `required: ["sessionId"]`, `additionalProperties: false`:

- `sessionId` (string, **required**): `Global session id in the form instanceId:localSessionId.`
- `instance` (string, optional): `Optional instance id/label; when supplied it must agree with sessionId.`

### 2b. System prompt (`--append-system-prompt`)

**NOT named.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555`) enumerates only the `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` groups in its paragraph-2 capability inventory (`src/lib/peer-mcp-personas.ts:595-637`). There is no `fleet` clause and no `mcp__fleet__*` path anywhere in the snippet. A full-file `fleet` search of `peer-mcp-personas.ts` returns only the `McpGroup` type/`GROUP_META` plumbing (lines 78-118) and the capability-gate doc comment (lines 731-732) — never a system-prompt clause. So neither the group nor the tool is named in the system prompt; the entire fleet surface is system-prompt-silent by design (fleet is an operator-opt-in remote-control capability, not part of the default local-tool awareness pitch).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

**No covering block.** The mirrored peer-awareness block is the same text produced by `buildPeerAwarenessSnippet` (2b), which never names fleet; `src/lib/codex-mcp-config.ts` (which assembles the mirrored CLAUDE.md content) has zero `fleet` mentions. So the mirrored CLAUDE.md does not cover this tool — consistent with the system prompt.

The checked-in repo root `CLAUDE.md` (project root) also has **zero** `fleet` / `session_status` / `session-control` mentions (`rg -c -i fleet CLAUDE.md` → no match). The fleet surface is documented instead in standalone design docs — `docs/aiordie-fleet.md:63` lists `session_status` among the tools, and `docs/review/mcp/README.md:101` maps `session_status → line 350`. Both agree with the code (the doc line ref is off by one from the description string at 351, pointing at the `tool(` call head — an acceptable convention, matching how the README indexes every fleet tool).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: The one-liner is clear and correctly scoped — "lifecycle and interaction status for an addressed fleet session" tells the model exactly what it returns and that a session must be addressed. The `sessionId` field description carries the addressing contract (`instanceId:localSessionId`) so the model knows the id shape without guessing. There is no explicit "when NOT to use" clause, but for a trivial read-only status fetch that is acceptable — the sibling tools carry the routing weight (`send_message`/`await_turn`/`drive_task` descriptions at `src/lib/fleet/tools.ts:364,610,694` steer the model to `await_turn`/`drive_task` for turn completion, implicitly leaving `session_status` as the point-in-time probe).
- **Accuracy vs implementation**: Accurate. The handler (`src/lib/fleet/tools.ts:356-360`) resolves the session, calls `client.status(localId)`, and returns `{resolvedInstance, ...StatusResponse, sessionId: globalId}`. `StatusResponse` (`src/lib/fleet/client.ts:175-178`) = `{sessionId, status: FleetSessionStatus}`, and `FleetSessionStatus` (`src/lib/fleet/client.ts:142-152`) carries `lifecycle`, `interactionState`, `canAcceptInput`, `blockReason`, `awaiting`, etc. — so "lifecycle and interaction status" is a faithful summary of the returned shape. No stale model id, default, or gate: the tool has no model and no defaults, and the `fleet` capability string in the description-adjacent factory matches the gate.
- **Schema minimality**: Meets the "ruthlessly minimal MCP tool surface" bar. Only two fields; `sessionId` is required and load-bearing, `instance` is an optional consistency-check/disambiguation input that the handler actually validates against the decoded id (`resolveSession`, `src/lib/fleet/tools.ts:229-238` throws `INSTANCE_MISMATCH` when they disagree) — so it is actionable, not an echoed input. `additionalProperties:false` keeps the surface tight. No diagnostic-only or echoed-input fields.

### 3b. System-prompt coverage

- **Named or omitted?** Omitted — and by design. Fleet is an operator-opt-in remote-session-control capability behind `--fleet`; the peer-awareness snippet pitches the always-relevant local tool families (critics, search, workers, orchestrate, decide, browser) and deliberately excludes the fleet group. Omission is defensible: when the operator turns fleet on they are already reaching for these tools, and the per-tool `description` carries the full contract.
- **Accurate & non-redundant**: N/A — nothing to be inaccurate or redundant with, since fleet is absent from the snippet.
- **Framing-constraint compliance**: N/A for the system prompt (tool not named). The `description` itself is a plain declarative sentence with no imperatives, hedges, or disguised anchors, so it would pass the framing constraints if it were ever surfaced.

### 3c. CLAUDE.md coverage

- **Accurate, non-redundant, not drifted?** The mirrored CLAUDE.md does not cover the tool (matches the system prompt), so there is nothing to drift. The checked-in root CLAUDE.md also omits fleet entirely; the authoritative fleet documentation lives in `docs/aiordie-fleet.md` and `docs/review/mcp/README.md`, both of which list `session_status` and agree with the code.
- **Injected block vs checked-in root CLAUDE.md consistency**: Consistent — both omit fleet, so there is no contradiction between the injected surface and the checked-in root file.

### 3d. Cross-surface consistency

No contradictions. Description ↔ system prompt ↔ CLAUDE.md ↔ code are consistent: the only model-facing surface is the `description` + 2-field schema, which faithfully describes the read-only status fetch the handler performs; the system prompt and both CLAUDE.md variants are silent on fleet (by design); the standalone docs that do mention `session_status` agree with the code. The tool's `capability:"fleet"` matches the gate consulted at both list and call time.

## 4. Findings

- **[Suggestion]** `src/lib/fleet/tools.ts:351` — the `description` does not hint at what the returned `status` object contains (`lifecycle` / `interactionState` / `canAcceptInput` / `blockReason` / `awaiting`), nor when to prefer `session_status` over `await_turn`/`drive_task`. Since fleet is system-prompt-silent, the `description` is the model's *only* routing signal for this tool. A short trailing clause — e.g. "Returns a point-in-time snapshot (lifecycle, interactionState, canAcceptInput, blockReason); for turn completion prefer `await_turn`" — would sharpen routing at near-zero token cost and mirror the richer sibling descriptions. Non-blocking: the current one-liner is correct and the addressing contract is fully specified.
- **[Suggestion]** `src/lib/fleet/tools.ts:353` — the `instance` field description ("Optional instance id/label; when supplied it must agree with sessionId.") states the constraint but not the consequence. Naming the failure (rejected with `INSTANCE_MISMATCH` when it disagrees, per `src/lib/fleet/tools.ts:233-237`) would make the field self-documenting and let the model recover from a mismatch without a round-trip. Non-blocking.

No Critical or Important findings. No correctness, security, or minimality defect in the injected surface.

## 5. Verdict

**Y** — the injected surface is correct, minimal, consistent, and adequately routed for a trivial read-only status probe. System-prompt/CLAUDE.md silence is by design (operator-opt-in fleet capability). Single most valuable improvement: enrich the `description` to name the returned status fields and steer turn-completion queries to `await_turn`/`drive_task`, since the `description` is this tool's only model-facing routing signal.
