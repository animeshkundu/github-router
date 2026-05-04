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

    // Two slugs flow through this code:
    //   * `chosenSlug` — the value we set for `ANTHROPIC_MODEL`. Must be an
    //     Anthropic-published slug (e.g. `claude-opus-4-7`) so Claude Code's
    //     hardcoded `/model` registry matches it and the UI shows the right
    //     menu entry. The proxy's resolver translates this back to a Copilot
    //     slug at request time, so the actual upstream call still works.
    //   * `resolvedSlug` — the Copilot-side slug after `resolveModel`. Used
    //     only for cache-presence validation (fallback chain) and the
    //     launch banner.
    //
    // For the implicit-default path only, we walk
    // DEFAULT_CLAUDE_MODEL_FALLBACKS when neither the default nor any
    // earlier fallback resolves to a model present in the Copilot cache.
    // Explicit `--model` is respected as-is — including Copilot slugs
    // (which Claude Code's UI won't recognize, but power users may want
    // for explicit pinning).
    const usingDefault = !args.model
    const requestedSlug = args.model ?? DEFAULT_CLAUDE_MODEL
    let chosenSlug = requestedSlug
    let resolvedSlug = resolveModel(chosenSlug)

    if (usingDefault && state.models) {
      const inCache = (slug: string) =>
        state.models?.data.some((m) => m.id === resolveModel(slug)) ?? false
      if (!inCache(chosenSlug)) {
        for (const fallback of DEFAULT_CLAUDE_MODEL_FALLBACKS) {
          if (inCache(fallback)) {
            consola.info(
              `Default model "${chosenSlug}" not in your Copilot model list; falling back to "${fallback}".`,
            )
            chosenSlug = fallback
            resolvedSlug = resolveModel(fallback)
            break
          }
        }
      }
    }

    if (resolvedSlug !== chosenSlug) {
      consola.info(`Model "${chosenSlug}" resolved to "${resolvedSlug}"`)
    }
    const modelEntry = state.models?.data.find((m) => m.id === resolvedSlug)
    if (!modelEntry) {
      const available = listModelsForEndpoint("/v1/messages")
      consola.warn(
        `Model "${resolvedSlug}" not found. Available claude models: ${available.join(", ")}`,
      )
    }

    // Banner shows the round-trip so the user sees both names. Claude Code's
    // UI will display the chosenSlug; Copilot upstream sees resolvedSlug.
    const banner =
      chosenSlug === resolvedSlug
        ? chosenSlug
        : `${chosenSlug} → ${resolvedSlug}`
    // Print to stderr directly — consola's terminal reporter is already gone
    process.stderr.write(`Server ready on ${serverUrl}, launching Claude Code (${banner})...\n`)

    const envVars = getClaudeCodeEnvVars(serverUrl, chosenSlug)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "claude-code", envVars, extraArgs, model: chosenSlug },
      server,
    )
  },
})
