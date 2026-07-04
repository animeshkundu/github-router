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
  `advance()`; auto-spawned at boot (see below).

## Safety / status

- **The daemon IS auto-spawned at boot** under `--agents`: `server-setup.ts`
  calls `maybeSpawnDaemon({ agentsEnabled })` after the server is ready,
  default-ON via `GH_ROUTER_FM_DAEMON!=0` (set `=0` to disable).
  `scripts/first-mate-daemon.ts` is the standalone entry point for running it by
  itself.
- **The Claude `[fm-heartbeat]` stays armed as a passive failover** — it defers
  via the fencing lease while the daemon owns it, so the two never double-drive.
  Cutover does NOT require disarming the heartbeat; leaving it armed is the
  intended belt-and-suspenders.
- **Honest boundaries (not yet delivered):** the daemon removes lead *polling*
  for the deterministic drive loop but does NOT push judgments to the lead —
  every judgment still wakes the lead via the heartbeat (no server→lead push).
  The heartbeat failover covers an in-server daemon-task crash, not a host /
  process exit (there is no second always-on instance).
- **Landed since Phase 1:** holistic ledger-version CAS + fencing now covers the
  whole shared write path — unit ledger, missions registry, and decisions/
  approvals all route through `durable-store.commitJsonCas` (a stale-lease driver
  is rejected on any of them). The always-on host is now an assumed operating
  condition.
- **Still deferred (before enabling live Tier-1 auto-judge):** the AnswerInbox
  consumer must hard-reject `mode:"shadow"` records independent of
  `GH_ROUTER_FM_TIER1_LIVE` (so a future live flip can't consume a stale
  uncalibrated shadow verdict); live Tier1 routing behind
  verifiability/reversibility/policy gates + outcome calibration; per-action
  allowlists for what agents may touch. `GH_ROUTER_FM_TIER1_LIVE` stays OFF and
  `DETERMINISTIC_VERIFIERS` stays empty until those land.

## Test

    bun test tests/first-mate/scheduler/
