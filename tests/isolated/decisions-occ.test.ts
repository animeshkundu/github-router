import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { RepoRef } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-decisions-occ-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const {
  readDecisions,
  upsertDecision,
  withDecisionsMutation,
} = await import("~/lib/first-mate/decisions")
const {
  recordApproval,
  releaseApproval,
  verifyAndConsumeApproval,
} = await import("~/lib/first-mate/approval")
const { DurableFencedError, runFenced } = await import(
  "~/lib/first-mate/durable-store"
)
const { SchedulerLease } = await import("~/lib/first-mate/scheduler/lease")

const repo: RepoRef = { owner: "octo", name: "repo" }

interface DecisionsFile {
  version: 1
  rev?: number
  decisions: DecisionRecord[]
}

function decisionsPath(): string {
  return path.join(firstMateDir, "decisions.json")
}

function decision(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: id,
    decisionKey: `merge:octo/repo#7:${id}`,
    type: "merge_approval",
    status: "pending",
    packetId: `packet-${id}`,
    inputFingerprint: `fingerprint-${id}`,
    options: [{ id: "approve" }, { id: "hold" }],
    createdMs: 1,
    ...overrides,
  }
}

async function readDecisionsFile(): Promise<DecisionsFile> {
  return JSON.parse(await fs.readFile(decisionsPath(), "utf8")) as DecisionsFile
}

async function approve(
  id = "approval-decision",
  overrides: Partial<DecisionRecord> = {},
): Promise<DecisionRecord> {
  const rec = decision(id, overrides)
  await upsertDecision(rec)
  await recordApproval({
    decisionId: rec.decisionId,
    repo,
    pr: 7,
    headSha: "head-1",
    baseSha: "base-1",
    diffDigest: "diff-1",
    requiredCheckIds: ["ci"],
    floorRunId: "floor-1",
  })
  return rec
}

beforeEach(async () => {
  delete process.env.GH_ROUTER_FM_OCC
  await fs.rm(firstMateDir, { recursive: true, force: true })
  await fs.mkdir(firstMateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("decisions OCC", () => {
  test("withDecisionsMutation increments rev and returns the work value", async () => {
    const result = await withDecisionsMutation((decisions) => {
      decisions.push(decision("d1"))
      return "inserted"
    })

    expect(result).toBe("inserted")
    await expect(readDecisionsFile()).resolves.toMatchObject({
      version: 1,
      rev: 1,
      decisions: [{ decisionId: "d1" }],
    })

    const count = await withDecisionsMutation((decisions) => {
      decisions.push(decision("d2"))
      return decisions.length
    })
    expect(count).toBe(2)
    await expect(readDecisionsFile()).resolves.toMatchObject({ rev: 2 })
  })

  test("concurrent mutations converge without lost updates", async () => {
    await Promise.all([
      withDecisionsMutation((decisions) => {
        decisions.push(decision("d1"))
      }),
      withDecisionsMutation((decisions) => {
        decisions.push(decision("d2"))
      }),
      withDecisionsMutation((decisions) => {
        decisions.push(decision("d3"))
      }),
    ])

    const after = await readDecisionsFile()
    expect(after.rev).toBe(3)
    expect(after.decisions.map((entry) => entry.decisionId).sort()).toEqual([
      "d1",
      "d2",
      "d3",
    ])
  })

  test("stale fencing token inside runFenced rejects and leaves file unchanged", async () => {
    await upsertDecision(decision("d1"))
    const before = await fs.readFile(decisionsPath(), "utf8")
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()
    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2).toBeDefined()

    await expect(
      runFenced(held1!.fencingToken, async () => {
        await withDecisionsMutation((decisions) => {
          decisions.push(decision("d2"))
        })
      }),
    ).rejects.toBeInstanceOf(DurableFencedError)

    expect(await fs.readFile(decisionsPath(), "utf8")).toBe(before)
    expect((await readDecisions()).map((entry) => entry.decisionId)).toEqual(["d1"])
    await lease2.release()
  })

  test("two concurrent verifyAndConsumeApproval calls consume exactly once", async () => {
    await approve()

    const results = await Promise.all([
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ])

    expect(results.filter((result) => result.ok).length).toBe(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "replayed" },
    ])
    expect((await readDecisions())[0]?.approval?.consumed).toBe(true)
  })

  test("approval head_moved and base_moved guards still work", async () => {
    await approve()

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-2",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: false, reason: "head_moved" })

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-2",
      }),
    ).resolves.toEqual({ ok: false, reason: "base_moved" })

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: true })
  })

  test("releaseApproval then re-verify succeeds", async () => {
    await approve()

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: true })
    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: false, reason: "replayed" })

    await releaseApproval({ repo, pr: 7, headSha: "head-1" })

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: true })
  })

  test("back-compat pre-rev decisions.json is read as rev 0 and first commit writes rev 1", async () => {
    await fs.writeFile(
      decisionsPath(),
      `${JSON.stringify({ version: 1, decisions: [decision("old")] }, null, 2)}\n`,
      { mode: 0o600 },
    )

    await expect(readDecisions()).resolves.toMatchObject([{ decisionId: "old" }])
    await withDecisionsMutation((decisions) => {
      decisions.push(decision("new"))
    })

    const after = await readDecisionsFile()
    expect(after.rev).toBe(1)
    expect(after.decisions.map((entry) => entry.decisionId).sort()).toEqual([
      "new",
      "old",
    ])
  })
})
