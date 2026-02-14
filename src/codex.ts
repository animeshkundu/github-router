import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { launchChild } from "./lib/launch"
import {
  getCodexEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"

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

    const { server, serverUrl } = await setupAndServe({
      ...parsed,
      port: parsed.port, // undefined = random port
      silent: true,
    })

    const codexModel = args.model ?? "gpt5.3-codex"
    consola.success(`Server ready on ${serverUrl}, launching Codex CLI (${codexModel})...`)
    consola.level = 1 // errors only — prevent TUI corruption

    await server.ready()

    const envVars = getCodexEnvVars(serverUrl)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      { kind: "codex", envVars, extraArgs, model: args.model },
      server,
    )
  },
})
