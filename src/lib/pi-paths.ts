import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

function appDir(): string {
  return path.join(os.homedir(), ".local", "share", "github-router")
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
 * Provision the per-launch Pi mirror: snapshot-copy the user's real Pi
 * agent dir (settings, models, skills, prompts, extensions the user owns)
 * so the spawned `pi` starts from the user's own setup, then let the
 * launcher overlay the mode's generated files on top.
 *
 * Copy failures of individual user files are debug-logged and skipped —
 * a corrupt user file must not strand the launch. Throws only when the
 * mirror directory itself cannot be created.
 */
export async function ensurePiAgentMirror(): Promise<string> {
  const mirror = piMirrorDir()
  await fs.mkdir(mirror, { recursive: true })
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
  // isolation boundary).
  const SKIP = new Set(["auth.json", "sessions", "models-store.json"])
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
