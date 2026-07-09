# Review: `mcp__fleet__send_message`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__send_message` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `send_message` |
| Definition | `src/lib/fleet/tools.ts:362` (factory `tool()` at `src/lib/fleet/tools.ts:283`) |
| Always-on? | gated — off by default |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`) = `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"` |
| Backing model / endpoint | server-side fn — proxies to a remote ai-or-die instance's `/api/.../message` via `FleetClient.sendMessage` (no LLM call) |
| Write-capable | yes — side-effecting: types text into a live remote AI-CLI session |

Dual-gate defense-in-depth (same pattern as workers / stand_in): dropped from `tools/list` (`src/routes/mcp/handler.ts:341`) AND `tools/call` returns `-32601` when the gate is off (`src/routes/mcp/handler.ts:962-964`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:364`), verbatim:

> Send a message to a fleet session. By DEFAULT it first checks the session is idle / awaiting the next message and REFUSES (structured notReady, isError) rather than blind-type into a busy composer or a pending prompt — set requireIdle:false to force the legacy unconditional send, or waitForIdleMs to wait briefly for idle first. isError reflects DELIVERY: true when the message was not delivered (transport/precondition failure) OR refused as notReady. A delivered message whose confirmation did not arrive within awaitMs is NOT an error — it returns delivered:true with confirmationPending/confirmationTimedOut, because a long turn legitimately outruns awaitMs. The additive `submitted` field is true only when ai-or-die's submission sub-status proves the message reached the composer. Recommended pattern: send with awaitMs:0 for a fast delivery ack, then call await_turn (filtered to this sessionId) to observe the session's actual turn completion. The idempotencyKey makes a retried send safe (a retry never re-types the message).

Input-schema fields (`src/lib/fleet/tools.ts:365-373`; `required: ["sessionId", "message"]`):

- `sessionId` (string): "Global session id in the form instanceId:localSessionId."
- `instance` (string): "Optional instance id/label; when supplied it must agree with sessionId."
- `message` (string): "Message text to deliver to the session."
- `idempotencyKey` (string): "Optional caller idempotency key; AUTO-GENERATED when omitted, so you normally never pass it. Supply your OWN stable key only when you will retry the SAME send and need the upstream to dedupe it."
- `awaitMs` (number): "Optional best-effort confirmation wait (ms) — NOT a deadline. Prefer awaitMs:0 plus await_turn; a turn that outruns awaitMs returns confirmationPending, not an error."
- `requireIdle` (boolean): "Default true: check status and refuse a busy/awaiting-prompt/dead session with a structured notReady result. Set false to force an unconditional send (unsafe: may type into a busy composer)."
- `waitForIdleMs` (number): "When requireIdle, wait up to this many ms for the session to become idle before deciding (default 0 = decide immediately)."

`additionalProperties: false` (`src/lib/fleet/tools.ts:1196`), so unknown keys are rejected by the schema.

### 2b. System prompt (`--append-system-prompt`)

**NOT named.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) has no fleet branch at all — there is no `fleetKey`, no `opts.fleetAvailable`, and no clause mentioning `send_message`, `mcp__fleet__*`, or the fleet server. The snippet enumerates `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` conditionally, but **fleet is entirely omitted** — neither the group nor any of its tools is named. So the only model-facing surface for this tool is its `tools/list` `description` (2a).

This tool is not a persona, so there is no subagent `baseInstructions` / `buildAgentPrompt` system prompt either.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No injected marker block covers this tool. The mirrored peer-awareness block is the same text as 2b, which omits fleet; the artifact-panel directive, operating-defaults, and toolbelt blocks do not mention it either. Confirmed the repo root `CLAUDE.md` has zero `fleet` matches (grep, case-insensitive). The checked-in design doc that documents the tool is `docs/aiordie-fleet.md` — it is a design/ops reference, NOT an injected surface, and it agrees with the code: it lists `send_message (LOUD isError on unconfirmed delivery)` at `docs/aiordie-fleet.md:64` and the gate wiring at `docs/aiordie-fleet.md:72-74`.

Note: `docs/aiordie-fleet.md:64`'s parenthetical "LOUD `isError` on unconfirmed delivery" is now **stale relative to the code** — the current handler (`src/lib/fleet/tools.ts:438`) sets `isError` on delivery failure ONLY; an unconfirmed-but-delivered send is explicitly `isError:false` with `confirmationPending` (`src/lib/fleet/tools.ts:436-455`). The tool `description` itself is correct on this point; only the design-doc one-liner drifted.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. It states what the tool does (send a free-text message to a remote session), the default safety behavior (refuse a busy/awaiting/dead session), the opt-out (`requireIdle:false`), and — critically — a "when NOT to use" signal: a pending non-message prompt routes the model to `respond`, not `send_message` (the `awaiting_other` refusal advice at `src/lib/fleet/tools.ts:393-395`). It also teaches the recommended two-call pattern (`awaitMs:0` then `await_turn`).
- **Side-effect / target legibility.** Adequate but implicit. The tool drives a remote session (a genuine write / side effect), yet the description never says the word "remote" or that the target is another machine's live AI-CLI — a reader could take "fleet session" as local. Target selection is legible in the schema (`sessionId` = `instanceId:localSessionId`, optional cross-checking `instance`), and the write nature is conveyed via "blind-type into a busy composer" / "the message reached the composer", so the side effect is signaled, if obliquely. See finding [Suggestion-1].
- **Accuracy vs implementation.** Verified line-by-line, all accurate:
  - "REFUSES (structured notReady, isError)" → `src/lib/fleet/tools.ts:390-408` returns `notReady:true` + `isError:true` only when `isHardNotReady(reason)` (`busy` / `awaiting_other` / `terminal` per `src/lib/fleet/driver.ts:97,144`). An `unknown`/status-probe-fail state fails OPEN (comment `src/lib/fleet/tools.ts:381-384`; classifier `src/lib/fleet/driver.ts:126-140`) — consistent with "checks the session is idle / awaiting the next message and REFUSES ... a busy composer or a pending prompt" (it refuses on positive evidence, not on ambiguity).
  - "isError reflects DELIVERY" → `const isError = !delivered` (`src/lib/fleet/tools.ts:438`); `delivered` derives from `response.delivered`/`delivery.status` (`src/lib/fleet/tools.ts:423-427`). Accurate.
  - "confirmationPending/confirmationTimedOut ... NOT an error" → `src/lib/fleet/tools.ts:436-455` emits both fields with `isError:false`. Accurate.
  - "`submitted` ... only when ai-or-die's submission sub-status proves the message reached the composer" → `submitted = delivered && response.submission?.status === "submitted"` (`src/lib/fleet/tools.ts:431`; field exists on `SendMessageResponse`, `src/lib/fleet/client.ts:247`). Accurate.
  - "idempotencyKey makes a retried send safe" → auto-`randomUUID()` when omitted (`src/lib/fleet/tools.ts:415`); dedup is end-to-end and depends on the ai-or-die control plane honoring it — the schema field text ("need the upstream to dedupe it") is honest about that dependency.
- **Schema minimality.** Every field passes the "what would the model do with this?" test. All seven are either required (`sessionId`, `message`), a routing/safety knob the model tunes (`requireIdle`, `waitForIdleMs`, `awaitMs`), a cross-check guard (`instance`), or an escape hatch (`idempotencyKey`, whose text explicitly says the model normally omits it). No echoed-input or diagnostic-only fields. Minimal.

### 3b. System-prompt coverage

- **Omitted — by design, defensible.** Fleet is an opt-in operator surface (off by default, `--fleet` / `GH_ROUTER_ENABLE_FLEET=1`). Since the awareness snippet is a static string built once at launch and fleet is a rarely-enabled niche capability, leaving it out of the snippet keeps the always-present system prompt lean. The dual-gate ensures the tool only appears in `tools/list` when the operator opted in, and the `description` is self-sufficient for routing. This mirrors the treatment of `first-mate` (also opt-in) which similarly gets only a conditional single-line mention. The gap is acceptable: no correctness or safety property depends on a system-prompt clause, because the description carries the safety framing (`requireIdle`, `respond`-vs-message routing) itself.
- **Consistency check.** Because fleet is unnamed in 2b, there is no redundancy and no framing-constraint (imperative/hedge/anchor) risk to evaluate — there is no clause. `tests/peer-mcp-personas.test.ts` pins the snippet's constraints for the groups it DOES name; fleet's absence is not covered by a test (see finding [Suggestion-2]).

### 3c. CLAUDE.md coverage

- No injected CLAUDE.md block covers this tool; consistent with 2b (the mirrored peer-awareness block is the same fleet-free text). Not drifted, because it says nothing.
- The checked-in design doc `docs/aiordie-fleet.md` documents it and agrees with the code on gate, addressing, and safety — except the one stale parenthetical noted in 2c ("LOUD isError on unconfirmed delivery"), which the current delivery-only `isError` semantics contradict. Design-doc-only; not a model-facing surface.

### 3d. Cross-surface consistency

- description ↔ code: consistent (3a).
- description ↔ system prompt: no conflict (system prompt is silent).
- description ↔ CLAUDE.md injected block: no conflict (silent).
- description ↔ `docs/aiordie-fleet.md`: the design doc's `isError`-on-unconfirmed one-liner contradicts the description's explicit "unconfirmed is NOT an error". The description is the correct one; the doc lags.

## 4. Findings

Ranked, most severe first.

- **[Important]** `docs/aiordie-fleet.md:64` — the parenthetical "`send_message` (LOUD `isError` on unconfirmed delivery)" is stale: the shipped tool sets `isError` on delivery failure only and returns an unconfirmed-but-delivered send as `isError:false` + `confirmationPending` (`src/lib/fleet/tools.ts:436-455`). It contradicts the tool `description`. Fix: reword to "LOUD `isError` on non-delivery (unconfirmed-but-delivered is a non-error `confirmationPending`)". Not model-facing (design doc), hence Important not Critical, but it is a factual contradiction across surfaces.
- **[Suggestion-1]** `src/lib/fleet/tools.ts:364` — the description never states the target is a *remote* session on another machine, so the write's blast radius is under-signaled for a side-effecting tool. A reader could assume a local session. Fix: open with "Send a message to a **remote** ai-or-die fleet session" (one word), making the cross-machine side effect explicit without lengthening the surface.
- **[Suggestion-2]** No test pins fleet's deliberate absence from `buildPeerAwarenessSnippet`. A future edit could add a fleet clause (or a stray mention) without a guard catching it. Fix: add a one-line assertion in `tests/peer-mcp-personas.test.ts` that the snippet does not contain `fleet` / `send_message`, documenting the omission as intentional. Non-blocking.

No Critical findings: the description does not instruct the model to do anything the code rejects, and the safety-refusal, `isError`, and `submitted` claims all match the implementation.

## 5. Verdict

**Y** — the injected surface is correct, minimal, and self-consistent (the only model-facing surface is an accurate, well-routed `description`; fleet's omission from the system prompt is a defensible opt-in-niche design choice). Single most important fix: correct the stale "LOUD isError on unconfirmed delivery" line in `docs/aiordie-fleet.md:64` so the design doc stops contradicting the tool's actual delivery-only `isError` semantics.
