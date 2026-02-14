#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"

import { generateEnvScript } from "./lib/shell"
import { DEFAULT_CODEX_MODEL, DEFAULT_PORT } from "./lib/port"
import {
  getClaudeCodeEnvVars,
  getCodexEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"

function printAndCopyCommand(command: string, label: string): void {
  consola.box(`${label}\n\n${command}`)
  try {
    clipboard.writeSync(command)
    consola.success(`Copied ${label} command to clipboard!`)
  } catch {
    consola.warn("Failed to copy to clipboard. Copy the command above manually.")
  }
}

function generateClaudeCodeCommand(serverUrl: string, model?: string) {
  const envVars = getClaudeCodeEnvVars(serverUrl, model)
  const command = generateEnvScript(envVars, "claude --dangerously-skip-permissions")
  printAndCopyCommand(command, "Claude Code")
}

function generateCodexCommand(serverUrl: string, model?: string) {
  const codexModel = model ?? DEFAULT_CODEX_MODEL
  const envVars = getCodexEnvVars(serverUrl)
  const command = generateEnvScript(envVars, `codex -m ${codexModel}`)
  printAndCopyCommand(command, "Codex CLI")
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the github-router server",
  },
  args: {
    ...sharedServerArgs,
    cc: {
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    cx: {
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Codex CLI with Copilot API config",
    },
    model: {
      alias: "m",
      type: "string",
      description: "Override the default model (used with --cc or --cx)",
    },
  },
  async run({ args }) {
    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)

    const { serverUrl } = await setupAndServe({
      ...parsed,
      port: parsed.port ?? DEFAULT_PORT,
      silent: false,
    })

    if (args.cc) generateClaudeCodeCommand(serverUrl, args.model)
    if (args.cx) generateCodexCommand(serverUrl, args.model)

    consola.box(
      `🌐 Usage Viewer: https://animeshkundu.github.io/github-router/dashboard.html?endpoint=${serverUrl}/usage`,
    )
  },
})
