import fs from "node:fs/promises"
import path from "node:path"

/**
 * Precedence guards for the per-launch Pi mirror.
 *
 * Pi's discovery is first-match and largely silent (`loadContextFileFromDir`
 * returns on the first candidate in `AGENTS.override.md`, `AGENTS.md`,
 * `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`), so a file the user owns and a file
 * this launcher owns can each make the other unreachable without any error:
 *
 * - `AGENTS.override.md` in the agent dir beats `AGENTS.md` there, so the
 *   bridged memory block never reaches the prompt.
 * - The reverse also happens: a user `CLAUDE.md` in the mirror is silently
 *   OUTRANKED by the `AGENTS.md` we write, so the user's own global
 *   instructions disappear from the prompt. Measured against Pi's
 *   `loadProjectContextFiles`: with only `CLAUDE.md` present Pi loads it; the
 *   moment the bridge writes `AGENTS.md` beside it, the user's file is gone.
 *   That direction is the more dangerous one, because nothing about the launch
 *   looks wrong.
 * - A trusted `<cwd>/.pi/APPEND_SYSTEM.md` beats the agent-dir one, so the
 *   gh-router mode digest loses to the project's file.
 * - `<agentDir>/SYSTEM.md` REPLACES Pi's default system prompt. Our digest is
 *   still appended, but the base prompt the digest was written against is gone.
 *
 * None of these are errors and none should be "repaired" (deleting or renaming
 * a user's file is worse than the shadow). They are reported once per launch,
 * from data this module collects, so the reporting itself is unit-testable.
 */

export interface MirrorPrecedence {
  /** `<mirror>/AGENTS.override.md` exists and is a file. */
  agentsOverride: boolean
  /** `<mirror>/SYSTEM.md` exists and is a file. */
  systemMd: boolean
  /** `<cwd>/.pi/APPEND_SYSTEM.md` exists and is a file. */
  projectAppendSystem: string | null
  /**
   * A user `CLAUDE.md` sits in the mirror, where the `AGENTS.md` this launcher
   * writes will outrank it. Pi reads exactly one context file per directory, so
   * the user's global instructions stop being loaded.
   */
  userClaudeMd: string | null
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** Collect the precedence hazards for this launch. Never throws. */
export async function inspectMirrorPrecedence(
  mirrorDir: string,
  projectCwd: string,
): Promise<MirrorPrecedence> {
  const projectAppend = path.join(projectCwd, ".pi", "APPEND_SYSTEM.md")
  // `CLAUDE.md` only matters when Pi would otherwise have loaded it: the mirror
  // is seeded from `~/.pi/agent`, so its presence means the user keeps their
  // global instructions there rather than in `AGENTS.md`.
  const userClaudeMd = path.join(mirrorDir, "CLAUDE.md")
  return {
    agentsOverride: await isFile(path.join(mirrorDir, "AGENTS.override.md")),
    systemMd: await isFile(path.join(mirrorDir, "SYSTEM.md")),
    projectAppendSystem: (await isFile(projectAppend)) ? projectAppend : null,
    userClaudeMd: (await isFile(userClaudeMd)) ? userClaudeMd : null,
  }
}

export interface SkillWritePlan<T> {
  /** Skills that do not exist yet and should be written. */
  write: Array<T>
  /** Same-named skills the user already has; the user's copy wins. */
  shadowed: Array<{ dir: string; file: string; skill: T }>
}

/**
 * The launch warnings a bridge block provokes, as data rather than as calls.
 *
 * Both messages describe the SAME Pi rule in opposite directions: one context
 * file per directory, first candidate wins. They are only true when a block was
 * actually written (`bridgeActive`), because otherwise `AGENTS.md` either does
 * not exist (so `CLAUDE.md` still loads) or was never touched by us. Returning
 * strings keeps the gating unit-testable; the launcher only logs them.
 */
export function bridgeShadowWarnings(
  precedence: MirrorPrecedence,
  opts: {
    bridgeActive: boolean
    mirrorDir: string
    /**
     * The user already kept their own text in `AGENTS.md`. Defaults to `false`
     * ("`AGENTS.md` is ours only"). When true, `CLAUDE.md` was ALREADY unreachable
     * before this launch — Pi has read `AGENTS.md` in preference to it all along —
     * so blaming the bridge would send the user to fix the wrong thing.
     */
    userOwnsAgentsMd?: boolean
  },
): Array<string> {
  if (!opts.bridgeActive) return []
  const warnings: Array<string> = []
  if (precedence.agentsOverride) {
    const file = path.join(opts.mirrorDir, "AGENTS.override.md")
    warnings.push(
      `Pi memory bridge: ${file} shadows the mirror AGENTS.md, so the bridged Copilot/Claude rules are NOT loaded this launch. Remove that file (or pass --no-memory-bridge to silence this) and Pi will read the bridged block.`,
    )
  }
  if (precedence.userClaudeMd && !opts.userOwnsAgentsMd) {
    warnings.push(
      `Pi memory bridge: your ${precedence.userClaudeMd} is NOT loaded any more. Pi reads exactly one context file per agent dir and the bridged block lives in AGENTS.md, which outranks it. Copy your text into AGENTS.md — this launcher keeps it above the bridged block — or pass --no-memory-bridge to read CLAUDE.md again.`,
    )
  }
  return warnings
}

/**
 * Split the router's skills into "write" and "already the user's".
 *
 * The mirror is seeded from `~/.pi/agent` before this runs, so a user-level
 * `skills/gh-oracle/SKILL.md` is already on disk. Overwriting it would silently
 * destroy the user's copy, so the user's file wins and the caller reports the
 * collision instead.
 */
export async function planSkillWrites<T extends { dir: string }>(
  mirrorDir: string,
  skills: ReadonlyArray<T>,
): Promise<SkillWritePlan<T>> {
  const write: Array<T> = []
  const shadowed: Array<{ dir: string; file: string; skill: T }> = []
  for (const skill of skills) {
    const file = path.join(mirrorDir, "skills", skill.dir, "SKILL.md")
    if (await isFile(file)) shadowed.push({ dir: skill.dir, file, skill })
    else write.push(skill)
  }
  return { write, shadowed }
}
