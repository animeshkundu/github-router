/**
 * Windows-safe, injection-safe command execution helpers.
 *
 * Why this module exists: on Windows, npm-installed CLIs (`claude`,
 * `npm`, `codex`) are `.cmd`/`.bat` shims. Node's `execFile`/`spawn`
 * with `shell:false` cannot launch them (CreateProcess only resolves
 * `.exe`), so callers must go through `cmd.exe` (`shell:true`). That in
 * turn opens two hazards this module closes:
 *
 *   1. **Metacharacter injection** (`& | < > ^ ( ) ! %`). A naive
 *      "quote only tokens with spaces" scheme lets `pkg@latest&calc`
 *      run `calc` as a second command. `buildExecInvocation` applies
 *      real cmd.exe quoting (argv-quote + caret-escape) and fails
 *      closed on `%` (which cannot be reliably escaped on the cmd
 *      command line).
 *
 *   2. **CWD shadowing.** `cmd.exe` resolves a bare `npm` from the
 *      current directory before PATH, so an untrusted repo can plant
 *      `npm.cmd`. `resolveExecutable` resolves to an absolute path
 *      against PATH only (honoring PATHEXT), never the cwd, so callers
 *      spawn the real binary by absolute path.
 *
 * All runners are best-effort and timeout-bounded; callers wrap in
 * try/catch and never let an update/probe failure block launch.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

/**
 * Parse a boolean-ish env value. Returns `undefined` when unset or
 * unrecognized so callers can apply their own default. Accepts
 * `1|true|yes|on` (true) and `0|false|no|off|<empty>` (false),
 * case-insensitive. The single shared parser for all new `GH_ROUTER_*`
 * flags so on/off semantics don't drift per call site.
 */
export function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "") {
    return false
  }
  return undefined
}

/** Read the PATH value from an env object, case-insensitively. */
function pathValueOf(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") return env[key] ?? ""
  }
  return ""
}

export interface ResolveExecutableOpts {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Directory to treat as "current dir" and exclude from resolution. */
  cwd?: string
}

/**
 * Resolve an executable name to an absolute path against PATH, honoring
 * `PATHEXT` on Windows and **excluding the current working directory**.
 *
 * Returns `null` when unresolved — callers treat that as "tool absent"
 * and skip (best-effort). Spawning the returned absolute path means
 * `cmd.exe`'s implicit cwd-first lookup never applies, closing the
 * planted-`npm.cmd` vector.
 */
