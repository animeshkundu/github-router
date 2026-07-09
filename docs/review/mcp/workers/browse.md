# Review: `mcp__workers__browse`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__browse` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `browse` |
| Definition | `src/lib/peer-mcp-personas.ts:1904` (NON_PERSONA_MCP_TOOLS entry); handler `runBrowseToolCall` at `src/lib/peer-mcp-personas.ts:2318` |
| Always-on? | gated by `browse_agent` capability; requires `--browse` |
| Capability gate | `browse_agent` → `browseAgentEnabled()` (`src/lib/mcp-capabilities.ts:248`) |
| Backing model / endpoint | `gpt-5.4-mini` (`BROWSE_DEFAULT_MODEL`, `src/lib/worker-agent/engine.ts:183`), high thinking (`BROWSE_DEFAULT_THINKING`, `engine.ts:186`); routed through the same Pi worker engine as explore/review/implement |
| Write-capable | no (drives a browser; no filesystem write tools — `mode: "browse"` uses `buildBrowseTools`, not `buildWorkerTools`) |
| Dispatcher subagent | `worker-browse` (bodies from `dispatcherDescription`/`dispatcherPrompt`, `src/lib/worker-dispatch.ts:215,226`) |

Gate detail (`browseAgentEnabled()`, `mcp-capabilities.ts:248-255`): requires `browserToolsEnabled()` (the `--browse` opt-in AND a supported browser on disk) AND the `gpt-5.4-mini` default present in the live catalog with a usable endpoint. Fires symmetrically at `tools/list` (`handler.ts:338`) and `tools/call` (`handler.ts:928-938`, -32601 on miss) — the same defense-in-depth as `worker`/`stand_in`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1908-1919`):

> Runs as the background `worker-browse` agent. Dispatch via the Agent tool (subagent_type: worker-browse) so your turn is never blocked; the result arrives as a completion notification. A Pi-driven autonomous browser agent (gpt-5.4-mini) that drives a real browser to accomplish `task` and returns the result. Runs in its own context to preserve the lead's window (raw DOM / page snapshots stay inside the agent). Pass `sessionId` to continue a prior session (its id is returned appended to the result as `[browse session: <id>]`); omit it for a fresh isolated session. Multiple concurrent calls run as parallel sessions on the one shared browser. Examples: "find the cheapest flight LHR-JFK next Tuesday", "log into the dashboard and read the current MRR", "summarize the top 3 HN front-page stories".

Input schema (`peer-mcp-personas.ts:1920-1948`), `required: ["task"]`, `additionalProperties: false`:

- `task` (string, required): "The browsing task — what to find, read, or do on the web. The agent plans its own navigate/click/read sequence and returns a single text answer."
- `sessionId` (string, optional): "Optional. The id of a prior browse session to CONTINUE (reuses its owned tabs). Read it from a previous call's `[browse session: <id>]` suffix. Omit for a fresh isolated session. An unknown id starts a fresh session."
- `workspace` (string, optional): "Optional absolute path. Browse ignores the filesystem, so this rarely matters; provided for parity with the other worker tools. Must be absolute when set."

### 2b. System prompt (`--append-system-prompt`)

`browse` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:567-646`). The worker sentence (`peer-mcp-personas.ts:600`) lists only the five core dispatchers:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). …

The browser paragraph (`peer-mcp-personas.ts:634-635`, gated on `browseAvailable`) describes the LEAD browser tools, a DIFFERENT capability:

> `mcp__browser__*` tools drive a real Chrome / Edge browser via a local extension. Lead surface: `__act(intent, value?)` … The lead never sees raw DOM: refs and bboxes stay internal.

So neither the browse WORKER nor its `worker-browse` dispatcher appears anywhere in the snippet. Its only system-prompt-adjacent surface is the `worker-browse` subagent's own body:

- Dispatcher description (`worker-dispatch.ts:215-216`, via `dispatcherDescription("browse")`): "Non-blocking `browse` worker: dispatches an autonomous browser agent in the background and delivers its result as a completion notification. Use proactively for any browse-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."
- Dispatcher system prompt (`worker-dispatch.ts:226-254`, via `dispatcherPrompt("browse", workersKey)`): the generic thin-dispatcher body shared by all six modes. It instructs the subagent to "Call the `mcp__<workersKey>__browse` tool EXACTLY ONCE, passing through the fields from the lead's brief: `prompt`: the lead's worker brief, copied verbatim …".

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored CLAUDE.md peer-awareness block is the SAME `buildPeerAwarenessSnippet` text (`appendPeerAwarenessToMirroredClaudeMd`, `src/lib/claude-md-injection.ts:653`), so 2c == 2b: browse is not named there either. No other injected marker block (style / operating-defaults / toolbelt / artifact-panel) covers it.

