/**
 * The persistent PowerShell helper that holds a Win32
 * `SetThreadExecutionState` assertion for the proxy's lifetime.
 *
 * `SetThreadExecutionState` is THREAD-scoped: a one-shot process that
 * sets it and exits releases the assertion immediately. So a long-lived
 * helper holds it on its own main thread and blocks on stdin; when the
 * proxy dies (clean exit, signal, SIGKILL/taskkill, OOM) the stdin pipe
 * closes, the helper hits EOF, clears the assertion, and exits — and
 * Windows releases the thread's assertion on process death regardless.
 * The helper therefore cannot outlive the proxy, so no orphan sweep is
 * needed (unlike colbert/worktrees, which leave on-disk artifacts).
 *
 * Best-effort: every failure path (no powershell, Constrained Language
 * Mode blocking `Add-Type`, spawn error) degrades to a clean no-op. We
 * NEVER attempt to install, enable, or bypass language-mode/WDAC policy.
 */

import { spawn } from "node:child_process"

import { killManagedTree, resolveExecutable } from "../exec"

export interface HelperHandle {
  child: ReturnType<typeof spawn>
}

export interface SpawnHelperResult {
  /** null when powershell.exe couldn't be resolved or spawn threw. */
  handle: HelperHandle | null
  /**
   * Resolves `true` once the helper prints its `OK` readiness line
   * (the assertion took), or `false` on early child exit / timeout /
   * no-powershell (Constrained Language Mode blocks `Add-Type`, etc.).
   */
  ready: Promise<boolean>
}

// Win32 EXECUTION_STATE flags (winbase.h).
const ES_CONTINUOUS = 0x80000000
const ES_SYSTEM_REQUIRED = 0x00000001
const ES_DISPLAY_REQUIRED = 0x00000002

/** Default time to wait for the helper's `OK` readiness line. */
const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * The execution-state flags to assert. Always `ES_CONTINUOUS |
 * ES_SYSTEM_REQUIRED` (machine stays awake); adds `ES_DISPLAY_REQUIRED`
 * (screen stays on) when `displayRequired`. `>>> 0` forces an unsigned
 * 32-bit value so the hex literal handed to PowerShell is positive.
 */
export function executionStateFlags(displayRequired: boolean): number {
  let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  if (displayRequired) flags |= ES_DISPLAY_REQUIRED
  return flags >>> 0
}

/** Format a uint32 as a PowerShell `[uint32]<decimal>` literal.
 *
 * Decimal, NOT hex: in Windows PowerShell a hex literal like `0x80000001`
 * parses as a *negative* Int32 (`-2147483647`) and fails to convert to
 * the `uint` parameter ("Value was either too large or too small for a
 * UInt32"). A decimal literal over Int32.MaxValue auto-promotes to a
 * positive Int64, and the explicit `[uint32]` cast then fits. Verified
 * against a real win32 host before shipping. */
function psUint32(n: number): string {
  return `[uint32]${n >>> 0}`
}

/**
 * Build the PowerShell script the persistent helper runs. PURE — the
 * flag value is our own constant templated as a numeric literal, so
 * there is no injection surface. The script:
 *   1. P/Invokes `SetThreadExecutionState` with the requested flags.
 *   2. Prints `OK` once the assertion succeeds (the readiness signal;
 *      no `OK` => `Add-Type` was CLM-blocked or the call returned 0).
 *   3. Blocks reading stdin so it self-exits on parent death (pipe EOF).
 *   4. Clears the assertion (`ES_CONTINUOUS` only) on the way out.
 *
 * The C# member-definition is a PowerShell SINGLE-quoted string so its
 * embedded `"kernel32.dll"` double-quotes need no escaping.
 */
export function buildKeepAwakeScript(displayRequired: boolean): string {
  const assert = psUint32(executionStateFlags(displayRequired))
  const clear = psUint32(ES_CONTINUOUS)
  return [
    `Add-Type -Name P -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'`,
    `if ([W.P]::SetThreadExecutionState(${assert}) -ne 0) { [Console]::Out.WriteLine('OK'); [Console]::Out.Flush() }`,
    `while ($null -ne [Console]::In.ReadLine()) {}`,
    `[void][W.P]::SetThreadExecutionState(${clear})`,
  ].join("\n")
}

/** The argv passed to powershell.exe (excluding the executable itself). */
export function buildHelperArgs(displayRequired: boolean): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildKeepAwakeScript(displayRequired),
  ]
}

/**
 * Spawn the persistent helper. Returns a null handle (and `ready` →
 * `false`) when powershell.exe can't be resolved or spawn throws — both
 * clean no-op degradations. The helper's stdout is piped only to detect
 * the `OK` readiness line; stderr is ignored.
 */
export function spawnHelper(opts: {
  displayRequired: boolean
  readyTimeoutMs?: number
}): SpawnHelperResult {
  const ps = resolveExecutable("powershell.exe")
  if (!ps) return { handle: null, ready: Promise.resolve(false) }

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(ps, buildHelperArgs(opts.displayRequired), {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    })
  } catch {
    return { handle: null, ready: Promise.resolve(false) }
  }
  // A spawn 'error' (e.g. ENOENT slipping past resolveExecutable) must
  // never surface as an unhandled error event.
  child.on("error", () => {})

  const handle: HelperHandle = { child }
  const ready = new Promise<boolean>((resolve) => {
    let settled = false
    let buf = ""
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(
      () => done(false),
      opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    )
    timer.unref?.()

    child.stdout?.on("data", (c: Buffer) => {
      // Inert + bounded after settle: the helper only ever prints the
      // single `OK` line, so cap the readiness buffer defensively and stop
      // appending once resolved (the listener stays attached for the
      // child's life but does nothing further).
      if (settled || buf.length > 256) return
      buf += c.toString("utf8")
      if (buf.includes("OK")) done(true)
    })
    child.stdout?.on("error", () => {})
    // Early exit before OK => the assertion never took (CLM/failure).
    child.once("exit", () => done(false))
    child.once("error", () => done(false))
  })
  return { handle, ready }
}

/**
 * Release the assertion: close the helper's stdin (→ pipe EOF → the
 * helper clears `ES_*` and exits) then `taskkill /T /F` as a
 * belt-and-suspenders reap. Windows also releases the assertion on the
 * helper's process death regardless. Best-effort; never throws.
 */
export function killHelper(handle: HelperHandle): void {
  const { child } = handle
  try {
    child.stdin?.end()
  } catch {
    // stdin already closed
  }
  try {
    killManagedTree(child)
  } catch {
    // already gone
  }
}
