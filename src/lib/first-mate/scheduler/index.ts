import {
  advance,
  type AdvanceResult,
  type HumanRequest,
  type ModelRequest,
} from "~/lib/first-mate/controller"
import { occEnabled } from "~/lib/first-mate/ledger"

import { AnswerInbox } from "./answer-inbox"
import { SchedulerDaemon, type AdvanceLike, type DaemonOptions } from "./daemon"
import { EscalationQueue, type PushHook } from "./escalation"
import { SchedulerLease, makeDriveGate } from "./lease"
import {
  Tier1Shadow,
  fromModelRequest,
  isValidVerdictShape,
  shadowEnabled,
  tier1LiveEnabled,
} from "./shadow"

/**
 * Wiring for the server-side driver. The daemon holds a fencing lease and
 * decouples answer-submission (queued by deferring leads) from driving.
 * It IS auto-started at bootstrap: `server-setup.ts` calls
 * `maybeSpawnDaemon({ agentsEnabled })` after the server is ready (default-ON
 * under `--agents` via `GH_ROUTER_FM_DAEMON!=0`).
 */

/**
 * F5 — refuse to start the server-side daemon when ledger OCC is disabled.
 * GH_ROUTER_FM_OCC=0 turns off the cross-process lock, CAS, AND fencing on the
 * shared write path. The daemon is a SECOND driver alongside the in-process
 * `[fm-heartbeat]`; the lease gate makes a non-holder defer, but a driver whose
 * lease is stolen MID-sweep is only stopped from clobbering by fencing — which
 * is off under OCC=0. So daemon + heartbeat with OCC=0 reopens split-brain /
 * lost updates. Fail closed: the daemon does not start unless the operator both
 * disables OCC AND sets the explicit, separate GH_ROUTER_FM_ALLOW_UNSAFE_OCC=1
 * override (acknowledging a single-driver deployment). Exported for the test.
 */
export function assertOccSafeForDaemon(): void {
  if (occEnabled()) return
  if (process.env.GH_ROUTER_FM_ALLOW_UNSAFE_OCC === "1") return
  throw new Error(
    "first-mate daemon refuses to start with GH_ROUTER_FM_OCC=0: OCC is the only " +
      "thing that rejects a fenced-out driver's writes, so daemon+heartbeat with OCC " +
      "off reopens split-brain / lost updates. Re-enable OCC (unset GH_ROUTER_FM_OCC), " +
      "or — only if you truly run a SINGLE driver — set GH_ROUTER_FM_ALLOW_UNSAFE_OCC=1 " +
      "to override.",
  )
}

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
    | "minBackoffMs"
    | "maxBackoffMs"
    | "stuckThreshold"
    | "errorThreshold"
    | "setTimer"
    | "clearTimer"
    | "nowMs"
    | "delayOverrideMs"
  >
>

export interface ControllerDaemonOptions extends DaemonOverrides {
  /** Injectable push hook for escalations (tests / real wake channel). */
  push?: PushHook
  /**
   * Optional extra watchdog observers. These COMPOSE with (do not replace) the
   * built-in escalation-queue wiring, so a caller adding logging can never
   * silently unwire the durable escalation.
   */
  onStuck?: DaemonOptions["onStuck"]
  onError?: DaemonOptions["onError"]
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
  assertOccSafeForDaemon()
  const { push, onStuck: userOnStuck, onError: userOnError, ...daemonOverrides } = opts
  const lease = new SchedulerLease()
  const inbox = new AnswerInbox()
  const shadow = new Tier1Shadow()
  const escalation = new EscalationQueue(push ? { push } : {})

  return new SchedulerDaemon({
    lease,
    // #8 — the watchdog signals surface to the human via the durable escalation
    // queue (+ push hook). onStuck: a portfolio that stopped making progress
    // while units remain active. onError: advance() has failed N ticks in a row
    // (bad creds / outage / poison state) — the error path never reaches the
    // stuck watchdog, so this is its own escalation. Both are debounced by the
    // daemon; enqueue is fire-and-forget and never throws the tick. A
    // caller-supplied onStuck/onError COMPOSES (runs after) — it cannot unwire
    // the escalation.
    onStuck: (info) => {
      void escalation
        .enqueue({
          requestId: `stuck:${info.cycles}:${info.progressKey}`,
          kind: "stuck_portfolio",
          target: "human",
          reason: `no progress for ${info.cycles} consecutive wake(s) while units are active`,
        })
        .catch(() => undefined)
      userOnStuck?.(info)
    },
    onError: (info) => {
      void escalation
        .enqueue({
          requestId: `daemon-error:${info.consecutiveFailures}`,
          kind: "persistent_error",
          target: "human",
          reason: `first-mate daemon advance() failed ${info.consecutiveFailures} ticks in a row: ${info.error}`,
        })
        .catch(() => undefined)
      userOnError?.(info)
    },
    advance: async () => {
      const res = await advance({
        driveGate: makeDriveGate(lease),
        answerQueue: inbox,
        // #3 — fence every ledger write in the sweep with the held lease token,
        // and renew the lease before each dispatch (stop the wave if it was
        // stolen). makeDriveGate above has already renewed/acquired, so the
        // token is current by the time advance reads it.
        fenceToken: () => lease.fencingToken,
        renewLease: async () => (await lease.renew()) !== undefined,
      })
      // Auto-answer path is only wired when shadow/Tier1 is on; escalation of
      // everything else happens ALWAYS (routing-gap fix).
      const autoAnswer =
        shadowEnabled() || tier1LiveEnabled()
          ? async (req: ModelRequest): Promise<{ accepted: boolean }> => {
              const decision = await shadow.route(fromModelRequest(req))
              // Validate the verdict shape for this kind before enqueue — a
              // shape-invalid auto-accept must escalate, not apply as a no-op or
              // a malformed answer. (decideRoute already gates this; this is a
              // defence-in-depth check at the enqueue boundary.)
              if (decision.autoAccept && isValidVerdictShape(req.kind, decision.verdict)) {
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
export * from "./singleton"
