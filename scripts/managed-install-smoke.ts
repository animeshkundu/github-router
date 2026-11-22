#!/usr/bin/env bun
/**
 * Cross-platform smoke for the managed install.
 *
 * Everything else in the suite tests the pieces with fakes. This runs the whole
 * chain the way a user's machine does it, once per OS in CI:
 *
 *   1. a consumer install of the packed tarball into a directory that LOOKS like
 *      the npx cache (that is the only origin that adopts, and its layout is what
 *      `classifyEntry` keys on);
 *   2. `update --self --no-optional` → a real npm install of the real package
 *      into `<APP_DIR>/m/self/<version>/`;
 *   3. a second run of the ORIGINAL entry → the bootstrap must re-exec into the
 *      managed payload and print exactly ONE version line (two banners would mean
 *      the app graph loaded twice);
 *   4. the stable launcher must resolve to the payload's app entry — never back
 *      to `dist/bin.js`, which would re-exec forever;
 *   5. on Windows, the deepest installed file must fit in MAX_PATH from the REAL
 *      default app dir, with the runner's real username.
 *
 * Deliberately not a `bun:test` file: it needs a packaged tarball and two real
 * `npm install`s, and it must be runnable by hand on a Windows box where nobody
 * wants the whole suite.
 *
 *   bun scripts/managed-install-smoke.ts [--keep]
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "..")
const keep = process.argv.includes("--keep")
const failures: Array<string> = []

function step(name: string): void {
  process.stdout.write(`\n=== ${name}\n`)
}

function fail(message: string): void {
  failures.push(message)
  process.stderr.write(`  FAIL ${message}\n`)
}

function ok(message: string): void {
  process.stdout.write(`  ok   ${message}\n`)
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(cmd: string, args: Array<string>, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  }
}

function mustRun(cmd: string, args: Array<string>, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): RunResult {
  const result = run(cmd, args, opts)
  if (result.code !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${result.code}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

interface Manifest {
  name: string
  version: string
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Manifest
}

/** Version string from `package.json`, for the tarball name. */
function packageVersion(): string {
  return manifest().version
}

/** `<scope>-<name>-<version>.tgz`, which is how npm names a packed scoped package. */
function tarballName(): string {
  const pkg = manifest()
  return `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`
}

/** `<prefix>/node_modules/<package>/`, honouring the scope. */
function packageDir(prefix: string): string {
  return path.join(prefix, "node_modules", ...manifest().name.split("/"))
}

/** Deepest relative path in `dir`, so the MAX_PATH budget can be measured not guessed. */
function deepestRelative(dir: string): { rel: string; length: number } {
  let worst = { rel: "", length: 0 }
  const walk = (current: string, prefix: string): void => {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel)
        continue
      }
      const full = path.join(current, entry.name)
      const length = full.length
      if (length > worst.length) worst = { rel, length }
    }
  }
  walk(dir, "")
  return worst
}

/** `os.tmpdir()` replacement that honours the runner's scratch dir. */
function systemTmp(): string {
  return process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp"
}

const version = packageVersion()
const work = fs.mkdtempSync(path.join(systemTmp(), "gh-router-managed-smoke-"))
/** Tarballs this run created in the repo root, removed on the way out. */
const produced: Array<string> = []
const npmCache = path.join(work, "npm-cache")
// The npx cache is `<cache>/_npx/<hash>/`, and `classifyEntry` keys on exactly
// that shape. Laying the consumer install out here is what makes the bootstrap
// take the adopt path — the whole feature is invisible otherwise.
const npxRoot = path.join(npmCache, "_npx", "smokehash")
// ALWAYS the scratch dir, never an inherited `GH_ROUTER_APP_DIR`: this script
// runs a real installer and deletes its own tmpdir afterwards, so pointing it at
// a real app dir would both mutate and then partially reap a user's install.
const appDir = path.join(work, "app")

