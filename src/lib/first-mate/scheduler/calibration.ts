import fs from "node:fs/promises"
import path from "node:path"

import { decideRoute, type Tier1Verdict } from "~/lib/first-mate/scheduler/shadow"
import { PATHS } from "~/lib/paths"

/**
 * Phase 4 — calibration + observability. Consumes the Tier1 shadow log
 * (tier1-shadow.jsonl: `shadow` verdict records + `outcome` records), pairs
 * them by requestId, and reports per-judgment-kind how often Tier1's would-be
 * verdict AGREED with the lead's actual outcome and how often it would have
 * auto-accepted. This is the evidence base that lets the Phase 3 allowlist
 * widen (or tighten) by DATA rather than guesswork.
 *
 * Also provides an append-only audit log and a dead-letter queue for units that
 * repeatedly fail, so a poison unit is quarantined instead of looping forever.
 */

interface ShadowRec {
  type: "shadow"
  requestId: string
  kind: string
  wouldVerdict: unknown
  confidence: number
  novelty: "known" | "novel"
  stakes: "low" | "high"
}
interface OutcomeRec {
  type: "outcome"
  requestId: string
  leadOutcome: unknown
}

export interface CalibrationStats {
  kind: string
  shadowCount: number
  pairedCount: number
  agreeCount: number
  agreeRate: number | null
  wouldAutoAccept: number
}

function shadowLogPath(dir: string): string {
  return path.join(dir, "tier1-shadow.jsonl")
}

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const out: Array<Record<string, unknown>> = []
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // skip corrupt line
    }
  }
  return out
}

/** A stable, comparable projection of a verdict (best-effort: `.decision` else JSON). */
function verdictKey(v: unknown): string {
  if (v && typeof v === "object" && "decision" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).decision)
  }
  return JSON.stringify(v ?? null)
}

/** Compute per-kind calibration by joining shadow verdicts to lead outcomes. */
export async function computeCalibration(
  dir: string = PATHS.FIRST_MATE_DIR,
): Promise<CalibrationStats[]> {
  const records = await readJsonl(shadowLogPath(dir))
  const shadows = new Map<string, ShadowRec>()
  const outcomes = new Map<string, OutcomeRec>()
  for (const r of records) {
    if (r.type === "shadow" && typeof r.requestId === "string") {
      shadows.set(r.requestId, r as unknown as ShadowRec)
    } else if (r.type === "outcome" && typeof r.requestId === "string") {
      outcomes.set(r.requestId, r as unknown as OutcomeRec)
    }
  }
  const byKind = new Map<string, CalibrationStats>()
  const get = (kind: string): CalibrationStats => {
    let s = byKind.get(kind)
    if (!s) {
      s = { kind, shadowCount: 0, pairedCount: 0, agreeCount: 0, agreeRate: null, wouldAutoAccept: 0 }
      byKind.set(kind, s)
    }
    return s
  }
  for (const [requestId, shadow] of shadows) {
    const s = get(shadow.kind)
    s.shadowCount += 1
    const verdict: Tier1Verdict = {
      wouldVerdict: shadow.wouldVerdict,
      confidence: shadow.confidence,
      novelty: shadow.novelty,
      stakes: shadow.stakes,
    }
    if (decideRoute(shadow.kind, verdict).autoAccept) s.wouldAutoAccept += 1
    const outcome = outcomes.get(requestId)
    if (outcome) {
      s.pairedCount += 1
      if (verdictKey(shadow.wouldVerdict) === verdictKey(outcome.leadOutcome)) s.agreeCount += 1
    }
  }
  for (const s of byKind.values()) {
    s.agreeRate = s.pairedCount > 0 ? s.agreeCount / s.pairedCount : null
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

/** A compact human-readable calibration report. */
export async function calibrationReport(dir: string = PATHS.FIRST_MATE_DIR): Promise<string> {
  const stats = await computeCalibration(dir)
  if (stats.length === 0) return "first-mate Tier1 calibration: no shadow records yet."
  const lines = ["first-mate Tier1 calibration (shadow vs lead outcome):"]
  for (const s of stats) {
    const rate = s.agreeRate === null ? "n/a" : `${Math.round(s.agreeRate * 100)}%`
    lines.push(
      `  ${s.kind}: ${s.shadowCount} judged, ${s.pairedCount} paired, agree ${rate}, ` +
        `would-auto-accept ${s.wouldAutoAccept}`,
    )
  }
  return lines.join("\n")
}

/** Append-only audit log of controller-relevant events. */
export interface AuditEvent {
  atMs: number
  event: string
  requestId?: string
  repo?: string
  detail?: string
}
export class AuditLog {
  private readonly file: string
  private readonly now: () => number
  constructor(opts: { dir?: string; nowMs?: () => number } = {}) {
    this.file = path.join(opts.dir ?? PATHS.FIRST_MATE_DIR, "audit.jsonl")
    this.now = opts.nowMs ?? Date.now
  }
  async append(e: Omit<AuditEvent, "atMs"> & { atMs?: number }): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const full: AuditEvent = { ...e, atMs: e.atMs ?? this.now() }
    await fs.appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
  }
  async list(): Promise<AuditEvent[]> {
    return (await readJsonl(this.file)) as unknown as AuditEvent[]
  }
}

/** Dead-letter queue: quarantine a unit after N repeated failures. */
export interface DlqEntry {
  unitKey: string
  failures: number
  dead: boolean
  lastReason: string
  updatedMs: number
}
export class DeadLetterQueue {
  private readonly file: string
  private readonly maxFailures: number
  private readonly now: () => number
  private chain: Promise<void> = Promise.resolve()
  constructor(opts: { dir?: string; maxFailures?: number; nowMs?: () => number } = {}) {
    this.file = path.join(opts.dir ?? PATHS.FIRST_MATE_DIR, "dead-letter.json")
    this.maxFailures = opts.maxFailures ?? 3
    this.now = opts.nowMs ?? Date.now
  }
  private async read(): Promise<DlqEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { entries?: DlqEntry[] }
      return parsed.entries ?? []
    } catch {
      return []
    }
  }
  private async write(entries: DlqEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 })
  }
  /** Record a failure; returns the entry (dead=true once it crosses the threshold). */
  async recordFailure(unitKey: string, reason: string): Promise<DlqEntry> {
    const run = this.chain.then(async () => {
      const entries = await this.read()
      let e = entries.find((x) => x.unitKey === unitKey)
      if (!e) {
        e = { unitKey, failures: 0, dead: false, lastReason: reason, updatedMs: this.now() }
        entries.push(e)
      }
      e.failures += 1
      e.lastReason = reason
      e.updatedMs = this.now()
      e.dead = e.failures >= this.maxFailures
      await this.write(entries)
      return e
    })
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  async isDead(unitKey: string): Promise<boolean> {
    return (await this.read()).some((e) => e.unitKey === unitKey && e.dead)
  }
  async list(): Promise<DlqEntry[]> {
    return this.read()
  }
}
