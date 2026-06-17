/**
 * Writer for injected skills: materializes a `SKILL.md` into the per-launch
 * `CLAUDE_CONFIG_DIR` mirror so the spawned Claude Code session discovers it as a
 * user-scope skill (`<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`, where the folder
 * name MUST equal the frontmatter `name` — the loader enforces this).
 *
 * Safety mirrors `claude-md-injection.ts`:
 *   - mirror-only write guard (symlink-resolving) so we never touch the user's
 *     real `~/.claude/skills/`;
 *   - ATOMIC temp+rename so a concurrent child process can never read a
 *     half-written `SKILL.md` (Claude Code watches the skills dir);
 *   - warn-and-continue on every failure — an injected skill is an enhancement,
 *     never a launch blocker.
 *
 * No per-skill stale sweep is needed: the whole per-launch mirror dir is GC'd by
 * `removeOwnClaudeConfigMirror` / `sweepStaleClaudeConfigMirrors`.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { isUnderClaudeConfigMirrorRealpath, renameWithRetry } from "../claude-md-injection"
import { PATHS } from "../paths"

/** Grep-able prefix on every warn path (mirrors the CLAUDE_MD_WRITE convention). */
const ERROR_CODE = "INJECTED_SKILL_WRITE"

/**
 * Strict skill-name allowlist. Lowercase kebab so the folder name is a safe path
 * segment AND a valid Claude Code skill `name` (loader asserts folder == name).
 * All our injected skills (`gh-research`, `gh-orchestrate`, `gh-floor-keeper`)
 * pass.
 */
const VALID_SKILL_NAME = /^[a-z][a-z0-9-]*$/

export interface WriteInjectedSkillResult {
  written: boolean
  /** Absolute path of the written `SKILL.md` on success. */
  path?: string
}

/**
 * Write `md` to `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`. `md` must already be
 * a complete `SKILL.md` (YAML frontmatter with `name: <name>` + `description`,
 * then the body). Idempotent across launches (overwrite); the per-launch mirror
 * dir is disposable.
 */
export async function writeInjectedSkill(
  name: string,
  md: string,
): Promise<WriteInjectedSkillResult> {
  if (!VALID_SKILL_NAME.test(name)) {
    consola.warn(`${ERROR_CODE}: invalid skill name "${name}" (need lowercase kebab); skipping`)
    return { written: false }
  }

  const dir = path.join(PATHS.CLAUDE_CONFIG_DIR, "skills", name)
  const target = path.join(dir, "SKILL.md")

  // The mirror-only guard resolves the target's PARENT via realpath, so the
  // parent must exist first. Creating the dir before the guard is safe: mkdir
  // inside the mirror is the same privilege as the write we are about to do, and
  // the guard still rejects if the resolved parent escapes the mirror root.
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err) {
    consola.warn(
      `${ERROR_CODE}: mkdir failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { written: false }
  }

  if (!(await isUnderClaudeConfigMirrorRealpath(target))) {
    consola.warn(
      `${ERROR_CODE}: refusing to write outside the resolved mirror dir (target=${target}, mirror=${PATHS.CLAUDE_CONFIG_DIR})`,
    )
    return { written: false }
  }

  // Atomic temp + rename (wx so we never clobber a racer's temp). No copyFile
  // fallback (would follow a symlink/hardlink and escape the mirror boundary).
  const tempPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, md, { encoding: "utf8", flag: "wx" })
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    consola.warn(
      `${ERROR_CODE}: temp-file write failed for ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { written: false }
  }

  const ok = await renameWithRetry(tempPath, target, md)
  if (!ok) return { written: false }

  consola.debug(`${ERROR_CODE}: wrote ${target} (${md.length} bytes)`)
  return { written: true, path: target }
}
