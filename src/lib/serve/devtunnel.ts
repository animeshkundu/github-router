import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import os from "node:os"

import { killChildProcessTree, resolveExecutable, runCommandCapture } from "../exec"

// Label stamped on every tunnel `serve --tunnel` creates, so our tunnels are
// identifiable and sweepable (`devtunnel list -l github-router-serve`). Before
// this, serve minted an anonymous, unlabeled tunnel per launch that was never
// deleted — they accumulated server-side against the hard
// `TunnelsPerUserPerCluster` (10) cap until new tunnels were denied.
export const SERVE_TUNNEL_LABEL = "github-router-serve"

// A per-machine label so reuse/sweep scopes to THIS host and never touches a
// tunnel another machine (sharing the same dev-tunnels account) owns. Hashed so
// an arbitrary hostname maps to a label-charset-safe token.
export function serveTunnelMachineLabel(hostname: string = os.hostname()): string {
  return `ghr-machine-${createHash("sha256").update(hostname).digest("hex").slice(0, 12)}`
}

/**
 * Stable, deterministic tunnel ID for THIS machine, so `serve --tunnel` REUSES
 * one tunnel across launches → a stable, bookmarkable public URL. Derived from a
 * hash of the hostname (valid tunnel-id charset: lowercase alnum + hyphens,
 * bounded length). NOTE: the hosting URL's subdomain is a devtunnels-assigned
 * token, NOT this id — the id only anchors find/reuse; the URL is stable because
 * the same tunnel is re-hosted, not because the id appears in it.
 */
export function serveTunnelId(hostname: string = os.hostname()): string {
  return `ghr-serve-${createHash("sha256").update(hostname).digest("hex").slice(0, 12)}`
}

/**
 * Reconcile a reused tunnel's ports to exactly `[desired]`: which existing ports
 * to delete and whether the desired port must be created. Pure (unit-tested).
 * This is why reuse works across `--port` changes — `devtunnel host <id>
 * -p <newport>` fails ("Batch update of ports is not supported"), but per-port
 * `port delete` + `port create` does not.
 */
export function portsToReconcile(
  currentPorts: number[],
  desired: number,
): { toDelete: number[]; toCreate: number | null } {
  return {
    toDelete: currentPorts.filter((p) => p !== desired),
    toCreate: currentPorts.includes(desired) ? null : desired,
  }
}

export interface TunnelInfo {
  tunnelId: string
  labels?: string[]
  hostConnections?: number
}

/**
 * The IDs of our own idle tunnels for this machine to sweep — EXCLUDING the
 * stable reused tunnel (`exceptId`), which we keep and re-host. Pure
 * (unit-tested). A tunnel with a live host connection (a concurrent serve
 * instance) is never swept. Cleans up pre-migration random-named tunnels + any
 * crash-orphaned duplicates while preserving the one stable tunnel.
 */
export function serveTunnelIdsToSweep(
  tunnels: TunnelInfo[],
  machineLabel: string,
  exceptId?: string,
): string[] {
  return tunnels
    .filter((t) => (t.labels ?? []).includes(machineLabel) && !t.hostConnections)
    .map((t) => t.tunnelId)
    .filter((id) => !exceptId || id.split(".")[0] !== exceptId)
}

/** List the tunnels serve owns (label-filtered). Best-effort: [] on any error. */
async function listServeTunnels(cli: string): Promise<TunnelInfo[]> {
  try {
    const { stdout, code } = await runCommandCapture(
      [cli, "list", "-l", SERVE_TUNNEL_LABEL, "-j"],
      { timeoutMs: 15_000 },
    )
    if (code !== 0) return []
    const parsed = JSON.parse(stdout) as { tunnels?: TunnelInfo[] }
    return Array.isArray(parsed?.tunnels) ? parsed.tunnels : []
  } catch {
    return []
  }
}

/** Best-effort delete of a single tunnel by full id (e.g. `fancy-fog-x.inc1`). */
async function deleteTunnel(cli: string, tunnelId: string): Promise<void> {
  try {
    await runCommandCapture([cli, "delete", tunnelId, "-f"], { timeoutMs: 15_000 })
  } catch {
    /* best-effort — a stale delete failing must not block hosting */
  }
}

