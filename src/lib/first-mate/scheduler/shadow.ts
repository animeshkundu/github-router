import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { resolveTierModel } from "~/lib/first-mate/model-tiers"

/**
 * Tier-1 SHADOW mode (Phase 2 scaffolding, log-only).
 *
 * The peer review was unanimous: routing autonomy by a model's SELF-assessed
 * confidence/difficulty is circular and unsafe, and difficulty is not the
 * safety boundary. Before Tier1 is ever allowed to auto-answer anything, it
 * runs in shadow: for each judgment the lead actually answers, we record what
 * Tier1 WOULD have decided. Comparing the two over time is the calibration
 * record that later gates a narrow, verifiability-scoped live rollout.
 *
 * This module NEVER auto-accepts and NEVER feeds a decision back into the
 * controller. It only appends to a shadow log. The actual model call is
 * injectable so tests stay hermetic and offline.
 */
export interface ShadowRecord {
  atMs: number
  requestId: string
  kind: string
  tier1Model: string | undefined
  wouldDecide: unknown
  leadDecided?: unknown
  agree?: boolean
}

export interface ShadowOptions {
  dir?: string
  nowMs?: () => number
  /**
   * Injectable Tier1 judge. In production this would call the T1 model via the
   * router with the request's context + ledger bundle; omitted/undefined in
   * tests and when shadow is disabled.
   */
  judge?: (input: { requestId: string; kind: string; context: unknown }) => Promise<unknown>
}

function shadowLogPath(dir: string): string {
  return path.join(dir, "scheduler.shadow.log.jsonl")
}

/** Shadow runs only when explicitly enabled, so it never adds latency by default. */
export function shadowEnabled(): boolean {
  return process.env.GH_ROUTER_FM_SHADOW === "1"
}

export class Tier1Shadow {
  private readonly file: string
  private readonly now: () => number
  private readonly judge: ShadowOptions["judge"]

  constructor(opts: ShadowOptions = {}) {
    this.file = shadowLogPath(opts.dir ?? PATHS.FIRST_MATE_DIR)
    this.now = opts.nowMs ?? Date.now
    this.judge = opts.judge
  }

  private async append(record: ShadowRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    // Append is inherently additive; a tmp+rename would clobber prior lines, so
    // use an appic write with a trailing newline per JSONL record.
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  /**
   * Record a shadow judgment. Returns the record written, or undefined when
   * shadow is disabled or no judge is wired (the safe no-op default).
   * NEVER influences control flow.
   */
  async observe(input: {
    requestId: string
    kind: string
    context: unknown
    leadDecided?: unknown
  }): Promise<ShadowRecord | undefined> {
    if (!this.judge) return undefined
    let wouldDecide: unknown
    try {
      wouldDecide = await this.judge({
        requestId: input.requestId,
        kind: input.kind,
        context: input.context,
      })
    } catch (err) {
      consola.debug("first-mate Tier1 shadow judge failed (ignored):", err)
      return undefined
    }
    const record: ShadowRecord = {
      atMs: this.now(),
      requestId: input.requestId,
      kind: input.kind,
      tier1Model: resolveTierModel("T1"),
      wouldDecide,
      ...(input.leadDecided === undefined
        ? {}
        : {
            leadDecided: input.leadDecided,
            agree: JSON.stringify(wouldDecide) === JSON.stringify(input.leadDecided),
          }),
    }
    await this.append(record)
    return record
  }
}

/** Deterministic id for a shadow record, handy for callers/tests. */
export function shadowRequestId(prefix = "shadow"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`
}
