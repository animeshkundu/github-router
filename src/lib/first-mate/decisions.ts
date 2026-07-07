import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { commitJsonCas } from "./durable-store"
import type { ApprovalRecord } from "~/lib/first-mate/approval"
import type { RepoRef } from "~/lib/first-mate/types"

const DECISIONS_VERSION = 1

export type DecisionStatus =
  | "pending"
  | "answered"
  | "queued_away"
  | "queued_away_irreversible"

export interface DecisionRecord {
  decisionId: string
  decisionKey: string
  type: string
  status: DecisionStatus
  packetId?: string
  inputFingerprint: string
  options?: Array<{ id: string }>
  chosenOptionId?: string | null
  resolvedBy?: "human" | string | null
  createdMs: number
  resolvedMs?: number
  approval?: ApprovalRecord
}

interface DecisionsFile {
  version: 1
  rev?: number
  decisions: DecisionRecord[]
}

const DECISION_STATUSES = new Set<DecisionStatus>([
  "pending",
  "answered",
  "queued_away",
  "queued_away_irreversible",
])

function decisionsPath(): string {
  return path.join(PATHS.FIRST_MATE_DIR, "decisions.json")
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  )
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

function isOptionRefs(value: unknown): value is Array<{ id: string }> {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((option) => {
        const row = asRecord(option)
        return row !== undefined && typeof row.id === "string"
      }))
  )
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  const approval = asRecord(value)
  return (
    approval !== undefined &&
    typeof approval.decisionId === "string" &&
    approval.decisionId.length > 0 &&
    isRepoRef(approval.repo) &&
    isPositiveInteger(approval.pr) &&
    typeof approval.headSha === "string" &&
    approval.headSha.length > 0 &&
    isOptionalString(approval.baseSha) &&
    isOptionalString(approval.diffDigest) &&
    isOptionalStringArray(approval.requiredCheckIds) &&
    isOptionalString(approval.floorRunId) &&
    approval.status === "approved" &&
    typeof approval.consumed === "boolean" &&
    isFiniteNumber(approval.createdMs) &&
    isOptionalFiniteNumber(approval.consumedMs)
  )
}

function isOptionalApprovalRecord(value: unknown): value is ApprovalRecord | undefined {
  return value === undefined || isApprovalRecord(value)
}

function isDecisionRecord(value: unknown): value is DecisionRecord {
  const record = asRecord(value)
  return (
    record !== undefined &&
    typeof record.decisionId === "string" &&
    record.decisionId.length > 0 &&
    typeof record.decisionKey === "string" &&
    record.decisionKey.length > 0 &&
    typeof record.type === "string" &&
    record.type.length > 0 &&
    isOneOf(record.status, DECISION_STATUSES) &&
    isOptionalString(record.packetId) &&
    typeof record.inputFingerprint === "string" &&
    record.inputFingerprint.length > 0 &&
    isOptionRefs(record.options) &&
    isOptionalStringOrNull(record.chosenOptionId) &&
    isOptionalStringOrNull(record.resolvedBy) &&
    isFiniteNumber(record.createdMs) &&
    isOptionalFiniteNumber(record.resolvedMs) &&
    isOptionalApprovalRecord(record.approval)
  )
}

function parseDecisions(
  raw: string | undefined,
): { rev: number; decisions: DecisionRecord[] } {
  if (raw === undefined) return { rev: 0, decisions: [] }

  try {
    const parsed = asRecord(JSON.parse(raw))
    if (
      !parsed ||
      parsed.version !== DECISIONS_VERSION ||
      !Array.isArray(parsed.decisions)
    ) {
      return { rev: 0, decisions: [] }
    }
    const rev = isNonNegativeInteger(parsed.rev) ? parsed.rev : 0
    const cleaned = parsed.decisions.filter(isDecisionRecord)
    if (cleaned.length !== parsed.decisions.length) {
      consola.debug(
        `first-mate decisions dropped ${parsed.decisions.length - cleaned.length} corrupt decision(s)`,
      )
    }
    return { rev, decisions: cleaned }
  } catch (err) {
    consola.debug("first-mate decisions corrupt, starting empty:", err)
    return { rev: 0, decisions: [] }
  }
}

async function readDecisionsFile(): Promise<DecisionsFile> {
  let raw: string | undefined
  try {
    raw = await fs.readFile(decisionsPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate decisions read skipped:", err)
    }
    raw = undefined
  }

  const parsed = parseDecisions(raw)
  return {
    version: DECISIONS_VERSION,
    rev: parsed.rev,
    decisions: parsed.decisions,
  }
}

export async function withDecisionsMutation<T>(
  work: (decisions: DecisionRecord[]) => T | Promise<T>,
): Promise<T> {
  const { result } = await commitJsonCas<DecisionRecord[], T>({
    path: decisionsPath(),
    parse: (raw) => {
      const parsed = parseDecisions(raw)
      return { rev: parsed.rev, value: parsed.decisions }
    },
    mutate: async (decisions) => {
      const result = await work(decisions)
      return { value: decisions, result }
    },
    build: (decisions, rev): DecisionsFile => ({
      version: DECISIONS_VERSION,
      rev,
      decisions,
    }),
  })
  return result
}

export async function readDecisions(): Promise<DecisionRecord[]> {
  return (await readDecisionsFile()).decisions
}

export async function upsertDecision(rec: DecisionRecord): Promise<void> {
  await withDecisionsMutation((decisions) => {
    const kept = decisions.filter(
      (entry) =>
        entry.decisionId !== rec.decisionId && entry.decisionKey !== rec.decisionKey,
    )
    decisions.splice(0, decisions.length, ...kept, rec)
  })
}

export async function findByKey(
  decisionKey: string,
): Promise<DecisionRecord | undefined> {
  return (await readDecisions()).find((record) => record.decisionKey === decisionKey)
}

export async function markAnswered(
  decisionId: string,
  chosenOptionId: string | null,
  resolvedBy: "human" | string | null,
): Promise<void> {
  await withDecisionsMutation((decisions) => {
    const record = decisions.find((entry) => entry.decisionId === decisionId)
    if (!record) return
    record.status = "answered"
    record.chosenOptionId = chosenOptionId
    record.resolvedBy = resolvedBy
    record.resolvedMs = Date.now()
  })
}
