import { spawn } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"

import { defineCommand } from "citty"
import consola from "consola"

import { killChildProcessTree } from "./lib/exec"
import { ensureClaudeConfigMirror, removeOwnClaudeConfigMirror } from "./lib/paths"
import { pickClaudeDefault } from "./lib/port"
import {
  getClaudeCodeEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"
import {
  composeCloudCliChildEnv,
  mintJwt,
  resolveCloudCli,
  spawnCloudCli,
  waitForCloudCliReady,
} from "./lib/serve/cloudcli"
import { startReverseProxy } from "./lib/serve/reverse-proxy"
import { getGitHubUser } from "./services/github/get-user"

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** Default user-facing control-plane port when `--port` is not given. */
const DEFAULT_SERVE_PORT = 5454

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.once("error", () => resolve(false))
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)))
  })
}

/**
 * Resolve the user-facing port: honor an explicit `--port`; otherwise use 5454
 * when free, else fall back to a random free port.
 */
async function resolveServePort(requested?: number): Promise<number> {
  if (requested != null) return requested
  if (await isPortFree(DEFAULT_SERVE_PORT)) return DEFAULT_SERVE_PORT
  const fallback = await getFreePort()
  consola.info(`Port ${DEFAULT_SERVE_PORT} is in use; using ${fallback} instead.`)
  return fallback
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref()
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
    }
  } catch {
    // best-effort; the URL is printed too
  }
}

