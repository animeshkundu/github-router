#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import type { Model } from "./services/copilot/get-models"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  codex: boolean
  showToken: boolean
  proxyEnv: boolean
}

const allowedAccountTypes = new Set(["individual", "business", "enterprise"])

function printAndCopyCommand(command: string, label: string): void {
  consola.box(`${label}\n\n${command}`)
  try {
    clipboard.writeSync(command)
    consola.success(`Copied ${label} command to clipboard!`)
  } catch {
    consola.warn("Failed to copy to clipboard. Copy the command above manually.")
  }
}

function filterModelsByEndpoint(
  models: Array<Model>,
  endpoint: string,
): Array<Model> {
  const filtered = models.filter((model) => {
    const endpoints = model.supported_endpoints
    // Some deployments omit supported_endpoints; keep those models visible.
    if (!endpoints || endpoints.length === 0) return true
    return endpoints.some((entry) => {
      const normalized = entry.replace(/^\/?v1\//, "").replace(/^\//, "")
      return normalized === endpoint
    })
  })

  return filtered.length > 0 ? filtered : models
}

async function generateClaudeCodeCommand(serverUrl: string) {
  invariant(state.models, "Models should be loaded by now")

  const claudeModels = state.models.data.filter((model) =>
    model.id.toLowerCase().startsWith("claude"),
  )

  if (claudeModels.length === 0) {
    consola.error("No Claude models available from Copilot API")
    return
  }

  // Pick the best main model: prefer opus, then sonnet, then first available
  const mainModel =
    claudeModels.find((m) => m.id.includes("opus")) ??
    claudeModels.find((m) => m.id.includes("sonnet")) ??
    claudeModels[0]

  // Pick the best small model: prefer haiku, then sonnet, then first available
  const smallModel =
    claudeModels.find((m) => m.id.includes("haiku")) ??
    claudeModels.find((m) => m.id.includes("sonnet")) ??
    claudeModels[0]

  // Only prompt if there are multiple options and the user might want to override
  let selectedModel = mainModel.id
  let selectedSmallModel = smallModel.id

  if (claudeModels.length > 1) {
    consola.info(
      `Using ${mainModel.id} as main model and ${smallModel.id} as small model`,
    )
    const override = await consola.prompt("Override model selection?", {
      type: "confirm",
      initial: false,
    })

    if (override) {
      selectedModel = await consola.prompt(
        "Select a main model for Claude Code",
        {
          type: "select",
          options: claudeModels.map((model) => model.id),
        },
      )
      selectedSmallModel = await consola.prompt(
        "Select a small/fast model for Claude Code",
        {
          type: "select",
          options: claudeModels.map((model) => model.id),
        },
      )
    }
  }

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude --dangerously-skip-permissions",
  )

  printAndCopyCommand(command, "Claude Code")
}

async function generateCodexCommand(serverUrl: string) {
  invariant(state.models, "Models should be loaded by now")

  const supportedModels = filterModelsByEndpoint(
    state.models.data,
    "responses",
  )

  const defaultCodexModel = supportedModels.find(
    (model) => model.id === "gpt5.2-codex",
  )

  const selectedModel =
    defaultCodexModel ?
      defaultCodexModel.id
    : await consola.prompt("Select a model to use with Codex CLI", {
        type: "select",
        options: supportedModels.map((model) => model.id),
      })

  const quotedModel = JSON.stringify(selectedModel)
  const command = generateEnvScript(
    {
      OPENAI_BASE_URL: `${serverUrl}/v1`,
      OPENAI_API_KEY: "dummy",
    },
    `codex -m ${quotedModel}`,
  )

  printAndCopyCommand(command, "Codex CLI")
}

export async function runServer(options: RunServerOptions): Promise<void> {
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

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) await generateClaudeCodeCommand(serverUrl)
  if (options.codex) await generateCodexCommand(serverUrl)

  consola.box(
    `🌐 Usage Viewer: https://animeshkundu.github.io/github-router/dashboard.html?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    hostname: "127.0.0.1",
    port: options.port,
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the github-router server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "8787",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "enterprise",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    codex: {
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Codex CLI with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    let rateLimit: number | undefined
    if (rateLimitRaw !== undefined) {
      rateLimit = Number.parseInt(rateLimitRaw, 10)
      if (Number.isNaN(rateLimit) || rateLimit <= 0) {
        throw new Error("Invalid rate limit. Must be a positive integer.")
      }
    }

    const port = Number.parseInt(args.port, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error("Invalid port. Must be between 1 and 65535.")
    }

    const accountType = args["account-type"]
    if (!allowedAccountTypes.has(accountType)) {
      throw new Error(
        "Invalid account type. Must be individual, business, or enterprise.",
      )
    }

    const rateLimitWait = args.wait && rateLimit !== undefined
    if (args.wait && rateLimit === undefined) {
      consola.warn("Rate limit wait ignored because no rate limit was set.")
    }

    const githubToken = args["github-token"] ?? process.env.GH_TOKEN

    return runServer({
      port,
      verbose: args.verbose,
      accountType,
      manual: args.manual,
      rateLimit,
      rateLimitWait,
      githubToken,
      claudeCode: args["claude-code"],
      codex: args.codex,
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})
