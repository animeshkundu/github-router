/**
 * Bounded `bash` execution for the worker tool.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Bash hardening"
 * section). This is the load-bearing defense between the worker LLM
 * and the user's shell — every value here was chosen for an explicit
 * reason; re-read the plan before changing one.
 *
 * Highlights of the threat model that constrain the implementation:
 *
 *   - **Strict env allowlist** (NOT `STRIPPED_PARENT_ENV_KEYS`-as-denylist).
 *     Start from `{}` and copy only the named keys. Denylists drift the
 *     moment a new credential env var ships; allowlists fail closed.
 *     `env`/`printenv` inside the spawned shell must NOT see
 *     `GITHUB_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
 *     `COPILOT_TOKEN`, or any `GH_ROUTER_*` variable.
 *
 *   - **POSIX `bash -c <cmd>` NOT `-lc`.** `-l` sources the user's
 *     login profile (`~/.bash_profile`, `~/.bashrc`), which may
 *     re-export the credentials we just stripped, or `cd` into an
 *     unexpected directory, or set `PROMPT_COMMAND`. The plan calls
 *     this out as a peer-review fix; do not "fix" it back.
 *
 *   - **Windows `cmd.exe /d /s /c <cmd>`.** `/d` skips `AutoRun`,
 *     `/s` modifies quote handling for `/c`, `/c` runs and exits.
 *     `COMSPEC` is honored when set (some sites alias it to a
 *     restricted shell).
 *
 *   - **Process-group cleanup.** A bash one-liner like `sleep 30 | cat`
 *     spawns grandchildren. Killing just `child.pid` orphans `sleep`.
 *     POSIX: spawn with `detached: true` (own process group) then
 *     `kill(-pid, SIG…)`. Windows: `taskkill /T /F /PID` (the `/T`
 *     traverses the tree).
 *
 *   - **1 MiB per-stream output cap.** A `cat large.bin` would blow up
 *     the agent's context. On overrun we append a one-line truncation
 *     marker and kill the process — the marker doesn't count against
 *     the cap.
 *
 *   - `opts.disableNetwork` is a hint for the caller's `beforeToolCall`
 *     filter (see plan: `GH_ROUTER_WORKER_DISABLE_NETWORK`). `runBash`
 *     accepts it for symmetry but does NOT enforce it — enforcement is
 *     a caller-side regex on the raw `cmd` string, before we even spawn.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import process from "node:process"

import { PATHS } from "../paths"
import { toolbeltEnabled } from "../toolbelt"
import { toolbeltPathOverride } from "../toolbelt/path-inject"

/**
 * Env keys preserved from the parent process. Add a new key only if
 * (a) it is genuinely required for typical shell invocations to work
 * AND (b) it cannot carry the user's credentials. The current set was
 * chosen to make `git`, `bun`, `node`, `gh`, common UNIX utilities,
 * and PowerShell/cmd built-ins functional.
 */
const ENV_ALLOWLIST = [
  // POSIX + Windows: search path for executables.
  "PATH",
  // POSIX: home directory (some tools refuse to run without it).
  "HOME",
  // Windows: equivalent of HOME — `git`, `bun`, `npm` all check it.
  "USERPROFILE",
  // Locale — without LANG, tools may downgrade to ASCII or refuse
  // UTF-8 output and trip on filenames with non-ASCII characters.
  "LANG",
  "LC_ALL",
  // Timezone — date/time-aware tools (`date`, build timestamps) want it.
  "TZ",
  // POSIX temp directory hint.
  "TMPDIR",
  // Windows temp directory hints (both spellings exist).
  "TEMP",
  "TMP",
  // Windows: required by COM/registry-touching tools (e.g., PowerShell).
  "SystemRoot",
  // Windows: which shell to launch (we honor COMSPEC for the `cmd.exe`
  // lookup; carrying the value through to the child is also harmless).
  "ComSpec",
  // Windows: which extensions count as executable (`.exe`, `.bat`, …).
  "PATHEXT",
  // Windows: current user's login name. `git config user.name` defaults
  // to this; `whoami`, `npm`, and many other tools also read it.
  "USERNAME",
  // Windows: per-user roaming app data. `git` stores its global config
  // and credential helpers here; `npm`, `gh`, etc. follow suit.
  "APPDATA",
  // Windows: per-user local app data. `gh`, `bun`, and other CLIs
  // store caches/state here.
  "LOCALAPPDATA",
  // Windows: path to the Windows install directory. Some tools need
  // this in addition to `SystemRoot` (they are usually the same).
  "windir",
  // Windows: which drive letter Windows is installed on (`C:`). Some
  // installers and PowerShell scripts construct paths from this.
  "SystemDrive",
  // Windows: standard install prefixes. Build tools (MSBuild, cmake,
  // node-gyp) look for SDKs and toolchains under these roots.
  "ProgramFiles",
  "ProgramFiles(x86)",
  // Windows: system-wide app data (analog of `/etc`). `chocolatey`
  // and per-machine `git` configs live here.
  "ProgramData",
] as const