export function resolveExecutable(
  name: string,
  opts: ResolveExecutableOpts = {},
): string | null {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  // Defensive: some test harnesses mock `node:process` without `cwd`.
  // Absent a usable cwd we simply skip the cwd-exclusion guard (the
  // returned absolute path already bypasses cmd.exe's cwd-first lookup).
  const cwdRaw =
    opts.cwd ?? (typeof process.cwd === "function" ? process.cwd() : undefined)
  const resolvedCwd = cwdRaw ? path.resolve(cwdRaw) : null

  const dirs = pathValueOf(env)
    .split(path.delimiter)
    // Drop empty entries and a literal "." — both denote the cwd on
    // Windows, which we explicitly refuse to resolve against.
    .filter((d) => d.length > 0 && d !== ".")

  const isWin = platform === "win32"

  // POSIX: an explicit path component → resolve directly.
  if (!isWin && name.includes("/")) {
    return existsSync(name) ? path.resolve(name) : null
  }
  // Windows: an explicit path component (with a separator) → direct.
  if (isWin && (name.includes("\\") || name.includes("/"))) {
    return existsSync(name) ? path.resolve(name) : null
  }

  const exts =
    isWin && path.extname(name) === ""
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean)
      : [""]

  for (const dir of dirs) {
    // Belt-and-suspenders: never resolve against the cwd even if it is
    // listed explicitly in PATH.
    if (resolvedCwd && path.resolve(dir) === resolvedCwd) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Quote one argument for a `cmd.exe /c "<line>"` command line so the
 * target program receives it verbatim and no `cmd.exe` metacharacter
 * retains shell meaning.
 *
 * Two phases (the canonical Windows approach — Colascione / Rust std):
 *   1. **argv quoting** so `CommandLineToArgvW` in the target parses
 *      the token as one argument (double-quote, backslash-escape).
 *   2. **caret-escaping** every `cmd.exe` metacharacter — including the
 *      quotes from phase 1 — so `cmd.exe` is never in quote-mode, strips
 *      the carets, and hands the argv-quoted string to the program.
 *
 * `%` is special: it cannot be reliably escaped on the `cmd.exe`
 * *command line* (caret does not stop `%VAR%` expansion there). Rather
 * than mis-escape, we **throw** — our callers never pass `%`, so this
 * fails closed on the one unescapable injection vector.
 */
export function quoteWinArg(arg: string): string {
  if (arg.includes("%")) {
    throw new Error(
      "buildExecInvocation: argument contains '%', which cannot be safely " +
        "escaped on the Windows command line; refusing to build the command.",
    )
  }

  // Phase 1 — argv quoting.
  let quoted: string
  if (arg.length > 0 && !/[ \t\n\v"&|<>()^!]/.test(arg)) {
    quoted = arg
  } else {
    let s = '"'
    let backslashes = 0
    for (const ch of arg) {
      if (ch === "\\") {
        backslashes++
      } else if (ch === '"') {
        s += "\\".repeat(backslashes * 2 + 1) + '"'
        backslashes = 0
      } else {
        s += "\\".repeat(backslashes) + ch
        backslashes = 0
      }
    }
    s += "\\".repeat(backslashes * 2) + '"'
    quoted = s
  }

  // Phase 2 — caret-escape all cmd.exe metacharacters (and the carets
  // themselves). cmd strips these; the program sees the phase-1 string.
  return quoted.replace(/[()!^"<>&|]/g, "^$&")
}

export interface ExecInvocation {
  command: string
  args: string[]
  shell: boolean
}

/**
 * Build the platform-correct `spawn` invocation for a command given as
 * an argv array. Pure / unit-testable (no spawn).
 *
 *   - win32 → a single caret/argv-quoted command string + `shell:true`
 *     + empty args array (the empty array avoids the DEP0190 warning
 *     that fires when args and `shell:true` are combined). `cmd[0]`
 *     should already be an absolute path from `resolveExecutable`.
 *   - posix → `(cmd[0], cmd.slice(1))` with `shell:false` — no shell,
 *     no injection surface.
 */
export function buildExecInvocation(
  cmd: string[],
  platform: NodeJS.Platform = process.platform,
): ExecInvocation {
  if (cmd.length === 0) throw new Error("buildExecInvocation: empty command")
  if (platform === "win32") {
    return { command: cmd.map(quoteWinArg).join(" "), args: [], shell: true }
  }
  return { command: cmd[0], args: cmd.slice(1), shell: false }
}

export interface RunOpts {
  cwd?: string
  /** Hard timeout in ms; the process tree is killed on expiry. */
  timeoutMs?: number
  /** Extra env to merge over the parent env for the child. */
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  stdout: string
  stderr: string
  /** Exit code; `null` when killed by signal/timeout. */
  code: number | null
  timedOut: boolean
}

function runInternal(
  cmd: string[],
  stdoutMode: "pipe" | "inherit" | "ignore",
  opts: RunOpts,
): Promise<RunResult> {
  const { command, args, shell } = buildExecInvocation(cmd)
  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell,
        windowsHide: true,
        stdio: [
          "ignore",
          stdoutMode,
          stdoutMode === "inherit" ? "inherit" : "pipe",
        ],
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child.pid)
        }, opts.timeoutMs)
      : undefined
    timer?.unref?.()

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8")
    })
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8")
    })
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    }

    child.on("error", (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => finish(code))
  })
}

/** Kill a process tree best-effort (taskkill /T on Windows). */
function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } else {
      process.kill(pid, "SIGTERM")
    }
  } catch {
    // already gone
  }
}

/** Run a command and capture stdout/stderr. Rejects on spawn error. */
export function runCommandCapture(
  cmd: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return runInternal(cmd, "pipe", opts)
}

/** Run a command discarding output (still captures stderr for errors). */
export function runCommandVoid(
  cmd: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return runInternal(cmd, "pipe", opts)
}

/** Run a command with the child's stdout/stderr inherited to the user. */
export function runCommandInherit(
  cmd: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return runInternal(cmd, "inherit", opts)
}

