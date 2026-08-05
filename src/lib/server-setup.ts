import * as fs from "node:fs"
import * as nodePath from "node:path"

import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import { createBodyTooLargeError, limitRequestBody } from "srvx/body-limit"

import { PATHS, ensurePaths } from "./paths"
import { maybeSpawnDaemon, wireDaemonTeardown } from "./first-mate/scheduler/autospawn"
import { agentToolsEnabled } from "./mcp-capabilities"
import { withOneMSuffix } from "./one-m-context"
import { generateRandomPort } from "./port"
import { initProxyFromEnv } from "./proxy"
import { state } from "./state"
import { setupCopilotToken, setupGitHubAgentToken, setupGitHubToken } from "./token"
import { toolbeltEnabled } from "./toolbelt"
import { toolbeltPathOverride } from "./toolbelt/path-inject"
import { cacheModels, cacheCopilotVersion, cacheVSCodeVersion } from "./utils"
import { resolveMcpToolTimeoutMs } from "./worker-agent/budget"
import { server as app } from "../server"

const MAX_PORT_RETRIES = 10

/**
 * Maximum request body the proxy will accept, in bytes.
 *
 * Pinned EXPLICITLY because the runtimes disagree by default: bun's `serve`
 * defaults `maxRequestBodySize` to 128 MB and rejects past it, while
 * `node:http` (the srvx node adapter) has no body limit at all. Left
 * unset, the same request succeeds under node and 413s under bun, with
 * nothing in the response explaining that the runtime is the variable.
 * Same class of defect as the `idleTimeout` divergence below.
 *
 * Note which side that leaves exposed: `dist/main.js` ships
 * `#!/usr/bin/env node`, so npm-installed users are on the runtime with NO
 * limit, and bun is mostly the dev/`bun run start` path. The uncapped case
 * was the shipped one.
 *
 * 128 MB — i.e. bun's default, adopted as the intended value on BOTH
 * runtimes rather than inherited on one:
 *
 * - It sits above the traffic this proxy is built for, with margin. A
 *   full 1M-token Claude Code context is on the order of 4-5 MB of JSON
 *   text; base64 inline images inflate 4/3 and are re-sent every turn, so
 *   an image-heavy session runs to tens of MB. That is an estimate, not a
 *   measurement, which is part of why the cap is set well clear of it
 *   rather than snugly above it.
 * - Removing the limit to "match node" is not free even on loopback. The
 *   app mounts permissive `cors()`, so any web page the user visits can
 *   POST to 127.0.0.1:<port> (CORS gates reading the response, not sending
 *   the request); so can any local process. An unbounded body lets either
 *   stream the proxy to death.
 * - Raising it above 128 MB buys nothing and costs safety: the proxy
 *   BUFFERS the whole body (`c.req.json()`), parses it into a JS object
 *   (multiples of the text size in heap), then re-serializes it upstream.
 *   Past ~512 MB V8's max string length makes `JSON.stringify` fail
 *   opaquely — a cap well under that keeps the failure explainable.
 *
 * A body over this ceiling means something is wrong (runaway loop,
 * corrupted context), not a workload that needs a bigger buffer, so
 * there is deliberately no env override to raise it.
 */
export const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024

/**
 * Where the RUNTIME's own body check sits. Not the policy.
 *
 * The policy is `MAX_REQUEST_BODY_BYTES`, enforced by `withBodyLimit` in
 * this process, identically on every runtime. This value exists only to
 * displace the 128 MB default bun's `serve` applies, which would otherwise pre-empt
 * that gate — bun enforces its limit at header-parse time by replying and
 * closing while the client is still uploading, so a client that has not
 * finished writing never reads the reply. Measured with a real client
 * posting 64 MB over a limit: `The socket connection was closed
 * unexpectedly`, i.e. exactly the opaque failure this change removes, and
 * exactly what bun does TODAY at its default. An early response from our
 * own handler, by contrast, is delivered cleanly (413 with the JSON body,
 * ~50ms, no memory growth; draining the body first was strictly worse at
 * 155ms and +50 MB, so we do not drain).
 *
 * Set as ONE top-level srvx option, so bun and node get the same number.
 * A bun-only override would put the two runtimes back on different
 * thresholds, which is the defect being fixed, not a fix for it.
 *
 * Deliberately far above the policy so the policy always decides first:
 * everything a client can realistically send is answered by the explained
 * 413, and this is reached only by a body that is both undeclared and
 * absurd. It stays finite so "no limit at all" is never the state. It
 * bounds nothing the gate does not already bound — an unread body is
 * discarded by both runtimes rather than buffered — so a high value costs
 * no memory, and buys message quality across the whole realistic range.
 */
const TRANSPORT_BODY_CEILING_BYTES = 1024 * 1024 * 1024

/**
 * The 413 the user sees when a request body is over the ceiling.
 *
 * Anthropic error envelope (`request_too_large` is Anthropic's own 413
 * category), so a client that parses our error shape on every other path
 * parses this one too, and the message says what to actually do about it.
 *
 * `declaredBytes` is present only when the request declared a length. A
 * body caught mid-stream has no known size, and saying so beats inventing
 * one. Byte counts are exact, with the MB figure only as a gloss:
 * rounding alone reads as a contradiction at the boundary, where a body
 * one byte over renders as "128.0 MB, over the 128.0 MB limit".
 */
function bodyTooLargeResponse(declaredBytes?: number): Response {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
  const actual =
    declaredBytes === undefined ?
      `Request body exceeds the size github-router accepts`
    : `Request body is ${declaredBytes} bytes (${mb(declaredBytes)}), over `
      + `the size github-router accepts`
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "request_too_large",
        message:
          `${actual}: at most ${MAX_REQUEST_BODY_BYTES} bytes `
          + `(${mb(MAX_REQUEST_BODY_BYTES)}), the same limit under bun and node. `
          + `This is usually an accumulated conversation or inline images `
          + `(base64 attachments are re-sent every turn) rather than one large `
          + `message — start a new session or drop the attachments.`,
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  )
}

