/**
 * "What version should be live, and how do I get there?"
 *
 * The installer (`install.ts`) knows how to put an exact version on disk; this
 * module knows which exact version to ask for and how often to ask. Three
 * decisions here were forced by measurement, not taste:
 *
 * 1. **The installed version is authoritative, never the requested one.** A
 *    corporate mirror, `min-release-age`, or a `latest` tag pointing at an older
 *    release all make `npm view` disagree with what the tarball actually is. If
 *    the update loop trusted its own request, it would queue the same install
 *    forever: request `1.2.4`, get `1.2.3`, pointer still says `1.2.3`, next hour
 *    request `1.2.4` again. So after an install we re-read the pointer and adopt
 *    whatever landed.
 * 2. **A version already on disk is adopted without npm.** That covers
 *    `update --version <v>` for a version that is present, a lost/restored
 *    pointer, and the second of two racing installers. `rename` onto a non-empty
 *    directory is `ENOTEMPTY`, so this is also what keeps the common case from
 *    ever reaching a rename at all.
 * 3. **Background work is throttled and detached.** A launch must never wait on
 *    npm, and a short-lived command (`--version`) must not be held open by an
 *    install either. So the background path is a DETACHED child running
 *    `update --self --quiet`, unref'd, with its own throttle in
 *    `install-state.json`.
 */

import consola from "consola"

import { spawn } from "node:child_process"

import { resolveExecutable, runCommandCapture } from "../exec"
import { type InstallOutcome, ensureManagedInstall, gcManaged } from "./install"
import { describeOrigin, classifyOrigin } from "./origin"
import { type ManagedKind, launcherPath, npmPackageFor } from "./paths"
import { managedInstallDisabled } from "./npm-env"
import { readInstalledMarker, readPointer } from "./pointer"
import { ensureLauncher } from "./launcher"
import { mayAttemptNow, patchInstallState, readInstallState } from "./state"
import { ensureShims, pathHint } from "./shim"

/** 5 s is enough for `npm view` and short enough not to notice. */
const NPM_VIEW_TIMEOUT_MS = 8000

export interface UpdateCheck {
  kind: ManagedKind
  installedVersion: string | null
  latestVersion: string | null
  /** Exact version that would be installed/adopted. */
  targetVersion: string | null
  upToDate: boolean
  registry: string | null
  entryPath: string | null
}

/**
 * Registry for a kind.
 *
 * Pi has its own resolution rule (`resolvePiRegistry()`), and it is not a detail
 * we can inherit here: a lagging corporate mirror below `PI_MIN_VERSION` makes
 * the floor unreachable, which was a real install loop. `self` uses the user's
 * configured registry, which is what they expect for the router itself.
 */
export async function registryFor(kind: ManagedKind): Promise<string | null> {
  if (kind === "pi") {
    // Imported lazily: `pi-version-check` pulls `consola` and the Pi graph, and
    // this module is reachable from the bootstrap.
    const { resolvePiRegistry } = await import("../pi-version-check")
    return resolvePiRegistry()
  }
  return null
}

/** `npm view <pkg> version`, or `null` when npm is absent/offline. */
export async function fetchLatestVersion(kind: ManagedKind): Promise<string | null> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return null
  const registry = await registryFor(kind)
  const args = [npmPath, "view", npmPackageFor(kind), "version", "--silent"]
  if (registry) args.push(`--registry=${registry}`)
  try {
    const { stdout, code } = await runCommandCapture(args, { timeoutMs: NPM_VIEW_TIMEOUT_MS })
    if (code !== 0) return null
    const value = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ""
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : null
  } catch {
    return null
  }
}

/** Compare two semver-shaped strings on the leading `X.Y.Z`. */
export function isNewerVersion(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false
  const a = installed.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  const b = latest.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const av = Number.isNaN(a[i]) ? 0 : (a[i] ?? 0)
    const bv = Number.isNaN(b[i]) ? 0 : (b[i] ?? 0)
    if (av < bv) return true
    if (av > bv) return false
  }
  return false
}

/** What is live right now for `kind`, if anything. */
export async function currentManagedVersion(kind: ManagedKind): Promise<string | null> {
  const pointer = await readPointer(kind, { verifyEntry: false })
  return pointer?.version ?? null
}

/**
 * Compute the desired state without changing anything.
 *
 * `--check` uses this, and so does the background path (to decide whether to
 * spawn at all): a launch that only needs to know "am I current" must not write
 * the pointer, install a launcher, or touch npm's tree.
 */
