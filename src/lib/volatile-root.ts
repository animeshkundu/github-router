/**
 * "Could the OS delete this path while we are not looking?"
 *
 * One predicate, two consumers with the same question and different stakes:
 *
 * - `hook-launcher/self-invocation.ts` asks it about a PERSISTED hook command, so
 *   the answer drives a user-facing warning;
 * - `managed-install/origin.ts` asks it about the running code, so the answer
 *   drives "is this tree disposable enough to replace with the managed install".
 *
 * It lives alone here because `origin.ts` is imported by the bootstrap bundle
 * (`dist/bin.js`), which must not pull `consola`, `PATHS`, or the hook-launcher
 * provisioning graph just to compare two path prefixes. Hence: `node:` builtins
 * only, no logging, no app state.
 *
 * Why it cannot be a bare prefix test: `os.tmpdir()` reports `/var/folders/…` on
 * macOS while a process sees `/private/var/folders/…`, so a single-form compare
 * silently never matches. Both sides are therefore compared in resolved AND
 * unresolved form, and `realpath` failure (a path that does not exist, which is
 * the normal case for a hook command that has not run yet) must not change the
 * answer.
 */

import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function realpathIfPossible(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/**
 * Whether `target` sits under a directory the OS is entitled to clean out from
 * under a running session: the per-user temp dir on every platform, which is
 * where `bunx` (unlike `npx`, which uses a cache under `$HOME`) installs.
 */
export function isUnderVolatileRoot(target: string): boolean {
  try {
    const prefixes = new Set<string>()
    for (const root of [os.tmpdir(), realpathIfPossible(os.tmpdir())]) {
      prefixes.add(root.endsWith(path.sep) ? root : root + path.sep)
    }
    const targets = [target, realpathIfPossible(target)]
    return targets.some((candidate) => [...prefixes].some((prefix) => candidate.startsWith(prefix)))
  } catch {
    return false
  }
}
