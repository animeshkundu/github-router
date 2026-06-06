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
