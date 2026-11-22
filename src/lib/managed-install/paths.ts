/**
 * Filesystem layout for the managed install.
 *
 * `npx github-router@latest` re-extracts a ~586 MB tree for every published
 * version (measured: 16 releases in 31 days), so the router wants the Claude
 * Code shape instead: install once into a per-user prefix, keep versioned
 * payloads side by side, and let a pointer decide which one runs. This module is
 * only the NAMES — no I/O — so it can be imported by the standalone launcher,
 * the CLI, and tests without pulling in npm or the app graph.
 *
 * ```
 * <APP_DIR>/m/<kind>/
 *     current.json                  the only mutable pointer (atomic file rename)
 *     launcher.mjs                  stable path, written once, never swapped
 *     install-state.json            lastAttemptAt / failures / cache
 *     <version>/package.json        generated { private: true, dependencies: … }
 *     <version>/node_modules/…      immutable payload
 *     <version>/.installed.json     {version, resolved, integrity, installedAt, runtime}
 *     .staging-<pid>-<rand>/        npm --prefix target, renamed away on publish
 *     .trash-<rand>/                rename-aside target for a corrupt version
 * <APP_DIR>/optional/<pkg>@<version>/   shared heavy payload (§8 of the plan)
 * <APP_DIR>/cli-bin/github-router…      shims
 * ```
 *
 * Two naming decisions are load-bearing and must not drift:
 *
 * 1. **`<version>` is the version dir name directly under `<kind>`**, not under a
 *    `versions/` level. Windows `MAX_PATH` applies per file, and an installed
 *    npm tree already carries ~139 characters of relative path; the
 *    `versions/<v>` form pushes a Pi payload past 260 for an 18-character
 *    username (measured 264 vs 249). See the plan's §7 table.
 * 2. **Every transient name starts with `.`**. That single rule is the GC
 *    contract: anything `readdir` returns that starts with `.` is never a
 *    version, so a killed install can never be mistaken for one.
 */

import os from "node:os"
import path from "node:path"

/** Kinds of payload the router keeps installed. */
export type ManagedKind = "self" | "pi"

/**
 * The app-data root. Mirrors `PATHS.APP_DIR` (`src/lib/paths.ts:9`) but is
 * resolved independently: the launcher runs before the app graph loads (and
 * must not import `consola` or `cloudagent-hook-settings`), and tests need to
 * relocate it without touching the real `~/.local/share`.
 */
export function appDir(): string {
  const override = process.env.GH_ROUTER_APP_DIR?.trim()
  if (override && path.isAbsolute(override)) return override
  return path.join(os.homedir(), ".local", "share", "github-router")
}

export function managedRoot(kind: ManagedKind): string {
  return path.join(appDir(), "m", kind)
}

export function pointerPath(kind: ManagedKind): string {
  return path.join(managedRoot(kind), "current.json")
}

/**
 * The launcher's path never changes across versions — that is its whole job.
 *
 * `.mjs`, not `.js`, for the same reason the hooks bundle chose `.mjs`
 * (`tsdown.config.ts`): this file sits in a directory with no governing
 * `package.json`, so on Node 20 / 22.0-22.6 a `.js` name is parsed as CommonJS
 * and dies on its first `import`. `import.meta` and top-level await are in the
 * body, so the name has to say ESM on every runtime.
 */
export function launcherPath(kind: ManagedKind): string {
  return path.join(managedRoot(kind), "launcher.mjs")
}

export function installStatePath(kind: ManagedKind): string {
  return path.join(managedRoot(kind), "install-state.json")
}

/** A concrete installed payload. `dirName` is what `readdir` reports. */
export function versionDir(kind: ManagedKind, version: string): string {
  return path.join(managedRoot(kind), version)
}

export function installedMarkerPath(kind: ManagedKind, version: string): string {
  return path.join(versionDir(kind, version), ".installed.json")
}

/**
 * A private, per-attempt npm prefix.
 *
 * Inside `<kind>/` on purpose: `rename()` must stay same-directory, because a
 * cross-device rename is `EXDEV` and stops being atomic, and because people do
 * symlink such directories onto a roomier volume. The `.` prefix keeps GC from
 * ever counting it as a version; the pid makes a dead installer's leftover
 * identifiable without reading anything.
 */
export function stagingDir(kind: ManagedKind, pid = process.pid, rand = randomHex()): string {
  return path.join(managedRoot(kind), `.staging-${pid}-${rand}`)
}

