/**
 * Bridge the INHERITED artifact directories — Claude Code's `.claude/` /
 * `~/.claude/` and Copilot's `.github/` / `~/.copilot/` — into a
 * `github-router pi` launch.
 *
 * Three namespaces, three different failure modes, one rule set:
 *
 *   | namespace       | same-name outcome in Pi                       | reported? |
 *   |-----------------|-----------------------------------------------|-----------|
 *   | agent registry  | `mergeRuntimeAgents` throws, EVERY `subagent`  | yes       |
 *   |                 | call in the process fails until it is removed  |           |
 *   | `skills/*`      | the other `SKILL.md` is overwritten in place   | **no**    |
 *   | `prompts/*.md`  | the other file is overwritten in place         | **no**    |
 *
 * So the planner reserves names BEFORE anything is written, and the rule
 * differs by namespace on purpose:
 *
 *   - **agents**: a name the router itself already ships (its roster, the
 *     pi-subagents builtins, the read-only CLI adapters) means the role
 *     already exists — the foreign definition is **skipped and reported**.
 *     Two agents with one purpose in one catalog is the ambiguity that
 *     produces wrong delegations, and a registry identity is not the only
 *     carrier of the content (the skill and prompt are).
 *   - **skills and prompts**: the file IS the only carrier, so they are
 *     **renamed, never skipped** — `gh-oracle` → `gh-oracle-2`,
 *     `review.md` → `review-2.md`.
 *
 * Renaming happens for anything else that is taken, deterministically:
 * agents become `<slug>-<scope>` (then `-2`, `-3`…), skills and prompts
 * become `<slug>-2` (then `-3`…). No source prefix — a prefix is not a
 * namespace (it walks straight into the builtin `claude-code` /
 * `claude-code-writer`) and it renames artifacts the user recognises for no
 * safety gain, since the reservation is what makes collisions unreachable.
 *
 * Foreign `model:` and `aliases:` are never emitted. The model would be a
 * Copilot slug that `isUnavailableSubagentModel` refuses (so every run of
 * that agent fails), and an alias is another registry identity that can
 * collide invisibly. Every bridged agent therefore runs on the launch's
 * lead model. `tools:` is dropped from the frontmatter and folded into the
 * body as prose, because an unresolvable entry in pi-subagents' strict
 * allowlist hard-fails the child.
 *
 * Nothing here imports pi-subagents or Pi: the router owns one rule and
 * reads the same frontmatter the loaders read, so a version bump upstream
 * cannot silently move a name out from under it.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { capBytes, redactSecrets, splitFrontmatter } from "./pi-memory-bridge"

/**
 * Every name pi-subagents reserves for itself — `BUILTIN_AGENT_NAMES` from
 * the installed package plus the live alias map, the read-only CLI adapters,
 * and the router's own roster.
 *
 * Cannot be imported: pi-subagents is an installed Pi extension, never a
 * router dependency (bundling its internals would couple the launcher to a
 * version it does not pin). LAST_VERIFIED against pi-subagents 0.88.0:
 * `src/agents/builtin-names.js` for the 13 names, and a live `snapshot.all`
 * for the aliases (`oracle → advisor`,
 * `worker → developer, coder, implementer, develop`; every other builtin
 * carries none).
 *
 * Drift here is not a correctness hole: the extension's `tool_result` net
 * unregisters anything the registry rejects at merge time. It is a
 * friendliness hole (a foreign agent skipped needlessly), which is why this
 * list is commented rather than guessed.
 */
export const PI_FOREIGN_ROUTER_OWNED_AGENTS: ReadonlyArray<string> = Object.freeze([
  // pi-subagents builtins (BUILTIN_AGENT_NAMES, 0.88.0).
  "advisor",
  "claude-code",
  "claude-code-writer",
  "codex-exec",
  "codex-exec-writer",
  "cursor-agent",
  "cursor-agent-writer",
  "delegate",
  "evidence-auditor",
  "oracle",
  "researcher",
  "reviewer",
  "scout",
  "worker",
  // Live aliases of those builtins (`oracle`, `worker` above).
  "developer",
  "coder",
  "implementer",
  "develop",
])

