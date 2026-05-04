import consola from "consola"
import { serve, type ServerHandler } from "srvx"

import { PATHS, ensurePaths } from "./paths"
import { generateRandomPort } from "./port"
import { initProxyFromEnv } from "./proxy"
import { state } from "./state"
import { setupCopilotToken, setupGitHubToken } from "./token"
import { cacheModels, cacheCopilotVersion, cacheVSCodeVersion } from "./utils"
import { server as app } from "../server"

const MAX_PORT_RETRIES = 10

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
  silent: boolean
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

  if (process.env.COPILOT_API_URL) {
    state.copilotApiUrl = process.env.COPILOT_API_URL
  }

  await ensurePaths()
  await cacheVSCodeVersion()
  await cacheCopilotVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.debug(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serveOptions = {
    fetch: app.fetch as ServerHandler,
    hostname: "127.0.0.1",
    silent: options.silent,
  }

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
  }
}

/**
 * Build environment variables for Claude Code.
 *
 * Defends against every non-proxy auth path Claude Code might otherwise
 * pick up (verified live against claude 2.1.126 — see `getClaudeCodeEnvVars`
 * tests). Auth precedence in Claude Code is documented at
 * https://code.claude.com/docs/en/iam:
 *
 *   1. Cloud provider (CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY) — wins
 *      over ANTHROPIC_BASE_URL, so we explicitly clear inherited truthy
 *      values with empty strings.
 *   2. ANTHROPIC_AUTH_TOKEN — sent as `Authorization: Bearer …`.
 *   3. ANTHROPIC_API_KEY — sent as `x-api-key: …`. Claude Code sends BOTH
 *      headers when both env vars are set, so we shadow the user's
 *      possibly-real shell-exported key with a dummy too.
 *   4. apiKeyHelper in settings.json — overridden by env vars (#2/#3).
 *   5. CLAUDE_CODE_OAUTH_TOKEN — long-lived OAuth; cleared explicitly.
 *   6. Subscription OAuth (Keychain / ~/.claude/.credentials.json) — beaten
 *      by env-var precedence above.
 */
export function getClaudeCodeEnvVars(
  serverUrl: string,
  model?: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    // Route to the proxy
    ANTHROPIC_BASE_URL: serverUrl,
    // Authoritative dummy creds — both required because Claude Code sends
    // both headers when both vars are set; without ANTHROPIC_API_KEY="dummy"
    // a real shell-exported key would leak to the proxy via x-api-key.
    ANTHROPIC_AUTH_TOKEN: "dummy",
    ANTHROPIC_API_KEY: "dummy",
    // Disable cloud-provider routing in case the user has these set
    // (empty string is falsy in Claude Code's truthy check).
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    // Disable any inherited long-lived OAuth token.
    CLAUDE_CODE_OAUTH_TOKEN: "",
    // Drop user-injected custom headers that could carry auth.
    ANTHROPIC_CUSTOM_HEADERS: "",
    // Suppress non-essential telemetry/model calls.
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
  if (model) vars.ANTHROPIC_MODEL = model
  return vars
}

/**
 * Build environment variables for Codex CLI.
 *
 * Codex caches a ChatGPT subscription login under `$CODEX_HOME` (defaults
 * `~/.codex`); per openai/codex#2733 the cached login can override
 * `OPENAI_API_KEY`. Pointing `CODEX_HOME` at an isolated directory makes
 * the proxy's dummy key authoritative.
 */
export function getCodexEnvVars(serverUrl: string): Record<string, string> {
  return {
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
    // Isolated CODEX_HOME — masks any cached ChatGPT login (openai/codex#2733).
    CODEX_HOME: PATHS.CODEX_HOME,
  }
}
