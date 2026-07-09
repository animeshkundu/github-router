# Review: `mcp__fleet__drive_task`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__drive_task` |
| Group / server | `fleet` (serverInfo `github-router-fleet`, `src/lib/peer-mcp-personas.ts:118`) |
| Wire tool name | `drive_task` |
| Definition | `src/lib/fleet/tools.ts:692` (entry) / handler `:702` → `driveTask({...})` in `src/lib/fleet/driver.ts:557` |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182` = `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET==="1"`; `--fleet` opt-in). Filters both `tools/list` (`handler.ts:341`) and `tools/call` (`handler.ts:961-971`). |
| Backing model / endpoint | server-side fn (composes fleet-client HTTP calls to a remote ai-or-die instance; no LLM dispatch) |
| Write-capable | yes — side-effecting: sends a message into a live remote agent session and can inject a Ctrl-C interrupt (`driver.ts:608`, `:655`) |

Single model-facing surface: the tool `description` at `tools/list`. The group is NOT named in `buildPeerAwarenessSnippet` and NOT in any CLAUDE.md (see 2b/2c).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

> `src/lib/fleet/tools.ts:694`:

"Drive one prompt on a session to completion and return the parsed operator report. Composes the reliable path: ensure the composer is idle (else return a structured busy/not-ready result), send and surface whether the message reached the composer (submitted; a delivered-but-unconfirmed send still proceeds), wait for the RELIABLE turn boundary (turn_ended / waiting_input — never the became_idle flicker), read the transcript tail, and parse the OPERATOR REPORT trailer into {state, summary, ask, artifact, raw}. A per-call REPORT_ID nonce is embedded in the trailer instruction and the parsed report is trusted ONLY when it echoes that nonce, so a stale prior-turn trailer left in the tail can never be returned as this turn's result. A reliable waiting_input outranks the model's self-reported STATE (a still-blocked session is never reported as done). If the turn does not end within timeoutMs (e.g. a blocking Stop hook that would otherwise hang ~10 min), it AUTO-RECOVERS with a Ctrl-C interrupt rather than blocking, then re-waits briefly and re-reads; a caller ABORT is distinct (settled:'aborted', state:'aborted') and never injects a Ctrl-C. Read `state` TOGETHER with `settled`/`interrupted`/`recovered`: state:'done' with settled:'timeout' + interrupted:true means the model reported done but the turn had to be interrupted to recover, so treat it as needs-verification rather than a clean completion; `submitted` is a best-effort positive signal that CAN be false even on a successful turn. Robust to a busy session (state:'busy'), a missing/stale/placeholder trailer (state falls back to the settle-derived value, reportFound:false), and a hung hook (interrupted:true, recovered:true/false). By default it appends the trailer instruction so the driven session emits a parseable report; set expectReport:false to send the prompt verbatim (a trailer left in the tail is then never trusted)."

Input schema (`:695-701`, `required: ["sessionId","prompt"]`, `additionalProperties: false`):

- `sessionId` (string): "Global session id in the form instanceId:localSessionId."
- `instance` (string): "Optional instance id/label; when supplied it must agree with sessionId."
- `prompt` (string): "The task/prompt to drive on the session."
- `timeoutMs` (number): "Ms to wait for the turn to end before auto-recovering via interrupt (default 120000). Set generously — exceeding it triggers a Ctrl-C recovery." (the `120000` is interpolated from `DRIVE_TASK_DEFAULT_TIMEOUT_MS`, `tools.ts:45`.)
- `expectReport` (boolean): "Default true: append the OPERATOR REPORT trailer instruction so the driven session ends its turn with a parseable {state,summary,ask,artifact}. Set false to send the prompt verbatim."

### 2b. System prompt (`--append-system-prompt`)

`drive_task` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). The snippet has no `fleetAvailable` option and emits no fleet clause at all — the `fleet` GROUP is likewise absent, not merely the tool. The awareness paragraph is gated by `codexCli` / `geminiAvailable` / `workerToolsAvailable` / `standInAvailable` / `browseAvailable` / `agentToolsAvailable` (`:556-562`); there is no `fleet` branch. So the system prompt says NOTHING about this tool or its server. The only model-facing surface is the `description` in 2a.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

None. The mirrored CLAUDE.md peer-awareness block is the same `buildPeerAwarenessSnippet` output as 2b, which omits fleet, so the mirror says nothing about `drive_task`.

Checked-in repo root `CLAUDE.md` has ZERO mention of `fleet` / `drive_task` / `ai-or-die` (grep of the whole file returns no matches). The fleet surface is documented only in the standalone design doc `docs/aiordie-fleet.md`, which is NOT injected into any model context. That doc's tool inventory (`docs/aiordie-fleet.md:62-67`) lists `list_instances`, `list_sessions`, `read_session`, `session_status`, `send_message`, `send_keys`, `respond`, `create_session`, `stop_session`, `await_turn`, and `read_file`/`list_dir`/`search`/`git_show` — but **omits `drive_task` entirely**. So the highest-value composite tool is undocumented in the one design doc that covers its own group.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: excellent for *how it behaves*, thin on *when to reach for it*. The description is a precise operational spec of the composite: idle-check → send → reliable turn-boundary wait → tail read → nonce-guarded report parse → timeout auto-recovery. Every claim checks out against `driveTask` (`driver.ts:557-729`): the idle refusal (step 1, `:575-595`), the `submitted` submission sub-status (`:609`), the `turn_ended`/`waiting_input` settle that never accepts `became_idle` (`TURN_SETTLE_KINDS`, `driver.ts:34`; `waitForTurnSettled` `:315`), the REPORT_ID nonce trust gate (`isCurrentReport`, `:635-636`), the `waiting_input`-outranks-STATE precedence (`:707-712`), and the Ctrl-C recovery that fires only on a genuine timeout and never on abort (`:651-655`). The result-field triangulation guidance ("Read `state` TOGETHER with `settled`/`interrupted`/`recovered`") is genuinely actionable and all four fields exist on `DriveTaskResult` (`driver.ts:494-517`).
- **Differentiation / composite framing**: the description says it "Composes the reliable path" but never names the sibling tools it composes (`send_message` + `await_turn` + `read_session`), nor when to prefer `drive_task` OVER hand-composing them, nor that it operates on an EXISTING session (does NOT create one — `create_session` is a separate step). A model that has all 13 fleet tools in `tools/list` and no system-prompt orientation (2b/2c) must infer the "use the composite, not the three primitives" routing from the word "Composes" alone. The one-turn scope is also implicit: "Drive ONE prompt on a session" is stated, but that this is a single-shot convenience over the send/await/read triad (vs a multi-turn loop) could be sharper.
- **Accuracy vs implementation**: accurate. No stale model id (server-side fn, no model). The `{state, summary, ask, artifact, raw}` parse shape matches `parseOperatorReport` + `DriveTaskResult` (`raw` = the transcript tail, `:719-723`). `state:'busy'` on a busy session matches `notReadyState("busy")` (`driver.ts:519-521`). The `timeoutMs` default `120000` is correctly interpolated from the constant. One nuance the description slightly over-simplifies: it says a timeout "AUTO-RECOVERS with a Ctrl-C interrupt … then re-waits briefly and re-reads", which matches steps 6; but the recovery re-read is only ADOPTED when it yields a current (nonce-matched) report or the pre-interrupt read had none (`:672-677`) — a subtlety the model doesn't need, so its omission is correct minimality, not a defect.
- **Schema minimality**: passes the ruthlessly-minimal bar. All five fields are either required (`sessionId`, `prompt`) or model-tunable behavior knobs (`instance` disambiguation/assertion, `timeoutMs`, `expectReport`). No echoed-input or diagnostic-only field. `instance` is the standard optional cross-check used by every addressed fleet tool (`resolveSession`, `tools.ts:223-240`) and is actionable (a mismatch throws `INSTANCE_MISMATCH`). `idempotencyKey`/`interruptKey`/`reportId` are correctly NOT exposed — they are generated per-call via `randomUUID()` inside the handler (`tools.ts:710-712`), so the model cannot foot-gun the nonce guard.

### 3b. System-prompt coverage

- **Omitted.** `drive_task` (and the whole `fleet` group) is absent from `buildPeerAwarenessSnippet`.
- **By design or a gap?** Defensible as design: `fleet` is an off-by-default (`--fleet`) power-user surface, and the other opt-in groups follow the same pattern — the snippet gates each capability's mention behind its availability flag, and there simply is no `fleetAvailable` opt threaded in. But it is inconsistent with `browser` and `first-mate`, which ARE off-by-default AND get a system-prompt clause when enabled (`:630-637` browser; the `agentToolsAvailable` skill sentence `:616-621`). Given `drive_task` is the highest-leverage fleet tool and the group carries 13 tools with no orientation, a one-line "when fleet is on" clause would materially improve routing. The acceptability call: **acceptable but sub-optimal** — the tool works from its `description` alone, but a model with a dozen fleet tools and zero framing is more likely to hand-roll send/await/read than to reach for the composite. This is the single thing most worth changing.
- **Accuracy**: n/a (nothing to be accurate about; nothing is said).

### 3c. CLAUDE.md coverage

- **Injected block**: none (peer-awareness omits fleet, matching 2b). Not drifted because it says nothing.
- **Checked-in root CLAUDE.md**: no fleet section at all. This is consistent with the injected surface (both silent), so there is no contradiction — but the standalone `docs/aiordie-fleet.md`, the one place fleet IS documented, has a tool-inventory list (`:62-67`) that OMITS `drive_task`. That is a real doc gap: a maintainer reading the fleet design doc would not learn the composite tool exists.

### 3d. Cross-surface consistency

No contradictions, because two of the three surfaces (system prompt, CLAUDE.md) are silent and the third (description) is accurate against the code. The only cross-surface inconsistency is a coverage gap, not a conflict: `docs/aiordie-fleet.md:62-67` lists ten-plus fleet tools but not `drive_task`, so the design doc undersells the surface it documents. Every behavioral claim in the `description` was verified against `driver.ts` and holds.

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:555-646` — `buildPeerAwarenessSnippet` names no `fleet` clause, so when `--fleet` is on the model gets 13 fleet tools (incl. the `drive_task` composite) with zero system-prompt orientation, unlike the comparably off-by-default `browser`/`first-mate` groups which DO get a clause. A model is then likely to hand-compose `send_message`+`await_turn`+`read_session` instead of using `drive_task`. Fix: thread a `fleetAvailable` opt and add a one-line clause naming the group and steering `drive_task` as the single-shot "drive one prompt to completion + parsed report" path over the primitives (mirror the browser clause pattern at `:630-637`). Suggestion, not Important: the tool is fully usable from its `description` alone.
- **[Suggestion]** `docs/aiordie-fleet.md:62-67` — the fleet tool inventory lists every other tool but omits `drive_task`, the highest-value composite. Fix: add `drive_task` to the list with a half-line ("drive one prompt to completion, nonce-guarded operator report, auto-Ctrl-C recovery on a hung Stop hook"). Docs-only; not model-facing.
- **[Suggestion]** `src/lib/fleet/tools.ts:694` — the `description` says "Composes the reliable path" without naming the composed primitives or stating it operates on an EXISTING session (does not create one). Adding "(composes send_message + await_turn + read_session on an already-created session)" would sharpen routing vs the primitives and vs `create_session`. Non-blocking polish; the composite behavior is otherwise fully and accurately specified.

No Critical or Important findings: the description is accurate against `driveTask` (`driver.ts:557-729`) on every load-bearing claim (nonce trust gate, `waiting_input` precedence, timeout Ctrl-C recovery vs abort, `submitted` best-effort), the schema is minimal and generates the safety-critical nonces server-side, and the gate correctly filters both list and call. No repro of a misroute that rejects a valid call or accepts an invalid one.

## 5. Verdict

**Y** — the injected surface is correct, minimal, and internally consistent: the sole model-facing surface is an accurate, code-faithful `description`, the schema is ruthlessly minimal with the nonce/idempotency keys generated server-side, and the `fleet` capability gates both `tools/list` and `tools/call`. Single most valuable improvement (Suggestion, not a blocker): add a one-line `fleet` clause to `buildPeerAwarenessSnippet` so an enabled fleet model is steered to `drive_task` as the composite instead of hand-rolling the send/await/read triad.