/** Per-stream byte cap. Past this we truncate + kill the child. */
const OUTPUT_CAP_BYTES = 1024 * 1024

/**
 * Grace period between SIGTERM and SIGKILL on POSIX. 2 seconds gives
 * a well-behaved shell time to flush stdout / unwind a trap; longer
 * holds the worker open under abuse, shorter risks losing buffered
 * output in the common case.
 */
const POSIX_KILL_GRACE_MS = 2000

export interface RunBashOpts {
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  /**
   * Caller's intent flag — `true` means the caller's `beforeToolCall`
   * filter is rejecting network-egress commands at the regex level
   * BEFORE invoking `runBash`. We accept the param for symmetry with
   * the tool surface; we do NOT re-check the command here because
   * doing so would split the source of truth.
   */
  disableNetwork: boolean
}

export interface RunBashResult {
  stdout: string
  stderr: string
  exitCode: number
  /** `true` if `opts.timeoutMs` elapsed before the child exited. */
  timedOut: boolean
  /** `true` if `opts.signal` aborted before the child exited. */
  killed: boolean
}

export function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  // Prepend the toolbelt bin dir so the worker shell can call
  // rg/fd/jq/sd/sg/yq too. Reuse the casing-safe helper; never mutate
  // the global process.env (that would broaden shadowing to every
  // router subprocess). Credential keys remain dropped by the allowlist.
  if (toolbeltEnabled()) {
    Object.assign(env, toolbeltPathOverride(env, PATHS.TOOLBELT_BIN_DIR))
  }
  return env
}

/**
 * Kill the child and all its descendants. POSIX uses the process
 * group (negative PID); Windows uses `taskkill /T /F`. Both are
 * wrapped in try/catch — by the time we issue the kill the process
 * may already have exited, and we'd rather see a clean
 * `RunBashResult` than an unhandled rejection.
 *
 * On Windows we explicitly swallow `EBUSY` (see plan / code-search.ts
 * `killChild` comment) — `taskkill` occasionally races with the
 * child's own teardown and reports the file is locked.
 */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EBUSY") {
        // Swallow all errors — the child might already be gone, and
        // there's no recovery path. EBUSY is the documented common
        // race we explicitly choose to ignore.
      }
    }
    return
  }

  // POSIX: signal the whole process group.
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    // Group might already be gone.
  }
  const t = setTimeout(() => {
    // Only escalate if the child hasn't exited.
    if (child.exitCode !== null || child.signalCode !== null) return
    if (!child.pid) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // Already dead.
    }
  }, POSIX_KILL_GRACE_MS)
  // Don't hold the event loop open just for the escalation timer.
  t.unref?.()
}

/**
 * Run a shell command under strict isolation.
 *
 * Contract:
 *   - `cwd` is forced; the spawned shell cannot `cd` outside without
 *     using shell builtins (which would only affect the child's own
 *     working dir, not the worker's).
 *   - Env is a strict allowlist (see `ENV_ALLOWLIST` and module doc).
 *   - Timeout fires at `opts.timeoutMs`; on expiry we kill the
 *     process tree and resolve with `timedOut: true`.
 *   - `opts.signal.aborted` immediately kills the process tree and
 *     resolves with `killed: true`.
 *   - Each of stdout/stderr is capped at 1 MiB; overrun appends
 *     `[bash: stdout|stderr truncated at 1MB]` and kills the child.
 *   - `stdin` is `"ignore"` — the worker has no interactive shell.
 *
 * Never rejects: every failure path resolves with a fully-populated
 * `RunBashResult`. Callers shouldn't need a `.catch()`.
 */