function cleanup(): void {
  if (keep) {
    process.stdout.write(`\nkept ${work}\n`)
    return
  }
  fs.rmSync(work, { recursive: true, force: true })
  for (const file of produced) fs.rmSync(file, { force: true })
}

/**
 * Which version to install into the managed tree.
 *
 * The local version when the registry already has it (the normal case on
 * `master`, where the release workflow publishes the bumped version), otherwise
 * the latest published one. The reason to prefer the local version is that the
 * payload then matches the tarball this script just packed — including the
 * dependency diet, which is what makes the MAX_PATH projection meaningful. The
 * reason to fall back is a version-bump PR, where the manifest is ahead of the
 * registry: failing CI there would be reporting the release process, not this
 * feature.
 */
function pickTargetVersion(local: string): string {
  const exact = run("npm", ["view", `github-router@${local}`, "version", "--silent"])
  if (exact.code === 0 && exact.stdout.trim() === local) return local
  const latest = run("npm", ["view", "github-router", "version", "--silent"])
  const published = latest.stdout.trim()
  if (latest.code === 0 && published) {
    process.stdout.write(
      `  note: ${local} is not on the registry yet; installing published ${published}\n`,
    )
    return published
  }
  // Nothing on the registry at all (offline): allow the caller to pin a version.
  const pinned = process.env.GH_ROUTER_SMOKE_VERSION?.trim()
  if (pinned) return pinned
  throw new Error(`cannot resolve a managed target version (local ${local} unpublished, registry unreachable)`)
}

