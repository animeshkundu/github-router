import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { commitJsonCas, withFileLock } from "./durable-store"
import type {
  AgentKey,
  Artifact,
  DispatchMode,
  Phase,
  ProviderState,
  RepoRef,
  UnitRow,
  Validation,
} from "~/lib/first-mate/types"

const LEDGER_VERSION = 1
const DEFAULT_TERMINAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const TERMINAL_MAX_ENTRIES = 200

const AGENTS = new Set<AgentKey>(["copilot", "anthropic", "openai"])
// Runtime validator sets for the union types isUnitRow checks. Each is built
// from a Record<Union, true> so the COMPILER enforces that every member of the
// union is present — a future union addition that forgets the set fails to
// compile instead of silently dropping units on read (the "no_ci" data-loss
// bug). Keep these keyed exhaustively.
function membersOf<T extends string>(record: Record<T, true>): Set<T> {
  return new Set(Object.keys(record) as T[])
}

const DISPATCH_MODES = membersOf<DispatchMode>({ plan: true, build: true })
const PROVIDER_STATES = membersOf<ProviderState>({
  none: true,
  queued: true,
  in_progress: true,
  waiting_for_user: true,
  completed: true,
  failed: true,
  timed_out: true,
  cancelled: true,
})
const PHASES = membersOf<Phase>({
  plan: true,
  build: true,
  fix: true,
  review: true,
  merge: true,
  done: true,
})
const ARTIFACTS = membersOf<Artifact>({
  no_pr: true,
  pr_open: true,
  pr_closed: true,
  pr_merged: true,
  multiple_prs: true,
})
const VALIDATIONS = membersOf<Validation>({
  unknown: true,
  ci_running: true,
  ci_passed: true,
  ci_failed: true,
  no_ci: true,
  review_pending: true,
  changes_requested: true,
  floor_pending: true,
  floor_passed: true,
  floor_failed: true,
})

interface RepoLedgerFile {
  version: 1
  /**
   * OCC revision counter (Phase 1.1). Increments on every write. Absent in
   * pre-1.1 files, read as 0 — additive and backward-compatible. A caller can
   * pass `expectedRev` to {@link commitUnits} for compare-and-swap semantics;
   * the shared write path only enforces it when OCC is enabled.
   */
  rev?: number
  units: UnitRow[]
}

export { runFenced, currentFenceToken, occEnabled } from "./durable-store"
export {
  DurableConflictError as LedgerConflictError,
  DurableFencedError as LedgerFencedError,
} from "./durable-store"

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_")
  return cleaned.length > 0 ? cleaned : "_"
}

