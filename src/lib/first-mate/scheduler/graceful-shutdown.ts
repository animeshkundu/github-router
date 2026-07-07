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
 * EOF-gating (finding #6): the EOF triggers are only wired when stdin is an
 * actual pipe/socket. A direct / process-manager launch with stdin from
 * `/dev/null` (a character device) or a file redirect emits `'end'` IMMEDIATELY,
 * which would fire an instant false shutdown the moment the daemon starts. We
 * skip the EOF wiring ONLY when we can POSITIVELY prove stdin is a non-pipe fd
 * (fail-safe: when detection is uncertain we still wire it, preserving the
 * always-graceful behavior on the real pipe autospawn uses). SIGINT/SIGTERM are
 * wired unconditionally either way. The autospawn parent always launches the
 * daemon with stdin `"pipe"`, so the normal path is unaffected.
 *
 * This is the SINGLE source of truth for the daemon's teardown wiring, imported
 * by both `scripts/first-mate-daemon.ts` (production) and the E2E harness — so
 * the test exercises the real production wiring, not a divergent copy.
 */

import { fstatSync } from "node:fs"

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
  /**
   * Whether stdin is a pipe/socket (an EOF-carrying stream). When set it is
   * authoritative; when unset it is auto-detected (see {@link stdinLooksLikePipe})
   * for the real `process.stdin`, and defaults to `true` for an injected stdin
   * (tests/embedded callers keep the full EOF wiring).
   */
  stdinIsPipe?: boolean
}

export interface GracefulShutdownHandle {
  /** True once a trigger has fired and `onShutdown` was invoked. */
  triggered: () => boolean
}

/**
 * Positively detect whether the real fd 0 is a pipe/socket. Returns `true`
 * (wire EOF) unless it can PROVE stdin is a non-pipe (regular file, char device
 * like `/dev/null`, directory) — the skip-only-when-certain, fail-safe rule.
 * Any fstat error → `true` (uncertain, preserve the prior always-wire behavior).
 */
function stdinLooksLikePipe(): boolean {
  try {
    const st = fstatSync(0)
    if (st.isFIFO() || st.isSocket()) return true
    // Regular file / char device (/dev/null) / directory → NOT an EOF pipe.
    if (st.isFile() || st.isCharacterDevice() || st.isDirectory() || st.isBlockDevice()) {
      return false
    }
    return true // unknown fd type → wire (fail-safe)
  } catch {
    return true // no stat available → wire (fail-safe)
  }
}

/**
 * Wire SIGINT/SIGTERM + (when stdin is a pipe/socket) stdin `end`/`close` to a
 * single, at-most-once `onShutdown`, and `resume()` stdin so the EOF flow
 * actually starts. Returns a handle exposing whether shutdown has been triggered
 * (for tests / diagnostics).
 */
export function installGracefulShutdown(
  opts: GracefulShutdownOptions,
): GracefulShutdownHandle {
  const proc = opts.proc ?? process
  const stdin = opts.stdin ?? process.stdin
  // Authoritative flag wins; else auto-detect for the real stdin, and default an
  // injected stdin to a pipe so tests/embedded callers keep the EOF wiring.
  const stdinIsPipe =
    opts.stdinIsPipe ?? (opts.stdin !== undefined ? true : stdinLooksLikePipe())

  let shuttingDown = false
  const trigger = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    opts.onShutdown()
  }

  // POSIX teardown (Windows never runs these for an external kill).
  proc.on("SIGINT", trigger)
  proc.on("SIGTERM", trigger)
  // Cross-platform teardown: parent closing the stdin write end → EOF here. Only
  // wired when stdin is a real EOF-carrying pipe/socket (see the module docstring
  // and stdinLooksLikePipe) so a /dev/null or file-redirected stdin can't fire an
  // instant false shutdown at startup.
  if (stdinIsPipe) {
    stdin.on("end", trigger)
    stdin.on("close", trigger)
    // Start the stdin flow so `'end'` can fire (a paused stdin never emits it).
    try {
      stdin.resume()
    } catch {
      /* best-effort: an absent/closed stdin must not defeat signal wiring */
    }
  }

  return { triggered: () => shuttingDown }
}
