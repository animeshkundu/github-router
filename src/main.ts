#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { claude } from "./claude"
import { codex } from "./codex"
import { debug } from "./debug"
import { start } from "./start"

process.on("unhandledRejection", (error) => {
  consola.error("Unhandled rejection:", error)
})

process.on("uncaughtException", (error) => {
  consola.error("Uncaught exception:", error)
  process.exit(1)
})

const main = defineCommand({
  meta: {
    name: "github-router",
    description:
      "A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.",
  },
  subCommands: { auth, start, claude, codex, "check-usage": checkUsage, debug },
})

await runMain(main)
