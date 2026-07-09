import { spawn } from "node:child_process"

import { killChildProcessTree, resolveExecutable, runCommandCapture } from "../exec"

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
 * Host an AUTHENTICATED (never anonymous) temporary dev tunnel forwarding the
 * given local port, and resolve once its public URL is printed.
 *
 * We NEVER pass `--allow-anonymous`, so the tunnel is reachable only by the
 * signed-in owner (or identities explicitly granted access) — Microsoft's
 * default. The temporary tunnel is deleted when the child exits (on shutdown).
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
  // Intentionally NO `--allow-anonymous`: authenticated (owner-only) access.
  const child = spawn(cli, ["host", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

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
