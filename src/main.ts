#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "github-router",
    description:
      "A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.",
  },
  subCommands: { auth, start, "check-usage": checkUsage, debug },
})

await runMain(main)
