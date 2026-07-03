import { advance, type AdvanceResult } from "~/lib/first-mate/controller"

import { SchedulerDaemon, type AdvanceLike, type DaemonOptions } from "./daemon"
import { SchedulerLease } from "./lease"

/**
 * Phase 1 wiring. Nothing here is auto-started; the cutover (disarming the
 * Claude [fm-heartbeat] cron and starting this daemon against the live ledger)
 * is a deliberate, gated step. See ./README.md.
 */

/** Map the controller's rich result onto the daemon's minimal contract. */
export function advanceResultToAdvanceLike(res: AdvanceResult): AdvanceLike {
  let active = 0
  for (const row of res.board) {
    for (const [phase, n] of Object.entries(row.counts)) {
      if (phase !== "done") active += n
    }
  }
  // Stable snapshot of where every mission's units sit; the watchdog escalates
  // when this stops changing while units remain active.
  const progressKey = JSON.stringify(
    res.board.map((r) => [r.missionId, r.counts, r.blocked]),
  )
  return { nextWakeSeconds: res.nextWakeSeconds, activeUnits: active, progressKey }
}

type DaemonOverrides = Partial<
  Pick<
    DaemonOptions,
    | "onStuck"
    | "minBackoffMs"
    | "maxBackoffMs"
    | "stuckThreshold"
    | "setTimer"
    | "clearTimer"
    | "nowMs"
  >
>

/**
 * Build a daemon that drives the REAL controller `advance()` unchanged (all
 * judgments still escalate to the lead — Phase 1 changes only the wake source,
 * not autonomy). Holds a fencing lease so it cannot double-drive a live lead
 * heartbeat.
 */
export function createControllerDaemon(overrides: DaemonOverrides = {}): SchedulerDaemon {
  return new SchedulerDaemon({
    lease: new SchedulerLease(),
    advance: async () => advanceResultToAdvanceLike(await advance()),
    ...overrides,
  })
}

export * from "./lease"
export * from "./outbox"
export * from "./daemon"
export * from "./shadow"
