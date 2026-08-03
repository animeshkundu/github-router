# Subagent: `worker-browse`

> Non-blocking background dispatcher for the `browse` worker (autonomous browser agent). Carries a confirmed field-name mismatch (A3).

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-browse` (`worker-dispatch.ts:58-60`; `BROWSE_WORKER_MODE`, `worker-dispatch.ts:45`) |
| Subagent's OWN model | inherited (Claude); the WORKER runs `BROWSE_DEFAULT_MODEL` = `gpt-5.4-mini` (repo CLAUDE.md) |
| Gate | `browseAvailable` (separate from the core five) — added only when `browseAgentEnabled()` (`--browse` + browser detected + browse default model in catalog). `activeDispatchModes({browse})` (`worker-dispatch.ts:73-75`), consumed by `buildPeerAgentDefinitions` (`codex-mcp-config.ts:326-335`); pinned by `tests/isolated/codex-mcp-config.test.ts:578-590` |
| Description | `dispatcherDescription("browse")` (`worker-dispatch.ts:215-216` + suffix) |
| System prompt | `dispatcherPrompt("browse", workersKey)` (`worker-dispatch.ts:226-254`) |
| Tools | `["mcp__<workersKey>__*"]` (`worker-dispatch.ts:263-265`) |

## 2. Description (verbatim)

> Non-blocking `browse` worker: dispatches an autonomous browser agent in the background and delivers its result as a completion notification. Use proactively for any browse-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

`dispatcherPrompt("browse", ...)` produces the STANDARD thin-dispatcher body with NO browse-specific override. Critically, the passthrough instruction (`worker-dispatch.ts:236`) reads:

> Call the `mcp__<workersKey>__browse` tool EXACTLY ONCE, passing through the fields from the lead's brief:
>   - `prompt`: the lead's worker brief, copied verbatim
>   - `workspace` (optional): absolute path, if the lead specified one
>   - `model` / `thinking` (optional): only if the lead specified them
>   - `maxWallClockMs` (optional): per-call wall-clock budget in ms, if the lead specified one

The `worktree` line is correctly omitted for browse (`worker-dispatch.ts:241` gates it to implement/test), but the `prompt` field name is NOT adjusted for browse.

## 4. Routing-trigger assessment

- **States trigger — strong (as a routing line).** "Use proactively for any browse-mode worker task so a long run never blocks your turn" is the same explicit proactive trigger as the other dispatchers.
- **Specific / previews body — the description is fine; the PROMPT is wrong.** The routing line accurately previews "autonomous browser agent, background, notification". The defect is not the trigger — it is the system-prompt's passthrough contract.

## 5. The A3 field-name mismatch (confirmed)

**Confirmed against code.** The `browse` tool's input schema requires `task`, not `prompt`:

- `peer-mcp-personas.ts:1920-1948`: `inputSchema` has `required: ["task"]` (`:1922`), `additionalProperties: false` (`:1923`), and the only content property is `task` (`:1925-1931`). There is NO `prompt` property.
- `dispatcherPrompt("browse", ...)` (`worker-dispatch.ts:236`) instructs the dispatcher to pass `prompt` (the shared passthrough for all modes), never `task`.

So the worker-browse dispatcher is told to call `mcp__<workersKey>__browse` with `{prompt: <brief>}`, but the tool requires `{task: <brief>}` and rejects unknown properties. A dispatcher that follows its prompt literally would either (a) send `prompt` and hit an `additionalProperties: false` / missing-required-`task` validation failure, or (b) have to infer on its own that `prompt`→`task` despite the prompt telling it `prompt`. The other five modes (explore/implement/review/plan/test) all require `prompt`, so the shared passthrough is correct for them and browse is the sole diverging tool — which is exactly why the shared `dispatcherPrompt` misfits it.

The public description of the browse tool (`peer-mcp-personas.ts:1908-1919`) even says the agent "accomplish[es] `task`" and "Dispatch via the Agent tool (subagent_type: worker-browse)", reinforcing that `task` is the intended field — the dispatcher prompt simply was not specialized when `browse` joined the modes.

## 6. Don't-nerf / right-balance

The routing trigger itself is right and the non-blocking framing raises the floor. The problem is a correctness bug in the injected system prompt, not a balance issue: the dispatcher is instructed to call its tool with the wrong argument name.

## 7. Findings + verdict

- **[Important] A3 — worker-browse dispatcher prompt passes `prompt`, but the browse tool requires `task`.** `dispatcherPrompt` (`worker-dispatch.ts:236`) hard-codes `prompt` for all modes; the browse tool schema requires `task` with `additionalProperties: false` (`peer-mcp-personas.ts:1922-1923`). browse is the only mode whose tool does not accept `prompt`, so the shared passthrough is wrong specifically for browse. Fix: branch `dispatcherPrompt` on `mode === "browse"` to instruct passing `task` (mirroring how it already branches the `worktree` line for implement/test at `worker-dispatch.ts:241`). Repro: a `worker-browse` invocation following its prompt literally sends `{prompt: …}` and the tool rejects it (missing required `task` / unknown property `prompt`). Reliability depends on the dispatcher model silently correcting the field name, which the prompt actively steers against.
- **[Suggestion]** Add a `worker-dispatch.ts` regression test asserting `dispatcherPrompt("browse", key)` mentions `task` (and does NOT tell the dispatcher to pass `prompt`), symmetric to the existing implement/test `worktree` coverage.

**Verdict: N (blocked on A3).** The routing trigger is fine, but the injected dispatcher system prompt instructs the wrong argument name (`prompt` vs the tool's required `task`), a confirmed correctness defect unique to browse.
