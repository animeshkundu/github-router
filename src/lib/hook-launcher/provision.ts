/**
 * Publish the self-contained hook launcher (`dist/hooks.mjs`) to a stable,
 * content-addressed path under `<APP_DIR>/hooks/`.
 *
 * Why this exists: `github-router claude` persists Claude Code hook commands
 * into a settings.json that outlives the process that wrote it, built from
 * `process.argv[1]`. Under `bunx` that path is inside `$TMPDIR`, and macOS's
 * per-user temp reaper deletes files there (keeping the directory skeleton) —
 * so `node <tmp>/…/dist/main.js` died on its first bare import with
 * `ERR_MODULE_NOT_FOUND` and EVERY hook in a long-running session failed until
 * the tree happened to be re-extracted. `bunx pkg@latest` also re-extracts in
 * place whenever npm's `latest` advances, so a live session's hooks could
 * silently start executing a different version's code.
 *
 * Deliberate departures from `provisionBrowserAssets()`, which this otherwise
 * mirrors:
 *
 *   - **Content-addressed, immutable names.** The digest IS the filename, so a
 *     new build never overwrites an old launcher and there is nothing to
 *     garbage-collect. Version-keyed names would need GC, and GC across
 *     concurrent proxies is a race: proxy N deleting N+1's launcher (or the
 *     reverse) breaks a live session's hooks. At ~1.5 MB, keeping stale
 *     launchers costs less than the race would.
 *
 *   - **The source is verified before it is published.** Hashing the bytes
 *     read from `dist/hooks.mjs` only identifies those bytes; it does not
 *     prove they are a complete artifact. A concurrent in-place `bunx`
 *     extraction can hand over a truncated file, which content-addressing
 *     would happily preserve forever under its own hash. The build writes a
 *     `dist/hooks.sha256` sidecar and we publish only on a match.
 *
 *   - **Failures are not latched.** A transient `EBUSY` (Windows antivirus, a
 *     concurrent reader) must not disable provisioning for the process
 *     lifetime, so only success is cached.
 *
 * Never throws: the caller degrades to `process.argv[1]` with a visible
 * warning rather than failing the launch.
 */

import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import consola from "consola"

import { PATHS } from "../paths"

/** Sidecar written by `scripts/stamp-hooks-digest.ts` next to the bundle. */
const DIGEST_SIDECAR = "hooks.sha256"

/** Basename of the built launcher bundle. */
const BUNDLE_NAME = "hooks.mjs"

/**
 * Publish retries. A rename can lose a race with another proxy publishing the
 * same digest, or hit a Windows sharing violation while an antivirus scanner
 * holds the temp file. Both clear in milliseconds.
 */
const PUBLISH_ATTEMPTS = 3

let _published: string | undefined
let _inFlight: Promise<string | undefined> | undefined

/** @internal — reset module state between test cases. */
export function __resetHookLauncherForTests(): void {
  _published = undefined
  _inFlight = undefined
}

/**
 * Resolve the built bundle that sits beside the running code.
 *
 * In a built layout every chunk lives in `dist/`, so a sibling lookup finds
 * `dist/hooks.mjs`. Running from source it resolves to
 * `src/lib/hook-launcher/hooks.mjs`, which does not exist — which is exactly
 * the wanted behaviour: a `bun run dev` session must keep using
 * `process.argv[1]` rather than silently adopting a stale bundle from some
 * earlier build.
 */
function bundledLauncherPath(): string | undefined {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), BUNDLE_NAME)
  } catch {
    return undefined
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

/**
 * Read the build's expected digest. Absent or malformed means "cannot verify",
 * which is treated as a refusal to publish rather than as permission to skip
 * the check — an unverified source is the one thing content-addressing cannot
 * recover from.
 */
function expectedDigest(bundlePath: string): string | undefined {
  try {
    const raw = readFileSync(
      path.join(path.dirname(bundlePath), DIGEST_SIDECAR),
      "utf8",
    ).trim()
    return /^[0-9a-f]{64}$/.test(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/** True when `target` already holds exactly the bytes its name claims. */
function targetIsValid(target: string, digest: string): boolean {
  try {
    return sha256(readFileSync(target)) === digest
  } catch {
    return false
  }
}

/**
 * Write `bytes` to `target` via a unique same-directory temp file plus a
 * rename, so a crash mid-write can never leave a partial file under the name
 * a hook command points at.
 *
 * The target is never deleted first: on Windows that would open a window where
 * a concurrently-launching session finds no launcher at all. A rename onto an
 * existing path can fail there, so a losing racer validates what the winner
 * wrote and accepts it.
 */
function publish(target: string, bytes: Buffer, digest: string): boolean {
  // Checked once up front rather than per attempt: validation re-hashes ~1.5 MB
  // and the retries exist for rename contention, which revalidating cannot fix.
  if (targetIsValid(target, digest)) return true
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    const tmp = `${target}.${process.pid}-${attempt}.tmp`
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 })
      renameSync(tmp, target)
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Best-effort. A Windows sharing violation can strand the temp file;
        // `sweepStaleLaunchers` reaps it later rather than leaking 1.5 MB.
      }
    }
  }
  return targetIsValid(target, digest)
}