export async function checkForUpdate(
  kind: ManagedKind,
  opts: { version?: string; force?: boolean } = {},
): Promise<UpdateCheck> {
  const pointer = await readPointer(kind, { verifyEntry: false })
  const installedVersion = pointer?.version ?? null
  const latestVersion = opts.version ?? (await fetchLatestVersion(kind))
  const targetVersion = opts.version ?? latestVersion
  // Only when there IS an installed version: passing `""` reads the kind-root
  // `.installed.json`, which is not a thing, and only a version-mismatch guard
  // made that harmless.
  const marker = installedVersion ? await readInstalledMarker(kind, installedVersion) : null
  return {
    kind,
    installedVersion,
    latestVersion,
    targetVersion,
    upToDate:
      targetVersion !== null && installedVersion !== null
      && targetVersion === installedVersion && (await readPointer(kind)) !== null,
    registry: marker?.registry ?? (await registryFor(kind)),
    entryPath: pointer?.entryPath ?? null,
  }
}

export interface UpdateOptions {
  kind: ManagedKind
  /** Exact version to install. Defaults to npm's `latest`. */
  version?: string
  /** Ignore the backoff window and reinstall even if the version matches. */
  force?: boolean
  /** Report only; never install, never write. */
  check?: boolean
  signal?: AbortSignal
}

export interface UpdateReport {
  check: UpdateCheck
  /** What actually happened. Absent for `--check`. */
  outcome?: InstallOutcome
  launcher?: { path: string; written: boolean }
  shims?: Array<{ path: string; outcome: string }>
  /** One-line PATH instruction when the shim dir is not on PATH. */
  pathHint?: string | null
  gc?: {
    removedVersions: Array<string>
    removedStaging: Array<string>
    removedTransient: Array<string>
  }
}

/**
 * Bring `kind` up to date: install (or adopt) the target version, publish the
 * pointer, then make the stable surface point at it.
 *
 * Order matters and is deliberate: the payload and pointer land FIRST, and the
 * launcher/shims are refreshed after. A launcher written before a failed install
 * would still be correct (it reads the pointer), but a shim written before the
 * pointer exists would advertise a managed install that is not there.
 */
export async function runManagedUpdate(opts: UpdateOptions): Promise<UpdateReport> {
  const registry = await registryFor(opts.kind)
  const check = await checkForUpdate(opts.kind, { version: opts.version, force: opts.force })
  if (opts.check) return { check }

  const target = check.targetVersion
  if (!target) {
    return {
      check,
      outcome: {
        kind: "failed",
        version: null,
        detail:
          "could not determine a version to install (npm view failed). Check your connection/registry, or pass --version.",
      },
    }
  }

  const outcome = await ensureManagedInstall({
    kind: opts.kind,
    version: target,
    force: opts.force,
    registry: registry ?? undefined,
    signal: opts.signal,
  })

  // GC runs on FAILURE TOO, not just after a successful install. A failed
  // install is precisely what leaves `.staging-*` behind, and the backoff ladder
  // (1 h → 6 h → 24 h) means a machine that keeps failing may never reach a
  // successful install to sweep it. `gcManaged` protects the pointer's version,
  // the two newest, and anything younger than 7 days, so it cannot race an
  // install that is actually in progress — and it is skipped outright when the
  // install lock is held, because the lock holder will sweep after itself.
  const gc = await gcUnderLock(opts.kind)

  if (outcome.kind !== "installed" && outcome.kind !== "adopted") {
    return { check, outcome, gc }
  }

  const launcher = await ensureLauncher(opts.kind)
  const shims = await ensureShims(opts.kind, launcherPath(opts.kind))
  return {
    check: { ...check, installedVersion: outcome.version ?? check.installedVersion, upToDate: true },
    outcome,
    launcher,
    shims,
    pathHint: pathHint(),
    gc,
  }
}

/**
 * Sweep a kind's directory, but only while holding the install lock.
 *
 * Two reasons for the lock, not one: it guarantees we never delete a
 * `.staging-*` that a live install is writing into (those are inside the 1 h TTL
 * anyway, but a slow corporate install can exceed that), and it guarantees we
 * never delete a version dir in the window between `rename` publishing it and
 * the pointer being written. Both are `skipped` conditions rather than errors —
 * the lock holder sweeps after itself.
 */
async function gcUnderLock(kind: ManagedKind): Promise<NonNullable<UpdateReport["gc"]>> {
  const empty: NonNullable<UpdateReport["gc"]> = {
    removedVersions: [],
    removedStaging: [],
    removedTransient: [],
  }
  let captured = empty
  try {
    const { withInstallLockResult } = await import("../update-lock")
    const result = await withInstallLockResult(`managed-${kind}.lock`, async () => {
      const report = await gcManaged(kind)
      captured = {
        removedVersions: report.removedVersions,
        removedStaging: report.removedStaging,
        removedTransient: report.removedTransient,
      }
    })
    return result.outcome === "ran" ? captured : empty
  } catch {
    return empty
  }
}

