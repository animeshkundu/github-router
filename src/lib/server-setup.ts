import consola from "consola"
import { serve, type ServerHandler } from "srvx"

import { ensurePaths } from "./paths"
import { generateRandomPort } from "./port"
import { initProxyFromEnv } from "./proxy"
import { state } from "./state"
import { setupCopilotToken, setupGitHubToken } from "./token"
import { cacheModels, cacheVSCodeVersion } from "./utils"
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

  await ensurePaths()
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serveOptions = {
    fetch: app.fetch as ServerHandler,
    hostname: "127.0.0.1",
    silent: options.silent,
  }

  let srvxServer: ReturnType<typeof serve>

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
            || error.message.includes("address already in use"))
        if (!isAddrInUse) throw error
        consola.debug(`Port ${candidatePort} in use, trying another...`)
      }
    }

    if (!srvxServer!) {
      throw new Error(
        `Failed to find an available port after ${MAX_PORT_RETRIES} attempts. `
        + `Specify a port with --port or free some ports. Last error: ${lastError}`,
      )
    }
  }

  // Read actual port from the server URL
  const url = srvxServer.url ?? `http://127.0.0.1:${options.port}`
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
  }
}

/** Build environment variables for Claude Code. */
export function getClaudeCodeEnvVars(
  serverUrl: string,
  model?: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    ANTHROPIC_BASE_URL: serverUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
  if (model) vars.ANTHROPIC_MODEL = model
  return vars
}

/** Build environment variables for Codex CLI. */
export function getCodexEnvVars(serverUrl: string): Record<string, string> {
  return {
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
  }
}
