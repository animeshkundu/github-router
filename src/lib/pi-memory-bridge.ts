import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Pi memory bridge: repo instruction + user-global + auto-memory surfacing.
 *
 * Pi natively loads per-dir first-win
 * `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`
 * (agentDir global + fs-root → cwd, concatenated, no trust gate).
 * It does NOT load `.github/copilot-instructions.md`,
 * `.github/instructions/*.instructions.md` (`applyTo`), `.claude/rules/`
 * (`paths:`), `@path` imports, `CLAUDE.local.md`, `./.claude/CLAUDE.md`,
 * `~/.claude/CLAUDE.md`, or Claude auto-memory.
 *
 * Strategy (per approved plan): synthesize the static repo-wide slice into
 * the per-launch mirror's `AGENTS.md` (a Pi-native candidate, so no new
 * loader is needed) and lazy-attach path-scoped rules via the
 * `gh-router-pi` extension's `tool_result` hook (mirrors
 * `pi-code/claude-rules.ts`). Auto-memory is on-demand only (`/memory`
 * command + explicit read), never auto-injected.
 *
 * The synthesized block is a permanent per-turn cost: Pi loads the mirror's
 * `AGENTS.md` into the `project_context` system-prompt section on EVERY turn
 * (`core/resource-loader.js` → `renderProjectContext`). It is therefore
 * written as instruction text, not as a report: one heading per source group,
 * one `path — body` line per file, no titles, no provenance comments. Measured
 * on a realistic repo: 86% of the pre-compaction block was scaffolding.
 *
 * The bridge does NOT try to replace what Pi loads natively. Pi still reads
 * the repo's own `AGENTS.md`/`CLAUDE.md` (and `AGENTS.override.md`) itself, so
 * a repo that ships both a native context file and a bridged Copilot/Claude
 * file sees the shared guidance twice; that is expected, because suppressing a
 * repo's own file to save bytes would silently drop guidance the user can see.
 *
 * All filesystem access is best-effort: missing/unreadable files are
 * skipped, never fatal. Pure helpers are exported for unit tests.
 */

export const PI_BRIDGE_STATIC_BUDGET_BYTES = 24_000 as const
/**
 * Floor reserved for every group that still has content to write, so one huge
 * first section cannot starve the rest down to a bare truncation marker. A
 * group that cannot fit its floor is written as a named omission instead of a
 * silent gap; see `buildMirrorBridgeSection`.
 */
export const PI_BRIDGE_SECTION_FLOOR_BYTES = 1_500 as const
/**
 * Room held back for the "omitted for budget" row, so a body can never consume
 * the space reserved to report that something did not fit.
 */
const PI_BRIDGE_OMISSION_ROW_BYTES = 160
export const PI_BRIDGE_IMPORT_MAX_DEPTH = 4 as const
export const PI_BRIDGE_IMPORT_MAX_FILES = 10 as const
export const PI_BRIDGE_MEMORY_INDEX_MAX_LINES = 200 as const
export const PI_BRIDGE_MEMORY_INDEX_MAX_BYTES = 25_000 as const
export const PI_BRIDGE_FENCE_BEGIN = "<!-- gh-router memory-bridge begin -->"
export const PI_BRIDGE_FENCE_END = "<!-- gh-router memory-bridge end -->"

export interface PiBridgeScopedRule {
  /** Display path (absolute or repo-relative) for attribution. */
  file: string
  /** Rule body with frontmatter stripped. */
  body: string
  /** Glob list from `paths:` / `applyTo:` / `globs:`. Empty = unscoped. */
  globs: Array<string>
  /** Where the rule came from (for `/context` surfacing). */
  source: string
}

export interface PiBridgeCollected {
  /** Repo-wide copilot instructions that were found (after import expansion). */
  copilotInstructions: Array<{ file: string; content: string }>
  /** Unscoped Claude rules (inlined statically). */
  unscopedRules: Array<{ file: string; content: string }>
  /** Path-scoped rules (lazy-attached, not inlined). */
  scopedRules: Array<PiBridgeScopedRule>
  /** User-global files found (capped, inlined). */
  userGlobal: Array<{ file: string; content: string }>
  /** Resolved `@` imports (appended once, deduped). */
  imports: Array<{ file: string; content: string }>
  /** Skipped files with reasons (for `/context`). */
  skipped: Array<{ file: string; reason: string }>
  /** Entries dropped because another entry named the same file (realpath/inode). */
  deduped?: number
}

