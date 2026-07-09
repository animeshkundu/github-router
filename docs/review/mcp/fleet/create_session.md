# Review: `mcp__fleet__create_session`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__create_session` |
| Group / server | `fleet` (serverInfo `github-router-fleet`, `src/lib/peer-mcp-personas.ts:118`) |
| Wire tool name | `create_session` (`src/lib/fleet/tools.ts:533`) |
| Definition | `src/lib/fleet/tools.ts:532-586` (factory `tool()` at `:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182-184`): true iff `state.fleetEnabled` (`--fleet`) OR `GH_ROUTER_ENABLE_FLEET=1`. No local dependency check. |
| Backing model / endpoint | server-side fn → remote ai-or-die control plane `POST /api/control/sessions/create` (`src/lib/fleet/client.ts:365-367`) |
| Write-capable | yes — allocates a remote session (spawns a PTY / agent process on the target instance) |

Enablement is symmetric list-time + call-time: dropped from `tools/list` and `tools/call` returns `-32601` when the gate is off (`src/routes/mcp/handler.ts:341`, `:961-968`). The tool is spread into the union via `FLEET_TOOLS` (`src/lib/peer-mcp-personas.ts:2059`, built by `createFleetTools()` at `src/lib/fleet/tools.ts:784`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:534`):

> Create a new session on a specific fleet instance. The instance argument is required; no default is used.

Input schema (`src/lib/fleet/tools.ts:535-546`); required = `["instance", "agent"]`:

- `instance` (string) — "Required instance id or label. Create never uses the registry default."
- `agent` (string) — "Agent/runtime to create on the instance."
- `name` (string) — "Optional display name for the session."
- `workingDir` (string) — "Optional working directory on the remote instance."
- `idempotencyKey` (string) — "Optional caller idempotency key; auto-generated when omitted."
- `start` (boolean) — "Whether the remote instance should start the session immediately."
- `readyTimeoutMs` (number) — "F17: bounded ms to wait for the agent to become driveable before returning. The response carries ready/bound/blocker."
- `permissionMode` (string) — "F10 (claude only): permission mode the launched agent starts in — one of plan | acceptEdits | default | bypassPermissions. Rejected with BAD_REQUEST if unknown or if agentArgs also sets it."
- `agentArgs` (array) — "F10 (claude only): extra launcher args appended after the github-router prefix. Must NOT include --permission-mode or --dangerously-skip-permissions (use permissionMode) — rejected with BAD_REQUEST."
- `disableStopGate` (boolean) — "C3 (claude only): disable the structural Stop-gate on the launched session by injecting --no-stop-gate into agentArgs, so a driven session's turn-end never hangs on a blocking Stop hook. Requires a remote github-router that understands the flag (uses the agent_args capability)."

### 2b. System prompt (`--append-system-prompt`)

`create_session` is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). Neither the tool nor the `fleet` group appears anywhere in the snippet: paragraph 1 names `mcp__peers__*`; paragraph 2 (`para2Parts`, `:595-637`) names only `search`, `workers`, `orchestrate`, `decide`, and `browser` groups — each behind its own availability flag. There is no `fleet` branch and no `opts.fleetToolsAvailable` input to the snippet builder at all. So the **only** model-facing surface for this tool is its `tools/list` `description`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored CLAUDE.md carries the same peer-awareness block as 2b (via `buildPeerAwarenessSnippet`), so it likewise does **not** cover `create_session` or the `fleet` group.

Checked-in repo root `CLAUDE.md`: `fleet` appears **nowhere** (grep `-i fleet` → no matches). The root doc documents `first-mate` (`--agents`) at length but never mentions the `--fleet` fleet surface. The canonical prose lives instead in `docs/aiordie-fleet.md` and `docs/fleet-control-plane-contract.md` (not injected into the model, not linked from root CLAUDE.md). `docs/aiordie-fleet.md:62-67` describes `create_session` and states `agent: "claude" + start: true` is the way to spin up a remote session; `docs/fleet-control-plane-contract.md:49-85` is the wire contract this schema mirrors. Both agree with the code.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The one-line description conveys *what* the tool does and one hard rule (instance required, no default). It gives no "when to reach for this" or "when NOT to" framing — acceptable for a resource-allocating operator tool, but a first-time caller learns nothing about the fleet workflow (create → drive → stop) from the description alone, and since the system prompt is silent (2b), there is no other steer. A caller must infer the workflow from sibling tool descriptions (`send_message`, `drive_task`, `await_turn`).
- **`agent` under-specified (Important).** The schema marks `agent` **required** (`:546`) and describes it only as "Agent/runtime to create on the instance." The upstream contract is an enum — `"claude"|"codex"|"copilot"|"gemini"|"terminal"` (`docs/fleet-control-plane-contract.md:54`). The model has no way to know the valid values from the surface; a bad value round-trips to the remote for a `BAD_REQUEST`. The description should enumerate the accepted runtimes (or the schema should carry `enum`).
- **`start` semantics unstated (Important).** `start` is described as "Whether the remote instance should start the session immediately." It does not say that WITHOUT `start:true` the create yields a `lifecycle:'created'` session that is not running / not driveable (`docs/fleet-control-plane-contract.md:75`, `docs/aiordie-fleet.md:66`). A model reading only the description could create a session, then be surprised that `send_message`/`drive_task` find nothing to drive. The common-case recipe (`agent:"claude", start:true`) is not hinted anywhere in the injected surface.
- **Accuracy vs implementation.** The mechanics are accurate: fields map 1:1 to `CreateSessionInput` (`src/lib/fleet/client.ts:188-200`) via `definedObject(...)` (`:566-577`); `disableStopGate` injects `--no-stop-gate` into `agentArgs` and shares the `agent_args` capability (`:552-558`, `:562-563`); the `permissionMode`/`agentArgs` capability pre-checks (`:559-564`) match the `assertCapability` fail-open-on-unknown behavior (`:204-217`). The returned `sessionId` is re-encoded to the global `instanceId:localId` form (`:583`) and the instance is echoed as `{id,label}` only via `publicInstance` (`:1086-1088`) — no token leak. All accurate; no stale model id or default.
- **Schema minimality.** Every field is an input the handler consumes and forwards (none echoed-only, none diagnostic-only), so the surface satisfies the "ruthlessly minimal" principle on the *presence* axis. Two nits: (1) `permissionMode` and `agentArgs` descriptions each restate the same F10 "claude only … rejected with BAD_REQUEST" contract — mildly redundant but individually actionable, so acceptable. (2) The `F17`/`F10`/`C3` internal-ticket tags leak into three field descriptions (`readyTimeoutMs`, `permissionMode`, `agentArgs`, `disableStopGate`) — noise the model cannot act on; the same leak exists on `send_message`/`await_turn`, so it is a fleet-wide pattern, not unique here.

### 3b. System-prompt coverage

- **Omitted — by design, and acceptable.** Fleet is an opt-in operator surface (`--fleet`); the awareness snippet only advertises always-on / capability-common tooling. Not naming `fleet` keeps the snippet from listing a group that is off for the vast majority of launches, and the tool descriptions are self-contained enough to be discovered from `tools/list`. This matches the framing-constraint spirit (no anchors, no imperatives) since there is simply no clause. **Judgment: acceptable** — the description is load-bearing precisely because the system prompt is silent, which raises the bar on 3a's gaps (`agent` enum, `start` semantics) but does not by itself constitute a defect.
- No imperative/hedge/anchor to flag (nothing exists to violate the constraints pinned by `tests/peer-mcp-personas.test.ts`).

### 3c. CLAUDE.md coverage

- The injected/mirrored CLAUDE.md does not cover the tool (same silence as 2b) — consistent with 3b.
- The checked-in root `CLAUDE.md` documents `first-mate` but never mentions `--fleet` or the fleet MCP group at all. Given the review-checklist expectation that model-facing surfaces are documented, the **absence of any root-CLAUDE.md pointer to the fleet surface** is a documentation gap (the design prose exists only in `docs/aiordie-fleet.md` / `docs/fleet-control-plane-contract.md`, which are not linked from the root "Design docs" list). Not a model-facing correctness bug, but it means the tool ships undocumented in the canonical index.

### 3d. Cross-surface consistency

No contradictions. Description ↔ `CreateSessionInput` (client) ↔ `docs/fleet-control-plane-contract.md` all agree on field names, types, the F10 BAD_REQUEST rules, and the F17 readiness fields. The only cross-surface *mismatch* is required-ness of `agent`: the tool schema marks it required (`:546`) and the handler enforces it via `requiredString` (`:549`), while `CreateSessionInput.agent` is typed optional (`src/lib/fleet/client.ts:191`) and the contract enum lists it among request fields. This is a deliberate tightening at the tool boundary (a session with no agent is not useful), not a contradiction — but it is undocumented in the description.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:538` — `agent` is required but its description ("Agent/runtime to create on the instance") omits the valid enum values (`claude|codex|copilot|gemini|terminal`, per `docs/fleet-control-plane-contract.md:54`). A model cannot pick a valid value from the surface; a wrong value costs a remote round-trip to `BAD_REQUEST`. Fix: enumerate the accepted runtimes in the description (or add `enum` to the schema prop).
- **[Important]** `src/lib/fleet/tools.ts:541` — `start`'s description omits that without `start:true` the session is created but NOT running/driveable (`docs/fleet-control-plane-contract.md:75`). The common-case recipe (`agent:"claude", start:true`) is unstated anywhere in the injected surface, and the system prompt is silent, so a model may create an inert session and then fail to drive it. Fix: state that `start:true` is required for the session to run and be driveable.
- **[Suggestion]** `src/lib/fleet/tools.ts:542-545` — internal ticket tags `F17`/`F10`/`C3` leak into `readyTimeoutMs`/`permissionMode`/`agentArgs`/`disableStopGate` descriptions; strip them (non-actionable to the model). Fleet-wide pattern, not unique to this tool.
- **[Suggestion]** root `CLAUDE.md` — no pointer to the `--fleet` fleet MCP surface in the "Design docs" index (only `first-mate` is documented). Add a one-line entry linking `docs/aiordie-fleet.md` so the canonical index covers the fleet tools.

No Critical: the description tells the model nothing the code rejects, the gate is symmetric, and no token is echoed. The gaps are missing when-to / valid-value signals, not misroutes.

## 5. Verdict

N — injected surface is accurate, minimal, gate-consistent, and leak-free, but under-routed: with the system prompt silent, the description is the sole steer yet omits the `agent` enum and the load-bearing `start:true` semantics. Single most important fix: enumerate `agent`'s valid runtimes and state that `start:true` is needed for a driveable session.
