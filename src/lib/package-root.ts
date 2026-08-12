/**
 * The github-router package root, resolvable even when the running entrypoint
 * lives outside the package tree.
 *
 * Why this exists: the Claude Code hooks are launched from a stable, relocated
 * bundle under `<APP_DIR>/hooks/` (see `src/lib/hook-launcher/provision.ts`)
 * so a reaped or re-extracted `bunx` temp tree can't kill them mid-session.
 * That relocation breaks every "walk up from where I am" package-root lookup:
 * from `<APP_DIR>/hooks/` neither `process.argv[1]` nor `import.meta.url` has
 * a `package.json` above it, and the pre-existing fallback in
 * `browser-mcp/native-host-installer.ts` was `process.cwd()` — the user's
 * WORKSPACE. Silently resolving the package root to the user's repo is worse
 * than failing, so the launcher is told the answer instead of deriving it.
 *
 * The value is baked into the launcher's command string as a literal
 * `--package-root` ARG rather than passed via the environment, matching the
 * precedent set by `buildSessionBindHookCommand`: the spawned child's env is
 * filtered, so an env var can be stripped out from under us while an argv
 * entry always survives.
 */

/** The literal flag baked into the stable hook launcher's command string. */
export const PACKAGE_ROOT_FLAG = "--package-root"

let _explicitPackageRoot: string | undefined

/**
 * Record the package root supplied on the command line. Ignores an empty or
 * non-string value so a malformed argv falls back to derivation rather than
 * pinning the root to `""`.
 */
export function setExplicitPackageRoot(root: string | undefined): void {
  _explicitPackageRoot =
    typeof root === "string" && root.length > 0 ? root : undefined
}

/** The explicitly supplied package root, or undefined when none was given. */
export function explicitPackageRoot(): string | undefined {
  return _explicitPackageRoot
}

/** @internal — reset module state between test cases. */
export function __resetExplicitPackageRootForTests(): void {
  _explicitPackageRoot = undefined
}

/**
 * Strip `--package-root <path>` / `--package-root=<path>` out of a raw argv,
 * recording the value, and return the remaining args.
 *
 * The flag is consumed BEFORE citty sees the argv because it is a launcher-wide
 * concern, not a per-subcommand one: adding it to all nine subcommands' `args`
 * definitions would be nine places to forget it in the tenth.
 */
export function takePackageRootArg(argv: readonly string[]): Array<string> {
  const rest: Array<string> = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === PACKAGE_ROOT_FLAG) {
      // The value is the next token. A trailing bare flag records nothing and
      // is simply dropped — `setExplicitPackageRoot(undefined)` is a no-op.
      setExplicitPackageRoot(argv[i + 1])
      i++
      continue
    }
    if (arg?.startsWith(`${PACKAGE_ROOT_FLAG}=`)) {
      setExplicitPackageRoot(arg.slice(PACKAGE_ROOT_FLAG.length + 1))
      continue
    }
    if (typeof arg === "string") rest.push(arg)
  }
  return rest
}
