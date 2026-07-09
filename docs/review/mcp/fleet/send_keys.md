# Review: `mcp__fleet__send_keys`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__send_keys` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `send_keys` |
| Definition | `src/lib/fleet/tools.ts:459` (factory `tool()` at `:283`) |
| Always-on? | gated |
| Capability gate | `fleet` → `fleetToolsEnabled()` = `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"` (`src/lib/mcp-capabilities.ts:182-184`); `--fleet` sets `state.fleetEnabled` |
| Backing model / endpoint | server-side fn → `FleetClient.sendKeys` POSTs `/api/control/sessions/{id}/keys` on the resolved remote instance (`src/lib/fleet/client.ts:413-414`) |
| Write-capable | yes (side-effecting: injects keystrokes into a live remote PTY/composer) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`tools.ts:460`):

> Send key input to a fleet session. Prefer the higher-level `op`: 'submit' presses Enter and 'interrupt' sends Ctrl-C, each mapped to ai-or-die's NAMED key (never a literal control byte like "\r"). Use `keys` only for literal input; `raw` is strictly for literal bytes. Provide exactly one of `op` or `keys`.

Input schema (`tools.ts:461-468`), `required: ["sessionId"]`, `additionalProperties: false`:

- `sessionId` (string, **required**): "Global session id in the form instanceId:localSessionId."
- `instance` (string): "Optional instance id/label; when supplied it must agree with sessionId."
- `op` (string): "Higher-level named op: 'submit' (Enter) or 'interrupt' (Ctrl-C). Mapped to the ai-or-die named key with raw off. Do NOT also pass keys."
- `keys` (string): "Literal key sequence to send. Provide instead of op."
- `idempotencyKey` (string): "Optional caller idempotency key; auto-generated when omitted."
- `raw` (boolean): "Pass keys through as raw literal bytes when the instance supports it. Ignored when op is set."

### 2b. System prompt (`--append-system-prompt`)