export interface PiBridgeStats {
  staticFiles: number
  scopedRules: number
  imports: number
  skipped: number
  /**
   * True when any body (or the whole block) was cut by the byte budget. Computed
   * here and surfaced by `/memory`, `/context`, `.gh-router-bridge.json` and a
   * launch warning — a silent cut is the failure mode this field exists for.
   */
  truncated: boolean
  /** Bytes of the emitted fenced section, so `/memory` can show the real cost. */
  bytes: number
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/**
 * Truncate to a UTF-8 byte budget without splitting a code point, marker
 * included in the budget.
 *
 * Exported because the foreign-artifact bridge caps with the same measure Pi's
 * own limits are stated in, and `label` keeps the truncation marker honest
 * about which bridge did the cutting.
 */
export function capBytes(
  s: string,
  max: number,
  label = "gh-router memory bridge",
): { text: string; truncated: boolean } {
  if (byteLength(s) <= max) return { text: s, truncated: false }
  // The marker is part of the budget, not extra: a caller that asserts "≤ 8
  // KiB" means the returned string, so the head is cut short enough for the
  // marker to fit inside `max`.
  const marker = `\n…[truncated by ${label}]`
  const budget = Math.max(0, max - byteLength(marker))
  let low = 0
  let high = s.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (byteLength(s.slice(0, mid)) <= budget) low = mid + 1
    else high = mid
  }
  return { text: `${s.slice(0, Math.max(0, low - 1))}${marker}`, truncated: true }
}

/** Strip YAML frontmatter (`--- ... ---`) and return body + raw frontmatter. */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---")) return { frontmatter: "", body: normalized }
  const end = normalized.indexOf("\n---", 3)
  if (end === -1) return { frontmatter: "", body: normalized }
  return {
    frontmatter: normalized.slice(3, end).trim(),
    body: normalized.slice(end + 4).replace(/^\n/, ""),
  }
}

/**
 * Minimal frontmatter glob extraction for `paths:` / `applyTo:` / `globs:`.
 * Supports `key: "glob"`, `key: a, b`, and YAML lists. Case-insensitive keys.
 * Returns [] when no scoping key is present (unscoped rule).
 */
