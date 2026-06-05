import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { ConsolaOptions, LogObject } from "consola"

// Use env var for temp dir to avoid os.tmpdir() which may be broken by
// other test files' mock.module("node:os") bleeding through.
const tmpBase = process.env.TEMP || process.env.TMPDIR || "/tmp"
const tempDir = await fsp.mkdtemp(
  path.join(tmpBase, "github-router-filelog-"),
)

// Import the reporter class directly — avoids consola module identity issues
// that arise from mock.module in the isolated test environment.
const { FileLogReporter } = await import("../../src/lib/file-log-reporter")

// The reporter now holds a persistent append fd for the file's lifetime, so
// every test's reporter MUST be closed before afterAll's recursive rm —
// Windows refuses to delete a file with an open handle. Track instances via a
// factory and close them after each test.
const openReporters: Array<{ close: () => void }> = []
function newReporter(filePath: string): InstanceType<typeof FileLogReporter> {
  const r = new FileLogReporter(filePath)
  openReporters.push(r)
  return r
}

const dummyCtx = { options: {} as ConsolaOptions }

let logFile: string
let testIndex = 0

function makeLogObj(
  type: string,
  ...args: unknown[]
): LogObject {
  return {
    date: new Date("2026-03-04T00:00:00.000Z"),
    args,
    type,
    level: type === "error" || type === "fatal" ? 0 : type === "warn" ? 1 : 3,
    tag: "",
  } as LogObject
}

beforeEach(async () => {
  testIndex++
  logFile = path.join(tempDir, `error-${testIndex}.log`)
  try { fs.unlinkSync(logFile) } catch { /* may not exist */ }
  try { fs.unlinkSync(logFile + ".1") } catch { /* may not exist */ }
})

afterEach(() => {
  // Release every reporter's persistent append fd before the next test's
  // beforeEach unlink / the suite's afterAll rm — Windows can't delete a file
  // with an open handle.
  for (const r of openReporters) r.close()
  openReporters.length = 0
})

function readLog(): string {
  try { return fs.readFileSync(logFile, "utf-8") } catch { return "" }
}

