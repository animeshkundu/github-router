import fs from "node:fs/promises"
import process from "node:process"

import { LogLevels } from "consola"
import type { ConsolaReporter, LogObject } from "consola"
import type { ConsolaInstance } from "consola"

import { PATHS } from "./paths"

const MAX_LOG_SIZE = 1_048_576 // 1 MB
const TRUNCATE_TO = 524_288 // 512 KB

// Dedup cache: "modelId::endpoint" keys logged this process
const loggedMismatches = new Set<string>()

// Simple lock to prevent concurrent rotation
let rotating = false

function formatTimestamp(): string {
  return new Date().toISOString()
}

function sanitize(s: string): string {
  return s.replaceAll("\n", "\\n")
}

async function doAppend(line: string): Promise<void> {
  await maybeRotate()
  await fs.appendFile(PATHS.ERROR_LOG_PATH, line)
}

function appendToLog(line: string): void {
  doAppend(line).catch((err) => {
    try {
      process.stderr.write(`[github-router] error log write failed: ${err}\n`)
    } catch {
      // nothing we can do
    }
  })
}

async function maybeRotate(): Promise<void> {
  if (rotating) return
  rotating = true
  try {
    let stat
    try {
      stat = await fs.stat(PATHS.ERROR_LOG_PATH)
    } catch {
      return // file doesn't exist yet
    }
    if (stat.size < MAX_LOG_SIZE) return

    const buf = await fs.readFile(PATHS.ERROR_LOG_PATH)
    const tail = buf.subarray(buf.length - TRUNCATE_TO)
    const firstNewline = tail.indexOf(0x0a) // '\n'
    const trimmed = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail
    await fs.writeFile(PATHS.ERROR_LOG_PATH, trimmed)
  } catch {
    // rotation failure must never crash the server
  } finally {
    rotating = false
  }
}

export function logMismatchToFile(
  modelId: string,
  endpoint: string,
  supportedEndpoints: string[],
): void {
  const key = `${modelId}::${endpoint}`
  if (loggedMismatches.has(key)) return
  loggedMismatches.add(key)

  const supported = supportedEndpoints.length > 0
    ? supportedEndpoints.join(", ")
    : "(none)"
  const line = `[${formatTimestamp()}] [MISMATCH] Model "${modelId}" does not support ${endpoint}. Supported: ${supported}\n`
  appendToLog(line)
}

export function log5xxToFile(
  method: string,
  path: string,
  status: number,
  message: string,
): void {
  const line = `[${formatTimestamp()}] [5XX] ${method} ${path} ${status} ${sanitize(message)}\n`
  appendToLog(line)
}

/**
 * Create a consola reporter that writes error/fatal messages to the log file.
 */
export function createFileReporter(): ConsolaReporter {
  return {
    log(logObj: LogObject) {
      if (logObj.level > LogLevels.error) return

      const args = logObj.args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ")
      const line = `[${formatTimestamp()}] [ERROR] ${sanitize(args)}\n`
      appendToLog(line)
    },
  }
}

/**
 * Replace all reporters with the file reporter and silence console output.
 * Use in claude/codex mode to prevent TUI corruption.
 */
export function enableFileOnlyLogging(instance: ConsolaInstance): void {
  instance.setReporters([createFileReporter()])
  instance.level = LogLevels.verbose // allow all levels to reach the reporter
}

/**
 * Add the file reporter alongside existing reporters.
 * Use in standalone mode for persistent error logs plus normal console output.
 */
export function enableFileLogging(instance: ConsolaInstance): void {
  instance.addReporter(createFileReporter())
}

/**
 * Clear the mismatch dedup cache. Exported for testing.
 */
export function resetMismatchCache(): void {
  loggedMismatches.clear()
}
