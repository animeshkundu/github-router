import path from "node:path"

/**
 * Capstone — daemon auto-spawn at bootstrap. When the server boots in
 * operator/`--agents` mode, spawn the first-mate scheduler daemon as a SEPARATE
 * process (the peer review required a separate lane so a hung tick can't starve
 * the proxy event loop). Default-ON, gated by GH_ROUTER_FM_DAEMON != 0.
 *
 * Safe now because answer-decoupling + driveGate + push escalation are in: the
 * daemon is drive-primary via the fencing lease and the existing [fm-heartbeat]
 * degrades to a passive failover + escalation-wake (NOT disarmed). Dormant on
 * the branch — it only activates on the human's rebuild with agents enabled.
 */

export function shouldAutoSpawnDaemon(
  env: NodeJS.ProcessEnv,
  agentsEnabled: boolean,
): boolean {
  if (!agentsEnabled) return false // nothing to drive without missions/agents
  return env.GH_ROUTER_FM_DAEMON !== "0" // default ON; =0 is the escape hatch
}

export interface DaemonHandle {
  pid: number | undefined
  kill: () => void
}

/**
 * Spawn the daemon as a detached child if the gate passes; else return
 * undefined. The daemon script self-guards too (GH_ROUTER_FM_DAEMON=0 exits),
 * so this is belt-and-suspenders. Never throws — a failed spawn must not take
 * down the proxy.
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
  try {
    const spawn =
      opts.spawn ??
      ((cmd, e) => {
        const proc = Bun.spawn(cmd, { env: e, stdout: "ignore", stderr: "ignore" })
        return { pid: proc.pid, kill: () => proc.kill() }
      })
    const child = spawn(["bun", script], env)
    return { pid: child.pid, kill: child.kill }
  } catch {
    return undefined // never let a spawn failure crash bootstrap
  }
}