/** Current port numbers configured on a tunnel. Best-effort: [] on any error. */
async function getTunnelPorts(cli: string, tunnelId: string): Promise<number[]> {
  try {
    const { stdout, code } = await runCommandCapture(
      [cli, "port", "list", tunnelId, "-j"],
      { timeoutMs: 15_000 },
    )
    if (code !== 0) return []
    const parsed = JSON.parse(stdout) as { ports?: Array<{ portNumber?: number }> }
    return (parsed?.ports ?? [])
      .map((p) => p.portNumber)
      .filter((n): n is number => typeof n === "number")
  } catch {
    return []
  }
}

/**
 * Ensure the stable per-machine tunnel exists (create it labeled if absent).
 * Returns true when the stable tunnel is present + owned by us (safe to reuse),
 * false to fall back to the anonymous-labeled host path. `existing` is the
 * pre-fetched label-scoped list (so we don't re-list).
 */
async function ensureStableTunnel(
  cli: string,
  stableId: string,
  machineLabel: string,
  existing: TunnelInfo[],
): Promise<boolean> {
  const present = existing.some((t) => t.tunnelId.split(".")[0] === stableId)
  if (present) return true
  try {
    // `create` errors ("Conflict") if the id is already taken — but we only get
    // here when our label-scoped list did NOT contain it, so a conflict means a
    // DIFFERENT owner holds the id: fall back rather than reuse a foreign tunnel.
    const { code } = await runCommandCapture(
      [cli, "create", stableId, "-l", SERVE_TUNNEL_LABEL, "-l", machineLabel,
        "-d", "github-router-serve-control-plane"],
      { timeoutMs: 20_000 },
    )
    return code === 0
  } catch {
    return false
  }
}

/** Reconcile the tunnel's ports to exactly `[port]` (delete stale, create missing). */
async function reconcileTunnelPorts(cli: string, tunnelId: string, port: number): Promise<void> {
  const { toDelete, toCreate } = portsToReconcile(await getTunnelPorts(cli, tunnelId), port)
  for (const p of toDelete) {
    await runCommandCapture([cli, "port", "delete", tunnelId, "-p", String(p)], { timeoutMs: 15_000 }).catch(() => {})
  }
  if (toCreate != null) {
    await runCommandCapture([cli, "port", "create", tunnelId, "-p", String(toCreate)], { timeoutMs: 15_000 }).catch(() => {})
  }
}


// Matches the browser URL devtunnel prints, e.g.
//   Hosting port 5454 at https://l3rs99qw-5454.usw2.devtunnels.ms/
const DEVTUNNEL_URL_RE =
  /https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.devtunnels\.ms\/?/i

export type DevtunnelFailureKind =
  | "not-installed"
  | "not-logged-in"
  | "timeout"
  | "exited"
  | "spawn"

export class DevtunnelError extends Error {
  readonly kind: DevtunnelFailureKind
  constructor(kind: DevtunnelFailureKind, message: string) {
    super(message)
    this.name = "DevtunnelError"
    this.kind = kind
  }
}

export interface DevtunnelHandle {
  url: string
  stop: () => void
}

/** Absolute path to the `devtunnel` CLI, or null if not on PATH. */
export function resolveDevtunnelCli(): string | null {
  return resolveExecutable("devtunnel")
}

/** Best-effort login check via `devtunnel user show`. */
export async function isDevtunnelLoggedIn(cli: string): Promise<boolean> {
  try {
    const { stdout, stderr, code } = await runCommandCapture(
      [cli, "user", "show"],
      { timeoutMs: 15_000 },
    )
    const out = `${stdout}\n${stderr}`
    if (/not logged in/i.test(out)) return false
    if (/logged in as/i.test(out)) return true
    return code === 0
  } catch {
    return false
  }
}

/** Extract the dev-tunnel browser URL from CLI output. Exported for tests. */
export function parseDevtunnelUrl(text: string): string | null {
  const m = text.match(DEVTUNNEL_URL_RE)
  return m ? m[0].replace(/\/+$/, "") : null
}

/**
 * Spawn `devtunnel <args>` and resolve once it prints its public URL. Shared by
 * the stable-reuse and anonymous-labeled host paths. Rejects (DevtunnelError) on
 * timeout, early exit, an auth error in the output, or a spawn failure.
 */