/** srvx's canonical over-limit error, however it reaches us. */
function isBodyTooLarge(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "ERR_BODY_TOO_LARGE"
  )
}

/**
 * Enforce `MAX_REQUEST_BODY_BYTES` in-process, so the limit and the
 * rejection are the same on every runtime.
 *
 * Leaving it to the runtimes is what produced the divergence in the first
 * place, and their rejections are not interchangeable:
 *
 * - bun rejects at header-parse time and closes the connection while the
 *   client is still uploading, so the client sees a dead socket rather
 *   than the 413 (measured; see `TRANSPORT_BODY_CEILING_BYTES`).
 * - node lets the handler run and rejects the body READ with an
 *   `ERR_BODY_TOO_LARGE` error. The app installs no Hono `onError`, so
 *   that becomes `500 Internal Server Error` — indistinguishable from a
 *   real proxy fault.
 *
 * Two layers, one threshold, applied uniformly:
 *
 * 1. A declared `Content-Length` over the limit is answered before the
 *    body is read at all. This is the path every real client takes
 *    (Claude Code / undici / curl all declare a length on a JSON body).
 * 2. Anything else — chunked, or a length that understates the body — is
 *    caught mid-stream by srvx's own `limitRequestBody`, the same helper
 *    its node and deno adapters use. Overflow is surfaced as the SAME
 *    explained 413 rather than leaking out as a 500.
 *
 * So a body that declares no length is no longer a hole in the message
 * quality OR in the bound, and neither depends on which runtime is
 * serving. Verified end to end against both adapters with a real client:
 * declared-over and chunked-over each return an identical 413.
 */
export function withBodyLimit(fetchHandler: ServerHandler): ServerHandler {
  return async (request) => {
    const declared = request.headers.get("content-length")
    // Only a plain integer is trusted as a declared length. Anything else
    // (absent, chunked, a comma-joined duplicate) is not guessed at — it
    // just falls through to layer 2, which enforces the same threshold.
    if (declared !== null && /^\d+$/.test(declared)) {
      const bytes = Number(declared)
      if (bytes > MAX_REQUEST_BODY_BYTES) return bodyTooLargeResponse(bytes)
    }

    // `overflowed` is per-request state closed over by this one call, so
    // concurrent requests cannot see each other's flag.
    let overflowed = false
    const limited = limitRequestBody(request, MAX_REQUEST_BODY_BYTES, {
      createError: (max) => {
        overflowed = true
        return createBodyTooLargeError(max)
      },
    })

    try {
      const response = await fetchHandler(limited)
      // The flag is only ever set by a body read that failed, so the
      // handler cannot have produced a meaningful response; replacing it
      // is what stops the overflow surfacing as Hono's generic 500. A
      // route that never reads the body never trips this. Cancel what we
      // discard so a handler that did return a stream can't dangle.
      if (overflowed) {
        void response.body?.cancel().catch(() => {})
        return bodyTooLargeResponse()
      }
      return response
    } catch (error) {
      // Belt and braces for an overflow that propagates instead of being
      // caught by the framework.
      if (overflowed || isBodyTooLarge(error)) return bodyTooLargeResponse()
      throw error
    }
  }
}

export interface ServerSetupOptions {
  port?: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
  extendedBetas: boolean
  browseEnabled: boolean
  fleetEnabled: boolean
  agentsEnabled: boolean
  powerBrowseEnabled: boolean
  humanlikeEnabled: boolean
  silent: boolean
}

/**
 * Build the srvx `serve()` options shared by the explicit-port and
 * random-port paths.
 *
 * Extracted and exported so the per-runtime overrides below are
 * assertable. `setupAndServe` itself performs auth and network I/O, so the
 * only way to pin this behaviour in a test is to make the options object
 * reachable on its own — and it needs pinning, because deleting either
 * override reintroduces a failure that looks like an upstream/network
 * problem rather than a config one.
 */
export function buildServeOptions(
  fetchHandler: ServerHandler,
  silent: boolean,
): {
  fetch: ServerHandler
  hostname: string
  silent: boolean
  maxRequestBodySize: number
  bun: { idleTimeout: number }
} {
  return {
    fetch: withBodyLimit(fetchHandler),
    hostname: "127.0.0.1",
    silent,
    // Pin the transport ceiling instead of inheriting one runtime's
    // default. Unset, srvx forwards nothing: bun applies its own 128 MB
    // default and node applies none, so the identical request 413s or
    // succeeds purely on which runtime is serving, with no signal to the
    // user that the runtime was the variable.
    //
    // TOP-LEVEL on purpose, not in the `bun` namespace: srvx's top-level
    // option reaches every adapter, so both runtimes get the same number.
    // A bun-only override would leave the two on different thresholds,
    // which is the defect, not a fix for it.
    //
    // This is the outer bound, NOT the policy — `withBodyLimit` above
    // enforces MAX_REQUEST_BODY_BYTES in-process, identically everywhere,
    // and answers first. See TRANSPORT_BODY_CEILING_BYTES for why it sits
    // so far above, and MAX_REQUEST_BODY_BYTES for why the proxy caps at
    // all rather than matching node's absence of a limit.
    maxRequestBodySize: TRANSPORT_BODY_CEILING_BYTES,
    // Bun-only: disable `Bun.serve`'s per-connection idle reaper.
    //
    // Bun defaults `idleTimeout` to 10 seconds and applies it to a
    // STREAMING response: if no bytes reach the socket for ~10s while a
    // ReadableStream body is open, Bun kills the connection. Node's
    // `node:http` (the srvx node adapter) has no equivalent default
    // (`server.timeout === 0`), which is why this only ever bit users
    // running the proxy under bun.
    //
    // Upstream Copilot routinely goes quiet for longer than that
    // mid-stream — extended thinking and prompt processing on a large
    // accumulated context both produce >10s SSE gaps. The client (undici)
    // surfaces the kill as `UND_ERR_SOCKET other side closed`, which
    // Claude Code reports as `Unable to connect to API (ECONNRESET)`.
    // Because the retry replays the same large context, every retry
    // reproduces the same gap and the whole 10-attempt backoff burns down.
    // Reproduced end-to-end: headers + first byte at +12.7s, socket killed
    // at +24.0s (an 11.3s mid-stream gap); the identical request through
    // the node adapter completes.
    //
    // Disabled rather than raised to Bun's 255s maximum: the proxy already
    // owns upstream-stall detection via UPSTREAM_INACTIVITY_TIMEOUT_MS
    // (`relayAnthropicStream`, default 5 min), and a 255s socket reaper
    // would fire BEFORE that guard and reintroduce this same bug at a
    // longer horizon. One authority for stream liveness, and it is ours.
    //
    // Namespaced under `bun`, so the node adapter ignores it. Note that
    // the body ceiling above is deliberately NOT namespaced here — a
    // per-runtime body limit is the bug, not the fix.
    bun: { idleTimeout: 0 },
  }
}

