/**
 * Non-git `.gitignore` → `.ignore` mirror.
 *
 * colgrep honors a repo's `.gitignore` ONLY inside an actual git
 * repository (empirically verified: a `.gitignore` in a non-git directory
 * is NOT applied, so `dist/` / `node_modules/` / build output would be
 * indexed). It DOES honor a ripgrep-style `.ignore` file unconditionally,
 * git or not. So for a NON-git workspace we mirror `.gitignore` into
 * `.ignore`, preserving the same language-agnostic "only source + config"
 * indexing that git repos get for free from their own `.gitignore`.
 *
 * Git repos are deliberately left untouched — they already filter
 * correctly via `.gitignore`, so no file is written into them.
 *
 * The mirror is best-effort, idempotent, and additive-safe:
 *   - written only when a `.gitignore` exists,
 *   - a pre-existing USER-authored `.ignore` is NEVER overwritten (we only
 *     ever (re)write a file WE created, identified by the exact
 *     {@link MIRROR_HEADER} prefix),
 *   - a symlink / directory / special file at `.ignore` is left untouched
 *     (never written through — a clobber-redirect guard),
 *   - written via a temp file + atomic rename so a crash mid-write can
 *     never leave a truncated `.ignore` (which colgrep would read as a
 *     partial ignore list and index un-ignored dirs),
 *   - re-written only when the mirrored `.gitignore` content changed.
 *
 * Opt out with `GH_ROUTER_COLBERT_NO_IGNORE_MIRROR=1`.
 *
 * NOTE: only the workspace-root `.gitignore` is mirrored; nested per-dir
 * `.gitignore` files in a non-git tree are not (a documented limitation —
 * build-output ignores overwhelmingly live at the repo root).
 */

import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { parseBoolEnv } from "../exec"

/** First line of a mirror WE generated (human-facing tag). */
export const MIRROR_MARKER = "# github-router: colgrep .gitignore mirror"

/**
 * Exact constant prefix every mirror we write begins with. Ownership is
 * tested against the FULL header (not just the first line) so a user file
 * that merely starts with the tag line is never misclassified as ours.
 */
const MIRROR_HEADER =
  `${MIRROR_MARKER}\n` +
  "# DO NOT EDIT — auto-generated and regenerated when .gitignore changes;\n" +
  "# local edits here are overwritten. This directory is not a git repo and\n" +
  "# colgrep only reads .gitignore inside a git repo, so this mirror keeps\n" +
  "# semantic-search indexing limited to source + config. Safe to delete.\n" +
  "# Disable via GH_ROUTER_COLBERT_NO_IGNORE_MIRROR=1.\n\n"

/** True when the operator opted out via `GH_ROUTER_COLBERT_NO_IGNORE_MIRROR=1`. */
export function ignoreMirrorOptedOut(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_COLBERT_NO_IGNORE_MIRROR) === true
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * Ensure a NON-git `workspace` has an `.ignore` mirroring its
 * `.gitignore`. No-op when opted out, when there is no `.gitignore`, or
 * when a user-authored (or symlinked / non-regular) `.ignore` already
 * exists. Never throws.
 *
 * The caller (`runInit`) invokes this ONLY for non-git workspaces — a git
 * repo already applies `.gitignore` natively and gets no file written.
 * `runInit` is single-flight per workspace, so no two mirror writes race
 * on the same path.
 */
export async function ensureIgnoreMirror(workspace: string): Promise<void> {
  if (ignoreMirrorOptedOut()) return
  try {
    let gitignore: string
    try {
      gitignore = await readFile(path.join(workspace, ".gitignore"), "utf8")
    } catch (err) {
      // Only a genuinely-absent .gitignore is a clean skip; surface other
      // errors (EACCES / EISDIR / transient I/O) at debug rather than
      // silently pretending there was nothing to mirror.
      if (!isMissing(err)) {
        consola.debug("colbert: ignore-mirror .gitignore read failed:", err)
      }
      return
    }

    const ignorePath = path.join(workspace, ".ignore")
    const desired = MIRROR_HEADER + gitignore

    // Inspect an existing .ignore WITHOUT following a symlink. Never write
    // through or replace a symlink / directory / special file — that could
    // redirect the write outside the workspace (clobber primitive). Only a
    // plain regular file we recognize as our own mirror is refreshed.
    let existingStat: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      existingStat = await lstat(ignorePath)
    } catch {
      existingStat = undefined
    }
    if (existingStat) {
      if (!existingStat.isFile()) return // symlink / dir / special → leave it
      const existing = await readFile(ignorePath, "utf8").catch(() => undefined)
      if (existing === undefined) return
      if (!existing.startsWith(MIRROR_HEADER)) return // user-owned → leave it
      if (existing === desired) return // already current → no write
    }

    // Atomic write: temp (per-pid, ours to clobber) + rename. A crash or
    // kill leaves only the temp, never a half-written .ignore.
    const tmp = `${ignorePath}.gh-router-${process.pid}.tmp`
    await writeFile(tmp, desired, "utf8")
    try {
      await rename(tmp, ignorePath)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    consola.debug(
      `colbert: mirrored .gitignore -> .ignore for non-git workspace ${workspace}`,
    )
  } catch (err) {
    consola.debug("colbert: ignore-mirror skipped:", err)
  }
}