function hostTunnelProcess(cli: string, args: string[], timeoutMs: number): Promise<DevtunnelHandle> {
  const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  return new Promise<DevtunnelHandle>((resolve, reject) => {
    let settled = false
    const stop = () => {
      // Tree-kill: the devtunnel process spawns a helper and a plain
      // child.kill() leaves the tunnel up (verified). taskkill /T /F on
      // Windows, process-group SIGTERM on POSIX.
      try {
        killChildProcessTree(child, { detachedGroup: process.platform !== "win32" })
      } catch {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () =>
        finish(() => {
          stop()
          reject(new DevtunnelError("timeout", "dev tunnel did not report a URL in time"))
        }),
      timeoutMs,
    )
    const onData = (buf: Buffer) => {
      const text = String(buf)
      const url = parseDevtunnelUrl(text)
      if (url) {
        finish(() => resolve({ url, stop }))
        return
      }
      if (/not logged in|login (required|expired)|unauthorized/i.test(text)) {
        finish(() => {
          stop()
          reject(new DevtunnelError("not-logged-in", "dev tunnel authentication failed; run `devtunnel user login`"))
        })
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", (err) => finish(() => reject(new DevtunnelError("spawn", err.message))))
    child.once("exit", (code) =>
      finish(() =>
        reject(new DevtunnelError("exited", `devtunnel exited (code ${code}) before printing a URL`)),
      ),
    )
  })
}

/**
 * Host an AUTHENTICATED (never anonymous) dev tunnel forwarding `port`, resolving
 * once its public URL is printed. NEVER `--allow-anonymous` (owner-only access).
 *
 * REUSES a stable per-machine tunnel (`serveTunnelId`) across launches → a
 * STABLE, bookmarkable public URL. Each launch: ensure the stable tunnel exists
 * (create it labeled if absent), reconcile its ports to exactly `[port]` via
 * per-port delete/create (`host <id> -p <newport>` can't change ports — it 400s
 * "Batch update of ports is not supported"), sweep our OTHER idle labeled tunnels
 * (pre-migration random-named ones / crash orphans), then `host <id>`. The URL's
 * subdomain is a devtunnels-assigned token (not the id), but it's stable because
 * the SAME tunnel is re-hosted every launch.
 *
 * If any stable-path step fails (id already taken by another owner, CLI hiccup),
 * falls back to hosting a fresh anonymous-labeled tunnel (the prior behavior) so
 * `--tunnel` always works — just without a stable URL that launch.
 */
export async function startDevtunnel(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<DevtunnelHandle> {
  const cli = resolveDevtunnelCli()
  if (!cli) {
    throw new DevtunnelError(
      "not-installed",
      "The `devtunnel` CLI is not installed. Install it (winget install Microsoft.devtunnel  /  brew install --cask devtunnel) then run `devtunnel user login`.",
    )
  }
  if (!(await isDevtunnelLoggedIn(cli))) {
    throw new DevtunnelError(
      "not-logged-in",
      "Not signed in to dev tunnels. Run `devtunnel user login` (or `devtunnel user login -g` for GitHub) first.",
    )
  }

  const timeoutMs = opts.timeoutMs ?? 40_000
  const machineLabel = serveTunnelMachineLabel()
  const stableId = serveTunnelId()

  // Stable-reuse path (best-effort; any failure falls through to anonymous host).
  try {
    const owned = await listServeTunnels(cli)
    if (await ensureStableTunnel(cli, stableId, machineLabel, owned)) {
      await reconcileTunnelPorts(cli, stableId, port)
      // Sweep our OTHER idle labeled tunnels but KEEP the stable one.
      for (const id of serveTunnelIdsToSweep(owned, machineLabel, stableId)) {
        await deleteTunnel(cli, id)
      }
      return await hostTunnelProcess(cli, ["host", stableId], timeoutMs)
    }
  } catch {
    /* fall through to the anonymous-labeled host path */
  }

  // Fallback: sweep our idle labeled tunnels, then host a fresh anonymous one.
  // Labels are SEPARATE `-l` flags — the service rejects a label containing a
  // space (`must match '[\w-=]{1,50}'`), so they can't be joined into one arg.
  try {
    for (const id of serveTunnelIdsToSweep(await listServeTunnels(cli), machineLabel)) {
      await deleteTunnel(cli, id)
    }
  } catch {
    /* best-effort sweep — never blocks hosting */
  }
  return await hostTunnelProcess(
    cli,
    ["host", "-p", String(port), "-l", SERVE_TUNNEL_LABEL, "-l", machineLabel, "-d", "github-router-serve-control-plane"],
    timeoutMs,
  )
}
