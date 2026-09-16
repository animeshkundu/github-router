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
  extractAndRecordPricedAic,
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
    // Raw token counts retained per model per type (11 in + 5 out, ×2).
    expect(snap.tokensByModel["gpt-5.6-luna"]).toEqual({
      input: 22,
      cache_read: 0,
      cache_write: 0,
      output: 10,
      other: 0,
    })
    // Models recorded without details still get a zeroed entry.
    expect(snap.tokensByModel["claude-haiku-4.5"]).toEqual({
      input: 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      other: 0,
    })
    // Persisted file round-trips through the hook reader.
    expect(readAicSnapshotFile(ledgerFile)).toEqual(snap)
  })

  test("unknown token types land in the other bucket, never dropped", () => {
    recordAic(
      "m",
      extractCopilotUsage({
        total_nano_aiu: 100000,
        token_details: [
          { batch_size: 1000000, cost_per_batch: 1000000, token_count: 7, token_type: "weird_future_type" },
          { batch_size: 1000000, cost_per_batch: 1000000, token_count: 3 },
        ],
      }),
    )
    const snap = aicSnapshot()
    expect(snap.tokensByModel["m"]?.other).toBe(10)
    expect(snap.tokensByModel["m"]?.input).toBe(0)
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

  test("extractAndRecordPricedAic skips zero-nano frames without recording", () => {
    // Interim streaming frames carry total_nano_aiu: 0 — a streaming tap
    // must treat that as "no reading yet", not as a free request.
    expect(
      extractAndRecordPricedAic("m", { copilot_usage: { total_nano_aiu: 0, token_details: [] } }),
    ).toBeUndefined()
    expect(aicSnapshot().requests).toBe(0)
    expect(aicSnapshot().totalNanoAiu).toBe(0)
    // Missing/invalid containers behave exactly like the unpriced variant.
    expect(extractAndRecordPricedAic("m", { usage: {} })).toBeUndefined()
    expect(extractAndRecordPricedAic("m", null)).toBeUndefined()
    expect(aicSnapshot().requests).toBe(0)
  })

  test("extractAndRecordPricedAic records the first priced reading", () => {
    const nano = extractAndRecordPricedAic("gpt-5.6-luna", { copilot_usage: USAGE_A })
    expect(nano).toBe(820000)
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().totalNanoAiu).toBe(820000)
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

  test("pre-tokens snapshot files read with empty tokensByModel", async () => {
    await fs.writeFile(
      ledgerFile,
      JSON.stringify({
        totalNanoAiu: 820000,
        requests: 1,
        perModel: { "gpt-5.6-luna": { nanoAiu: 820000, requests: 1 } },
        perTokenType: { input: 220000 },
      }),
    )
    const snap = readAicSnapshotFile(ledgerFile)
    expect(snap?.tokensByModel).toEqual({})
    expect(snap?.totalNanoAiu).toBe(820000)
  })

  test("malformed tokensByModel degrades to empty rather than failing", async () => {
    await fs.writeFile(
      ledgerFile,
      JSON.stringify({
        totalNanoAiu: 1,
        requests: 1,
        perModel: {},
        perTokenType: {},
        tokensByModel: { m: { input: -5 }, n: "nope" },
      }),
    )
    expect(readAicSnapshotFile(ledgerFile)?.tokensByModel).toEqual({})
  })
})
