import consola from "consola"

import { SchedulerLease } from "~/lib/first-mate/scheduler/lease"

/**
 * The server-side scheduler that ticks the deterministic controller with NO
 * lead polling. Phase 1: it drives the existing `advance()` unchanged (all
 * judgments still go to the lead) — it only removes the Claude-side heartbeat
 * as the wake source and adds the reliability primitives the review required:
 * a fencing lease (single driver), capped backoff, a kill switch, and a
 * stuck-unit watchdog.
 *
 * It is intentionally driven through {@link tickOnce} so tests use a fake clock
 * with zero real timers. `start()` chains `tickOnce` via the injected timer.
 * The daemon IS auto-spawned at boot under `--agents` (see
 * `autospawn.maybeSpawnDaemon`, called from `server-setup.ts`), default-ON via
 * `GH_ROUTER_FM_DAEMON!=0`. The Claude `[fm-heartbeat]` stays armed as a passive
 * failover (it defers via the fencing lease while this daemon owns it). Honest
 * boundary: this only removes lead POLLING for the deterministic drive loop; it
 * does NOT push judgments to the lead — every judgment still wakes the lead via
 * the heartbeat.
 */
export interface AdvanceLike {
  nextWakeSeconds: number | null
  /** Opaque progress marker; the watchdog escalates when it stops changing. */
  progressKey?: string
  activeUnits?: number
}

export interface DaemonOptions {
  advance: () => Promise<AdvanceLike>
  lease: SchedulerLease
  nowMs?: () => number
  /** Injectable timer for tests. Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** ms floor/ceiling for backoff on error. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Consecutive no-progress ticks (with active units) before escalating. */
  stuckThreshold?: number
  onStuck?: (info: { progressKey: string; cycles: number }) => void
  /**
   * Consecutive `tickOnce` throws (advance() failing) before escalating a
   * persistent error. The error path never reaches the stuck watchdog, so
   * without this a permanently-failing advance() (bad creds, GitHub outage,
   * poison state) would back off forever in silence. Debounced: fires once when
   * the streak first crosses the threshold, then not again until a success
   * resets the streak.
   */
  errorThreshold?: number
  onError?: (info: { consecutiveFailures: number; error: string }) => void
  /**
   * Test seam: force a fixed inter-tick delay (ms), bypassing the
   * nextWakeSeconds [60,3600]s clamp. For the E2E harness only — production
   * leaves this unset so real cadence applies.
   */
  delayOverrideMs?: number
}

const CLAMP_MIN_S = 60
const CLAMP_MAX_S = 3600
const DEFAULT_MIN_BACKOFF_MS = 5_000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const DEFAULT_STUCK_THRESHOLD = 4
const DEFAULT_ERROR_THRESHOLD = 5

export interface TickResult {
  ran: boolean
  reason?: "not_owner"
  nextDelayMs: number
  stuckEscalated: boolean
  /** True on the tick where a persistent-error escalation fired. */
  errorEscalated?: boolean
}

export class SchedulerDaemon {
  private readonly opts: Required<
    Omit<
      DaemonOptions,
      "onStuck" | "onError" | "setTimer" | "clearTimer" | "nowMs" | "delayOverrideMs"
    >
  > &
    Pick<DaemonOptions, "onStuck" | "onError">
  private readonly delayOverrideMs: number | undefined
  private readonly setTimer: NonNullable<DaemonOptions["setTimer"]>
  private readonly clearTimer: NonNullable<DaemonOptions["clearTimer"]>
  private readonly lease: SchedulerLease

  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private consecutiveFailures = 0
  private errorEscalated = false
  private lastProgressKey: string | undefined
  private noProgressCycles = 0

