import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { readRepoLedger } from "~/lib/first-mate/ledger"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const REGISTRY_VERSION = 1

export interface Mission {
  id: string
  goal: string
  acceptanceCriteria: string
  houseRules?: string
  priority?: number
  repos: RepoRef[]
  status: "active" | "done" | "abandoned"
  createdMs: number
  updatedMs: number
}

interface MissionRegistryFile {
  version: 1
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

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
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
    Array.isArray(mission.repos) &&
    mission.repos.every(isRepoRef) &&
    (mission.status === "active" ||
      mission.status === "done" ||
      mission.status === "abandoned") &&
    isFiniteNumber(mission.createdMs) &&
    isFiniteNumber(mission.updatedMs)
  )
}

async function writeRegistry(value: MissionRegistryFile): Promise<void> {
  await fs.mkdir(PATHS.FIRST_MATE_DIR, { recursive: true })
  const target = registryPath()
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

let _registryChain: Promise<void> = Promise.resolve()

function serializeRegistryWrite(work: () => Promise<void>): Promise<void> {
  const next = _registryChain.then(work)
  _registryChain = next.catch(() => undefined)
  return next
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner.toLowerCase()}\0${repo.name.toLowerCase()}`
}

export async function readMissions(): Promise<Mission[]> {
  let raw: string
  try {
    raw = await fs.readFile(registryPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug("first-mate registry read skipped:", err)
    }
    return []
  }

  try {
    const parsed = asRecord(JSON.parse(raw))
    if (
      !parsed ||
      parsed.version !== REGISTRY_VERSION ||
      !Array.isArray(parsed.missions)
    ) {
      return []
    }
    const cleaned = parsed.missions.filter(isMission)
    if (cleaned.length !== parsed.missions.length) {
      consola.debug(
        `first-mate registry dropped ${parsed.missions.length - cleaned.length} corrupt mission(s)`,
      )
    }
    return cleaned
  } catch (err) {
    consola.debug("first-mate registry corrupt, starting empty:", err)
    return []
  }
}

export async function upsertMission(mission: Mission): Promise<void> {
  await serializeRegistryWrite(async () => {
    const missions = (await readMissions()).filter((entry) => entry.id !== mission.id)
    missions.push(mission)
    await writeRegistry({ version: REGISTRY_VERSION, missions })
  })
}

export async function listActiveMissions(): Promise<Mission[]> {
  return (await readMissions()).filter((mission) => mission.status === "active")
}

export async function loadAllUnits(): Promise<UnitRow[]> {
  const missions = await readMissions()
  const repos = new Map<string, RepoRef>()
  for (const mission of missions) {
    for (const repo of mission.repos) {
      repos.set(repoKey(repo), repo)
    }
  }

  const units: UnitRow[] = []
  for (const repo of repos.values()) {
    units.push(...(await readRepoLedger(repo)))
  }
  return units
}
