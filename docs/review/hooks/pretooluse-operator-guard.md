# Hook 3: `PreToolUse` operator guard (`--agents`)

## 1. Identity

| Field | Value |
|---|---|
| Event | `PreToolUse` |
| Matcher | `mcp__workers__.*\|mcp__orchestrate__.*`, `FIRST_MATE_GUARD_MATCHER` (`src/internal-first-mate-guard.ts:72`) |
| Executable | `github-router internal-first-mate-guard` (`src/internal-first-mate-guard.ts`) |
| Decision logic | `operatorPreToolUse` / `shouldDenyOperatorTool` (`src/lib/first-mate/operator-shaping.ts:69-109`) |
| Gate | `agentToolsEnabled()`, i.e. `--agents` / `GH_ROUTER_ENABLE_AGENTS=1` + GitHub agent token (`src/claude.ts:753`) |
| Registration | `src/claude.ts:758-764`, no host timeout override |
| Blocks the tool? | Yes, exit code 2 with the reason on stderr |
| Install failure | Launch-FATAL, `assertShapingInstalled` throws if the hook can't be written (`src/claude.ts:771`, `operator-shaping.ts:80-87`) |

In `--agents` operator mode the spawned Claude is the cloud-agent OPERATOR, not the product implementer. Local `mcp__workers__*` / `mcp__orchestrate__*` tools are kept subagent-only for the main operator so the lead context stays small and implementation is delegated to GitHub cloud agents or the `worker-*` subagents. File writes and Bash are NOT blocked (a deliberate relaxation from an earlier hard-block design: `operator-shaping.ts:6-8`).

## 2. Model-facing text (verbatim)

No injected system-prompt / CLAUDE.md text from this hook. The only model-facing string is the exit-2 block reason: `operatorPreToolUse` (`src/lib/first-mate/operator-shaping.ts:105`):

> `<toolName>` is subagent-only in cloud-agent operator mode — use the worker-* Agent subagents or delegate implementation to a GitHub cloud agent via the first-mate MCP instead of calling local worker/orchestrate MCP tools from the main operator.

On a named-but-unparseable payload the guard fails closed with "operator guard: unparseable PreToolUse payload: blocking (fail-closed)" (`internal-first-mate-guard.ts:56`).

Note: `OPERATOR_MODE_BANNER` (`operator-shaping.ts:36-43`) is a SEPARATE constant that reads like the operator's mode banner, but it is NOT injected by this hook or anywhere else in `src/` (see §7).

## 3. Firing logic

- The matcher routes only `mcp__workers__*` and `mcp__orchestrate__*` calls to the guard (`FIRST_MATE_GUARD_MATCHER`, `:72`). Note it is a FIXED prefix (`mcp__workers__`), not the resolved `<workersKey>`: so on a user-collision key rename this matcher would not match the renamed server (see §7).
- `shouldDenyOperatorTool` (`operator-shaping.ts:69-72`): denies iff operator mode AND the tool name starts with `mcp__workers__` or `mcp__orchestrate__`. `OPERATOR_DENIED_TOOLS` is empty (`:17`): no exact-name denials.
- The guard is injected only in operator mode, so the subcommand hardcodes `operatorMode = true` (`internal-first-mate-guard.ts:62`).
- Fail-closed on an unparseable payload with a nonempty implied tool (`:55-58`); allow on a genuinely empty tool name (`:59`).
- Install is a launch-fatal precondition: if the hook can't be written, `assertShapingInstalled(true, false)` throws rather than start an unguarded operator session (`operator-shaping.ts:80-87`).

## 4. Firing-appropriateness verdict

**Right mechanism, but it likely over-blocks the recommended workaround (and has a matcher-scope gap).**

- The intent (keep worker/orchestrate off the main operator thread, allow via subagents) is a structural policy, and a deterministic PreToolUse block is the right mechanism. No over-fire on non-worker tools: Bash / Edit / Write / Read / first-mate tools all pass.
- Fail-closed on an unparseable denied-tool payload is the safe direction for a capability boundary.
- **Over-block (the serious one):** because #3 denies by prefix without checking `agent_type`, and PreToolUse fires inside subagents (the premise #2 is built on), the `worker-<mode>` dispatcher's own `mcp__workers__<mode>` call is caught by #3 and denied, even though #2 allows it. The one deny wins. So the exact `worker-*` delegation this guard's reason recommends is itself blocked in operator mode. See §7 finding 1.
- **Matcher-scope gap:** the matcher is the literal `mcp__workers__.*`, but the workers server key can be resolved to `gh-router-workers-N` on a user collision (per `resolveGroupKeysFromMirror`). Hook #2 bakes the RESOLVED key into its matcher; this hook does not. In the (rare) collision case the operator guard's matcher would not fire on the renamed server, leaving the main operator able to call the renamed worker tool directly.