export function runBash(
  cmd: string,
  opts: RunBashOpts,
): Promise<RunBashResult> {
  return new Promise((resolve) => {
    // Accept the hint without acting on it — caller's responsibility.
    void opts.disableNetwork

    const isWin = process.platform === "win32"
    const file = isWin
      ? (process.env.COMSPEC ?? "cmd.exe")
      : "/bin/bash"
    // POSIX: `-c` (NOT `-lc`). Windows: `/d /s /c` (skip AutoRun;
    // preserve quotes; run-and-exit).
    const args = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd]

    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: buildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX-only: detached → child gets its own process group.
        // We rely on this for `kill(-pid, …)` to reach grandchildren.
        ...(isWin ? { windowsHide: true } : { detached: true }),
      })
    } catch (err) {
      resolve({
        stdout: "",
        stderr:
          err instanceof Error ? err.message : `spawn failed: ${String(err)}`,
        exitCode: -1,
        timedOut: false,
        killed: false,
      })
      return
    }

    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let killed = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, opts.timeoutMs)
    // Don't keep the event loop alive past the test/scope that owns
    // this call — the child's open pipes already do that work.
    timer.unref?.()

    const onAbort = (): void => {
      killed = true
      killProcessTree(child)
    }

    // Distinguish synchronous "already aborted" from late aborts:
    //   - synchronous: just kill, no listener (will never fire).
    //   - late: register a once-listener that auto-removes after first call.
    let abortListenerActive = false
    if (opts.signal.aborted) {
      onAbort()
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true })
      abortListenerActive = true
    }

    function appendStdout(chunk: Buffer): void {
      if (stdoutTruncated) return
      const room = OUTPUT_CAP_BYTES - stdoutBytes
      if (chunk.length <= room) {
        stdout += chunk.toString("utf8")
        stdoutBytes += chunk.length
        return
      }
      if (room > 0) {
        stdout += chunk.subarray(0, room).toString("utf8")
        stdoutBytes += room
      }
      stdout += "\n[bash: stdout truncated at 1MB]\n"
      stdoutTruncated = true
      killProcessTree(child)
    }

    function appendStderr(chunk: Buffer): void {
      if (stderrTruncated) return
      const room = OUTPUT_CAP_BYTES - stderrBytes
      if (chunk.length <= room) {
        stderr += chunk.toString("utf8")
        stderrBytes += chunk.length
        return
      }
      if (room > 0) {
        stderr += chunk.subarray(0, room).toString("utf8")
        stderrBytes += room
      }
      stderr += "\n[bash: stderr truncated at 1MB]\n"
      stderrTruncated = true
      killProcessTree(child)
    }

    child.stdout?.on("data", appendStdout)
    child.stderr?.on("data", appendStderr)
    // Suppress unhandled 'error' rejections on the streams themselves
    // — when we kill the child mid-stream, the streams may emit
    // EPIPE which would otherwise crash the process.
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})

    function settle(exitCode: number): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortListenerActive) {
        opts.signal.removeEventListener("abort", onAbort)
      }
      resolve({ stdout, stderr, exitCode, timedOut, killed })
    }

    child.on("exit", (code, signal) => {
      // signal-killed children report exitCode=null; map to 128+sig
      // semantics so the caller sees a non-zero value rather than
      // accidentally treating the result as success.
      const exitCode = code ?? (signal ? 128 : 1)
      settle(exitCode)
    })

    child.on("error", (err) => {
      // 'error' on the child itself (spawn failure post-callback,
      // typically EACCES on `/bin/bash`). Surface it through stderr.
      if (!stderrTruncated) {
        const msg = err instanceof Error ? err.message : String(err)
        appendStderr(Buffer.from(msg))
      }
      settle(-1)
    })
  })
}
