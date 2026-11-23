import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

// Only the env predicate, no path helpers: `pi-package-cache` imports `PATHS`
// from `./paths`, so this edge cannot close a cycle back onto this module.
import { piPackageCacheEnabled } from "./pi-package-cache"
import { PATHS } from "./paths"

/**
 * The app-data root, taken from the ONE resolver in `paths.ts`.
 *
 * This module used to carry its own `os.homedir()/"..."/github-router` copy,
 * which silently ignored `GH_ROUTER_APP_DIR`. That was survivable while
 * everything here was per-launch scratch, but the package cache made it a
 * correctness bug: `piPackageCacheDir` honours the override and lands under
 * `<override>/pi-packages`, while mirrors stayed under `~/.local/share`, so
 * the cache's in-use scan looked for other launches in a directory nothing
 * writes to and could never see one. Two resolvers for one directory is the
 * bug; `paths.ts` documents the same hazard for the managed install.
 */
function appDir(): string {
  return PATHS.APP_DIR
}

/** Where the user's real Pi agent dir lives (`PI_CODING_AGENT_DIR` wins). */
export function userPiAgentDir(): string {
  const override = (process.env.PI_CODING_AGENT_DIR ?? "").trim()
  if (override.length > 0) return override
  return path.join(os.homedir(), ".pi", "agent")
}

/**
 * Per-launch suffix for the Pi mirror. Lazily generated once per process
 * so every path getter in this module agrees on the directory.
 */
let launchSuffix: string | undefined

function perLaunchSuffix(): string {
  launchSuffix ??= `pi-agent-${process.pid}-${randomBytes(4).toString("hex")}`
  return launchSuffix
}

/** Router-owned, per-launch Pi agent dir for the spawned `pi` child. */
export function piMirrorDir(): string {
  return path.join(appDir(), "pi-mirrors", perLaunchSuffix())
}

/**
 * Router-owned, durable Pi session store, shared by every launch.
 *
 * Pi's default session root is `<agent dir>/sessions/`, and the agent dir is
 * the per-launch mirror we delete on shutdown, so quitting used to take the
 * whole transcript history with it and `--continue` / `--resume` had nothing
 * left to resume. One stable root, handed to the child as
 * `PI_CODING_AGENT_SESSION_DIR`, outlives every launch. Pi groups sessions by
 * working directory under that root, so per-workspace history stays separate
 * and `--continue` still picks the right one.
 *
 * Deliberately outside `sweepStalePiAgentMirrors`: that sweep reaps mirrors by
 * PID because they are scratch, and this directory is history. Nothing here
 * ages it out either — Pi documents no retention policy, and the session
 * picker's delete is the user-facing pruning surface.
 */
export function piSessionsDir(): string {
  return path.join(appDir(), "pi-sessions")
}

/**
 * Provision the per-launch Pi mirror: snapshot-copy the user's real Pi
 * agent dir (settings, models, skills, prompts, extensions the user owns)
 * so the spawned `pi` starts from the user's own setup, then let the
 * launcher overlay the mode's generated files on top.
 *
 * Copy failures of individual user files are debug-logged and skipped —
 * a corrupt user file must not strand the launch. Throws only when the
 * mirror directory itself cannot be created.
 *
 * `npm/` is the one entry this copy does NOT own when the package cache is
 * on: `seedPiPackageCache` replaces `<mirror>/npm` with a link into the
 * durable cache, so copying the user's own `npm` tree there first would be a
 * full 27 s copy (88 MB / 14.6k files, measured) of a tree deleted moments
 * later. With the cache disabled the copy stays, because nothing else would
 * populate that path.
 */
export async function ensurePiAgentMirror(): Promise<string> {
  const mirror = piMirrorDir()
  await fs.mkdir(mirror, { recursive: true })
  // The session root sits outside the mirror and survives it, so it is not
  // created by the copy below. Make it here rather than leaving Pi to create
  // it on first save: `--continue` on a fresh install then resolves against a
  // real (empty) directory instead of an absent one.
  await fs.mkdir(piSessionsDir(), { recursive: true })
  const source = userPiAgentDir()
  let entries: Array<string>
  try {
    entries = await fs.readdir(source)
  } catch {
    // No user Pi dir yet (fresh machine) — the mirror starts empty and
    // the launcher writes every file Pi needs.
    return mirror
  }
  // Snapshot user-owned resources; never auth.json (credentials stay the
  // user's — Pi resolves its dummy/provider key from our generated
  // models.json, and copying OAuth tokens into a swept dir risks stranding
  // them), never sessions/ (per-project history must not leak across the
  // isolation boundary), never models-store.json. User `extensions/` are
  // excluded by default: third-party workflow orchestrators (background
  // lanes / preflight tools) otherwise ride into the cost-controlled
  // profile and break its fixed roster contract. Opt back in with
  // GH_ROUTER_PI_KEEP_USER_EXTENSIONS=1.
  const keepUserExtensions = process.env.GH_ROUTER_PI_KEEP_USER_EXTENSIONS === "1"
  // The launcher owns `<mirror>/npm` when the cache is on (it becomes a link
  // into the durable entry), so mirroring the user's npm tree there would be a
  // full 27 s copy of a tree we are about to replace.
  const cacheOwnsNpm = piPackageCacheEnabled()
  const SKIP = new Set([
    "auth.json",
    "sessions",
    "models-store.json",
    ...(keepUserExtensions ? [] : ["extensions"]),
    ...(cacheOwnsNpm ? ["npm"] : []),
  ])
  await Promise.all(
    entries
      .filter((e) => !SKIP.has(e))
      .map(async (entry) => {
        try {
          await fs.cp(path.join(source, entry), path.join(mirror, entry), {
            recursive: true,
          })
        } catch (err) {
          consola.debug(`Pi mirror: skipping ${entry}:`, err)
        }
      }),
  )
  return mirror
}

/** Remove THIS launch's Pi mirror on shutdown. Best-effort, never throws. */
export async function removeOwnPiAgentMirror(): Promise<void> {
  try {
    await fs.rm(piMirrorDir(), { recursive: true, force: true })
  } catch (err) {
    consola.debug("Pi mirror cleanup failed:", err)
  }
}

/**
 * Sweep stale Pi mirrors left behind by crashed launches (dirs whose PID
 * no longer exists, or older than 24h). Best-effort, never throws.
 */
export async function sweepStalePiAgentMirrors(): Promise<void> {
  const root = path.join(appDir(), "pi-mirrors")
  let entries: Array<string>
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const dir = path.join(root, entry)
      try {
        const stat = await fs.stat(dir)
        const ageMs = Date.now() - stat.mtimeMs
        const pidMatch = /^pi-agent-(\d+)-[0-9a-f]+$/.exec(entry)
        let dead = ageMs > 24 * 3600 * 1000
        if (pidMatch && !dead) {
          const pid = Number.parseInt(pidMatch[1], 10)
          try {
            process.kill(pid, 0)
          } catch {
            dead = true // ESRCH — PID is gone
          }
        }
        if (dead) await fs.rm(dir, { recursive: true, force: true })
      } catch (err) {
        consola.debug(`Pi mirror sweep: skipping ${entry}:`, err)
      }
    }),
  )
}
