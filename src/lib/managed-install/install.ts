/**
 * The managed installer: put one exact package version into
 * `<APP_DIR>/m/<kind>/<version>/` and point `current.json` at it.
 *
 * The whole design is driven by three measured facts:
 *
 * 1. **`npx github-router@latest` re-extracts ~586 MB per published version**
 *    (16 releases in 31 days; `~/.npm/_npx` was 2.5 GB across 25 directories).
 *    Re-extraction, not re-download, is the 3 s cost — the tarball is cached.
 * 2. **A live npm tree must never be mutated in place.** On Windows
 *    `npm install` over files a process holds open fails `EPERM`/`EBUSY`; this
 *    is why the `-g` path uses a detached post-exit waiter. So publishing is
 *    `rename()` of a fully-built sibling directory, which is atomic and touches
 *    nothing the running process has open.
 * 3. **npm exits 0 on several env-driven no-ops** (`dry_run`, `global`,
 *    `workspaces`, `omit`). See `npm-env.ts` for the table. Verifying the
 *    entry file is therefore mandatory, not defensive.
 *
 * The staging directory lives INSIDE `<kind>/` on purpose: `rename` must be
 * same-directory (no `EXDEV`, and people symlink node_modules-heavy dirs onto
 * other volumes), and a `.`-prefixed name is what GC uses to tell a leftover
 * attempt from a version.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { writeFileAtomic } from "../atomic-file"
import { resolveExecutable, runCommandCapture } from "../exec"
import { withInstallLockResult } from "../update-lock"
import { buildNpmEnv, managedInstallDisabled } from "./npm-env"
import { reportManagedDiagnostic } from "./diagnostics"
import {
  type ManagedKind,
  STAGING_RE,
  TRASH_RE,
  entryRelativeFor,
  isVersionName,
  managedRoot,
  npmPackageFor,
  stagingDir,
  trashDir,
  versionDir,
} from "./paths"
import {
  type InstalledMarker,
  readInstalledMarker,
  readPointer,
  readPointerDetailed,
  removePointer,
  writePointer,
} from "./pointer"
import {
  KEEP_VERSIONS,
  TRANSIENT_TTL_MS,
  VERSION_FLOOR_MS,
  mayAttemptNow,
  nextAttemptAtFor,
  patchInstallState,
  readInstallState,
} from "./state"

/** Ceiling for one install. A cold 66 MB install is ~10 s; a slow mirror is minutes. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

export type InstallOutcomeKind =
  | "installed"
  | "adopted"
  | "disabled"
  | "locked"
  | "no-npm"
  | "backoff"
  | "failed"

export interface InstallOutcome {
  kind: InstallOutcomeKind
  /** The version now live, when one is. */
  version: string | null
  /** Absolute path of the payload entry, when one is. */
  entryPath?: string
  /** Human-readable detail for the CLI. */
  detail?: string
  error?: unknown
}

export interface EnsureInstallOpts {
  kind: ManagedKind
  /** Exact version to install. Required — never a range, never `latest`. */
  version: string
  /** Ignore the backoff window (explicit `github-router update --force`). */
  force?: boolean
  /** Point at this version even if the pointer already names another. */
  activate?: boolean
  /**
   * Registry override for this install (`npm_config_registry`).
   *
   * Injected rather than derived: Pi needs `resolvePiRegistry()` (a corporate
   * mirror can lag below `PI_MIN_VERSION`), but importing `pi-version-check`
   * here would drag consola and the whole Pi graph into the installer — and
   * this module is called from the bootstrap's background path.
   */
  registry?: string
  signal?: AbortSignal
}

/**
 * Make `version` available and (optionally) live for `kind`.
 *
 * Idempotent and safe to run concurrently across processes: the second caller
 * loses the lock, or loses the `rename` race and adopts the winner's payload.
 */