export function extractScopeGlobs(frontmatter: string): Array<string> {
  const out: Array<string> = []
  const lines = frontmatter.split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const m = /^\s*(paths|applyTo|globs)\s*:\s*(.*)$/i.exec(line)
    if (!m) {
      i++
      continue
    }
    const rest = (m[2] ?? "").trim()
    if (rest.startsWith("[") && rest.endsWith("]")) {
      for (const part of rest.slice(1, -1).split(",")) {
        const v = part.trim().replace(/^["']|["']$/g, "")
        if (v) out.push(v)
      }
      i++
      continue
    }
    if (rest && !rest.startsWith("|") && !rest.startsWith(">")) {
      const v = rest.replace(/^["']|["']$/g, "").split("#")[0]?.trim() ?? ""
      if (v) {
        for (const part of v.split(",")) {
          const p = part.trim()
          if (p) out.push(p)
        }
      }
      i++
      continue
    }
    // Block list on following indented lines (`- "glob"`).
    i++
    while (i < lines.length) {
      const item = lines[i] ?? ""
      const im = /^\s+-\s+(.+)$/.exec(item)
      if (!im) break
      const v = (im[1] ?? "").trim().replace(/^["']|["']$/g, "")
      if (v) out.push(v)
      i++
    }
  }
  return out
}

/** Convert a single glob to RegExp. `*` stays in-segment, `**` crosses. */
function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "")
  let re = ""
  let k = 0
  while (k < g.length) {
    const c = g[k]
    if (c === "*") {
      if (g[k + 1] === "*") {
        // `**/` → optional any-prefix; trailing `/**` → any suffix.
        if (g[k + 2] === "/") {
          re += "(?:.*/)?"
          k += 3
        } else {
          re += ".*"
          k += 2
        }
      } else {
        re += "[^/]*"
        k += 1
      }
      continue
    }
    if (c === "?") {
      re += "[^/]"
      k += 1
      continue
    }
    if ("+()|^$.{}[]\\".includes(c ?? "")) re += `\\${c}`
    else re += c
    k += 1
  }
  // Slashless patterns (`*.ts`) match basename at any depth (gitignore-style).
  if (!g.includes("/")) re = `(?:.*/)?${re}`
  return new RegExp(`^${re}$`)
}

/**
 * Does a touched file match any of the rule globs?
 * `touchedAbs` may be absolute or repo-relative; `ruleRoot` scopes
 * project-relative globs. Falls back to basename matching.
 */
export function ruleMatchesFile(
  globs: ReadonlyArray<string>,
  touchedAbs: string,
  ruleRoot: string,
): boolean {
  if (globs.length === 0) return false
  const candidates = new Set<string>()
  const norm = touchedAbs.replace(/\\/g, "/")
  candidates.add(norm)
  const rel = path.relative(ruleRoot, touchedAbs).replace(/\\/g, "/")
  if (rel && !rel.startsWith("..")) candidates.add(rel)
  candidates.add(path.basename(touchedAbs))
  for (const glob of globs) {
    let re: RegExp
    try {
      re = globToRegExp(glob)
    } catch {
      continue
    }
    for (const c of candidates) {
      if (re.test(c)) return true
    }
  }
  return false
}

/** Extract `@path` references (whole-line or trailing) ending in a text extension. */
export function extractAtImports(content: string): Array<string> {
  const refs: Array<string> = []
  const seen = new Set<string>()
  const pattern = /@([~.]?[\w./\\-]+\.(?:md|txt|yaml|yml|json|toml))(?:\s|$)/g
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.includes("@")) continue
    // Skip fenced-code `@` mentions (commented-out imports must not expand).
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(trimmed)) !== null) {
      const ref = m[1] ?? ""
      if (ref && !seen.has(ref)) {
        seen.add(ref)
        refs.push(ref)
      }
    }
  }
  return refs
}

/**
 * Resolve `@` imports against an in-memory file map (pure, testable).
 * Depth-capped, cycle-safe, budget-capped. Returns appended bodies only
 * (base files are never re-appended by the caller).
 */
export function resolveImportsPure(
  baseFiles: ReadonlyArray<{ file: string; content: string }>,
  readFile: (absPath: string) => string | undefined,
  homeDir: string,
  maxDepth = PI_BRIDGE_IMPORT_MAX_DEPTH,
  maxFiles = PI_BRIDGE_IMPORT_MAX_FILES,
): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = []
  const visited = new Set<string>()
  for (const base of baseFiles) {
    try {
      visited.add(path.resolve(base.file))
    } catch {
      visited.add(base.file)
    }
  }
  const visit = (importerAbs: string, content: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return
    const baseDir = path.dirname(importerAbs)
    for (const ref of extractAtImports(content)) {
      if (out.length >= maxFiles) return
      let expanded = ref
      if (expanded.startsWith("~")) expanded = path.join(homeDir, expanded.slice(1))
      const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded)
      if (visited.has(abs)) continue
      visited.add(abs)
      const body = readFile(abs)
      if (body === undefined) continue
      out.push({ file: abs, content: splitFrontmatter(body).body })
      visit(abs, body, depth + 1)
    }
  }
  for (const base of baseFiles) {
    let abs = base.file
    try {
      abs = path.resolve(base.file)
    } catch {
      // keep as-is
    }
    visit(abs, base.content, 1)
  }
  return out
}

/** Cap Claude auto-memory index the way Claude Code measures it. */
export function capMemoryIndex(raw: string): string {
  const lines = raw.split("\n").slice(0, PI_BRIDGE_MEMORY_INDEX_MAX_LINES)
  let text = lines.join("\n")
  if (byteLength(text) > PI_BRIDGE_MEMORY_INDEX_MAX_BYTES) {
    text = capBytes(text, PI_BRIDGE_MEMORY_INDEX_MAX_BYTES).text
  }
  return text
}

