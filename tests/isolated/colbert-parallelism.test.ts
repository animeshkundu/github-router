/**
 * colgrep encoding-parallelism cap.
 *
 * Lives in the ISOLATED lane because it needs the REAL `node:os`.
 * tests/isolated/colbert.test.ts calls `mock.module("node:os", ...)` with a
 * homedir/tmpdir-only stub; bun applies that process-globally and
 * permanently, so in the shared lane-1 process `os.cpus` is already
 * undefined by the time this file loads — and the thread count this logic
 * is entirely about disappears with it. Its own process keeps the real one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"

const realThreads = os.availableParallelism?.() ?? os.cpus().length

describe("colgrep parallelism cap", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.GH_ROUTER_COLBERT_PARALLEL
    delete process.env.GH_ROUTER_COLBERT_PARALLEL
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.GH_ROUTER_COLBERT_PARALLEL
    else process.env.GH_ROUTER_COLBERT_PARALLEL = saved
  })

  test("uses 25% of the machine's threads", async () => {
    const { colbertParallelSessions } = await import("../../src/lib/colbert/runner")
    expect(colbertParallelSessions()).toBe(Math.max(2, Math.floor(realThreads * 0.25)))
  })

  test("never exceeds a quarter of the threads — a background build must not take the box", async () => {
    const { colbertParallelSessions } = await import("../../src/lib/colbert/runner")
    const sessions = colbertParallelSessions()
    // Only meaningful once the quarter-share clears the floor of 2.
    if (realThreads >= 8) expect(sessions).toBeLessThanOrEqual(realThreads / 4)
    expect(sessions).toBeLessThan(realThreads)
  })

  test("never drops below 2, so a small box does not index single-threaded", async () => {
    const { colbertParallelSessions } = await import("../../src/lib/colbert/runner")
    expect(colbertParallelSessions()).toBeGreaterThanOrEqual(2)
  })

  test("an explicit override wins", async () => {
    const { colbertParallelSessions } = await import("../../src/lib/colbert/runner")
    process.env.GH_ROUTER_COLBERT_PARALLEL = "13"
    expect(colbertParallelSessions()).toBe(13)
  })

  test("a junk or non-positive override falls back to the computed cap", async () => {
    const { colbertParallelSessions } = await import("../../src/lib/colbert/runner")
    const computed = Math.max(2, Math.floor(realThreads * 0.25))
    for (const junk of ["0", "-4", "abc", "2.5", "", " "]) {
      process.env.GH_ROUTER_COLBERT_PARALLEL = junk
      expect(colbertParallelSessions(), `override ${JSON.stringify(junk)}`).toBe(computed)
    }
  })
})