/**
 * The router's own agent roster is NOT in the constant above: it depends on
 * the launch (`buildPiAgentFiles` writes Explore / General-Purpose / reviewer /
 * oracle / advisor, and `--no-peers` writes none), so `buildReservedNames`
 * takes it as `emittedAgents` instead. A hardcoded copy here would skip a
 * foreign `Explore` on a peerless launch that publishes no such role.
 */

/** Foreign artifact roots. Project + user, Claude + Copilot. */
const SKILL_ROOTS_PROJECT = [".claude/skills", ".github/skills"] as const
const SKILL_ROOTS_USER = [".claude/skills", ".copilot/skills"] as const
const AGENT_ROOTS_PROJECT = [".claude/agents", ".github/agents"] as const
const AGENT_ROOTS_USER = [".claude/agents", ".copilot/agents"] as const
const PROMPT_ROOTS_PROJECT = [".claude/commands", ".github/prompts"] as const
const PROMPT_ROOTS_USER = [".claude/commands"] as const

/** Pi's own artifact roots in the mirror / repo / home, for reservation. */
const PI_SKILL_ROOTS_REL = ["skills", ".pi/skills", ".agents/skills"] as const
const PI_PROMPT_ROOTS_REL = ["prompts", ".pi/prompts"] as const
const PI_AGENT_ROOTS_REL = ["agents", ".pi/agents", ".agents"] as const

/** Caps. Pi refuses a skill without a description (`core/skills.js:252`). */
const MAX_FOREIGN_AGENT_BODY_BYTES = 8 * 1024
const MAX_FOREIGN_DESCRIPTION_CHARS = 200
const MAX_FOREIGN_SKILL_DESCRIPTION_CHARS = 1_000
const MAX_FOREIGN_INDEX_BYTES = 4 * 1024
/** Mirrors Pi's own limits so a bridged file can never be rejected. */
const MAX_SKILL_NAME_CHARS = 64

export interface PiForeignAgentSpec {
  /** Final, collision-free, slugged (the authored name unless it was taken). */
  name: string
  /** The name as authored in the source file, before any suffix. */
  originalName: string
  /** One line, whitespace-collapsed, ≤ 200 chars. */
  description: string
  /** Frontmatter stripped, provenance line, tool policy as prose, ≤ 8 KiB. */
  body: string
  source: "claude" | "copilot"
  scope: "project" | "user"
  /** Repo- or home-relative provenance, shown in the index. */
  file: string
  /** Set when the name had to change (`gh-oracle` → `gh-oracle-2`). */
  renamedFrom?: string
}

export interface PiForeignArtifactDoc {
  /** Final name: skill directory, or prompt file stem. */
  name: string
  content: string
  renamedFrom?: string
}

export interface PiForeignPlan {
  /** Written to `<mirror>/skills/<name>/SKILL.md`. */
  skills: Array<PiForeignArtifactDoc>
  /** Written to `<mirror>/prompts/<name>.md`. */
  prompts: Array<PiForeignArtifactDoc>
  /**
   * Registered through the pi-subagents runtime-agent event. NO files are
   * written for these: one registry entry, announced in the prompt index,
   * loaded on demand via `subagent({action:"list"})`.
   */
  agents: Array<PiForeignAgentSpec>
  /** Everything dropped rather than bridged, with the reason. Never silent. */
  skipped: Array<{ name: string; file: string; reason: string }>
}

export interface PiReservedNames {
  /** Builtins + aliases + adapters + this launch's roster. Never renamed to. */
  routerOwnedAgents: Set<string>
  /** Every agent identity key on disk (name, aliases, localName). */
  agents: Set<string>
  /** Skill names and directory slugs on disk, plus this launch's own. */
  skills: Set<string>
  /** Prompt stems on disk, plus this launch's own. */
  prompts: Set<string>
}

function lower(s: string): string {
  return s.trim().toLowerCase()
}