  constructor(options: DaemonOptions) {
    this.lease = options.lease
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h))
    this.delayOverrideMs = options.delayOverrideMs
    this.opts = {
      advance: options.advance,
      lease: options.lease,
      minBackoffMs: options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      stuckThreshold: options.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD,
      errorThreshold: options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD,
      onStuck: options.onStuck,
      onError: options.onError,
    }
  }

  private backoffMs(): number {
    const exp = this.opts.minBackoffMs * 2 ** (this.consecutiveFailures - 1)
    return Math.min(exp, this.opts.maxBackoffMs)
  }

  /**
   * Run exactly one tick: acquire/renew the fencing lease, and only if we own
   * it call `advance`. Computes the next delay from `nextWakeSeconds` (or capped
   * backoff on error) and runs the stuck-unit watchdog. Pure w.r.t. timers.
   */
  async tickOnce(): Promise<TickResult> {
    const held = (await this.lease.renew()) ?? (await this.lease.tryAcquire())
    if (!held) {
      // Another driver owns a live lease — do nothing, re-check after one TTL-ish window.
      return { ran: false, reason: "not_owner", nextDelayMs: this.opts.minBackoffMs, stuckEscalated: false }
    }

    let result: AdvanceLike
    try {
      result = await this.opts.advance()
      this.consecutiveFailures = 0
      this.errorEscalated = false // healthy tick re-arms error escalation
    } catch (err) {
      this.consecutiveFailures += 1
      const delay = this.backoffMs()
      const message = err instanceof Error ? err.message : String(err)
      consola.warn(`first-mate daemon tick failed (#${this.consecutiveFailures}); backoff ${delay}ms:`, err)
      // Persistent-error escalation. The error path never reaches the stuck
      // watchdog, so escalate once when the failure streak first crosses the
      // threshold (debounced by errorEscalated until a success resets it).
      let errorEscalated = false
      if (this.consecutiveFailures >= this.opts.errorThreshold && !this.errorEscalated) {
        this.errorEscalated = true
        errorEscalated = true
        this.opts.onError?.({ consecutiveFailures: this.consecutiveFailures, error: message })
      }
      return { ran: true, nextDelayMs: delay, stuckEscalated: false, errorEscalated }
    }

    const stuckEscalated = this.runWatchdog(result)

    const nextDelayMs =
      this.delayOverrideMs ??
      (result.nextWakeSeconds === null
        ? this.opts.maxBackoffMs // idle portfolio: check back slowly
        : Math.min(Math.max(result.nextWakeSeconds, CLAMP_MIN_S), CLAMP_MAX_S) * 1000)

    return { ran: true, nextDelayMs, stuckEscalated }
  }

  private runWatchdog(result: AdvanceLike): boolean {
    const active = result.activeUnits ?? 0
    if (active <= 0) {
      this.noProgressCycles = 0
      this.lastProgressKey = result.progressKey
      return false
    }
    if (result.progressKey !== undefined && result.progressKey === this.lastProgressKey) {
      this.noProgressCycles += 1
    } else {
      this.noProgressCycles = 0
    }
    this.lastProgressKey = result.progressKey
    if (this.noProgressCycles >= this.opts.stuckThreshold) {
      this.opts.onStuck?.({ progressKey: result.progressKey ?? "", cycles: this.noProgressCycles })
      this.noProgressCycles = 0 // escalated; reset so we don't spam
      return true
    }
    return false
  }

  /** Begin the self-scheduling loop. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    const loop = async (): Promise<void> => {
      if (!this.running) return
      let delay = this.opts.minBackoffMs
      try {
        const res = await this.tickOnce()
        delay = res.nextDelayMs
      } catch (err) {
        consola.error("first-mate daemon loop error:", err)
        this.consecutiveFailures += 1
        delay = this.backoffMs()
      }
      if (!this.running) return
      this.timer = this.setTimer(() => void loop(), delay)
    }
    void loop()
  }

  /** Kill switch: stop scheduling and release the lease. Does not touch the proxy. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    await this.lease.release()
  }

  get isRunning(): boolean {
    return this.running
  }
}