## 5. Injected-text quality (5a)

Only the block reason is model-facing:

- **Descriptive + actionable:** names the offending tool, states the rule (subagent-only in operator mode), and gives two concrete remediations (worker-* Agent subagents, or delegate to a cloud agent via first-mate). The model can act next call.
- **No over-trigger:** the firmness is appropriate: this is a hard capability boundary in a specific mode, not a soft steer, so imperative phrasing is correct.
- **Right amount:** one sentence, complete.

## 6. Intelligent-hook analysis

Not a candidate for bounded inference. Like hook #2, this is a deterministic capability boundary: whether a tool is worker/orchestrate is a pure name check, and the policy (subagent-only) is fixed, not context-dependent. Inference would add latency and a fail-open risk (a fail-open on a security boundary would let a blocked call through, violating widen-not-narrow in the wrong direction). Keep it deterministic and fail-closed. The correct improvement here is scope (resolve the key into the matcher), not intelligence.

## 7. Findings

- **[Important] In operator mode this guard likely over-blocks the very `worker-*` subagents its own deny reason recommends.** #3 hardcodes `operatorMode=true` (`internal-first-mate-guard.ts:62`) and denies any `mcp__workers__*` / `mcp__orchestrate__*` call by tool-name PREFIX, without inspecting `agent_type`. But in `--agents` mode the workers guard (#2) is ALSO registered, and #2's entire design (`decideWorkerGuard`, `worker-dispatch.ts:183-190`) proves PreToolUse fires INSIDE the `worker-<mode>` dispatcher subagent (it discriminates by `agent_type === "worker-<mode>"`). Claude Code applies a single deny across all matching PreToolUse hooks, so when the dispatcher subagent makes its `mcp__workers__<mode>` call, #2 ALLOWS it but #3 DENIES it (it does not check the caller), and the deny wins. That blocks the exact `worker-*` delegation path this guard's reason (`operator-shaping.ts:105`) and the operator banner tell the model to use. Fix: #3 must ALSO allow the `worker-<mode>` dispatcher `agent_type` (mirror #2's allow branch), or exclude dispatcher-originated calls from its prefix deny. Verify against a live operator session before landing, but the in-repo evidence (#2's own premise) strongly implies the block. This is the mode-defining guard blocking the mode's intended workflow.
- **[Important] The matcher uses the fixed `mcp__workers__` prefix, not the resolved workers key.** `internal-first-mate-guard.ts:72` hardcodes `mcp__workers__.*|mcp__orchestrate__.*`. If the workers/orchestrate server key was renamed to a `gh-router-<group>-N` fallback on a user-side collision, this guard would not match, and the operator could call the renamed worker tool directly from the main thread. Fix: build this matcher from the resolved group keys the same way hook #2 does (`guardToolMatcher` bakes the resolved key), or assert the operator guard is registered against the resolved keys. Narrow (collision-only) but it is a capability-boundary hole in the mode that most wants the boundary.
- **[Suggestion] `OPERATOR_MODE_BANNER` is defined and tested but never injected.** `operator-shaping.ts:36-43` + `tests/first-mate/operator-shaping.test.ts:63`: the constant exists and its content is asserted, but no code path injects it into `--append-system-prompt` or the mirrored CLAUDE.md. Operator steering reaches the model only through the `/gh-first-mate` skill. Either wire the banner into the operator session's system prompt (its content is good, self-describing mode text) or delete the constant + test as dead. As-is it is a maintenance trap: a reader assumes the operator sees this banner, and it does not.

**Verdict:** The block reason is clean and the mechanism is right, but the guard most likely blocks the `worker-*` delegation path it recommends (it denies by prefix without allowing the dispatcher `agent_type` the way #2 does), and its matcher should be built from the resolved key. Fix the dispatcher over-block first; it defeats the mode's own intended workflow.
