#!/usr/bin/env node

import { defineCommand, runMain, showUsage } from "citty"
import consola from "consola"

import { getPackageVersion } from "./lib/version"

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
  || argv[0] === "internal-fast-dispatch-guard"
if (!isVersionFlag && !isInternalHook) {
  consola.info(`github-router v${version}`)
}

/**
 * Subcommands are LAZY THUNKS, not static imports.
 *
 * citty resolves only the named entry (`_findSubCommand` → `resolveValue`), so
 * running one subcommand no longer evaluates the other 17 module graphs. That
 * matters because several of these are per-turn Claude Code hooks — the
 * `UserPromptSubmit`, `Stop` and `PreToolUse` handlers registered by
 * `src/claude.ts` each spawn a FRESH `node dist/main.js <sub>` process, so any
 * import-time cost lands in the user's interactive loop on every prompt.
 * `internal-worker-guard`, for instance, needs three modules but was loading
 * the entire claude/serve/MCP graph plus the Pi vendor runtime.
 *
 * Safe because the import-time side effects in this codebase
 * (`assertMcpToolSurfaceConsistent` in `server.ts`, the tree-sitter grammar
 * preload, the worktree/session exit-handler registrations, the first-mate
 * allowlist assertion) are reachable ONLY from claude/codex/serve/start, and
 * all four reach all of them independently — no subcommand relies on another's
 * module being loaded. Verified by an AST walk of the runtime import graph.
 *
 * `--help` is the one path that still resolves everything: citty's
 * `renderUsage` reads each subcommand's meta to print descriptions. That is
 * not latency-critical, and `resolveHelpTarget` below resolves only the single
 * subcommand when help is scoped to one.
 */
const main = defineCommand({
  meta: {
    name: "github-router",
    version,
    description:
      "A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.",
  },
  subCommands: {
    auth: () => import("./auth").then((m) => m.auth),
    start: () => import("./start").then((m) => m.start),
    claude: () => import("./claude").then((m) => m.claude),
    codex: () => import("./codex").then((m) => m.codex),
    serve: () => import("./serve").then((m) => m.serve),
    models: () => import("./models").then((m) => m.models),
    "check-usage": () => import("./check-usage").then((m) => m.checkUsage),
    debug: () => import("./debug").then((m) => m.debug),
    "internal-stop-hook": () =>
      import("./internal-stop-hook").then((m) => m.internalStopHook),
    "internal-prompt-submit": () =>
      import("./internal-prompt-submit").then((m) => m.internalPromptSubmit),
    "internal-stop-review": () =>
      import("./internal-stop-review").then((m) => m.internalStopReview),
    "internal-plan-review": () =>
      import("./internal-plan-review").then((m) => m.internalPlanReview),
    "internal-session-bind": () =>
      import("./internal-session-bind").then((m) => m.internalSessionBind),
    "internal-workspace-header": () =>
      import("./internal-workspace-header").then(
        (m) => m.internalWorkspaceHeader,
      ),
    "internal-artifact-open": () =>
      import("./internal-artifact-open").then((m) => m.internalArtifactOpen),
    "internal-first-mate-guard": () =>
      import("./internal-first-mate-guard").then(
        (m) => m.internalFirstMateGuard,
      ),
    "internal-worker-guard": () =>
      import("./internal-worker-guard").then((m) => m.internalWorkerGuard),
    "internal-fast-dispatch-guard": () =>
      import("./internal-fast-dispatch-guard").then((m) => m.internalFastDispatchGuard),
  },
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