export async function setupAndServe(
  options: ServerSetupOptions,
): Promise<{ server: ReturnType<typeof serve>; serverUrl: string }> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.extendedBetas = options.extendedBetas
  // --browse + GH_ROUTER_ENABLE_BROWSE=1 are equivalent; either enables
  // the browser-control MCP tools. The env-var path is the convenience
  // for users who don't want to retype the flag every session, mirroring
  // the GH_ROUTER_DISABLE_WORKER_TOOLS / GH_ROUTER_LOG_PEER_MCP convention.
  state.browseEnabled =
    options.browseEnabled || process.env.GH_ROUTER_ENABLE_BROWSE === "1"
  state.fleetEnabled =
    options.fleetEnabled || process.env.GH_ROUTER_ENABLE_FLEET === "1"
  // --agents + GH_ROUTER_ENABLE_AGENTS=1 enable the first-mate
  // cloud-agent orchestration surface (the write-token GitHub layer +
  // the `mcp__first-mate__*` tools). The tools additionally require the
  // write token to be present (see `agentToolsEnabled()`), so the flag
  // alone doesn't expose an unauthenticated surface.
  state.agentsEnabled =
    options.agentsEnabled || process.env.GH_ROUTER_ENABLE_AGENTS === "1"
  // --power-browse implies --browse: power mode exposes the FULL
  // browser tool surface (read_page, mouse, drag, scroll, keyboard,
  // type, eval_js, diagnostics, find, locate) on top of the lead
  // surface. There is no "power without basic" state, so enabling
  // power forces basic on too.
  state.powerBrowseEnabled =
    options.powerBrowseEnabled || process.env.GH_ROUTER_ENABLE_POWER_BROWSE === "1"
  if (state.powerBrowseEnabled) state.browseEnabled = true
  // Humanlike pacing override. GH_ROUTER_BROWSER_NO_HUMANLIKE=1 wins
  // over every other signal so test runs stay deterministic.
  if (process.env.GH_ROUTER_BROWSER_NO_HUMANLIKE === "1") {
    state.humanlikeForce = "off"
  } else if (options.humanlikeEnabled || process.env.GH_ROUTER_HUMANLIKE === "1") {
    state.humanlikeForce = "on"
  } else {
    state.humanlikeForce = "auto"
  }

  if (process.env.COPILOT_API_URL) {
    state.copilotApiUrl = process.env.COPILOT_API_URL
  }

  await ensurePaths()
  // The two editor-identity lookups are independent of each other and of the
  // token chain below, so they overlap. Both are cached with a 12h TTL
  // (`editor-version-cache.ts`), so on the common path neither touches the
  // network at all and this only bounds the cold case.
  //
  // `ensurePaths()` deliberately stays a prerequisite rather than joining the
  // batch: it is the FS init these writes land in, and folding it in would
  // let network work proceed past a filesystem failure.
  await Promise.all([cacheVSCodeVersion(), cacheCopilotVersion()])

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  // First-mate agent orchestration needs a second, write-capable GitHub
  // token (repo/workflow/read:org via the GitHub CLI OAuth client). Only
  // when opted in via --agents / GH_ROUTER_ENABLE_AGENTS. A failure here
  // is fatal to the opted-in surface (the tools won't work without it)
  // but must not break plain proxy operation — so it's gated on the flag.
  if (state.agentsEnabled) {
    await setupGitHubAgentToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.debug(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serveOptions = buildServeOptions(
    app.fetch as ServerHandler,
    options.silent,
  )

  let srvxServer: ReturnType<typeof serve> | undefined

  if (options.port !== undefined) {
    // Explicit port — no retry
    srvxServer = serve({ ...serveOptions, port: options.port })
  } else {
    // Random available port with retry
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
      const candidatePort = generateRandomPort()
      try {
        srvxServer = serve({ ...serveOptions, port: candidatePort })
        break
      } catch (error) {
        lastError = error
        const isAddrInUse =
          error instanceof Error
          && (error.message.includes("EADDRINUSE")
            || error.message.includes("address already in use")
            || ("code" in error
              && (error as NodeJS.ErrnoException).code === "EADDRINUSE"))
        if (!isAddrInUse) throw error
        consola.debug(`Port ${candidatePort} in use, trying another...`)
      }
    }

    if (srvxServer === undefined) {
      throw new Error(
        `Failed to find an available port after ${MAX_PORT_RETRIES} attempts. `
        + `Specify a port with --port or free some ports. Last error: ${lastError}`,
      )
    }
  }

  // Wait for the server to be listening before reading the URL
  await srvxServer.ready()
  const url = srvxServer.url
  if (!url) {
    throw new Error("Server started but URL is not available")
  }
  const serverUrl = url.replace(/\/$/, "")

  // Opt-in (GH_ROUTER_FM_DAEMON=1; default OFF) auto-spawn of the first-mate
  // scheduler daemon as a SEPARATE process. The [fm-heartbeat] cron is the
  // default driver; this is experimental. Never throws. The returned handle is
  // wired to shutdown so a drive-primary daemon can never orphan and keep
  // merging PRs after the proxy exits (Windows has no process-group reaping).
  // Teardown EOFs the child's stdin first (graceful lease/pidfile release — the
  // only graceful path on Windows), then hard-kills as a non-blocking backstop.
  try {
    const handle = maybeSpawnDaemon({ agentsEnabled: agentToolsEnabled() })
    if (handle) {
      wireDaemonTeardown(handle)
      consola.debug(`first-mate daemon spawn attempted (pid ${handle.pid ?? "?"}).`)
    }
  } catch (err) {
    consola.debug("first-mate daemon auto-spawn skipped:", err)
  }

  return { server: srvxServer, serverUrl }
}

