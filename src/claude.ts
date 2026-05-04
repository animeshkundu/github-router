import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { enableFileLogging } from "./lib/file-log-reporter"
import { launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
} from "./lib/port"
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

    // Resolve and validate model (warnings go to log file, not terminal).
    // When --model is not supplied, fall back to DEFAULT_CLAUDE_MODEL.
    // For the implicit-default path only, walk DEFAULT_CLAUDE_MODEL_FALLBACKS
    // when the default isn't in the resolved Copilot model list — e.g. on
    // non-enterprise tokens where claude-opus-4.7-1m-internal is gated.
    // Explicit --model is respected as-is.
    const usingDefault = !args.model
    const requestedModel = args.model ?? DEFAULT_CLAUDE_MODEL
    let resolvedModel = resolveModel(requestedModel)

    if (usingDefault && state.models) {
      const inCache = (id: string) =>
        state.models?.data.some((m) => m.id === id) ?? false
      if (!inCache(resolvedModel)) {
        for (const fallback of DEFAULT_CLAUDE_MODEL_FALLBACKS) {
          const fallbackResolved = resolveModel(fallback)
          if (inCache(fallbackResolved)) {
            consola.info(
              `Default model "${resolvedModel}" not in your Copilot model list; falling back to "${fallbackResolved}".`,
            )
            resolvedModel = fallbackResolved
            break
          }
        }
      }
    }

    if (resolvedModel !== requestedModel) {
      consola.info(`Model "${requestedModel}" resolved to "${resolvedModel}"`)
    }
    const modelEntry = state.models?.data.find((m) => m.id === resolvedModel)
    if (!modelEntry) {
      const available = listModelsForEndpoint("/v1/messages")
      consola.warn(
        `Model "${resolvedModel}" not found. Available claude models: ${available.join(", ")}`,
      )
    }

    // Print to stderr directly — consola's terminal reporter is already gone
    process.stderr.write(`Server ready on ${serverUrl}, launching Claude Code (${resolvedModel})...\n`)

    const envVars = getClaudeCodeEnvVars(serverUrl, resolvedModel)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "claude-code", envVars, extraArgs, model: resolvedModel },
      server,
    )
  },
})