export function repoLedgerPath(repo: RepoRef): string {
  return path.join(
    PATHS.FIRST_MATE_DIR,
    `${sanitizeSegment(repo.owner)}__${sanitizeSegment(repo.name)}.json`,
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isIssueNumberOrNull(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isRepoRef(value: unknown): value is RepoRef {
  const repo = asRecord(value)
  return (
    repo !== undefined &&
    typeof repo.owner === "string" &&
    repo.owner.length > 0 &&
    typeof repo.name === "string" &&
    repo.name.length > 0
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

function isLastSteer(value: unknown): value is NonNullable<UnitRow["lastSteer"]> {
  if (value === undefined) return true
  const steer = asRecord(value)
  return (
    steer !== undefined &&
    isOptionalString(steer.cursor) &&
    isOptionalString(steer.sha) &&
    isFiniteNumber(steer.atMs)
  )
}

function isUnitRow(value: unknown): value is UnitRow {
  const row = asRecord(value)
  if (!row) return false

  return (
    typeof row.missionId === "string" &&
    row.missionId.length > 0 &&
    isRepoRef(row.repo) &&
    isIssueNumberOrNull(row.issue) &&
    isIssueNumberOrNull(row.pr) &&
    isStringOrNull(row.taskId) &&
    isOneOf(row.agent, AGENTS) &&
    typeof row.botLogin === "string" &&
    isOneOf(row.dispatchMode, DISPATCH_MODES) &&
    isOneOf(row.provider, PROVIDER_STATES) &&
    isOneOf(row.phase, PHASES) &&
    isOneOf(row.artifact, ARTIFACTS) &&
    isOneOf(row.validation, VALIDATIONS) &&
    isNonNegativeInteger(row.retries) &&
    isStringArray(row.dependsOn) &&
    typeof row.title === "string" &&
    isLastSteer(row.lastSteer) &&
    (row.cancelledBy === undefined ||
      row.cancelledBy === "controller" ||
      row.cancelledBy === "external") &&
    isOptionalStringOrNull(row.bakeoffGroupId) &&
    isOptionalStringOrNull(row.blockingDecisionId) &&
    isOptionalBoolean(row.verifierAssigned) &&
    (row.implementerLab === undefined || isOneOf(row.implementerLab, AGENTS)) &&
    isOptionalStringOrNull(row.branch) &&
    isOptionalStringOrNull(row.headSha) &&
    isOptionalStringOrNull(row.baseSha) &&
    isOptionalFiniteNumber(row.lastCheckedMs) &&
    isOptionalBoolean(row.terminal)
  )
}

function sameUnitHandle(a: UnitRow, b: UnitRow): boolean {
  return (
    (b.id != null && a.id === b.id) ||
    (b.issue !== null && a.issue === b.issue) ||
    (b.taskId !== null && a.taskId === b.taskId)
  )
}

function terminalTimestamp(row: UnitRow): number {
  return row.lastCheckedMs ?? row.lastSteer?.atMs ?? 0
}

function parseLedgerRaw(raw: string): { rev: number; units: UnitRow[] } {
  try {
    const parsed = asRecord(JSON.parse(raw))
    if (!parsed || parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.units)) {
      return { rev: 0, units: [] }
    }
    const rev = isNonNegativeInteger(parsed.rev) ? parsed.rev : 0
    const cleaned = parsed.units.filter(isUnitRow)
    if (cleaned.length !== parsed.units.length) {
      consola.debug(
        `first-mate ledger dropped ${parsed.units.length - cleaned.length} corrupt unit(s)`,
      )
    }
    return { rev, units: cleaned }
  } catch (err) {
    consola.debug("first-mate ledger corrupt, starting empty:", err)
    return { rev: 0, units: [] }
  }
}

/** Read units plus the OCC revision (0 when the file is absent or pre-1.1). */
export async function readRepoLedgerWithRev(
  repo: RepoRef,
): Promise<{ rev: number; units: UnitRow[] }> {
  let raw: string
  try {
    raw = await fs.readFile(repoLedgerPath(repo), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate ledger read skipped:", err)
    }
    return { rev: 0, units: [] }
  }
  return parseLedgerRaw(raw)
}

export async function readRepoLedger(repo: RepoRef): Promise<UnitRow[]> {
  return (await readRepoLedgerWithRev(repo)).units
}

export interface CommitOptions {
  /**
   * True compare-and-swap: reject if the on-disk rev differs. When set, a
   * conflict SURFACES as {@link LedgerConflictError} (no transparent retry) so
   * the caller's "world unchanged since rev N" assertion is honored. Only
   * meaningful when OCC is enabled.
   */
  expectedRev?: number
  /** Reject if this is no longer the current fencing token (OCC-enabled only). */
  fencingToken?: number
}

export function withRepoLock<T>(
  repo: RepoRef,
  fn: (verifyOwner: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return withFileLock(repoLedgerPath(repo), fn)
}

/**
 * The single shared write path for unit mutations. Reads the current
 * {rev, units}, applies `mutate`, writes with `rev + 1`.
 *
 * OCC off (`GH_ROUTER_FM_OCC=0`): legacy in-process-serialized write, no lock,
 * never rejects for CAS/fencing — stamps the additive `rev` only.
 *
 * OCC on (default): each attempt reads the latest rev, applies `mutate`, and
 * CAS-writes under a cross-process lock. On a version conflict a normal caller
 * (no `expectedRev`) transparently RETRIES — reload, re-apply `mutate` to the
 * fresh units, re-commit — up to the durable-store retry limit, so a single
 * writer is a no-op and concurrent writers converge with no lost update. A
 * caller that passed an explicit `expectedRev` gets the conflict SURFACED (true
 * CAS). A stale `fencingToken` always fails hard.
 */
export async function commitUnits(
  repo: RepoRef,
  mutate: (units: UnitRow[]) => UnitRow[],
  opts: CommitOptions = {},
): Promise<{ rev: number }> {
  const { rev } = await commitJsonCas<UnitRow[], void>({
    path: repoLedgerPath(repo),
    parse: (raw) => {
      if (raw === undefined) return { rev: 0, value: [] }
      const parsed = parseLedgerRaw(raw)
      return { rev: parsed.rev, value: parsed.units }
    },
    mutate: (units) => ({ value: mutate(units), result: undefined }),
    build: (units, rev): RepoLedgerFile => ({
      version: LEDGER_VERSION,
      rev,
      units,
    }),
    expectedRev: opts.expectedRev,
    fencingToken: opts.fencingToken,
  })
  return { rev }
}

export async function upsertUnit(repo: RepoRef, unit: UnitRow): Promise<void> {
  await commitUnits(repo, (current) => {
    const next = current.filter((row) => !sameUnitHandle(row, unit))
    next.push(unit)
    return next
  })
}

export async function removeUnit(repo: RepoRef, issue: number): Promise<void> {
  await commitUnits(repo, (current) => current.filter((row) => row.issue !== issue))
}

export async function pruneTerminal(
  repo: RepoRef,
  maxAgeMs = DEFAULT_TERMINAL_MAX_AGE_MS,
): Promise<void> {
  await commitUnits(repo, (current) => {
    const now = Date.now()
    const keptTerminals = new Set(
      current
        .filter((row) => row.terminal === true)
        .filter((row) => now - terminalTimestamp(row) < maxAgeMs)
        .sort((a, b) => terminalTimestamp(a) - terminalTimestamp(b))
        .slice(-TERMINAL_MAX_ENTRIES),
    )
    return current.filter((row) => row.terminal !== true || keptTerminals.has(row))
  })
}
