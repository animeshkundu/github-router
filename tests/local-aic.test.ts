// AIC accounting for the local profiles.
//
// A local lead turn costs nothing, and the ledger must SAY so. Two failure
// modes are pinned here: (1) filing a local `opus` under a Copilot model,
// which `resolveModel`/`aicModelKey` would do, misattributing a free turn to a
// billed one; (2) rendering nothing at all for a measured zero, which is
// indistinguishable from a ledger that never worked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  __resetAicLedgerForTests,
  aicSnapshot,
  aicTotalCredits,
  formatAicExitSummary,
  formatAicStatus,
  readAicSnapshotFile,
  recordZeroCostRequest,
  type AicSnapshot,
} from "~/lib/aic-ledger"
import { discountedUsdForSnapshot } from "~/lib/copilot-discount"
import { composeAicStatusLine } from "~/internal-aic-status"

function emptySnapshot(over: Partial<AicSnapshot> = {}): AicSnapshot {
  return {
    requests: 0,
    totalNanoAiu: 0,
    perModel: {},
    perTokenType: { input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0 },
    tokensByModel: {},
    ...over,
  } as AicSnapshot
}

describe("recordZeroCostRequest", () => {
  let dir: string
  let ledgerFile: string
  let savedEnv: string | undefined

  beforeEach(async () => {
    __resetAicLedgerForTests()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-local-"))
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

  test("counts the request at zero and keys the RAW local id", () => {
    recordZeroCostRequest("opus")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(0)
    expect(snap.perModel.opus).toEqual({ nanoAiu: 0, requests: 1 })
    // The whole point: `resolveModel("opus")` would say `claude-opus-5.5`, and
    // a free local turn must never be attributed to a billed Copilot model.
    expect(snap.perModel["claude-opus-5.5"]).toBeUndefined()
  })

  test("accumulates across turns without inventing cost", () => {
    recordZeroCostRequest("opus")
    recordZeroCostRequest("opus")
    recordZeroCostRequest("sonnet")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(3)
    expect(snap.totalNanoAiu).toBe(0)
    expect(snap.perModel.opus).toEqual({ nanoAiu: 0, requests: 2 })
    expect(snap.perModel.sonnet).toEqual({ nanoAiu: 0, requests: 1 })
  })

  test("an absent model is filed as unknown, not dropped", () => {
    recordZeroCostRequest(undefined)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.perModel.unknown).toEqual({ nanoAiu: 0, requests: 1 })
  })

  test("persists, so the status-line hook sees it from its own process", async () => {
    recordZeroCostRequest("opus")
    // The status line runs `internal-aic-status` as a separate process and
    // reads the file, not this process's module state.
    await new Promise((r) => setTimeout(r, 10))
    const onDisk = readAicSnapshotFile(ledgerFile)
    expect(onDisk?.requests).toBe(1)
    expect(onDisk?.perModel.opus?.requests).toBe(1)
  })
})

describe("formatAicStatus", () => {
  test("a measured zero renders as a number, not an absence", () => {
    expect(formatAicStatus(emptySnapshot({ requests: 3 }))).toBe("[AIC 0.00]")
  })

  test("nothing recorded at all still renders nothing", () => {
    expect(formatAicStatus(emptySnapshot())).toBe("")
  })

  test("a priced request keeps the existing shape", () => {
    // 1 credit = 1e9 nano; 12.42 credits renders with exactly two decimals.
    const nano = 12_420_000_000
    expect(
      formatAicStatus(
        emptySnapshot({
          requests: 1,
          totalNanoAiu: nano,
          perModel: { "gpt-6-luna": { nanoAiu: nano, requests: 1 } },
        }),
      ),
    ).toBe("[AIC 12.42]")
  })
})

describe("status line composition", () => {
  test("the zero fragment is prepended like any other", () => {
    expect(composeAicStatusLine("[AIC 0.00]", "/repo  opus")).toBe(
      "[AIC 0.00] /repo  opus",
    )
  })
})

describe("spend display", () => {
  test("a zero-cost session reports $0, never an unknown placeholder", () => {
    const zero = emptySnapshot({
      requests: 3,
      perModel: { opus: { nanoAiu: 0, requests: 3 } },
    })
    expect(aicTotalCredits(zero)).toBe(0)
    // This is the value the status line renders as `~$0.00`; `undefined` (the
    // "unknown" path) is what produces `~$--`.
    expect(discountedUsdForSnapshot(zero).total).toBe(0)
  })
})

describe("formatAicExitSummary", () => {
  test("needs no edit to read correctly for a local session", () => {
    const snap = emptySnapshot({
      requests: 3,
      perModel: { opus: { nanoAiu: 0, requests: 3 } },
    })
    expect(formatAicExitSummary(snap)).toBe(
      "AIC consumed this session: 0 credits (~$0.00) across 3 requests",
    )
    expect(formatAicExitSummary(snap, { verbose: true })).toContain(
      "opus: 0 credits across 3 requests",
    )
  })
})
