/**
 * "Which Pi do we launch, and how do we spell it?"
 *
 * Pi is not a dependency of this package: the launcher spawns whatever `pi` the
 * user has. That is fine until you look at what happens today when the answer
 * changes underneath a session — `npm install -g` while the launcher is running
 * mutates a tree the spawned Pi has open, and on Windows that is `EPERM`. The
 * managed install gives Pi a versioned, rename-published home instead, so a Pi
 * refresh becomes the same safe operation as a router refresh.
 *
 * Precedence (plan §6), in order:
 *
 * 1. `--pi-path <abs>` — explicit user override, never floor-checked. Someone
 *    pointing at a local build is testing, not asking for our opinion.
 * 2. `pi` on PATH, provided it is **not our own shim** and meets
 *    `PI_MIN_VERSION`. The shim check is not cosmetic: our `pi` shim execs the
 *    managed launcher, so adopting it as "the user's Pi" would make the
 *    launcher's own spawn resolve to itself.
 * 3. The managed pointer, when it meets the floor.
 * 4. Install into the managed dir and use that.
 *
 * Rule 2's floor is what lets the managed install take over from a user install
 * that is too old, which previously could only be fixed by rewriting the user's
 * global npm tree (`npm install -g` from `updatePi`). Falling through is
 * reported, never silent: a user whose `pi` was silently ignored would file a
 * bug about "the wrong version".
 */

import fs from "node:fs/promises"
import path from "node:path"

import { resolveExecutable, runCommandCapture } from "../exec"
import { PI_MIN_VERSION, meetsPiMinVersion, resolvePiRegistry } from "../pi-version-check"
import { ensureManagedInstall } from "./install"
import { isOurShim } from "./shim"
import { type ManagedKind, versionDir } from "./paths"
import { readPointer } from "./pointer"

/** Timeout for `pi --version`. Generous: a cold V8 start on Windows is slow. */
const VERSION_TIMEOUT_MS = 5000

export type PiCommandSource = "flag" | "path" | "managed" | "installed"

export interface PiCommand {
  /**
   * argv prefix. `command` is the executable, `args` its fixed leading
   * arguments — a managed Pi is `node <payload>/dist/bundle/cli.js`, so the
   * caller can no longer assume "one token".
   */
  command: string
  args: Array<string>
  source: PiCommandSource
  /** Version this command is known/believed to be, when known. */
  version: string | null
  /**
   * Something the user should hear once (below-floor fallback, managed install
   * that failed and left us using an older one). Undefined when nothing is
   * surprising.
   */
  note?: string
}

export interface ResolvePiOpts {
  /** `--pi-path`: absolute path to a `pi` binary/script. */
  piPath?: string
  /** Allow installing into the managed dir (false for `--no-update-check`). */
  allowInstall?: boolean
  /** Probe the managed pointer only; never install. Used by `--no-auto-update`. */
  noInstall?: boolean
  signal?: AbortSignal
}

/** Run `<exe> --version` and pull the semver out. Null on any failure. */
export async function probePiVersion(command: string, args: Array<string> = []): Promise<string | null> {
  try {
    const { stdout, code } = await runCommandCapture([command, ...args, "--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
    })
    if (code !== 0) return null
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1]! : null
  } catch {
    return null
  }
}

/**
 * The package's own `bin` target for `pi`, relative to the package root.
 *
 * Read from the installed `package.json` rather than hardcoded because Pi has
 * already moved it once (`dist/cli.js` → `dist/bundle/cli.js`), and a hardcoded
 * path turns a Pi refactor into "the launcher cannot start Pi at all".
 */
export async function piBinEntry(packageRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8")
    const parsed = JSON.parse(raw) as { bin?: unknown }
    if (typeof parsed.bin === "string") return parsed.bin
    if (parsed.bin && typeof parsed.bin === "object") {
      const binMap = parsed.bin as Record<string, unknown>
      const value = binMap["pi"]
      if (typeof value === "string") return value
    }
  } catch {
    // Not installed, or not a package. Caller falls through.
  }
  return null
}

/**
 * The managed Pi's argv prefix, if a complete and in-floor payload is live.
 *
 * `process.execPath` is not necessarily Node — under `bunx` it is Bun, and Pi's
 * bundle is built for Node. So prefer a real `node` on PATH and only fall back
 * to the running interpreter, which at least guarantees *an* interpreter exists.
 */
