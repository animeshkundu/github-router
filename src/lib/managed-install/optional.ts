/**
 * On-demand install of the heavy optional payloads.
 *
 * `@huggingface/transformers` (~547 MB with its ONNX runtime) and
 * `tree-sitter-wasms` (~49 MB of grammars) are the entire difference between a
 * 66 MB install and a 586 MB one. The plan moves them to **optional** peers so
 * nobody pays for them at install time — which has one blunt consequence that
 * must be stated plainly: **optional peers are installed for nobody**, at any
 * depth, by npm and by bun alike (measured). So "optional" cannot mean "the
 * usual install will bring it"; it has to mean "we install it the first time
 * something actually needs it".
 *
 * Three rules shape this file:
 *
 * 1. **One copy per machine, shared across versions.** The payload lands in
 *    `<APP_DIR>/optional/<pkg>@<version>/`, never inside a managed version dir:
 *    those are per-version and GC keeps two, so an in-tree copy would be 1.1 GB
 *    and would be re-fetched on every bump.
 * 2. **Failure is always allowed.** Reranking falls back to BM25F and structural
 *    ranking to the regex heuristic; both already warn for exactly this case.
 *    Nothing here may ever make a search or a chat request fail.
 * 3. **Off the hot path.** Resolution (is a usable copy present?) is a couple of
 *    `stat`s against a bounded directory listing, and it is synchronous because
 *    both consumers are. Installation is a separate, throttled, detached child;
 *    the request that noticed the gap proceeds without it.
 *
 * Supply-chain posture matches the managed installer: exact version, scrubbed
 * npm env, `--ignore-scripts`, `--no-global`, provenance from the lockfile.
 */

import fs from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

import { writeFileAtomic, readFileWithRetry } from "../atomic-file"
import { parseBoolEnv, resolveExecutable, runCommandCapture } from "../exec"
import { buildNpmEnv } from "./npm-env"
import { reportManagedDiagnostic } from "./diagnostics"
import { VERSION_RE, isTransientName, isVersionName, optionalRoot, randomHex } from "./paths"

/** The packages that may be installed on demand. */
export const OPTIONAL_PACKAGES = ["@huggingface/transformers", "tree-sitter-wasms"] as const
export type OptionalPackage = (typeof OPTIONAL_PACKAGES)[number]

/**
 * Entry file that must exist for a copy to count as installed.
 *
 * A package directory alone is not enough: an interrupted `npm install` can
 * leave `node_modules/<pkg>` in place with its payload missing, and an
 * on-demand install is precisely the kind that gets interrupted (the user
 * quits, the machine sleeps). These are the exact files the two consumers load.
 */
export const OPTIONAL_REQUIRED_FILE: Readonly<Record<OptionalPackage, string>> = {
  "@huggingface/transformers": "dist/transformers.node.mjs",
  // The filename must be the one the package actually ships:
  // `tree-sitter-wasms@0.1.13/out/tree-sitter-typescript.wasm`. A wrong name
  // here is not a loud failure — the install SUCCEEDS, `completeAt` then refuses
  // the payload, structural ranking silently keeps using the regex fallback,
  // and the package state backs off for an hour pretending npm broke.
  "tree-sitter-wasms": "out/tree-sitter-typescript.wasm",
}

/**
 * The peer range each payload must satisfy, mirroring `package.json`.
 *
 * On-demand installation used to take whatever `npm view <pkg> version` said,
 * which is unbounded: the day transformers 5.x ships, every machine fetches a
 * major the router has never run — and `completeAt` refusing the payload turns
 * that into a one-hour backoff that hides the cause. Bounding the query
 * (`npm view <pkg>@<range> version`) makes npm do the range arithmetic, so the
 * answer is by construction compatible. `tests/optional-payload-manifest.test.ts`
 * asserts this table still matches `package.json#peerDependencies`.
 */
export const OPTIONAL_VERSION_RANGE: Readonly<Record<OptionalPackage, string>> = {
  "@huggingface/transformers": "^4.3.2",
  "tree-sitter-wasms": "^0.1.13",
}

/** `<pkg>` → the directory name used under `optional/` (`@scope/name` is unsafe). */
function sanitized(pkg: string): string {
  return pkg.replace("/", "__")
}

/**
 * Test seam: what a slot actually installs.
 *
 * The install mechanics (staging, verify, publish-by-rename, provenance, GC) are
 * identical for a 547 MB ONNX payload and for a 6 KB package with no scripts, but
 * only one of them can run in a test. Overriding via a seam keeps ONE code path
 * instead of a re-implementation in the test that could pass while production
 * breaks. Nothing in `src/` calls the setters.
 */
interface OptionalSubject {
  packageName: string
  requiredFile: string
  version: string | null
  /** Peer range to resolve within; the real table by default. */
  range: string | null
}
const subjects = new Map<OptionalPackage, OptionalSubject>()

function subjectFor(pkg: OptionalPackage): OptionalSubject {
  return (
    subjects.get(pkg) ?? {
      packageName: pkg,
      requiredFile: OPTIONAL_REQUIRED_FILE[pkg],
      version: null,
      range: OPTIONAL_VERSION_RANGE[pkg],
    }
  )
}

/** @internal — point one slot at a throwaway package. */
export function __setOptionalTestSubject(input: {
  pkg: OptionalPackage
  packageName: string
  requiredFile: string
  version?: string
}): void {
  subjects.set(input.pkg, {
    packageName: input.packageName,
    requiredFile: input.requiredFile,
    version: input.version ?? null,
    // A test stand-in (`is-number`) has its own version, so bind it to itself
    // rather than to the real package's peer range.
    range: input.version ? input.version : null,
  })
}

