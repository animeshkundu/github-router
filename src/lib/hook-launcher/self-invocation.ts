/**
 * How this process names ITSELF in a command string that gets persisted to
 * disk and executed later by someone else.
 *
 * Every Claude Code hook, the MCP `headersHelper`, and the worker-guard are
 * registered as shell commands inside a settings.json that outlives the
 * process that wrote it. They were built from `(process.execPath,
 * process.argv[1])`, which under `bunx` points into `$TMPDIR` — a directory
 * macOS reaps and `bunx pkg@latest` re-extracts in place. A persisted command
 * pointing there stops working mid-session (see
 * `src/lib/hook-launcher/provision.ts` for the failure in full).
 *
 * So the pair is resolved ONCE per launch, through the stable relocated
 * launcher when one can be published, and every builder composes its command
 * from that single answer.
 */

import { readFileSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { PACKAGE_ROOT_FLAG } from "../package-root"
import { PATHS } from "../paths"
import { provisionHookLauncher } from "./provision"

/** The binary + script + package root a persisted command should name. */
export interface SelfInvocation {
  /** The node/bun binary to exec. */
  execPath: string
  /** Script to pass to it, omitted for a packaged single-file build. */
  scriptPath?: string
  /**
   * The github-router package root, baked in only when `scriptPath` is the
   * relocated launcher. From `<APP_DIR>/hooks/` nothing can derive it: the
   * pre-existing walk in `browser-mcp/native-host-installer.ts` falls back to
   * `process.cwd()`, which would silently resolve to the USER'S WORKSPACE.
   */
  packageRoot?: string
}

function quote(s: string): string {
  return `"${s}"`
}

/**
 * Compose a persisted command string: the binary, the script when it differs
 * from the binary, the baked package root when there is one, then the args.
 *
 * Every builder in the codebase routes through here so the three parts cannot
 * drift apart — and so a future part is added in one place, not eleven.
 */
export function buildSelfCommand(inv: SelfInvocation, args: string): string {
  const parts = [quote(inv.execPath)]
  if (inv.scriptPath && inv.scriptPath !== inv.execPath) {
    parts.push(quote(inv.scriptPath))
  }
  if (inv.packageRoot) {
    parts.push(PACKAGE_ROOT_FLAG, quote(inv.packageRoot))
  }
  if (args) parts.push(args)
  return parts.join(" ")
}

/** The invocation describing the currently running entrypoint, unrelocated. */
export function currentInvocation(): SelfInvocation {
  return { execPath: process.execPath, scriptPath: process.argv[1] }
}

let _resolved: SelfInvocation | undefined

/** @internal — reset module state between test cases. */
export function __resetSelfInvocationForTests(): void {
  _resolved = undefined
}

/**
 * Resolve the invocation to bake into every persisted command this launch
 * writes. Awaited BEFORE the settings are written, never fire-and-forget: a
 * command persisted while provisioning is still pending would name the very
 * temp path this exists to avoid, and the session would stay broken however
 * well provisioning later went.
 *
 * Falls back to the running entrypoint if the launcher cannot be published, so
 * a provisioning failure degrades rather than breaking a launch. The caller is
 * responsible for surfacing that fallback — see `hookLauncherDegradedWarning`.
 */
export async function resolveSelfInvocation(): Promise<SelfInvocation> {
  if (_resolved) return _resolved
  const launcher = await provisionHookLauncher()
  _resolved =
    launcher ?
      {
        execPath: process.execPath,
        scriptPath: launcher,
        packageRoot: currentPackageRoot(),
      }
    : currentInvocation()
  return _resolved
}

/**
 * A human-facing warning when this launch is about to persist hook commands
 * pointing into a directory the OS may reap — the exact configuration that
 * produced the original bug.
 *
 * Returns the message rather than logging it, mirroring
 * `colbertDegradedWarning`: `claude` and `codex` call `enableFileLogging()`,
 * which redirects `consola.warn` to the error log, so a warning logged here
 * would be invisible on the one path where it matters most. The caller writes
 * it to stderr next to the readiness line instead.
 *
 * Silent when running from source, which has no bundle to publish and is not a
 * degraded state.
 */
export function hookLauncherDegradedWarning(
  inv: SelfInvocation,
): string | null {
  if (!inv.scriptPath) return null
  // Our own published launcher is checked FIRST, and is authoritative: we know
  // we published it, so it can never warrant the "could not publish" message
  // below even if APP_DIR itself sits somewhere unusual.
  if (inv.scriptPath.startsWith(PATHS.HOOK_LAUNCHER_DIR)) {
    if (inv.packageRoot) return null
    // Relocated but rootless. Today this only degrades `--version` inside the
    // launcher, because nothing in the hook graph consumes the package root for
    // anything else. It is reported anyway because it is a trap rather than a
    // bug: the day a hook subcommand pulls in code_search or the browser
    // installer, `packageRoot()` falls through to `process.cwd()` and starts
    // resolving against the user's REPO with no signal at all.
    return (
      "Hook launcher published without a package root; hook version reporting "
      + "will be degraded. This usually means the install tree is partially "
      + "missing — reinstall github-router."
    )
  }
  if (isUnderVolatileRoot(inv.scriptPath)) {
    return (
      "Hook commands point into a temporary directory and will stop working "
      + "when the OS reaps it (the stable launcher could not be published). "
      + "Reinstall with `npm install -g github-router` to avoid this."
    )
  }
  return null
}

/**
 * The package root of the RUNNING code, derived while we are still inside the
 * package tree — the one moment it is knowable without guessing.
 *
 * The name is checked, not just the presence of a package.json: this value is
 * baked into a persisted command and consumed by `packageRoot()` as the
 * highest-priority source, so handing it the WRONG root would be worse than
 * handing it none. Matches `findPackageRoot()` in
 * `browser-mcp/native-host-installer.ts`, whose fallbacks this supersedes.
 */
function currentPackageRoot(): string | undefined {
  const entry = typeof process.argv[1] === "string" ? process.argv[1] : undefined
  if (!entry) return undefined
  let cur = path.dirname(entry)
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(cur, "package.json"), "utf8"),
      ) as { name?: unknown }
      if (typeof pkg.name === "string" && pkg.name.includes("github-router")) {
        return cur
      }
    } catch {
      // Not here, or unreadable; walk up.
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Whether a path sits under a directory the OS is entitled to clean out from
 * under a running session: the per-user temp dir on every platform, which is
 * where `bunx` (unlike `npx`, which uses a cache under $HOME) installs.
 *
 * Both sides are compared in resolved AND unresolved form. macOS reports
 * `$TMPDIR` as `/var/folders/…` while a process sees `/private/var/folders/…`,
 * so a single-form prefix test silently never matches; and `realpathSync`
 * fails on a path that does not exist, which would otherwise make the answer
 * depend on whether the file happens to be there.
 */
export function isUnderVolatileRoot(target: string): boolean {
  try {
    const prefixes = new Set<string>()
    for (const root of [os.tmpdir(), realpathIfPossible(os.tmpdir())]) {
      prefixes.add(root.endsWith(path.sep) ? root : root + path.sep)
    }
    const targets = [target, realpathIfPossible(target)]
    return targets.some((t) => [...prefixes].some((p) => t.startsWith(p)))
  } catch {
    return false
  }
}

function realpathIfPossible(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