export async function managedPiCommand(): Promise<PiCommand | null> {
  // `verifyEntry: false` on purpose. The default verification stats
  // `ENTRY_RELATIVE.pi`, a hardcoded path — but the entry is resolved below from
  // the package's own `bin` map precisely so a Pi reorganisation (a renamed or
  // moved bin) keeps working. Verifying the hardcoded guess first would reject
  // the pointer at the one moment `piBinEntry` exists to save us, and the
  // launcher would reinstall and then fail closed. Verify the RESOLVED path.
  const pointer = await readPointer("pi", { verifyEntry: false })
  if (!pointer) return null
  if (!meetsPiMinVersion(pointer.version)) return null

  const root = versionDir("pi", pointer.version)
  const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent")
  const relative = await piBinEntry(packageDir)
  if (!relative) return null
  const entry = path.join(packageDir, relative)
  try {
    const stat = await fs.stat(entry)
    if (!stat.isFile()) return null
  } catch {
    return null
  }
  const runner = resolveExecutable("node") ?? process.execPath
  return { command: runner, args: [entry], source: "managed", version: pointer.version }
}

/** Is this resolved `pi` a PATH user install rather than our own shim? */
async function isUserPi(candidate: string): Promise<boolean> {
  try {
    return !(await isOurShim(candidate))
  } catch {
    // If the marker check itself fails, assume ours: adopting it would recurse.
    return false
  }
}

/**
 * Resolve the Pi invocation to spawn.
 *
 * Never throws: every failure degrades to a later rule, and the final answer is
 * always a runnable-or-explainable command. The caller decides whether "nothing
 * resolved" is fatal.
 */
export async function resolvePiCommand(opts: ResolvePiOpts = {}): Promise<PiCommand | null> {
  const explicit = opts.piPath?.trim()
  if (explicit) {
    return { command: explicit, args: [], source: "flag", version: await probePiVersion(explicit) }
  }

  const onPath = resolveExecutable("pi")
  let belowFloor: string | null = null
  if (onPath && (await isUserPi(onPath))) {
    const version = await probePiVersion(onPath)
    if (version && meetsPiMinVersion(version)) {
      return { command: onPath, args: [], source: "path", version }
    }
    if (version) belowFloor = version
  }

  const managed = await managedPiCommand()
  if (managed) {
    return belowFloor
      ? {
          ...managed,
          note: `Using the managed Pi ${managed.version}: the \`pi\` on PATH is v${belowFloor}, below the supported floor v${PI_MIN_VERSION}. Upgrade that one (or drop it from PATH, or pass --pi-path) to choose it again.`,
        }
      : managed
  }

  if (opts.noInstall || opts.allowInstall === false) return null

  const kind: ManagedKind = "pi"
  const latest = await latestPiVersion()
  if (!latest) {
    // No version ⇒ no install. `ensureManagedInstall` requires an EXACT version
    // (a range would let `npm view` and the tarball disagree, and the pointer
    // would then flap forever), so "latest" is resolved here or not at all.
    return {
      command: "",
      args: [],
      source: "installed",
      version: null,
      note: "Pi is not installed and its latest version could not be resolved (offline, or npm is not on PATH).",
    }
  }
  const outcome = await ensureManagedInstall({
    kind,
    version: latest,
    registry: resolvePiRegistry(),
    signal: opts.signal,
  })
  const installed = await managedPiCommand()
  if (installed) {
    return belowFloor
      ? {
          ...installed,
          note: `Using the managed Pi ${installed.version}: the \`pi\` on PATH is v${belowFloor}, below the supported floor v${PI_MIN_VERSION}. Upgrade that one (or drop it from PATH, or pass --pi-path) to choose it again.`,
        }
      : { ...installed, source: "installed" }
  }
  return {
    command: "",
    args: [],
    source: "installed",
    version: null,
    note:
      outcome.kind === "installed" || outcome.kind === "adopted"
        ? `Pi ${outcome.version ?? ""} was installed but no runnable entry was found.`
        : (outcome.detail ?? "Pi is not installed and could not be installed automatically."),
  }
}

/**
 * `npm view … version` for Pi, pinned to the Pi registry.
 *
 * Returns null rather than the string `"latest"` on failure: the installer
 * demands an exact version, so passing a tag through would fail one layer later
 * with "invalid version latest" — a confusing error for "you are offline".
 */
async function latestPiVersion(): Promise<string | null> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return null
  try {
    const { stdout, code } = await runCommandCapture(
      [
        npmPath,
        "view",
        "@earendil-works/pi-coding-agent",
        "version",
        "--silent",
        `--registry=${resolvePiRegistry()}`,
      ],
      { timeoutMs: 8000 },
    )
    if (code !== 0) return null
    const value = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ""
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : null
  } catch {
    return null
  }
}
