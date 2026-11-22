/**
 * Where did this process start from?
 *
 * The bootstrap (`dist/bin.js`) has to answer one question before it does
 * anything else: *is the tree I am running from a disposable copy?* If it is
 * (`npx`, `bunx`), adopting the managed install is the whole point of the
 * feature. If it is not (`npm i -g`, a git checkout, or already managed), the
 * bootstrap must be a pure pass-through — user decision 4 is explicit that a
 * global install stays its own owner and must never be duplicated.
 *
 * Classification is deliberately **positive** and **fail-safe**: each branch
 * needs evidence (a realpath under a known root, a `.git` marker), and the
 * default answer is `unknown`, which every caller treats as `source` — no adopt,
 * no install, no background work. A wrong `npx` answer costs the user a 66 MB
 * install they did not want; a wrong `source` answer costs nothing.
 *
 * Cost matters here in a way it does not elsewhere: this runs on EVERY CLI
 * invocation. So every probe is bounded, cached in-process, and the two that
 * spawn (`npm root -g`, `npm config get cache`) are cached across runs in
 * `install-state.json` — `NPM_CONFIG_CACHE` moving is rare enough that one
 * stale read is worth avoiding 300 ms on every launch.
 */

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveExecutable, runCommandCapture } from "../exec"
import { isUnderVolatileRoot, realpathIfPossible } from "../volatile-root"
import { reportManagedDiagnostic } from "./diagnostics"
import { patchInstallState, readInstallState } from "./state"
import { type ManagedKind, appDir, managedRoot } from "./paths"

export type InstallOrigin = "managed" | "npm-global" | "npx" | "bunx" | "source" | "unknown"

export interface OriginInfo {
  origin: InstallOrigin
  /** Realpath of the running package root, when it could be determined. */
  packageRoot?: string
  /** One-line reason, for `--debug` and for the "why did nothing happen" question. */
  detail: string
}

/** Timeout for the two npm probes. A cold `npm root -g` can take ~300 ms. */
const PROBE_TIMEOUT_MS = 5000

let cached: OriginInfo | undefined

/** @internal — reset module state between test cases. */
export function __resetOriginForTests(): void {
  cached = undefined
}

/** The running package root: the directory holding `package.json` for this code. */
export function currentPackageRoot(): string | undefined {
  return findPackageRoot(process.argv[1])
}

