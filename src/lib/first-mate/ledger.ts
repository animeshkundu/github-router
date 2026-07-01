import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
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
const DISPATCH_MODES = new Set<DispatchMode>(["plan", "build"])
const PROVIDER_STATES = new Set<ProviderState>([
  "none",
  "queued",
  "in_progress",
  "waiting_for_user",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
])
const PHASES = new Set<Phase>(["plan", "build", "fix", "review", "merge", "done"])
const ARTIFACTS = new Set<Artifact>([
  "no_pr",
  "pr_open",
  "pr_closed",
  "pr_merged",
  "multiple_prs",
])
const VALIDATIONS = new Set<Validation>([
  "unknown",
  "ci_running",
  "ci_passed",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "floor_pending",
  "floor_passed",
  "floor_failed",
])

interface RepoLedgerFile {
  version: 1
  units: UnitRow[]
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

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeInteger)
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
    isIntegerArray(row.dependsOn) &&
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

async function writeRepoLedger(repo: RepoRef, units: UnitRow[]): Promise<void> {
  await writeJsonSecure(repoLedgerPath(repo), { version: LEDGER_VERSION, units })
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

export async function readRepoLedger(repo: RepoRef): Promise<UnitRow[]> {
  let raw: string
  try {
    raw = await fs.readFile(repoLedgerPath(repo), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate ledger read skipped:", err)
    }
    return []
  }

  try {
    const parsed = asRecord(JSON.parse(raw))
    if (!parsed || parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.units)) {
      return []
    }
    const cleaned = parsed.units.filter(isUnitRow)
    if (cleaned.length !== parsed.units.length) {
      consola.debug(
        `first-mate ledger dropped ${parsed.units.length - cleaned.length} corrupt unit(s)`,
      )
    }
    return cleaned
  } catch (err) {
    consola.debug("first-mate ledger corrupt, starting empty:", err)
    return []
  }
}

export async function upsertUnit(repo: RepoRef, unit: UnitRow): Promise<void> {
  await serializeLedgerWrite(async () => {
    const current = await readRepoLedger(repo)
    const next = current.filter((row) => !sameUnitHandle(row, unit))
    next.push(unit)
    await writeRepoLedger(repo, next)
  })
}

export async function removeUnit(repo: RepoRef, issue: number): Promise<void> {
  await serializeLedgerWrite(async () => {
    const current = await readRepoLedger(repo)
    await writeRepoLedger(
      repo,
      current.filter((row) => row.issue !== issue),
    )
  })
}

export async function pruneTerminal(
  repo: RepoRef,
  maxAgeMs = DEFAULT_TERMINAL_MAX_AGE_MS,
): Promise<void> {
  await serializeLedgerWrite(async () => {
    const current = await readRepoLedger(repo)
    const now = Date.now()
    const keptTerminals = new Set(
      current
        .filter((row) => row.terminal === true)
        .filter((row) => now - terminalTimestamp(row) < maxAgeMs)
        .sort((a, b) => terminalTimestamp(a) - terminalTimestamp(b))
        .slice(-TERMINAL_MAX_ENTRIES),
    )
    const next = current.filter(
      (row) => row.terminal !== true || keptTerminals.has(row),
    )
    await writeRepoLedger(repo, next)
  })
}
