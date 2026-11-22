/**
 * The bootstrap decision: "run me, or hand off?"
 *
 * `dist/bin.js` is the published `bin`, so it runs on EVERY invocation — including
 * the ~13 per-turn Claude Code hooks. That makes this file's job narrow and its
 * cost budget tight: decide in a few milliseconds, then get out of the way.
 *
 * The decision itself is pure (`decideBootstrap` takes its inputs, returns a
 * plan), because the alternative — asserting behaviour by spawning the real CLI
 * and parsing logs — cannot reach the interesting cases (a managed pointer whose
 * payload was reaped, a re-exec that must preserve a signal death).
 *
 * ### Why re-exec instead of adopting in-process
 *
 * `main.ts` prints the banner (`:45`) and computes the version (`:16`) at module
 * scope, so an in-process adoption could only happen *after* the npx copy had
 * already evaluated citty/consola and printed its own banner: two banners, two
 * module graphs, and duplicated singletons (`state.ts`, `mcp-inflight.ts`, the
 * keep-awake refcount, the launch registry). Rewriting `argv[1]` first is worse —
 * it mutates a global before a fallible import, leaving argv pointing into the
 * managed tree while npx code runs.
 *
 * Re-exec makes `argv[1]` correct by construction, so `packageRoot()`,
 * `currentInvocation()`, and the self-respawn sites need no changes at all. The
 * cost is one extra runtime start (~40 ms) against a solved 3 s problem.
 *
 * ### The three things that must NOT re-exec
 *
 * - **`internal-*` subcommands.** They run per turn; an extra hop each time is a
 *   fifth of a second per turn, and they must run the code the session already
 *   validated rather than whatever is live now.
 * - **`update`.** It is the repair tool. Bootstrapping it would make a broken
 *   pointer unrepairable, and the background child re-entering this file would
 *   spawn itself forever.
 * - **A missing/nonexistent payload.** Falling back to the current tree is always
 *   correct; re-exec into a hole is not.
 */

import path from "node:path"

import { classifyEntry, shouldAdoptFor } from "./origin"
import { readPointer } from "./pointer"
import { mayAttemptNow, patchInstallState, readInstallState } from "./state"
import { managedInstallDisabled } from "./npm-env"

export type BootstrapPlan =
  /** Run this tree's `main.js` (the normal case for every origin but npx/bunx). */
  | { action: "passthrough"; reason: string }
  /** Hand off to the managed payload at `entryPath`. */
  | { action: "reexec"; entryPath: string; version: string; reason: string }
  /** Run this tree, and queue a background install for the next launch. */
  | { action: "schedule"; reason: string; updaterEntry: string }

/**
 * Subcommands that must never take the hand-off path.
 *
 * `internal-*` is a prefix, not a list: a new hook subcommand added to
 * `main.ts` should inherit the rule without editing this file.
 */
function mustRunInline(subcommand: string | undefined): string | null {
  if (!subcommand) return null
  if (subcommand.startsWith("internal-")) return "internal hook (per-turn hot path)"
  if (subcommand === "update") return "update is the repair tool"
  return null
}

export interface BootstrapInputs {
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Injected so tests need not manipulate `process.argv`. */
  entry?: string
}

/**
 * Decide what `dist/bin.js` should do, given the argv it was started with.
 *
 * Returns `passthrough` for every origin that owns its own tree (`npm-global`,
 * `source`, `managed`, `unknown`): user decision 4 is that a global install is
 * never duplicated, and a dev checkout must run its own code.
 */
