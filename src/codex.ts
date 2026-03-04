import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import { DEFAULT_CODEX_MODEL } from "./lib/port"
import {
  getCodexEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"
import { state } from "./lib/state"
import { resolveCodexModel } from "./lib/utils"

export const codex = defineCommand({
  meta: {
    name: "codex",
    description: "Start the proxy server and launch Codex CLI",
  },
  args: {
    ...sharedServerArgs,
    model: {
      alias: "m",
      type: "string",
      description: "Override the default model for Codex CLI",
    },
  },
  async run({ args }) {
    if (!process.stdout.isTTY) {
      consola.error("The codex subcommand requires a TTY (interactive terminal).")
      process.exit(1)
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)

    let server: Awaited<ReturnType<typeof setupAndServe>>["server"]
    let serverUrl: string
    try {
      const result = await setupAndServe({
        ...parsed,
        port: parsed.port, // undefined = random port
        silent: true,
      })
      server = result.server
      serverUrl = result.serverUrl
    } catch (error) {
      consola.error("Failed to start server:", error instanceof Error ? error.message : error)
      process.exit(1)
    }

    const requestedModel = args.model ?? DEFAULT_CODEX_MODEL
    const codexModel = resolveCodexModel(requestedModel)
    if (codexModel !== requestedModel) {
      consola.info(`Model "${requestedModel}" resolved to "${codexModel}"`)
    }

    // Validate model exists in Copilot model list
    const modelEntry = state.models?.data.find((m) => m.id === codexModel)
    if (!modelEntry) {
      const available = listModelsForEndpoint("/responses")
      consola.warn(
        `Model "${codexModel}" not found. Available codex models: ${available.join(", ")}`,
      )
    } else {
      const ctx = modelEntry.capabilities?.limits?.max_context_window_tokens
      if (ctx) consola.info(`Model context window: ${ctx.toLocaleString()} tokens`)
    }

    consola.success(`Server ready on ${serverUrl}, launching Codex CLI (${codexModel})...`)
    consola.level = -Infinity // silent — prevent TUI corruption

    const envVars = getCodexEnvVars(serverUrl)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "codex", envVars, extraArgs, model: codexModel },
      server,
    )
  },
})
