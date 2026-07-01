import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { RepoRef } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "first-mate-decision-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const { PATHS } = await import("~/lib/paths")
const { buildDecisionPacket, esc } = await import("~/lib/first-mate/decision-packet")
const {
  findByKey,
  markAnswered,
  readDecisions,
  upsertDecision,
} = await import("~/lib/first-mate/decisions")
const {
  recordApproval,
  verifyAndConsumeApproval,
} = await import("~/lib/first-mate/approval")

const repo: RepoRef = { owner: "octo", name: "repo" }

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: "decision-1",
    decisionKey: "merge:octo/repo#7",
    type: "merge_approval",
    status: "pending",
    packetId: "packet-1",
    inputFingerprint: "fingerprint-1",
    options: [{ id: "approve" }, { id: "hold" }],
    createdMs: 1,
    ...overrides,
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

async function approve(overrides: Partial<DecisionRecord> = {}): Promise<DecisionRecord> {
  const rec = decision(overrides)
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
  await fs.rm(PATHS.FIRST_MATE_DIR, { recursive: true, force: true })
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("decision packet HTML", () => {
  test("escapes interpolated text and emits option cards", () => {
    const xss = `<img src=x onerror="alert('xss')">`
    const { html, decisionId, packetId } = buildDecisionPacket({
      type: "merge_approval",
      tldr: `Ship it ${xss}`,
      question: "Merge this PR?",
      options: [
        {
          id: "approve",
          label: `Approve ${xss}`,
          consequence: "The PR will merge.",
          recommended: true,
        },
        {
          id: "hold",
          label: "Hold",
          consequence: "The PR stays open.",
        },
      ],
      evidence: {
        prSummary: xss,
        ciExcerpt: `failed && ${xss}`,
        floorVerdict: "passed",
        links: [
          { label: `PR ${xss}`, url: "https://github.com/octo/repo/pull/7?x=1&y=2" },
          { label: "bad", url: "javascript:alert(1)" },
        ],
      },
      missionId: "mission-1",
      repo,
      unit: { issue: 1, pr: 7 },
    })

    expect(packetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(decisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;")
    expect(count(html, `<span class="badge"`)).toBe(1)
    expect(html).toContain(">Recommended</span>")
    expect(count(html, `<section class="option" data-option=`)).toBe(2)
    expect(html).toContain(`data-option="approve"`)
    expect(html).toContain(`data-option="hold"`)
    expect(html).toContain("https://github.com/octo/repo/pull/7?x=1&amp;y=2")
    expect(html).not.toContain("javascript:alert")
  })

  test("esc escapes HTML-sensitive characters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })
})

describe("decisions ledger", () => {
  test("upsertDecision, findByKey, and markAnswered round-trip", async () => {
    await upsertDecision(decision({ decisionId: "decision-a", decisionKey: "key-a" }))

    expect(await findByKey("key-a")).toMatchObject({
      decisionId: "decision-a",
      status: "pending",
    })

    await markAnswered("decision-a", "approve", "human")
    expect(await findByKey("key-a")).toMatchObject({
      decisionId: "decision-a",
      status: "answered",
      chosenOptionId: "approve",
      resolvedBy: "human",
    })
    expect(typeof (await findByKey("key-a"))?.resolvedMs).toBe("number")
  })
})

describe("approval gate", () => {
  test("recordApproval then verifyAndConsumeApproval succeeds once and rejects replay", async () => {
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
  })

  test("rejects when the approved head moved", async () => {
    await approve()

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-2",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: false, reason: "head_moved" })
  })

  test("rejects when the approved base moved", async () => {
    await approve()

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-2",
      }),
    ).resolves.toEqual({ ok: false, reason: "base_moved" })
  })

  test("rejects when no approval exists", async () => {
    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: false, reason: "no_approval" })
  })

  test("approval survives a fresh read and remains consumable", async () => {
    await approve({ decisionId: "restart-decision", decisionKey: "restart-key" })

    const rows = await readDecisions()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.approval).toMatchObject({
      decisionId: "restart-decision",
      repo,
      pr: 7,
      headSha: "head-1",
      baseSha: "base-1",
      status: "approved",
      consumed: false,
    })

    await expect(
      verifyAndConsumeApproval({
        repo,
        pr: 7,
        liveHeadSha: "head-1",
        liveBaseSha: "base-1",
      }),
    ).resolves.toEqual({ ok: true })
  })
})
