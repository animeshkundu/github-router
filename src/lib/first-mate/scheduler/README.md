# first-mate scheduler (Phase 1)

Server-side reliability layer for the first-mate controller. Phase 1 added the
safety primitives the cross-lab design review required; Phase 2 adds default-on
Tier1 shadow/live routing for a narrow non-merge offload envelope. `author_fix`,
`answer_agent_question`, and `decompose` may auto-answer only when high-confidence,
known, low-stakes, valid-shaped, and verifier/downstream-check safe; plan, judge,
and merge-authorizing judgments still escalate.

## Modules

- **`lease.ts`** — single-driver lease with a monotonic **fencing token**. The
  token, not the lease, is the safety boundary: a stalled/slept driver holding
  an old token is rejected at commit via `isCurrentFencingToken()`, so two
  drivers can never both write the ledger (the split-brain finding).
- **`outbox.ts`** — durable outbox that separates intent from execution. An
  executor maps GitHub "already applied" errors (409/422/405) to `already`,
  which settles as success — killing the poison-pill retry livelock.
- **`daemon.ts`** — the tick loop: renew/acquire the fencing lease, and only if
  owned call `advance()`; schedule the next tick from the controller's own
  `nextWakeSeconds`; capped exponential backoff on error; a **kill switch**
  (`stop()`) that never touches the proxy; a **stuck-unit watchdog** that
  escalates after N no-progress cycles. Driven via `tickOnce()` for hermetic,
  timer-free tests.
- **`shadow.ts`** — Tier-1 shadow/live router. It records what a mid-tier model
  WOULD decide vs what the lead decided, and it can feed back auto-answers for
  the safe allowlist (`author_fix`, `answer_agent_question`, `decompose`) only
  under the confidence/known/low-stakes/verifier gates. Everything uncertain and
  every plan/judge/merge-authorizing judgment escalates. Shadow logging and live
  routing are default-on; opt out with `GH_ROUTER_FM_SHADOW=0` or
  `GH_ROUTER_FM_TIER1_LIVE=0`.
- **`index.ts`** — `createControllerDaemon()` wires the daemon to the real
  `advance()`; auto-spawned at boot (see below).

## Safety / status

- **The daemon is OPT-IN, default OFF** — auto-spawn at boot requires
  `GH_ROUTER_FM_DAEMON=1` (under `--agents`). The **[fm-heartbeat] cron is the
  default driver** and the proven path. Default-on is deferred until the two
  remaining hardening items below land — a proxy that crashes or orphans a
  drive-primary daemon on boot is worse than the heartbeat it replaces.
- **Never crashes the proxy:** the spawn attaches an async `'error'` listener
  (an ENOENT from a missing `bun` arrives as an event, not a sync throw — without
  the listener it becomes `uncaughtException` → `exit(1)`), and no-ops when the
  daemon `.ts` entry is absent (dist/global installs don't ship it).
- **Never orphans:** `server-setup.ts` stores the spawn handle and kills it on
  `exit`/`SIGINT`/`SIGTERM`. An orphaned drive-primary daemon would keep renewing
  the lease and merging PRs after the proxy is gone. (Windows lacks process-group
  reaping; a Job Object is a further hardening TODO for SIGKILL.)
- **When opted in**, the daemon holds the fencing lease and the [fm-heartbeat]
  degrades to a passive failover via the shared lease/`driveGate`, so the two
  never double-drive. Honest boundary: this removes lead *polling* for the
  deterministic drive loop only; live judgments still wake the lead via the
  heartbeat (no server→lead push), and the failover covers an in-server
  daemon-task crash, not a host/process exit.
- **Landed:** holistic ledger-version CAS + fencing across the whole shared
  write path (unit ledger + missions registry + decisions/approvals via
  `durable-store.commitJsonCas`); a token-verified atomic-claim stale-lock break
  in `withFileLock` (never unlink-to-steal). Always-on host is assumed.
- **Remaining hardening:** a verifier-stall wall-clock escalation (a unit awaiting
  a Copilot review that never lands currently noops with no escalation — the
  `totalFixes` cap only advances on the fix path); the AnswerInbox consumer must
  hard-reject `mode:"shadow"` records independent of `GH_ROUTER_FM_TIER1_LIVE`;
  convergence accounting plus the full decision-table exposition (Phase 3); a
  Windows Job Object for the child.

## Test

    bun test tests/first-mate/scheduler/