/** Collapse to a legal Pi/prompt path segment and registry name. */
export function piForeignSlug(raw: string): string {
  const slug = String(raw ?? "")
    .toLowerCase()
    // Any run of illegal characters is one separator, so `Copilot Deploy!`
    // and `--spaced Name--` both land on a legal, readable segment.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const trimmed = slug.length > MAX_SKILL_NAME_CHARS ? slug.slice(0, MAX_SKILL_NAME_CHARS).replace(/-+$/, "") : slug
  // An all-symbols name slugs to nothing; it still needs a usable identity.
  return trimmed.length > 0 ? trimmed : "foreign"
}

function collapseLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim()
}

function truncateChars(raw: string, max: number): string {
  if (raw.length <= max) return raw
  return `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** YAML-ish frontmatter read: `key: value` on one line, quotes stripped. */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, "im")
  const match = re.exec(frontmatter)
  if (!match) return undefined
  const value = match[1].trim().replace(/^["']/, "").replace(/["']$/, "").trim()
  return value.length > 0 ? value : undefined
}

/** Space- and comma-separated list value (`tools: read, grep, bash`). */
function frontmatterList(frontmatter: string, key: string): Array<string> {
  const raw = frontmatterValue(frontmatter, key)
  if (!raw) return []
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function listDir(dir: string): Promise<Array<string>> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}

/** Repo root: walk up for `.git`, else the given cwd. Never throws. */
export async function piForeignRepoRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 12; depth++) {
    try {
      await fs.stat(path.join(dir, ".git"))
      return dir
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return cwd
}

function sourceOf(file: string): "claude" | "copilot" {
  return file.includes("/.github/") || file.includes("/.copilot/") ? "copilot" : "claude"
}

function provenancePath(file: string, repoRoot: string, homeDir: string): string {
  const rel = (base: string, prefix: string): string | undefined => {
    const out = path.relative(base, file)
    return out.length > 0 && !out.startsWith("..") ? `${prefix}${out.split(path.sep).join("/")}` : undefined
  }
  // `~` for home on purpose: the index and the provenance line are read by a
  // human in a transcript, and an absolute path would leak the account name
  // into every bridged artifact.
  return rel(repoRoot, "") ?? rel(homeDir, "~/") ?? path.basename(file)
}

/* ------------------------------------------------------------------ */
/* Reservation                                                         */
/* ------------------------------------------------------------------ */

/** Every `<dir>/*.md` under an agent root (flat — that is all Pi scans). */
async function agentIdentityKeys(root: string): Promise<Array<string>> {
  const keys: Array<string> = []
  for (const name of await listDir(root)) {
    if (!name.endsWith(".md")) continue
    // `.agent.md` (Copilot) and `*.md` (Claude) both reduce to the stem.
    const stem = name.replace(/\.agent\.md$/, "").replace(/\.md$/, "")
    const raw = await readIfExists(path.join(root, name))
    if (raw === undefined) continue
    const { frontmatter } = splitFrontmatter(raw)
    const authored = frontmatterValue(frontmatter, "name") ?? stem
    keys.push(authored, stem)
    for (const key of ["aliases", "alias", "localName"]) {
      keys.push(...frontmatterList(frontmatter, key))
    }
  }
  return keys
}

async function skillNamesUnder(root: string): Promise<Array<string>> {
  const names: Array<string> = []
  for (const entry of await listDir(root)) {
    if (entry.startsWith(".")) continue
    const dir = path.join(root, entry)
    if (await isDirectory(dir)) {
      // Directory-based skill: Pi names it from frontmatter, else the dir.
      names.push(entry)
      const raw = await readIfExists(path.join(dir, "SKILL.md"))
      if (raw !== undefined) {
        const named = frontmatterValue(splitFrontmatter(raw).frontmatter, "name")
        if (named) names.push(named)
      }
      continue
    }
    if (entry.endsWith(".md")) {
      // Single-file skill: the stem is the name.
      const stem = entry.replace(/\.md$/, "")
      names.push(stem)
      const raw = await readIfExists(path.join(root, entry))
      if (raw !== undefined) {
        const named = frontmatterValue(splitFrontmatter(raw).frontmatter, "name")
        if (named) names.push(named)
      }
    }
  }
  return names
}

async function promptNamesUnder(root: string): Promise<Array<string>> {
  const names: Array<string> = []
  for (const entry of await listDir(root)) {
    const full = path.join(root, entry)
    if (await isDirectory(full)) {
      names.push(...(await promptNamesUnder(full)))
      continue
    }
    if (entry.endsWith(".md")) names.push(entry.replace(/\.md$/, ""))
  }
  return names
}

/**
 * Build the four reservation sets.
 *
 * `emittedSkills` / `emittedPrompts` are the names THIS launch is about to
 * write, so a foreign artifact can never land on top of one the router just
 * created in the same process (the `<mirror>/` scan would see a stale copy
 * from the previous launch, not this one).
 */
export async function buildReservedNames(opts: {
  mirrorDir: string
  repoRoot: string
  homeDir: string
  /**
   * The router roster THIS launch really publishes (agent-file stems from
   * `buildPiAgentFiles`, empty under `--no-peers`). Part of the router-owned
   * set, because the role exists and the roster must win the name. Kept
   * separate from the constant so a peerless launch does not skip a foreign
   * `Explore` for a roster it never wrote.
   */
  emittedAgents?: ReadonlyArray<string>
  emittedSkills?: ReadonlyArray<string>
  emittedPrompts?: ReadonlyArray<string>
}): Promise<PiReservedNames> {
  const routerOwnedAgents = new Set<string>(
    PI_FOREIGN_ROUTER_OWNED_AGENTS.map(lower),
  )
  for (const name of opts.emittedAgents ?? []) routerOwnedAgents.add(lower(name))
  const agents = new Set<string>()
  const skills = new Set<string>()
  const prompts = new Set<string>()

  for (const root of [
    path.join(opts.mirrorDir, PI_AGENT_ROOTS_REL[0]),
    path.join(opts.repoRoot, PI_AGENT_ROOTS_REL[1]),
    path.join(opts.repoRoot, PI_AGENT_ROOTS_REL[2]),
    path.join(opts.homeDir, ".pi/agent/agents"),
    path.join(opts.homeDir, ".agents"),
  ]) {
    for (const key of await agentIdentityKeys(root)) agents.add(lower(key))
  }
  for (const key of routerOwnedAgents) agents.add(key)

  for (const root of [
    path.join(opts.mirrorDir, PI_SKILL_ROOTS_REL[0]),
    path.join(opts.repoRoot, PI_SKILL_ROOTS_REL[1]),
    path.join(opts.repoRoot, PI_SKILL_ROOTS_REL[2]),
    path.join(opts.homeDir, ".pi/agent/skills"),
    path.join(opts.homeDir, ".agents/skills"),
  ]) {
    for (const name of await skillNamesUnder(root)) skills.add(lower(name))
  }
  for (const name of opts.emittedSkills ?? []) skills.add(lower(name))

  for (const root of [
    path.join(opts.mirrorDir, PI_PROMPT_ROOTS_REL[0]),
    path.join(opts.repoRoot, PI_PROMPT_ROOTS_REL[1]),
  ]) {
    for (const name of await promptNamesUnder(root)) prompts.add(lower(name))
  }
  for (const name of opts.emittedPrompts ?? []) prompts.add(lower(name))

  return { routerOwnedAgents, agents, skills, prompts }
}

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic suffix search shared by agents and skills/prompts. */
function claim(
  taken: Set<string>,
  base: string,
  suffixes: () => Iterable<string>,
): string {
  if (!taken.has(lower(base))) {
    taken.add(lower(base))
    return base
  }
  for (const candidate of suffixes()) {
    if (!taken.has(lower(candidate))) {
      taken.add(lower(candidate))
      return candidate
    }
  }
  // Unreachable: the generator is infinite. Keep TypeScript honest.
  return base
}

function* scopeSuffixes(base: string, scope: string): Generator<string> {
  yield `${base}-${scope}`
  for (let n = 2; n < 1_000; n++) yield `${base}-${scope}-${n}`
}

function* ordinals(base: string): Generator<string> {
  for (let n = 2; n < 1_000; n++) yield `${base}-${n}`
}

async function collectAgentFiles(
  roots: ReadonlyArray<{ dir: string; scope: "project" | "user" }>,
): Promise<Array<{ file: string; scope: "project" | "user" }>> {
  const out: Array<{ file: string; scope: "project" | "user" }> = []
  for (const { dir, scope } of roots) {
    for (const entry of await listDir(dir)) {
      if (!entry.endsWith(".md")) continue
      out.push({ file: path.join(dir, entry), scope })
    }
  }
  return byScopeThenPath(out)
}

/**
 * Scope is the FIRST sort key, not the root order.
 *
 * The two roots per scope (`.claude/…`, `.github/…`) are visited in a fixed
 * order, but `readdir` order is filesystem-dependent and the plan's suffixes
 * (`writer` vs `writer-user`) are assigned first-come. A project artifact must
 * win its authored name over a user artifact of the same name on every machine,
 * so the ordering is stated here rather than inherited from the walk.
 */
function byScopeThenPath<T extends { file: string; scope: "project" | "user" }>(
  rows: Array<T>,
): Array<T> {
  return rows.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })
}