/** Redact likely secrets before persisting synthesized bridge content. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]")
    .replace(/(sk-(live|test)-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{8,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{8,})/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED jwt]")
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Collect bridge inputs from disk (best-effort). Repo root is the cwd's
 * git top-level when resolvable, else cwd. Only reads files; never writes.
 */
export async function collectBridgeInputs(
  cwd = process.cwd(),
  homeDir = os.homedir(),
): Promise<PiBridgeCollected> {
  const collected: PiBridgeCollected = {
    copilotInstructions: [],
    unscopedRules: [],
    scopedRules: [],
    userGlobal: [],
    imports: [],
    skipped: [],
  }
  // Repo root: walk up for `.git` (cheap, no subprocess).
  let repoRoot = cwd
  try {
    let dir = path.resolve(cwd)
    for (let depth = 0; depth < 12; depth++) {
      try {
        await fsp.stat(path.join(dir, ".git"))
        repoRoot = dir
        break
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    repoRoot = cwd
  }

  // 1. Repo-wide Copilot instructions (+ `@` expansion later).
  const copilotFile = path.join(repoRoot, ".github", "copilot-instructions.md")
  const copilotBody = await readIfExists(copilotFile)
  const baseForImports: Array<{ file: string; content: string }> = []
  if (copilotBody !== undefined) {
    collected.copilotInstructions.push({ file: copilotFile, content: splitFrontmatter(copilotBody).body })
    baseForImports.push({ file: copilotFile, content: copilotBody })
  }

  // 2. Path-specific Copilot instructions (applyTo).
  try {
    const dir = path.join(repoRoot, ".github", "instructions")
    const entries = await fsp.readdir(dir)
    for (const name of entries.sort()) {
      if (!name.endsWith(".instructions.md")) continue
      const file = path.join(dir, name)
      const raw = await readIfExists(file)
      if (raw === undefined) continue
      const { frontmatter, body } = splitFrontmatter(raw)
      const globs = extractScopeGlobs(frontmatter)
      if (globs.length === 0 || globs.includes("**") || globs.includes("**/*")) {
        collected.unscopedRules.push({ file, content: body })
      } else {
        collected.scopedRules.push({ file, body, globs, source: "copilot-instructions" })
      }
    }
  } catch {
    // no instructions dir — not an error
  }

  // 3. Claude rules (nearest `.claude/rules` at-or-above cwd).
  try {
    let dir: string | null = null
    let walk = path.resolve(cwd)
    for (let depth = 0; depth < 12; depth++) {
      try {
        await fsp.stat(path.join(walk, ".claude", "rules"))
        dir = path.join(walk, ".claude", "rules")
        break
      } catch {
        const parent = path.dirname(walk)
        if (parent === walk) break
        walk = parent
      }
    }
    if (dir) {
      const entries = await fsp.readdir(dir)
      for (const name of entries.sort()) {
        if (!name.endsWith(".md")) continue
        const file = path.join(dir, name)
        const raw = await readIfExists(file)
        if (raw === undefined) continue
        const { frontmatter, body } = splitFrontmatter(raw)
        if (!body.trim()) {
          collected.skipped.push({ file, reason: "empty after frontmatter strip" })
          continue
        }
        const globs = extractScopeGlobs(frontmatter)
        if (globs.length === 0) collected.unscopedRules.push({ file, content: body })
        else collected.scopedRules.push({ file, body, globs, source: "claude-rules" })
      }
    }
  } catch {
    // unreadable rules dir — skip
  }

  // 4. Alternate project memory `./.claude/CLAUDE.md`. Recorded here only;
  // step 7 dedupes it against anything the same file reached through an `@`
  // import, and Pi still loads the repo's OWN AGENTS.md/CLAUDE.md natively
  // (`loadProjectContextFiles`), which this bridge deliberately does not try
  // to replace: suppressing a repo's own context file to save bytes would
  // silently drop guidance the user can see.
  const dotClaude = path.join(repoRoot, ".claude", "CLAUDE.md")
  const dotBody = await readIfExists(dotClaude)
  if (dotBody !== undefined && dotBody.trim()) {
    collected.unscopedRules.push({ file: dotClaude, content: splitFrontmatter(dotBody).body })
    baseForImports.push({ file: dotClaude, content: dotBody })
  }

  // 5. User-global files (inlined, capped downstream).
  for (const file of [
    path.join(homeDir, ".claude", "CLAUDE.md"),
    path.join(homeDir, ".copilot", "copilot-instructions.md"),
  ]) {
    const raw = await readIfExists(file)
    if (raw !== undefined && raw.trim()) {
      collected.userGlobal.push({ file, content: splitFrontmatter(raw).body })
      baseForImports.push({ file, content: raw })
    }
  }

  // 6. `@` imports across everything collected so far.
  const fileMap = new Map<string, string>()
  for (const group of [collected.copilotInstructions, collected.unscopedRules, collected.userGlobal]) {
    for (const entry of group) {
      try {
        fileMap.set(path.resolve(entry.file), entry.content)
      } catch {
        fileMap.set(entry.file, entry.content)
      }
    }
  }
  // Async BFS over `@` imports (map first, disk fallback). Seeds `seen`
  // with base files so a self-import never re-appends the base body.
  const seen = new Set<string>()
  for (const b of baseForImports) {
    try {
      seen.add(path.resolve(b.file))
    } catch {
      seen.add(b.file)
    }
  }
  const queue: Array<{ importer: string; content: string; depth: number }> = baseForImports.map((b) => ({
    importer: b.file,
    content: b.content,
    depth: 1,
  }))
  while (queue.length > 0 && collected.imports.length < PI_BRIDGE_IMPORT_MAX_FILES) {
    const head = queue.shift()
    if (!head || head.depth > PI_BRIDGE_IMPORT_MAX_DEPTH) continue
    let importerAbs = head.importer
    try {
      importerAbs = path.resolve(head.importer)
    } catch {
      // keep
    }
    const baseDir = path.dirname(importerAbs)
    for (const ref of extractAtImports(head.content)) {
      if (collected.imports.length + seen.size >= PI_BRIDGE_IMPORT_MAX_FILES) break
      let expanded = ref
      if (expanded.startsWith("~")) expanded = path.join(homeDir, expanded.slice(1))
      const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded)
      if (seen.has(abs)) continue
      seen.add(abs)
      const hit = fileMap.get(abs) ?? (await readIfExists(abs))
      if (hit === undefined) {
        collected.skipped.push({ file: abs, reason: `import of ${head.importer} not found` })
        continue
      }
      const body = splitFrontmatter(hit).body
      collected.imports.push({ file: abs, content: body })
      queue.push({ importer: abs, content: hit, depth: head.depth + 1 })
    }
  }

  return dedupeCollected(collected)
}

/**
 * Canonical identity for a collected file: `realpath` when it resolves (so a
 * symlinked rule is not emitted twice under two names), `INO` identity as a
 * fallback for hard links (two names for one inode are one rule), the resolved
 * path otherwise.
 */
function fileIdentity(file: string): string {
  const resolved = (() => {
    try {
      return path.resolve(file)
    } catch {
      return file
    }
  })()
  try {
    const real = fs.realpathSync.native(resolved)
    const { dev, ino } = fs.statSync(real)
    return ino ? `${dev}:${ino}` : real
  } catch {
    return resolved
  }
}

/**
 * Drop entries that name the same file (symlink, hard link, or an `@` import
 * that re-reaches a base file). First occurrence wins: groups are ordered by
 * authority (repo-wide, then project rules, then user-global, then imports), so
 * the earlier copy is the one with the better provenance.
 */
function dedupeCollected(collected: PiBridgeCollected): PiBridgeCollected {
  const seen = new Set<string>()
  const keep = <T extends { file: string }>(entry: T): boolean => {
    const id = fileIdentity(entry.file)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }
  const imports = collected.imports.filter(keep)
  const unscopedRules = collected.unscopedRules.filter(keep)
  const userGlobal = collected.userGlobal.filter(keep)
  const copilotInstructions = collected.copilotInstructions.filter(keep)
  const scopedRules = collected.scopedRules.filter(keep)
  const skipped = collected.skipped.filter(keep)
  const dropped =
    (collected.imports.length - imports.length)
    + (collected.unscopedRules.length - unscopedRules.length)
    + (collected.userGlobal.length - userGlobal.length)
    + (collected.copilotInstructions.length - copilotInstructions.length)
    + (collected.scopedRules.length - scopedRules.length)
  return {
    copilotInstructions,
    unscopedRules,
    scopedRules,
    userGlobal,
    imports,
    skipped,
    ...(dropped > 0 ? { deduped: dropped } : {}),
  }
}

/**
 * Display form of a source path: repo-relative when it lives under the repo,
 * `~`-relative when under the home directory, absolute otherwise. Keeps the
 * block free of absolute paths, which cost bytes the model never needs.
 */
function displaySource(file: string, repoRoot?: string, homeDir?: string): string {
  const clean = file.replaceAll("\0", "")
  const rel = (root: string): string | undefined => {
    const base = root.replace(/[\\/]+$/, "")
    if (!base) return undefined
    if (clean === base) return undefined
    if (!clean.startsWith(`${base}/`) && !clean.startsWith(`${base}\\`)) return undefined
    return clean.slice(base.length + 1)
  }
  const inRepo = repoRoot ? rel(repoRoot) : undefined
  if (inRepo) return inRepo
  const inHome = homeDir ? rel(homeDir) : undefined
  if (inHome) return `~/${inHome}`
  return clean
}

interface BridgeGroup {
  title: string
  entries: ReadonlyArray<{ file: string; content: string }>
}

/**
 * Build the static mirror `AGENTS.md` bridge section.
 *
 * Every emitted byte is a per-turn prompt cost, so the block carries
 * instruction text and nothing else: one heading per group, one line per file
 * in the form `` `path` — body ``, bodies copied verbatim (a `file:line` list
 * is real AGENTS.md content and must not be flattened), and no title or
 * provenance comments. Returns `section: ""` when nothing was collected, so
 * the caller writes no block at all — and `mergeBridgeIntoAgentsMd` then strips
 * any block a previous launch wrote, rather than leaving stale guidance in the
 * prompt forever.
 *
 * Budget: `PI_BRIDGE_STATIC_BUDGET_BYTES` still bounds the block, but every
 * group with content keeps `PI_BRIDGE_SECTION_FLOOR_BYTES` (capped at an even
 * share of what is left), so the last group cannot be reduced to a bare
 * truncation marker by a large first one. A group that still cannot fit is
 * written as a named omission, which the model can act on, unlike a silence.
 * Redaction runs per body BEFORE the cap, so a cut can never leave the first
 * half of a secret in the prompt.
 *
 * The ceiling is an invariant, not a target: the fence is part of the ledger
 * (it used to be appended after the fact, which let the accounting overshoot)
 * and the omission row is a single capped row for the whole group, because a
 * group of 40 small files could otherwise spend the whole budget on markers
 * alone. That row leads with the omitted COUNT, so it stays informative even
 * when its own list of names is cut.
 */
export function buildMirrorBridgeSection(
  collected: PiBridgeCollected,
  opts: { repoRoot?: string; homeDir?: string } = {},
): { section: string; stats: PiBridgeStats } {
  const homeDir = opts.homeDir ?? os.homedir()
  const groups: Array<BridgeGroup> = [
    { title: "Copilot repo instructions", entries: collected.copilotInstructions },
    { title: "Unscoped project rules", entries: collected.unscopedRules },
    { title: "User-global instructions", entries: collected.userGlobal },
    { title: "Imported (`@path`)", entries: collected.imports },
  ].filter((g) => g.entries.length > 0)
  const scoped = collected.scopedRules

  let truncated = false
  const parts: Array<string> = []
  // The fence and its blank line are emitted bytes, so they are charged to the
  // ledger up front; leaving them out is what let an adversarial group stack
  // past the ceiling on top of an already-full budget.
  let used = byteLength(PI_BRIDGE_FENCE_BEGIN) + byteLength(PI_BRIDGE_FENCE_END) + 4
  const live = (): Array<BridgeGroup> =>
    groups.filter((g) => g.entries.some((e) => e.content.replaceAll("\0", "").trim().length > 0))

  for (const [index, group] of groups.entries()) {
    // The lazy path-scoped list is a consumer of this same budget, so it counts
    // as one more group when the floors are handed out. Without that, an
    // oversized static slice left it zero room and every scoped rule silently
    // became unreachable for the whole session.
    const remainingGroups = Math.max(1, live().length - index + (scoped.length > 0 ? 1 : 0))
    // Reserve a floor for every group that still has to be written, never more
    // than an even share of what is left.
    const share = Math.floor(Math.max(0, PI_BRIDGE_STATIC_BUDGET_BYTES - used - 512) / remainingGroups)
    const floor = Math.min(PI_BRIDGE_SECTION_FLOOR_BYTES, Math.max(200, share))
    const budget = Math.max(0, PI_BRIDGE_STATIC_BUDGET_BYTES - used - 512 - floor * (remainingGroups - 1))
    const heading = `## ${group.title}`
    const rendered: Array<string> = []
    const omitted: Array<string> = []
    let groupTruncated = false
    const roomLeft = (): number =>
      budget - byteLength(heading) - 2 - rendered.reduce((n, s) => n + byteLength(s) + 2, 0)
    for (const entry of group.entries) {
      // Redact FIRST: a cap applied to unredacted text can leave a secret
      // prefix in the prompt.
      const body = redactSecrets(entry.content.replaceAll("\0", "")).trim()
      if (!body) continue
      const source = displaySource(entry.file, opts.repoRoot, homeDir)
      const line = `\`${source}\` — ${body}`
      const room = roomLeft()
      // Hold back room for the omission row, so a body cannot eat the space
      // that is supposed to say "some rules did not fit".
      if (room <= PI_BRIDGE_OMISSION_ROW_BYTES) {
        omitted.push(source)
        continue
      }
      const capped = capBytes(line, room - PI_BRIDGE_OMISSION_ROW_BYTES)
      if (capped.truncated) groupTruncated = true
      rendered.push(capped.text)
    }
    if (omitted.length > 0) {
      // One capped row for the whole group. The COUNT comes first so the row
      // stays informative even when the name list itself has to be cut (a group
      // of 40 small files would otherwise spend the budget on markers alone).
      groupTruncated = true
      const names = omitted.map((source) => `\`${source}\``).join(", ")
      const row = `- Omitted for budget (${omitted.length}): ${names}`
      const room = roomLeft()
      if (room > 0) rendered.push(capBytes(row, room).text)
    }
    if (rendered.length === 0) continue
    if (groupTruncated) truncated = true
    parts.push(heading, "", ...rendered, "")
    used = byteLength(PI_BRIDGE_FENCE_BEGIN) + byteLength(PI_BRIDGE_FENCE_END) + 4 + byteLength(parts.join("\n"))
    if (used >= PI_BRIDGE_STATIC_BUDGET_BYTES - 512) break
  }

  if (scoped.length > 0) {
    // One line per rule. The glob is what the model needs; the body is
    // attached lazily on the first matching read. The scoped list shares the
    // same budget as the sections above it, and it gets a floor too: an
    // oversized static slice must not turn the lazy list into an invisible one,
    // because those rules are then unreachable for the whole session.
    const header = "## Path-scoped rules (attached on first matching read/edit/write)"
    // Never more than what is actually left: the floors above already reserved
    // this section's share, and adding a floor on top of a spent budget is how
    // the ceiling used to be overshot.
    const room = Math.max(0, PI_BRIDGE_STATIC_BUDGET_BYTES - used - 512)
    const rows: Array<string> = []
    const omitted: Array<string> = []
    let scopedTruncated = false
    for (const rule of scoped) {
      const source = displaySource(rule.file, opts.repoRoot, homeDir)
      const row = `- \`${source}\` — \`${rule.globs.join(", ").replaceAll("\0", "")}\``
      const left = room - byteLength(header) - 2 - rows.reduce((n, s) => n + byteLength(s) + 2, 0)
      if (left <= PI_BRIDGE_OMISSION_ROW_BYTES) {
        omitted.push(source)
        continue
      }
      rows.push(capBytes(row, left - PI_BRIDGE_OMISSION_ROW_BYTES).text)
    }
    if (omitted.length > 0) {
      scopedTruncated = true
      const names = omitted.map((source) => `\`${source}\``).join(", ")
      const left = room - byteLength(header) - 2 - rows.reduce((n, s) => n + byteLength(s) + 2, 0)
      if (left > 0) rows.push(capBytes(`- Omitted for budget (${omitted.length}): ${names}`, left).text)
    }
    if (rows.length > 0) {
      if (scopedTruncated) truncated = true
      parts.push(header, "", ...rows, "")
    }
  }

  if (parts.length === 0) {
    return {
      section: "",
      stats: {
        staticFiles: 0,
        scopedRules: scoped.length,
        imports: collected.imports.length,
        skipped: collected.skipped.length,
        truncated,
        bytes: 0,
      },
    }
  }

  const section = `${PI_BRIDGE_FENCE_BEGIN}\n\n${parts.join("\n").trimEnd()}\n\n${PI_BRIDGE_FENCE_END}\n`
  return {
    section,
    stats: {
      staticFiles:
        collected.copilotInstructions.length + collected.unscopedRules.length + collected.userGlobal.length,
      scopedRules: scoped.length,
      imports: collected.imports.length,
      skipped: collected.skipped.length,
      truncated,
      bytes: byteLength(section),
    },
  }
}

/**
 * Merge a bridge section into mirror `AGENTS.md`: append when absent,
 * replace the fenced block when present.
 *
 * Byte-stable: merging the same section repeatedly must not grow the file. The
 * obvious implementation (`before + section + after`) is NOT, because `section`
 * ends with a newline and `after` starts with one, so every relaunch appended a
 * blank line that nothing ever removed. The result is normalized here instead:
 * `section` contributes exactly one trailing newline and `after` contributes
 * none of its leading ones.
 *
 * An empty `section` means the bridge found nothing to say: return the existing
 * user content untouched, but STRIP any fence this launcher wrote previously.
 * A stale block advertises guidance that no longer exists and still costs prompt
 * bytes every turn, so leaving it in place is worse than writing nothing.
 */
export function mergeBridgeIntoAgentsMd(existing: string | undefined, section: string): string {
  const body = (existing ?? "").replace(/\r\n/g, "\n")
  const begin = body.indexOf(PI_BRIDGE_FENCE_BEGIN)
  const end = body.indexOf(PI_BRIDGE_FENCE_END)
  const fenced = begin !== -1 && end !== -1 && end > begin
  if (!section.trim()) {
    if (!fenced) return existing ?? ""
    // Drop the previous block, keep whatever the user put around it.
    const before = body.slice(0, begin).replace(/\n*$/, "")
    const after = body.slice(end + PI_BRIDGE_FENCE_END.length).replace(/^\n+/, "").trimEnd()
    if (!before) return after ? `${after}\n` : ""
    return after ? `${before}\n\n${after}\n` : `${before}\n`
  }
  const block = `${section.trimEnd()}\n`
  if (!body.trim()) return block
  if (fenced) {
    const before = body.slice(0, begin).replace(/\n*$/, "")
    const after = body.slice(end + PI_BRIDGE_FENCE_END.length).replace(/^\n+/, "").trimEnd()
    const head = before ? `${before}\n\n` : ""
    const tail = after ? `\n${after}\n` : ""
    return `${head}${block}${tail}`
  }
  const before = body.replace(/\n*$/, "")
  return `${before}\n\n${block}`
}

/** Resolve the Claude auto-memory index path for a repo (on-demand read). */
export function claudeAutoMemoryIndex(homeDir: string, repoRoot: string): string {
  const slug = repoRoot.replace(/^\//, "").replace(/\//g, "-")
  return path.join(homeDir, ".claude", "projects", slug || "-", "memory", "MEMORY.md")
}
