/**
 * Workspace confinement + sensitive-file denylist for worker tools.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Tools" section).
 *
 * `confineToWorkspace(rawPath, workspaceAbs)` is the single chokepoint
 * every path-touching worker tool routes through (`read`, `glob`,
 * `grep`, `code_search`, `edit`, `write`). It rejects:
 *
 *   - explicit `..` segments after normalization (`a/../b` is allowed
 *     because it resolves to `a/b`; a path that escapes the workspace
 *     via `..` is rejected by the prefix check);
 *   - on Windows: UNC paths (`\\server\share`), device paths
 *     (`\\?\C:\…`, `\\.\…`), and drive-relative paths (`C:foo`);
 *   - any path whose realpath-resolved form falls outside
 *     `workspaceAbs` — trailing-separator-aware so `C:\work` does not
 *     accidentally accept `C:\workspace2`.
 *
 * Symlink/junction handling uses `fs.realpathSync.native()` (rather
 * than the JS-emulated `realpathSync`) to match the platform's own
 * resolution for case-folding on macOS, reparse points on Windows,
 * etc. — same rule cc-backup's filesystem layer uses.
 *
 * `SENSITIVE_FILE_DENYLIST` covers credential-shaped filenames the
 * worker should never read even when they live inside the confined
 * workspace. `isSensitivePath` returns true when any pattern matches
 * any segment of the path relative to the workspace; callers (the
 * `read`/`glob`/`grep`/`code_search` tools) translate that into a
 * factual "denied: secret-file pattern" tool result that Pi sees and
 * decides on.
 */

import { realpathSync } from "node:fs"
import * as path from "node:path"

const IS_WINDOWS = process.platform === "win32"

/**
 * Sensitive-file regex patterns evaluated against each path segment
 * (the path relative to the workspace root, split on `/` and `\`).
 *
 * The patterns are deliberately narrow — they target the shapes of
 * common credential / private-key files, not entire categories. They
 * are NOT a sandbox; they are a "stop fat-fingering through .env"
 * guardrail. Layered with workspace confinement they suffice for the
 * threat model documented in the plan.
 */
export const SENSITIVE_FILE_DENYLIST: ReadonlyArray<RegExp> = [
  // `.env`, `.env.local`, `.env.production`, etc. (dotfile env files).
  /^\.env(\..+)?$/i,
  // PEM-encoded keys / certs.
  /^.+\.pem$/i,
  // OpenSSH private keys (and their `.pub` counterparts; treat both as sensitive).
  /^id_rsa(\..+)?$/i,
  /^id_ed25519(\..+)?$/i,
  // npm + curl/wget auth tokens.
  /^\.npmrc$/i,
  /^\.netrc$/i,
]

/**
 * Directory segments treated as sensitive: if any path component
 * matches one of these names, the path is sensitive. Covers `.git/`
 * interior (config, hooks, packed refs), SSH key material, and
 * GPG/PGP keyrings.
 */
const SENSITIVE_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".gnupg",
])

/**
 * Internal helper: split a path into segments using both POSIX and
 * Windows separators (`/` and `\`). We don't use `path.sep` because a
 * path can mix separators on Windows (`C:\work/foo\bar`).
 */
function splitSegments(p: string): Array<string> {
  return p.split(/[\\/]+/).filter((s) => s.length > 0)
}

/**
 * Check whether `absPath` (already absolute and inside `workspaceAbs`)
 * matches any pattern on the sensitive-file denylist.
 *
 * Returns `true` if the path itself is sensitive, OR if any of its
 * intermediate segments names a sensitive directory (e.g. `.git/`,
 * `.ssh/`). Sensitive-segment matching catches both nested files
 * (`.git/config`, `.ssh/known_hosts`) and the directory listing itself
 * (preventing `glob(".git/**")` from leaking refs).
 *
 * The check is performed against the path RELATIVE to the workspace
 * to avoid false positives on workspace-name shapes like `~/keys.pem`
 * being a containing directory (only relevant on weird user setups,
 * but free correctness).
 */
export function isSensitivePath(absPath: string, workspaceAbs: string): boolean {
  const rel = path.relative(workspaceAbs, absPath)
  if (rel === "") {
    // The workspace root itself is never sensitive.
    return false
  }
  const segments = splitSegments(rel)
  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) return true
    for (const pat of SENSITIVE_FILE_DENYLIST) {
      if (pat.test(seg)) return true
    }
  }
  return false
}

/**
 * Pre-realpath syntactic rejection of Windows paths the worker must
 * not accept under any circumstance.
 *
 * - UNC paths (`\\server\share\…`) traverse remote filesystems; we
 *   only confine the local workspace.
 * - Device / namespace paths (`\\?\C:\…`, `\\.\PhysicalDrive0`) bypass
 *   the normal Win32 path-parser including length/character limits;
 *   we'd lose the safety guarantees of the rest of this check.
 * - Drive-relative paths (`C:foo` — note: no separator after the
 *   drive) resolve against the per-drive current directory, which the
 *   worker has no control over.
 */
