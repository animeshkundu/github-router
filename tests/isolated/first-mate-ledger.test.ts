import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Mission } from "~/lib/first-mate/registry"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "first-mate-ledger-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const { PATHS } = await import("~/lib/paths")
const {
  readRepoLedger,
  upsertUnit,
} = await import("~/lib/first-mate/ledger")
const {
  loadAllUnits,
  upsertMission,
} = await import("~/lib/first-mate/registry")

const repoA: RepoRef = { owner: "octo", name: "alpha" }
const repoB: RepoRef = { owner: "octo", name: "beta" }

function unit(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "mission-1",
    repo: repoA,
    issue: 1,
    pr: null,
    taskId: "task-1",
    agent: "copilot",
    botLogin: "copilot-swe-agent",
    dispatchMode: "build",
    provider: "in_progress",
    phase: "build",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "unit",
    ...overrides,
  }
}

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    goal: "ship the feature",
    acceptanceCriteria: "all units are complete",
    repos: [repoA, repoB],
    status: "active",
    createdMs: 1,
    updatedMs: 2,
    ...overrides,
  }
}

beforeEach(async () => {
  await fs.rm(PATHS.FIRST_MATE_DIR, { recursive: true, force: true })
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("first-mate durable ledger", () => {
  test("upsertUnit then readRepoLedger round-trips a unit", async () => {
    const expected = unit({ title: "round trip" })
    await upsertUnit(repoA, expected)

    expect(await readRepoLedger(repoA)).toEqual([expected])
  })

  test("a unit in every validation state survives the read filter (no silent drop)", async () => {
    // Regression: "no_ci" was added to the Validation type but not the ledger's
    // runtime validator set, so isUnitRow dropped no_ci units on read (data loss).
    const validations = [
      "unknown", "ci_running", "ci_passed", "ci_failed", "no_ci",
      "review_pending", "changes_requested", "floor_pending", "floor_passed", "floor_failed",
    ] as const
    for (const [i, validation] of validations.entries()) {
      await upsertUnit(repoA, unit({ issue: 100 + i, taskId: `t-${validation}`, validation }))
    }
    const persisted = await readRepoLedger(repoA)
    expect(persisted).toHaveLength(validations.length)
    expect(persisted.map((u) => u.validation).sort()).toEqual([...validations].sort())
  })

  test("a unit's dispatch-intent (outbox) field round-trips through the ledger", async () => {
    const withIntent = unit({
      issue: 200,
      taskId: null,
      provider: "none",
      dispatch: { id: "corr-abc", requestedMs: 123, attempts: 1 },
    })
    await upsertUnit(repoA, withIntent)
    const [persisted] = await readRepoLedger(repoA)
    expect(persisted?.dispatch).toEqual({ id: "corr-abc", requestedMs: 123, attempts: 1 })
  })

  test("upsertUnit replaces by issue", async () => {
    await upsertUnit(repoA, unit({ issue: 7, taskId: "task-a", title: "first" }))
    await upsertUnit(repoA, unit({ issue: 7, taskId: "task-b", title: "second" }))

    const rows = await readRepoLedger(repoA)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBe("task-b")
    expect(rows[0]?.title).toBe("second")
  })

  test("validate-on-read returns [] for a corrupt ledger file", async () => {
    await fs.mkdir(PATHS.FIRST_MATE_DIR, { recursive: true })
    await fs.writeFile(path.join(PATHS.FIRST_MATE_DIR, "octo__alpha.json"), "garbage")

    expect(await readRepoLedger(repoA)).toEqual([])
  })

  test("loadAllUnits reconstructs units across mission repos", async () => {
    const first = unit({ repo: repoA, issue: 1, taskId: "task-a", title: "alpha" })
    const second = unit({ repo: repoB, issue: 2, taskId: "task-b", title: "beta" })

    await upsertUnit(repoA, first)
    await upsertUnit(repoB, second)
    await upsertMission(mission({ repos: [repoA, repoB] }))

    const rows = await loadAllUnits()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.title))).toEqual(new Set(["alpha", "beta"]))
  })

  test("concurrent upserts serialize without corrupting the ledger", async () => {
    const expected = Array.from({ length: 20 }, (_, index) =>
      unit({
        issue: index + 1,
        taskId: `task-${index + 1}`,
        title: `unit-${index + 1}`,
      }),
    )

    await Promise.all(expected.map((row) => upsertUnit(repoA, row)))

    const rows = await readRepoLedger(repoA)
    expect(rows).toHaveLength(expected.length)
    expect(new Set(rows.map((row) => row.issue))).toEqual(
      new Set(expected.map((row) => row.issue)),
    )
  })
})