/** @internal — restore the real subjects. */
export function __resetOptionalTestSubject(): void {
  subjects.clear()
}

/**
 * True when the user disabled on-demand payloads.
 *
 * Uses the shared `parseBoolEnv`, not a local `raw === "1" || raw === "true"`:
 * `GH_ROUTER_NO_OPTIONAL_INSTALL=TRUE` or `=yes` used to be unrecognised and
 * silently *enabled* a 547 MB download, which is the worst possible way for an
 * off switch to fail.
 */
export function optionalInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolEnv(env.GH_ROUTER_NO_OPTIONAL_INSTALL) === true
}

/** The `node_modules/<pkg>` directory inside an installed optional copy. */
function payloadDir(target: string, pkg: OptionalPackage): string {
  return path.join(target, "node_modules", ...subjectFor(pkg).packageName.split("/"))
}

/** Is `target` a complete payload? */
function completeAt(target: string, pkg: OptionalPackage): boolean {
  const dir = payloadDir(target, pkg)
  return (
    existsSync(path.join(dir, "package.json"))
    && existsSync(path.join(dir, subjectFor(pkg).requiredFile))
  )
}

/**
 * A usable installed copy of `pkg`, preferring the NEWEST version present.
 *
 * Synchronous on purpose: `resolveGrammarRoot()` and the rerank loader are
 * called from synchronous contexts, and a promise here would force an `await`
 * onto a path that must stay cheap. The listing is small (one entry per
 * installed version, typically one).
 *
 * Returns the package directory (the thing a consumer imports from), not the
 * `optional/<pkg>@<ver>` prefix.
 */
export function installedOptional(pkg: OptionalPackage): string | null {
  const [newest] = completeTargets(pkg)
  return newest ? payloadDir(newest, pkg) : null
}

/**
 * Every COMPLETE `<root>/<pkg>@<version>` target dir, newest version first.
 *
 * Split out of `installedOptional` because two callers need the target dir
 * itself rather than the package dir inside it: the upgrade check ("is the
 * version we just resolved already here?") and the GC protection list ("spare
 * the copy this process is using").
 */
function completeTargets(pkg: OptionalPackage): Array<string> {
  const root = optionalRoot()
  let names: Array<string>
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const prefix = `${sanitized(pkg)}@`
  const candidates = names
    .filter((name) => name.startsWith(prefix) && !name.startsWith("."))
    .map((name) => ({ name, version: name.slice(prefix.length) }))
    .filter((entry) => isVersionName(entry.version))
    // Newest first: a stale older copy must never shadow a fresh one.
    .sort((a, b) => compareVersions(b.version, a.version))

  const out: Array<string> = []
  for (const candidate of candidates) {
    const target = path.join(root, candidate.name)
    if (completeAt(target, pkg)) out.push(target)
  }
  return out
}

/** Where `pkg@version` would live. */
export function optionalTarget(pkg: OptionalPackage, version: string): string {
  return path.join(optionalRoot(), `${sanitized(pkg)}@${version}`)
}

/** `payloadDir` for exactly `pkg@version`, or null when that copy is not complete. */
function installedOptionalTarget(pkg: OptionalPackage, version: string): string | null {
  const target = optionalTarget(pkg, version)
  return completeAt(target, pkg) ? payloadDir(target, pkg) : null
}

// ---------------------------------------------------------------------------
// Backoff + GC state
// ---------------------------------------------------------------------------

/**
 * `optional/install-state.json`.
 *
 * Separate from `m/<kind>/install-state.json` because the lifecycles are
 * separate: pruning the managed tree must never reset (or inherit) a failing
 * optional install's ladder, and the optional ladder is per PACKAGE.
 */
interface OptionalState {
  /**
   * Schema of this file, so a poisoned ladder written by an older build can be
   * retired instead of waited out.
   *
   * Absent means 1 (the only schema that ever shipped without a number). Bump on
   * every change that makes an existing `consecutiveFailures`/`nextAttemptAt`
   * pair mean something different: a bug that failed the install for a reason
   * the user could not influence (the Windows `^`-range quoting bug in
   * `lib/exec.ts`) left every machine on a 1h -> 6h -> 24h ladder that no code
   * change can climb, because the recorded failure is re-read as a fresh one. A
   * reader that sees an older schema drops the ladder fields and treats the
   * package as having no recorded failure.
   */
  schemaVersion?: number
  packages?: Partial<
    Record<
      OptionalPackage,
      {
        lastAttemptAt?: string
        lastSuccessAt?: string
        consecutiveFailures?: number
        nextAttemptAt?: string
        lastError?: string
        version?: string
      }
    >
  >
}

/** Current `OptionalState` schema; see the field's doc block. */
const OPTIONAL_STATE_SCHEMA = 2

const BACKOFF_HOURS = [1, 6, 24] as const
const KEEP_OPTIONAL_VERSIONS = 2
const OPTIONAL_FLOOR_MS = 30 * 24 * 60 * 60_000

function statePath(): string {
  return path.join(optionalRoot(), "install-state.json")
}

async function readState(): Promise<OptionalState> {
  try {
    const raw = await readFileWithRetry(statePath(), { retryMissing: false })
    const parsed = JSON.parse(raw) as OptionalState
    if (typeof parsed !== "object" || parsed === null) return {}
    return migrateState(parsed)
  } catch {
    return {}
  }
}

