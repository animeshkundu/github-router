import os from "node:os"
import path from "node:path"

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
 * The parent env is sanitized of every key in `STRIPPED_PARENT_ENV_KEYS`
 * (see `src/lib/launch.ts`) BEFORE these overrides are merged in, so we
 * only need to provide the positive values.
 *
 * Auth precedence in Claude Code (https://code.claude.com/docs/en/iam):
 *   1. Cloud provider (CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY) — stripped at parent.
 *   2. ANTHROPIC_AUTH_TOKEN — set here to "dummy"; wins over #4–#6.
 *   3. ANTHROPIC_API_KEY — stripped at parent, intentionally NOT re-set
 *      (Claude Code emits an Auth conflict warning when both AUTH_TOKEN
 *      and API_KEY are present, even with dummy values).
 *   4. apiKeyHelper in settings.json — beaten by #2.
 *   5. CLAUDE_CODE_OAUTH_TOKEN — stripped at parent.
 *   6. Subscription OAuth (Keychain / ~/.claude/.credentials.json) —
 *      INVISIBLE to the spawned child via the CLAUDE_CONFIG_DIR trick
 *      below. The credential file is left in place so `claude /logout`
 *      still works outside the proxy.
 *
 * `CLAUDE_CONFIG_DIR` activates Claude Code's per-config-dir keychain
 * isolation. Per binary-grep of Claude Code 2.1.126's `iN()` function:
 *
 *   function iN(H = "") {
 *     let _ = B6(),  // resolved config-dir path
 *         K = !process.env.CLAUDE_CONFIG_DIR ? "" : `-${sha256(_).slice(0, 8)}`;
 *     return `Claude Code${OAUTH_FILE_SUFFIX}${H}${K}`
 *   }
 *
 * The conditional is on PRESENCE, not value. When CLAUDE_CONFIG_DIR is
 * unset (the user's normal `claude` usage), the keychain service name is
 * "Claude Code" and their `/login` credential is found there. When set
 * (the proxy session), the service name becomes "Claude Code-<hash>" —
 * the user's credential is invisible, `iCH()` returns null, and all
 * three auth-conflict warnings fire `false`. The path resolves to the
 * default config-dir, so settings.json/skills/MCP/plugins/hooks/CLAUDE.md
 * still load from `~/.claude` as normal.
 */
export function getClaudeCodeEnvVars(
  serverUrl: string,
  model?: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    // Route to the proxy
    ANTHROPIC_BASE_URL: serverUrl,
    // Authoritative dummy bearer; sent as `Authorization: Bearer dummy`.
    ANTHROPIC_AUTH_TOKEN: "dummy",
    // Activate per-config-dir keychain isolation — silences the
    // "/login managed key" auth-conflict warning without requiring
    // `claude /logout`. Pointing at the default $HOME/.claude is
    // intentional: it preserves all user customization (settings.json,
    // skills, MCP, hooks, CLAUDE.md, custom agents) while making the
    // keychain probe miss the user's actual credential entry.
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude"),
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
  return {
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
    // Isolated CODEX_HOME — masks any cached ChatGPT login (openai/codex#2733).
    CODEX_HOME: PATHS.CODEX_HOME,
  }
}
