import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { isUnderClaudeConfigMirror, PATHS } from "./paths"

/**
 * Marker fence around the peer-MCP awareness block in the mirrored
 * `<CLAUDE_CONFIG_DIR>/CLAUDE.md`. The literal text is intentionally
 * specific enough that a content collision with user prose is
 * implausible. Used by `findMarkerBlocks` to locate prior injections
 * for idempotent re-write across launches.
 *
 * Writer-side guard: `appendPeerAwarenessToMirroredClaudeMd` refuses
 * to write a snippet that itself contains either marker literal — that
 * would create ambiguous state on the next launch (the inner literal
 * would parse as a new open or close marker).
 */
const MARKER_OPEN =
  "<!-- gh-router peer-mcp awareness — auto-injected, regenerated per launch -->"
const MARKER_CLOSE = "<!-- /gh-router peer-mcp awareness -->"

/**
 * Skip the helper if the user's `~/.claude/CLAUDE.md` (or, equivalently,
 * the would-be post-write file) has grown past this size.
 * Read-modify-write becomes pathological at very large sizes; CLAUDE.md
 * should never legitimately be a database. The main agent still gets
 * the awareness via `--append-system-prompt`, so skipping here only
 * loses descendant-reach.
 */
const MAX_CLAUDE_MD_BYTES = 1 * 1024 * 1024 // 1 MiB

/**
 * Bounded retry budget for the temp → rename step on Windows where
 * `fs.rename` can transiently fail with EBUSY / EPERM / EACCES when
 * CLAUDE.md is open in an editor, scanned by AV, or indexed by the
 * search service. Mirrors the verify-on-rename-fail pattern at
 * `paths.ts:795-818`. POSIX renames almost never fail this way; the
 * cost on Linux/macOS is one extra `lstat` in the unhappy path.
 */
const RENAME_RETRY_DELAYS_MS = [50, 200, 500] as const

/**
 * Grep-able error-code prefix. Every warn-and-continue path here
 * starts its message with this token so a Windows user who never sees
 * a fresh marker block in their mirror can `grep CLAUDE_MD_WRITE` in
 * the launcher output and land on the actionable line directly.
 */
const ERROR_CODE = "CLAUDE_MD_WRITE"

interface MarkerBlock {
  openLineIndex: number
  closeLineIndex: number
}

/**
 * Find every well-formed marker block in `lines`. A well-formed block
 * is an exact `MARKER_OPEN` line followed somewhere later (any number
 * of intervening lines) by an exact `MARKER_CLOSE` line, with no
 * intervening `MARKER_OPEN`. Multiple stale blocks all surface here so
 * the caller can remove all of them.
 *
 * Malformed state (open without close, or close without open) is
 * reported separately via the second return value so the caller can
 * `warn` and leave user prose untouched. We never try to "fix"
 * malformed marker state — that risks corrupting user content.
 */
export function findMarkerBlocks(lines: ReadonlyArray<string>): {
  blocks: Array<MarkerBlock>
  malformed: boolean
} {
  const blocks: Array<MarkerBlock> = []
  let pendingOpen: number | null = null
  let malformed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === MARKER_OPEN) {
      if (pendingOpen !== null) {
        // Two opens with no close between them — malformed.
        malformed = true
      }
      pendingOpen = i
    } else if (line === MARKER_CLOSE) {
      if (pendingOpen === null) {
        // Close with no preceding open — malformed.
        malformed = true
      } else {
        blocks.push({ openLineIndex: pendingOpen, closeLineIndex: i })
        pendingOpen = null
      }
    }
  }
  if (pendingOpen !== null) {
    // Open with no close — malformed.
    malformed = true
  }
  return { blocks, malformed }
}

