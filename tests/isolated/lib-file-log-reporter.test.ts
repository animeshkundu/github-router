import { test, expect, describe, beforeEach, afterAll } from "bun:test"
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

function readLog(): string {
  try { return fs.readFileSync(logFile, "utf-8") } catch { return "" }
}

describe("FileLogReporter", () => {
  afterAll(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  test("error messages are written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "something broke"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[ERROR]")
    expect(content).toContain("something broke")
  })

  test("warn messages are written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("warn", "slow query"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[WARN]")
    expect(content).toContain("slow query")
  })

  test("fatal messages are written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("fatal", "crash"), dummyCtx)

    const content = readLog()
    expect(content).toContain("[FATAL]")
    expect(content).toContain("crash")
  })

  test("info messages are NOT written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("info", "status update"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("debug messages are NOT written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("debug", "trace data"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("success messages are NOT written to the log file", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("success", "all good"), dummyCtx)

    expect(readLog()).toBe("")
  })

  test("duplicate messages are only written once", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)
    reporter.log(makeLogObj("error", "same error"), dummyCtx)

    const lines = readLog().trim().split("\n")
    expect(lines.length).toBe(1)
  })

  test("different messages are each written", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "error-a"), dummyCtx)
    reporter.log(makeLogObj("error", "error-b"), dummyCtx)

    const content = readLog()
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(2)
    expect(content).toContain("error-a")
    expect(content).toContain("error-b")
  })

  test("Error objects are serialized safely", () => {
    const reporter = new FileLogReporter(logFile)
    const err = new Error("boom")
    reporter.log(makeLogObj("error", "failed:", err), dummyCtx)

    const content = readLog()
    expect(content).toContain("boom")
    expect(content).not.toContain("[object Error]")
  })

  test("credential patterns are redacted", () => {
    const reporter = new FileLogReporter(logFile)
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
    const reporter = new FileLogReporter(logFile)
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

    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "permission test"), dummyCtx)

    const stats = fs.statSync(logFile)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test("log rotation triggers when file exceeds 1MB", () => {
    // Create a file slightly over 1MB
    const big = "x".repeat(1024 * 1024 + 100)
    fs.writeFileSync(logFile, big)

    const reporter = new FileLogReporter(logFile) // construction triggers rotation
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

    const reporter = new FileLogReporter(logFile)
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

    const reporter = new FileLogReporter(dirPath)
    // Should not throw
    expect(() =>
      reporter.log(makeLogObj("error", "should not crash"), dummyCtx),
    ).not.toThrow()
  })

  test("log lines have ISO timestamp format", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "timestamp check"), dummyCtx)

    const content = readLog()
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test("each log line ends with newline", () => {
    const reporter = new FileLogReporter(logFile)
    reporter.log(makeLogObj("error", "line-a"), dummyCtx)
    reporter.log(makeLogObj("warn", "line-b"), dummyCtx)

    const content = readLog()
    expect(content.endsWith("\n")).toBe(true)
    const lines = content.split("\n")
    // Last element after split on trailing \n is empty string
    expect(lines[lines.length - 1]).toBe("")
  })
})
