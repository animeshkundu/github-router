import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { commitJsonCas } from "./durable-store"
import { readRepoLedger } from "~/lib/first-mate/ledger"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const REGISTRY_VERSION = 1

export interface Mission {
  id: string
  goal: string
  acceptanceCriteria: string
  houseRules?: string
  priority?: number
  /**
   * The GitHub cloud coding agent model this mission's tasks default to (e.g.
   * `gpt-5.5`). Optional → back-compat; absent means the controller falls back
   * to DEFAULT_CODEX_MODEL. A per-unit `UnitRow.model` overrides this.
   */
  defaultModel?: string
  /**
   * Plan-review gate policy. `hard` (default when absent) keeps the current
   * flow: a model plan review's approve dispatches the build and a rejecting
   * review re-runs planning autonomously. `soft` still auto-advances a PASSING
   * plan review to the build dispatch without human approval, but a REJECTING
   * review escalates to a human instead of silently burning another plan cycle.
   */
  planGate?: "hard" | "soft"
  /**
   * Per-mission budget: the maximum number of author_fix cycles a single unit
   * may burn before the controller STOPS iterating and escalates to a human.
   * An ADDITIONAL cap beside `policy.totalFixCap`/`maxRetries` (not a
   * replacement). Optional → back-compat; absent uses the controller default.
   */
  maxFixCycles?: number
  /**
   * Per-mission budget: the maximum number of `@copilot` fix mentions a single
   * unit may post before the controller STOPS and escalates to a human.
   * Optional → back-compat; absent uses the controller default.
   */
  maxCopilotComments?: number
  /** When true, a repo with no reported CI is not mergeable through first-mate. */
  ciRequired?: boolean
  /**
   * Back-compat marker that this mission has already produced (or accepted) a
   * decompose answer. Absent legacy rows read as false; once true, a pruned-empty
   * mission must not re-emit decompose.
   */
  everDecomposed?: boolean
  repos: RepoRef[]
  status: "active" | "done" | "abandoned"
  createdMs: number
  updatedMs: number
}

interface MissionRegistryFile {
  version: 1
  rev?: number
  missions: Mission[]
}

function registryPath(): string {
  return path.join(PATHS.FIRST_MATE_DIR, "missions.json")
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

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1)
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

function isMission(value: unknown): value is Mission {
  const mission = asRecord(value)
  return (
    mission !== undefined &&
    typeof mission.id === "string" &&
    mission.id.length > 0 &&
    typeof mission.goal === "string" &&
    typeof mission.acceptanceCriteria === "string" &&
    isOptionalString(mission.houseRules) &&
    isOptionalFiniteNumber(mission.priority) &&
    isOptionalString(mission.defaultModel) &&
    (mission.planGate === undefined ||
      mission.planGate === "hard" ||
      mission.planGate === "soft") &&
    isOptionalPositiveInteger(mission.maxFixCycles) &&
    isOptionalPositiveInteger(mission.maxCopilotComments) &&
    (mission.ciRequired === undefined || typeof mission.ciRequired === "boolean") &&
    (mission.everDecomposed === undefined || typeof mission.everDecomposed === "boolean") &&
    Array.isArray(mission.repos) &&
    mission.repos.every(isRepoRef) &&
    (mission.status === "active" ||
      mission.status === "done" ||
      mission.status === "abandoned") &&
    isFiniteNumber(mission.createdMs) &&
    isFiniteNumber(mission.updatedMs)
  )
}

function parseRegistry(raw: string | undefined): { rev: number; missions: Mission[] } {
  if (raw === undefined) return { rev: 0, missions: [] }

  try {
    const parsed = asRecord(JSON.parse(raw))
    if (
      !parsed ||
      parsed.version !== REGISTRY_VERSION ||
      !Array.isArray(parsed.missions)
    ) {
      return { rev: 0, missions: [] }
    }
    const rev = isNonNegativeInteger(parsed.rev) ? parsed.rev : 0
    const cleaned = parsed.missions.filter(isMission)
    if (cleaned.length !== parsed.missions.length) {
      consola.debug(
        `first-mate registry dropped ${parsed.missions.length - cleaned.length} corrupt mission(s)`,
      )
    }
    return { rev, missions: cleaned }
  } catch (err) {
    consola.debug("first-mate registry corrupt, starting empty:", err)
    return { rev: 0, missions: [] }
  }
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner.toLowerCase()}\0${repo.name.toLowerCase()}`
}

export async function readMissions(): Promise<Mission[]> {
  let raw: string | undefined
  try {
    raw = await fs.readFile(registryPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate registry read skipped:", err)
    }
    raw = undefined
  }

  return parseRegistry(raw).missions
}

export async function upsertMission(mission: Mission): Promise<void> {
  await commitJsonCas<Mission[], void>({
    path: registryPath(),
    parse: (raw) => {
      const parsed = parseRegistry(raw)
      return { rev: parsed.rev, value: parsed.missions }
    },
    mutate: (missions) => ({
      value: [...missions.filter((entry) => entry.id !== mission.id), mission],
      result: undefined,
    }),
    build: (missions, rev): MissionRegistryFile => ({
      version: REGISTRY_VERSION,
      rev,
      missions,
    }),
  })
}

export async function listActiveMissions(): Promise<Mission[]> {
  return (await readMissions()).filter((mission) => mission.status === "active")
}

export async function loadAllUnits(missionIdFilter?: string): Promise<UnitRow[]> {
  const missions = await readMissions()
  const repos = new Map<string, RepoRef>()
  for (const mission of missions) {
    if (missionIdFilter !== undefined && mission.id !== missionIdFilter) continue
    for (const repo of mission.repos) {
      repos.set(repoKey(repo), repo)
    }
  }

  const units: UnitRow[] = []
  for (const repo of repos.values()) {
    const repoUnits = await readRepoLedger(repo)
    // When filtering by mission, exclude units that belong to other missions
    // (a repo may be shared across multiple missions).
    if (missionIdFilter !== undefined) {
      units.push(...repoUnits.filter((u) => u.missionId === missionIdFilter))
    } else {
      units.push(...repoUnits)
    }
  }
  return units
}