Checked-in root `CLAUDE.md`: the `### Browser-control MCP (--browse)` section (`CLAUDE.md:145-149`) documents ONLY the LEAD `mcp__browser__*` tool suite (the 19-tool set, install flow, session/tab-input invariants). The browse WORKER (`mcp__workers__browse` / `worker-browse`) is not mentioned anywhere in root CLAUDE.md — the worker-tools writeup in the peer-MCP section lists explore/review/implement/plan/test but not browse.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. The three example tasks (flight search, dashboard login, HN summary) teach the model exactly when to reach for it. The dispatcher framing ("Runs as the background `worker-browse` agent … so your turn is never blocked") is consistent with the other five worker tools and is pinned by `tests/peer-mcp-personas.test.ts:14-23`. There is no explicit "when NOT to use it" clause, but the contrast with the lead `mcp__browser__*` tools is implicit rather than stated — a model that has both surfaces could plausibly not know that browse is for delegated multi-step autonomy while the lead tools are for direct, in-context control.
- **Accuracy vs implementation**: model id `gpt-5.4-mini` matches `BROWSE_DEFAULT_MODEL` (`engine.ts:183`); the comment block above the tool (`peer-mcp-personas.ts:1884-1903`) accurately describes the gate and the session mechanic. "Multiple concurrent calls run as parallel sessions on the one shared browser" matches the session registry (`session-registry.ts`: per-session tab ownership, cap `GH_ROUTER_BROWSE_MAX_SESSIONS` default 6, LRU-idle eviction). The `[browse session: <id>]` suffix is really appended (`runBrowseToolCall`, `peer-mcp-personas.ts:2428`) and an unknown/absent `sessionId` really does start a fresh session (`peer-mcp-personas.ts:2372-2386`). No stale facts in the description itself.
- **Schema minimality**: `task` is required and load-bearing. `sessionId` is model-tunable and directly actionable (its origin — the result suffix — is spelled out, so a continuation call is discoverable from a prior result). `workspace` is the weak field: the description itself says "Browse ignores the filesystem, so this rarely matters; provided for parity" — an echoed-parity field the model has no useful reason to set. It is validated (absolute-only, `peer-mcp-personas.ts:2343-2367`) but never meaningfully consumed by a browser workload. Per the "ruthlessly minimal MCP tool surface" principle it is a candidate to drop; parity with the other worker tools is a real but weak justification.

### 3b. System-prompt coverage

- **Omitted from the worker sentence — by design, mostly.** Browse is gated separately (`browse_agent`, not `worker`) and only exists under `--browse`, whereas the worker sentence is gated on `workerToolsAvailable`. Threading a conditional browse clause into that sentence would require a second gate signal in `buildPeerAwarenessSnippet` and would name a tool that is absent on the common (no-`--browse`) launch. Leaving it out of the always-worker-sentence is defensible. The browse tool's own description + the `worker-browse` dispatcher description carry the routing signal, and the tool-description test (`tests/peer-mcp-personas.test.ts:14`) pins that. The cost of the omission is small: a lead in a `--browse` session sees `worker-browse` in the Agent-tool subagent list and sees `mcp__workers__browse` in `tools/list`, so the capability is discoverable without the snippet. This is an Important-or-lower gap, not Critical.
- **Not asserted either way.** Unlike `worker-explore`/`worker-implement` (pinned present in the snippet by `tests/peer-mcp-personas.test.ts:428-429`), `worker-browse`'s absence from the worker sentence is not pinned by any test — so if someone later adds a browse clause, no test guards the framing. Incidental, not enforced.
- **Framing-constraint compliance**: the snippet has no browse text to violate the constraint. The dispatcher description uses the documented "Use proactively" auto-delegation idiom (`worker-dispatch.ts:219`), which is the sanctioned pattern for subagent descriptions, not a disallowed system-prompt imperative.

### 3c. CLAUDE.md coverage

