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
 * Nothing here is auto-started; wiring to the live controller + cutover is a
 * separate, gated step.
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
}

const CLAMP_MIN_S = 60
const CLAMP_MAX_S = 3600
const DEFAULT_MIN_BACKOFF_MS = 5_000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const DEFAULT_STUCK_THRESHOLD = 4

export interface TickResult {
  ran: boolean
  reason?: "not_owner"
  nextDelayMs: number
  stuckEscalated: boolean
}

export class SchedulerDaemon {
  private readonly opts: Required<
    Omit<DaemonOptions, "onStuck" | "setTimer" | "clearTimer" | "nowMs">
  > &
    Pick<DaemonOptions, "onStuck">
  private readonly setTimer: NonNullable<DaemonOptions["setTimer"]>
  private readonly clearTimer: NonNullable<DaemonOptions["clearTimer"]>
  private readonly lease: SchedulerLease

  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private consecutiveFailures = 0
  private lastProgressKey: string | undefined
  private noProgressCycles = 0

  constructor(options: DaemonOptions) {
    this.lease = options.lease
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h))
    this.opts = {
      advance: options.advance,
      lease: options.lease,
      minBackoffMs: options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      stuckThreshold: options.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD,
      onStuck: options.onStuck,
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
    } catch (err) {
      this.consecutiveFailures += 1
      const delay = this.backoffMs()
      consola.warn(`first-mate daemon tick failed (#${this.consecutiveFailures}); backoff ${delay}ms:`, err)
      return { ran: true, nextDelayMs: delay, stuckEscalated: false }
    }

    const stuckEscalated = this.runWatchdog(result)

    const nextDelayMs =
      result.nextWakeSeconds === null
        ? this.opts.maxBackoffMs // idle portfolio: check back slowly
        : Math.min(Math.max(result.nextWakeSeconds, CLAMP_MIN_S), CLAMP_MAX_S) * 1000

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
