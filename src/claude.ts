import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { launchChild } from "./lib/launch"
import {
  getClaudeCodeEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"

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

    const { server, serverUrl } = await setupAndServe({
      ...parsed,
      port: parsed.port, // undefined = random port
      silent: true,
    })

    consola.success(`Server ready on ${serverUrl}, launching Claude Code...`)
    consola.level = 1 // errors only — prevent TUI corruption

    await server.ready()

    const envVars = getClaudeCodeEnvVars(serverUrl, args.model)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "claude-code", envVars, extraArgs, model: args.model },
      server,
    )
  },
})
