import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  __resetAicLedgerForTests,
  aicLedgerPath,
  aicSnapshot,
  aicTotalCredits,
  extractAndRecordAic,
  formatAicExitSummary,
  formatAicStatus,
  readAicSnapshotFile,
  recordAic,
} from "~/lib/aic-ledger"
import { extractCopilotUsage } from "~/lib/aic-usage"

const USAGE_A = {
  total_nano_aiu: 820000,
  token_details: [
    { batch_size: 1000000, cost_per_batch: 20000000000, model: "gpt-5.6-luna", token_count: 11, token_type: "input" },
    { batch_size: 1000000, cost_per_batch: 120000000000, model: "gpt-5.6-luna", token_count: 5, token_type: "output" },
  ],
}

describe("aic ledger", () => {
  let dir: string
  let ledgerFile: string
  let savedEnv: string | undefined

  beforeEach(async () => {
    __resetAicLedgerForTests()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-"))
    ledgerFile = path.join(dir, "ledger.json")
    savedEnv = process.env.GH_ROUTER_AIC_LEDGER
    process.env.GH_ROUTER_AIC_LEDGER = ledgerFile
  })

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GH_ROUTER_AIC_LEDGER
    else process.env.GH_ROUTER_AIC_LEDGER = savedEnv
    __resetAicLedgerForTests()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("aicLedgerPath honors GH_ROUTER_AIC_LEDGER", () => {
    expect(aicLedgerPath()).toBe(ledgerFile)
  })

  test("record accumulates totals, per-model, and per-type + persists", () => {
    recordAic("gpt-5.6-luna", extractCopilotUsage(USAGE_A))
    recordAic("gpt-5.6-luna", extractCopilotUsage(USAGE_A))
    recordAic("claude-haiku-4.5", extractCopilotUsage({ total_nano_aiu: 3200000, token_details: [] }))
    const snap = aicSnapshot()
    expect(snap.requests).toBe(3)
    expect(snap.totalNanoAiu).toBe(820000 * 2 + 3200000)
    expect(snap.perModel["gpt-5.6-luna"]).toEqual({ nanoAiu: 1640000, requests: 2 })
    expect(snap.perModel["claude-haiku-4.5"]).toEqual({ nanoAiu: 3200000, requests: 1 })
    // Reconstructed per-type nano: 11×20e9/1e6=220000 input, 5×120e9/1e6=600000 output, ×2.
    expect(snap.perTokenType.input).toBe(440000)
    expect(snap.perTokenType.output).toBe(1200000)
    // Persisted file round-trips through the hook reader.
    expect(readAicSnapshotFile(ledgerFile)).toEqual(snap)
  })

  test("record is a no-op on undefined usage", () => {
    recordAic("m", undefined)
    expect(aicSnapshot().requests).toBe(0)
  })

  test("extractAndRecordAic reads .copilot_usage and returns nano", () => {
    const nano = extractAndRecordAic("gpt-5.6-luna", { copilot_usage: USAGE_A, usage: {} })
    expect(nano).toBe(820000)
    expect(aicSnapshot().requests).toBe(1)
    expect(extractAndRecordAic("m", { usage: {} })).toBeUndefined()
    expect(extractAndRecordAic("m", null)).toBeUndefined()
    expect(aicSnapshot().requests).toBe(1)
  })

  test("formatAicStatus is empty pre-first-record, [AIC x] after", () => {
    expect(formatAicStatus(aicSnapshot())).toBe("")
    recordAic("m", extractCopilotUsage(USAGE_A))
    expect(formatAicStatus(aicSnapshot())).toBe("[AIC 0.00082]")
  })

  test("formatAicExitSummary totals always, breakdown only when verbose", () => {
    recordAic("gpt-5.6-luna", extractCopilotUsage(USAGE_A))
    const terse = formatAicExitSummary(aicSnapshot())
    expect(terse).toContain("AIC consumed this session:")
    expect(terse).toContain("across 1 request")
    expect(terse).not.toContain("gpt-5.6-luna")
    const verbose = formatAicExitSummary(aicSnapshot(), { verbose: true })
    expect(verbose).toContain("gpt-5.6-luna")
    expect(verbose).toContain("by type:")
  })

  test("aicTotalCredits converts", () => {
    recordAic("m", extractCopilotUsage(USAGE_A))
    expect(aicTotalCredits(aicSnapshot())).toBeCloseTo(0.00082, 12)
  })

  test("readAicSnapshotFile returns undefined for garbage", async () => {
    await fs.writeFile(ledgerFile, "not json {")
    expect(readAicSnapshotFile(ledgerFile)).toBeUndefined()
    await fs.writeFile(ledgerFile, JSON.stringify([1, 2]))
    expect(readAicSnapshotFile(ledgerFile)).toBeUndefined()
    expect(readAicSnapshotFile(path.join(dir, "missing.json"))).toBeUndefined()
  })
})
