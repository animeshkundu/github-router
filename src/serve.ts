import { spawn } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"

import { defineCommand } from "citty"
import consola from "consola"

import { provisionBrowserAssets } from "./lib/browser-mcp/provision"
import { provisionAndIndexColbert } from "./lib/colbert"
import { resolveCodexCliBackend } from "./lib/codex-mcp-config"
import { killChildProcessTree } from "./lib/exec"
import { startKeepAwake, stopKeepAwake } from "./lib/keep-awake"
import {
  hookLauncherDegradedWarning,
  resolveSelfInvocation,
} from "./lib/hook-launcher/self-invocation"
import { getCodexVersion } from "./lib/launch"
import { resolveLaunchProfile } from "./lib/launch-profile"
import { browserToolsEnabled } from "./lib/mcp-capabilities"
import { SEAMLESS_BUILTIN_TOOLS } from "./lib/mcp-permissions-settings"
import { ensureClaudeConfigMirror, PATHS, removeOwnClaudeConfigMirror } from "./lib/paths"
import {
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
  pickClaudeDefault,
  resolveLeadSlugArg,
} from "./lib/port"
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
import { DevtunnelError, startDevtunnel } from "./lib/serve/devtunnel"
import { provisionServeEnhancements } from "./lib/serve/enhancements"
import { facadeBlockedRequest, facadeInterceptKind, rewriteProviderResponse } from "./lib/serve/provider-facade"
import {
  SERVE_IDENTITY_PATH,
  SERVE_IDENTITY_SERVICE,
  startReverseProxy,
} from "./lib/serve/reverse-proxy"
import { runSelfUpdate } from "./lib/self-update"
import { state } from "./lib/state"
import { provisionToolbelt } from "./lib/toolbelt/provision"
import { resolveModel } from "./lib/utils"
import { getGitHubUser } from "./services/github/get-user"

export function assertStandardServeModel(model: string | undefined): void {
  const requestedProfile = resolveLaunchProfile(model)
  if (requestedProfile === "standard") return
  throw new Error(
    `The ${requestedProfile} launch profile is available only through `
      + `github-router claude -m ${requestedProfile}; github-router serve uses `
      + "the Standard roster, ACL, and model picker. Pass an explicit model id "
      + "to serve instead of the profile alias.",
  )
}

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
 * Probe a loopback port for an already-running `github-router serve` (its
 * identity endpoint). Returns true when the port hosts OUR serve, else false
 * (free, or a foreign process). `serve` is designed to run ONCE per machine
 * (a single machine-wide control plane for all repos), so a second launch
 * attaches to the running one instead of spawning a duplicate CloudCLI +
 * contending on the shared auth DB. We intentionally do NOT trust any URL the
 * probed service reports — a local squatter could forge the identity marker, so
 * the caller only ever opens a locally-constructed loopback origin.
 */
function probeExistingServe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: SERVE_IDENTITY_PATH,
        headers: { host: `127.0.0.1:${port}` },
        timeout: 1500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(false)
          return
        }
        const chunks: Buffer[] = []
        res.on("data", (d) => chunks.push(Buffer.from(d)))
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              service?: string
            }
            resolve(body.service === SERVE_IDENTITY_SERVICE)
          } catch {
            resolve(false)
          }
        })
        res.on("error", () => resolve(false))
      },
    )
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(false))
  })
}

