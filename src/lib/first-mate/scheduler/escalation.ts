import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"

/**
 * Phase C — push-not-poll escalation.
 *
 * When a judgment escalates to the lead or a human, the driver writes it to a
 * durable queue AND fires a push hook so the lead can be woken instead of
 * polling. Honesty about the boundary: the durable queue and the hook are real,
 * but the daemon runs server-side and CANNOT itself call the lead's scheduler
 * primitives (CronCreate / ScheduleWakeup are lead-model tools). So:
 *   - a real push hook can be injected where the harness exposes a wake channel
 *     (e.g. a one-shot wake enqueued by a co-located supervisor);
 *   - otherwise the DEFAULT hook logs, and the passive [fm-heartbeat] surfaces
 *     the queued escalation on its next wake (bounded-latency, not zero-poll).
 * True zero-poll depends on harness support for a server→lead push.
 */
export interface EscalationItem {
  atMs: number
  requestId: string
  kind: string
  target: "lead" | "human"
  reason: string
  repo?: string
  missionId?: string
}

export type PushHook = (item: EscalationItem) => void | Promise<void>

/** Default hook: no real wake channel server-side — log and rely on the heartbeat. */
export const heartbeatFallbackPush: PushHook = (item) => {
  consola.debug(
    `first-mate escalation queued (${item.target}/${item.kind}/${item.requestId}); ` +
      "no server-side push channel — the heartbeat will surface it on next wake.",
  )
}

export interface EscalationQueueOptions {
  dir?: string
  nowMs?: () => number
  push?: PushHook
}

export class EscalationQueue {
  private readonly file: string
  private readonly now: () => number
  private readonly push: PushHook

  constructor(opts: EscalationQueueOptions = {}) {
    this.file = path.join(opts.dir ?? PATHS.FIRST_MATE_DIR, "escalations.jsonl")
    this.now = opts.nowMs ?? Date.now
    this.push = opts.push ?? heartbeatFallbackPush
  }

  /** Durably record an escalation and fire the push hook (never throws). */
  async enqueue(item: Omit<EscalationItem, "atMs"> & { atMs?: number }): Promise<EscalationItem> {
    const full: EscalationItem = { ...item, atMs: item.atMs ?? this.now() }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
    try {
      await this.push(full)
    } catch (err) {
      consola.debug("first-mate escalation push hook failed (ignored):", err)
    }
    return full
  }

  async list(): Promise<EscalationItem[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    const out: EscalationItem[] = []
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as EscalationItem)
      } catch {
        // skip corrupt line
      }
    }
    return out
  }
}