/**
 * Detect line-ending style of `content`. Returns `"\r\n"` if `\r\n`
 * sequences outnumber bare `\n`; otherwise `"\n"`. Empty content
 * defaults to `\n` (POSIX-style new file).
 *
 * Preserves CRLF on Windows users' existing CLAUDE.md — flipping their
 * line endings under them would be a regression even though Claude
 * Code itself reads either style.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  if (content.length === 0) return "\n"
  // Count CRLF occurrences. Bare `\n` count is `\n total - CRLF count`.
  const crlf = (content.match(/\r\n/g) ?? []).length
  const totalLf = (content.match(/\n/g) ?? []).length
  const bareLf = totalLf - crlf
  return crlf > bareLf ? "\r\n" : "\n"
}

/**
 * Strip a leading UTF-8 BOM (`U+FEFF`) if present so the first line's
 * marker comparison is byte-exact. CLAUDE.md authored on Windows in
 * Notepad / VS Code sometimes carries a BOM; without this strip the
 * first marker line would never match (`<BOM><!--...` !== `<!--...`)
 * and successive launches would loop into malformed-state warn paths.
 */
function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/**
 * Split `content` into lines without losing the line-ending style.
 * The split is done on `\n`; trailing `\r` (from CRLF) is stripped
 * from each line for marker comparison, but the original ending is
 * reconstructed via `detectLineEnding` + `joinLines`.
 */
function splitLines(content: string): Array<string> {
  if (content.length === 0) return []
  const lines = content.split("\n").map((l) =>
    l.endsWith("\r") ? l.slice(0, -1) : l,
  )
  // If the file ends in `\n`, the trailing element is `""` — keep it
  // so we can detect "trailing newline present" when rebuilding.
  return lines
}

function joinLines(lines: ReadonlyArray<string>, eol: "\r\n" | "\n"): string {
  return lines.join(eol)
}

/**
 * Containment check that defeats symlink/junction tricks (peer-review
 * C3). `isUnderClaudeConfigMirror` is purely lexical via
 * `path.resolve()` — it does NOT dereference symlinks, so an attacker
 * (or an unfortunate `~/.claude` symlinked into Dropbox) could escape
 * the mirror while passing the lexical guard. This helper resolves
 * BOTH paths to their canonical form via `fs.realpath()` first.
 *
 * **Fail-closed semantics (advisor follow-up):**
 *
 *   - If the mirror root itself is a symlink (`lstat` reports
 *     `isSymbolicLink() === true`), refuse. A symlinked mirror root
 *     means writes flow through the link to whatever the user (or an
 *     attacker) targeted — the boundary's whole point is to never
 *     mutate real `~/.claude/`, so accepting any symlinked root
 *     undermines it.
 *   - If `realpath` fails on the mirror root, refuse. The mirror dir
 *     is provisioned by `ensureClaudeConfigMirror` before this helper
 *     runs (documented ordering invariant); a `realpath` failure here
 *     signals an unexpected state.
 *   - If `realpath` fails on the target's parent (e.g. first-time
 *     creation), fall back to the lexical check we already passed at
 *     entry — the target's parent IS the mirror root for the
 *     `CLAUDE.md`-creation case, and the mirror-root realpath above
 *     has already confirmed the root.
 */
