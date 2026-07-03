import {
  advance,
  type AdvanceResult,
  type HumanRequest,
  type ModelRequest,
} from "~/lib/first-mate/controller"

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
export interface EscalationSink {
  enqueue: (item: {
    requestId: string
    kind: string
    target: "lead" | "human"
    reason: string
    repo?: string
    missionId?: string
  }) => Promise<unknown>
}

function repoStr(repo?: { owner: string; name: string }): string | undefined {
  return repo ? `${repo.owner}/${repo.name}` : undefined
}

/**
 * Routing-gap fix (opus BLOCKER). When the daemon is the drive holder it CONSUMES
 * the advance() call, so the lead never sees the requests unless the daemon
 * surfaces them. This ALWAYS routes — independent of shadow/Tier1:
 *   - every needsModel escalates to the lead (unless an optional autoAnswer path
 *     auto-accepts it), and
 *   - every needsHuman escalates to the human queue.
 * Nothing is dropped when the daemon is primary.
 */
export async function routeAdvanceResult(
  res: { needsModel: ModelRequest[]; needsHuman: HumanRequest[] },
  deps: {
    escalation: EscalationSink
    autoAnswer?: (req: ModelRequest) => Promise<{ accepted: boolean }>
  },
): Promise<{ escalatedModel: number; escalatedHuman: number; autoAnswered: number }> {
  let escalatedModel = 0
  let escalatedHuman = 0
  let autoAnswered = 0
  for (const req of res.needsModel) {
    if (deps.autoAnswer) {
      const { accepted } = await deps.autoAnswer(req)
      if (accepted) {
        autoAnswered += 1
        continue
      }
    }
    await deps.escalation.enqueue({
      requestId: req.requestId,
      kind: req.kind,
      target: "lead",
      reason: "needs lead judgment",
      repo: repoStr(req.repo),
      missionId: req.missionId,
    })
    escalatedModel += 1
  }
  for (const h of res.needsHuman) {
    await deps.escalation.enqueue({
      requestId: h.requestId,
      kind: "human_decision",
      target: "human",
      reason: h.reason,
      repo: repoStr(h.repo),
      missionId: h.missionId,
    })
    escalatedHuman += 1
  }
  return { escalatedModel, escalatedHuman, autoAnswered }
}

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
      // Auto-answer path is only wired when shadow/Tier1 is on; escalation of
      // everything else happens ALWAYS (routing-gap fix).
      const autoAnswer =
        shadowEnabled() || tier1LiveEnabled()
          ? async (req: ModelRequest): Promise<{ accepted: boolean }> => {
              const decision = await shadow.route(fromModelRequest(req))
              if (decision.autoAccept) {
                await inbox.enqueue({
                  modelAnswers: [{ requestId: req.requestId, verdict: decision.verdict }],
                })
                return { accepted: true }
              }
              return { accepted: false }
            }
          : undefined
      await routeAdvanceResult(res, { escalation, autoAnswer })
      return advanceResultToAdvanceLike(res)
    },
    ...daemonOverrides,
  })
}

export * from "./answer-inbox"
export * from "./autospawn"
export * from "./calibration"
export * from "./escalation"
export * from "./lease"
export * from "./outbox"
export * from "./daemon"
export * from "./shadow"
