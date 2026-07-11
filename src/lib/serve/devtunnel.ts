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

export interface TunnelInfo {
  tunnelId: string
  labels?: string[]
  hostConnections?: number
}

/**
 * The IDs of our own idle tunnels for this machine — every one is deleted before
 * we host a fresh labeled tunnel, bounding github-router to a single tunnel per
 * machine. Pure (unit-tested). A tunnel with a live host connection (a
 * concurrent serve instance) is never swept.
 */
export function serveTunnelIdsToSweep(
  tunnels: TunnelInfo[],
  machineLabel: string,
): string[] {
  return tunnels
    .filter((t) => (t.labels ?? []).includes(machineLabel) && !t.hostConnections)
    .map((t) => t.tunnelId)
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
 * Host an AUTHENTICATED (never anonymous) dev tunnel forwarding the given local
 * port, and resolve once its public URL is printed.
 *
 * We NEVER pass `--allow-anonymous`, so the tunnel is reachable only by the
 * signed-in owner (or identities explicitly granted access) — Microsoft's
 * default.
 *
 * Tunnel lifecycle: a tunnel implicitly created by `host` is a PERSISTENT
 * server-side object — killing the host process stops hosting but does NOT
 * delete it. So instead of minting a fresh anonymous tunnel per launch (which
 * strands objects against the `TunnelsPerUserPerCluster` cap), we label every
 * tunnel and, on each launch, sweep our own idle labeled tunnels from prior
 * launches before hosting a fresh one. That bounds github-router to a single
 * tunnel per machine and stays correct across `--port` changes (reusing a
 * tunnel by id can't: `devtunnel host <id> -p <newport>` fails with "Batch
 * update of ports is not supported" when the baked-in port differs). Because the
 * next launch's sweep also reclaims a crash/`taskkill`-orphaned tunnel, teardown
 * reliability doesn't matter.
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

  // Delete our own idle tunnels from prior launches, then host a fresh labeled
  // one below. Best-effort: any failure just skips the sweep (we still host).
  const machineLabel = serveTunnelMachineLabel()
  try {
    for (const id of serveTunnelIdsToSweep(await listServeTunnels(cli), machineLabel)) {
      await deleteTunnel(cli, id)
    }
  } catch {
    /* best-effort sweep — never blocks hosting */
  }

  // Intentionally NO `--allow-anonymous`: authenticated (owner-only) access.
  // Labels are SEPARATE `-l` flags — the service rejects a label containing a
  // space (`must match '[\w-=]{1,50}'`), so they can't be joined into one arg.
  const child = spawn(
    cli,
    [
      "host",
      "-p",
      String(port),
      "-l",
      SERVE_TUNNEL_LABEL,
      "-l",
      machineLabel,
      "-d",
      "github-router-serve-control-plane",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )

  return await new Promise<DevtunnelHandle>((resolve, reject) => {
    let settled = false
    const stop = () => {
      // Tree-kill: the devtunnel process spawns a helper and a plain
      // child.kill() leaves the tunnel up (verified). taskkill /T /F on
      // Windows, process-group SIGTERM on POSIX.
      try {
        killChildProcessTree(child, {
          detachedGroup: process.platform !== "win32",
        })
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
          reject(
            new DevtunnelError(
              "timeout",
              "dev tunnel did not report a URL in time",
            ),
          )
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
          reject(
            new DevtunnelError(
              "not-logged-in",
              "dev tunnel authentication failed; run `devtunnel user login`",
            ),
          )
        })
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", (err) =>
      finish(() => reject(new DevtunnelError("spawn", err.message))),
    )
    child.once("exit", (code) =>
      finish(() =>
        reject(
          new DevtunnelError(
            "exited",
            `devtunnel exited (code ${code}) before printing a URL`,
          ),
        ),
      ),
    )
  })
}