export async function decideBootstrap(inputs: BootstrapInputs): Promise<BootstrapPlan> {
  const env = inputs.env ?? process.env
  const argv = inputs.argv
  // The first non-flag token is the subcommand, which is exactly what citty does
  // (`findSubCommandIndex`): the ROOT command declares no `args`, so there is no
  // global flag that takes a value and no value can be mistaken for a name. A
  // value flag added to the root would have to be taught here too — this mirrors
  // citty rather than guessing, because guessing wrong disables the hand-off.
  //
  // `--` ends option parsing (citty stops there as well), so anything after it is
  // an operand: `github-router -- update` must not be read as the repair command.
  const terminator = argv.indexOf("--")
  const positional = terminator >= 0 ? argv.slice(0, terminator) : argv
  const subcommand = positional.find((arg) => !arg.startsWith("-"))

  if (managedInstallDisabled(env)) {
    return { action: "passthrough", reason: "GH_ROUTER_NO_MANAGED_INSTALL is set" }
  }
  if (argv.includes("--no-managed-install")) {
    return { action: "passthrough", reason: "--no-managed-install" }
  }
  // The detached child this file spawns must not bootstrap again, or it would
  // classify the same npx tree, see the same missing pointer, and spawn forever.
  if (env.GH_ROUTER_MANAGED_BACKGROUND === "1") {
    return { action: "passthrough", reason: "background child; bootstrap already decided" }
  }
  const inline = mustRunInline(subcommand)
  if (inline) return { action: "passthrough", reason: inline }

  // Classify the entry that is actually running, not `process.argv[1]`: they are
  // the same in production (this file IS argv[1]), but keeping it explicit is
  // what makes the matrix testable without respawning the runner.
  const entry = inputs.entry ?? argvEntry()
  const origin = await classifyEntry(entry)
  // `managed` short-circuits BEFORE the pointer is read, so a mis-pointed
  // pointer can never cost an exec loop — which is exactly the failure a
  // "resolve bin from package.json" design would have produced, since the bin
  // is this file.
  if (origin.origin === "managed") {
    return { action: "passthrough", reason: "already running from the managed tree" }
  }
  if (!shouldAdoptFor(origin.origin)) {
    return { action: "passthrough", reason: `origin is ${origin.origin}; this tree owns itself` }
  }

  const pointer = await readPointer("self")
  if (pointer) {
    return {
      action: "reexec",
      entryPath: pointer.entryPath,
      version: pointer.version,
      reason: `managed ${pointer.version} is live`,
    }
  }

  if (!entry) return { action: "passthrough", reason: "no argv[1]; cannot schedule an install" }

  const state = await readInstallState("self")
  if (!mayAttemptNow(state)) {
    return {
      action: "passthrough",
      reason: `managed install backing off until ${state.nextAttemptAt}`,
    }
  }
  return { action: "schedule", reason: "no managed install yet", updaterEntry: entry }
}

/** `process.argv[1]` when it looks usable. */
export function argvEntry(): string | undefined {
  const entry = process.argv[1]
  return typeof entry === "string" && entry.length > 0 && path.isAbsolute(entry) ? entry : undefined
}

/**
 * Reserve a background attempt and stamp the origin.
 *
 * Written BEFORE the spawn (optimistic) so a second `npx github-router@latest`
 * a minute later sees the reservation and waits, instead of starting a competing
 * npm install over the same prefix.
 *
 * Deliberately NOT `nextAttemptAt`: a reservation must never become a backoff
 * window, or a spawn that fails outright (ENOMEM, a deleted `process.execPath`)
 * would silence the next launch for an hour without npm ever having run. The
 * cheap-and-honest split is: this file records only that an attempt was QUEUED
 * (`lastAttemptAt`, `lastOrigin`), and the child records success or failure when
 * it has something real to report. Stamp-per-spawn would move the write after the
 * spawn it is supposed to guard (a rival launch can win that window), and buys
 * nothing the model above does not already give.
 */
export async function reserveBackgroundAttempt(origin: string): Promise<void> {
  // A PATCH, never `{...snapshot, ...}`: this runs after an `npm view` that can
  // take seconds, and spreading a stale snapshot would resurrect fields another
  // process cleared meanwhile (`npmProbe` — losing it costs a 250 ms subprocess
  // on every later launch).
  await patchInstallState("self", {
    lastAttemptAt: new Date().toISOString(),
    lastOrigin: origin,
  })
}

/**
 * The argv the detached background child runs. Exported so a test can pin it.
 *
 * `--no-optional` is deliberate: the optional payloads are up to 547 MB, and a
 * detached child that the user never sees must not start downloading them. They
 * are installed by an explicit `github-router update` (or on demand, from the
 * feature that needs one).
 */
export const BACKGROUND_UPDATE_ARGS = ["update", "--self", "--quiet", "--no-optional"] as const