/**
 * Retire a ladder this build did not write, keeping everything still valid.
 *
 * `consecutiveFailures` + `nextAttemptAt` are a claim about THIS build's ability
 * to install the package. When an older build failed for a reason the build
 * itself caused — the `^`-range quoting bug made `npm view` reject every spec
 * before a byte was downloaded — that claim is wrong after the fix, and the only
 * thing the inherited ladder does is keep the payload uninstalled for at least
 * an hour per startup. So a schema this build does not recognise drops exactly
 * those fields (plus the error text that described the old failure);
 * `lastAttemptAt`, `lastSuccessAt` and `version` are kept because they describe
 * what is on disk, not why an attempt failed.
 *
 * Unrecognised covers BOTH directions, and that is deliberate. A newer schema
 * means a newer build invented these numbers for semantics this build cannot
 * read (a downgrade, a pinned launch dir, a rollback); guessing would either
 * suppress a payload for hours or re-attempt a download every launch. Dropping
 * the ladder errs toward one early attempt, which for an optional payload is the
 * cheap mistake. The paired rule is in `patchState`: every write stamps exactly
 * `OPTIONAL_STATE_SCHEMA`, because the ladder next to the stamp was produced by
 * this build's semantics — keeping a newer number would mislabel it.
 *
 * Pure and exercised through `ensureOptionalPackage`, the only caller: the state
 * file is the only input, and dropping `consecutiveFailures` is what
 * `mayAttemptNow` already treats as "not a backoff".
 */
function migrateState(state: OptionalState): OptionalState {
  if ((state.schemaVersion ?? 1) === OPTIONAL_STATE_SCHEMA) return state
  const packages: OptionalState["packages"] = {}
  for (const [pkg, entry] of Object.entries(state.packages ?? {})) {
    if (!entry || typeof entry !== "object") continue
    // Rebuild rather than destructure-with-rest: `no-unused-vars` rejects the
    // `_failures`/`_next`/`_error` bindings an omit-by-rest would create, and this
    // also drops unknown keys from a hand-edited file.
    const kept: NonNullable<OptionalState["packages"]>[OptionalPackage] = {}
    if (entry.lastAttemptAt !== undefined) kept.lastAttemptAt = entry.lastAttemptAt
    if (entry.lastSuccessAt !== undefined) kept.lastSuccessAt = entry.lastSuccessAt
    if (entry.version !== undefined) kept.version = entry.version
    packages[pkg as OptionalPackage] = kept
  }
  return { schemaVersion: OPTIONAL_STATE_SCHEMA, packages }
}

/**
 * Persist a schema migration the moment an attempt starts.
 *
 * `readState` migrates in memory, which alone is enough to let an attempt through
 * — and that is the load-bearing part. This write is for the two paths that never
 * patch state afterwards: a payload already installed, and `npm` missing. Left
 * alone, those machines would carry the old ladder in the file forever, so a human
 * reading `install-state.json` (or a support thread) would keep seeing a failure
 * that this build no longer produces.
 *
 * Not load-bearing also means not worth losing a concurrent update over: the write
 * is built from the newest read, and `migrateState` is idempotent.
 */
async function persistMigratedState(): Promise<void> {
  try {
    // One read, then migrate what was read. Re-reading to compare first (the
    // original shape) bought nothing: `writeFileAtomic` gives atomic REPLACE, not
    // isolation, so a `patchState` can still land between the last read and the
    // write. Building the write from the newest read is the most a lock-free writer
    // can do, and the migration is idempotent, so the only field a race can lose is
    // `lastAttemptAt`-class metadata that describes an attempt this build already
    // dropped the verdict for.
    const parsed = JSON.parse(await readFileWithRetry(statePath(), { retryMissing: false })) as OptionalState
    if (typeof parsed !== "object" || parsed === null) return
    if ((parsed.schemaVersion ?? 1) === OPTIONAL_STATE_SCHEMA) return
    await writeFileAtomic(statePath(), `${JSON.stringify(migrateState(parsed), null, 2)}\n`, {
      mode: 0o644,
    })
  } catch {
    // No file (first run) or unparseable: a write here would create noise, not state.
  }
}