- **Mirrored block**: same as 2b (accurate by construction; browse simply absent).
- **Root CLAUDE.md drift**: the `--browse` section documents the lead browser suite but omits the browse WORKER entirely. A reader of root CLAUDE.md would not learn that `--browse` also unlocks a `mcp__workers__browse` / `worker-browse` autonomous browser agent gated on `browse_agent`. This is a real doc gap: the browse worker is a distinct architectural surface (its own Pi engine mode, own session registry, own capability gate) that shares only the `--browse` flag with the lead tools. Minor severity — the code is correct; the checked-in doc is incomplete.

### 3d. Cross-surface consistency

The one substantive inconsistency: the shared `dispatcherPrompt` (`worker-dispatch.ts:236-237`) tells EVERY dispatcher, including `worker-browse`, to call its worker tool passing `prompt: the lead's worker brief`. That is correct for the five core workers, whose MCP handler reads `arguments.prompt` (`runWorkerToolCall`, `peer-mcp-personas.ts:2143`). But the browse tool's schema requires `task` and forbids extra properties (`required: ["task"]`, `additionalProperties: false`, `peer-mcp-personas.ts:1922-1923`), and `runBrowseToolCall` reads only `args.task` (`peer-mcp-personas.ts:2325`) — an empty `task` returns `isError: true` "browse: arguments.task is required" (`peer-mcp-personas.ts:2326-2336`). The non-persona `tools/call` path passes args through raw with no MCP-boundary schema validation (`handler.ts:1173`), so nothing normalizes `prompt`→`task`. Net effect: a `worker-browse` subagent that follows its prompt literally and sends `{prompt: "…"}` gets a hard error. In practice the subagent also sees the tool's `task`-required schema in `tools/list` and a capable model will usually reconcile the two by sending `task`, so this is a latent/probabilistic defect rather than a guaranteed break — but the dispatcher prompt names a field the browse tool does not accept, which is a genuine contract mismatch and the most fixable finding here.

## 4. Findings

- **[Important]** `src/lib/worker-dispatch.ts:236-237` — the shared `dispatcherPrompt` instructs the `worker-browse` dispatcher to pass `prompt`, but the browse tool requires `task` (`peer-mcp-personas.ts:1922`) and rejects unknown keys (`additionalProperties: false`); `runBrowseToolCall` reads only `args.task` and errors on its absence (`peer-mcp-personas.ts:2325-2336`). A literal-following dispatcher sends `{prompt}` → hard `isError` "arguments.task is required". Repro: dispatch `Agent(subagent_type: "worker-browse", prompt: "summarize HN front page")`; if the subagent forwards `{prompt: <brief>}` per its instructions, the browse call fails. Fix: make the dispatcher prompt field name mode-aware — pass `task` (not `prompt`) for `mode === "browse"` in `dispatcherPrompt` — OR accept `prompt` as an alias in `runBrowseToolCall` (read `args.task ?? args.prompt`) and add `prompt` to the schema. The mode-aware prompt is the cleaner fix (keeps the tool surface minimal). Add a test asserting the browse dispatcher prompt names `task`.

- **[Suggestion]** `CLAUDE.md:145-149` — the checked-in `--browse` section documents only the lead `mcp__browser__*` suite and omits the browse WORKER (`mcp__workers__browse` / `worker-browse`, gated on `browse_agent`, backed by `gpt-5.4-mini`, own session registry). Add a short paragraph distinguishing the two `--browse` surfaces so the doc matches the code.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1940-1946` — the `workspace` field is self-described as "rarely matters … provided for parity" and is never meaningfully consumed by a browser workload. Consider dropping it per the minimal-surface principle, or keep it but this is the one echoed-parity field on the schema.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1908-1919` — the description gives no explicit "when NOT to use" contrast with the lead `mcp__browser__*` tools. In a `--browse` session both surfaces are visible; one sentence clarifying that browse is for delegated multi-step autonomy (own context) vs the lead tools for direct in-context control would sharpen routing. Non-blocking.

## 5. Verdict

Y (with one fix). The browse tool's own description is accurate, well-routed, and minimal apart from the parity `workspace` field; its separate `browse_agent` gate and absence from the always-on worker sentence are defensible by design. The single load-bearing fix: reconcile the `worker-browse` dispatcher prompt (which says `prompt`) with the browse tool's schema (which requires `task`) so a literal-following dispatcher cannot hard-error — make `dispatcherPrompt` name `task` for the browse mode.