/** Where a corrupt version dir is moved aside to before a re-publish. */
export function trashDir(kind: ManagedKind, rand = randomHex()): string {
  return path.join(managedRoot(kind), `.trash-${rand}`)
}

/** Shims live outside `APP_DIR/bin`, which the toolbelt prunes. */
export function cliBinDir(): string {
  return path.join(appDir(), "cli-bin")
}

export function shimPath(base: string, platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? `${base}.cmd` : base
  return path.join(cliBinDir(), name)
}

/**
 * Root for the shared heavy payloads (`@huggingface/transformers`,
 * `tree-sitter-wasms`).
 *
 * Outside `m/<kind>/<version>/` on purpose: those are per-version and GC keeps
 * two of them, so an in-tree copy of a 547 MB model runtime would be 1.1 GB and
 * would be re-downloaded on every version bump. Here it exists once per machine.
 */
export function optionalRoot(): string {
  return path.join(appDir(), "optional")
}

/**
 * Name shapes GC recognises, defined once.
 *
 * `install.ts` and `optional.ts` both sweep `.staging-*`/`.trash-*` leftovers and
 * both classify `<version>` dirs. They matched these inline before, which meant
 * the transient-name contract (`paths.ts`'s own doc block calls the leading dot
 * load-bearing) was stated in three places and could drift in two of them.
 *
 * The version shape is deliberately strict: semver-ish triples, no leading dot
 * and no prerelease-only names, so a stray `README`, `.DS_Store` or lock file is
 * never mistaken for a payload.
 */
export const STAGING_RE = /^\.staging-\d+-[0-9a-f]+$/
export const TRASH_RE = /^\.trash-[0-9a-f]+$/
export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export function isVersionName(name: string): boolean {
  return VERSION_RE.test(name)
}

export function isTransientName(name: string): boolean {
  return name.startsWith(".") && (STAGING_RE.test(name) || TRASH_RE.test(name))
}

export function randomHex(): string {
  // `randomBytes` is not imported at module scope: the launcher this module is
  // inlined into runs before any bundler chunk resolves, and `node:crypto` is
  // one more external the inlining recipe has to keep. `Math.random` is
  // adequate here — the value only has to be unique among sibling attempts,
  // and the pid is already part of the name.
  return Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0")
}

/**
 * Relative entry path for a kind, once its package is installed.
 *
 * `self` names the APP entry (`dist/main.js`), never the published bin
 * (`dist/bin.js`). That is not cosmetic: the bin IS the bootstrap, so a pointer
 * derived from the bin map would re-exec the bootstrap, which reads the same
 * pointer, forever. `pointer.isSafeEntry` refuses it as a second line of defence.
 */
export const ENTRY_RELATIVE: Readonly<Record<ManagedKind, string>> = {
  self: "node_modules/github-router/dist/main.js",
  pi: "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
}

/** The npm package each kind installs. */
export const NPM_PACKAGE: Readonly<Record<ManagedKind, string>> = {
  self: "github-router",
  pi: "@earendil-works/pi-coding-agent",
}

/**
 * Test seams for the two constants above.
 *
 * The installer's interesting behaviour (staging, publish-by-rename, provenance,
 * GC) is identical for a 6 KB package with no install scripts and for the real
 * 66 MB payload, so the end-to-end test installs a tiny one. Without these the
 * test would either need the network and a minute per case, or would have to
 * re-implement the layout — which is exactly the duplicated-logic trap that
 * makes a test pass while production breaks.
 *
 * Not part of the public surface: nothing in `src/` calls them.
 */
let entryOverride: Partial<Record<ManagedKind, string>> = {}
let packageOverride: Partial<Record<ManagedKind, string>> = {}

export function entryRelativeFor(kind: ManagedKind): string {
  return entryOverride[kind] ?? ENTRY_RELATIVE[kind]
}

export function npmPackageFor(kind: ManagedKind): string {
  return packageOverride[kind] ?? NPM_PACKAGE[kind]
}

/** @internal — point the installer at a throwaway package for a test. */
export function __setManagedTestTarget(
  kind: ManagedKind,
  target: { entry?: string; package?: string },
): void {
  if (target.entry !== undefined) entryOverride = { ...entryOverride, [kind]: target.entry }
  if (target.package !== undefined) packageOverride = { ...packageOverride, [kind]: target.package }
}

/** @internal — restore the real targets between test cases. */
export function __resetManagedTestTarget(): void {
  entryOverride = {}
  packageOverride = {}
}