async function patchState(
  pkg: OptionalPackage,
  patch: Partial<NonNullable<OptionalState["packages"]>[OptionalPackage] & object>,
): Promise<void> {
  try {
    const state = await readState()
    const next: OptionalState = {
      // Keep any top-level key this build does not know about. Today the file holds
      // only `schemaVersion` + `packages`, but dropping an unknown key on every
      // write is a silent deletion waiting for the first future field (the same
      // self-healing rule `managed-install/state.ts` follows).
      ...state,
      // Exactly this build's schema, never a higher one: an unrecognised schema
      // was just migrated (its ladder dropped), so the entry being written now is
      // produced by these semantics and must be labelled accordingly. Keeping a
      // newer number would let a later build trust a ladder it did not write.
      schemaVersion: OPTIONAL_STATE_SCHEMA,
      packages: { ...(state.packages ?? {}), [pkg]: { ...(state.packages?.[pkg] ?? {}), ...patch } },
    }
    // `undefined` means delete — how a success clears the ladder.
    for (const [key, value] of Object.entries(next.packages?.[pkg] ?? {})) {
      if (value === undefined) delete (next.packages![pkg] as Record<string, unknown>)[key]
    }
    await fs.mkdir(optionalRoot(), { recursive: true })
    await writeFileAtomic(statePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
  } catch (err) {
    reportManagedDiagnostic("debug", `optional: could not write state: ${String(err)}`)
  }
}

function nextAttemptAtFor(failures: number): string {
  const index = Math.min(Math.max(failures, 1), BACKOFF_HOURS.length) - 1
  return new Date(Date.now() + (BACKOFF_HOURS[index] ?? 24) * 3_600_000).toISOString()
}

/**
 * When the next attempt is due, and how to skip the wait.
 *
 * The ladder exists so a broken registry or an offline laptop does not spawn npm
 * on every launch, and it climbs 1h -> 6h -> 24h. That is the right default, but a
 * message that only says "backing off" hides two things the reader needs: WHEN it
 * will try again, and that `--force` skips the wait entirely. Without them a user
 * whose payload is missing for a day has no way to tell a broken install from a
 * deliberate cooldown, and no way to test a fix.
 */
function backoffHint(failures: number): string {
  const at = Date.parse(nextAttemptAtFor(failures))
  return `next attempt ${new Date(at).toISOString().replace(".000Z", "Z")}, --force retries now`
}

/**
 * The same hint for the guard's early return, derived from what is on disk.
 *
 * Nothing from the environment is interpolated here, only a timestamp this module
 * itself wrote.
 */
async function backoffDetail(pkg: OptionalPackage): Promise<string> {
  const entry = (await readState()).packages?.[pkg]
  const at = entry?.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Number.NaN
  const when = Number.isNaN(at) ? "later" : new Date(at).toISOString().replace(".000Z", "Z")
  return `backing off after a failed ${pkg} install (next attempt ${when}); --force retries now`
}

/**
 * Whether an attempt may start — a RESERVATION is not a backoff.
 *
 * `nextAttemptAt` is written before every attempt so two processes cannot both
 * download a 500 MB payload, and it is also the ladder's output. Conflating them
 * makes `github-router update` (issued while an on-demand install is still
 * running, seconds after it reserved) report "backing off after a failed
 * tree-sitter-wasms install" when nothing had failed. With `consecutiveFailures`
 * still 0 the window is a reservation, so re-attempting is allowed; the loser of
 * the rename race adopts the winner's payload.
 */
async function mayAttemptNow(pkg: OptionalPackage): Promise<boolean> {
  const entry = (await readState()).packages?.[pkg]
  if ((entry?.consecutiveFailures ?? 0) === 0) return true
  if (!entry?.nextAttemptAt) return true
  const next = new Date(entry.nextAttemptAt).getTime()
  return Number.isNaN(next) ? true : Date.now() >= next
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface EnsureOptionalResult {
  /** The `node_modules/<pkg>` directory when usable, else null. */
  dir: string | null
  detail?: string
  installed?: boolean
}

/**
 * Make sure `pkg` is installed and return its directory.
 *
 * Fail-open and throttled: a failure is remembered on the standard ladder, so a
 * permanently offline machine does not spawn an npm process per search.
 */
export async function ensureOptionalPackage(
  pkg: OptionalPackage,
  opts: { signal?: AbortSignal; force?: boolean; registry?: string } = {},
): Promise<EnsureOptionalResult> {
  if (optionalInstallDisabled()) {
    return { dir: null, detail: "GH_ROUTER_NO_OPTIONAL_INSTALL is set" }
  }
  // Persist a schema migration before the guard can short-circuit on it: a stale
  // ladder must not survive by being read and then abandoned.
  await persistMigratedState()
  if (!opts.force && !(await mayAttemptNow(pkg))) {
    return { dir: null, detail: await backoffDetail(pkg) }
  }

  const npmPath = resolveExecutable("npm")
  if (!npmPath) {
    // No npm is not a reason to refuse a payload that is already installed.
    const existing = installedOptional(pkg)
    return existing ? { dir: existing } : { dir: null, detail: "npm is not on PATH" }
  }

  // Resolve FIRST, then compare against what is installed.
  //
  // The obvious order — "anything installed? return it" — makes the payload
  // permanently un-upgradable: the first install wins forever, `update` keeps
  // reporting the stale copy "ready", and a fix for a broken payload can never
  // reach a machine that already has one. `installedOptional` prefers the newest
  // copy but cannot know whether a NEWER version exists.
  const resolved = await resolveOptionalVersion(pkg, opts.registry)
  const version = resolved.version
  // A payload dir, so it can be returned as-is (wrapping it in `payloadDir` again
  // produced `<pkg>/node_modules/<pkg>/node_modules/<pkg>`).
  const existing = version ? installedOptionalTarget(pkg, version) : installedOptional(pkg)
  if (existing && !opts.force) {
    // Resolution failing while a usable payload is on disk is a DIFFERENT situation
    // from having nothing to install, and it used to be silent: the early return
    // skipped the failure branch entirely, so `update` said "ready" while every
    // future upgrade would fail at the first step. Reported at debug because the
    // user's payload works; not recorded on the ladder because an attempt that
    // delivered a working payload did not fail.
    if (!version && resolved.detail) {
      reportManagedDiagnostic(
        "debug",
        `optional: ${pkg} is installed but its version could not be resolved: ${resolved.detail}`,
      )
    }
    return { dir: existing }
  }

  if (!version) {
    // Ladder the RESOLUTION failure too. It used to hard-set
    // `consecutiveFailures: 1` on every attempt, which pinned the package at the
    // bottom rung of the ladder forever: a machine whose `npm view` was broken by
    // something we fixed could never climb out, and a genuinely offline machine
    // was retried hourly instead of backing off.
    const failures = ((await readState()).packages?.[pkg]?.consecutiveFailures ?? 0) + 1
    const detail = resolved.detail ?? `could not resolve a version for ${pkg}`
    await patchState(pkg, {
      lastAttemptAt: new Date().toISOString(),
      consecutiveFailures: failures,
      nextAttemptAt: nextAttemptAtFor(failures),
      lastError: detail,
      // Clear a stale success version so the state cannot read as healthy — but
      // only when nothing is on disk. `--force` reaches this branch with a working
      // payload installed (`existing` was computed above and the early return was
      // skipped), and erasing the version recorded for a payload that IS there is a
      // lie the next reader has to work around.
      ...(existing ? {} : { version: undefined }),
    })
    return { dir: null, detail: `${detail} (${backoffHint(failures)})` }
  }

  const target = optionalTarget(pkg, version)
  // A concurrent install may have published it while we resolved.
  if (completeAt(target, pkg)) return { dir: payloadDir(target, pkg), installed: false }

  // The newest copy this machine already had, captured BEFORE the install so GC
  // can be told to spare it (see the `gcOptional` call below). A running process
  // may have it memory-mapped: the ONNX runtime is loaded lazily, so "this
  // process installed the newer one" says nothing about whether it is still
  // reading the older one.
  const [previousTarget] = completeTargets(pkg)

  // Reservation only, with the ladder value keyed on the REAL failure count: a
  // first attempt has `consecutiveFailures` 0, which `mayAttemptNow` treats as
  // "not a backoff".
  await patchState(pkg, {
    lastAttemptAt: new Date().toISOString(),
    nextAttemptAt: nextAttemptAtFor((await readState()).packages?.[pkg]?.consecutiveFailures ?? 0),
  })

  try {
    await installInto(pkg, version, target, npmPath, opts.registry, opts.signal)
    await patchState(pkg, {
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
      version,
    })
    // Protect BOTH the copy this process was already using (a rerank that has the
    // ONNX runtime loaded memory-maps files from it) and the one just installed.
    // GC removes by age + rank, and "rank" cannot see a running
    // process: on POSIX an `fs.rm` of a mapped directory SUCCEEDS (`EBUSY` only
    // rescues Windows), so the next lazy load in that process dies. Protecting
    // these two names is the whole of what this process can know; the 30-day
    // floor and keep-2 rule cover the rest.
    const protect = [path.basename(target)]
    if (previousTarget) protect.push(previousTarget)
    await gcOptional(Date.now(), protect).catch(() => {})
    return { dir: payloadDir(target, pkg), installed: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const failures = ((await readState()).packages?.[pkg]?.consecutiveFailures ?? 0) + 1
    await patchState(pkg, {
      lastAttemptAt: new Date().toISOString(),
      consecutiveFailures: failures,
      nextAttemptAt: nextAttemptAtFor(failures),
      lastError: detail,
    })
    return { dir: null, detail }
  }
}

/**
 * Install `pkg@version` into `target` via a staging sibling.
 *
 * Same publish discipline as the managed installer (build in `.staging-*`,
 * verify the entry, rename into place) and for the same reason: the target may
 * be read concurrently by a running request, and a half-written payload that
 * passes a directory-existence check is worse than no payload.
 */
async function installInto(
  pkg: OptionalPackage,
  version: string,
  target: string,
  npmPath: string,
  registry?: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = optionalRoot()
  await fs.mkdir(root, { recursive: true })
  const staging = path.join(root, `.staging-${process.pid}-${randomHex()}`)
  // Not `recursive`: the name is unique, so an EEXIST means a leftover tree from
  // a same-pid attempt, and installing into it would let an INHERITED copy pass
  // the completeness check below. Fail and let the caller retry.
  await fs.mkdir(staging)
  try {
    const pkgJson = {
      name: `gh-router-optional-${sanitized(pkg)}`,
      private: true,
      version: "0.0.0",
      dependencies: { [subjectFor(pkg).packageName]: version },
    }
    await writeFileAtomic(path.join(staging, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`, {
      mode: 0o644,
    })

    const overrides: NodeJS.ProcessEnv = {}
    if (registry) overrides.npm_config_registry = registry
    const { env } = buildNpmEnv(process.env, overrides)

    reportManagedDiagnostic("info", `Installing optional ${pkg}@${version} (one-time)…`)
    const { code, stderr } = await runCommandCapture(
      [
        npmPath,
        "install",
        "--no-global",
        "--no-dry-run",
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...(registry ? [`--registry=${registry}`] : []),
      ],
      { cwd: staging, env, timeoutMs: 30 * 60_000, signal },
    )
    if (code !== 0) {
      throw new Error(`npm install ${pkg}@${version} failed (exit ${code}): ${stderr.slice(0, 400)}`)
    }
    if (!completeAt(staging, pkg)) {
      throw new Error(
        `${subjectFor(pkg).packageName}@${version} installed but ${subjectFor(pkg).requiredFile} is missing`,
      )
    }
    // The required file existing is not the same as the right version being
    // installed: a stale tree, a mirror serving another tarball, or a `--omit`
    // config that slipped through all look complete. The rename below publishes
    // this directory, so verify identity before that.
    try {
      const declared = (
        JSON.parse(await fs.readFile(path.join(payloadDir(staging, pkg), "package.json"), "utf8")) as {
          version?: unknown
        }
      ).version
      if (declared !== version) {
        throw new Error(
          `${subjectFor(pkg).packageName}@${version} installed but its package.json declares ${JSON.stringify(declared)}; refusing to publish it`,
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("refusing to publish")) throw err
      throw new Error(
        `${subjectFor(pkg).packageName}@${version} installed but its package.json is unreadable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      )
    }
    const packages = await harvestProvenance(staging)
    await writeFileAtomic(
      path.join(staging, ".installed.json"),
      `${JSON.stringify({ version, packages, installedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o644 },
    )

    try {
      await fs.rename(staging, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const clash =
        code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES"
      if (!clash) throw err
      // Somebody published it first. Adopt theirs if it is complete.
      if (completeAt(target, pkg)) return
      const aside = path.join(root, `.trash-${randomHex()}`)
      let movedAside = false
      try {
        await fs.rename(target, aside)
        movedAside = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
      try {
        await fs.rename(staging, target)
      } catch (err) {
        // Put the incomplete-but-present tree back rather than leaving the
        // package with NO copy at all: `installedOptional` refuses it either way,
        // but a single retry can repair it in place, and a missing directory
        // cannot be compared or resumed.
        if (movedAside) await fs.rename(aside, target).catch(() => {})
        throw err
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** `{ "<pkg>@<ver>": { resolved, integrity } }` from the prefix lockfile. */
async function harvestProvenance(
  prefix: string,
): Promise<Record<string, { resolved?: string; integrity?: string }>> {
  const out: Record<string, { resolved?: string; integrity?: string }> = {}
  try {
    const raw = await fs.readFile(path.join(prefix, "package-lock.json"), "utf8")
    const parsed = JSON.parse(raw) as {
      packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>
    }
    for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
      if (!key.startsWith("node_modules/") || entry.link || !entry.version) continue
      const name = key.slice("node_modules/".length)
      // Top-level only; the transitive tree is reproducible from the registry
      // once the root tarball's integrity is pinned.
      if (name.includes("node_modules/")) continue
      out[`${name}@${entry.version}`] = {
        ...(entry.resolved ? { resolved: entry.resolved } : {}),
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      }
    }
  } catch {
    // No lockfile: provenance is diagnostics, never a gate.
  }
  return out
}

/**
 * Newest published version of `pkg`, or a `detail` explaining why there is none.
 *
 * The `detail` is not cosmetic. This resolution step is the one that fails for a
 * reason the user cannot see: a registry that cannot answer, or — the case that
 * shipped — an argv that reached npm corrupted, so `npm view` exited non-zero
 * and said `EINVALIDTAGNAME` while the caller reported a generic "could not
 * resolve a version". Carrying npm's own error code and summary through turns a
 * silent, unactionable backoff into a diagnosis.
 */
async function resolveOptionalVersion(
  pkg: OptionalPackage,
  registry?: string,
): Promise<{ version: string | null; detail?: string }> {
  const pinned = subjectFor(pkg).version
  if (pinned) return { version: pinned }
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return { version: null, detail: "npm is not on PATH" }
  const subject = subjectFor(pkg)
  // With a range, npm does the range arithmetic and `--json` gives every match
  // newest-last; without one (a test stand-in) the spec is the bare name.
  const spec = subject.range ? `${subject.packageName}@${subject.range}` : subject.packageName
  try {
    const args = [npmPath, "view", spec, "version", "--json", "--silent"]
    if (registry) args.push(`--registry=${registry}`)
    const { stdout, stderr, code } = await runCommandCapture(args, { timeoutMs: 8000 })
    if (code !== 0) {
      const why = npmFailureDetail(stdout, stderr)
      // A silent failure (npm killed by a signal, a wrapper that exits without a
      // word) would otherwise produce `failed (exit 1): ` with a dangling colon.
      const reason = why ? `failed (exit ${code}): ${why}` : `failed (exit ${code}) with no message`
      return { version: null, detail: `npm view ${spec} ${reason}` }
    }
    const value = lastVersionFromJson(stdout)
    if (value && VERSION_RE.test(value)) return { version: value }
    const seen = sanitizeDiagnostic(JSON.stringify(stdout.trim().slice(0, 120)))
    return { version: null, detail: `npm view ${spec} returned ${seen}` }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { version: null, detail: `npm view ${spec} failed: ${sanitizeDiagnostic(why)}` }
  }
}

/**
 * Why `npm view` failed, in one readable line.
 *
 * Under `--json` npm does NOT put that sentence on stderr. It writes a JSON error
 * ENVELOPE to stdout and leaves stderr empty:
 *
 *   {"error":{"code":"EINVALIDTAGNAME","summary":"Invalid tag name \"^^0.1.13\" …"}}
 *
 * so reading the first line of either stream yields `"{"` — measured, for the very
 * failure this branch exists to explain. Parsing the envelope is what makes the
 * message carry `EINVALIDTAGNAME` and the bad spec instead of a brace; the
 * line-based read stays as the fallback for a non-JSON failure (a crashed npm, a
 * proxy error page, a spawn-level message on stderr).
 */
function npmFailureDetail(stdout: string, stderr: string): string {
  for (const stream of [stdout, stderr]) {
    const parsed = parseJson(stream)
    const error = (parsed as { error?: unknown } | null)?.error
    if (error && typeof error === "object") {
      const { code, summary } = error as { code?: unknown; summary?: unknown }
      const parts = [code, summary].filter((part): part is string => typeof part === "string")
      if (parts.length > 0) return sanitizeDiagnostic(parts.join(" "))
    }
  }
  return sanitizeDiagnostic(firstLine(stderr || stdout))
}

/**
 * Make a third-party diagnostic safe to store and print.
 *
 * `lastError` is written to `optional/install-state.json` (mode 0644) and echoed
 * to the terminal by `update`. The text comes from npm, which comes from whatever
 * registry answered, so it is untrusted input, and there are three concrete shapes
 * it can take:
 *
 *   - **ANSI/control characters.** A registry behind a corporate proxy can answer
 *     with a coloured or framed error page, and an escape sequence replayed into a
 *     terminal can rewrite the line the user is reading. Whole sequences are
 *     removed, then any remaining control byte and any zero-width/bidi override:
 *     nothing here is worth preserving, and the `npm view --json` output that
 *     matters is parsed before it reaches this function.
 *   - **A URL with credentials.** `resolveOptionalVersion` passes
 *     `--registry=<url>`, and npm echoes the request URL on 401/404 — so a
 *     `https://user:token@mirror` registry would land in a world-readable file and
 *     on the terminal. Userinfo is replaced wholesale rather than partly kept,
 *     because a redactor that preserves "the useful part" of a secret is one regex
 *     bug away from leaking it.
 *   - **Length.** A megabyte of proxy HTML does not belong in a state file.
 *
 * Deliberately local rather than `sanitizeTransportText` from `../upstream-retry`:
 * that module imports `consola`, and this layer is documented as the one that must
 * not (see `./paths`, `./diagnostics`), because it is reachable from the bin bundle
 * and from request paths.
 */
function sanitizeDiagnostic(text: string): string {
  const flat = text
    // Normalise the C1 single-byte CSI (`\u009b`) to its two-byte form first, so
    // the CSI rule below has one shape to handle. Without this the control pass
    // turned it into a space and left `31mcyan` behind — measured.
    .replace(/\u009b/g, "\u001b[")
    // Whole ANSI escape sequences first, not just the ESC byte. Removing only
    // `\x1b` leaves the parameters behind as printable text — measured, a
    // coloured `npm ERR!` came out as `[31mE401 for …[0m`, which is uglier than
    // what it replaced and still leaks terminal framing into a state file. CSI
    // (`ESC [ … final`), OSC (`ESC ] … BEL|ST`) and the two-byte forms cover what
    // a registry, a proxy error page or a progress bar can emit.
    //
    // The OSC body stops at BEL, at ST, at end-of-string, or at the LOOKAHEAD of
    // another ESC. That last alternative is the one that matters: an OSC with no
    // terminator is common in truncated npm output, and the naive alternation
    // either matched it not at all (leaving `ESC]8;;url`, which the CSI rule then
    // turned into `ttps://…` with its head eaten) or, with a fully lazy `[\s\S]*?`,
    // swallowed every later escape on the line as well.
    // eslint-disable-next-line no-control-regex -- matching escape sequences IS the point.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b)|$)/g, "")
    // eslint-disable-next-line no-control-regex -- as above.
    .replace(/\u001b[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g, "")
    // Whatever ESC is left introduces a sequence this build does not model (an
    // SSC/DCS, or a truncated one). Drop the ESC and the character after it, the
    // same way a terminal consumes a two-byte function: leaving the bare ESC is
    // the one outcome that must never survive, since it makes the FOLLOWING text
    // a control sequence again on display.
    // eslint-disable-next-line no-control-regex -- as above.
    .replace(/\u001b[\s\S]/g, "")
    // Zero-width and bidirectional overrides. These are not control bytes, so the
    // next pass misses them, and they are the cheap way to make one line READ as
    // another in a terminal or an editor (a U+202E turns the rest of the line
    // around). Nothing a registry has to say needs them.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    // Anything left that a terminal would execute or a JSON reader would choke
    // on: C0/C1, and the two Unicode line separators that are not `\n`.
    // eslint-disable-next-line no-control-regex -- as above.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Greedy up to the LAST `@` before the path, not the first. A URL can legally
    // carry more than one: `https://a@b:c@host/x` redacted non-greedily kept
    // `b:c` in clear, which is exactly the half of a credential worth stealing.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[REDACTED]@")
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/** `JSON.parse` that returns null instead of throwing on the non-JSON cases above. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * First non-empty line of a diagnostic, trimmed.
 *
 * Both streams are candidates because npm's choice is not stable across versions
 * and subcommands, and neither is guaranteed. Used only as the non-JSON fallback
 * now — see `npmFailureDetail` for why the first line of `--json` output is not a
 * diagnosis.
 */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((part) => part.trim().length > 0)?.trim() ?? ""
}

/**
 * The newest version in `npm view … --json` output, or null.
 *
 * The output is a bare `"1.2.3"` when the spec matches exactly one version and
 * an ARRAY when a range matches several — and `npm view left-pad@^1.0.0 version`
 * prints the array newest-LAST, so the last element is the answer in both cases.
 * Parsing it as JSON rather than taking the last LINE is what makes a range with
 * a hundred matches work; the old line-based read returned `"1.3.0"` (with the
 * quotes) and the version regex then rejected it.
 */
function lastVersionFromJson(stdout: string): string | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "string") return parsed
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const entry = parsed[i]
        if (typeof entry === "string") return entry
      }
    }
    return null
  } catch {
    return null
  }
}

/** Compare dotted versions on the leading three components. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const av = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0)
    const bv = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0)
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Keep the newest `KEEP_OPTIONAL_VERSIONS` copies per package and sweep
 * abandoned staging/trash dirs.
 *
 * Deliberately more conservative than the managed GC (30-day floor, keep 2, and
 * never remove the only copy of a package): each copy is up to 547 MB, so
 * deleting the wrong one is expensive to undo.
 *
 * `protect` is the caller's knowledge of what is IN USE — directory names under
 * the optional root that must survive this sweep. Nothing on disk records which
 * copy a running process has loaded, and the two rules here cannot infer it: a
 * process that has been up for weeks holds an old version that ranks below the
 * two newest and is past the floor, and on POSIX `fs.rm` of a memory-mapped
 * payload SUCCEEDS (`EBUSY` only saves Windows). The next lazy load in that
 * process would then fail. The installer passes the copy it just wrote and the
 * one it replaced.
 */
export async function gcOptional(
  now = Date.now(),
  protect: ReadonlyArray<string> = [],
): Promise<{
  removed: Array<string>
  removedTransient: Array<string>
}> {
  const root = optionalRoot()
  let names: Array<string>
  try {
    names = await fs.readdir(root)
  } catch {
    return { removed: [], removedTransient: [] }
  }

  const removed: Array<string> = []
  const removedTransient: Array<string> = []

  // Bucket by package, carrying mtime so "newest" is by time, not by the order
  // the filesystem happened to hand back.
  const versions = new Map<string, Array<{ name: string; mtimeMs: number }>>()

  for (const name of names) {
    const full = path.join(root, name)
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(full)).mtimeMs
    } catch {
      continue
    }
    // Same shapes as the managed GC (`paths.ts`): a user file that merely
    // starts with `.staging-` is not one of our abandoned attempts.
    if (isTransientName(name)) {
      if (now - mtimeMs > 60 * 60_000) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => {})
        removedTransient.push(name)
      }
      continue
    }
    const match = /^(.+?)@(.+)$/.exec(name)
    if (!match) continue
    if (!isVersionName(match[2]!)) continue
    const bucket = versions.get(match[1]!) ?? []
    bucket.push({ name, mtimeMs })
    versions.set(match[1]!, bucket)
  }

  const spared = new Set(protect)
  for (const entries of versions.values()) {
    // Newest first, then keep the first N. Everything from index N on is a
    // removal CANDIDATE, still subject to the age floor and the protect list.
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const entry of entries.slice(KEEP_OPTIONAL_VERSIONS)) {
      if (spared.has(entry.name)) continue
      if (now - entry.mtimeMs < OPTIONAL_FLOOR_MS) continue
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true })
        .then(() => removed.push(entry.name))
        .catch(() => {
          // EBUSY on Windows (a loaded ONNX runtime): retried on the next pass.
        })
    }
  }
  return { removed, removedTransient }
}