export async function ensureManagedInstall(opts: EnsureInstallOpts): Promise<InstallOutcome> {
  const { kind, version } = opts
  if (managedInstallDisabled()) {
    return { kind: "disabled", version: null, detail: "GH_ROUTER_NO_MANAGED_INSTALL is set" }
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { kind: "failed", version: null, detail: `invalid version "${version}"` }
  }

  const npmPath = resolveExecutable("npm")
  if (!npmPath) {
    return {
      kind: "no-npm",
      version: null,
      detail:
        "npm is not on PATH, so the managed install is unavailable; this launch runs from the current tree.",
    }
  }

  const state = await readInstallState(kind)
  // `mayAttemptNow`, not `installAllowedNow`: a bare reservation (written
  // optimistically by every attempt, so two launches cannot both run npm) is not
  // a failure and must not suppress this one. See `state.ts`.
  if (!opts.force && !mayAttemptNow(state)) {
    return {
      kind: "backoff",
      version: null,
      // First line only: `lastError` embeds npm's stderr, which is 20 lines long
      // and ends mid-filename. The full text stays in `install-state.json` for a
      // support thread; the CLI gets the sentence.
      detail: `last attempt failed (${firstLine(state.lastError) ?? "unknown error"}); next try after ${state.nextAttemptAt}`,
    }
  }

  // Optimistic: reserve the attempt before running so a concurrent launch backs
  // off instead of starting a second npm process over the same prefix.
  const reservation = nextAttemptAtFor((state.consecutiveFailures ?? 0) + 1)
  await patchInstallState(kind, {
    lastAttemptAt: new Date().toISOString(),
    nextAttemptAt: reservation,
  })

  const lock = await withInstallLockResult(`managed-${kind}.lock`, async () => {
    // Re-check inside the lock: the winner may have just published it.
    const existing = await probeVersion(kind, version)
    if (existing) {
      await activate(kind, version, opts.activate !== false)
      return
    }
    await installInto(kind, version, npmPath, opts.registry, opts.signal)
    await activate(kind, version, opts.activate !== false)
  })

  if (lock.outcome === "failed") {
    const lastError = errorText(lock.error)
    // Re-read rather than reusing the snapshot taken before an install that may
    // have run for minutes: another process (or `npmProbes`) writes this file.
    const fresh = await readInstallState(kind)
    // A concurrent process may have SUCCEEDED while this one was failing (its
    // lock was released, ours then failed for its own reason). Recording a
    // failure now would install a backoff on top of a healthy payload and make
    // the next launch report "last attempt failed" about a machine that is up to
    // date. `lastSuccessAt` moving is exactly that signal.
    if (fresh.lastSuccessAt !== state.lastSuccessAt) {
      return { kind: "failed", version: null, detail: lastError, error: lock.error }
    }
    const failures = (fresh.consecutiveFailures ?? 0) + 1
    await patchInstallState(kind, {
      lastAttemptAt: new Date().toISOString(),
      consecutiveFailures: failures,
      nextAttemptAt: nextAttemptAtFor(failures),
      lastError,
    })
    return { kind: "failed", version: null, detail: lastError, error: lock.error }
  }

  if (lock.outcome === "skipped") {
    // NOT a failure, so the reservation written above must not harden into a
    // backoff window. It was written to keep two launches from both running npm;
    // leaving it in place would make the very next launch skip an install that
    // nothing tried yet — and if the winner finished first, the loser's
    // reservation would land AFTER the winner cleared it, suppressing refreshes
    // for an hour on a machine that is already up to date.
    //
    // Guarded rather than unconditional: the lock holder may have FAILED in the
    // meantime and written its own (genuine) window, which restoring ours would
    // erase. Only the reservation this call wrote is ours to remove.
    const now = await readInstallState(kind)
    if (now.nextAttemptAt === reservation) {
      await patchInstallState(kind, { nextAttemptAt: state.nextAttemptAt })
    }
    return {
      kind: "locked",
      version: null,
      detail: "another github-router process is installing; retry shortly",
    }
  }

  const live = await readPointer(kind, { verifyEntry: false })
  // `adopted` vs `installed` is user-visible (``update`` prints it), so it must be
  // judged against what is on disk now, not against the snapshot taken before an
  // install that may have taken minutes.
  const fresh = await readInstallState(kind)
  const alreadySucceeded = fresh.lastSuccessAt !== undefined && live?.version === version
  const stateWritten = await patchInstallState(kind, {
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    consecutiveFailures: 0,
    // Explicit `undefined` = delete, which is what clears the ladder.
    nextAttemptAt: undefined,
    lastError: undefined,
  })
  return {
    kind: alreadySucceeded ? "adopted" : "installed",
    version,
    entryPath: live?.version === version ? live.entryPath : versionEntry(kind, version),
    // A failed write is NOT a failed install — the payload is live and this
    // process knows it — but the next launch reads the stale ladder from disk and
    // would report "last attempt failed" for up to 24 h on a healthy machine. Say
    // so once, here, instead of leaving it to be discovered as a mystery.
    ...(stateWritten
      ? {}
      : {
          detail:
            "installed, but install-state.json could not be written; the next launch may think the previous attempt failed",
        }),
  }
}