export const serve = defineCommand({
  meta: {
    name: "serve",
    description:
      "Serve a browser control plane (CloudCLI) with Claude routed through the proxy",
  },
  args: {
    ...sharedServerArgs,
    model: {
      alias: "m",
      type: "string",
      description: "Override the default Claude model",
    },
    "cloudcli-path": {
      type: "string",
      description: "Use an existing CloudCLI install instead of the managed one",
    },
    "cloudcli-version": {
      type: "string",
      description: "Override the pinned CloudCLI version to install",
    },
    "no-install": {
      type: "boolean",
      default: false,
      description: "Do not auto-install CloudCLI; require an existing install",
    },
    "no-open": {
      type: "boolean",
      default: false,
      description: "Do not open the browser automatically",
    },
    "public-url": {
      type: "string",
      description:
        "Public URL(s) this is reachable at (e.g. a dev-tunnel https URL), comma-separated — allowlists their host+origin for remote access",
    },
    devtunnel: {
      type: "boolean",
      default: false,
      description:
        "Accept any *.devtunnels.ms host/origin (Microsoft dev tunnels) without pinning the exact --public-url",
    },
  },
  async run({ args }) {
    if (process.versions.bun) {
      consola.warn(
        "`serve` should run under Node.js. Bun's node:http upgrade sockets cannot relay the CloudCLI terminal/chat WebSockets; run the installed `github-router` binary (Node).",
      )
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)
    const chosenSlug = (args.model as string | undefined) ?? pickClaudeDefault()

    // 1. github-router proxy — internal (random port). The USER-facing port is
    //    the reverse proxy below, so force this one random regardless of --port.
    const { server, serverUrl } = await setupAndServe({
      ...parsed,
      port: undefined,
      silent: true,
    })

    // 2. provision the router-owned CLAUDE_CONFIG_DIR (synthetic creds +
    //    onboarding-skip) so CloudCLI's SDK-spawned claude authenticates
    //    through the proxy. Hard-fail on error (mirrors src/claude.ts).
    try {
      await ensureClaudeConfigMirror()
    } catch (err) {
      consola.error(
        `Failed to provision CLAUDE_CONFIG_DIR mirror: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      process.exit(1)
    }

    // 3. filtered child env: the vetted secret-stripping allowlist (buildEnv,
    //    drops GITHUB_TOKEN/GH_ROUTER_*/ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY/
    //    COPILOT_TOKEN) plus the non-secret ANTHROPIC_BASE_URL/CLAUDE_CONFIG_DIR
    //    /model vars. Auth rides the synthetic .credentials.json FILE, not env.
    const childEnv: NodeJS.ProcessEnv = composeCloudCliChildEnv(
      getClaudeCodeEnvVars(serverUrl, chosenSlug),
    )

    // 4. resolve/install + spawn CloudCLI on a loopback port.
    let cloudcli
    try {
      cloudcli = await resolveCloudCli({
        cliPath: args["cloudcli-path"] as string | undefined,
        noInstall: args["no-install"] === true,
        version: args["cloudcli-version"] as string | undefined,
      })
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const ccPort = await getFreePort()
    const cc = spawnCloudCli({
      serverEntry: cloudcli.serverEntry,
      port: ccPort,
      env: childEnv,
    })

    // 5. shutdown wiring (we don't use launchChild — its kind union is closed).
    let shuttingDown = false
    let reverseClose: (() => Promise<void>) | null = null
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      try {
        killChildProcessTree(cc.child, {
          detachedGroup: process.platform !== "win32",
        })
      } catch {
        /* best-effort */
      }
      if (reverseClose) await reverseClose().catch(() => {})
      try {
        ;(server as unknown as { close?: () => void }).close?.()
      } catch {
        /* best-effort */
      }
      await removeOwnClaudeConfigMirror().catch(() => {})
    }
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)))
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)))
    cc.child.once("exit", (code) => {
      if (!shuttingDown) {
        consola.error(`CloudCLI exited unexpectedly (code ${code}).`)
        void shutdown().then(() => process.exit(1))
      }
    })
    cc.child.once("error", (err) => {
      // spawn failure (ENOENT/EACCES) emits 'error', not 'exit' — an unhandled
      // 'error' crashes the process and bypasses shutdown, orphaning the mirror.
      if (!shuttingDown) {
        consola.error(`CloudCLI failed to start: ${err.message}`)
        void shutdown().then(() => process.exit(1))
      }
    })

    // 6. wait for CloudCLI, seed the user from the GitHub identity, mint a JWT.
    let ready
    try {
      ready = await waitForCloudCliReady(ccPort)
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err))
      await shutdown()
      process.exit(1)
    }

    let username = "github-router"
    try {
      username = (await getGitHubUser()).login
    } catch {
      // fall back to a generic control-plane user; not fatal
    }

    let token: string
    try {
      token = await mintJwt(ccPort, username, ready.needsSetup)
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err))
      await shutdown()
      process.exit(1)
    }

    // 7. resolve remote-access allowlist (dev tunnels) + the user-facing port.
    const publicUrls = String(args["public-url"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const extraAllowedHosts: string[] = []
    const extraAllowedOrigins: string[] = []
    for (const u of publicUrls) {
      try {
        const url = new URL(u)
        extraAllowedHosts.push(url.host)
        extraAllowedOrigins.push(url.origin)
      } catch {
        consola.warn(`Ignoring invalid --public-url "${u}"`)
      }
    }
    const allowDevtunnelHosts = args.devtunnel === true
    if (extraAllowedHosts.length || allowDevtunnelHosts) {
      consola.warn(
        "Remote access enabled: anyone who reaches this through your tunnel AND passes the tunnel's authentication gets FULL control-plane access — including a shell on this machine. Use an authenticated (non-anonymous) tunnel and only grant access to people you fully trust.",
      )
    }

    const servePort = await resolveServePort(parsed.port)
    let reverse
    try {
      reverse = await startReverseProxy({
        targetHost: "127.0.0.1",
        targetPort: ccPort,
        bindHost: "127.0.0.1",
        bindPort: servePort,
        authToken: token,
        extraAllowedHosts,
        extraAllowedOrigins,
        allowDevtunnelHosts,
      })
    } catch (err) {
      consola.error(
        `Failed to bind the control-plane port ${servePort}: ${
          err instanceof Error ? err.message : String(err)
        }. Is it already in use? Pass --port <n>.`,
      )
      await shutdown()
      process.exit(1)
    }
    reverseClose = reverse.close

    // 8. ready.
    const publicLine = publicUrls.length
      ? `\npublic: ${publicUrls.join(", ")}`
      : allowDevtunnelHosts
        ? `\npublic: any *.devtunnels.ms tunnel`
        : ""
    consola.box(
      `🖥️  github-router control plane\n\n${reverse.url}${publicLine}\n\nsigned in as ${username} · model ${chosenSlug}\nCtrl+C to stop`,
    )
    if (args["no-open"] !== true) openBrowser(reverse.url)
  },
})