// ---------------------------------------------------------------------------
// Entry points used by the launcher / update
// ---------------------------------------------------------------------------

/**
 * Install ONE payload, whichever a caller asked for by name.
 *
 * Separate entry point from `ensureOptionalPackage` because the argument comes
 * from a command line: an unknown name must be a reported no-op, never a crash
 * and never "install everything because the filter matched nothing".
 */
export function isOptionalPackage(name: string): name is OptionalPackage {
  return (OPTIONAL_PACKAGES as ReadonlyArray<string>).includes(name)
}

/**
 * Install both payloads, reporting what happened.
 *
 * Called from `github-router update` (foreground, where a failure is visible)
 * and never from a request path.
 */
export async function ensureOptionalPackages(
  opts: { registry?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<Array<{ pkg: OptionalPackage; dir: string | null; detail?: string }>> {
  const out: Array<{ pkg: OptionalPackage; dir: string | null; detail?: string }> = []
  for (const pkg of OPTIONAL_PACKAGES) {
    const result = await ensureOptionalPackage(pkg, opts)
    out.push({ pkg, dir: result.dir, ...(result.detail ? { detail: result.detail } : {}) })
  }
  return out
}

/** Set by {@link scheduleOptionalInstall}; one detached child per process. */
let scheduledInProcess = false

/**
 * Detached, best-effort install for a launch that noticed a gap.
 *
 * Detached because the spawn cost of two npm installs (minutes on a cold cache)
 * must never be attributed to the command the user actually ran — and a search
 * that triggered this proceeds on its BM25F fallback regardless.
 */
export function scheduleOptionalInstall(
  pkg: OptionalPackage,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (optionalInstallDisabled()) return false
  if (typeof argv1 !== "string" || argv1.length === 0) return false
  // Once per process. The callers are on request paths (a rerank, a structural
  // search), and for an agent a "request path" means per turn: spawning a
  // detached node process on every one of them would be worse than the missing
  // payload. Cross-process throttling is the backoff in `install-state.json`;
  // this flag only stops the same process from re-spawning what it already
  // started.
  if (scheduledInProcess) return false
  scheduledInProcess = true
  const missing = pkg
  void (async () => {
    try {
      // Dynamic on purpose: modules that only ever RESOLVE a payload (the
      // rerank loader, the grammar resolver) should not pull
      // `node:child_process` into their import graph.
      const { spawn } = await import("node:child_process")
      // `--optional-only --optional-pkg <pkg>`: the caller is a feature that found
      // no payload, so installing THAT payload is the whole request. Not a
      // self-update, not a managed Pi appearing on a source checkout because a
      // search was slow, and — the part that is easy to get wrong — not the OTHER
      // payload either: a structural-search miss must not start a 547 MB ONNX
      // download because both slots share one flag.
      const child = spawn(
        process.execPath,
        [argv1, "update", "--quiet", "--optional-only", "--optional-pkg", missing],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, GH_ROUTER_MANAGED_BACKGROUND: "1" },
        },
      )
      child.on("error", () => {})
      child.unref()
    } catch {
      // Never fatal: the next launch (or an explicit `update`) tries again.
    }
  })()
  return true
}

