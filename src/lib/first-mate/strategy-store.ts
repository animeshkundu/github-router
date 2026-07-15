import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { commitJsonCas } from "./durable-store"
import type {
  StrategyBet,
  StrategyDecisionEntry,
  StrategyGreatnessItem,
  StrategyRecord,
} from "./types"

const STRATEGIES_VERSION = 1

interface StrategiesFile {
  version: 1
  rev?: number
  strategies: StrategyRecord[]
}

function strategiesPath(): string {
  return path.join(PATHS.FIRST_MATE_DIR, "strategy.json")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  )
}

function isStrategyBet(value: unknown): value is StrategyBet {
  const bet = asRecord(value)
  return (
    bet !== undefined &&
    typeof bet.hypothesis === "string" &&
    typeof bet.metric === "string" &&
    typeof bet.threshold === "string" &&
    (bet.decisionRule === "kill" ||
      bet.decisionRule === "pivot" ||
      bet.decisionRule === "continue")
  )
}

function isOptionalStrategyBet(value: unknown): boolean {
  return value === undefined || isStrategyBet(value)
}

function isStrategyGreatnessItem(value: unknown): value is StrategyGreatnessItem {
  const entry = asRecord(value)
  return (
    entry !== undefined &&
    typeof entry.item === "string" &&
    (entry.status === "done" || entry.status === "pending") &&
    isOptionalString(entry.evidence)
  )
}

function isOptionalGreatnessChecklist(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isStrategyGreatnessItem))
  )
}

function isStrategyDecisionEntry(value: unknown): value is StrategyDecisionEntry {
  const entry = asRecord(value)
  return (
    entry !== undefined &&
    isFiniteNumber(entry.atMs) &&
    typeof entry.decision === "string" &&
    typeof entry.rationale === "string" &&
    isOptionalString(entry.evidenceRef)
  )
}

function isOptionalDecisionLog(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isStrategyDecisionEntry))
  )
}

function isNextStrategicAction(value: unknown): boolean {
  if (value === undefined) return true
  const next = asRecord(value)
  return (
    next !== undefined &&
    typeof next.action === "string" &&
    isOptionalString(next.trigger)
  )
}

function isStrategyRecord(value: unknown): value is StrategyRecord {
  const record = asRecord(value)
  return (
    record !== undefined &&
    typeof record.missionId === "string" &&
    record.missionId.length > 0 &&
    isOptionalStringArray(record.repos) &&
    isOptionalString(record.currentPhase) &&
    isOptionalStrategyBet(record.activeBet) &&
    isOptionalGreatnessChecklist(record.greatnessChecklist) &&
    isOptionalDecisionLog(record.decisionLog) &&
    isOptionalStringArray(record.openAssumptions) &&
    isNextStrategicAction(record.nextStrategicAction) &&
    isFiniteNumber(record.updatedMs) &&
    isOptionalString(record.updatedByWake)
  )
}

function parseStrategies(
  raw: string | undefined,
): { rev: number; strategies: StrategyRecord[] } {
  if (raw === undefined) return { rev: 0, strategies: [] }

  try {
    const parsed = asRecord(JSON.parse(raw))
    if (
      !parsed ||
      parsed.version !== STRATEGIES_VERSION ||
      !Array.isArray(parsed.strategies)
    ) {
      return { rev: 0, strategies: [] }
    }
    const rev = isNonNegativeInteger(parsed.rev) ? parsed.rev : 0
    const cleaned = parsed.strategies.filter(isStrategyRecord)
    if (cleaned.length !== parsed.strategies.length) {
      consola.debug(
        `first-mate strategies dropped ${parsed.strategies.length - cleaned.length} corrupt strategy record(s)`,
      )
    }
    return { rev, strategies: cleaned }
  } catch (err) {
    consola.debug("first-mate strategies corrupt, starting empty:", err)
    return { rev: 0, strategies: [] }
  }
}

async function readStrategiesFile(): Promise<StrategiesFile> {
  let raw: string | undefined
  try {
    raw = await fs.readFile(strategiesPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate strategies read skipped:", err)
    }
    raw = undefined
  }

  const parsed = parseStrategies(raw)
  return {
    version: STRATEGIES_VERSION,
    rev: parsed.rev,
    strategies: parsed.strategies,
  }
}

async function withStrategiesMutation<T>(
  work: (strategies: StrategyRecord[]) => T | Promise<T>,
): Promise<T> {
  const { result } = await commitJsonCas<StrategyRecord[], T>({
    path: strategiesPath(),
    parse: (raw) => {
      const parsed = parseStrategies(raw)
      return { rev: parsed.rev, value: parsed.strategies }
    },
    mutate: async (strategies) => {
      const result = await work(strategies)
      return { value: strategies, result }
    },
    build: (strategies, rev): StrategiesFile => ({
      version: STRATEGIES_VERSION,
      rev,
      strategies,
    }),
  })
  return result
}

export async function readStrategies(): Promise<StrategyRecord[]> {
  return (await readStrategiesFile()).strategies
}

export async function readStrategy(
  missionId: string,
): Promise<StrategyRecord | undefined> {
  return (await readStrategies()).find((record) => record.missionId === missionId)
}

export async function upsertStrategy(rec: StrategyRecord): Promise<void> {
  await withStrategiesMutation((strategies) => {
    const existing = strategies.find((entry) => entry.missionId === rec.missionId)
    const next: StrategyRecord = {
      ...existing,
      ...rec,
      decisionLog: [
        ...(existing?.decisionLog ?? []),
        ...(rec.decisionLog ?? []),
      ],
      updatedMs: Date.now(),
    }
    const kept = strategies.filter((entry) => entry.missionId !== rec.missionId)
    strategies.splice(0, strategies.length, ...kept, next)
  })
}

export async function pruneStrategy(missionId: string): Promise<void> {
  await withStrategiesMutation((strategies) => {
    const kept = strategies.filter((entry) => entry.missionId !== missionId)
    strategies.splice(0, strategies.length, ...kept)
  })
}