**Not named.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) builds the appended snippet from `criticList` + `para2Parts`; neither names `send_keys`, and the `fleet` group is absent entirely — there is no `opts.fleetAvailable` input and no fleet clause in the returned array (`:639-645`). The snippet gates mentions on `codexCli`/`geminiAvailable`/`workerToolsAvailable`/`standInAvailable`/`browseAvailable`/`agentToolsAvailable` only. So for fleet, not the group and not the tool: **nothing at all** reaches the system prompt. The only model-facing surface for this tool is its `description` (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

**No covering marker block.** The mirrored peer-awareness block is the same text as 2b, so it too omits fleet. The checked-in repo `CLAUDE.md` (project root) has **zero** mentions of `fleet`, `send_keys`, `send_message`, or `ai-or-die` (grep: no matches). Fleet is documented only in `docs/aiordie-fleet.md`, which is a repo design doc, NOT an injected surface — the model never reads it at runtime. Consistent with the injection-surface map in `docs/review/mcp/README.md:23` ("fleet — not named at all in the snippet"). So the description in 2a is the sole surface; there is no drift risk between surfaces because there are no other surfaces.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. It steers the model to the safe path (`op: 'submit'|'interrupt'`) first, warns that a literal `"\r"` is the wrong way to press Enter, and confines `keys`/`raw` to literal input. The "Provide exactly one of `op` or `keys`" rule matches the handler, which rejects both-set and neither-set (`tools.ts:473-478`). What is under-served is the **when-NOT** boundary: nothing tells the model to prefer `send_message` for free text or `respond` for an awaited prompt (see 3d). A model holding a session that is awaiting a plan-approval could reasonably reach for `send_keys` with `keys: "y"` when `respond` is the intended tool.
- **Accuracy vs implementation.** Accurate.
  - `op: 'submit'` → `"enter"`, `'interrupt'` → `"ctrl-c"`, both sent with `raw:false` — confirmed `mapNamedKeyOp` (`driver.ts:80-87`) + the op branch hard-setting `raw = false` (`tools.ts:481-487`).
  - "Ignored when op is set" for `raw` — confirmed: the op branch never reads `args.raw`, it assigns `raw = false` unconditionally (`tools.ts:487`); only the `keys` branch reads `optionalBoolean(args, "raw")` (`tools.ts:490`).
  - No stale model id / default / gate.
- **Schema minimality.** Mostly minimal, one real gap and one soft gap:
  - `sessionId` required, `instance` optional-cross-check, `op`/`keys`/`raw`/`idempotencyKey` all model-tunable and actionable. No echoed-input or diagnostic-only INPUT fields.
  - **Gap (schema vs prose invariant):** the "exactly one of `op`/`keys`" rule is enforced ONLY in the handler (`tools.ts:473-478`), not in the JSON schema. `required` lists just `sessionId` (`tools.ts:468`). A model that reads only the schema (not the prose) can emit `{sessionId}` with neither, and gets a runtime `INVALID_ARGUMENT` round-trip instead of a schema rejection. JSON-Schema `oneOf`/`required`-group would move that failure to validation time. Low severity (the prose is clear and the handler error is actionable), but it is a real description-vs-schema asymmetry.
  - **Output minimality (not an input-schema issue but on the model-facing surface):** the handler spreads `...response` into the result (`tools.ts:505`), so the wire `SendKeysResponse` (`keysId`, `delivered`, `duplicated?` — `client.ts:255-259`) all reach the model. `keysId` is a diagnostic-only echo the model cannot act on, and `duplicated?` is surfaced with no description telling the model what it means (idempotency-key replay). Per the ruthlessly-minimal-surface principle these are borderline — `delivered` is actionable, `keysId` is not.

### 3b. System-prompt coverage

- **Omitted — defensible.** send_keys is a low-level, single-instance write primitive inside a gated, opt-in group (`--fleet`). The awareness snippet is a capability inventory for always-relevant tools; naming a 15-tool opt-in fleet group there would bloat every session's system prompt for a feature most launches never enable. The tool `description` (2a) is self-contained enough to route on its own. So the omission is by-design, consistent with the README map (`docs/review/mcp/README.md:23`), not a gap — with one caveat: because there is NO group-level fleet mention anywhere in the snippet, a model that has the fleet tools in `tools/list` gets no framing for how the fleet tools relate to each other (send_message vs send_keys vs respond vs drive_task). That relational routing has to be inferred from descriptions alone.
- **Framing-constraint compliance.** N/A — nothing about this tool is in the snippet, so there is no imperative/hedge/anchor to violate.

### 3c. CLAUDE.md coverage

- **Accurate by omission.** The mirrored CLAUDE.md peer-awareness block equals 2b, so fleet is absent there too; the root repo CLAUDE.md never mentions fleet. There is nothing to drift. This is internally consistent: all three surfaces converge on "description only."
- The only documentation debt is that `docs/aiordie-fleet.md` describes send_keys (`:63`) but that doc is not an injected surface and is out of scope for what the model reads.

### 3d. Cross-surface consistency

- No contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ code — because the description is the only populated surface, and it matches the handler + driver code (verified 3a).
- The one consistency concern is **intra-group, not cross-surface**: the `send_keys` vs `send_message` distinction. It IS discoverable but only by reading both descriptions:
  - `send_message` (`tools.ts:364`) is the free-text path with idle-precondition checking (`requireIdle`, structured `notReady`), delivery/confirmation semantics, and the `await_turn` follow-up pattern.
  - `send_keys` (`tools.ts:460`) is raw keystrokes / control keys, no idle check, no delivery-confirmation loop.
  - `respond` (`tools.ts:511`) is the awaited-prompt path.
  The send_keys description does NOT point at send_message for free text or at respond for a prompt, and send_message's description does not point back at send_keys for control keys. A reader of the send_keys description alone learns *what* it does but not *when to prefer a sibling*. Given that no system-prompt/CLAUDE.md text frames the group, the descriptions are the only place this routing can live, and send_keys under-specifies it.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:460` — the `send_keys` description defines the tool well but gives no when-NOT-to-use signal relative to its siblings. A model can reach for `send_keys` with literal bytes when `send_message` (free text, with idle-safety) or `respond` (awaited prompt) is the intended tool, because no surface frames the group and the description does not cross-reference. **Fix:** add one clause, e.g. "For free-text input prefer `send_message` (it checks the session is idle first); to answer an awaited prompt use `respond`. `send_keys` is for control keys and literal key sequences only." This is the single highest-value change — it is also the only place the routing can live, since fleet is absent from the system prompt and CLAUDE.md.

- **[Suggestion]** `src/lib/fleet/tools.ts:461-468` — the "exactly one of `op`/`keys`" invariant lives only in prose + a runtime handler check (`:473-478`), not in the JSON schema (`required: ["sessionId"]`). A schema-only reader can send neither and eat an `INVALID_ARGUMENT` round-trip. **Fix:** express the mutual exclusion in the schema (a `oneOf` over `{required:["op"]}` / `{required:["keys"]}`) so validation rejects it before dispatch. Low impact — the handler error is already actionable.

- **[Suggestion]** `src/lib/fleet/tools.ts:505` — the result spreads the full `SendKeysResponse`, surfacing `keysId` (a diagnostic-only echo the model cannot act on) and an undescribed `duplicated?` flag. Per the ruthlessly-minimal-surface principle, consider projecting to `{delivered}` (+ `duplicated` with a one-line meaning if kept) and dropping `keysId`. Non-blocking; it costs a little model context, not correctness.

## 5. Verdict

**Y (with one important fix).** The injected surface is correct (description matches driver + handler), minimal on inputs, and fully consistent across surfaces (description is the only populated one, and it does not drift). The single most important fix: add a when-NOT clause to the description pointing at `send_message` (free text) and `respond` (awaited prompt), since fleet is named in no system-prompt or CLAUDE.md block and the description is therefore the only place that routing signal can live.
