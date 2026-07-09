# Hook 2: `PreToolUse` workers non-blocking guard

## 1. Identity

| Field | Value |
|---|---|
| Event | `PreToolUse` |
| Matcher | `^mcp__<workersKey>__(explore\|implement\|review\|plan\|test)$` (adds `\|browse` when `browseAgentEnabled()`), `guardToolMatcher` (`src/lib/worker-dispatch.ts:88-91`) |
| Executable | `github-router internal-worker-guard --workers-key <k> --modes <csv>` (`src/internal-worker-guard.ts`) |
| Decision logic | `decideWorkerGuard` (`src/lib/worker-dispatch.ts:154-197`) |
| Gate | `workerToolsEnabled()` AND `injected.ok` AND NOT `GH_ROUTER_DISABLE_WORKER_GUARD=1` (`src/claude.ts:711-740`) |
| Registration | `src/claude.ts:736`, host `timeout` 10s |
| Blocks the tool? | Yes, prints a `permissionDecision: "deny"` JSON to stdout (does not use exit 2) |

The `workers` MCP tools block the caller for up to 6h. The main agent must never block on one, so a raw `mcp__<workersKey>__<mode>` call from the main thread is DENIED and redirected to the matching `worker-<mode>` background dispatcher subagent. The call is ALLOWED only when it originates inside that dispatcher (`agent_type === "worker-<mode>"`).

The matcher's `<workersKey>` is the resolved server key (bare `workers`, or a `gh-router-workers-N` fallback on user collision) and the mode alternation is the active dispatch modes: both baked into the command args so a changed resolution produces a distinct, non-stale hook entry (`worker-dispatch.ts:277-289`).

## 2. Model-facing text (verbatim)

No injected system-prompt / CLAUDE.md text. The only model-facing string is the deny reason shown when the guard fires: `guardDenyReason` (`src/lib/worker-dispatch.ts:109-119`):

> Workers run as background subagents in this session so your turn never blocks. Re-issue this as `Agent(subagent_type: "worker-<mode>", prompt: <your worker brief>)`. It returns immediately and delivers the worker's result as a completion notification — do not call the raw `mcp__…__` worker tool from the main thread.

On an unparseable payload the target degrades to a generic "the matching background `worker-*` agent via the Agent tool" (`:110-112`).

## 3. Firing logic

- The matcher scopes the hook to exactly the active worker tools: anchored, exact alternation, so an unrelated `mcp__<key>__status` never invokes it (`worker-dispatch.ts:81-91`).
- `decideWorkerGuard` (`:154-197`) rules, fail-toward-protecting-the-invariant:
  - Payload unparseable / no `tool_name` → DENY (fail closed; the matcher only routes worker calls here, so an unreadable one is still a worker call) (`:169-174`).
  - `tool_name` not a recognized worker tool for this key → ALLOW (matcher over-fired) (`:176-181`).
  - `agent_type` equals the EXACT dispatcher name for this mode → ALLOW (`:183-190`). Exact-mode match, so a read-only `worker-explore` cannot invoke the write-capable `implement` worker.
  - Otherwise (main agent: `agent_type` absent; a non-dispatcher subagent; or a dispatcher for a different mode) → DENY + redirect (`:192-196`).
- Gating: registered ONLY when `injected.ok` (subagents can see the workers MCP). On the collision fallback (parent-only `--mcp-config`, subagents blind) the guard is skipped so the main agent is not left with both a deny AND no working dispatcher (`src/claude.ts:711-717`). Opt-out `GH_ROUTER_DISABLE_WORKER_GUARD=1` restores the raw blocking call (`:718-723`).

## 4. Firing-appropriateness verdict

**Fires correctly.** This is a precise, well-scoped structural guard, not a heuristic.

- The matcher fires only on the exact tools that can block, and only for calls that are NOT from the sanctioned dispatcher. There is no over-fire (the exact-alternation matcher + the allow-non-worker branch handle any matcher slop) and no under-fire (fail-closed on an unreadable payload).
- The gating is correct: it refuses to register in the one state where registering would break the session (subagents blind), and it has an explicit escape hatch.
- The exact-mode allow (not "any dispatcher") is a genuine security property: it prevents a read-only dispatcher from being redirected/injected into invoking the write-capable worker.

The only nuance: it denies ALL non-dispatcher subagents too (`:192-196`), which the code justifies as closing the transitive-blocking hole (a foreground subagent that blocked on a worker would transitively block the main agent). This is correct for the non-blocking invariant, though it means a user-authored subagent cannot call a worker tool directly: it must also go through the `worker-*` dispatcher. Intended, documented.

## 5. Injected-text quality (5a)

Only the deny reason is model-facing. It is well-written:

- **Descriptive + actionable:** it states WHY (workers block; your turn never blocks) and gives the exact remediation (`Agent(subagent_type: "worker-<mode>", …)`) with the mode filled in. The model can act on it next call without guessing.
- **No over-trigger:** the one imperative ("do not call the raw `mcp__…__` worker tool from the main thread") is appropriate here: this IS a hard structural rule, not a soft preference, so a firm phrasing is correct (unlike a steer, where firmness would over-trigger).
- **Right amount:** three sentences, no padding. Minimal and complete.

## 6. Intelligent-hook analysis

Not a candidate for a bounded-inference gate, and correctly so. This is a deterministic structural invariant (a raw worker call from the main thread WILL block the turn: that is certain, not context-dependent), so inference would add latency and non-determinism for zero benefit. The right design for a certain, binary condition is exactly what is here: a pure, fast, local decision. An intelligent gate would be a regression (it would risk fail-open letting a blocking call through). Leave it deterministic.

## 7. Findings

- **[Suggestion] The deny path uses `permissionDecision: "deny"` JSON, not exit 2: worth a one-line note in the doc-comment for contrast with hook #3.** `guardDenyOutput` (`worker-dispatch.ts:122-130`) emits the structured PreToolUse decision on stdout, which is the correct mechanism for a permission verdict (it surfaces the reason to the model cleanly). Hook #3 (operator guard) uses exit 2 instead. Both are valid; the divergence is intentional (this hook redirects, the operator hook hard-blocks) but undocumented. No code change needed.

**Verdict:** Correct, minimal, well-routed. A deterministic structural guard doing exactly the right thing at exactly the right moment; the deny reason is a model of actionable hook feedback. No fix required.
