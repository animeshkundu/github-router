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
 *    gone.
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
  spawn?: (cmd: string[], env: NodeJS.ProcessEnv) => { pid?: number; kill: () => void }
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
    const spawn =
      opts.spawn ??
      ((cmd, e) => {
        // node:child_process (not Bun.spawn) so the bundled dist/main.js stays
        // node-loadable. No `detached` — the caller kills this on shutdown.
        const proc = spawnChild(cmd[0]!, cmd.slice(1), {
          env: e,
          stdio: "ignore",
        })
        // Finding 1: ENOENT (e.g. `bun` not on PATH) is delivered ASYNC as an
        // 'error' event. Without a listener the emitter re-throws on a later
        // tick → uncaughtException → the proxy exits(1). Swallow it.
        proc.on("error", (err) =>
          consola.debug("first-mate daemon spawn error (ignored):", err),
        )
        return { pid: proc.pid, kill: () => void proc.kill() }
      })
    const child = spawn(["bun", script], env)
    return { pid: child.pid, kill: child.kill }
  } catch {
    return undefined // never let a spawn failure crash bootstrap
  }
}