/** Shared CLI arg definitions for all server commands. */
export const sharedServerArgs = {
  port: {
    alias: "p",
    type: "string" as const,
    description: "Port to listen on",
  },
  verbose: {
    alias: "v",
    type: "boolean" as const,
    default: false,
    description: "Enable verbose logging",
  },
  "account-type": {
    alias: "a",
    type: "string" as const,
    default: "enterprise",
    description: "Account type to use (individual, business, enterprise)",
  },
  manual: {
    type: "boolean" as const,
    default: false,
    description: "Enable manual request approval",
  },
  "rate-limit": {
    alias: "r",
    type: "string" as const,
    description: "Rate limit in seconds between requests",
  },
  wait: {
    alias: "w",
    type: "boolean" as const,
    default: false,
    description:
      "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
  },
  "github-token": {
    alias: "g",
    type: "string" as const,
    description:
      "Provide GitHub token directly (must be generated using the `auth` subcommand)",
  },
  "show-token": {
    type: "boolean" as const,
    default: false,
    description: "Show GitHub and Copilot tokens on fetch and refresh",
  },
  "proxy-env": {
    type: "boolean" as const,
    default: false,
    description: "Initialize proxy from environment variables",
  },
  "extended-betas": {
    type: "boolean" as const,
    default: false,
    description:
      "Forward extended beta headers for Claude CLI compatibility (default: VS Code-only)",
  },
  browse: {
    type: "boolean" as const,
    default: false,
    description:
      "Enable the browser-control MCP tools (browser_open_tab, browser_screenshot, browser_click, etc.) on /mcp. Requires Chrome or Edge installed; the bundled extension must be loaded on first tool call (the proxy returns install_required with a Load Unpacked path and the expected extension ID). Off by default; can also be enabled with GH_ROUTER_ENABLE_BROWSE=1.",
  },
  fleet: {
    type: "boolean" as const,
    default: false,
    description:
      "Enable the fleet session-control MCP tools (mcp__fleet__*) on /mcp for driving sessions across remote ai-or-die instances over their tunnels. Off by default; also enabled with GH_ROUTER_ENABLE_FLEET=1.",
  },
  agents: {
    type: "boolean" as const,
    default: false,
    description:
      "Enable the first-mate cloud-agent orchestration surface (mcp__first-mate__*): a durable controller that drives GitHub cloud coding agents (Copilot/Anthropic/OpenAI) across research/plan/implement/test/merge. Triggers a second GitHub device-login for a write-capable token (repo, workflow, read:org). Off by default; also enabled with GH_ROUTER_ENABLE_AGENTS=1.",
  },
  "power-browse": {
    type: "boolean" as const,
    default: false,
    description:
      "Expose the full ~18-tool browser MCP surface (raw read_page, mouse / drag / scroll / keyboard / type primitives, eval_js, diagnostics, find, locate). Default --browse exposes only the 6 lead-model tools (act, observe, extract, navigate, screenshot, open_tab) that hide DOM details behind intent. Implies --browse. Off by default; can also be enabled with GH_ROUTER_ENABLE_POWER_BROWSE=1.",
  },
  humanlike: {
    type: "boolean" as const,
    default: false,
    description:
      "Force humanlike pacing on ALL browser tool dispatches: Beta-distributed inter-action delays (800-4600 ms), Bezier mouse trajectories with overshoot-and-correct, per-keystroke jitter with word-end pauses, scroll chunking. Use for known anti-bot sites (Cloudflare, Datadome). Off by default (auto mode); GH_ROUTER_HUMANLIKE=1 is the env equivalent. GH_ROUTER_BROWSER_NO_HUMANLIKE=1 hard-disables (wins over --humanlike, for tests).",
  },
  "self-update": {
    type: "boolean" as const,
    default: true,
    description:
      "Update github-router itself to the latest npm version on launch (throttled once/hour). Best-effort and non-blocking: the proxy serves immediately and a detached updater applies the new version after this process exits (it takes effect on the NEXT launch; the running process keeps its current build). Disable with --no-self-update or GH_ROUTER_NO_SELF_UPDATE=1. Skipped silently if npm/network unavailable.",
  },
} as const

const allowedAccountTypes = new Set(["individual", "business", "enterprise"])

/** Parse shared server args into ServerSetupOptions fields. */
export function parseSharedArgs(args: Record<string, unknown>): {
  port?: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
  extendedBetas: boolean
  browseEnabled: boolean
  fleetEnabled: boolean
  agentsEnabled: boolean
  powerBrowseEnabled: boolean
  humanlikeEnabled: boolean
} {
  const portRaw = args.port as string | undefined
  let port: number | undefined
  if (portRaw !== undefined) {
    port = Number.parseInt(portRaw, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error("Invalid port. Must be between 1 and 65535.")
    }
  }

  const accountType = (args["account-type"] as string) ?? "enterprise"
  if (!allowedAccountTypes.has(accountType)) {
    throw new Error(
      "Invalid account type. Must be individual, business, or enterprise.",
    )
  }

  const rateLimitRaw = args["rate-limit"] as string | undefined
  let rateLimit: number | undefined
  if (rateLimitRaw !== undefined) {
    rateLimit = Number.parseInt(rateLimitRaw, 10)
    if (Number.isNaN(rateLimit) || rateLimit <= 0) {
      throw new Error("Invalid rate limit. Must be a positive integer.")
    }
  }

  const rateLimitWait = (args.wait as boolean) && rateLimit !== undefined
  if ((args.wait as boolean) && rateLimit === undefined) {
    consola.warn("Rate limit wait ignored because no rate limit was set.")
  }

  const githubToken =
    (args["github-token"] as string | undefined) ?? process.env.GH_TOKEN

  return {
    port,
    verbose: args.verbose as boolean,
    accountType,
    manual: args.manual as boolean,
    rateLimit,
    rateLimitWait,
    githubToken,
    showToken: args["show-token"] as boolean,
    proxyEnv: args["proxy-env"] as boolean,
    extendedBetas: args["extended-betas"] as boolean,
    browseEnabled: args.browse as boolean,
    fleetEnabled: args.fleet as boolean,
    agentsEnabled: args.agents as boolean,
    powerBrowseEnabled: args["power-browse"] as boolean,
    humanlikeEnabled: args.humanlike as boolean,
  }
}