describe("FileLogReporter", () => {
  afterAll(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  test("error messages are written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "something broke"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[ERROR]")
    expect(content).toContain("something broke")
  })

  test("warn messages are written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("warn", "slow query"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[WARN]")
    expect(content).toContain("slow query")
  })

  test("fatal messages are written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("fatal", "crash"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[FATAL]")
    expect(content).toContain("crash")
  })

  test("info messages are NOT written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("info", "status update"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("debug messages are NOT written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("debug", "trace data"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("success messages are NOT written to the log file", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("success", "all good"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("duplicate messages are only written once", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)

    const lines = readLog().trim().split("\n")
    expect(lines.length).toBe(1)
  })

  test("different messages are each written", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "error-a"), dummyCtx)
    reporter.log(makeLogObj("error", "error-b"), dummyCtx)

    const content = readLog()
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(2)
    expect(content).toContain("error-a")
    expect(content).toContain("error-b")
  })

  test("Error objects are serialized safely", () => {
    const reporter = newReporter(logFile)
    const err = new Error("boom")
    reporter.log(makeLogObj("error", "failed:", err), dummyCtx)

    const content = readLog()
    expect(content).toContain("boom")
    expect(content).not.toContain("[object Error]")
  })

  test("credential patterns are redacted", () => {
    const reporter = newReporter(logFile)
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    const ghToken = "gho_abc123def456ghi789jkl012mno345pqr678"
    reporter.log(makeLogObj("error", `Token: ${jwt}`), dummyCtx)
    reporter.log(makeLogObj("warn", `Auth: ${ghToken}`), dummyCtx)

    const content = readLog()
    expect(content).not.toContain("eyJhbGci")
    expect(content).not.toContain("gho_abc123")
    expect(content).toContain("[REDACTED]")
  })

  test("newlines in args are escaped to prevent log injection", () => {
    const reporter = newReporter(logFile)
    reporter.log(
      makeLogObj("error", "Model \"evil\nFake [ERROR] injected\""),
      dummyCtx,
    )

    const lines = readLog().trim().split("\n")
    expect(lines.length).toBe(1)
    expect(readLog()).toContain("\\n")
  })

  test("file is created with 0o600 permissions on Unix", () => {
    if (process.platform === "win32") return

    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "permission test"), dummyCtx)

    const stats = fs.statSync(logFile)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test("log rotation triggers when file exceeds 1MB", () => {
    // Create a file slightly over 1MB
    const big = "x".repeat(1024 * 1024 + 100)
    fs.writeFileSync(logFile, big)

    const reporter = newReporter(logFile) // construction triggers rotation
    reporter.log(makeLogObj("error", "after rotation"), dummyCtx)

    // Original file should be small (just the new entry)
    const content = readLog()
    expect(content).toContain("after rotation")
    expect(content.length).toBeLessThan(1024)

    // Rotated file should exist
    const rotated = fs.readFileSync(logFile + ".1", "utf-8")
    expect(rotated.length).toBeGreaterThan(1024 * 1024)
  })

  test("no rotation when file is under 1MB", () => {
    fs.writeFileSync(logFile, "small content")

    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "new entry"), dummyCtx)

    // Rotated file should NOT exist
    expect(() => fs.statSync(logFile + ".1")).toThrow()

    const content = readLog()
    expect(content).toContain("new entry")
  })

  test("appendFileSync errors are swallowed silently", () => {
    // Make the log path a directory so writes will fail
    const dirPath = path.join(tempDir, `error-dir-${testIndex}`)
    fs.mkdirSync(dirPath, { recursive: true })

    const reporter = newReporter(dirPath)
    // Should not throw
    expect(() =>
      reporter.log(makeLogObj("error", "should not crash"), dummyCtx),
    ).not.toThrow()
  })

  test("log lines have ISO timestamp format", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "timestamp check"), dummyCtx)

    const content = readLog()
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test("each log line ends with newline", () => {
    const reporter = newReporter(logFile)
    reporter.log(makeLogObj("error", "line-a"), dummyCtx)
    reporter.log(makeLogObj("warn", "line-b"), dummyCtx)

    const content = readLog()
    expect(content.endsWith("\n")).toBe(true)
    const lines = content.split("\n")
    // Last element after split on trailing \n is empty string
    expect(lines[lines.length - 1]).toBe("")
  })

  // Regression test for Bug #5: rotation must fire from log(), not only from
  // the constructor. A long-running daemon that writes many unique error lines
  // after startup should never grow the log file without bound.
  //
  // Strategy: start with an empty file (so construction does NOT rotate),
  // then write enough unique lines to exceed the 1 MiB cap 3x over.
  // After all writes, the active log file must be smaller than 1 MiB.
  //
  // The unfixed code fails this assertion because rotateIfNeeded() is only
  // called in the constructor, so the append-only hot path grows the file
  // without any ceiling check.
  test("rotation fires from log() after the file grows past 1MB during a long-lived daemon run", () => {
    // Start with an empty file — construction does NOT rotate.
    fs.writeFileSync(logFile, "")
    const reporter = newReporter(logFile)

    // Each line is ~120 bytes; 1 MiB / 120 ≈ 8738 lines per MB.
    // Write 3 * 9000 = 27 000 unique error lines so we exceed 1 MiB three times.
    // Lines must be unique to defeat the dedup set; include the loop index.
    const TARGET_LINES = 27_000
    for (let i = 0; i < TARGET_LINES; i++) {
      reporter.log(makeLogObj("error", `daemon-error-unique-${i}-${"x".repeat(60)}`), dummyCtx)
    }

    const sizeAfter = fs.statSync(logFile).size
    expect(sizeAfter).toBeLessThan(1024 * 1024)
  })
})