function rejectWindowsHostilePath(raw: string): string | null {
  // UNC + device/namespace: leading `\\` or `//`.
  if (/^[\\/]{2}/.test(raw)) {
    return "rejected: UNC or device path"
  }
  // Drive-relative: `C:foo` but NOT `C:\foo`, `C:/foo`, or bare `C:`.
  // Bare `C:` is treated as drive-current-dir too, so reject it.
  if (/^[A-Za-z]:(?![\\/])/.test(raw)) {
    return "rejected: drive-relative path"
  }
  return null
}

export interface ConfineOk {
  ok: true
  abs: string
}
export interface ConfineErr {
  ok: false
  error: string
}
export type ConfineResult = ConfineOk | ConfineErr

/**
 * Resolve `rawPath` against `workspaceAbs` and verify the result lives
 * within the workspace.
 *
 * `workspaceAbs` MUST already be absolute and pre-realpath-resolved by
 * the caller (the engine does this once at worker start). We don't
 * realpath it again per-call.
 *
 * Behavior:
 *   1. Syntactic Windows rejection (UNC / device / drive-relative).
 *   2. Reject explicit `..` segments on the RAW input — `..` after
 *      normalization is fine (`a/../b` → `a/b`), but a user explicitly
 *      writing `..` is almost always trying to escape.
 *   3. If `rawPath` is absolute, use as-is; otherwise join against
 *      `workspaceAbs`.
 *   4. realpath-canonicalize with `realpathSync.native()` so symlinks
 *      and junctions point at their true target. If the path does not
 *      yet exist (e.g. `write` creating a new file), realpath the
 *      *parent* and re-join with the basename — same trick cc-backup
 *      uses for write-creates inside a confined workspace.
 *   5. Trailing-separator-aware prefix check against `workspaceAbs`:
 *      append `path.sep` to both sides before `startsWith` so
 *      `C:\work` does not match `C:\workspace2`. Allow equality too
 *      (the workspace root is a valid path).
 *
 * Returns either `{ok: true, abs}` with the canonical absolute path
 * (suitable for `fs.readFile`, `fs.writeFile`, etc.) or `{ok: false,
 * error}` with a terse human-readable reason.
 *
 * Note: errors are intentionally short — they are returned to the
 * model verbatim (as tool-result text) and don't echo the input path
 * to keep the audit log + log lines compact.
 */
export function confineToWorkspace(
  rawPath: string,
  workspaceAbs: string,
): string {
  const result = confineToWorkspaceResult(rawPath, workspaceAbs)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.abs
}

/**
 * Result-returning variant. Most call sites want the throw form (it
 * composes cleanly into AgentTool.execute which returns errors via
 * `{isError, content}`); tests + tools that want to surface a specific
 * error message to Pi without raising can use this form.
 */
export function confineToWorkspaceResult(
  rawPath: string,
  workspaceAbs: string,
): ConfineResult {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, error: "rejected: empty path" }
  }

  if (IS_WINDOWS) {
    const winErr = rejectWindowsHostilePath(rawPath)
    if (winErr) return { ok: false, error: winErr }
  }

  // Reject explicit `..` segments in the RAW input. This catches the
  // common escape attempts; `a/../b` (no leading `..`) normalizes
  // safely and is allowed because the realpath check will catch any
  // actual escape.
  const rawSegments = splitSegments(rawPath)
  if (rawSegments.includes("..")) {
    return { ok: false, error: "rejected: parent-directory segment" }
  }

  // Build the absolute candidate path.
  const candidate = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.normalize(path.join(workspaceAbs, rawPath))

  // realpath canonicalization. If the path doesn't exist yet (e.g.
  // write-creating a new file), fall back to realpath-ing the parent
  // and joining the basename — same pattern as cc-backup. If even the
  // parent doesn't exist, leave the candidate as-is (the eventual fs
  // call will fail with the right ENOENT; we don't pre-empt).
  let canonical: string
  try {
    canonical = realpathSync.native(candidate)
  } catch {
    const parent = path.dirname(candidate)
    const base = path.basename(candidate)
    try {
      const realParent = realpathSync.native(parent)
      canonical = path.join(realParent, base)
    } catch {
      canonical = candidate
    }
  }

  // Trailing-separator-aware prefix check. Without this, `C:\work` is
  // a prefix of `C:\workspace2` and the confinement leaks.
  const wsWithSep = workspaceAbs.endsWith(path.sep)
    ? workspaceAbs
    : workspaceAbs + path.sep
  const isInside =
    canonical === workspaceAbs || canonical.startsWith(wsWithSep)
  if (!isInside) {
    return { ok: false, error: "rejected: outside workspace" }
  }

  return { ok: true, abs: canonical }
}