/**
 * Non-Claude models we surface as first-class, selectable rows in Claude
 * Code's model picker (Phase 3 of native-non-claude-models). The main
 * agent loop runs on them through the `/v1/messages` translation shim
 * (`src/lib/anthropic-translate/*`, branched in `routes/messages/handler.ts`)
 * that forwards non-Claude targets to Copilot `/responses` (gpt) or
 * `/chat/completions` (gemini). The exact gemini id is
 * `gemini-3.1-pro-preview` (preview slug — NOT `gemini-3.1-pro`).
 *
 * Display labels only: the gateway-model cache schema Claude Code reads is
 * `{id, display_name?}` per model — there is NO per-model context-window
 * field. Context accounting is instead driven off the id itself, via the
 * `[1m]` literal-bracket suffix `nativeSelectableModelsInCatalog` attaches to
 * every row the catalog says serves >=1M. See `withOneMSuffix`.
 */
const NATIVE_NON_CLAUDE_MODELS: ReadonlyArray<{
  id: string
  displayName: string
}> = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (preview)" },
]

/**
 * The subset of `NATIVE_NON_CLAUDE_MODELS` actually present in the live
 * Copilot catalog. License tiers differ (gpt-5.5 needs
 * pro_plus/business/enterprise/max; gemini-3.5-flash is absent on
 * edu/individual_trial), so a model missing from the catalog is silently
 * dropped — the caller then neither enables discovery nor writes a cache
 * for it, and lesser tiers see the unchanged picker. Pure (reads
 * `state.models`), so it is unit-testable without side effects.
 *
 * The projected id carries a `[1m]` suffix when the catalog advertises a
 * >=1M window for it, because Claude Code budgets a gateway-discovered row
 * at its 200K default otherwise — `gpt-5.6-sol` (1,050,000) would compact at
 * roughly a fifth of its real window. `withOneMSuffix` is catalog-gated, so
 * `gpt-5.3-codex` (400K) stays bare and keeps the conservative accounting;
 * over-budgeting it would trade premature compaction for a hard overflow.
 * The lookup below still keys off the BARE id — the decoration is applied
 * only to the value handed to Claude Code.
 */
export function nativeSelectableModelsInCatalog(): Array<{
  id: string
  display_name: string
}> {
  const catalog = state.models?.data
  if (!catalog || catalog.length === 0) return []
  const present = new Set(catalog.map((m) => m.id))
  return NATIVE_NON_CLAUDE_MODELS.filter((m) => present.has(m.id)).map((m) => ({
    id: withOneMSuffix(m.id),
    display_name: m.displayName,
  }))
}

/**
 * Pre-seed Claude Code's gateway-model discovery cache so the non-Claude
 * models appear as selectable picker rows WITHOUT the network fetch.
 *
 * Verified against the installed Claude Code build (2.1.201): the picker
 * builder reads `<CLAUDE_CONFIG_DIR>/cache/gateway-models.json`
 * (schema `{baseUrl: string, fetchedAt: number, models: [{id, display_name?}]}`)
 * and — when gateway discovery is enabled (first-party auth mode +
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` set + a non-`api.anthropic.com`
 * `ANTHROPIC_BASE_URL`, all true for the proxy) — maps each cached model to
 * a picker row `{value: id, label: display_name}`. Critically, the
 * cache-READ path applies NO id filter; the `/^(claude|anthropic)/i` filter
 * lives ONLY in the network-FETCH path. So a pre-seeded cache can carry the
 * real Copilot ids (`gpt-5.5`, `gemini-3.1-pro-preview`, …) — no `claude-*`
 * alias needed — and selecting a row sends that real id, which
 * `resolveModel()` exact-matches and the `/v1/messages` shim routes.
 *
 * The network fetch never overwrites this seed: it bails when nonessential
 * traffic is disabled, and the proxy ALWAYS sets
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the fetch returns before
 * it can write. The seed is therefore authoritative for the session.
 *
 * `baseUrl` MUST equal the `ANTHROPIC_BASE_URL` Claude Code sees
 * (`serverUrl`) or the cache is discarded. `configDir` defaults to
 * `PATHS.CLAUDE_CONFIG_DIR` — the same dir the proxy points
 * `CLAUDE_CONFIG_DIR` at — so the write target and Claude Code's read
 * target are identical by construction.
 *
 * Best-effort: every failure is swallowed — a missing picker row must never
 * break launch. This is coupled to Claude Code's internal cache path/schema;
 * if a future build changes them the read simply ignores the seed and the
 * rows don't appear (graceful degradation). Returns whether a file was
 * written (for tests/observability).
 *
 * The write is atomic (temp file in the same dir + rename) so a Claude Code
 * read can never observe a torn/partial JSON (which its safeParse would
 * reject, dropping the rows). Rename-over-existing is atomic on POSIX and
 * Windows (libuv MoveFileEx REPLACE_EXISTING).
 */