/**
 * Publish `version` as the live payload.
 *
 * Reads the pointer back rather than trusting its own write: if a concurrent
 * `update` published a different version first, the pointer is the winner and
 * this call must not claim otherwise.
 */
async function activate(kind: ManagedKind, version: string, activateIt: boolean): Promise<void> {
  const marker = await readInstalledMarker(kind, version)
  if (!activateIt) return
  await writePointer({
    kind,
    version,
    entry: entryRelativeFor(kind),
    runtimeHint: process.execPath,
    registry: marker?.registry,
    installedAt: new Date().toISOString(),
  })
}

/** The payload entry inside a published version dir. */
export function versionEntry(kind: ManagedKind, version: string): string {
  return path.join(versionDir(kind, version), entryRelativeFor(kind))
}

/**
 * Is `version` already a complete payload?
 *
 * Both conditions are required. The marker alone is not enough (a killed
 * `npm install` leaves whatever it got so far, and the marker is written by us
 * only after verification), and the entry alone is not enough (a half-installed
 * tree can contain the entry file while its dependencies are missing).
 */
async function probeVersion(
  kind: ManagedKind,
  version: string,
): Promise<{ version: string; entryPath: string } | null> {
  const entryPath = versionEntry(kind, version)
  const marker = await readInstalledMarker(kind, version)
  if (!marker) return null
  try {
    const stat = await fs.stat(entryPath)
    if (!stat.isFile()) return null
  } catch {
    return null
  }
  return { version, entryPath }
}

/**
 * Do the install and publish it.
 *
 * Everything happens in a fresh `.staging-<pid>-<rand>` sibling:
 *
 * 1. private `package.json` with an EXACT dependency (a range would make
 *    `adopt` and `npm view` disagree about what is live),
 * 2. `npm install` with `cwd` = staging and a scrubbed env,
 * 3. verify the entry, harvest provenance from `package-lock.json`, write the
 *    marker INSIDE staging,
 * 4. `rename(staging → <version>)`, then verify again through the final path.
 *
 * The marker lands before the rename so a crash can never leave a
 * complete-looking version dir without one — and a crash before the rename
 * leaves only a `.staging-*` dir, which GC sweeps.
 */
