#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { claude } from "./claude"
import { codex } from "./codex"
import { debug } from "./debug"
import { internalPromptSubmit } from "./internal-prompt-submit"
import { internalPlanReview } from "./internal-plan-review"
import { internalSessionBind } from "./internal-session-bind"
import { internalArtifactOpen } from "./internal-artifact-open"
import { internalFirstMateGuard } from "./internal-first-mate-guard"
import { internalStopHook } from "./internal-stop-hook"
import { internalStopReview } from "./internal-stop-review"
import { internalWorkerGuard } from "./internal-worker-guard"
import { getPackageVersion } from "./lib/version"
import { models } from "./models"
import { start } from "./start"

process.on("unhandledRejection", (error) => {
  consola.error("Unhandled rejection:", error)
})

process.on("uncaughtException", (error) => {
  consola.error("Uncaught exception:", error)
  process.exit(1)
})

const version = getPackageVersion()

// Always surface the running version on stderr so crash reports
// identify which build is in use. Suppressed only for `--version`
// (citty's built-in handler prints just the bare version number, and
// a banner above it is redundant). `-v` is NOT special-cased: citty
// doesn't treat it as `--version`, so users typing `-v` still get
// the banner — which is the closest thing to "show me the version".
const argv = process.argv.slice(2)
const isVersionFlag = argv.includes("--version")
// Suppress the banner for the internal hooks: their stdout/stderr is consumed by
// Claude Code (the Stop hook's stderr is the block message; the prompt-submit
// hook's stdout is injected context), so it must stay clean. `internal-stop-review`
// and `internal-plan-review` are detached/background with no consumer, but stay
// quiet for the same reason.
const isInternalHook =
  argv[0] === "internal-stop-hook"
  || argv[0] === "internal-prompt-submit"
  || argv[0] === "internal-stop-review"
  || argv[0] === "internal-plan-review"
  || argv[0] === "internal-session-bind"
  || argv[0] === "internal-artifact-open"
  || argv[0] === "internal-first-mate-guard"
  || argv[0] === "internal-worker-guard"
if (!isVersionFlag && !isInternalHook) {
  consola.info(`github-router v${version}`)
}

const main = defineCommand({
  meta: {
    name: "github-router",
    version,
    description:
      "A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.",
  },
  subCommands: { auth, start, claude, codex, models, "check-usage": checkUsage, debug, "internal-stop-hook": internalStopHook, "internal-prompt-submit": internalPromptSubmit, "internal-stop-review": internalStopReview, "internal-plan-review": internalPlanReview, "internal-session-bind": internalSessionBind, "internal-artifact-open": internalArtifactOpen, "internal-first-mate-guard": internalFirstMateGuard, "internal-worker-guard": internalWorkerGuard },
})

await runMain(main)