export function seedGatewayModelCache(
  serverUrl: string,
  models: ReadonlyArray<{ id: string; display_name: string }>,
  configDir: string = PATHS.CLAUDE_CONFIG_DIR,
): boolean {
  if (models.length === 0) return false
  const cacheDir = nodePath.join(configDir, "cache")
  const target = nodePath.join(cacheDir, "gateway-models.json")
  const tmp = nodePath.join(
    cacheDir,
    `gateway-models.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const payload = {
      baseUrl: serverUrl,
      fetchedAt: Date.now(),
      models: models.map((m) => ({ id: m.id, display_name: m.display_name })),
    }
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf-8")
    fs.renameSync(tmp, target)
    return true
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    return false
  }
}

/**
 * Remove any seeded gateway-model cache. Called when the current catalog
 * carries none of the target models, so a user who has pinned
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` on cannot surface rows for
 * models that are no longer available. Best-effort (per-launch config dirs
 * make a stale file rare, but this closes the pinned-port + catalog-change
 * seam). Never throws.
 */
export function clearGatewayModelCache(
  configDir: string = PATHS.CLAUDE_CONFIG_DIR,
): void {
  try {
    fs.rmSync(nodePath.join(configDir, "cache", "gateway-models.json"), {
      force: true,
    })
  } catch {
    /* best-effort */
  }
}

/**
 * Build environment variables for Claude Code.
 *
 * The parent env is sanitized of every key in `STRIPPED_PARENT_ENV_KEYS`
 * (see `src/lib/launch.ts`) BEFORE these overrides are merged in, so we
 * only need to provide the positive values.
 *
 * Auth precedence in Claude Code (https://code.claude.com/docs/en/iam),
 * after the github-router substrate fix:
 *   1. Cloud provider (CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY) — stripped at parent.
 *   2. ANTHROPIC_AUTH_TOKEN — NOT set by the proxy. Stripped at parent
 *      (no env-source auth in the spawned child at all).
 *   3. ANTHROPIC_API_KEY — stripped at parent.
 *   4. apiKeyHelper in settings.json — copied into our config dir as
 *      part of the mirror; if the user defined one, it still fires
 *      and may mint an `x-api-key` header. Copilot ignores `x-api-key`,
 *      so behavior is unchanged from before this fix.
 *   5. CLAUDE_CODE_OAUTH_TOKEN — stripped at parent.
 *   6. Subscription OAuth (Keychain / `<CLAUDE_CONFIG_DIR>/.credentials.json`)
 *      — the credentials file is OURS (synthetic blob, written by
 *      `ensureClaudeConfigMirror`). Claude Code reads accessToken from
 *      it and sends as `Authorization: Bearer <accessToken>`. The
 *      teammate-spawn allowlist propagates `CLAUDE_CONFIG_DIR` to
 *      children, so spawned teammates find the same synthetic credential
 *      and authenticate (the bug this whole fix addresses).
 *
 * `CLAUDE_CONFIG_DIR` activates Claude Code's per-config-dir keychain
 * isolation (per binary-grep of v2.1.126's `iN()` function: when set,
 * the keychain service name becomes `Claude Code-<sha256(path)[0..8]>`,
 * missing the user's real `Claude Code` entry). Pointing it at our
 * snapshot-copied `PATHS.CLAUDE_CONFIG_DIR` preserves user customization
 * (mirrored settings.json, skills, MCP, hooks, CLAUDE.md, custom
 * agents) while giving teammates a credential they can find on disk.
 *
 * No-401 invariant: Claude Code's reactive refresh path (`SZ1` →
 * `D3(0,true,...)`) fires on any 401 from upstream. The synthetic
 * refreshToken would fail any real refresh attempt, so the proxy
 * MUST NOT return 401 on the Anthropic-shape boundary even when
 * upstream Copilot returns 401. See `src/routes/messages/handler.ts`.
 */
export function getClaudeCodeEnvVars(
  serverUrl: string,
  model?: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    // Route to the proxy
    ANTHROPIC_BASE_URL: serverUrl,
    // CLAUDE_CONFIG_DIR points at the router-owned snapshot mirror;
    // the synthetic .credentials.json inside it provides the OAuth
    // accessToken that Claude Code sends as Bearer. See
    // `ensureClaudeConfigMirror` in `src/lib/paths.ts`.
    CLAUDE_CONFIG_DIR: PATHS.CLAUDE_CONFIG_DIR,
    // Suppress non-essential telemetry/model calls. The first two are
    // Anthropic's own knobs (per cc-backup managedEnv.ts); the third
    // (`DISABLE_TELEMETRY`) suppresses Datadog/Statsig/etc. external
    // analytics that would otherwise run regardless of the proxy. None of
    // these calls reach the proxy (they hit external hosts), but they
    // consume user resources and may leak metadata. Setting all three
    // turns the spawned child into a quiet local-only session.
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  }
  if (model) vars.ANTHROPIC_MODEL = model

  // Extend Claude Code's MCP per-tool-call wait window. Two distinct
  // env vars are at play (per binary inspection of v2.1.141 by the
  // peer-MCP team's empirical SDK test, 2026-05-14):
  //
  //   - MCP_TIMEOUT — historical/general MCP timeout, may apply to
  //     server-startup or initial-handshake but NOT confirmed to reach
  //     the per-tool-call HTTP wait on v2.1.138-141 (regressions
  //     #50289 / #52137 documented this as silently-ignored on the
  //     per-call path). Kept as belt-and-suspenders.
  //
  //   - MCP_TOOL_TIMEOUT — the load-bearing one. v2.1.141's `y13()`
  //     reads `parseInt(process.env.MCP_TOOL_TIMEOUT)` for the per-
  //     tool-call timeout passed to MCP SDK's `.callTool({...},
  //     schema, {timeout: W})`. Default `1e8` ms (~27.7 hours) when
  //     the env is unset. Set to 6h15m (`resolveMcpToolTimeoutMs()`,
  //     override `GH_ROUTER_MCP_TOOL_TIMEOUT_MS`): finite-but-large
  //     (surfaces regressions where the SDK silently caps at 60s, AND
  //     bounds runaway calls) but high enough that an autonomous worker
  //     can do up to its 6h wall-clock of real work AND still return its
  //     result before the harness gives up. INVARIANT: the worker
  //     wall-clock (default 6h, per-call overridable) is clamped to
  //     `workerWallClockCeilingMs()` = this timeout − 15 min teardown
  //     headroom (`MCP_TIMEOUT_HEADROOM_MS`), so a slow/runaway worker
  //     aborts gracefully (partial work + `[halted: wallclock]`) a full
  //     headroom before the harness hard-kills it — 6h worker < 6h15m
  //     ceiling. Both live in `worker-agent/budget.ts` (single source of
  //     truth) so the two numbers can never drift apart.
  //
  // Without the SDK's `resetTimeoutOnProgress` opt-in (which Claude
  // Code does not pass), SSE notifications/progress events DO NOT
  // reset the per-call timer — they only fire UI callbacks. So
  // MCP_TOOL_TIMEOUT is the actual lever for long-running peer-MCP
  // calls, not the SSE response transport. SSE remains valuable as
  // the canonical Streamable HTTP shape and for progress UI, but the
  // ceiling-busting work is done by these env vars.
  //
  // Presence-based guard (symmetric with ANTHROPIC_SMALL_FAST_MODEL /
  // the tier-default / experimental-enables guards below): if the parent
  // env already set either key, preserve the user's value — only inject
  // our default when unset. Neither key is in `STRIPPED_PARENT_ENV_KEYS`,
  // so an unset override lets the parent value flow through naturally.
  const mcpToolTimeoutMs = String(resolveMcpToolTimeoutMs())
  if (process.env.MCP_TIMEOUT === undefined) vars.MCP_TIMEOUT = mcpToolTimeoutMs
  if (process.env.MCP_TOOL_TIMEOUT === undefined) {
    vars.MCP_TOOL_TIMEOUT = mcpToolTimeoutMs
  }

  // Default the small/fast tier model (used by Claude Code for status
  // text, auto-compact summaries, session titles, background ops) to
  // claude-sonnet-5. Anthropic-published dashed slug that is also the
  // Copilot catalog id verbatim (no dotted variant), so resolveModel
  // resolves it via an exact catalog match at request time.
  // We deliberately pass Sonnet rather than Haiku here: on the canonical
  // Copilot-Enterprise deployment the quality lift on background ops
  // (compaction summaries, session titles) is worth more than Haiku's
  // marginal latency/cost edge, and Copilot bills per-request by
  // multiplier rather than per-token. Sonnet 5 is both the newest Sonnet
  // and cheaper than Sonnet 4.6 per the live catalog (input/output
  // multipliers 200/1000 vs 300/1500), so it strictly dominates the
  // prior default for this tier. The /model picker's Haiku tier row
  // (ANTHROPIC_DEFAULT_HAIKU_MODEL below) is likewise seeded to
  // claude-sonnet-5 so the cheap-tier pick also lands on Sonnet 5.
  // Presence-based guard preserves any user-set value, including the
  // dated slug variant or a different family (gemini, gpt) for users
  // who have custom Copilot mappings — symmetric with the
  // ANTHROPIC_SMALL_FAST_MODEL pass-through documented in launch.ts's
  // STRIPPED_PARENT_ENV_KEYS comment.
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL === undefined) {
    vars.ANTHROPIC_SMALL_FAST_MODEL = "claude-sonnet-5"
  }

  // Tier-default knobs read by Claude Code's /model picker (cc-backup
  // src/utils/model/modelOptions.ts:78,109,167) when the user invokes
  // the picker to switch model. Without these, the picker shows
  // Anthropic's catalog-baseline entries (which may be stale relative
  // to what Copilot has). Setting them seeds the three tier rows with
  // ids the proxy's resolveModel knows how to route.
  //
  // Why NO [1m] suffix on the Sonnet/Haiku tier rows: the picker-row tier
  // defaults are always the bare slug — the [1m] decoration for the
  // *active* default lives on ANTHROPIC_MODEL itself (see pickClaudeDefault
  // in src/lib/port.ts) and is cap-aware against the live catalog via the
  // dual-signal detector (sibling-slug regex OR base-slug
  // max_context_window_tokens). Seeding a bracketed slug here would bypass
  // that cap-awareness and risk a request Copilot 400s (unrecognized
  // bracket) or local over-accounting of context. Note both the Sonnet and
  // Haiku tier rows are seeded to claude-sonnet-5 (the Haiku row is NOT a
  // haiku slug) to match the ANTHROPIC_SMALL_FAST_MODEL default above — the
  // Sonnet/cheap-tier picks land on Sonnet 5, which is newer and cheaper than
  // the prior Sonnet-4.6 / Haiku-4.5 defaults.
  //
  // Presence-based guard symmetric with the SMALL_FAST_MODEL guard
  // above — preserves any value (including 0/false/off/unrecognized)
  // the user has explicitly set.
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined) {
    vars.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-5"
  }
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === undefined) {
    vars.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-sonnet-5"
  }
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL === undefined) {
    vars.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-5"
  }

  // Plan-mode (v2) Phase-2 "Plan" agent parallelism. Claude Code's
  // getPlanModeV2AgentCount() (verified verbatim in the claude v2.1.158
  // binary, minified fn `bGK`) gates this on subscription tier:
  //   env override CLAUDE_CODE_PLAN_V2_AGENT_COUNT (1..10) wins, else
  //   max+rateLimitTier=default_claude_max_20x -> 3, enterprise/team -> 3,
  //   else 1.
  // Our synthetic credential is subscriptionType:"max" with
  // rateLimitTier:"default_claude_max_20x", so the natural tier path now
  // yields 3 — but we pin it higher here. The env override is the clean,
  // tier-independent lever (wins unconditionally, range 1..10), so the
  // count holds even if the credential tier ever changes. Presence-guarded,
  // symmetric with the tier-default guards above: any user-set value
  // (incl. "0"/unset intent) wins; we only inject the default when unset.
  if (process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT === undefined) {
    vars.CLAUDE_CODE_PLAN_V2_AGENT_COUNT = "7"
  }

  // Auto-enable Anthropic's experimental "leverage" features for proxied
  // claude sessions. Symmetric with the leverage-policy default
  // (extended-betas ON for `claude` subcommand): users running
  // `github-router claude` opted in for the Claude Code feature surface,
  // and these experimental gates default off for non-Anthropic users
  // (gated by GrowthBook flags that don't fire outside Anthropic).
  //
  // Presence-based guard: if the parent env has set ANY value for these
  // keys (including "0", "false", "no", "off", or any unrecognized
  // value), preserve the user's intent — only inject "1" when the key
  // is unset. The parent env survives `buildLaunchCommand`'s sanitize
  // step because none of these keys are in `STRIPPED_PARENT_ENV_KEYS`,
  // so an unset proxy var means the parent's value (if any) wins
  // naturally.
  //
  // ADVISOR has a documented `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` hard
  // opt-out that wins via JI()'s ordering (DISABLE checked before
  // ENABLE). FORK_SUBAGENT and AGENT_TEAMS rely on Anthropic's SH()
  // falsy semantics for opt-out ("0"/"false"/"no"/"off"/empty all opt
  // out — preserved by the presence guard). FINE_GRAINED_TOOL_STREAMING
  // is explicitly recommended by Anthropic's docs at
  // code.claude.com/docs/en/env-vars: "Set to `1` to force on when
  // routing through a proxy via ANTHROPIC_BASE_URL". TASKS only
  // manifests in `claude -p` headless mode.
  //
  // GATEWAY_MODEL_DISCOVERY is intentionally NOT enabled here — Claude
  // Code's hardcoded slug registry maps slugs to capabilities, not just
  // labels; Copilot's slugs (claude-opus-4.6-1m) don't match
  // Anthropic's registry (claude-opus-4-6), so dynamic discovery would
  // silently degrade advanced tool use. Enable it intentionally only
  // after building a slug-translation shim in /v1/models. See
  // CLAUDE.md "Experimental Claude Code features auto-enabled".
  const experimentalEnables: ReadonlyArray<string> = [
    "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL",
    "CLAUDE_CODE_FORK_SUBAGENT",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
    "CLAUDE_CODE_ENABLE_TASKS",
  ]
  for (const key of experimentalEnables) {
    if (process.env[key] === undefined) {
      vars[key] = "1"
    }
  }

  // Native selection of the four non-Claude models (Phase 3). Surface
  // gpt-5.5, gpt-5.3-codex, gemini-3.5-flash, gemini-3.1-pro-preview as
  // selectable rows in Claude Code's model picker — ADDITIVELY, without
  // touching the opus/sonnet/haiku tier defaults (ANTHROPIC_DEFAULT_*,
  // ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL) seeded above.
  //
  // Mechanism (verified against installed Claude Code 2.1.201): the ONLY
  // env lever that adds MORE THAN ONE selectable row is gateway model
  // discovery — ANTHROPIC_CUSTOM_MODEL_OPTION adds exactly one. Discovery's
  // NETWORK fetch is blocked here (it never reads the synthetic OAuth
  // credential, and bails on CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1),
  // but its cache-READ path is not — so we (1) enable discovery and (2)
  // pre-seed its cache with the real Copilot ids (seedGatewayModelCache).
  // The cache-read applies no id filter, so no claude-* alias / no
  // /v1/models normalization is needed, and the picker rows carry the real
  // ids the /v1/messages shim already routes.
  //
  // Non-regression is structural: the fetch that could otherwise discover
  // Copilot's dotted claude-* slugs (and degrade tier capability mapping —
  // the reason discovery is normally left off) is permanently blocked, and
  // the cache we seed contains ONLY these four non-Claude models. Tiers are
  // untouched.
  //
  // Gated on at least one target being in the live catalog (license tiers
  // differ) and presence-guarded: a user-set discovery value always wins.
  // The guard checks BOTH the parent env (consistent with every other guard
  // in this function) AND `vars` (defence against a future in-function
  // refactor that sets this key earlier). Discovery is enabled only when the
  // cache seed actually landed, so we never turn on a feature with nothing
  // to show. When no target is in the catalog we clear any prior seed so a
  // user-pinned discovery flag can't surface stale rows.
  const nativeModels = nativeSelectableModelsInCatalog()
  if (nativeModels.length > 0) {
    const seeded = seedGatewayModelCache(serverUrl, nativeModels)
    if (
      seeded
      && process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === undefined
      && vars.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === undefined
    ) {
      vars.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
    }
  } else {
    clearGatewayModelCache()
  }

  // Prepend the toolbelt bin dir to the spawned agent's PATH so it can
  // call rg/fd/jq/sd/sg/yq directly. Uses the parent's existing PATH
  // key casing to avoid creating a duplicate `Path`/`PATH` on Windows.
  if (toolbeltEnabled()) {
    Object.assign(vars, toolbeltPathOverride(process.env, PATHS.TOOLBELT_BIN_DIR))
  }

  return vars
}

/**
 * Build environment variables for Codex CLI.
 *
 * Like `getClaudeCodeEnvVars`, the parent env is sanitized of
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `CODEX_HOME` (see
 * `STRIPPED_PARENT_ENV_KEYS` in `src/lib/launch.ts`) before these
 * overrides are merged, so a stale shell `OPENAI_API_KEY` can't leak
 * through. Codex caches a ChatGPT subscription login under
 * `$CODEX_HOME/auth.json` which can override `OPENAI_API_KEY` per
 * openai/codex#2733; pointing `CODEX_HOME` at an isolated directory
 * masks any cached login.
 */
export function getCodexEnvVars(serverUrl: string): Record<string, string> {
  const vars: Record<string, string> = {
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
    // Isolated CODEX_HOME — masks any cached ChatGPT login (openai/codex#2733).
    CODEX_HOME: PATHS.CODEX_HOME,
  }
  if (toolbeltEnabled()) {
    Object.assign(vars, toolbeltPathOverride(process.env, PATHS.TOOLBELT_BIN_DIR))
  }
  return vars
}
