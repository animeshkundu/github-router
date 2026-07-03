import { advance, type AdvanceResult, type ModelRequest } from "~/lib/first-mate/controller"

import { AnswerInbox } from "./answer-inbox"
import { SchedulerDaemon, type AdvanceLike, type DaemonOptions } from "./daemon"
import { EscalationQueue, type PushHook } from "./escalation"
import { SchedulerLease, makeDriveGate } from "./lease"
import {
  Tier1Shadow,
  fromModelRequest,
  shadowEnabled,
  tier1LiveEnabled,
} from "./shadow"

/**
 * Wiring for the server-side driver. The daemon holds a fencing lease and
 * decouples answer-submission (queued by deferring leads) from driving.
 * Auto-starting it at bootstrap is the capstone step (not done here).
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
    | "delayOverrideMs"
  >
>

export interface ControllerDaemonOptions extends DaemonOverrides {
  /** Injectable push hook for escalations (tests / real wake channel). */
  push?: PushHook
}

function toRepo(req: ModelRequest): { owner: string; name: string } | undefined {
  return req.repo ? { owner: req.repo.owner, name: req.repo.name } : undefined
}

/**
 * Build the server-side driver daemon. It:
 *  - holds a fencing lease (driveGate) so it never double-drives the heartbeat;
 *  - drains + applies answers the lead queued while deferring (answerQueue);
 *  - when shadow/live Tier1 is enabled, routes each emitted judgment: an
 *    allowlisted, high-confidence, reversible verdict is AUTO-ANSWERED (enqueued
 *    for the next tick to apply); everything else is ESCALATED (durably queued +
 *    push hook). Shadow logging always records for calibration.
 * With both flags off (default) it behaves exactly like the pre-Phase-3 daemon.
 */
export function createControllerDaemon(opts: ControllerDaemonOptions = {}): SchedulerDaemon {
  const { push, ...daemonOverrides } = opts
  const lease = new SchedulerLease()
  const inbox = new AnswerInbox()
  const shadow = new Tier1Shadow()
  const escalation = new EscalationQueue(push ? { push } : {})

  return new SchedulerDaemon({
    lease,
    advance: async () => {
      const res = await advance({ driveGate: makeDriveGate(lease), answerQueue: inbox })
      if ((shadowEnabled() || tier1LiveEnabled()) && res.needsModel.length > 0) {
        for (const req of res.needsModel) {
          const decision = await shadow.route(fromModelRequest(req))
          if (decision.autoAccept) {
            await inbox.enqueue({
              modelAnswers: [{ requestId: req.requestId, verdict: decision.verdict }],
            })
          } else {
            await escalation.enqueue({
              requestId: req.requestId,
              kind: req.kind,
              target: "lead",
              reason: decision.reason,
              repo: toRepo(req) ? `${req.repo.owner}/${req.repo.name}` : undefined,
              missionId: req.missionId,
            })
          }
        }
      }
      return advanceResultToAdvanceLike(res)
    },
    ...daemonOverrides,
  })
}

export * from "./answer-inbox"
export * from "./escalation"
export * from "./lease"
export * from "./outbox"
export * from "./daemon"
export * from "./shadow"