/**
 * The background entry point for the bootstrap: "install self if it is not
 * installed, and refresh it when a launch notices a newer one".
 *
 * Returns a short description of what it decided, which the bootstrap logs at
 * debug level. Never throws and never blocks: the actual install is a DETACHED
 * child, so even `github-router --version` exits immediately.
 */
export async function scheduleBackgroundSelfInstall(
  opts: { quiet?: boolean } = {},
): Promise<string> {
  // Checked before the origin probe, let alone the `npm view`: with the managed
  // layer switched off there is nothing to schedule, and an 8 s `npm view` plus a
  // detached child that immediately reports "disabled" is a silly price for
  // discovering that.
  if (managedInstallDisabled()) return "managed install is disabled (GH_ROUTER_NO_MANAGED_INSTALL)"

  const origin = await classifyOrigin()
  // Only disposable origins engage. `npm i -g` and a source checkout own their
  // trees (user decision 4) and a managed copy would be a second thing to update.
  if (origin.origin !== "npx" && origin.origin !== "bunx") {
    return `origin is ${describeOrigin(origin.origin)}; managed install not engaged`
  }

  const state = await readInstallState("self")
  if (!mayAttemptNow(state)) {
    return `backing off until ${state.nextAttemptAt} after: ${state.lastError ?? "previous failure"}`
  }

  const pointer = await readPointer("self")
  const installed = pointer?.version ?? null
  const latest = await fetchLatestVersion("self")
  if (latest && installed === latest) return `already at ${installed}`

  // Reserve the attempt before spawning so concurrent launches (and a second
  // npx invocation a minute later) do not each start an npm process. A PATCH,
  // not `{...state, ...}`: the snapshot above was read before an `npm view` that
  // can take seconds, and spreading it would resurrect fields another process
  // cleared in the meantime (`npmProbe`, in particular — losing it costs a
  // 250 ms subprocess on every later launch).
  await patchInstallState("self", {
    lastAttemptAt: new Date().toISOString(),
    lastOrigin: origin.origin,
  })

  const entry = process.argv[1]
  if (typeof entry !== "string" || entry.length === 0) return "no argv[1]; cannot spawn the updater"

  spawnDetachedUpdater(entry, [
    "update",
    "--self",
    // Never pull the optional payloads from a background child: they are up to
    // 547 MB and nobody is watching.
    "--no-optional",
    ...(opts.quiet === false ? [] : ["--quiet"]),
  ])
  return latest ? `queued install of ${latest}` : "no published version visible; launch will run from the current tree"
}

/**
 * The Pi twin of `scheduleBackgroundSelfInstall`.
 *
 * Tighter on purpose: this only ever refreshes a payload that is already live
 * (an install with nothing on disk is the launcher's foreground job, where a
 * failure can be reported to the user), and it never writes a pointer — the
 * detached `update --pi` child does that under the install lock.
 */
export async function scheduleBackgroundPiInstall(): Promise<string> {
  if (managedInstallDisabled()) return "managed install is disabled (GH_ROUTER_NO_MANAGED_INSTALL)"
  const pointer = await readPointer("pi", { verifyEntry: false })
  if (!pointer) return "no managed Pi yet"

  const state = await readInstallState("pi")
  if (!mayAttemptNow(state)) {
    return `backing off until ${state.nextAttemptAt} after: ${state.lastError ?? "previous failure"}`
  }

  const latest = await fetchLatestVersion("pi")
  if (latest && pointer.version === latest) return `already at ${pointer.version}`

  await patchInstallState("pi", { lastAttemptAt: new Date().toISOString() })
  const entry = process.argv[1]
  if (typeof entry !== "string" || entry.length === 0) return "no argv[1]; cannot spawn the updater"
  spawnDetachedUpdater(entry, ["update", "--pi", "--quiet", "--no-optional"])
  return latest ? `queued install of ${latest}` : "no published Pi version visible"
}

/**
 * Spawn a detached `node <entry> <args…>` that outlives this process.
 *
 * Detached and unref'd on purpose. The alternative — doing the install in-process
 * — holds the event loop open, so `github-router --version` would sit there for a
 * minute waiting on npm. A detached child keeps the promise "launch is never
 * delayed by an update", and if it is killed mid-install the staging dir is
 * swept by GC an hour later.
 *
 * `stdio: "ignore"` because the parent's stdio may be a Claude Code hook pipe;
 * writing the child's chatter there would corrupt a hook payload.
 */
export function spawnDetachedUpdater(entry: string, args: Array<string>): boolean {
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, GH_ROUTER_MANAGED_BACKGROUND: "1" },
    })
    child.on("error", () => {})
    child.unref()
    return true
  } catch (err) {
    consola.debug("Could not spawn the background managed install:", err)
    return false
  }
}

