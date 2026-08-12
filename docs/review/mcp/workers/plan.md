# MCP tool: `workers.plan`

## Identity

| Field | Value |
|---|---|
| MCP-facing name | `plan` under the `workers` server |
| Backing mode | Read-only Pi worker, `mode: "plan"` |
| Default model | `PLAN_DEFAULT_MODEL = "claude-opus-5"` (exact live-catalog id) |
| Default thinking | `high`; callers can request a higher tier per call or through `worker_defaults` |
| Workspace | Optional absolute path; defaults to the proxy launch cwd |

## Routing description

The tool is surfaced through the non-blocking `worker-plan` dispatcher. It reads the repository and returns an ordered implementation plan covering files, approach, risks, and verification. It does not edit files, author tests, or perform the implementation.

## Runtime contract

The plan model is deliberately the strongest planning model in the default catalog, while the built-in effort now favours time-to-outcome at `high`. Per-call `thinking` overrides session defaults, which override the built-in, so a caller can restore `xhigh` when the task warrants it. If Opus 5 is absent, the mode returns a helpful model-resolution error rather than disabling the whole worker surface.

The worker uses the read-only tool surface and shares the normal worker budgets, compaction, relay cap, and non-blocking dispatcher behavior.

## Findings + verdict

- **Default drift resolved.** Earlier review text still described the former `xhigh` built-in. The runtime default is now `high`, with higher effort remaining caller-selectable.
- **Description remains honest.** The user-visible schema describes the default as high and the allowed effort enum still includes `xhigh`.

**Verdict: Y.** The review now matches the live `claude-opus-5` / `high` default and its override contract.
