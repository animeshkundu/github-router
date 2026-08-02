#!/usr/bin/env node

import { defineCommand, runMain, showUsage } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { claude } from "./claude"
import { codex } from "./codex"
import { debug } from "./debug"
import { internalPromptSubmit } from "./internal-prompt-submit"
import { internalPlanReview } from "./internal-plan-review"
import { internalSessionBind } from "./internal-session-bind"
import { internalWorkspaceHeader } from "./internal-workspace-header"
import { internalArtifactOpen } from "./internal-artifact-open"
import { internalFirstMateGuard } from "./internal-first-mate-guard"
import { internalStopHook } from "./internal-stop-hook"
import { internalStopReview } from "./internal-stop-review"
import { internalWorkerGuard } from "./internal-worker-guard"
import { getPackageVersion } from "./lib/version"
import { models } from "./models"
import { serve } from "./serve"
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
  || argv[0] === "internal-workspace-header"
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
  subCommands: { auth, start, claude, codex, serve, models, "check-usage": checkUsage, debug, "internal-stop-hook": internalStopHook, "internal-prompt-submit": internalPromptSubmit, "internal-stop-review": internalStopReview, "internal-plan-review": internalPlanReview, "internal-session-bind": internalSessionBind, "internal-workspace-header": internalWorkspaceHeader, "internal-artifact-open": internalArtifactOpen, "internal-first-mate-guard": internalFirstMateGuard, "internal-worker-guard": internalWorkerGuard },
})

/**
 * Print usage ourselves and let the process DRAIN, instead of letting citty
 * hard-exit while stdout is still queued.
 *
 * citty's `runMain` calls `process.exit(0)` immediately after `showUsage`
 * resolves (citty 0.2.2 dist/index.mjs:389; 0.1.6 does the same, so this is
 * not an upgrade regression). On Windows a PIPE-backed stdout is async, so the
 * usage text is still in a libuv handle when the hard exit tears the loop down
 * and node aborts:
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`
 * — after printing the help the user asked for.
 *
 * `--version` is unaffected: citty's version branch has no `process.exit()`
 * and drains naturally. That asymmetry is why this survived so long — the
 * cheapest smoke test passes while every `--help` path aborts. Node 22 on
 * Windows tolerated it; node 24 does not, and release.yml publishes with
 * node 24.
 *
 * Forcing `_handle.setBlocking(true)` first was tried and does NOT fix it —
 * the abort still reproduces through a pipe. The only reliable fix is to not
 * hard-exit at all, which is the same resolution the internal hooks already
 * use (`process.exitCode = 0`, never `process.exit()`), guarded by the tests
 * in this repo's internal-hooks-crash suite.
 *
 * Only the help path is intercepted; everything else still goes through citty
 * so argument parsing, subcommand dispatch and error handling stay citty's.
 */
const HELP_FLAGS = new Set(["--help", "-h"])

async function resolveHelpTarget(): Promise<{
  cmd: Parameters<typeof showUsage>[0]
  parent?: Parameters<typeof showUsage>[1]
}> {
  // First non-flag token is the subcommand, matching citty's own resolution
  // for our single-level command tree.
  const name = argv.find((arg) => !arg.startsWith("-"))
  const table = main.subCommands as Record<string, unknown> | undefined
  const entry = name ? table?.[name] : undefined
  if (!entry) return { cmd: main }
  // citty allows a subcommand to be a value, a promise, or a thunk.
  const resolved = typeof entry === "function" ? await entry() : await entry
  return {
    cmd: resolved as Parameters<typeof showUsage>[0],
    parent: main as Parameters<typeof showUsage>[1],
  }
}

if (argv.some((arg) => HELP_FLAGS.has(arg))) {
  const { cmd, parent } = await resolveHelpTarget()
  await showUsage(cmd, parent)
  // Signal success WITHOUT tearing the loop down — node drains stdout and
  // exits 0 on its own.
  process.exitCode = 0
} else {
  await runMain(main)
}
