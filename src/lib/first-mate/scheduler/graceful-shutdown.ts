/**
 * Cross-platform graceful-shutdown wiring for the first-mate daemon PROCESS.
 *
 * The daemon must release its fencing lease + singleton pidfile IMMEDIATELY and
 * cleanly on teardown (not by expiry / takeover). On POSIX the trigger is an
 * external SIGINT/SIGTERM. On Windows — the primary deployment target — an
 * external SIGTERM is a hard `TerminateProcess` that NEVER runs a
 * `process.on('SIGTERM')` handler, so signals cannot carry a graceful stop
 * there. The portable trigger is stdin EOF: when the parent closes the write end
 * of the child's stdin pipe, libuv fires `'end'`/`'close'` identically on Windows
 * named pipes and POSIX pipes. We therefore wire BOTH signals (POSIX still uses
 * them) AND stdin EOF (the cross-platform path), all behind a single once-guard
 * so `onShutdown` runs at most once regardless of which trigger fires.
 *
 * This is the SINGLE source of truth for the daemon's teardown wiring, imported
 * by both `scripts/first-mate-daemon.ts` (production) and the E2E harness — so
 * the test exercises the real production wiring, not a divergent copy.
 */

/** Minimal shape of the signal/exit emitter (satisfied by `process`). */
interface SignalEmitter {
  on: (event: string, listener: () => void) => unknown
}

/** Minimal shape of the stdin stream (satisfied by `process.stdin`). */
interface StdinStream {
  on: (event: string, listener: () => void) => unknown
  resume: () => void
}

export interface GracefulShutdownOptions {
  /** Invoked at most once when any teardown trigger fires. */
  onShutdown: () => void
  /** Signal/exit emitter (defaults to `process`). Injectable for tests. */
  proc?: SignalEmitter
  /** stdin stream (defaults to `process.stdin`). Injectable for tests. */
  stdin?: StdinStream
}

export interface GracefulShutdownHandle {
  /** True once a trigger has fired and `onShutdown` was invoked. */
  triggered: () => boolean
}

/**
 * Wire SIGINT/SIGTERM + stdin `end`/`close` to a single, at-most-once
 * `onShutdown`, and `resume()` stdin so the EOF flow actually starts. Returns a
 * handle exposing whether shutdown has been triggered (for tests / diagnostics).
 */
export function installGracefulShutdown(
  opts: GracefulShutdownOptions,
): GracefulShutdownHandle {
  const proc = opts.proc ?? process
  const stdin = opts.stdin ?? process.stdin

  let shuttingDown = false
  const trigger = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    opts.onShutdown()
  }

  // POSIX teardown (Windows never runs these for an external kill).
  proc.on("SIGINT", trigger)
  proc.on("SIGTERM", trigger)
  // Cross-platform teardown: parent closing the stdin write end → EOF here.
  stdin.on("end", trigger)
  stdin.on("close", trigger)
  // Start the stdin flow so `'end'` can fire (a paused stdin never emits it).
  try {
    stdin.resume()
  } catch {
    /* best-effort: an absent/closed stdin must not defeat signal wiring */
  }

  return { triggered: () => shuttingDown }
}
