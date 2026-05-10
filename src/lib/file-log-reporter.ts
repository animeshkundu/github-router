import fs from "node:fs"
import { Writable } from "node:stream"

import consola from "consola"
import type { ConsolaOptions, ConsolaReporter, LogObject } from "consola"

import { PATHS } from "~/lib/paths"

const MAX_LOG_BYTES = 1024 * 1024 // 1 MB
const DEDUP_MAX = 1000
const ARG_MAX_LEN = 2048
const DEDUP_KEY_MAX_LEN = 200

const CREDENTIAL_RE =
  /\b(eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}|gh[opsu]_[A-Za-z0-9_]{20,}|Bearer\s+\S{20,})\b/g

const ALLOWED_TYPES = new Set(["fatal", "error", "warn"])

function sanitize(line: string): string {
  return line.replace(CREDENTIAL_RE, "[REDACTED]")
}

function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) {
    const parts = [arg.message]
    if (arg.stack) parts.push(arg.stack)
    return parts.join("\n")
  }
  return String(arg)
}

function formatLogLine(logObj: LogObject): string {
  const ts = logObj.date.toISOString()
  const level = (logObj.type ?? "error").toUpperCase()
  const message = logObj.args
    .map((a) => {
      const s = serializeArg(a)
      return s.length > ARG_MAX_LEN ? s.slice(0, ARG_MAX_LEN) + "…" : s
    })
    .join(" ")
    .replace(/\r\n|\r|\n/g, "\\n")

  return sanitize(`${ts} [${level}] ${message}\n`)
}

function makeDedupeKey(logObj: LogObject): string {
  const firstArg =
    logObj.args.length > 0 ? serializeArg(logObj.args[0]) : ""
  const key = `${logObj.type}:${firstArg}`
  return key.length > DEDUP_KEY_MAX_LEN
    ? key.slice(0, DEDUP_KEY_MAX_LEN)
    : key
}

function rotateIfNeeded(filePath: string): void {
  let size: number
  try {
    size = fs.statSync(filePath).size
  } catch {
    return // file does not exist
  }
  if (size <= MAX_LOG_BYTES) return

  try {
    fs.renameSync(filePath, filePath + ".1")
  } catch {
    // best-effort: if rename fails, continue with the existing file
  }
}

export class FileLogReporter implements ConsolaReporter {
  private readonly filePath: string
  private readonly seen = new Set<string>()

  constructor(filePath: string) {
    this.filePath = filePath
    rotateIfNeeded(filePath)
  }

  log(logObj: LogObject, _ctx: { options: ConsolaOptions }): void {
    if (!ALLOWED_TYPES.has(logObj.type)) return

    const key = makeDedupeKey(logObj)
    if (this.seen.has(key)) return

    if (this.seen.size >= DEDUP_MAX) this.seen.clear()
    this.seen.add(key)

    const line = formatLogLine(logObj)

    // fs.openSync/writeSync/closeSync are synchronous and atomic from the
    // perspective of the JS event loop — no other log() call can interleave
    // between them. The previous re-entrancy guard (`if (this.writing)
    // return`) silently dropped log lines that arrived during the same
    // call stack as a write (e.g., a consola.error fired from an error
    // handler triggered by another log). Now we just write and trust the
    // synchronicity.
    //
    // The fd is closed in `finally` so an ENOSPC/EIO from writeSync does
    // not leak the fd. Repeated logging failures otherwise escalate into
    // EMFILE and bring down the whole process's ability to open files.
    let fd: number | undefined
    try {
      fd = fs.openSync(this.filePath, "a", 0o600)
      fs.writeSync(fd, line)
    } catch {
      // Silently discard — cannot log a logging failure
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          // already closed / unwritable — nothing to do
        }
      }
    }
  }
}

const nullStream = new Writable({ write(_chunk, _encoding, cb) { cb() } })

/**
 * Switch consola to file-only mode for TUI sessions.
 * Removes the terminal reporter and installs a file reporter that
 * persists errors and warnings to disk with dedup and credential scrubbing.
 *
 * Also sinks consola's stdout/stderr streams as belt-and-suspenders:
 * even if a terminal reporter is re-added, it cannot write to the terminal.
 * Crash handlers that call process.stderr.write() directly are unaffected.
 * FileLogReporter uses fs.writeSync() directly and is also unaffected.
 */
export function enableFileLogging(): void {
  const reporter = new FileLogReporter(PATHS.ERROR_LOG_PATH)
  consola.options.throttle = 0 // disable built-in dedup
  consola.setReporters([reporter])
  consola.options.stdout = nullStream as unknown as typeof process.stdout
  consola.options.stderr = nullStream as unknown as typeof process.stderr
}