async function main(): Promise<void> {
  process.stdout.write(`managed-install smoke (v${version}, ${process.platform})\n`)

  step("pack the tarball")
  // `prepack` runs the build; make that explicit so a stale dist is not used.
  mustRun("bun", ["run", "build"])
  const packed = run("npm", ["pack", "--silent"], { cwd: repoRoot })
  if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)
  const tarball = path.join(repoRoot, tarballName())
  if (!fs.existsSync(tarball)) throw new Error(`expected ${tarball} from npm pack`)
  produced.push(tarball)
  ok(`packed ${path.basename(tarball)}`)

  step("consumer install into an npx-shaped tree")
  // `npm_config_allow_scripts=""` because the ambient env of a developer machine
  // (and some CI images) sets a policy that makes `npm install` exit 1 with
  // EALLOWSCRIPTS. Empty string is how npm is told "no policy".
  //
  // `GH_ROUTER_APP_DIR` goes into EVERY child, not just the update: the first
  // `--version` from the npx-shaped tree legitimately takes the "schedule a
  // background install" path, and without the override it writes
  // `install-state.json` into the developer's REAL app dir — where its detached
  // child then races this script's cleanup, which deletes the npm cache out from
  // under it and records `EEXIST`/`ENOENT` failures against the real machine.
  // (Observed exactly that, once.) Everything a run touches stays under `work`.
  const smokeEnv = {
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    npm_config_allow_scripts: "",
    GH_ROUTER_APP_DIR: appDir,
  }
  mustRun("npm", ["install", tarball, "--prefix", npxRoot, "--no-audit", "--no-fund"], { env: smokeEnv })
  const entry = path.join(packageDir(npxRoot), "dist", "bin.js")
  if (!fs.existsSync(entry)) throw new Error(`consumer install did not produce ${entry}`)
  ok(`installed consumer tree at ${path.relative(work, npxRoot)}`)

  step("the bootstrap passes through when the managed layer is off")
  // The promise for every tree that owns itself. The disable flag is what makes
  // this step deterministic rather than a race: a first `--version` from an
  // npx-shaped tree legitimately SCHEDULES a background install, and that child
  // holds the install lock — so the explicit `update` below would (correctly)
  // report "another github-router process is installing" instead of installing.
  // Measured as a flaky failure before this was pinned down.
  const first = mustRun(process.execPath, [entry, "--version"], {
    env: { ...smokeEnv, GH_ROUTER_NO_MANAGED_INSTALL: "1" },
  })
  if (first.stdout.trim() !== version) fail(`--version printed ${JSON.stringify(first.stdout.trim())}, expected ${version}`)
  else ok(`--version → ${version}`)
  if (fs.existsSync(path.join(appDir, "m"))) fail("the disabled bootstrap still created a managed tree")
  else ok("nothing was scheduled into the app dir")

  step("update --self --no-optional installs the managed payload")
  // A hostile `npm_config_allow_scripts` is the documented EALLOWSCRIPTS killer
  // for a project-scoped install (`--ignore-scripts` does NOT neutralize it;
  // only an emptied variable does — docs/pi-launch.md). Setting it here makes
  // the managed install prove `buildNpmEnv` on the OS it is running on.
  const targetVersion = pickTargetVersion(version)
  process.stdout.write(`  target version: ${targetVersion}\n`)
  const update = run(process.execPath, [entry, "update", "--self", "--no-optional", "--version", targetVersion], {
    env: {
      ...smokeEnv,
      npm_config_allow_scripts: "is-number",
    },
  })
  if (update.code !== 0) {
    fail(`update exited ${update.code}: ${update.stderr.slice(-800)}`)
    return
  }
  const pointerFile = path.join(appDir, "m", "self", "current.json")
  if (!fs.existsSync(pointerFile)) {
    fail(`no pointer at ${pointerFile}; update said: ${update.stdout.slice(-500)}${update.stderr.slice(-500)}`)
    return
  }
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8")) as {
    version: string
    entry: string
    schemaVersion: number
  }
  if (pointer.version !== targetVersion) {
    fail(`pointer names ${pointer.version}, expected ${targetVersion}`)
  }
  else ok(`pointer → ${pointer.version}`)
  if (pointer.entry.endsWith("bin.js")) {
    fail(`pointer entry is the bootstrap (${pointer.entry}); that is an exec loop`)
  } else ok(`pointer entry is ${pointer.entry}`)

  const versionDir = path.join(appDir, "m", "self", pointer.version)
  const payloadEntry = path.join(versionDir, pointer.entry)
  if (!fs.existsSync(payloadEntry)) {
    fail(`payload entry is missing: ${payloadEntry}`)
    return
  }
  ok(`payload present (${Math.round(dirSize(versionDir) / 1e6)} MB)`)

  step("the npx tree now hands off to the managed payload")
  // `src/bin.ts` re-execs with a fresh module graph, so a double evaluation would
  // print two banners — the count is the assertion. (`GH_ROUTER_MANAGED_HANDOFF`
  // rides along in the child's env as a support marker; nothing reads it, so it
  // is deliberately not the thing under test.)
  const second = mustRun(process.execPath, [entry, "--version"], { env: smokeEnv })
  const lines = second.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) {
    fail(`hand-off printed ${lines.length} lines (expected exactly one banner):\n${second.stdout}`)
  } else {
    ok(`hand-off printed exactly one line: ${lines[0]}`)
  }
  if (lines[0] !== targetVersion) {
    fail(`hand-off printed ${JSON.stringify(lines[0])}, expected ${targetVersion}`)
  }

  step("the stable launcher resolves to the app entry")
  const launcher = path.join(appDir, "m", "self", "launcher.mjs")
  if (!fs.existsSync(launcher)) {
    fail(`no launcher at ${launcher}`)
  } else {
    const dry = mustRun(process.execPath, [launcher], {
      env: { ...smokeEnv, GH_ROUTER_MANAGED_TEST: "1", GH_ROUTER_MANAGED_DRY_RUN: "1" },
    })
    const resolved = JSON.parse(dry.stdout.trim()) as { version: string; entryPath: string }
    if (resolved.version !== pointer.version) fail(`launcher resolved ${resolved.version}, pointer says ${pointer.version}`)
    else if (resolved.entryPath.endsWith("bin.js")) fail(`launcher resolves the bootstrap: ${resolved.entryPath}`)
    // realpath: on macOS the temp dir is a symlink (`/var` → `/private/var`), and
    // the launcher reports the path it actually stats.
    else if (realpath(resolved.entryPath) !== realpath(payloadEntry)) {
      fail(`launcher resolved ${resolved.entryPath}, expected ${payloadEntry}`)
    } else ok(`launcher → ${path.relative(appDir, resolved.entryPath)}`)
  }

  step("PATH shims")
  const shimDir = path.join(appDir, "cli-bin")
  const shimName = process.platform === "win32" ? "github-router.cmd" : "github-router"
  const shim = path.join(shimDir, shimName)
  if (!fs.existsSync(shim)) fail(`no shim at ${shim}`)
  else {
    // The shim execs whatever runtime is on PATH; put the one that built this
    // first so the test is not measuring an unrelated stale node.
    //
    // A `.cmd` cannot be spawned directly on Windows (`spawnSync` rejects it with
    // EINVAL — cmd.exe is what interprets the batch file), which is exactly the
    // rule `buildExecInvocation` encodes for the CLI itself. Going through
    // cmd.exe here is therefore not a test shortcut; it is the real invocation.
    const shimEnv = {
      ...smokeEnv,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    }
    const shimmed =
      process.platform === "win32"
        ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", shim, "--version"], { env: shimEnv })
        : run(shim, ["--version"], { env: shimEnv })
    const shimLines = shimmed.stdout.trim().split(/\r?\n/).filter(Boolean)
    if (shimmed.code !== 0) fail(`shim exited ${shimmed.code}: ${shimmed.stderr.slice(-400)}`)
    else if (shimLines.length !== 1) fail(`shim printed ${shimLines.length} lines:\n${shimmed.stdout}`)
    else ok(`shim → ${shimLines[0]}`)
  }

  step("MAX_PATH budget (Windows)")
  if (process.platform !== "win32") {
    process.stdout.write("  skip: not Windows\n")
  } else {
    // The REAL default app dir, so the runner's real username length is in play.
    const home = process.env.USERPROFILE ?? ""
    const realAppDir = path.join(home, ".local", "share", "github-router")
    const worst = deepestRelative(versionDir)
    // `worst.rel` is relative to the version dir, and the version dir keeps the
    // same shape in both places — so the projection is exact, not an estimate.
    const realVersionDir = path.join(realAppDir, "m", "self", pointer.version)
    const projected = path.join(realVersionDir, ...worst.rel.split("/")).length
    process.stdout.write(`  deepest payload file: ${worst.rel} (${worst.rel.length} chars)\n`)
    process.stdout.write(`  projected absolute length from ${realAppDir}: ${projected}\n`)
    if (projected >= 260) {
      fail(`projected ${projected} chars exceeds MAX_PATH (260) from ${realAppDir}`)
    } else {
      ok(`${projected} < 260 (${260 - projected} chars of headroom)`)
    }
  }

  step("GC keeps the live version")
  const gcRun = run(process.execPath, [entry, "update", "--self", "--check", "--no-optional"], {
    env: smokeEnv,
  })
  if (gcRun.code !== 0) fail(`update --check exited ${gcRun.code}`)
  else if (!fs.existsSync(payloadEntry)) fail("update --check removed the live payload")
  else ok("live payload survived --check")
}

/** Real path when it exists, else the input — for symlinked temp dirs. */
function realpath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** Directory size in bytes, for the log line (not an assertion). */
function dirSize(dir: string): number {
  let total = 0
  const walk = (current: string): void => {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          // raced with cleanup; irrelevant for a log line
        }
      }
    }
  }
  walk(dir)
  return total
}

let exitCode = 0
try {
  await main()
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  cleanup()
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failure(s):\n`)
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  exitCode = 1
} else {
  process.stdout.write("\nmanaged-install smoke: OK\n")
}
process.exit(exitCode)
