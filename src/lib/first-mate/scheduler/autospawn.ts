import { spawn as spawnChild } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import consola from "consola"

/**
 * Opt-in auto-spawn of the first-mate scheduler daemon as a SEPARATE process
 * (a hung tick must not starve the proxy event loop).
 *
 * DEFAULT OFF — gated by GH_ROUTER_FM_DAEMON === "1" (explicit opt-in). The
 * durable [fm-heartbeat] cron is the DEFAULT driver and the proven path; the
 * daemon is experimental and NOT yet safe as the default because two hardening
 * items remain (a verifier-stall wall-clock escalation, and an atomic-claim
 * lock in durable-store) — flip the default only once those land.
 *
 * Requirements + honest boundaries:
 *  - The daemon entry is `scripts/first-mate-daemon.ts` (a TS source file run via
 *    `bun`); it is NOT in the published dist tarball, so auto-spawn only fires
 *    from a source checkout with `bun` available. If the script is absent we
 *    no-op (never a false "spawned" log).
 *  - Spawn failures NEVER crash the proxy: an async ENOENT (`bun` not on PATH)
 *    arrives as an `'error'` EVENT, not a sync throw, so we attach an `'error'`
 *    listener (without it the emitter re-throws → uncaughtException → exit(1)).
 *  - The returned handle MUST be killed by the caller on shutdown (no `detached`);
 *    an orphaned drive-primary daemon would keep merging PRs after the proxy is
 *    gone. The parent ALSO holds the child's stdin write end (`stdio[0]==="pipe"`)
 *    so it can EOF the child for a GRACEFUL stop (lease + pidfile released
 *    immediately, not by expiry) — the cross-platform teardown trigger, since an
 *    external SIGTERM on Windows is a hard kill the child can't observe. `kill()`
 *    stays the hard backstop so a wedged child is never orphaned (see
 *    `wireDaemonTeardown`).
 *  - It owns the deterministic drive loop only; live judgments still wake the
 *    lead via the heartbeat (no server->lead push).
 */

export function shouldAutoSpawnDaemon(
  env: NodeJS.ProcessEnv,
  agentsEnabled: boolean,
): boolean {
  if (!agentsEnabled) return false // nothing to drive without missions/agents
  return env.GH_ROUTER_FM_DAEMON === "1" // OPT-IN; default OFF (heartbeat drives)
}

export interface DaemonHandle {
  pid: number | undefined
  kill: () => void
  /**
   * Close the child's stdin write end (EOF). The daemon observes this as a
   * cross-platform graceful-shutdown trigger and releases its lease/pidfile
   * cleanly. Best-effort + non-throwing (a missing/closed stdin is a no-op).
   */
  endStdin: () => void
}

/** Options an injected spawner receives (so tests can assert the stdio shape). */
export interface DaemonSpawnOptions {
  env: NodeJS.ProcessEnv
  /** stdin MUST be "pipe" so the parent can EOF the child; 1/2 stay "ignore". */
  stdio: Array<"pipe" | "ignore" | "inherit">
}

/** What a spawner returns; `endStdin` is optional (defaulted to a no-op). */
export interface SpawnedChild {
  pid?: number
  kill: () => void
  endStdin?: () => void
}

/**
 * The minimal `child_process.spawn` surface {@link nodeDaemonSpawn} needs. A
 * narrow interface (not `typeof spawnChild`) so a test can inject a fake child
 * whose `kill` records the signal — the only way to assert the SIGKILL backstop,
 * since the injected `spawn` in {@link maybeSpawnDaemon} replaces `kill` wholesale.
 */