/**
 * Resolve the user-facing port: honor an explicit `--port`; otherwise use 5454
 * when free, else fall back to a random free port. (Single-instance detection —
 * an already-running github-router serve on the intended port — is handled by
 * the earlier `probeExistingServe` attach/refuse in `run`.)
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
    "codex-cli": {
      type: "boolean",
      default: false,
      description: "Route Codex personas through a local `codex mcp-server` (requires codex 0.129+; falls back to HTTP if missing)",
    },
    "browse-over-tunnel": {
      type: "boolean",
      default: false,
      description: "Expose the server-side browser MCP even when tunnel-exposed (session-hijack / SSRF risk — only with fully-trusted tunnel access)",
    },
    "agents-over-tunnel": {
      type: "boolean",
      default: false,
      description: "Expose first-mate (mints a repo+workflow GitHub write token) even when tunnel-exposed (only with fully-trusted tunnel access)",
    },
    "fleet-over-tunnel": {
      type: "boolean",
      default: false,
      description: "Expose the fleet MCP (drives remote coding sessions with your fleet credentials) even when tunnel-exposed (only with fully-trusted tunnel access)",
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
    tunnel: {
      type: "boolean",
      default: false,
      description:
        "Auto-create + host an AUTHENTICATED (never anonymous) Microsoft dev tunnel for the serve port and print its public URL, so you can reach the control plane from anywhere. Requires the `devtunnel` CLI + `devtunnel user login`.",
    },
  },
  async run({ args }) {
    state.serveMode = true

    if (process.versions.bun) {
      consola.warn(
        "`serve` should run under Node.js. Bun's node:http upgrade sockets cannot relay the CloudCLI terminal/chat WebSockets; run the installed `github-router` binary (Node).",
      )
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)
    try {
      assertStandardServeModel(args.model as string | undefined)
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // Single-instance guard: `serve` is a machine-wide control plane meant to run
    // ONCE per machine (work on any repo through its file explorer / sessions). If
    // one is already running on the intended port, attach to it (open + exit)
    // instead of spawning a second CloudCLI that would contend on the shared auth
    // DB. Only triggers for OUR serve; a foreign process on the port falls through
    // to the random-port fallback in resolveServePort.
    const intendedPort = parsed.port ?? DEFAULT_SERVE_PORT
    if (await probeExistingServe(intendedPort)) {
      // Construct the URL locally — never trust a URL the probed service reports
      // (a local squatter could forge the identity marker into an open-browser).
      const existingUrl = `http://127.0.0.1:${intendedPort}`
      consola.box(
        `github-router control plane already running\n\n${existingUrl}\n\nOpening it — stop that instance first if you want a fresh one.`,
      )
      if (args["no-open"] !== true) openBrowser(existingUrl)
      return
    }

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

    // Best-effort self-update (detached, applies next launch). Runs after the
    // server is listening so the bounded probe can't delay it.
    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    // Best-effort ColBERT semantic-search provision. ON by default; never blocks
    // launch. `skipCwdIndex`: serve is machine-wide, so the launch cwd is usually
    // NOT a repo the user works on — per-workspace on-demand indexing (kicked by
    // the first search for a given repo) covers real queries instead.
    void provisionAndIndexColbert({ skipCwdIndex: true })

    // Best-effort LLM toolbelt materialization. The mirror awareness line is
    // written by provisionServeEnhancements below, matching `github-router claude`.
    void provisionToolbelt().catch((err) =>
      consola.debug("Toolbelt provisioning failed:", err),
    )

    // Best-effort: keep the machine awake while the proxy/CloudCLI session runs.
    // Released via stopKeepAwake() in the shutdown chain below and by the module's
    // own self-registered signal/exit reaper.
    startKeepAwake()

    // Best-effort: materialize the browser extension + bridge into the stable
    // app-dir when browser tools are enabled.
    if (browserToolsEnabled()) {
      void provisionBrowserAssets().catch((err) =>
        consola.debug("Browser extension provisioning failed:", err),
      )
    }

    // Same lead-slug resolution the `claude` subcommand uses, via the shared
    // helper rather than a second copy of the branching. The copy that used to
    // live here had drifted twice: it never learned the `-m fast` alias, and
    // its fallback walk assigned the bare constant, silently dropping the
    // `[1m]` accounting on a family that is 1M-capable. Re-deriving the
    // fallback through `pickClaudeDefault` is what `src/claude.ts` already
    // does, for that exact reason.
    let chosenSlug = resolveLeadSlugArg(args.model as string | undefined)
    if (!(args.model as string | undefined)?.trim() && state.models) {
      const inCache = (slug: string): boolean =>
        state.models?.data.some((m) => m.id === resolveModel(slug)) ?? false
      if (!inCache(chosenSlug)) {
        for (const fb of DEFAULT_CLAUDE_MODEL_FALLBACKS) {
          if (inCache(fb)) {
            const fallbackSlug = pickClaudeDefault(
              fb.replace(/^claude-opus-/, ""),
            )
            consola.info(
              `Default model "${chosenSlug}" not in your Copilot model list; falling back to "${fallbackSlug}".`,
            )
            chosenSlug = fallbackSlug
            break
          }
        }
      }
    }

    const requestedCli = args["codex-cli"] === true
    const backend = resolveCodexCliBackend({
      requested: requestedCli,
      codexInfo: requestedCli ? getCodexVersion() : null,
    })
    const tunnelExposed =
      args.tunnel === true
      || String(args["public-url"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length > 0
    if (tunnelExposed && browserToolsEnabled() && args["browse-over-tunnel"] !== true) {
      consola.info(
        "Browser MCP is disabled over the tunnel (session-hijack/SSRF risk). Pass --browse-over-tunnel to enable it for fully-trusted access.",
      )
    }
    if (tunnelExposed && state.agentsEnabled && args["agents-over-tunnel"] !== true) {
      consola.info(
        "first-mate is disabled over the tunnel (it mints a GitHub write token). Pass --agents-over-tunnel to enable it for fully-trusted access.",
      )
    }
    if (tunnelExposed && state.fleetEnabled && args["fleet-over-tunnel"] !== true) {
      consola.info(
        "Fleet MCP is disabled over the tunnel (it drives remote coding sessions with your fleet credentials). Pass --fleet-over-tunnel to enable it for fully-trusted access.",
      )
    }

    // 2b. wire the github-router enhancement layer (MCP servers + peer/worker
    //     subagents + gh-* skills) into the mirror so CloudCLI-spawned Claude
    //     sessions get the same tools `github-router claude` provides. Must run
    //     after the mirror exists and before CloudCLI spawns claude. Resolve the
    //     self-invocation first so no persisted command races launcher publication.
    const selfInvocation = await resolveSelfInvocation()
    {
      const warning = hookLauncherDegradedWarning(selfInvocation)
      if (warning) process.stderr.write(`${warning}\n`)
    }
    const enhancements = await provisionServeEnhancements(serverUrl, {
      selfInvocation,
      codexCli: backend === "cli",
      tunnelExposed,
      browseOverTunnel: args["browse-over-tunnel"] === true,
      agentsOverTunnel: args["agents-over-tunnel"] === true,
      fleetOverTunnel: args["fleet-over-tunnel"] === true,
    })

    // 3. filtered child env: the vetted secret-stripping allowlist (buildEnv,
    //    drops GITHUB_TOKEN/GH_ROUTER_*/ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY/
    //    COPILOT_TOKEN) plus the non-secret ANTHROPIC_BASE_URL/CLAUDE_CONFIG_DIR
    //    /model vars. Auth rides the synthetic .credentials.json FILE, not env.
    const anthropicVars = getClaudeCodeEnvVars(
      serverUrl,
      chosenSlug,
      "standard",
      enhancements.pickerModels,
    )
    // CLAUDE_CODE_FORK_SUBAGENT silently no-ops under CloudCLI's headless
    // `claude --print` path (the binary's Z8() precondition disables forking
    // without an interactive session), so setting it here is dead weight that
    // would mislead the model into assuming forked subagents inherit full
    // context. Drop it for serve. (getClaudeCodeEnvVars sets it for the
    // interactive `claude` path, where forking works.)
    delete anthropicVars.CLAUDE_CODE_FORK_SUBAGENT
    if (enhancements.nonce) {
      anthropicVars.GH_ROUTER_HOOK_MCP_URL = serverUrl
      anthropicVars.GH_ROUTER_HOOK_NONCE = enhancements.nonce
    }
    const childEnv: NodeJS.ProcessEnv = composeCloudCliChildEnv(anthropicVars)
    // Placeholder only: CloudCLI's Claude provider checks this env var to mark
    // Claude as connected. Claude still authenticates through the proxy mirror.
    childEnv.ANTHROPIC_API_KEY = "sk-ant-github-router-proxy-placeholder"
    // CloudCLI's cloned server defines CLAUDE_FALLBACK_MODELS as an in-code object,
    // and the searched server tree has no process.env.CLAUDE_FALLBACK_MODELS reader.
    // Do not set an env var here unless CloudCLI adds a documented string format.

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
    let tunnelStop: (() => void) | null = null
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      if (tunnelStop) {
        try {
          tunnelStop()
        } catch {
          /* best-effort */
        }
      }
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
      await stopKeepAwake().catch(() => {})
      await enhancements.cleanup().catch(() => {})
      await removeOwnClaudeConfigMirror().catch(() => {})
    }
    // `shutdown()` must never strand the process. `.then(exit)` alone skips the
    // exit on a REJECTION, so a teardown failure leaves a process that was
    // explicitly trying to die running forever — the worst possible outcome on
    // a shutdown path. `.finally` guarantees the exit either way, and the code
    // is preserved because an operator's script reads it.
    const exitAfterShutdown = (code: number) => {
      void shutdown()
        .catch((err: unknown) => {
          consola.error("Shutdown failed; exiting anyway:", err)
        })
        .finally(() => process.exit(code))
    }
    process.once("SIGINT", () => exitAfterShutdown(0))
    process.once("SIGTERM", () => exitAfterShutdown(0))
    cc.child.once("exit", (code) => {
      if (!shuttingDown) {
        consola.error(`CloudCLI exited unexpectedly (code ${code}).`)
        exitAfterShutdown(1)
      }
    })
    cc.child.once("error", (err) => {
      // spawn failure (ENOENT/EACCES) emits 'error', not 'exit' — an unhandled
      // 'error' crashes the process and bypasses shutdown, orphaning the mirror.
      if (!shuttingDown) {
        consola.error(`CloudCLI failed to start: ${err.message}`)
        exitAfterShutdown(1)
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
    const tunnelMode = args.tunnel === true
    if (extraAllowedHosts.length || tunnelMode) {
      consola.warn(
        "Remote access enabled: anyone who reaches this through the tunnel AND passes its authentication gets FULL control-plane access — including a shell on this machine. The tunnel is authenticated (never anonymous); only grant access to people you fully trust.",
      )
    }

    const servePort = await resolveServePort(parsed.port)
    const providerFacade = {
      kindFor: facadeInterceptKind,
      blockedRequest: facadeBlockedRequest,
      rewrite: (kind: string, json: unknown, query: URLSearchParams) =>
        rewriteProviderResponse(
          kind as Parameters<typeof rewriteProviderResponse>[0],
          json,
          {
            getModels: () => state.models,
            // Resolve to the Copilot catalog slug so it matches the picker
            // OPTIONS values (chosenSlug may be a dashed/`[1m]`-bracketed Anthropic
            // slug; the OPTIONS values are catalog ids). Otherwise DEFAULT misses
            // and falls back to the first option.
            defaultModel: resolveModel(chosenSlug),
            claudeConfigDir: PATHS.CLAUDE_CONFIG_DIR,
          },
          query,
        ),
    }
    let reverse
    try {
      reverse = await startReverseProxy({
        targetHost: "127.0.0.1",
        targetPort: ccPort,
        bindHost: "127.0.0.1",
        bindPort: servePort,
        authToken: token,
        seedToolSettings: process.env.GH_ROUTER_SERVE_NO_AUTO_APPROVE !== "1",
        // Routine built-ins + every injected mcp tool name → auto-approve; the
        // two interaction tools (AskUserQuestion/ExitPlanMode) are excluded so
        // they reach the user (SEAMLESS_BUILTIN_TOOLS never lists them).
        seedAllowedTools: [...SEAMLESS_BUILTIN_TOOLS, ...(enhancements.mcpToolNames ?? [])],
        extraAllowedHosts,
        extraAllowedOrigins,
        allowDevtunnelHosts: tunnelMode,
        providerFacade,
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

    // 8. optionally auto-create + host an AUTHENTICATED dev tunnel for remote
    //    access. Non-fatal: on any failure keep serving locally (and the
    //    *.devtunnels.ms allowlist stays, so a manual `devtunnel host` works).
    let tunnelUrl: string | null = null
    if (tunnelMode) {
      consola.info("Creating an authenticated dev tunnel…")
      try {
        const tunnel = await startDevtunnel(servePort)
        tunnelUrl = tunnel.url
        tunnelStop = tunnel.stop
      } catch (err) {
        const msg = err instanceof DevtunnelError ? err.message : String(err)
        consola.warn(
          `Could not auto-host a dev tunnel: ${msg}\nServing locally only. To host manually once fixed: devtunnel host -p ${servePort}`,
        )
      }
    }

    // 9. ready.
    const publicLines = [
      ...publicUrls.map((u) => `remote: ${u}`),
      ...(tunnelUrl ? [`remote (tunnel): ${tunnelUrl}  (stable — bookmark it; same URL every launch)`] : []),
    ]
    const publicBlock = publicLines.length ? `\n${publicLines.join("\n")}` : ""
    consola.box(
      `🖥️  github-router control plane\n\nlocal:  ${reverse.url}${publicBlock}\n\nsigned in as ${username} · model ${chosenSlug}\nCtrl+C to stop`,
    )
    if (args["no-open"] !== true) openBrowser(reverse.url)
  },
})
