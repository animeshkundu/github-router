import fs from "node:fs/promises"
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
 * All filesystem access is best-effort: missing/unreadable files are
 * skipped, never fatal. Pure helpers are exported for unit tests.
 */

export const PI_BRIDGE_STATIC_BUDGET_BYTES = 24_000 as const
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
}

export interface PiBridgeStats {
  staticFiles: number
  scopedRules: number
  imports: number
  skipped: number
  truncated: boolean
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

function capBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= max) return { text: s, truncated: false }
  let low = 0
  let high = s.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (byteLength(s.slice(0, mid)) <= max) low = mid + 1
    else high = mid
  }
  return { text: `${s.slice(0, Math.max(0, low - 1))}\n…[truncated by gh-router memory bridge]` , truncated: true }
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
    return await fs.readFile(file, "utf8")
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
        await fs.stat(path.join(dir, ".git"))
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
    const entries = await fs.readdir(dir)
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
        await fs.stat(path.join(walk, ".claude", "rules"))
        dir = path.join(walk, ".claude", "rules")
        break
      } catch {
        const parent = path.dirname(walk)
        if (parent === walk) break
        walk = parent
      }
    }
    if (dir) {
      const entries = await fs.readdir(dir)
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

  // 4. Alternate project memory `./.claude/CLAUDE.md` (deduped later
  // against Pi-native context; approval-gated by the caller).
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

  return collected
}

/** Build the static mirror `AGENTS.md` bridge section. */
export function buildMirrorBridgeSection(
  collected: PiBridgeCollected,
  opts: { repoRoot?: string } = {},
): { section: string; stats: PiBridgeStats } {
  const parts: Array<string> = [PI_BRIDGE_FENCE_BEGIN, "", "# gh-router memory bridge", ""]
  let truncated = false

  const pushCapped = (title: string, file: string, content: string, budgetLeft: () => number): void => {
    // Strip NUL bytes: a literal U+0000 in synthesized context breaks
    // strict downstream JSON consumers (workflow-preflight parse errors).
    const body = content.replaceAll("\0", "").trim()
    if (!body) return
    const block = `## ${title}\n<!-- source: ${file} -->\n\n${body}\n`
    const capped = capBytes(block, Math.max(0, budgetLeft()))
    parts.push(capped.text, "")
    if (capped.truncated) truncated = true
  }
  let used = byteLength(parts.join("\n"))
  const budgetLeft = (): number => Math.max(0, PI_BRIDGE_STATIC_BUDGET_BYTES - used - 512)
  const account = (): void => {
    used = byteLength(parts.join("\n"))
  }

  for (const entry of collected.copilotInstructions) {
    pushCapped("Copilot repo instructions", entry.file, entry.content, budgetLeft)
    account()
  }
  for (const entry of collected.unscopedRules) {
    pushCapped("Unscoped project rules", entry.file, entry.content, budgetLeft)
    account()
  }
  for (const entry of collected.userGlobal) {
    pushCapped("User-global instructions", entry.file, entry.content, budgetLeft)
    account()
  }
  for (const entry of collected.imports) {
    pushCapped("Imported context (@path)", entry.file, entry.content, budgetLeft)
    account()
  }

  if (collected.scopedRules.length > 0) {
    parts.push(
      "## Path-scoped rules (lazy)",
      "",
      "The following rule files apply only to matching paths and are attached",
      "when a matching file is read/edited/written (once per session):",
      "",
    )
    for (const rule of collected.scopedRules) {
      parts.push(`- \`${rule.file.replaceAll("\0", "")}\` → \`${rule.globs.join(", ").replaceAll("\0", "")}\` (${rule.source.replaceAll("\0", "")})`)
    }
    parts.push("")
    account()
  }

  if (opts.repoRoot) parts.push(`<!-- repo: ${opts.repoRoot.replaceAll("\0", "")} -->`, "")
  parts.push(PI_BRIDGE_FENCE_END, "")
  const section = redactSecrets(parts.join("\n")).replaceAll("\0", "")
  return {
    section,
    stats: {
      staticFiles:
        collected.copilotInstructions.length + collected.unscopedRules.length + collected.userGlobal.length,
      scopedRules: collected.scopedRules.length,
      imports: collected.imports.length,
      skipped: collected.skipped.length,
      truncated,
    },
  }
}

/**
 * Merge a bridge section into mirror `AGENTS.md`: append when absent,
 * replace the fenced block when present (idempotent across relaunches).
 */
export function mergeBridgeIntoAgentsMd(existing: string | undefined, section: string): string {
  const body = (existing ?? "").replace(/\r\n/g, "\n")
  if (!body.trim()) return `${section}\n`
  const begin = body.indexOf(PI_BRIDGE_FENCE_BEGIN)
  const end = body.indexOf(PI_BRIDGE_FENCE_END)
  if (begin !== -1 && end !== -1 && end > begin) {
    const after = body.slice(end + PI_BRIDGE_FENCE_END.length)
    return `${body.slice(0, begin)}${section}${after.startsWith("\n") ? after : `\n${after}`}`
  }
  return `${body.endsWith("\n") ? body : `${body}\n`}\n${section}\n`
}

/** Resolve the Claude auto-memory index path for a repo (on-demand read). */
export function claudeAutoMemoryIndex(homeDir: string, repoRoot: string): string {
  const slug = repoRoot.replace(/^\//, "").replace(/\//g, "-")
  return path.join(homeDir, ".claude", "projects", slug || "-", "memory", "MEMORY.md")
}