export interface ManagedExeOpts extends RunOpts {
  /**
   * Hard cap on captured stdout bytes. On overflow the child is
   * tree-killed and the result carries `stdoutTruncated: true`. Defends
   * against a full-`CodeUnit` colgrep `--json` payload (source + 5
   * analysis layers per hit) bloating memory.
   */
  maxStdoutBytes?: number
  /**
   * When true, exceeding `maxStdoutBytes` does NOT tree-kill the child — it
   * sets `stdoutTruncated` and stops BUFFERING further stdout while still
   * draining the pipe (no backpressure). Use for a child whose kill is unsafe
   * (e.g. colgrep, which writes a non-atomic index — a byte-cap kill during
   * its result output could interrupt a write). The child runs to completion
   * (bounded by `timeoutMs` / `inactivityTimeoutMs`). Default false (kill).
   */
  truncateInsteadOfKill?: boolean
  /**
   * Called synchronously with the spawned child right after spawn
   * succeeds, BEFORE any output arrives. The colbert lifecycle ledger
   * uses this to register the child so a session-exit sweep can
   * tree-kill an orphan. Never throws into the runner.
   */
  onSpawn?: (child: ReturnType<typeof spawn>) => void
  /**
   * Inactivity (stall) watchdog. When set, a timer is armed for
   * `inactivityTimeoutMs` and RESET on every stdout/stderr data chunk. On
   * expiry (no output for the window) it consults `onInactivityCheck`: a
   * `true` return means "still making progress via an out-of-band signal"
   * (e.g. the colgrep index dir is still growing on disk even though the
   * process is silent on a non-TTY pipe) and the watchdog re-arms; a
   * `false`/absent return tree-kills the child and sets `stalled: true`.
   * This is the progress-based "stuck" detector that lets a long-but-
   * progressing build run to completion while still killing a hung one —
   * independent of the coarse total `timeoutMs` backstop.
   */
  inactivityTimeoutMs?: number
  /** External progress probe consulted when the inactivity timer fires.
   * Return `true` to re-arm (still progressing), `false`/throw to kill.
   * MUST be cheap + synchronous (called on a timer, not awaited). */
  onInactivityCheck?: () => boolean
}

export interface ManagedExeResult extends RunResult {
  /** True iff stdout was truncated at `maxStdoutBytes` (child was killed). */
  stdoutTruncated: boolean
  /** True iff the inactivity watchdog killed the child (no progress). */
  stalled: boolean
}

/**
 * Run a **native executable** (a real `.exe`/Mach-O/ELF, NOT a `.cmd`
 * shim) capturing stdout/stderr, with `shell:false` on EVERY platform.
 *
 * Why a separate runner from `runCommandCapture`: that path routes
 * through `buildExecInvocation`, which on Windows builds a
 * `cmd.exe`-quoted command string and **throws on `%`** (`quoteWinArg`).
 * A workspace path can legally contain `%` (and `&`, `(`, `)`, `!`, …),
 * so the managed colgrep binary — which IS a native `.exe`, not a shim —
 * must bypass cmd.exe entirely. `spawn(absExe, args, {shell:false})`
 * resolves the `.exe` via CreateProcess directly: no cmd.exe, no
 * metacharacter hazard, no `%` refusal. POSIX was already `shell:false`.
 * This is what makes "ANY absolute workspace" hold on Windows.
 *
 * Lifecycle:
 *   - `timeoutMs` → tree-kill on expiry (`taskkill /T /F` on Windows,
 *     POSIX process-group `kill(-pgid)` so colgrep's rayon worker
 *     children die too). `timedOut: true` in the result.
 *   - `maxStdoutBytes` → tree-kill + `stdoutTruncated: true` once the
 *     captured stdout exceeds the cap.
 *   - `onSpawn(child)` → register the child with the caller's ledger.
 *
 * `command` MUST be an absolute path to the executable (the caller
 * resolves it; we never search PATH here — there is nothing to inject).
 */
