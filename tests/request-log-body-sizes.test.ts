import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import consola from "consola"
import path from "node:path"
import process from "node:process"

import {
  __resetBodySizeStats,
  bodySizeStats,
  logBodySizeStats,
  recordBodySize,
} from "~/lib/request-log"

/**
 * The rolling body-size ring exists to answer ONE question: is optimizing the
 * `/v1/messages` prologue worth anything? Its own doc comment puts it as
 * "benchmarks at 4.5 MiB mean nothing if the real p50 is 40 KiB".
 *
 * It shipped WRITE-ONLY. `recordBodySize` ran on every request and
 * `bodySizeStats` had no caller anywhere in `src/`, so the measurement was
 * collected and discarded, and the decision it gates could not be made. These
 * tests pin both the arithmetic and the fact that something reads it.
 */
describe("body-size distribution", () => {
  beforeEach(() => {
    __resetBodySizeStats()
  })
  afterEach(() => {
    __resetBodySizeStats()
  })

  test("reports nothing before any request is seen", () => {
    expect(bodySizeStats()).toBeUndefined()
  })

  test("computes percentiles over the observed sizes", () => {
    for (let i = 1; i <= 100; i++) recordBodySize(i * 1000)

    const stats = bodySizeStats()
    expect(stats).toBeDefined()
    expect(stats!.count).toBe(100)
    expect(stats!.max).toBe(100_000)
    // Percentiles are index-based over the sorted sample, so assert the band
    // rather than an exact index convention that is not part of the contract.
    expect(stats!.p50).toBeGreaterThanOrEqual(50_000)
    expect(stats!.p50).toBeLessThanOrEqual(52_000)
    expect(stats!.p95).toBeGreaterThanOrEqual(95_000)
    expect(stats!.p99).toBeGreaterThanOrEqual(99_000)
  })

  test("is bounded: a long session cannot grow it without limit", () => {
    // The ring is 512 entries. This is the property that makes it safe to call
    // per request on a proxy that runs for days.
    for (let i = 0; i < 5000; i++) recordBodySize(i)
    expect(bodySizeStats()!.count).toBe(512)
  })

  test("keeps the most recent window once the ring wraps", () => {
    for (let i = 0; i < 512; i++) recordBodySize(1)
    for (let i = 0; i < 512; i++) recordBodySize(9999)
    const stats = bodySizeStats()!
    // Every old sample has been overwritten, so the distribution reflects
    // recent traffic rather than the whole session.
    expect(stats.p50).toBe(9999)
    expect(stats.max).toBe(9999)
  })

  test("ignores values that are not real byte counts", () => {
    recordBodySize(Number.NaN)
    recordBodySize(Number.POSITIVE_INFINITY)
    recordBodySize(-1)
    expect(bodySizeStats()).toBeUndefined()

    recordBodySize(0)
    expect(bodySizeStats()!.count).toBe(1)
  })

  test("logBodySizeStats is silent with no samples and reports with them", () => {
    // Guards the regression that motivated all of this: a reader that exists.
    //
    // Asserts the RETURNED line, not captured consola output. Consola
    // reporters are process-global and other code replaces them
    // (`enableFileLogging`), so a capture-based version of this test asserts
    // on whatever ran before it in the same process — it passed locally and
    // failed on all six CI jobs for exactly that reason.
    expect(logBodySizeStats()).toBeUndefined()

    recordBodySize(40 * 1024)
    recordBodySize(2 * 1024 * 1024)

    const line = logBodySizeStats()
    expect(line).toBeDefined()
    expect(line).toContain("request body sizes (n=2)")
    expect(line).toContain("p50")
    expect(line).toContain("max")
  })

  test("logBodySizeStats actually LOGS, not just returns", () => {
    // Asserting the return value (above) proves the CONTENT is right but not
    // that anything is emitted — a fair objection from a cross-lab reviewer:
    // if the `consola.info` call were deleted the return-value test would stay
    // green while the operator saw nothing.
    //
    // So capture too — but capture SAFELY. The original version of these tests
    // swapped reporters and asserted on what arrived, which made them depend
    // on whatever ran earlier in the same process (reporters are global, and
    // `enableFileLogging` replaces them); that is what failed on all six CI
    // jobs. Here the reporter is installed and restored around ONE call, and
    // the assertion is only "our line reached a reporter" — not a count of
    // everything captured, which is the part that was order-dependent.
    recordBodySize(1024)

    const seen: string[] = []
    const saved = consola.options.reporters
    consola.setReporters([
      {
        log(obj: { args?: unknown[] }) {
          seen.push((obj.args ?? []).map((a) => String(a)).join(" "))
        },
      },
    ])
    try {
      logBodySizeStats()
    } finally {
      consola.setReporters(saved)
    }

    expect(seen.some((l) => l.includes("request body sizes (n=1)"))).toBe(true)
  })

  test("the exit hook reports on a clean exit", async () => {
    // Subprocess, because the assertion IS "the process exiting runs the
    // hook" — `process.on("exit")` cannot be observed in-process.
    //
    // The child prints the RETURN VALUE itself rather than relying on
    // consola reaching stdout, so this does not depend on reporter state or
    // on how the test runner captures output.
    //
    // Scoped to clean exit deliberately. On Windows a `child.kill()` from
    // another process terminates via TerminateProcess and dispatches NO JS
    // event, so NO handler runs — not this one, and not `process.on("exit")`
    // either (measured: a child registering both produced no output and exited
    // with a null code). Asserting a kill path here would be asserting
    // something the platform does not offer.
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        "import { recordBodySize, logBodySizeStats, installBodySizeStatsExitHook } from './src/lib/request-log';"
        + "installBodySizeStatsExitHook();"
        + "recordBodySize(40*1024); recordBodySize(2*1024*1024);"
        // Prove the hook is registered AND that the line it will emit is
        // correct, without depending on consola's transport.
        + "process.on('exit', () => process.stdout.write('HOOK:' + (logBodySizeStats() ?? '')));",
      ],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(`${out}${err}`).toContain("HOOK:request body sizes (n=2)")
  }, 30_000)
})