export type LowLevelSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: Array<"pipe" | "ignore" | "inherit"> },
) => {
  pid?: number
  on(event: "error", listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
  stdin?: { end(): void } | null
}

/**
 * The real (non-injected) spawner: node:child_process (not Bun.spawn) so the
 * bundled dist/main.js stays node-loadable. No `detached` — the caller kills
 * this on shutdown. stdin is "pipe" (parent holds the write end for a graceful
 * EOF stop); stdout/stderr stay "ignore".
 */
export function nodeDaemonSpawn(
  cmd: string[],
  spawnOpts: DaemonSpawnOptions,
  spawnImpl: LowLevelSpawn = spawnChild,
): SpawnedChild {
  const proc = spawnImpl(cmd[0]!, cmd.slice(1), {
    env: spawnOpts.env,
    stdio: spawnOpts.stdio,
  })
  // Finding 1: ENOENT (e.g. `bun` not on PATH) is delivered ASYNC as an
  // 'error' event. Without a listener the emitter re-throws on a later tick →
  // uncaughtException → the proxy exits(1). Swallow it.
  proc.on("error", (err) =>
    consola.debug("first-mate daemon spawn error (ignored):", err),
  )
  return {
    pid: proc.pid,
    // Finding 3: SIGKILL, not the default SIGTERM. This is the HARD backstop
    // that only runs AFTER endStdin()'s graceful EOF already fired the child's
    // shutdown trigger — and the child's graceful-shutdown handler TRAPS SIGTERM
    // and no-ops it. So a catchable SIGTERM here could NOT force-kill a wedged
    // child on POSIX → an orphaned drive-primary daemon that keeps merging PRs.
    // SIGKILL is uncatchable, restoring the "wedged child is never orphaned"
    // guarantee cross-platform. (On Windows any signal maps to an unconditional
    // TerminateProcess, so it was already safe there.)
    kill: () => void proc.kill("SIGKILL"),
    // EOF the child's stdin → graceful shutdown. Best-effort: a closed or
    // never-opened stdin must not throw during teardown.
    endStdin: () => {
      try {
        proc.stdin?.end()
      } catch {
        /* best-effort */
      }
    },
  }
}

/**
 * Spawn the daemon child if the opt-in gate passes AND the daemon script is
 * present; else return undefined. Never throws, and never lets an async spawn
 * error crash bootstrap.
 */
export function maybeSpawnDaemon(opts: {
  env?: NodeJS.ProcessEnv
  agentsEnabled: boolean
  repoRoot?: string
  spawn?: (cmd: string[], spawnOpts: DaemonSpawnOptions) => SpawnedChild
}): DaemonHandle | undefined {
  const env = opts.env ?? process.env
  if (!shouldAutoSpawnDaemon(env, opts.agentsEnabled)) return undefined
  const script = path.join(opts.repoRoot ?? process.cwd(), "scripts/first-mate-daemon.ts")
  // Finding 6: in a dist/global install the .ts entry isn't present — no-op
  // rather than spawn a doomed `bun <missing.ts>` and log a false success.
  if (opts.spawn === undefined && !existsSync(script)) {
    consola.debug(`first-mate daemon entry not found (${script}); auto-spawn skipped.`)
    return undefined
  }
  try {
    const spawn = opts.spawn ?? ((cmd, spawnOpts): SpawnedChild => nodeDaemonSpawn(cmd, spawnOpts))
    const child = spawn(["bun", script], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    })
    return {
      pid: child.pid,
      kill: child.kill,
      endStdin: child.endStdin ?? (() => {}),
    }
  } catch {
    return undefined // never let a spawn failure crash bootstrap
  }
}

/**
 * Wire the proxy's teardown to shut the daemon child down GRACEFULLY, then hard
 * kill as a backstop. Ordering (per teardown path):
 *  1. `endStdin()` — EOF the child so it releases its lease/pidfile cleanly (the
 *     cross-platform trigger; on Windows an external SIGTERM would never run the
 *     child's handler, so this EOF is the ONLY graceful path there).
 *  2. `kill()` — hard backstop so a wedged child is never orphaned (a prior
 *     review blocker: an orphaned drive-primary daemon keeps merging PRs).
 *
 * On SIGINT/SIGTERM the kill is deferred by a short, NON-BLOCKING, unref'd grace
 * window (proxy exit is never delayed for it). On `'exit'` — where timers cannot
 * run — we EOF then kill synchronously as a last resort. All steps are
 * once-guarded and non-throwing.
 */
export function wireDaemonTeardown(
  handle: DaemonHandle,
  opts: {
    proc?: Pick<NodeJS.Process, "once">
    graceMs?: number
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  } = {},
): void {
  const proc = opts.proc ?? process
  const graceMs = opts.graceMs ?? 300
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))

  let killed = false
  const kill = (): void => {
    if (killed) return
    killed = true
    try {
      handle.kill()
    } catch {
      /* best-effort */
    }
  }
  let ended = false
  const endStdin = (): void => {
    if (ended) return
    ended = true
    try {
      handle.endStdin()
    } catch {
      /* best-effort: a missing/closed stdin must not throw during teardown */
    }
  }

  const onSignal = (): void => {
    endStdin() // 1) graceful EOF first
    const t = setTimer(kill, graceMs) // 2) hard backstop, non-blocking
    if (t && typeof t.unref === "function") t.unref()
  }
  proc.once("SIGINT", onSignal)
  proc.once("SIGTERM", onSignal)
  // 'exit' handlers cannot schedule timers — EOF then kill synchronously.
  proc.once("exit", () => {
    endStdin()
    kill()
  })
}
