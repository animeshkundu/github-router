import { createHash } from "node:crypto"
import fs from "node:fs"
import { Writable } from "node:stream"

import consola from "consola"
import type { ConsolaOptions, ConsolaReporter, LogObject } from "consola"

import { PATHS } from "~/lib/paths"

const MAX_LOG_BYTES = 1024 * 1024 // 1 MB
const DEDUP_MAX = 1000
const ARG_MAX_LEN = 2048
const ERROR_CAUSE_MAX_DEPTH = 4
const ERROR_FIELD_MAX_LEN = 512

const CREDENTIAL_RE =
  /\b(eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}|gh[opsu]_[A-Za-z0-9_]{20,}|Bearer\s+\S{20,})\b/g
const ERROR_BODY_RE = /\b(request\s+body|body)\s*[:=]\s*.*$/i

const ALLOWED_TYPES = new Set(["fatal", "error", "warn"])

function sanitize(line: string): string {
  return line.replace(CREDENTIAL_RE, "[REDACTED]")
}

function errorProperty(error: unknown, key: string): string | undefined {
  if (
    (typeof error !== "object" && typeof error !== "function")
    || error === null
  ) {
    return undefined
  }
  try {
    const value = (error as Record<string, unknown>)[key]
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

function errorCause(error: unknown): unknown {
  if (
    (typeof error !== "object" && typeof error !== "function")
    || error === null
  ) {
    return undefined
  }
  try {
    return (error as { cause?: unknown }).cause
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "[unserializable]"
  }
}

function boundErrorField(value: string): string {
  return value.length > ERROR_FIELD_MAX_LEN
    ? `${value.slice(0, ERROR_FIELD_MAX_LEN)}…`
    : value
}

function sanitizeErrorMessage(value: string): string {
  return sanitize(value).replace(ERROR_BODY_RE, "$1=[REDACTED]")
}

function serializeError(error: Error): string {
  const chain: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  for (
    let depth = 0;
    current !== undefined && depth <= ERROR_CAUSE_MAX_DEPTH;
    depth++
  ) {
    if (
      (typeof current === "object" || typeof current === "function")
      && current !== null
    ) {
      if (seen.has(current)) {
        chain.push("[circular cause]")
        break
      }
      seen.add(current)
    }

    const name = boundErrorField(errorProperty(current, "name") ?? "Error")
    const message = boundErrorField(
      sanitizeErrorMessage(
        errorProperty(current, "message")
          ?? (typeof current === "string" ? current : safeString(current)),
      ),
    )
    const rawCode = errorProperty(current, "code")
    const code = rawCode ? boundErrorField(rawCode) : undefined
    chain.push(`${name}: ${message}${code ? ` code=${code}` : ""}`)

    const cause = errorCause(current)
    if (cause === undefined) break
    if (depth === ERROR_CAUSE_MAX_DEPTH) {
      chain.push("[cause chain truncated]")
      break
    }
    current = cause
  }

  return chain.join(" <- cause: ")
}

function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return serializeError(arg)
  return safeString(arg)
}

function serializeArgs(logObj: LogObject): string[] {
  return logObj.args.map((arg) => {
    const serialized = sanitize(serializeArg(arg))
    return serialized.length > ARG_MAX_LEN
      ? `${serialized.slice(0, ARG_MAX_LEN)}…`
      : serialized
  })
}

function formatLogLine(logObj: LogObject): string {
  const ts = logObj.date.toISOString()
  const level = (logObj.type ?? "error").toUpperCase()
  const message = serializeArgs(logObj)
    .join(" ")
    .replace(/\r\n|\r|\n/g, "\\n")

  return `${ts} [${level}] ${message}\n`
}

function makeDedupeKey(logObj: LogObject): string {
  const hash = createHash("sha256")
  hash.update(logObj.type)
  for (const arg of serializeArgs(logObj)) {
    hash.update("\0")
    hash.update(String(arg.length))
    hash.update(":")
    hash.update(arg)
  }
  return hash.digest("base64url")
}

/**
 * Construction-time rotation: rename the log aside if it's already over the
 * cap before we start appending. Runs with no descriptor held (the instance
 * fd is opened lazily on the first `log()`), so a plain path stat + rename is
 * correct here. The per-`log()` ceiling check lives in `rotateIfNeeded()`.
 */
function rotateAtStartup(filePath: string): void {
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
  // Approximate bytes written since the last rotation check. We use a
  // conservative trigger threshold (half the max) so a burst of large
  // lines between checks never grows the file by more than ~2x the cap.
  // The stat inside rotateIfNeeded confirms the real size before rotating.
  private bytesSinceCheck = 0
  private static readonly ROTATE_CHECK_BYTES = MAX_LOG_BYTES / 2

  // Persistent append descriptor. Opened lazily on the first write and held
  // open for the reporter's lifetime — a daemon writing thousands of warn /
  // error lines must NOT pay an openSync + closeSync syscall pair per line
  // (that was ~0.4 ms/line on Windows NTFS, i.e. seconds per MB). It is
  // closed only across a rotation (so the rename can succeed — Windows
  // refuses to rename a file with an open handle) and on an explicit
  // close(); the next write reopens the fresh file.
  private fd: number | undefined

  constructor(filePath: string) {
    this.filePath = filePath
    rotateAtStartup(filePath)
  }

  private ensureFd(): number | undefined {
    if (this.fd !== undefined) return this.fd
    try {
      this.fd = fs.openSync(this.filePath, "a", 0o600)
    } catch {
      // Path unwritable (e.g. it's a directory, or perms) — stay closed and
      // drop lines silently. Cannot log a logging failure.
      this.fd = undefined
    }
    return this.fd
  }

  private closeFd(): void {
    if (this.fd === undefined) return
    try {
      fs.closeSync(this.fd)
    } catch {
      // already closed / unwritable — nothing to do
    }
    this.fd = undefined
  }

  /**
   * Enforce the MAX_LOG_BYTES ceiling. Sizes the LIVE file (fstat on the open
   * fd when we hold one — no path race — else a path stat), and on overflow
   * CLOSES the fd before renaming. Closing first is load-bearing on Windows
   * (renaming a file with an open handle fails with EBUSY/EPERM) and correct
   * on POSIX too (a held append-fd would otherwise keep writing into the
   * renamed `.1` inode). The fd is left closed so the next write reopens the
   * freshly-created file.
   */
  private rotateIfNeeded(): void {
    let size: number
    try {
      size =
        this.fd !== undefined
          ? fs.fstatSync(this.fd).size
          : fs.statSync(this.filePath).size
    } catch {
      return // file does not exist / fd invalid
    }
    if (size <= MAX_LOG_BYTES) return

    this.closeFd()
    try {
      fs.renameSync(this.filePath, this.filePath + ".1")
    } catch {
      // best-effort: if rename fails, continue appending to the existing file
    }
  }

  /**
   * Close the held descriptor. Safe to call repeatedly and after a write
   * failure. Optional for correctness (writeSync flushes immediately and the
   * OS closes fds at process exit), but lets a long-lived host release the
   * handle deterministically on shutdown.
   */
  close(): void {
    this.closeFd()
  }

  log(logObj: LogObject, _ctx: { options: ConsolaOptions }): void {
    if (!ALLOWED_TYPES.has(logObj.type)) return

    const key = makeDedupeKey(logObj)
    if (this.seen.has(key)) return

    if (this.seen.size >= DEDUP_MAX) this.seen.clear()
    this.seen.add(key)

    const line = formatLogLine(logObj)

    // Periodic rotation check: after every ROTATE_CHECK_BYTES written since
    // the last check, enforce the MAX_LOG_BYTES ceiling from inside the hot
    // path. The fstat/stat only runs when the threshold is exceeded, so this
    // adds at most one stat per 512 KB of output.
    //
    // Concurrency: log() is synchronous (the writeSync below holds the event
    // loop), so two calls can't interleave and the bytesSinceCheck counter is
    // safe without a mutex.
    this.bytesSinceCheck += line.length
    if (this.bytesSinceCheck >= FileLogReporter.ROTATE_CHECK_BYTES) {
      this.rotateIfNeeded()
      this.bytesSinceCheck = 0
    }

    // Write through the persistent append fd (opened lazily / reopened after
    // a rotation). On any write error, close + drop the fd so a transient
    // failure (ENOSPC, the file removed out from under us) neither wedges
    // logging permanently nor leaks the descriptor — the next call reopens.
    const fd = this.ensureFd()
    if (fd === undefined) return
    try {
      fs.writeSync(fd, line)
    } catch {
      this.closeFd()
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
  fileLoggingActive = true
}

/**
 * True once `enableFileLogging` has run. The file reporter accepts only
 * fatal/error/warn (`ALLOWED_TYPES`), so an `info`-level line — which is what
 * the per-request summary is — reaches no consumer at all in this mode.
 *
 * Exposed so callers can skip work whose ONLY purpose is to populate that
 * line. See `requestLogVisible` in `~/lib/request-log`.
 */
let fileLoggingActive = false

export function isFileLoggingEnabled(): boolean {
  return fileLoggingActive
}