export function runManagedExeCapture(
  command: string,
  args: ReadonlyArray<string>,
  opts: ManagedExeOpts = {},
): Promise<ManagedExeResult> {
  const isWin = process.platform === "win32"
  return new Promise<ManagedExeResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        // POSIX: new process group so we can kill the whole tree
        // (colgrep + rayon workers) with kill(-pgid). Windows uses
        // taskkill /T instead; `detached` there has no group semantics.
        detached: !isWin,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    try {
      opts.onSpawn?.(child)
    } catch {
      // ledger registration must never break the spawn
    }

    const chunks: Array<Buffer> = []
    let stdoutBytes = 0
    const stderrChunks: Array<Buffer> = []
    let stderrBytes = 0
    const STDERR_CAP = 64 * 1024
    let timedOut = false
    let stdoutTruncated = false
    let stalled = false
    let settled = false

    // Exactly one terminator wins: the first to fire records its reason and
    // tree-kills; later ones no-op. Keeps timedOut / stalled / stdoutTruncated
    // mutually exclusive and avoids a double tree-kill.
    let terminated = false
    const terminate = (reason: "timeout" | "stall" | "truncate"): void => {
      if (terminated) return
      terminated = true
      if (reason === "timeout") timedOut = true
      else if (reason === "stall") stalled = true
      else stdoutTruncated = true
      if (timer) clearTimeout(timer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      killManagedTree(child, isWin)
    }

    const timer = opts.timeoutMs
      ? setTimeout(() => terminate("timeout"), opts.timeoutMs)
      : undefined
    timer?.unref?.()

    // Inactivity (stall) watchdog. Re-arms itself: when the window elapses
    // with no output, consult the external progress probe — re-arm if it
    // says "still progressing" (e.g. the index dir grew), else kill + mark
    // stalled. Reset on every data chunk (a chatty process never stalls).
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined
    const armInactivity = (): void => {
      if (opts.inactivityTimeoutMs === undefined || settled || terminated) return
      inactivityTimer = setTimeout(() => {
        if (settled) return
        // No probe → pure output-inactivity kill. A probe that THROWS is
        // inconclusive → don't kill (re-arm); the absolute timeoutMs backstop
        // still catches a genuinely wedged process.
        let progressing = false
        if (opts.onInactivityCheck) {
          try {
            progressing = opts.onInactivityCheck() === true
          } catch {
            progressing = true
          }
        }
        if (progressing) {
          armInactivity()
          return
        }
        terminate("stall")
      }, opts.inactivityTimeoutMs)
      inactivityTimer?.unref?.()
    }
    const resetInactivity = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      armInactivity()
    }
    armInactivity()

    child.stdout?.on("data", (c: Buffer) => {
      resetInactivity()
      if (stdoutTruncated) return
      stdoutBytes += c.length
      if (
        opts.maxStdoutBytes !== undefined &&
        stdoutBytes > opts.maxStdoutBytes
      ) {
        stdoutTruncated = true
        // Default: tree-kill on overflow. Opt-in: keep the child alive and
        // just stop buffering (the data handler keeps firing + discarding via
        // the `if (stdoutTruncated) return` guard above, so the pipe drains
        // and the child never blocks on a full buffer).
        if (!opts.truncateInsteadOfKill) terminate("truncate")
        return
      }
      chunks.push(c)
    })
    child.stderr?.on("data", (c: Buffer) => {
      resetInactivity()
      // Hard byte cap on stderr — append only the slice that fits so a
      // single huge chunk can't overshoot. Never logged raw (it can
      // embed source code from colgrep).
      if (stderrBytes >= STDERR_CAP) return
      const remaining = STDERR_CAP - stderrBytes
      const slice = c.length > remaining ? c.subarray(0, remaining) : c
      stderrChunks.push(slice)
      stderrBytes += slice.length
    })
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
        timedOut,
        stdoutTruncated,
        stalled,
      })
    }

    child.on("error", (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      reject(err)
    })
    child.on("close", (code) => finish(code))
  })
}

/**
 * Tree-kill a managed child. Windows: `taskkill /T /F /PID` (whole
 * tree). POSIX: kill the process GROUP (`-pgid`) so colgrep's rayon
 * worker children die with the parent.
 *
 * `runManagedExeCapture` always spawns POSIX children `detached:true`
 * (their own process group), so the group kill is the correct and
 * sufficient primitive. We deliberately do NOT fall back to a positive-
 * pid `process.kill(pid)` when the group kill fails: by the time a kill
 * fires (timeout / byte-cap race), the child may have already exited and
 * its PID been recycled by an unrelated process — a positive-pid kill
 * would then target the wrong process. `ESRCH` (group already gone) is
 * the success case for our purposes; any other error is swallowed.
 */
export function killManagedTree(
  child: ReturnType<typeof spawn>,
  isWin: boolean = process.platform === "win32",
): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (isWin) {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } else {
      // Negative pid → the process group (we spawned detached). No
      // positive-pid fallback (PID-reuse hazard — see doc comment).
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    // ESRCH (already gone) / EPERM — best-effort, nothing more to do.
  }
}
