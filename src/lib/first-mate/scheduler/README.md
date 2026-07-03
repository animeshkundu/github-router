# first-mate scheduler (Phase 1)

Server-side reliability layer for the first-mate controller. Phase 1 removes the
Claude-side polling heartbeat as the wake source and adds the safety primitives
the cross-lab design review required. **It does not change autonomy** — every
judgment (`decompose` / `review_plan` / `judge_review` / `author_fix`) still
escalates to the lead exactly as today.

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
- **`shadow.ts`** — Tier-1 **shadow mode** (Phase 2 scaffolding, log-only). It
  records what a mid-tier model WOULD decide vs what the lead decided, building
  the calibration record that later gates a narrow, verifiability-scoped live
  rollout. Never influences control flow; disabled unless `GH_ROUTER_FM_SHADOW=1`.
- **`index.ts`** — `createControllerDaemon()` wires the daemon to the real
  `advance()`. Not auto-started.

## Safety / status

- Nothing here is wired into `bun run start`. The daemon runs only via the gated
  `scripts/first-mate-daemon.ts` (`GH_ROUTER_FM_DAEMON=1`).
- **Cutover is a separate operator step**: disarm the Claude `[fm-heartbeat]`
  cron BEFORE starting the daemon against the live ledger.
- Deferred to later phases (per review): full ledger-version CAS on the shared
  write path, live Tier1 routing behind verifiability/reversibility/policy gates
  + outcome calibration, running the daemon on an always-on host, and per-action
  allowlists for what agents may touch.

## Test

    bun test tests/first-mate/scheduler/
