import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Mission } from "~/lib/first-mate/registry"
import type { RepoRef } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-registry-occ-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const { upsertMission, readMissions } = await import("~/lib/first-mate/registry")
const { DurableFencedError, runFenced } = await import(
  "~/lib/first-mate/durable-store"
)
const { SchedulerLease } = await import("~/lib/first-mate/scheduler/lease")

const repo: RepoRef = { owner: "octo", name: "repo" }

interface RegistryFile {
  version: 1
  rev?: number
  missions: Mission[]
}

function mission(id: string, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    goal: `goal-${id}`,
    acceptanceCriteria: `accept-${id}`,
    repos: [repo],
    status: "active",
    createdMs: 1,
    updatedMs: 1,
    ...overrides,
  }
}

function missionsPath(): string {
  return path.join(firstMateDir, "missions.json")
}

async function readRegistryFile(): Promise<RegistryFile> {
  return JSON.parse(await fs.readFile(missionsPath(), "utf8")) as RegistryFile
}

beforeEach(async () => {
  delete process.env.GH_ROUTER_FM_OCC
  await fs.rm(firstMateDir, { recursive: true, force: true })
  await fs.mkdir(firstMateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("mission registry OCC", () => {
  test("upsertMission increments rev", async () => {
    await upsertMission(mission("m1"))
    await expect(readRegistryFile()).resolves.toMatchObject({
      version: 1,
      rev: 1,
      missions: [{ id: "m1" }],
    })

    await upsertMission(mission("m1", { goal: "updated", updatedMs: 2 }))
    const after = await readRegistryFile()
    expect(after.rev).toBe(2)
    expect(after.missions).toHaveLength(1)
    expect(after.missions[0]).toMatchObject({ id: "m1", goal: "updated" })
  })

  test("concurrent upserts of different missions converge", async () => {
    await Promise.all([
      upsertMission(mission("m1")),
      upsertMission(mission("m2")),
      upsertMission(mission("m3")),
    ])

    const after = await readRegistryFile()
    expect(after.rev).toBe(3)
    expect(after.missions.map((entry) => entry.id).sort()).toEqual(["m1", "m2", "m3"])
  })

  test("stale fencing token inside runFenced rejects and leaves file unchanged", async () => {
    await upsertMission(mission("m1"))
    const before = await fs.readFile(missionsPath(), "utf8")
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()
    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2).toBeDefined()

    await expect(
      runFenced(held1!.fencingToken, async () => {
        await upsertMission(mission("m2"))
      }),
    ).rejects.toBeInstanceOf(DurableFencedError)

    expect(await fs.readFile(missionsPath(), "utf8")).toBe(before)
    expect((await readMissions()).map((entry) => entry.id)).toEqual(["m1"])
    await lease2.release()
  })

  test("back-compat pre-rev missions.json is read as rev 0 and first commit writes rev 1", async () => {
    await fs.writeFile(
      missionsPath(),
      `${JSON.stringify({ version: 1, missions: [mission("old")] }, null, 2)}\n`,
      { mode: 0o600 },
    )

    await expect(readMissions()).resolves.toMatchObject([{ id: "old" }])
    await upsertMission(mission("new"))

    const after = await readRegistryFile()
    expect(after.rev).toBe(1)
    expect(after.missions.map((entry) => entry.id).sort()).toEqual(["new", "old"])
  })

  test("Mission.defaultModel round-trips through the registry", async () => {
    await upsertMission(mission("m-model", { defaultModel: "gpt-5.4" }))
    const [persisted] = await readMissions()
    expect(persisted?.defaultModel).toBe("gpt-5.4")
  })

  test("a mission without defaultModel still loads (back-compat)", async () => {
    await upsertMission(mission("m-nomodel"))
    const [persisted] = await readMissions()
    expect(persisted?.id).toBe("m-nomodel")
    expect(persisted?.defaultModel).toBeUndefined()
  })
})
