# Hook 4: `SessionStart` / `SessionEnd` ai-or-die session bind

## 1. Identity

| Field | Value |
|---|---|
| Events | `SessionStart` AND `SessionEnd` (both registered, no matcher) |
| Executable | `github-router internal-session-bind --out <sidecar>` (`src/internal-session-bind.ts`; command built by `buildSessionBindHookCommand`, `src/lib/orchestration/stop-gate-hook.ts:630-638`) |
| Gate | `AIORDIE_CLAUDE_BIND` env set and non-empty and containing no `"` (`src/claude.ts:784-790`) |
| Registration | `src/claude.ts:794-795` |
| Blocks the turn? | No, side-effect only, never writes stdout |
| Model-facing text | None |

Registered only when the proxy runs inside an ai-or-die Terminal tab (ai-or-die sets `AIORDIE_CLAUDE_BIND` to a per-tab sidecar path). On every startup / resume / clear / compact / exit it records the active Claude session id + transcript path to that sidecar, so ai-or-die can bind its sticky-note summariser to the exact transcript across `/resume`, `/clear`, and exit→relaunch.

## 2. Model-facing text (verbatim)

None. This hook never writes to stdout and injects nothing into the model's context. It writes only to the ai-or-die sidecar file. The `--out <path>` is baked into the command string as a literal arg (not env), so it survives `AIORDIE_CLAUDE_BIND` being stripped from the child env, and a nested `github-router claude` cannot hijack the parent tab (`src/claude.ts:774-793`).

## 3. Firing logic

- Fires on both `SessionStart` and `SessionEnd` for the top-level session; the subcommand skips subagent/teammate payloads via `agent_id`/`agent_type` (per the module doc-comment, same `isSubagentContext` pattern as the other hooks).
- Purely additive I/O to an app-controlled path. The sidecar path is refused defensively if it somehow contains a double-quote (would produce a malformed command): ai-or-die then falls back to its own inference path (`src/claude.ts:788-790`).

## 4. Firing-appropriateness verdict

**Fires correctly.** `SessionStart`/`SessionEnd` are exactly the lifecycle moments at which the transcript binding can change (new session, resume, clear, compact, exit), and recording on both endpoints is what lets the binding survive those transitions. There is no over-fire (it does trivial local I/O), no under-fire (it covers every transition that would otherwise orphan the binding), and no wrong-action (it writes only to the sidecar, never the model context). It is correctly gated behind the ai-or-die tab env so a non-tab session never registers it.

## 5. Injected-text quality (5a)

Not applicable: no model-facing text. This is the correct design: a session-binding side effect has nothing to say to the model, so it says nothing. This is a positive example of the "right amount" principle: a hook that injects zero text because zero is the right amount for its job.

## 6. Intelligent-hook analysis

Not a candidate. There is no decision to make: the binding must be recorded on every lifecycle transition; skipping any would break the summariser binding. A bounded-inference gate would add latency and failure surface to a deterministic bookkeeping write for no possible benefit. Correctly deterministic.

## 7. Findings

None. This hook is correct, minimal, and injects no model text: exactly right for a session-binding side effect.

**Verdict:** Correct and minimal. A side-effect-only lifecycle hook that fires at the right moments and says nothing to the model, which is the right amount. No fix.