async function installInto(
  kind: ManagedKind,
  version: string,
  npmPath: string,
  registry?: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = managedRoot(kind)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })

  const pkgName = npmPackageFor(kind)
  const staging = stagingDir(kind)
  // NOT `recursive: true`: the name already carries pid + random, so an EEXIST
  // here means a name collision (pid reuse after a crashed attempt left
  // `.staging-<pid>-<rand>` behind — unlikely, but the consequence is severe).
  // npm installing into an inherited tree would find an entry file it did not
  // fetch, `assertFile` would pass, a fresh `.installed.json` would be minted,
  // and an incomplete payload would publish — the "npm exited 0 and installed
  // nothing" laundering `npm-env.ts` exists to prevent. Failing loudly and
  // letting the caller retry with a new name is the only safe answer.
  await fs.mkdir(staging, { mode: 0o700 })

  try {
    const pkgJson = {
      name: `gh-router-managed-${kind}`,
      private: true,
      version: "0.0.0",
      // Exact, not a range: the publish step is rename-only, so anything the
      // resolver decides here becomes the live payload without a second look.
      dependencies: { [pkgName]: version },
    }
    await writeFileAtomic(path.join(staging, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`, {
      mode: 0o644,
    })

    // Registry is passed BOTH as env (so a transitive `npm` child spawned by a
    // lifecycle script would also see it — there are none, `--ignore-scripts`,
    // but belt and braces) and as an explicit flag below, because a flag beats
    // every config source npm has. For Pi this is not optional: a lagging mirror
    // can sit below `PI_MIN_VERSION`, and the floor is enforced against what
    // actually got installed.
    const overrides: NodeJS.ProcessEnv = {}
    if (registry) overrides.npm_config_registry = registry

    const scrub = buildNpmEnv(process.env, overrides)
    reportManagedDiagnostic(
      "debug",
      `managed[${kind}]: npm env kept=${scrub.kept.length} dropped=${scrub.dropped.join(",") || "none"}`,
    )

    reportManagedDiagnostic("info", `Installing ${pkgName}@${version} (one-time per version)…`)
    const { code, stderr } = await runCommandCapture(
      [
        npmPath,
        "install",
        // Defence in depth against the env keys scrubbed above: a flag beats
        // both env and .npmrc, so the destination and completeness cannot be
        // redirected by anything the user exported.
        "--no-global",
        "--no-dry-run",
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...(registry ? [`--registry=${registry}`] : []),
      ],
      {
        // cloudcli.ts inherits the caller's cwd, so npm reads that directory's
        // `.npmrc` — a repo-local `registry` line would silently redirect this
        // install. From the staging dir only `$HOME/.npmrc` and the global
        // file apply.
        cwd: staging,
        env: scrub.env,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
      },
    )
    if (code !== 0) {
      throw new Error(
        `npm install ${pkgName}@${version} failed (exit ${code}). This usually means no network, a corporate proxy, or a registry that does not carry the version.\n${stderr.slice(0, 600)}`,
      )
    }

    // Exit 0 does not imply "installed" (see the npm-env.ts table).
    const stagedEntry = path.join(staging, entryRelativeFor(kind))
    await assertFile(stagedEntry, `${pkgName}@${version} installed but its entry is missing`)
    // And the entry existing does not imply the RIGHT version: an inherited
    // staging tree, a mirror serving a different tarball under the requested
    // version, or `omit=optional` leaving a stale tree all produce a complete-
    // looking directory. The marker written below is the only thing that certifies
    // "this dir is complete", and `probeVersion` adopts any dir that has one
    // forever — so check the version the tree actually contains, and fail before
    // the marker exists.
    await assertInstalledVersion(path.join(staging, "node_modules", pkgName), pkgName, version)

    const marker: InstalledMarker = {
      version,
      installedAt: new Date().toISOString(),
      runtime: process.execPath,
      packages: await harvestProvenance(staging),
    }
    const resolvedRegistry = firstRegistry(marker) ?? registry
    if (resolvedRegistry) marker.registry = resolvedRegistry

    // Written INTO STAGING before the rename, so a version dir can never
    // appear without it. (`writeInstalledMarker` targets the final path, which
    // does not exist yet — hence the explicit staging path here.)
    await writeFileAtomic(stagingMarkerPath(staging), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o644,
    })

    const target = versionDir(kind, version)
    const published = await publishTo(staging, target, kind)
    if (published === "raced") {
      // Another installer won. Adopt its tree if it is complete; otherwise it
      // was mid-publish and we must not leave a broken version live.
      if (!(await probeVersion(kind, version))) {
        throw new Error(`another process published ${pkgName}@${version} incompletely; retry`)
      }
    }
    await assertFile(versionEntry(kind, version), `${pkgName}@${version} published without its entry`)
  } finally {
    // No-op on success (the rename moved it away).
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

type PublishResult = "published" | "raced"

/**
 * `rename(staging → target)`, moving a corrupt existing tree aside first.
 *
 * Rename onto an existing non-empty directory is `ENOTEMPTY` on POSIX and
 * `EPERM`/`EEXIST` on Windows — the exact `npm error code ENOTEMPTY` failure
 * Claude Code's updater hit. Renaming the loser aside to a fresh name always
 * works, so the published path is never a partially-overwritten tree.
 */
async function publishTo(
  staging: string,
  target: string,
  kind: ManagedKind,
): Promise<PublishResult> {
  try {
    await fs.rename(staging, target)
    return "published"
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
      throw err
    }
  }

  // Something is already at `target`. If it is a complete payload, another
  // process just won the race — adopt it. If not, move it aside and retry once.
  //
  // `kind` is threaded through instead of re-derived from the path: a `null`
  // derivation used to fall back to `trashDir("self")`, i.e. a Pi payload would
  // be moved into the SELF root, where the next `self` GC would delete it.
  if (await probeVersion(kind, path.basename(target))) return "raced"

  const aside = trashDir(kind)
  let movedAside = false
  try {
    await fs.rename(target, aside)
    movedAside = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Vanished between the failed rename and now: nothing to move aside, and
    // nothing to restore either.
    if (code !== "ENOENT") throw err
  }
  try {
    await fs.rename(staging, target)
    return "published"
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      // Lost a second race — treat as adopt, verified by the caller.
      return "raced"
    }
    // The publish failed for an unrelated reason (permissions, disk) AFTER the
    // old tree was moved aside. Put it back: the pointer may still name it, and
    // a pointer with no payload is a launch that falls back to the npx tree —
    // a silent downgrade caused by a failed update. GC would otherwise delete
    // the moved-aside copy an hour later, making the loss permanent.
    let restored = false
    if (movedAside) {
      restored = await fs.rename(aside, target).then(
        () => true,
        () => false,
      )
    }
    // The restore failed too. Nothing can run from `target`, and leaving the
    // pointer in place makes `update --check` report a version that is not on
    // disk (every other reader already treats it as absent). Drop it only when it
    // names the tree that is now gone — it may name a DIFFERENT version, which is
    // still perfectly good.
    if (!restored) {
      const live = await readPointer(kind, { verifyEntry: false })
      if (live && live.version === path.basename(target)) {
        await removePointer(kind).catch(() => {})
      }
    }
    throw err
  }
}

/**
 * Assert `dir`'s `package.json` declares `version`.
 *
 * Deliberately a THROW, not a warning: the caller writes the marker (which
 * certifies completeness forever) immediately after this, so "close enough" here
 * means a wrong or incomplete payload becomes the live one.
 */
async function assertInstalledVersion(dir: string, pkgName: string, version: string): Promise<void> {
  const manifestPath = path.join(dir, "package.json")
  let declared: unknown
  try {
    declared = (JSON.parse(await fs.readFile(manifestPath, "utf8")) as { version?: unknown }).version
  } catch {
    throw new Error(`${pkgName}@${version} installed but ${manifestPath} is missing or unreadable`)
  }
  if (declared !== version) {
    throw new Error(
      `${pkgName}@${version} installed but its package.json declares ${JSON.stringify(declared)}; refusing to publish it`,
    )
  }
}

/** The `.installed.json` path inside a staging dir (same name the final dir uses). */
function stagingMarkerPath(staging: string): string {
  return path.join(staging, ".installed.json")
}

/** `{ "<pkg>@<version>": { resolved, integrity } }` from the prefix lockfile. */
async function harvestProvenance(
  prefix: string,
): Promise<Record<string, { resolved?: string; integrity?: string }>> {
  const out: Record<string, { resolved?: string; integrity?: string }> = {}
  try {
    const raw = await fs.readFile(path.join(prefix, "package-lock.json"), "utf8")
    const parsed = JSON.parse(raw) as {
      packages?: Record<
        string,
        { version?: string; resolved?: string; integrity?: string; link?: boolean }
      >
    }
    for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
      if (!key.startsWith("node_modules/") || entry.link) continue
      const name = key.slice("node_modules/".length)
      // Only top-level provenance: the transitive tree is reproducible from
      // the registry once the root tarball's integrity is pinned.
      if (name.includes("node_modules/")) continue
      if (!entry.version) continue
      out[`${name}@${entry.version}`] = {
        ...(entry.resolved ? { resolved: entry.resolved } : {}),
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      }
    }
  } catch {
    // No lockfile (npm can be told not to write one). Provenance is
    // best-effort diagnostics, never a gate.
  }
  return out
}

/**
 * The registry a payload actually came from, derived from a tarball URL.
 *
 * NOT `new URL(resolved).origin`: a corporate mirror keeps its path
 * (`https://nexus.example/repository/npm-group/github-router/-/github-router-1.2.3.tgz`),
 * and truncating to the origin writes `https://nexus.example/` into `current.json`
 * and `install-state.json` as "the registry this install used". Anyone — a support
 * thread, a future reader, `update --check` — who then fetches from it gets a 404.
 *
 * The npm registry layout makes the answer exact: everything before the
 * `<pkg>/-/<pkg>-<version>.tgz` segment is the registry. When that shape is not
 * recognisable, prefer no answer over a wrong one.
 */
function registryFromResolved(resolved: string): string | undefined {
  try {
    const url = new URL(resolved)
    const marker = url.pathname.lastIndexOf("/-/")
    if (marker <= 0) return undefined
    const basePath = url.pathname.slice(0, marker + 1)
    return `${url.origin}${basePath}`
  } catch {
    // A non-URL `resolved` (file:, git:) has no registry.
    return undefined
  }
}

function firstRegistry(marker: InstalledMarker): string | undefined {
  for (const entry of Object.values(marker.packages ?? {})) {
    if (!entry.resolved) continue
    const registry = registryFromResolved(entry.resolved)
    if (registry) return registry
  }
  return undefined
}

async function assertFile(file: string, message: string): Promise<void> {
  try {
    const stat = await fs.stat(file)
    if (stat.isFile()) return
  } catch {
    // fall through
  }
  throw new Error(message)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 800)
  return String(err).slice(0, 800)
}

/** First non-empty line of a multi-line diagnostic, or null. */
function firstLine(text: string | undefined): string | null {
  if (!text) return null
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)
  return line ? line.trim() : null
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

export interface GcReport {
  removedStaging: Array<string>
  removedTrash: Array<string>
  /** Atomic-write temp files (`current.json.<pid>.<rand>.tmp`). */
  removedTransient: Array<string>
  removedVersions: Array<string>
  /** Kept, with the reason — this is what makes a support thread answerable. */
  kept: Array<{ name: string; reason: string }>
}

/**
 * Sweep leftover attempts and old payloads.
 *
 * Non-blocking and best-effort by contract: every removal error is swallowed
 * (`EBUSY` on Windows is normal while a virus scanner holds a file) and retried
 * on the next boot. The rules:
 *
 * - `.staging-*` / `.trash-*` older than an hour: delete.
 * - a `<version>` dir: delete only if it is NOT the pointer's, NOT one of the
 *   two newest, AND older than the 7-day floor.
 *
 * The floor exists because a live session's hooks name its payload dir
 * (`--package-root`), so a version can be in use long after the pointer moved
 * on. Bounding that at a week is the deliberate trade recorded in the plan.
 */
export async function gcManaged(kind: ManagedKind, now = Date.now()): Promise<GcReport> {
  const report: GcReport = {
    removedStaging: [],
    removedTrash: [],
    removedTransient: [],
    removedVersions: [],
    kept: [],
  }
  const root = managedRoot(kind)
  let names: Array<string>
  try {
    names = await fs.readdir(root)
  } catch {
    return report
  }

  // Abort the WHOLE sweep when the pointer cannot be read for a reason other
  // than "there is none". Without this a transient `EPERM`/`EBUSY` (a virus
  // scanner holding current.json, a torn read on a network home) reads as
  // "nothing is live", and the version it names — possibly neither of the two
  // newest nor inside the 7-day floor — gets deleted. That is unrecoverable
  // without a reinstall, on exactly the machine that is already in trouble.
  // Sweeping is an optimisation; skipping it costs disk, deleting a live tree
  // costs a working install.
  const pointerRead = await readPointerDetailed(kind, { verifyEntry: false })
  if (pointerRead.status === "unreadable") {
    return report
  }
  const live = pointerRead.pointer
  // Two different time quantities, kept apart on purpose: `modifiedAt` is an
  // absolute timestamp (used only to order "newest first") and `age` is a
  // duration (used only against the floor). An earlier version of this code
  // stored the timestamp and compared it to `VERSION_FLOOR_MS`, which made the
  // 7-day floor unfalsifiable — every real timestamp is larger than 7 days in
  // milliseconds, so the floor never protected anything.
  const versions: Array<{ name: string; modifiedAt: number; age: number }> = []

  for (const name of names) {
    const full = path.join(root, name)
    // Transient names are matched against the SAME shapes `paths.ts` defines for
    // staging/trash, not a bare prefix: a `.staging-notes` file a user dropped in
    // is not ours to delete, and the two modules must not disagree about what a
    // leftover looks like.
    if (STAGING_RE.test(name)) {
      const age = await ageMs(full, now)
      if (age !== null && age > TRANSIENT_TTL_MS) {
        if (await removeDir(full)) report.removedStaging.push(name)
      }
      continue
    }
    if (TRASH_RE.test(name)) {
      const age = await ageMs(full, now)
      if (age !== null && age > TRANSIENT_TTL_MS) {
        if (await removeDir(full)) report.removedTrash.push(name)
      }
      continue
    }
    // A killed `writeFileAtomic` leaves `<file>.<pid>.<rand>.tmp` beside the
    // file it was replacing — same TTL rule as the other transient names, so a
    // `.tmp` from a crashed pointer write does not sit here forever.
    if (name.endsWith(".tmp")) {
      const age = await ageMs(full, now)
      if (age !== null && age > TRANSIENT_TTL_MS) {
        if (await removeFile(full)) report.removedTransient.push(name)
      }
      continue
    }
    if (!isVersionName(name)) continue
    const age = (await ageMs(full, now)) ?? 0
    versions.push({ name, modifiedAt: now - age, age })
  }

  // Newest first (highest timestamp, then highest version as a tiebreak so a
  // same-second install of two versions is still deterministic).
  versions.sort((a, b) =>
    a.modifiedAt === b.modifiedAt
      ? compareVersions(b.name, a.name)
      : b.modifiedAt - a.modifiedAt,
  )
  const protectedNames = new Set<string>()
  if (live) protectedNames.add(live.version)
  for (const entry of versions.slice(0, KEEP_VERSIONS)) protectedNames.add(entry.name)

  for (const entry of versions) {
    if (protectedNames.has(entry.name)) {
      report.kept.push({ name: entry.name, reason: "newest-or-live" })
      continue
    }
    if (entry.age < VERSION_FLOOR_MS) {
      report.kept.push({ name: entry.name, reason: "within-7-day-floor" })
      continue
    }
    const full = path.join(root, entry.name)
    if (await removeDir(full)) report.removedVersions.push(entry.name)
    else report.kept.push({ name: entry.name, reason: "removal-failed" })
  }

  return report
}

async function ageMs(full: string, now: number): Promise<number | null> {
  try {
    const stat = await fs.stat(full)
    return now - stat.mtimeMs
  } catch {
    return null
  }
}

async function removeFile(full: string): Promise<boolean> {
  try {
    await fs.rm(full, { force: true })
    return true
  } catch (err) {
    reportManagedDiagnostic("debug", `managed: could not remove ${full}: ${String(err)}`)
    return false
  }
}

async function removeDir(full: string): Promise<boolean> {
  try {
    await fs.rm(full, { recursive: true, force: true })
    return true
  } catch (err) {
    reportManagedDiagnostic("debug", `managed: could not remove ${full}: ${String(err)}`)
    return false
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const av = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0)
    const bv = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0)
    if (av !== bv) return av - bv
  }
  return 0
}

/** Absolute path of a published version's entry, without touching the pointer. */
export function managedEntryPath(kind: ManagedKind, version: string): string {
  return versionEntry(kind, version)
}

