#!/usr/bin/env node

/**
 * The published `bin` entry — `dist/bin.js`.
 *
 * Runs on every invocation, including the ~13 per-turn Claude Code hooks, so it
 * must be cheap and must never change behaviour for a tree that owns itself.
 * `lib/managed-install/bootstrap.ts` holds the whole decision (and its rationale);
 * this file only executes the plan.
 *
 * Two mechanical constraints on the code below:
 *
 * 1. **`main.js` is imported DYNAMICALLY and by a computed specifier.** A static
 *    `import "./main.js"` would be folded into this bundle by tsdown, which would
 *    make `dist/bin.js` the entire 40 MB app and defeat the point of a bootstrap
 *    that can hand off before the app graph loads. The computed string keeps it a
 *    runtime import.
 * 2. **Nothing here throws.** A bootstrap failure must degrade to "run this
 *    tree", never to "the CLI is broken". Every step is wrapped, and the fallback
 *    is always `import` of this tree's own entry.
 */

import { spawn } from "node:child_process"

import {
  BACKGROUND_UPDATE_ARGS,
  argvEntry,
  decideBootstrap,
  reserveBackgroundAttempt,
} from "./lib/managed-install/bootstrap"
import { classifyOrigin } from "./lib/managed-install/origin"

/** `SIGINT`→2 etc., for the 128+n convention when a re-raise is not possible. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
}

/**
 * Run this tree's real entry.
 *
 * The specifier is built at RUNTIME from `import.meta.url`, and that is not
 * decoration: a literal `import("./main.js")` — or even `./${"main"}.js`, which
 * rolldown folds statically — is inlined by the bundler, which turns
 * `dist/bin.js` into a second copy of the whole app (measured: 13.4 MB and the
 * full tree-sitter/transformers graph). A `URL` is opaque to the bundler, so the
 * import stays a real runtime module load and `dist/bin.js` stays a few KB.
 */
async function runThisTree(): Promise<void> {
  const specifier = new URL("./main.js", import.meta.url).href
  await import(specifier)
}

/**
 * Hand off to the managed payload.
 *
 * Re-exec rather than in-process adoption: `main.ts` prints its banner and reads
 * its version at module scope, so adopting after this module has already been
 * evaluated would print two banners and evaluate two module graphs. `stdio:
 * "inherit"` keeps the caller's pipes (a hook's stdout IS its payload), and the
 * child's exit code and signal are propagated verbatim so a supervisor sees the
 * real outcome.
 */
async function handOff(entryPath: string, version: string): Promise<void> {
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const dropForwarders = (): void => {
    for (const name of SIGNALS) process.removeAllListeners(name)
  }

  // Forwarders FIRST, before the spawn: a signal delivered between `spawn`
  // returning and the handler being installed kills this process with the default
  // disposition and orphans the payload, which for a hook means a child that keeps
  // running after its parent is gone.
  let child: ReturnType<typeof spawn> | null = null
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      try {
        child?.kill(signal)
      } catch {
        // already gone
      }
    })
  }

  try {
    child = spawn(process.execPath, [entryPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      windowsHide: true,
      // Diagnostic marker only — nothing branches on it. It answers "was this
      // process started by the bootstrap or straight from the payload?" in a bug
      // report, which is otherwise indistinguishable once the banner is printed.
      env: { ...process.env, GH_ROUTER_MANAGED_HANDOFF: version },
    })
  } catch (err) {
    dropForwarders()
    throw err
  }

  await new Promise<void>((resolve, reject) => {
    // A hand-off that never started must leave NO forwarders behind either: the
    // caller's fallback (`runThisTree`) would then run with SIGINT/SIGTERM
    // absorbed by a handler whose child is gone, so Ctrl-C would do nothing and
    // the process would exit 0 — the same hazard as the re-raise below.
    child.on("error", (err) => {
      dropForwarders()
      reject(err)
    })
    child.on("exit", (code, signal) => {
      // It exits once. Leaving the forwarders installed after a normal exit makes
      // the rest of this process deaf to Ctrl-C for no reason.
      dropForwarders()
      if (signal) {
        // Mirror a signal death so the caller can distinguish "crashed" from
        // "exited 1". Shells expect 128+signal, so set that too in case the
        // re-raise cannot happen (a signal with no default action, or a
        // platform that refuses).

        process.exitCode = 128 + (SIGNAL_NUMBERS[signal] ?? 0)
        try {
          process.kill(process.pid, signal)
          return
        } catch {
          resolve()
          return
        }
      }
      process.exitCode = typeof code === "number" ? code : 1
      resolve()
    })
  })
}

/**
 * Queue the background install.
 *
 * Detached and unref'd: this launch must not be delayed by, or kept alive for, an
 * npm install. The child is `node <this entry> update --self --quiet`, which
 * reaches the same code with `GH_ROUTER_MANAGED_BACKGROUND=1` so it cannot recurse
 * into another spawn.
 */
function scheduleBackgroundInstall(entry: string): void {
  try {
    const child = spawn(process.execPath, [entry, ...BACKGROUND_UPDATE_ARGS], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, GH_ROUTER_MANAGED_BACKGROUND: "1" },
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never fatal: the next launch tries again.
  }
}

async function main(): Promise<void> {
  let plan
  try {
    plan = await decideBootstrap({ argv: process.argv.slice(2), entry: argvEntry() })
  } catch {
    // Any failure in classification means "do not get clever".
    await runThisTree()
    return
  }

  if (plan.action === "reexec") {
    try {
      await handOff(plan.entryPath, plan.version)
      return
    } catch {
      // A payload that cannot be started is a broken install, not a broken
      // launch: run this tree instead and let the next background attempt fix it.
      await runThisTree()
      return
    }
  }

  if (plan.action === "schedule") {
    // Reserve BEFORE spawning so a second concurrent launch backs off instead of
    // starting a competing install over the same prefix. Best effort.
    try {
      const origin = await classifyOrigin()
      await reserveBackgroundAttempt(origin.origin)
    } catch {
      // Reservation is an optimisation; the install itself re-checks its lock.
    }
    scheduleBackgroundInstall(plan.updaterEntry)
  }

  await runThisTree()
}

/**
 * Top-level guard.
 *
 * `runThisTree` is the one thing that must happen; if the bootstrap itself is
 * broken (an unreadable app dir, a corrupt state file that somehow throws), the
 * user still gets a working CLI. Deliberately `console.error` rather than
 * `consola`: the app graph has not loaded yet and pulling it in here would
 * reintroduce the double-instance hazard.
 */
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`github-router: bootstrap fell back to this tree (${message})`)
  process.exitCode = 1
})