/** A stranded publish temp is dead well inside this. */
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Launchers older than this are reaped. Generous on purpose — see the residual
 * risk in `sweepStaleLaunchers`.
 */
const LAUNCHER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Reap stranded publish temps and long-unused launchers.
 *
 * Without this the directory grows by ~1.5 MB per shipped version forever, and
 * this project ships a patch release per PR with self-update on by default.
 *
 * The immutable content-addressed naming exists to avoid a GC race, so the
 * sweep is built to not reintroduce one: it never touches the digest THIS
 * launch resolved, and every launch refreshes its own launcher's mtime, so a
 * file survives for as long as some proxy keeps launching against it. Residual
 * risk, stated plainly: a single proxy running continuously for more than 30
 * days without relaunching could have its launcher reaped by a newer proxy.
 * That is bounded and far rarer than the unbounded growth it prevents, but it
 * is not zero — a PID-liveness marker would close it if it ever bites.
 */
function sweepStaleLaunchers(dir: string, keep: string): void {
  const now = Date.now()
  let entries: Array<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === path.basename(keep)) continue
    const isTmp = name.endsWith(".tmp")
    // Strict shape match, like sweepAgedWorkerDiffs: this directory is ours,
    // but a name-shape check means a false positive can only ever cost a file
    // the next launch regenerates.
    const isLauncher = /^hooks-[0-9a-f]{64}\.mjs$/.test(name)
    if (!isTmp && !isLauncher) continue
    const target = path.join(dir, name)
    try {
      const age = now - statSync(target).mtimeMs
      if (age > (isTmp ? TMP_MAX_AGE_MS : LAUNCHER_MAX_AGE_MS)) {
        rmSync(target, { force: true })
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Materialize the launcher and return its stable absolute path, or undefined
 * when it could not be published (running from source, bundle missing or
 * unverifiable, filesystem refusing the write).
 *
 * Single-flight so the startup call and any lazy caller collapse to one run.
 */
export function provisionHookLauncher(): Promise<string | undefined> {
  if (_published) return Promise.resolve(_published)
  if (_inFlight) return _inFlight
  _inFlight = Promise.resolve()
    .then(() => provisionImpl())
    .then((result) => {
      // Cache SUCCESS only. Latching a transient failure would disable the
      // stable launcher for the whole process lifetime.
      if (result) _published = result
      return result
    })
    .finally(() => {
      _inFlight = undefined
    })
  return _inFlight
}

function provisionImpl(): string | undefined {
  const bundlePath = bundledLauncherPath()
  if (!bundlePath) return undefined
  return publishLauncherFrom(bundlePath)
}

/**
 * Verify and publish one specific bundle. Split out from the source resolution
 * above so the publication semantics are testable: running from source,
 * `bundledLauncherPath()` deliberately points at a file that does not exist,
 * which is the right behaviour but leaves nothing to exercise.
 *
 * @internal — production callers go through `provisionHookLauncher()`.
 */
export function publishLauncherFrom(bundlePath: string): string | undefined {
  try {
    let bytes: Buffer
    try {
      bytes = readFileSync(bundlePath)
    } catch {
      // Running from source, or the package tree was reaped out from under us.
      // Either way there is nothing to publish; a launcher published by an
      // earlier launch still stands.
      return undefined
    }

    const digest = sha256(bytes)
    const expected = expectedDigest(bundlePath)
    if (!expected) {
      // "Cannot verify" and "verified bad" both mean do-not-publish. Treating
      // an absent sidecar as permission would delete the integrity check in
      // exactly the degraded conditions it exists for.
      consola.debug(
        "[hook-launcher] no digest sidecar beside the bundle; not publishing",
      )
      return undefined
    }
    if (expected !== digest) {
      // The classic cause is reading mid-`bunx`-re-extraction. Publishing here
      // would freeze a torn bundle under a stable name forever, because
      // content-addressing gives a truncated file its own perfectly valid hash.
      consola.debug(
        "[hook-launcher] bundle digest does not match the build; not publishing",
      )
      return undefined
    }

    const dir = PATHS.HOOK_LAUNCHER_DIR
    // 0o700 / 0o600, matching the convention for the runtime dir in paths.ts.
    // This is not incidental hygiene: the published file is EXECUTED by node on
    // every prompt of every session, so a group- or world-writable path here
    // would let a local attacker swap the launcher and run code inside the
    // user's agent. chmod is best-effort — it is a no-op on Windows, where the
    // ACL inherited from APP_DIR governs.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* best-effort: Windows, or a dir we do not own */
    }
    const target = path.join(dir, `hooks-${digest}.mjs`)
    if (!publish(target, bytes, digest)) return undefined

    // Mark this launcher as still in use before sweeping, so a long-lived
    // install that keeps relaunching against an old version is never reaped by
    // a newer proxy's sweep.
    try {
      const now = new Date()
      utimesSync(target, now, now)
    } catch {
      /* best-effort */
    }
    sweepStaleLaunchers(dir, target)
    return target
  } catch (err) {
    consola.debug("[hook-launcher] provisioning skipped:", err)
    return undefined
  }
}
