/**
 * Windows keep-awake — public entry points.
 *
 * `startKeepAwake()` is the fire-and-forget call the `start` / `claude` /
 * `codex` launchers invoke after `setupAndServe` (alongside
 * `provisionAndIndexColbert()` / `runSelfUpdate()`). On Windows, by
 * default, it spawns a persistent PowerShell helper that holds a
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
 * assertion so the machine doesn't idle-sleep mid-session, and registers
 * SIGINT/SIGTERM/exit handlers to release it.
 *
 * Best-effort and model-agnostic: non-win32 is a total no-op; any
 * failure (no powershell, Constrained Language Mode blocking `Add-Type`)
 * degrades to a clean debug-logged no-op. We NEVER install, enable, or
 * bypass language-mode/WDAC policy, and never block or crash launch.
 *
 * Crash safety: the helper blocks on stdin, so if the proxy is hard-
 * killed the pipe closes, the helper hits EOF and exits, and Windows
 * releases the assertion on process death — no orphan is possible, so no
 * boot-time sweep is needed.
 */

import process from "node:process"

import consola from "consola"

import { keepAwakeOptedIn, keepDisplayOn } from "./flags"
import { type HelperHandle, killHelper, spawnHelper } from "./helper"

export { keepAwakeOptedIn, keepDisplayOn } from "./flags"

/**
 * True iff keep-awake should run THIS launch: win32 AND not opted out.
 * Non-win32 short-circuits before anything else (no spawn, no flags read
 * beyond the opt-out, no handler registration). `platform` is injectable
 * for tests; production callers use the default `process.platform`.
 */
export function keepAwakeEnabled(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && keepAwakeOptedIn()
}

let _handle: HelperHandle | null = null
let _started = false

/** Synchronously release the assertion + drop the handle. Idempotent.
 * Also clears the `_started` latch so a transient failure never
 * permanently disables a later start. */
function releaseSync(): void {
  const h = _handle
  _handle = null
  _started = false
  if (h) {
    try {
      killHelper(h)
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------
// Signal handlers (mirror colbert/worker-agent re-raise pattern)
// ---------------------------------------------------------------------

let _registered = false
let _exitHandler: (() => void) | null = null
let _sigintHandler: (() => void) | null = null
let _sigtermHandler: (() => void) | null = null

/**
 * Wire SIGINT/SIGTERM/exit handlers that release the assertion.
 * Idempotent. The signal handlers re-raise after releasing (remove self
 * + `process.kill(self)`) so Node's default terminate-on-signal is
 * restored — otherwise merely attaching a listener cancels the default
 * and Ctrl-C would clean but not exit. This is load-bearing for the
 * `start` subcommand, which has no `launchChild`/`onShutdown` of its own.
 */
function registerExitHandlers(): void {
  if (_registered) return
  _registered = true
  // On `exit` the event loop is dead, so killHelper's async `taskkill`
  // can't run — but that's fine: when the proxy process dies the OS closes
  // the helper's stdin pipe, the helper hits EOF and exits, and Windows
  // releases the assertion on its death. The signal handlers (event loop
  // still alive) DO run the taskkill belt-and-suspenders. Matches the
  // colbert lifecycle's established pattern.
  _exitHandler = () => releaseSync()
  _sigintHandler = () => {
    releaseSync()
    if (_sigintHandler) process.off("SIGINT", _sigintHandler)
    process.kill(process.pid, "SIGINT")
  }
  _sigtermHandler = () => {
    releaseSync()
    if (_sigtermHandler) process.off("SIGTERM", _sigtermHandler)
    process.kill(process.pid, "SIGTERM")
  }
  process.on("SIGINT", _sigintHandler)
  process.on("SIGTERM", _sigtermHandler)
  process.on("exit", _exitHandler)
}

/**
 * Start keeping the machine awake. Synchronous, fire-and-forget,
 * idempotent within a run. No-op off win32 or when opted out. Never
 * throws.
 */
export function startKeepAwake(): void {
  if (!keepAwakeEnabled()) return
  if (_started) return
  _started = true
  try {
    const { handle, ready } = spawnHelper({ displayRequired: keepDisplayOn() })
    if (!handle) {
      _started = false // nothing spawned — allow a later retry
      consola.debug("keep-awake: inactive (powershell.exe not resolvable)")
      return
    }
    _handle = handle
    // Keep `_handle` honest if the helper dies on its own (e.g. CLM made
    // Add-Type throw): drop the reference so a later stop/check is accurate.
    handle.child.once("exit", () => {
      if (_handle === handle) _handle = null
    })
    registerExitHandlers()
    void ready.then((ok) => {
      consola.debug(
        ok
          ? "keep-awake: holding SetThreadExecutionState assertion (system sleep prevented)"
          : "keep-awake: inactive (helper did not confirm — Constrained Language Mode or PowerShell unavailable)",
      )
    })
  } catch (err) {
    _started = false
    _handle = null
    consola.debug("keep-awake: failed to start (continuing):", err)
  }
}

/**
 * Release the assertion / reap the helper. Idempotent; safe to `await`
 * from a subcommand's `onShutdown` chain. Never throws.
 */
export async function stopKeepAwake(): Promise<void> {
  releaseSync()
}

/** Test-only: the current helper child PID, or undefined if no helper is
 * active. Lets tests assert "started once" (same pid) and "stop released"
 * (undefined) instead of only "did not throw". */
export function __keepAwakeChildPidForTests(): number | undefined {
  return _handle?.child.pid
}

/** Test-only: reset module state + unregister handlers. */
export function __resetKeepAwakeForTests(): void {
  releaseSync()
  _started = false
  if (_sigintHandler) {
    process.off("SIGINT", _sigintHandler)
    _sigintHandler = null
  }
  if (_sigtermHandler) {
    process.off("SIGTERM", _sigtermHandler)
    _sigtermHandler = null
  }
  if (_exitHandler) {
    process.off("exit", _exitHandler)
    _exitHandler = null
  }
  _registered = false
}