async function collectSkillFiles(
  roots: ReadonlyArray<{ dir: string; scope: "project" | "user" }>,
): Promise<Array<{ file: string; scope: "project" | "user"; name: string }>> {
  const out: Array<{ file: string; scope: "project" | "user"; name: string }> = []
  for (const { dir, scope } of roots) {
    for (const entry of await listDir(dir)) {
      if (entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (await isDirectory(full)) {
        const skillFile = path.join(full, "SKILL.md")
        const raw = await readIfExists(skillFile)
        if (raw === undefined) continue
        out.push({
          file: skillFile,
          scope,
          name: frontmatterValue(splitFrontmatter(raw).frontmatter, "name") ?? entry,
        })
        continue
      }
      if (entry.endsWith(".md")) {
        const raw = await readIfExists(full)
        if (raw === undefined) continue
        out.push({
          file: full,
          scope,
          name:
            frontmatterValue(splitFrontmatter(raw).frontmatter, "name")
            ?? entry.replace(/\.md$/, ""),
        })
      }
    }
  }
  return byScopeThenPath(out)
}

async function collectPromptFiles(
  roots: ReadonlyArray<{ dir: string; scope: "project" | "user" }>,
): Promise<Array<{ file: string; scope: "project" | "user"; name: string }>> {
  const out: Array<{ file: string; scope: "project" | "user"; name: string }> = []
  const walk = async (dir: string, scope: "project" | "user", prefix: string): Promise<void> => {
    for (const entry of await listDir(dir)) {
      if (entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (await isDirectory(full)) {
        await walk(full, scope, `${prefix}${entry}-`)
        continue
      }
      if (!entry.endsWith(".md")) continue
      // `.prompt.md` is Copilot's prompt-file suffix; `deploy.prompt.md` is
      // the command `deploy`, not `deploy-prompt`.
      const stem = entry.replace(/\.prompt\.md$/, "").replace(/\.md$/, "")
      // Nested commands flatten BEFORE the reservation, because a flattened
      // name can collide with a flat one (`nested/deploy` vs `deploy`).
      out.push({ file: full, scope, name: `${prefix}${stem}` })
    }
  }
  for (const { dir, scope } of roots) await walk(dir, scope, "")
  return byScopeThenPath(out)
}

/**
 * Build the bridge plan. Pure over the filesystem: reads the foreign roots
 * and the reservation sets, writes nothing.
 */
export async function planForeignArtifacts(opts: {
  repoRoot: string
  homeDir: string
  mirrorDir: string
  reservedNames: PiReservedNames
}): Promise<PiForeignPlan> {
  const { repoRoot, homeDir, reservedNames: reserved } = opts
  const plan: PiForeignPlan = { skills: [], prompts: [], agents: [], skipped: [] }

  // Reservation sets are copied for the skill/prompt namespaces: they are
  // mutated as this plan claims names, so two foreign files that ask for the
  // same thing disambiguate instead of fighting.
  const skillNames = new Set(reserved.skills)
  const promptNames = new Set(reserved.prompts)
  const agentNames = new Set(reserved.agents)

  /* ----- skills (always bridged) ----- */
  const skillFiles = await collectSkillFiles([
    ...SKILL_ROOTS_PROJECT.map((rel) => ({ dir: path.join(repoRoot, rel), scope: "project" as const })),
    ...SKILL_ROOTS_USER.map((rel) => ({ dir: path.join(homeDir, rel), scope: "user" as const })),
  ])
  for (const { file, name } of skillFiles) {
    const raw = await readIfExists(file)
    if (raw === undefined) continue
    const shown = provenancePath(file, repoRoot, homeDir)
    const { frontmatter, body } = splitFrontmatter(raw)
    const description = collapseLine(frontmatterValue(frontmatter, "description") ?? "")
    if (!description) {
      // Pi refuses a skill with no description (`core/skills.js:252-254`), so
      // this is a hard skip — reported, never a silent drop.
      plan.skipped.push({ name, file: shown, reason: "skill has no description (Pi requires one)" })
      continue
    }
    const authored = piForeignSlug(name)
    const finalName = claim(skillNames, authored, () => ordinals(authored))
    const allowed = frontmatterList(frontmatter, "allowed-tools")
    plan.skills.push({
      name: finalName,
      ...(finalName === authored ? {} : { renamedFrom: name }),
      content: `${buildSkillFrontmatter(description)}\n${buildArtifactBody({
        body,
        source: sourceOf(file),
        shown,
        allowed,
      })}`,
    })
  }

  /* ----- prompts (under --foreign) ----- */
  const promptFiles = await collectPromptFiles([
    ...PROMPT_ROOTS_PROJECT.map((rel) => ({ dir: path.join(repoRoot, rel), scope: "project" as const })),
    ...PROMPT_ROOTS_USER.map((rel) => ({ dir: path.join(homeDir, rel), scope: "user" as const })),
  ])
  for (const { file, name } of promptFiles) {
    const raw = await readIfExists(file)
    if (raw === undefined) continue
    const shown = provenancePath(file, repoRoot, homeDir)
    const authored = piForeignSlug(name)
    const finalName = claim(promptNames, authored, () => ordinals(authored))
    // A prompt template is prose + `$1`/`$ARGUMENTS` placeholders. The body is
    // otherwise passed through untouched: rewriting placeholders would silently
    // change what the command means, and `$ARGUMENTS` is documented as not
    // bridged. Only a provenance line is prepended, so the command's origin is
    // visible where it runs.
    const { body } = splitFrontmatter(raw)
    plan.prompts.push({
      name: finalName,
      ...(finalName === authored ? {} : { renamedFrom: name }),
      content: `${buildArtifactBody({ body, source: sourceOf(file), shown, allowed: [] })}\n`,
    })
  }

  /* ----- agents (specs only — no files) ----- */
  const agentFiles = await collectAgentFiles([
    ...AGENT_ROOTS_PROJECT.map((rel) => ({ dir: path.join(repoRoot, rel), scope: "project" as const })),
    ...AGENT_ROOTS_USER.map((rel) => ({ dir: path.join(homeDir, rel), scope: "user" as const })),
  ])
  // Content-dekeyed dedupe: first-mate dual-emits the same 8 roles into
  // `.github/agents` AND `.claude/agents` with byte-identical bodies, so the
  // second copy of a role must not become `planner-2`.
  const seenBodies = new Set<string>()
  for (const { file, scope } of agentFiles) {
    const raw = await readIfExists(file)
    if (raw === undefined) continue
    const shown = provenancePath(file, repoRoot, homeDir)
    const stem = path.basename(file).replace(/\.agent\.md$/, "").replace(/\.md$/, "")
    const { frontmatter, body } = splitFrontmatter(raw)
    const originalName = frontmatterValue(frontmatter, "name") ?? stem
    const description = collapseLine(frontmatterValue(frontmatter, "description") ?? "")
    // A flat `.md` without a description is not an agent definition (Copilot
    // requires one; Claude allows it but Pi's index line would be empty).
    if (!description) {
      plan.skipped.push({
        name: originalName,
        file: shown,
        reason: "no description in frontmatter (not a usable agent definition)",
      })
      continue
    }
    const authored = piForeignSlug(originalName)
    // Router-owned FIRST: the role already exists under that name, so a second
    // entry with one purpose would only make the catalog ambiguous. Ordered
    // before the dedupe so the dual-emitted `reviewer` from first-mate reports
    // the real reason twice ("the role exists") instead of once as a duplicate
    // of a copy that was itself never bridged — the second shape of skip would
    // be true but misleading, since nothing was bridged to duplicate.
    if (reserved.routerOwnedAgents.has(lower(originalName))) {
      plan.skipped.push({
        name: originalName,
        file: shown,
        reason: "name is owned by gh-router or a pi-subagents builtin (that role already exists)",
      })
      continue
    }
    const hash = `${authored}\u0000${body}`
    if (seenBodies.has(hash)) {
      plan.skipped.push({
        name: originalName,
        file: shown,
        reason: "duplicate of an identical definition already bridged from another emitted path",
      })
      continue
    }
    seenBodies.add(hash)
    const finalName = claim(agentNames, authored, () => scopeSuffixes(authored, scope))
    const tools = frontmatterList(frontmatter, "tools")
    plan.agents.push({
      name: finalName,
      originalName,
      description: truncateChars(description, MAX_FOREIGN_DESCRIPTION_CHARS),
      // Trimmed because pi-subagents' `validateString` rejects a
      // `systemPrompt` that differs from its own `trim()` — and a markdown
      // body always ends with a newline, so an untrimmed body would fail
      // registration for EVERY bridged agent (`runtime-agent-registry.js:48`).
      body: capBytes(
        buildArtifactBody({ body, source: sourceOf(file), shown, allowed: tools }),
        MAX_FOREIGN_AGENT_BODY_BYTES,
        "gh-router foreign-agent bridge",
      ).text.trim(),
      source: sourceOf(file),
      scope,
      file: shown,
      ...(finalName === authored ? {} : { renamedFrom: originalName }),
    })
  }

  return plan
}

/**
 * Frontmatter for a bridged skill.
 *
 * The `name:` key is deliberately ABSENT: Pi resolves a skill's name from the
 * frontmatter when present and from the parent directory otherwise
 * (`core/skills.js:245`), so dropping it lets the directory we just wrote
 * decide. Keeping the authored `name: gh-oracle` inside `gh-oracle-2/SKILL.md`
 * makes BOTH copies load as `gh-oracle` and the foreign one loses as a
 * `collision` diagnostic — a silent loss.
 */
function buildSkillFrontmatter(description: string): string {
  const safeDescription = truncateChars(description, MAX_FOREIGN_SKILL_DESCRIPTION_CHARS).replace(
    /\r?\n/g,
    " ",
  )
  return `---\ndescription: ${safeDescription}\n---\n`
}

/**
 * The shared body shape for bridged artifacts: a provenance line (so the
 * origin is visible where it runs, not only where it was written), the
 * original tool policy as prose (Pi cannot enforce a foreign allowlist, and an
 * unresolvable entry would hard-fail the child), then the authored body.
 *
 * The body is secret-redacted on the way through: a foreign agent or command is
 * user-authored prose that has never been through the router, and copying it
 * into a launch mirror verbatim would move any token pasted into it into a
 * second file tree.
 */
function buildArtifactBody(opts: {
  body: string
  source: "claude" | "copilot"
  shown: string
  allowed: ReadonlyArray<string>
}): string {
  const provenance = `> Bridged by github-router from ${opts.source === "copilot" ? "Copilot" : "Claude"} \`${opts.shown}\`.`
  const policy =
    opts.allowed.length > 0
      ? `> Authored tool policy (advisory in Pi): ${opts.allowed.join(", ")}.`
      : undefined
  const trimmed = redactSecrets(opts.body).replace(/^\n+/, "")
  return [provenance, ...(policy ? [policy] : []), "", trimmed].join("\n")
}

/**
 * The one index the model sees. Deliberately a compact list, not the bodies:
 * runtime agents are never advertised (`advertised-agent-prompt.js`), and
 * spending the 16-entry / 12 KiB catalog on foreign agents would crowd out
 * the router's own roster. The model calls
 * `subagent({action:"list", options:{search:"…"}})` for full descriptions.
 */
export function buildForeignAgentIndex(
  agents: ReadonlyArray<PiForeignAgentSpec>,
  opts: { maxBytes?: number } = {},
): string {
  if (agents.length === 0) return ""
  const maxBytes = opts.maxBytes ?? MAX_FOREIGN_INDEX_BYTES
  const header = [
    "Agents bridged from .claude / .github / ~/.copilot. They are NOT preloaded:",
    'call subagent({action:"list", options:{search:"<term>"}}) for full descriptions,',
    'then subagent({agent:"<name>", task:"…"}). They run on this profile\'s lead model.',
  ]
  const rows = agents.map(
    (a) => `- ${a.name} [${a.source}, ${a.scope}] — ${a.description}`,
  )
  // Ship whole rows: a half-written index line is worse than a count, because
  // the model would call an agent whose description it cannot read.
  const included: Array<string> = []
  let bytes = Buffer.byteLength([...header, ...included].join("\n"), "utf8")
  for (const row of rows) {
    const size = Buffer.byteLength(`${row}\n`, "utf8")
    if (bytes + size > maxBytes) break
    included.push(row)
    bytes += size
  }
  const omitted = rows.length - included.length
  const tail = omitted > 0 ? [`+${omitted} more; {action:"list", options:{search:"<term>"}}`] : []
  return [...header, ...included, ...tail].join("\n")
}

/**
 * Write the plan's skills and prompts into the mirror.
 *
 * `overwritten` counts a target that already existed. It must be `0` on every
 * launch — the reservation is what guarantees it — and the launcher warns when
 * it is not, which is the tripwire for the silent-clobber failure this whole
 * module exists to prevent. Agents are NOT written: they are registry entries.
 */
export async function writeForeignArtifacts(
  mirrorDir: string,
  plan: PiForeignPlan,
): Promise<{ skills: number; prompts: number; overwritten: number }> {
  let skills = 0
  let prompts = 0
  let overwritten = 0
  const write = async (file: string, content: string): Promise<void> => {
    const existing = await readIfExists(file)
    if (existing !== undefined) overwritten += 1
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content, "utf8")
  }
  for (const skill of plan.skills) {
    await write(path.join(mirrorDir, "skills", skill.name, "SKILL.md"), skill.content)
    skills += 1
  }
  for (const prompt of plan.prompts) {
    await write(path.join(mirrorDir, "prompts", `${prompt.name}.md`), prompt.content)
    prompts += 1
  }
  return { skills, prompts, overwritten }
}

/**
 * Count the foreign AGENT definitions a `--foreign` launch would consider.
 *
 * Exists so a launch without the flag can still say the artifacts are there:
 * the bridge is invisible by design, and a user who has `.github/agents/` has
 * no other way to learn the flag exists. Deliberately a `readdir` count rather
 * than a plan — no reservations, no body reads, and it must stay cheap because
 * it runs on every non-`--foreign` launch.
 *
 * Counts **stems**, not files, because first-mate dual-emits every role into
 * `.github/agents` AND `.claude/agents` with byte-identical bodies: a file
 * count would report 16 where the user has 8 roles, which reads like the bridge
 * found something it did not.
 */
export async function countForeignAgentFiles(opts: {
  repoRoot: string
  homeDir: string
}): Promise<number> {
  const stems = new Set<string>()
  for (const root of [
    ...AGENT_ROOTS_PROJECT.map((rel) => path.join(opts.repoRoot, rel)),
    ...AGENT_ROOTS_USER.map((rel) => path.join(opts.homeDir, rel)),
  ]) {
    for (const entry of await listDir(root)) {
      if (!entry.endsWith(".md")) continue
      stems.add(entry.replace(/\.agent\.md$/, "").replace(/\.md$/, ""))
    }
  }
  return stems.size
}

/** Default home dir for the planner (separate seam so tests stay hermetic). */
export function piForeignHomeDir(): string {
  return os.homedir()
}
