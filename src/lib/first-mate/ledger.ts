import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { isCurrentFencingToken } from "~/lib/first-mate/scheduler/lease"
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

/** Thrown by {@link commitUnits} when the on-disk rev moved under a CAS write. */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerConflictError"
  }
}

/** Thrown by {@link commitUnits} when the caller's fencing token is stale. */
export class LedgerFencedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerFencedError"
  }
}

/**
 * OCC + cross-process lock + fencing on the shared write path are GATED so the
 * live behavior is unchanged until a deliberate cutover flips this on.
 */
function occEnabled(): boolean {
  return process.env.GH_ROUTER_FM_OCC === "1"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_")
  return cleaned.length > 0 ? cleaned : "_"
}

function repoLedgerPath(repo: RepoRef): string {
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

async function writeJsonSecure(target: string, value: RepoLedgerFile): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => {})
    await fs.rename(tmp, target)
    await fs.chmod(target, 0o600).catch(() => {})
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

async function writeRepoLedger(
  repo: RepoRef,
  units: UnitRow[],
  rev: number,
): Promise<void> {
  await writeJsonSecure(repoLedgerPath(repo), { version: LEDGER_VERSION, rev, units })
}

let _ledgerChain: Promise<void> = Promise.resolve()

function serializeLedgerWrite(work: () => Promise<void>): Promise<void> {
  const next = _ledgerChain.then(work)
  _ledgerChain = next.catch(() => undefined)
  return next
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

const LOCK_TTL_MS = 15_000
const LOCK_RETRY_MS = 25
const LOCK_MAX_WAIT_MS = 10_000

/**
 * Cross-process mutual exclusion for a repo's ledger via atomic exclusive-create
 * (`O_EXCL`). The in-process {@link serializeLedgerWrite} chain only orders
 * writes within ONE process; this closes the daemon-vs-lead cross-process race.
 * A stale lock (older than {@link LOCK_TTL_MS}, e.g. from a crashed writer) is
 * broken so a dead process can't wedge the ledger forever.
 */
async function withRepoLock<T>(repo: RepoRef, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${repoLedgerPath(repo)}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx")
      await fh.writeFile(`${process.pid}`)
      await fh.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        const st = await fs.stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(
          `first-mate ledger lock timeout for ${repo.owner}/${repo.name}`,
        )
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  try {
    return await fn()
  } finally {
    await fs.unlink(lockPath).catch(() => {})
  }
}

export interface CommitOptions {
  /** CAS: reject if the on-disk rev differs (only enforced when OCC is enabled). */
  expectedRev?: number
  /** Reject if this is no longer the current fencing token (OCC-enabled only). */
  fencingToken?: number
}

/**
 * The single shared write path for unit mutations. Reads the current
 * {rev, units}, applies `mutate`, and writes with `rev + 1`.
 *
 * Default (OCC off): behaves exactly as before — in-process serialized,
 * atomic, never rejects — but now stamps the additive `rev`.
 *
 * OCC on (`GH_ROUTER_FM_OCC=1`): also takes a cross-process lock and, when the
 * caller supplies them, enforces `expectedRev` (compare-and-swap) and
 * `fencingToken`, throwing {@link LedgerConflictError} / {@link LedgerFencedError}
 * WITHOUT writing (fail-safe — never clobbers a newer version). Mutators that
 * pass neither still commit; the guard is opt-in per caller.
 */
export async function commitUnits(
  repo: RepoRef,
  mutate: (units: UnitRow[]) => UnitRow[],
  opts: CommitOptions = {},
): Promise<{ rev: number }> {
  let outRev = 0
  const doWork = async (): Promise<void> => {
    const { rev, units } = await readRepoLedgerWithRev(repo)
    if (occEnabled()) {
      if (opts.expectedRev !== undefined && opts.expectedRev !== rev) {
        throw new LedgerConflictError(
          `ledger rev mismatch for ${repo.owner}/${repo.name}: expected ${opts.expectedRev}, on-disk ${rev}`,
        )
      }
      if (
        opts.fencingToken !== undefined &&
        !(await isCurrentFencingToken(opts.fencingToken))
      ) {
        throw new LedgerFencedError(
          `stale fencing token ${opts.fencingToken} for ${repo.owner}/${repo.name}`,
        )
      }
    }
    const next = mutate(units)
    outRev = rev + 1
    await writeRepoLedger(repo, next, outRev)
  }
  await serializeLedgerWrite(() =>
    occEnabled() ? withRepoLock(repo, doWork) : doWork(),
  )
  return { rev: outRev }
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