async function isUnderClaudeConfigMirrorRealpath(
  target: string,
): Promise<boolean> {
  // Fast lexical reject first: if even the lexical check fails the
  // path is clearly wrong and we never need to touch the filesystem.
  if (!isUnderClaudeConfigMirror(target)) return false

  const mirrorRoot = PATHS.CLAUDE_CONFIG_DIR

  // Reject a symlinked mirror root. realpath would happily follow it
  // and the resolved target would still appear "under" the resolved
  // root — masking the escape.
  try {
    const rootLink = await fs.lstat(mirrorRoot)
    if (rootLink.isSymbolicLink()) {
      consola.warn(
        `${ERROR_CODE}: mirror root is a symlink (${mirrorRoot}); refusing to write through it`,
      )
      return false
    }
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: cannot lstat mirror root ${mirrorRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  // Canonicalize the mirror root. Failure here is fail-closed — the
  // mirror should exist by the time this helper runs.
  let resolvedRoot: string
  try {
    resolvedRoot = await fs.realpath(mirrorRoot)
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: realpath failed on mirror root ${mirrorRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  // Canonicalize the target's parent. ENOENT here is fail-closed: the
  // mirror root has already been lstat'd and realpath'd successfully
  // above, so a missing parent at this point means the root vanished
  // between checks — exactly the race-window an attacker would use to
  // swap the mirror with a symlink/junction. Refuse rather than grant
  // access (peer-review codex-critic C1).
  const targetParent = path.dirname(target)
  let resolvedTargetParent: string
  try {
    resolvedTargetParent = await fs.realpath(targetParent)
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: realpath failed on target parent ${targetParent} after root check (TOCTOU?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  if (resolvedTargetParent === resolvedRoot) return true
  return resolvedTargetParent.startsWith(resolvedRoot + path.sep)
}

/**
 * Try `fs.rename(temp, target)` with bounded retry + verify-on-fail.
 * Mirrors `injectSyntheticClaudeJsonFields` in `paths.ts`. Windows
 * `fs.rename` can transiently fail with EBUSY / EPERM / EACCES when
 * the destination is held by another process (editor, AV, search
 * indexer). Returns `true` on eventual success, `false` after all
 * retries are exhausted (caller will warn-and-continue).
 *
 * On final failure we read the destination back and check whether it
 * already matches `desiredContent` — a concurrent racer may have
 * landed the same bytes (the snippet is deterministic per launch).
 * In that case treat as success.
 *
 * **No `copyFile` fallback** (peer-review codex-critic C2). `fs.copyFile`
 * follows the destination path — if `target` was replaced with a
 * symlink/junction between our earlier `lstat` and now (TOCTOU), or
 * if `target` is a hardlink to the real `~/.claude/CLAUDE.md`,
 * `copyFile` would mutate user files through the link. The boundary
 * we are defending says "never mutate the real `~/.claude/`". Rename
 * is safe because replacing a path entry doesn't follow the link; the
 * `copyFile` degradation reintroduces the escape. Fail-closed instead.
 */
async function renameWithRetry(
  tempPath: string,
  target: string,
  desiredContent: string,
): Promise<boolean> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.rename(tempPath, target)
      return true
    } catch (err) {
      lastErr = err
      // Don't sleep after the final attempt.
      if (attempt < RENAME_RETRY_DELAYS_MS.length) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
        )
      }
    }
  }

  // All retries exhausted. Verify-on-fail: did a racer land the same
  // bytes we wanted? (Matches the paths.ts:795-818 pattern.)
  try {
    const observed = await fs.readFile(target, "utf8")
    if (observed === desiredContent) {
      await fs.unlink(tempPath).catch(() => {})
      consola.debug(
        `${ERROR_CODE}: rename failed but target already holds expected content (racer-won-race): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
      )
      return true
    }
  } catch {
    // Fall through to final cleanup + caller-side warn.
  }

  // Fail-closed: no copyFile fallback (would follow symlinks/hardlinks
  // and bypass the never-mutate-user-files boundary). Better to lose
  // descendant-reach for this launch than to risk overwriting the
  // user's real CLAUDE.md.
  await fs.unlink(tempPath).catch(() => {})
  consola.warn(
    `${ERROR_CODE}: rename failed for ${target} after ${RENAME_RETRY_DELAYS_MS.length + 1} attempts (no copyFile fallback — would risk symlink/hardlink escape; descendant-reach via CLAUDE.md disabled this launch; main agent still has --append-system-prompt). rename err: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  )
  return false
}

/**
 * Append the peer-MCP awareness `snippet` to the mirrored
 * `<CLAUDE_CONFIG_DIR>/CLAUDE.md`. Idempotent across launches: prior
 * well-formed marker blocks are removed before appending a fresh one
 * at the bottom. The original user content is preserved byte-for-byte
 * at the top (modulo line-ending normalization to the file's detected
 * style; leading UTF-8 BOM is stripped from the parse path).
 *
 * Failures `warn` and return — this surface is the descendant-reach
 * enhancement; the main agent still gets the awareness via
 * `--append-system-prompt`. A throw here would block the launch for
 * an enhancement-only failure. Every warn message starts with
 * `CLAUDE_MD_WRITE` so users can grep launcher output.
 *
 * Hard invariants:
 *   1. Mirror-only: refuse to write outside the per-launch mirror dir,
 *      with symlink/junction-resolving check via `fs.realpath` (not
 *      just lexical `path.resolve`).
 *   2. Symlink refusal: if the target itself is a symlink, do not
 *      follow.
 *   3. Size guard: skip if the would-be post-write content exceeds
 *      1 MiB — measured AFTER strip + append so a near-cap fixture
 *      with a stale block does not get permanently stranded.
 *   4. CRLF preservation: write back in the file's detected style.
 *   5. Malformed marker: leave user prose untouched + `warn`.
 *   6. Atomic write: temp + rename, with verify-on-fail / copyFile
 *      fallback for Windows transient EBUSY/EPERM.
 *   7. Writer-side guard: refuse to write a snippet that contains
 *      either marker literal — would create ambiguous state.
 */
export async function appendPeerAwarenessToMirroredClaudeMd(
  snippet: string,
): Promise<void> {
  // Invariant 7: writer-side guard. Refuse to inject a snippet that
  // contains either marker literal — otherwise the next launch's
  // parser would see the inner literal as a new open/close and
  // either delete user content (the I5 footgun) or trip the
  // malformed-marker path indefinitely. The snippet body should
  // never legitimately contain these strings; failing fast here
  // catches a builder bug at the source.
  if (snippet.includes(MARKER_OPEN) || snippet.includes(MARKER_CLOSE)) {
    consola.warn(
      `${ERROR_CODE}: refusing to inject snippet that contains marker literal; this would corrupt idempotency on the next launch`,
    )
    return
  }

  const target = path.join(PATHS.CLAUDE_CONFIG_DIR, "CLAUDE.md")

  // Invariant 1: mirror-only safety guard (symlink-resolving).
  if (!(await isUnderClaudeConfigMirrorRealpath(target))) {
    consola.warn(
      `${ERROR_CODE}: refusing to write outside resolved mirror dir (target=${target}, mirror=${PATHS.CLAUDE_CONFIG_DIR})`,
    )
    return
  }

  // Invariant 2: refuse to follow symlinks on the leaf. lstat tells
  // us about the link itself; fs.readFile would silently follow.
  let existingContent = ""
  let targetExists = false
  try {
    const linkStat = await fs.lstat(target)
    if (linkStat.isSymbolicLink()) {
      consola.warn(
        `${ERROR_CODE}: refusing to write through symlinked CLAUDE.md (target=${target})`,
      )
      return
    }
    if (!linkStat.isFile()) {
      // Directory or other non-regular entry sitting where CLAUDE.md
      // should be. Refuse rather than try to fix.
      consola.warn(
        `${ERROR_CODE}: refusing to write non-regular target (target=${target}, mode=${linkStat.mode.toString(8)})`,
      )
      return
    }
    // Early size guard (peer-review codex-critic suggestion #9) — skip
    // before paying the readFile cost. The post-build size guard below
    // catches the runaway-snippet case; this catches the runaway-file
    // case. nlink > 1 also caught here: hardlinked CLAUDE.md to the
    // real user file would otherwise be a path-following escape via
    // fs.writeFile, even with the symlink-refusal above.
    if (linkStat.size > MAX_CLAUDE_MD_BYTES) {
      consola.warn(
        `${ERROR_CODE}: skipping oversized CLAUDE.md (${linkStat.size} bytes > ${MAX_CLAUDE_MD_BYTES}); descendant-reach disabled this launch`,
      )
      return
    }
    if (linkStat.nlink > 1) {
      consola.warn(
        `${ERROR_CODE}: refusing to write to hardlinked CLAUDE.md (nlink=${linkStat.nlink}); would mutate shared inode`,
      )
      return
    }
    targetExists = true
    existingContent = await fs.readFile(target, "utf8")
  } catch (err) {
    if (
      typeof err === "object"
      && err !== null
      && "code" in err
      && (err as { code: string }).code === "ENOENT"
    ) {
      // No existing CLAUDE.md — start from empty content.
      existingContent = ""
      targetExists = false
    } else {
      consola.warn(
        `${ERROR_CODE}: failed to stat/read target (${target}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return
    }
  }

  // Invariant 4: detect line-ending style from the existing content
  // AND remember whether the file had a UTF-8 BOM so we can preserve
  // it (peer-review codex-critic I5 — UTF-8-with-BOM is common on
  // Windows, dropping it silently rewrites the file).
  const hadBom = existingContent.charCodeAt(0) === 0xfeff
  const normalizedContent = stripLeadingBom(existingContent)
  const eol = detectLineEnding(normalizedContent)

  // Strip prior well-formed marker blocks (invariant 5: malformed
  // state is warn-and-leave; we do not edit through user prose).
  const lines = splitLines(normalizedContent)
  const { blocks, malformed } = findMarkerBlocks(lines)
  if (malformed) {
    consola.warn(
      `${ERROR_CODE}: malformed marker state in ${target} (open without close or vice versa); leaving file untouched`,
    )
    return
  }
  // Remove blocks in reverse order so earlier indices stay valid.
  const cleanedLines = [...lines]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    cleanedLines.splice(
      block.openLineIndex,
      block.closeLineIndex - block.openLineIndex + 1,
    )
    // Drop trailing blank lines that were inserted as the block's
    // leading separator on previous writes (suggestion #13: loop
    // until non-blank, not exactly one — prevents accumulation if a
    // hand-edit ever introduced multiple blanks).
    while (
      block.openLineIndex - 1 >= 0
      && cleanedLines[block.openLineIndex - 1] === ""
      && cleanedLines.slice(0, block.openLineIndex - 1).some((l) => l !== "")
    ) {
      cleanedLines.splice(block.openLineIndex - 1, 1)
    }
  }

  // Trim trailing blank lines from cleaned content so the marker
  // block sits at the bottom with exactly one blank-line separator
  // between user content and our block (matches the file layout
  // invariant: `<original>\n\n<marker-block>`).
  while (cleanedLines.length > 0
    && cleanedLines[cleanedLines.length - 1] === "") {
    cleanedLines.pop()
  }

  // Build the final content. If user content is non-empty, separate
  // with a blank line. End with a trailing newline so editors / git
  // don't flag "no newline at end of file". Restore the leading UTF-8
  // BOM if the original had one (preserves Windows-authored files).
  const snippetLines = snippet.split("\n").map((l) =>
    l.endsWith("\r") ? l.slice(0, -1) : l,
  )
  const markerBlockLines = [MARKER_OPEN, ...snippetLines, MARKER_CLOSE]
  const finalLines: Array<string> =
    cleanedLines.length === 0
      ? [...markerBlockLines, ""]
      : [...cleanedLines, "", ...markerBlockLines, ""]
  const bodyContent = joinLines(finalLines, eol)
  const finalContent = hadBom ? "﻿" + bodyContent : bodyContent

  // Invariant 3: size guard, measured on the post-build content so a
  // user fixture sitting just below the cap with a stale block can
  // still be cleaned up — prevents the I6 "permanent stale-snippet
  // lockout" where the raw-size check fires before the strip and the
  // mirror is never re-rewritten.
  if (Buffer.byteLength(finalContent, "utf8") > MAX_CLAUDE_MD_BYTES) {
    consola.warn(
      `${ERROR_CODE}: post-build content exceeds ${MAX_CLAUDE_MD_BYTES} bytes; skipping update (descendant-reach disabled this launch)`,
    )
    return
  }

  // Invariant 6: atomic temp + rename, with bounded retry + verify-
  // on-fail / copyFile fallback for Windows transient EBUSY/EPERM.
  const tempPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, finalContent, {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    consola.warn(
      `${ERROR_CODE}: temp-file write failed for ${tempPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return
  }
  const ok = await renameWithRetry(tempPath, target, finalContent)
  if (!ok) return

  consola.debug(
    `${ERROR_CODE}: ${
      targetExists ? "updated" : "created"
    } ${target} (${finalContent.length} bytes, eol=${eol === "\r\n" ? "CRLF" : "LF"})`,
  )
}

/**
 * Test-only exports — internal helpers exposed so unit tests can
 * exercise marker handling and line-ending logic without writing
 * files. NOT part of the public API.
 */
export const __testExports = {
  MARKER_OPEN,
  MARKER_CLOSE,
  MAX_CLAUDE_MD_BYTES,
  ERROR_CODE,
  RENAME_RETRY_DELAYS_MS,
  detectLineEnding,
  stripLeadingBom,
  splitLines,
  joinLines,
  isUnderClaudeConfigMirrorRealpath,
  renameWithRetry,
}
