# `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` — MCP per-tool-call timeout

Governing lens: raise the floor, never nerf. This injection sets Claude Code's MCP
per-tool-call wait window to 6h15m. The floor question: does a large finite timeout let
long autonomous work complete (help) or does it mask hangs (hinder)?

## 1. Identity

| Field | Value |
|---|---|
| Vars | `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT` |
| Value injected | `resolveMcpToolTimeoutMs()` → default `22_500_000` ms (6h15m) |
| Where set | `src/lib/server-setup.ts:607-611` |
| Value source | `src/lib/worker-agent/budget.ts:111-113` (`resolveMcpToolTimeoutMs`) |
| Guard | presence-based, PER KEY — `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT` each injected only when `process.env.<key> === undefined` |
| Opt-out / override | `GH_ROUTER_MCP_TOOL_TIMEOUT_MS=<positive int>`, or set either key directly in the parent shell |
| Design doc | `docs/peer-mcp-design.md` (worker tools + timeout) |

Neither key is in `STRIPPED_PARENT_ENV_KEYS`, so an unset override lets the parent value
flow through naturally.

## 2. What it does + behavior effect

Two distinct env vars, per binary inspection of v2.1.141 (`src/lib/server-setup.ts:566-600`):

- **`MCP_TOOL_TIMEOUT`** is the load-bearing one. v2.1.141's `y13()` reads
  `parseInt(process.env.MCP_TOOL_TIMEOUT)` for the per-tool-call timeout passed to the
  MCP SDK's `.callTool(..., {timeout: W})`. Default when unset is `1e8` ms (~27.7h).
- **`MCP_TIMEOUT`** is the historical/general timeout (server startup / handshake), NOT
  confirmed to reach the per-call path on v2.1.138-141. Kept belt-and-suspenders.

The injection is the **load-bearing fix for Claude Code v2.1.113+'s MCP per-tool-call
timeout regression** (GitHub #50289 / #52137, which documented the per-call path silently
capping at ~60s). Setting a finite-but-large value both surfaces any future regression
where the SDK silently caps low AND bounds runaway calls, while being high enough that an
autonomous worker can do its full 6h of work and still return before the harness gives up.

**The invariant** (`src/lib/worker-agent/budget.ts:33-46, 115-125`): the worker wall-clock
(default 6h, per-call overridable) is clamped to `workerWallClockCeilingMs()` =
`MCP_TOOL_TIMEOUT − MCP_TIMEOUT_HEADROOM_MS` (15 min). So a non-converging worker hits its
OWN wall-clock first, raises `WorkerAbort`, and the engine returns partial work +
`[halted: wallclock]` a full headroom BEFORE the harness hard-kills the call (returning
nothing). 6h worker < 6h15m MCP cap. Both numbers live in one module so they can't drift.

Note: without the SDK's `resetTimeoutOnProgress` opt-in (which Claude Code does not pass),
SSE progress events do NOT reset the per-call timer — so `MCP_TOOL_TIMEOUT` is the actual
lever for long-running peer-MCP/worker calls, not the SSE transport (`server-setup.ts:594-600`).

## 3. Raise-the-floor assessment

**Expands capability — decisively.** Without this injection, the upstream regression caps
MCP tool calls at ~60s, which would make every long peer-critic call and every autonomous
worker run fail. This is the single env var that makes the 6h worker surface viable at all.
It removes a ceiling; it does not add one that bites real work.

**Is the default the best choice?** Yes, and it's well-reasoned:

- Finite (not the `1e8` default) so a genuinely hung call is eventually reaped and a future
  silent-cap regression surfaces instead of hiding.
- Large enough (6h15m) that the full 6h worker budget plus 15 min graceful teardown fits
  under it — the headroom is exactly the delivery budget for partial work.
- The single-source-of-truth coupling (`budget.ts` owns both the timeout and the headroom)
  is the right design: the "worker wall-clock + headroom ≤ MCP timeout" invariant cannot
  drift because the two numbers are derived, not duplicated.

**Does it hinder (mask hangs)?** Minimally. A truly stuck call burns up to 6h15m before
the harness kills it — long, but the worker's own wall-clock (+ turn / tool-byte / repeated-call
caps in `budget.ts`) fires far earlier for worker calls, and peer-critic calls have their
own `predictedTooLong` pre-flight. The large window is a deliberate trade: tolerate a rare
long hang to never truncate legitimate long work.

**Drift risk.** The `y13()` / `1e8`-default / `resetTimeoutOnProgress` facts are pinned to
v2.1.138-141. If a future build fixes #50289 or renames the env var, the injection becomes
a harmless no-op (the value is valid either way) — graceful degradation, no capability loss.

## 4. Findings

- **[Suggestion]** `src/lib/server-setup.ts:566-611` — the behavior is pinned to Claude
  Code v2.1.138-141 binary internals (`y13()`, the `1e8` default, the silent-cap
  regression). If upstream fixes the regression and honors SSE progress resets, the finite
  6h15m cap becomes slightly conservative vs the `1e8` default. Not a bug (finite is safer),
  but worth re-checking against newer builds so the value isn't needlessly tight if the
  regression is gone.
- No Critical/Important findings. The value, the coupling, and the presence guard are correct.

## 5. Verdict

Correct and floor-raising: this is the injection that unblocks the entire long-running
MCP/worker surface past the upstream #50289 regression. The finite-but-large value plus the
single-source headroom coupling is exactly right — it removes the ceiling that would break
real work while still bounding runaway calls. No nerf; only residual risk is the value
being pinned to specific binary internals.
