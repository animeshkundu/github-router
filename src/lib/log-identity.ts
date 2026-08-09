import { getPackageVersion } from "~/lib/version"

/**
 * Process identity for log lines.
 *
 * Several proxies routinely run on one machine (a long-lived `start`, plus one
 * per `claude` session) and they all append to the SAME `PATHS.ERROR_LOG_PATH`.
 * Without an identity field, one process's 401 storm is indistinguishable from
 * another's, and the natural reading — "the session I am looking at is broken"
 * — is wrong whenever a stale proxy is the one failing. That misreading cost a
 * full investigation before this existed, so the identity is not decoration.
 *
 * Deliberately NOT implemented with consola's `tag`: consola snapshots
 * `options.defaults` into each bound log method inside its constructor, so
 * assigning `consola.options.defaults.tag` after startup is a silent no-op, and
 * `withTag()` returns a new instance that every existing call site would have
 * to be rewritten to use. Formatting at the reporter is the one place that
 * covers every caller.
 */

let listenPort: number | undefined

/**
 * Publish the bound port, once it is actually known.
 *
 * Call this only AFTER the listener is ready. `setupAndServe` may retry several
 * random ports before one binds, so any earlier value can be wrong — and a
 * confidently wrong port in a log line is worse than none at all.
 *
 * Passing `undefined` clears it, which is what a test needs to exercise the
 * pre-bind state.
 */
export function setLogListenPort(port: number | undefined): void {
  listenPort = port
}

/**
 * `pid=<n> port=<n|pending> v<version>` — the smallest string that answers
 * "which process wrote this line, and was it running the build I think it was".
 *
 * `pending` rather than a guess: a line written before the listener bound is
 * genuinely portless, and saying so is honest where inventing a number is not.
 *
 * `getPackageVersion()` memoizes internally, so this stays allocation-plus-
 * concat on every line rather than a synchronous file read.
 */
export function logIdentity(): string {
  return `pid=${process.pid} port=${listenPort ?? "pending"} v${getPackageVersion()}`
}
