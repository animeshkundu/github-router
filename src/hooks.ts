#!/usr/bin/env node

/**
 * The stable hook launcher: a single self-contained bundle holding every
 * `internal-*` subcommand Claude Code invokes as a hook.
 *
 * Why this is a separate entrypoint from `main.ts`: the hook commands are
 * PERSISTED into a settings.json that outlives the process that wrote it, and
 * under `bunx` the package tree they pointed at lives in `$TMPDIR`. macOS's
 * per-user temp reaper deletes files there (leaving the directory skeleton), so
 * `node <tmp>/.../dist/main.js` would die on the first bare import —
 * `ERR_MODULE_NOT_FOUND` for `consola` — and EVERY hook in a long-running
 * session failed until the tree happened to be re-extracted. `bunx pkg@latest`
 * also re-extracts in place whenever npm's `latest` advances, so a live
 * session's hooks could silently start running a different version's code.
 *
 * This bundle is built with `noExternal: true` and code splitting off, so it
 * has NO `node_modules` lookup at all and can be copied to a stable location
 * outside the package tree. `src/lib/hook-launcher/provision.ts` publishes it
 * to `<APP_DIR>/hooks/hooks-<sha256>.mjs`, and the launcher points every
 * persisted command string there.
 *
 * `main.ts` keeps registering the same subcommands, so anything invoking them
 * the old way still works.
 */

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { takePackageRootArg } from "./lib/package-root"
import { getPackageVersion } from "./lib/version"

process.on("unhandledRejection", (error) => {
  consola.error("Unhandled rejection:", error)
})

process.on("uncaughtException", (error) => {
  consola.error("Uncaught exception:", error)
  process.exit(1)
})

// Consume the launcher-wide `--package-root` before citty parses anything. It
// must be recorded first: `getPackageVersion()` below and every relocated
// package-root lookup read it. See src/lib/package-root.ts for why the value
// travels as an argv entry rather than an env var.
const argv = takePackageRootArg(process.argv.slice(2))

// No startup banner, ever. Every subcommand here is a hook whose streams Claude
// Code consumes — the Stop hook's stderr becomes the block message and the
// prompt-submit hook's stdout becomes injected context — so both must stay
// clean. `main.ts` special-cases these same names for the same reason; here the
// whole binary is hooks, so there is nothing to special-case.

/**
 * Subcommands stay LAZY THUNKS even though code splitting is off and every
 * module already lives in this one file. Rolldown wraps an inlined dynamic
 * import so evaluation is still deferred to first call, which is what the
 * laziness was ever buying: these run per-turn in the user's interactive loop,
 * and `internal-worker-guard` needs three modules, not nine graphs.
 */
const main = defineCommand({
  meta: {
    name: "github-router-hooks",
    version: getPackageVersion(),
    description:
      "Internal: the github-router hook launcher. Not intended to be run by hand.",
  },
  subCommands: {
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
  },
})

// `rawArgs` is passed explicitly because `--package-root` has already been
// stripped from it; citty would otherwise re-read the unfiltered process.argv
// and reject the flag as unknown.
await runMain(main, { rawArgs: argv })