/** Walk up from `entry` to the `github-router` package root. */
export function findPackageRoot(entry: string | undefined): string | undefined {
  if (typeof entry !== "string" || entry.length === 0) return undefined
  let cur = path.dirname(realpathIfPossible(entry))
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cur, "package.json"), "utf8")) as {
        name?: unknown
      }
      // Exact names, not a substring: `not-github-router` and
      // `@someone/github-router-helper` are different packages, and adopting
      // based on a substring would let a look-alike tree claim the origin.
      if (pkg.name === "github-router" || pkg.name === "@animeshkundu/github-router") return cur
    } catch {
      // Not here; keep walking.
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Normalized, separator-trailing form so prefix tests cannot match `/foo` in
 * `/foobar`.
 *
 * Lowercased on Windows: NTFS is case-insensitive, so `C:\Users\X\AppData\npm`
 * (what `npm root -g` reports) and `c:\users\x\appdata\npm\node_modules\…`
 * (what a launcher spawned from a differently-cased PATH entry sees) are the same
 * directory and must compare equal. A case-sensitive compare would classify a
 * global install as `unknown` — and `unknown` means "never adopt, never install",
 * so the failure is a silent absence of the feature on that machine.
 */
function asPrefix(dir: string): string {
  const resolved = realpathIfPossible(dir)
  const withSep = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`
  return process.platform === "win32" ? withSep.toLowerCase() : withSep
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

function isUnder(target: string, root: string): boolean {
  if (!root) return false
  const prefix = asPrefix(root)
  // Resolve both sides: macOS reports /var/... while a process sees
  // /private/var/..., and a symlinked APP_DIR is normal on Linux setups.
  for (const candidate of [target, realpathIfPossible(target)]) {
    if (normalizeForCompare(candidate).startsWith(prefix)) return true
    if (normalizeForCompare(realpathIfPossible(candidate)).startsWith(prefix)) return true
  }
  return false
}

/** One `npm config get <key>` probe, bounded and never throwing. */
async function npmConfigValue(args: Array<string>): Promise<string | null> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return null
  try {
    const { stdout, code } = await runCommandCapture([npmPath, ...args], {
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (code !== 0) return null
    const value = stdout.trim().split(/\r?\n/).pop()?.trim()
    return value && path.isAbsolute(value) ? value : null
  } catch {
    return null
  }
}

interface NpmProbes {
  globalRoot: string | null
  cacheRoot: string | null
}

/**
 * Resolve (and memoise) both npm probes.
 *
 * Cached in-process for the life of this process and across runs in
 * `install-state.json`, keyed by `process.execPath`. The key matters: under nvm
 * the global root IS per-node-version, so an unkeyed cache would point the next
 * launch at a tree that node version no longer owns.
 *
 * One probe run per cache miss, not one per query: `classifyEntry` needs both,
 * and each is a ~250 ms subprocess.
 */
async function npmProbes(kind: ManagedKind = "self"): Promise<NpmProbes> {
  const runtime = process.execPath
  const state = await readInstallState(kind)
  const cached = state.npmProbe
  if (cached?.runtime === runtime && cached.globalRoot && cached.cacheRoot) {
    return { globalRoot: cached.globalRoot, cacheRoot: cached.cacheRoot }
  }
  const [globalRoot, cacheRoot] = await Promise.all([
    cached?.runtime === runtime && cached.globalRoot
      ? Promise.resolve(cached.globalRoot)
      : npmConfigValue(["root", "-g"]),
    cached?.runtime === runtime && cached.cacheRoot
      ? Promise.resolve(cached.cacheRoot)
      : npmConfigValue(["config", "get", "cache"]),
  ])
  if (globalRoot || cacheRoot) {
    await patchInstallState(kind, {
      // Keep the flat field for older readers/messages.
      ...(cacheRoot ? { npmCache: cacheRoot } : {}),
      npmProbe: {
        runtime,
        ...(globalRoot ? { globalRoot } : {}),
        ...(cacheRoot ? { cacheRoot } : {}),
      },
    })
  }
  return { globalRoot, cacheRoot }
}

/**
 * Classify this process's install origin.
 *
 * Order is significant and cheapest-first:
 *
 * 1. `managed` — a realpath under our own version dir. This must come first and
 *    short-circuit the pointer read, or a managed payload would adopt itself.
 * 2. `npm-global` — under `npm root -g`. User decision 4: never duplicated.
 * 3. `npx` — under `<npm cache>/_npx`.
 * 4. `source` — a `.git` beside the package root. Deliberately ahead of the
 *    volatility heuristic: a checkout in `/tmp` is still the developer's code.
 * 5. `bunx` — under a `.bunx-*` root, or any other volatile temp root.
 * 6. `unknown` — everything else, including "the package root could not be
 *    found". Treated exactly like `source` by every caller.
 */
export async function classifyOrigin(): Promise<OriginInfo> {
  if (cached) return cached
  const info = await classifyEntry(process.argv[1])
  cached = info
  return info
}

/**
 * Classify an arbitrary entry path.
 *
 * Extracted from `classifyOrigin` so the matrix is testable without respawning
 * the test runner with a doctored argv: the classification is pure with respect
 * to `entry`, and the only impurity (two npm probes) is already injectable via
 * the process PATH and the install-state cache.
 */
export async function classifyEntry(entry: string | undefined): Promise<OriginInfo> {
  if (typeof entry !== "string" || entry.length === 0) {
    return { origin: "unknown", detail: "no argv[1]; cannot tell where this code lives" }
  }
  const packageRoot = findPackageRoot(entry)
  const probe = packageRoot ?? path.dirname(realpathIfPossible(entry))

  if (isUnder(probe, managedRootOf("self")) || isUnder(probe, managedRootOf("pi"))) {
    return { origin: "managed", packageRoot, detail: `running from the managed tree (${probe})` }
  }

  const { globalRoot, cacheRoot } = await npmProbes()
  if (globalRoot && isUnder(probe, globalRoot)) {
    return {
      origin: "npm-global",
      packageRoot,
      detail: `running from the global install ${globalRoot}`,
    }
  }

  if (cacheRoot && isUnder(probe, path.join(cacheRoot, "_npx"))) {
    return { origin: "npx", packageRoot, detail: `running from the npx cache ${path.join(cacheRoot, "_npx")}` }
  }

  // A `.git` beside the package root is STRONGER evidence than "this path is in
  // a temp dir": a developer who cloned the repo into /tmp and runs it there is
  // running their own code and must not be silently switched onto a managed
  // build. So source is checked before the volatility heuristic.
  if (hasGitAncestor(packageRoot ?? probe)) {
    return { origin: "source", packageRoot, detail: `running from a git checkout (${packageRoot ?? probe})` }
  }

  // `bunx` no longer materialises a `.bunx-*` temp tree: current bun resolves
  // into its shared cache (`~/.bun/install/cache`, or `$BUN_INSTALL/cache`) and
  // executes from there. `isUnderVolatileRoot` does NOT cover that directory —
  // it is under $HOME, not the temp dir — so without this the most common modern
  // `bunx github-router` classified as `unknown`, which means "never adopt, never
  // install": the managed layer simply never engaged for bun users.
  if (isUnderBunCache(probe)) {
    return { origin: "bunx", packageRoot, detail: `running from the bun cache (${BUN_CACHE_HINT})` }
  }

  if (probe.includes(`${path.sep}.bunx-`) || isUnderVolatileRoot(probe)) {
    return { origin: "bunx", packageRoot, detail: `running from a volatile bunx/temp tree (${probe})` }
  }

  // A tree we cannot place. Refusing to act is the safe direction: the worst
  // outcome is that the managed install simply does not engage.
  reportManagedDiagnostic("debug", `managed: unrecognised install origin at ${probe}`)
  return { origin: "unknown", packageRoot, detail: `unrecognised origin (${probe})` }
}

/**
 * Whether a `.git` sits at or above `dir`.
 *
 * "Above" matters: in a checkout the package.json IS the repo root, but a
 * monorepo/workspace has the package in a subdirectory with `.git` above it, and
 * a `git worktree` checkout puts `.git` in the parent with a pointer file. All
 * three are the developer's own code.
 *
 * Bounded and non-recursive past the filesystem root; `existsSync` rather than a
 * stat-only check so a `.git` FILE (worktree/submodule) counts too.
 */
function hasGitAncestor(dir: string): boolean {
  let cur = dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(cur, ".git"))) return true
    const parent = path.dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
  return false
}

/** Where a `bunx` tree lands, for the diagnostic string. */
const BUN_CACHE_HINT = "$BUN_INSTALL/cache (or ~/.bun/install/cache)"

/**
 * Whether `dir` is inside bun's shared install cache.
 *
 * Both the cache root and its parent are tested, because bun's layout has been
 * `install/cache/<pkg>@<ver>@@@1` and, in older versions, a sibling directory.
 * Case-insensitive on Windows for the same reason `asPrefix` is.
 */
function isUnderBunCache(dir: string): boolean {
  const candidates = [process.env.BUN_INSTALL, process.env.BUN_INSTALL_CACHE_DIR].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  const roots = new Set<string>()
  for (const base of candidates) {
    roots.add(path.join(base, "cache"))
    roots.add(path.join(base, "install", "cache"))
  }
  const home = os.homedir()
  if (home) {
    // The CACHE only, deliberately. `~/.bun/install/global` is where `bun add -g`
    // puts a user's own global install, and user decision 4 is that a global
    // install is never duplicated — classifying it as `bunx` would silently swap
    // the binary a user installed for a managed one.
    roots.add(path.join(home, ".bun", "install", "cache"))
  }
  for (const root of roots) {
    // Both spellings, like every other prefix test in this file: a caller may
    // hand us a resolved path and a PATH/cache root that is not (or vice versa).
    if (isUnder(dir, root) || isUnder(realpathIfPossible(dir), realpathIfPossible(root))) return true
  }
  return false
}

function managedRootOf(kind: ManagedKind): string {
  return managedRoot(kind)
}

/**
 * Whether this origin should adopt an existing managed install.
 *
 * Kept as its own function so the policy is one line to read and one line to
 * change: only the disposable-copy origins adopt. `npm-global` and `source`
 * never do (their trees are the owner's), and `unknown` never does.
 */
export function shouldAdoptFor(origin: InstallOrigin): boolean {
  return origin === "npx" || origin === "bunx"
}

/** Whether this origin should kick off a managed install in the background. */
export function shouldInstallFor(origin: InstallOrigin): boolean {
  return origin === "npx" || origin === "bunx"
}

/** Human name for the origin, for the `update`/`--debug` output. */
export function describeOrigin(origin: InstallOrigin): string {
  switch (origin) {
    case "managed":
      return "managed install"
    case "npm-global":
      return "npm global install"
    case "npx":
      return "npx cache"
    case "bunx":
      return "bunx temporary tree"
    case "source":
      return "source checkout"
    case "unknown":
      return "unrecognised"
  }
}

/** The app dir, exposed for messages. */
export function managedAppDir(): string {
  return appDir()
}
