import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { enableFileLogging } from "./lib/file-log-reporter"
import { launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import {
  getClaudeCodeEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"
import { state } from "./lib/state"
import { resolveModel } from "./lib/utils"

export const claude = defineCommand({
  meta: {
    name: "claude",
    description: "Start the proxy server and launch Claude Code",
  },
  args: {
    ...sharedServerArgs,
    model: {
      alias: "m",
      type: "string",
      description: "Override the default model for Claude Code",
    },
  },
  async run({ args }) {
    if (!process.stdout.isTTY) {
      consola.error("The claude subcommand requires a TTY (interactive terminal).")
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

    enableFileLogging() // redirect errors/warnings to file; suppress terminal output

    // Validate model if overridden (warnings go to log file, not terminal)
    let resolvedModel: string | undefined
    if (args.model) {
      resolvedModel = resolveModel(args.model)
      if (resolvedModel !== args.model) {
        consola.info(`Model "${args.model}" resolved to "${resolvedModel}"`)
      }
      const modelEntry = state.models?.data.find((m) => m.id === resolvedModel)
      if (!modelEntry) {
        const available = listModelsForEndpoint("/v1/messages")
        consola.warn(
          `Model "${resolvedModel}" not found. Available claude models: ${available.join(", ")}`,
        )
      }
    }

    // Print to stderr directly — consola's terminal reporter is already gone
    process.stderr.write(`Server ready on ${serverUrl}, launching Claude Code...\n`)

    const envVars = getClaudeCodeEnvVars(serverUrl, resolvedModel ?? args.model)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "claude-code", envVars, extraArgs, model: resolvedModel ?? args.model },
      server,
    )
  },
})
