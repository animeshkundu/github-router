/**
 * `code_search` MCP tool implementation.
 *
 * Exposes structured code search to clients (Claude Code, codex,
 * gemini callers) via the `mcp__gh-router-peers__code_search` tool.
 * Backed by ripgrep; ranks with BM25F (Robertson, Zaragoza, Taylor
 * 2004) over four code-aware fields (matched line, context window,
 * file path tokens, symbol-context heuristic).
 *
 * Plan: ~/.local/share/.../plans/what-are-the-following-wild-tarjan.md
 * Peer review: same dir, file ending in -agent-af76e3758b0fa7e1a.md.
 *
 * Load-bearing design decisions worth knowing before editing:
 *
 *   - Workspace is any absolute path that exists and is a directory.
 *     The proxy runs as the user; code_search reads what the proxy
 *     process can read, the same way Claude Code's built-in Read /
 *     Bash tools do. The earlier allow-set + secret-shape denylist
 *     was dropped: the threat model is symmetric (the model already
 *     has Bash and Read), so an extra gate on this one tool was just
 *     inconsistency, not defense.
 *
 *   - rg is spawned with `cwd: canonicalWorkspace` and target `.`,
 *     NEVER with the user-supplied path string as an argv positional.
 *     This pins the directory at kernel-level at spawn time, closing
 *     most of the TOCTOU window between validate and spawn. The
 *     residual same-user race is out of scope.
 *
 *   - The `--` positional separator is mandatory. A query starting
 *     with `-` would otherwise be parsed as a ripgrep flag — CVE.
 *
 *   - On Windows, child.kill() does NOT reliably terminate
 *     descendants. We invoke `taskkill /T /F /PID <pid>` on abort.
 *
 *   - JSON streaming parser short-circuits on `signal.aborted` so a
 *     half-flushed truncated chunk never reaches JSON.parse — three-
 *     lab confirmed cancel-race fix.
 *
 *   - `--max-count` is per-file, not global. We enforce the limit
 *     globally in the TS reader; relying on ripgrep would let a
 *     500-file monorepo return 10,000 hits with limit=20.
 *
 *   - BM25F is applied at file granularity over the rg hit set. The
 *     v1 review's BM25 critique was about snippet-granularity (4-line
 *     length-normalization noise); files have varied lengths so
 *     length normalization is meaningful here.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createInterface } from "node:readline"
import * as path from "node:path"

import consola from "consola"
import Parser from "web-tree-sitter"

// ============================================================
// Constants
// ============================================================

/**
 * BM25's `k1` term-frequency saturation parameter. Lucene's default.
 * Robertson & Zaragoza 2009 monograph recommends 1.2-2.0; Lucene
 * ships 1.2, Elasticsearch ships 1.2, we ship 1.2.
 */
const BM25F_K1 = 1.2

/**
 * Per-field BM25F boost weights (`b_f` in the CIKM 2004 paper). The
 * relative ordering follows Sourcegraph Zoekt's published signal
 * priorities — matched line first, then symbol context, then path,
 * then surrounding context.
 */
const FIELD_BOOSTS = {
  match_line: 3.0,
  symbol_context: 2.5,
  file_path: 2.0,
  context: 1.0,
} as const

/**
 * Per-field length-normalization parameter (`l_f`). 0.0 disables
 * length normalization for short, uniform fields. Lucene's default
 * `b=0.75` for prose-like fields.
 */
const FIELD_LEN_NORMS = {
  match_line: 0.0,
  symbol_context: 0.0,
  file_path: 0.0,
  context: 0.75,
} as const

/**
 * Shoulder cut: drop results below this fraction of the top score.
 * 0.5 is the convention from learning-to-rank literature (Burges
 * 2010); chosen as the deliberate single-place constant.
 */
const SHOULDER_THRESHOLD = 0.5

const MAX_QUERY_LEN = 1024
const MAX_GLOB_LEN = 512
const DEFAULT_LIMIT = 20
const MAX_CONTEXT_LINES = 10
const DEFAULT_CONTEXT_LINES = 2
const MAX_SNIPPET_BYTES = 2048
const MAX_STDOUT_BYTES = 10 * 1024 * 1024
const WALL_TIME_MS = 30_000

/**
 * Structural-pass settings. The wall-clock budget is checked between
 * files (NOT mid-parse — tree-sitter doesn't surface a usable cancel
 * hook in the web-tree-sitter binding we're on), so a single
 * pathological file can overrun by one file's parse-time. In practice
 * a single source file parses in well under 50ms; 200ms gives us
 * comfortable headroom for ~5-10 files even on cold cache.
 */
const STRUCTURAL_BUDGET_MS = 200
const STRUCTURAL_TOPN_FULL = 50
const STRUCTURAL_TOPN_FAST = 10

/**
 * Cap the per-file size we'll parse. 1MB of source covers all
 * reasonable hand-written files; bigger files are almost always
 * generated code or vendored bundles whose AST signal is worthless
 * for ranking real definitions.
 */
const STRUCTURAL_MAX_FILE_BYTES = 1024 * 1024

/**
 * LRU bound on the parsed-tree cache. Each Tree pins ~roughly the
 * size of its source plus tree-sitter's internal node arena. 64 is
 * comfortably under typical Node heap budgets; trees are eagerly
 * `.delete()`-ed on eviction.
 */
const STRUCTURAL_CACHE_MAX = 64

/**
 * Definition-shape heuristic for `symbol_context` field. Match this
 * against the matched line (after leading whitespace strip) to
 * detect "the match is on a definition." This is the regex fallback
 * we use when (a) tree-sitter can't reach the file (unsupported
 * language, grammar load failure, parse error), (b) the file isn't
 * in the structural pass's top-N slice, or (c) the structural budget
 * fired.
 */
const SYMBOL_REGEX =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|readonly\s+)*(?:function|class|interface|type|enum|def|fn|trait|impl|module|namespace|const|let|var)\s+[A-Za-z_$]/

// ============================================================
// Types
// ============================================================

export interface CodeSearchInput {
  query: string
  workspace: string
  mode?: "ranked" | "literal" | "regex"
  file_glob?: string
  limit?: number
  context_lines?: number
  /**
   * Depth of the tree-sitter structural-ranking pass. `"full"` parses
   * the top 50 BM25F hits and re-scores them with AST-confirmed
   * definition signal. `"topN"` parses only the top 10 — same signal,
   * tighter latency on large repos. Default `"full"`. The pass is
   * wrapped in a 200ms wall-clock budget; on overrun, remaining hits
   * fall back to the regex symbol heuristic and `notice` is populated
   * with a human-readable explanation.
   */
  structural?: "full" | "topN"
}

export interface CodeSearchHit {
  file: string
  line: number
  snippet: string
  match_byte_range: [number, number]
  score?: number
  field_contributions?: Readonly<Record<string, number>> | null
}

export interface CodeSearchResponse {
  results: Array<CodeSearchHit>
  truncated: boolean
  pruned_below_shoulder?: number
  scanned_files: number
  elapsed_ms: number
  ranking: {
    algorithm: "BM25F" | "ripgrep_document_order"
    citation?: string
    k1?: number
  }
  /**
   * Single actionable degradation notice for the model. `null` on the
   * happy path. A string when something the model can correct fired:
   *   - structural-budget exhaustion ("retry with structural: \"topN\"
   *     or narrow query")
   *   - response-size cap ("response size limit reached at N hits;
   *     lower limit or narrow your query")
   * Size-cap takes priority over structural-budget when both fire,
   * because size-cap means the model is missing results; structural-
   * budget just means the ranking was less precise but the result set
   * is complete.
   *
   * The MCP handler maps this to the `notice` response field (omitted
   * entirely when `null`) — only-when-actionable surface per the
   * docs/peer-mcp-design.md minimality principle.
   */
  notice: string | null
}

/**
 * Internal representation of one rg match before scoring.
 * `context_before` and `context_after` are populated via ripgrep's
 * --context flag (rg emits "context" JSON events that we associate
 * with the surrounding match).
 */
interface RawHit {
  file: string // path RELATIVE to workspace
  line: number // 1-indexed
  matched_line: string // line text without trailing newline
  match_start: number // byte offset in matched_line
  match_end: number // byte offset in matched_line
  context_before: Array<string>
  context_after: Array<string>
}

// ============================================================
// Ripgrep resolution
// ============================================================

interface RipgrepResolution {
  rgPath: string
  source: "system" | "bundled"
}

let _rgResolution: RipgrepResolution | undefined

/**
 * Tri-tier resolution. Memoized. Mirrors cc-backup
 * `src/utils/ripgrep.ts:31-65`.
 *
 *   1. System rg on PATH — use the literal command name `"rg"` (NOT
 *      the absolute path). This leverages NoDefaultCurrentDirectory-
 *      InExePath on Windows, preventing PATH-hijacking via a
 *      malicious ./rg.exe in the proxy's cwd.
 *   2. Bundled via `@vscode/ripgrep` — falls back to the per-platform
 *      binary that `optionalDependencies` installed.
 *   3. Throw — surfaced to the caller as an MCP isError response.
 */
export function resolveRipgrep(): RipgrepResolution {
  if (_rgResolution) return _rgResolution

  // System check: probe PATH for `rg`. We DON'T use the absolute
  // path returned by which/where — using just the command name lets
  // the OS apply NoDefaultCurrentDirectoryInExePath on Windows.
  if (hasSystemRipgrep()) {
    _rgResolution = { rgPath: "rg", source: "system" }
    return _rgResolution
  }

  // Bundled fallback. require.resolve through the @vscode/ripgrep
  // package's exports — works because v1.18.0 ships per-platform
  // binary packages via optionalDependencies.
  try {
    // Using a dynamic import keeps the dep optional at type level;
    // the package's rgPath export is a string.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@vscode/ripgrep") as { rgPath: string }
    if (mod.rgPath && existsSync(mod.rgPath)) {
      _rgResolution = { rgPath: mod.rgPath, source: "bundled" }
      return _rgResolution
    }
  } catch {
    // fall through
  }

  throw new Error(
    "ripgrep not found. Either install rg system-wide (brew/apt/winget) " +
      "or reinstall the proxy so @vscode/ripgrep's per-platform binary is " +
      "fetched. See README's code_search section.",
  )
}

function hasSystemRipgrep(): boolean {
  // Probe via `which rg` / `where rg`. We don't trust the returned
  // path (PATH-hijack risk) — we just want to know if SOME rg is
  // on PATH. When found, we'll spawn `"rg"` and let the OS resolve
  // it again with its own safety guarantees.
  try {
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = execFileSync(cmd, ["rg"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    })
    return out.length > 0
  } catch {
    return false
  }
}

// ============================================================
// Input validation
// ============================================================

function validateInputs(input: CodeSearchInput): string | null {
  if (typeof input.query !== "string" || input.query.length === 0) {
    return "code_search: arguments.query is required (non-empty string)"
  }
  if (input.query.length > MAX_QUERY_LEN) {
    return `code_search: query exceeds ${MAX_QUERY_LEN} chars`
  }
  if (/[\0\r\n]/.test(input.query)) {
    return "code_search: query contains null byte or newline (rejected)"
  }
  if (typeof input.workspace !== "string" || input.workspace.length === 0) {
    return "code_search: arguments.workspace is required (absolute path)"
  }
  if (input.mode && !["ranked", "literal", "regex"].includes(input.mode)) {
    return `code_search: mode must be one of "ranked", "literal", "regex"`
  }
  if (input.file_glob !== undefined) {
    if (typeof input.file_glob !== "string") {
      return "code_search: file_glob must be a string"
    }
    if (input.file_glob.length > MAX_GLOB_LEN) {
      return `code_search: file_glob exceeds ${MAX_GLOB_LEN} chars`
    }
    if (/[\0\r\n]/.test(input.file_glob)) {
      return "code_search: file_glob contains null byte or newline"
    }
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1) {
      return "code_search: limit must be a positive integer"
    }
  }
  if (input.context_lines !== undefined) {
    if (
      typeof input.context_lines !== "number" ||
      !Number.isInteger(input.context_lines) ||
      input.context_lines < 0
    ) {
      return "code_search: context_lines must be a non-negative integer"
    }
  }
  return null
}

// ============================================================
// Workspace validation
// ============================================================

interface ValidationResult {
  ok: boolean
  canonical?: string
  error?: string
}

/**
 * Validate a `workspace` arg. The proxy runs as the user; any path
 * the proxy process can `stat` is a legal workspace — mirrors what
 * Claude Code's Read / Bash tools could already reach. Earlier the
 * validator enforced an allow-set + secret-shape file denylist; the
 * holistic threat model showed those were inconsistent guardrails
 * (the model already has filesystem access via its other tools), so
 * they're dropped.
 *
 * Still enforced:
 *   - Absolute path (relative paths are an integration-error footgun).
 *   - realpath canonicalization (resolves symlinks; output paths are
 *     reported relative to this).
 *   - Path must exist AND be a directory.
 *
 * Errors do NOT echo the rejected path (output of code_search flows
 * upstream to the model provider; consistent with the
 * COPILOT_HOST_ALLOWLIST pattern in `src/lib/utils.ts`).
 */
export function validateWorkspace(workspace: string): ValidationResult {
  if (!path.isAbsolute(workspace)) {
    return { ok: false, error: "workspace must be an absolute path" }
  }

  let canonical: string
  try {
    canonical = realpathSync(workspace)
  } catch {
    return { ok: false, error: "workspace path is not accessible" }
  }

  try {
    if (!statSync(canonical).isDirectory()) {
      return { ok: false, error: "workspace must be a directory" }
    }
  } catch {
    return { ok: false, error: "workspace path is not accessible" }
  }

  return { ok: true, canonical }
}

// ============================================================
// Tokenization (Vasilescu, Ray, Mockus ESEC/FSE 2021 — rule-based)
// ============================================================

/**
 * Rule-based identifier splitter per the ESEC/FSE 2021 benchmark.
 *
 *   1. Split on non-word characters.
 *   2. Within each chunk, split on case boundaries with acronym
 *      lookahead — `HTTPSConnection` → [`HTTPS`, `Connection`].
 *   3. Attach trailing digit runs to letters — `parseV2Handler` →
 *      [`parse`, `V2`, `Handler`] (NOT `[parse, V, 2, Handler]`).
 *   4. Lowercase all tokens.
 *   5. Drop tokens of length < 2 to suppress single-char noise.
 *
 * Limitation: ASCII identifiers only. Unicode identifiers (Cyrillic,
 * CJK, etc.) won't be tokenized. Documented as MVP scope.
 */
export function tokenize(text: string): Array<string> {
  const out: Array<string> = []
  const pieces = text.split(/[^A-Za-z0-9]+/)
  const re = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g
  for (const piece of pieces) {
    if (!piece) continue
    const matches = piece.match(re)
    if (!matches) continue
    for (const m of matches) {
      const lc = m.toLowerCase()
      if (lc.length >= 2) out.push(lc)
    }
  }
  return out
}

// ============================================================
// Process management
// ============================================================

/**
 * Platform-aware child termination. On Unix: SIGTERM, then SIGKILL
 * after a brief grace period. On Windows: taskkill /T /F because
 * child.kill() doesn't reliably terminate descendants — a long
 * search with worker threads would leak rg.exe processes.
 */
function killChild(child: ChildProcess): void {
  if (!child.pid || child.killed) return

  if (process.platform === "win32") {
    // /T = kill tree (including children of children)
    // /F = force; rg has no graceful-shutdown signal handler on Win.
    try {
      execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {
        // Errors are swallowed: the process may already have exited,
        // and we don't have anywhere meaningful to surface this to.
      })
    } catch {
      // Best effort.
    }
    return
  }

  try {
    child.kill("SIGTERM")
  } catch {
    // already dead
  }
  // Hard kill after 500 ms if it didn't go quietly.
  setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill("SIGKILL")
      } catch {
        // already dead
      }
    }
  }, 500).unref()
}

// ============================================================
// Identifier skeleton-form query expansion
// ============================================================

/**
 * Single-identifier query matcher. We only expand queries that look
 * like a single identifier — any whitespace, regex metacharacters, or
 * structural punctuation defeats the expansion and we fall through to
 * the original rg behavior. ASCII-only on purpose (matches the
 * tokenizer's scope; Unicode identifiers are MVP-out).
 */
const SINGLE_IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/

/**
 * Split an identifier into its constituent word-pieces, recognizing
 *
 *   - snake_case   (split on `_`)
 *   - kebab-case   (split on `-`)
 *   - camelCase    (split on lowercase→uppercase boundaries)
 *   - PascalCase   (each capitalized run is a piece)
 *   - acronym runs (HTTPSConnection → [HTTPS, Connection])
 *   - trailing digits attached to letters (parseV2 → [parse, V2])
 *
 * Pieces are returned in source-order, with the original case
 * preserved per piece — re-skeletons compose by re-casing each piece.
 */
function splitIdentifierPieces(identifier: string): Array<string> {
  const pieces: Array<string> = []
  for (const chunk of identifier.split(/[-_]/)) {
    if (!chunk) continue
    // Acronym-aware case-boundary split. Same regex as the BM25F
    // tokenizer, minus the lowercasing — we want original-case
    // pieces so we can re-cast them per skeleton.
    const matches = chunk.match(
      /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g,
    )
    if (matches) pieces.push(...matches)
  }
  return pieces
}

/**
 * Produce skeleton variants for an identifier query. Returns `null`
 * when the query is not a single identifier or has only one piece
 * (no skeleton structure to vary across) — caller falls through to
 * the literal-search path.
 *
 * The variant set covers the five conventions any real codebase
 * mixes:
 *
 *   getUserName       (lowerCamelCase)
 *   GetUserName       (UpperCamelCase / PascalCase)
 *   get_user_name     (snake_case)
 *   get-user-name     (kebab-case)
 *   GET_USER_NAME     (UPPER_SNAKE_CASE)
 *
 * The set is deduplicated so identifiers that collapse skeletons
 * (e.g., single-word queries) don't bloat the regex pointlessly.
 */
function expandIdentifierVariants(query: string): Array<string> | null {
  if (!SINGLE_IDENTIFIER_REGEX.test(query)) return null
  const pieces = splitIdentifierPieces(query)
  if (pieces.length < 2) return null
  const lower = pieces.map((p) => p.toLowerCase())
  const upper = pieces.map((p) => p.toUpperCase())
  const cap = lower.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  const variants = new Set<string>()
  variants.add(query)
  variants.add(lower[0] + cap.slice(1).join("")) // camelCase
  variants.add(cap.join("")) // PascalCase
  variants.add(lower.join("_")) // snake_case
  variants.add(lower.join("-")) // kebab-case
  variants.add(upper.join("_")) // UPPER_SNAKE_CASE
  return Array.from(variants)
}

/**
 * Build the rg regex pattern for a set of skeleton variants. The
 * variants are already plain identifiers (no regex metacharacters),
 * so simple alternation suffices. Word boundaries are intentionally
 * NOT applied — the user's mental model for "search for getUserName"
 * is substring-anywhere, which is also what `-F getUserName` did.
 */
function buildExpansionPattern(variants: ReadonlyArray<string>): string {
  return "(?:" + variants.join("|") + ")"
}

function buildRgArgs(input: {
  mode: "ranked" | "literal" | "regex"
  fileGlob?: string
  contextLines: number
  query: string
  /**
   * When set, the caller has expanded the original query into a
   * regex alternation across skeleton-form variants. We override
   * `-F` (literal) regardless of the user's chosen mode and pass
   * the alternation as a ripgrep regex pattern. The original-mode
   * literal semantics are preserved because the variants are plain
   * identifiers (no regex metacharacters).
   */
  expansionPattern?: string
}): Array<string> {
  const args: Array<string> = ["--json", "--no-follow"]

  // -C N means N lines BEFORE and N AFTER. We always want context
  // for snippet rendering AND for the BM25F context field.
  if (input.contextLines > 0) {
    args.push(`-C`, String(input.contextLines))
  }

  // Literal mode → -F. Ranked mode uses literal too (we want
  // exact-string semantics for the user's query; BM25F handles
  // tokenized matching at scoring time, not at rg time). Regex
  // mode uses ripgrep's default (PCRE2-via-builtin).
  //
  // EXCEPTION: when the caller passed `expansionPattern`, we drop
  // `-F` and feed the alternation as a regex. Skeleton expansion is
  // mutually exclusive with literal-mode semantics — but the
  // variants are still plain identifiers, so it remains
  // identifier-substring matching (the user's intent).
  if (!input.expansionPattern && (input.mode === "literal" || input.mode === "ranked")) {
    args.push("-F")
  }

  if (input.fileGlob && input.fileGlob !== "**/*") {
    args.push("-g", input.fileGlob)
  }

  // CVE fix HIGH-2: positional separator. Without `--`, a query
  // starting with `-` (e.g. `--no-ignore`) would be parsed as a
  // ripgrep flag.
  args.push("--", input.expansionPattern ?? input.query, ".")

  return args
}

// ============================================================
// JSON streaming parser
// ============================================================

interface RgEvent {
  type: string
  data: {
    path?: { text: string }
    lines?: { text: string }
    line_number?: number
    submatches?: Array<{
      match: { text: string }
      start: number
      end: number
    }>
    stats?: { searches?: number }
  }
}

interface ParseResult {
  hits: Array<RawHit>
  scannedFiles: number
  truncated: boolean
  cancelled: boolean
  stdoutBytes: number
}

/**
 * Stream-parse ripgrep --json output. Two load-bearing behaviors:
 *
 *   1. GLOBAL limit cap (NOT per-file — MEDIUM-10). Once we've
 *      accumulated `limit` hits, send SIGTERM and stop emitting.
 *
 *   2. CANCEL RACE short-circuit (HIGH-9, 3-lab confirmed). The
 *      moment `signal.aborted` flips, detach the line listener AND
 *      return early. A half-flushed truncated JSON line never
 *      reaches JSON.parse — that's the bug we're guarding against.
 */
async function parseRgJsonStream(
  child: ChildProcess,
  opts: { limit: number; contextLines: number; signal: AbortSignal },
): Promise<ParseResult> {
  const hits: Array<RawHit> = []
  let stdoutBytes = 0
  let truncatedByCap = false
  let cancelled = false
  let scannedFiles = 0

  // Pre-aborted: short-circuit before constructing the reader. Calling
  // rl.close() before the async iterator starts can hang on some
  // platforms (observed on Bun); avoid the readline construction
  // entirely.
  if (opts.signal.aborted) {
    killChild(child)
    return {
      hits,
      scannedFiles: 0,
      truncated: false,
      cancelled: true,
      stdoutBytes: 0,
    }
  }

  // Per-file accumulator: rg streams begin → context*before → match
  // → context*after → end. We buffer context_before lines per file
  // so we can attach them to the next match in that file.
  const pendingContextBefore: Array<string> = []
  let lastHitForContext: RawHit | undefined

  if (!child.stdout) {
    return { hits, scannedFiles: 0, truncated: false, cancelled: false, stdoutBytes: 0 }
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

  // Wire abort: on signal, immediately tear down the reader and
  // kill the child. The early `cancelled = true` flag stops the
  // line handler from attempting JSON.parse on partial chunks.
  const onAbort = (): void => {
    cancelled = true
    rl.close()
    killChild(child)
  }
  opts.signal.addEventListener("abort", onAbort, { once: true })

  try {
    for await (const rawLine of rl) {
      if (cancelled) break
      stdoutBytes += rawLine.length + 1 // +1 for the elided \n
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        truncatedByCap = true
        killChild(child)
        break
      }
      if (rawLine.length === 0) continue

      let evt: RgEvent
      try {
        evt = JSON.parse(rawLine) as RgEvent
      } catch {
        // Skip malformed lines rather than failing the whole call.
        // A truncated chunk at process death would also land here;
        // the cancelled flag check above handles the common case.
        continue
      }

      switch (evt.type) {
        case "begin": {
          scannedFiles += 1
          pendingContextBefore.length = 0
          lastHitForContext = undefined
          break
        }
        case "context": {
          const text = stripTrailingNewline(evt.data.lines?.text ?? "")
          if (lastHitForContext && lastHitForContext.context_after.length < opts.contextLines) {
            lastHitForContext.context_after.push(text)
          } else {
            pendingContextBefore.push(text)
            if (pendingContextBefore.length > opts.contextLines) {
              pendingContextBefore.shift()
            }
          }
          break
        }
        case "match": {
          if (hits.length >= opts.limit) {
            // Global limit reached. Kill child and stop reading.
            killChild(child)
            break
          }
          const sub = evt.data.submatches?.[0]
          if (!evt.data.path || !evt.data.lines || !evt.data.line_number || !sub) {
            break
          }
          const hit: RawHit = {
            file: evt.data.path.text,
            line: evt.data.line_number,
            matched_line: stripTrailingNewline(evt.data.lines.text),
            match_start: sub.start,
            match_end: sub.end,
            context_before: [...pendingContextBefore],
            context_after: [],
          }
          pendingContextBefore.length = 0
          lastHitForContext = hit
          hits.push(hit)
          break
        }
        case "end":
        case "summary":
        default:
          // Nothing actionable. The "summary" event arrives after
          // the entire stream; "end" arrives per-file. Both are
          // informational here.
          break
      }
    }
  } finally {
    opts.signal.removeEventListener("abort", onAbort)
  }

  return {
    hits,
    scannedFiles,
    truncated: truncatedByCap || hits.length >= opts.limit,
    cancelled,
    stdoutBytes,
  }
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2)
  if (s.endsWith("\n")) return s.slice(0, -1)
  return s
}

// ============================================================
// Tree-sitter structural ranking
// ============================================================

/**
 * Extension → grammar key. Grammars not in this map skip structural
 * parsing (the hit falls back to the regex SYMBOL_REGEX heuristic for
 * `symbol_context`). Keep this list aligned with `GRAMMAR_FILES`
 * below — adding a language requires both an extension mapping and a
 * `.wasm` to load.
 */
const EXTENSION_TO_LANG: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
}

/**
 * Grammar key → wasm filename under `node_modules/tree-sitter-wasms/out/`.
 * Resolved at runtime from `node_modules`; the file paths are stable
 * because `tree-sitter-wasms` ships prebuilt binaries (no per-install
 * codegen).
 */
const GRAMMAR_FILES: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
}

/**
 * Per-language definition-shape node types. When a matched identifier
 * sits inside one of these nodes AND is at the node's "name" position,
 * we have AST-confirmed evidence the line is an identifier-definition
 * site. The brief's enumeration plus a handful of language-idiomatic
 * extras (e.g., `lexical_declaration` for TS/JS top-level `const`s,
 * `mod_item` for Rust modules).
 *
 * The set lookup is per-language so a node type that means
 * "definition" in one language but "reference" in another won't
 * cross-pollute.
 */
const DEFINITION_NODE_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  typescript: new Set([
    "function_declaration",
    "function_signature",
    "function_expression",
    "method_definition",
    "method_signature",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "variable_declarator",
    "generator_function_declaration",
    "abstract_method_signature",
    "public_field_definition",
    "property_signature",
  ]),
  tsx: new Set([
    "function_declaration",
    "function_signature",
    "function_expression",
    "method_definition",
    "method_signature",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "variable_declarator",
    "generator_function_declaration",
    "abstract_method_signature",
    "public_field_definition",
    "property_signature",
  ]),
  javascript: new Set([
    "function_declaration",
    "function_expression",
    "method_definition",
    "class_declaration",
    "variable_declarator",
    "generator_function_declaration",
  ]),
  python: new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
  ]),
  go: new Set([
    "function_declaration",
    "method_declaration",
    "type_spec",
    "type_alias",
    "const_spec",
    "var_spec",
  ]),
  rust: new Set([
    "function_item",
    "impl_item",
    "trait_item",
    "struct_item",
    "enum_item",
    "mod_item",
    "type_item",
    "const_item",
    "static_item",
    "macro_definition",
  ]),
  java: new Set([
    "class_declaration",
    "interface_declaration",
    "method_declaration",
    "constructor_declaration",
    "enum_declaration",
    "field_declaration",
    "annotation_type_declaration",
  ]),
  c: new Set([
    "function_definition",
    "declaration",
    "struct_specifier",
    "enum_specifier",
    "union_specifier",
    "type_definition",
  ]),
  cpp: new Set([
    "function_definition",
    "declaration",
    "struct_specifier",
    "class_specifier",
    "enum_specifier",
    "union_specifier",
    "type_definition",
    "namespace_definition",
    "template_declaration",
  ]),
}

/**
 * Node types that the AST exposes as "this token is an identifier".
 * The match-position lookup uses these to filter out parent-node hits
 * before checking the definition-site predicate.
 */
const IDENTIFIER_NODE_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier_pattern",
  "shorthand_property_identifier",
  "scoped_identifier",
  "name",
])

interface GrammarBundle {
  /** Lazy promise of the language registry. Awaited per-call so the
   *  init cost overlaps with any other module-load work. */
  ready: Promise<Map<string, Parser.Language>>
}

let _grammarBundle: GrammarBundle | undefined

/**
 * Resolve the `tree-sitter-wasms/out/` directory at the package root.
 * `require.resolve` is used through a try/catch — the bundled-only
 * fallback runs in environments where node_modules has been pruned to
 * just runtime deps.
 */
function resolveGrammarRoot(): string | null {
  try {
    const pkgPath = require.resolve("tree-sitter-wasms/package.json")
    return path.join(path.dirname(pkgPath), "out")
  } catch {
    return null
  }
}

/**
 * Pre-load all grammars at module-init time so the first search
 * doesn't pay a ~500ms cold-start cost. The Promise is captured at
 * import time and awaited per-call; per-grammar failures are caught
 * individually so one broken grammar can't take the whole tool down.
 */
function getGrammarBundle(): GrammarBundle {
  if (_grammarBundle) return _grammarBundle
  const ready = (async (): Promise<Map<string, Parser.Language>> => {
    const out = new Map<string, Parser.Language>()
    try {
      await Parser.init()
    } catch (err) {
      consola.warn(
        `[code_search] tree-sitter Parser.init failed; structural ranking disabled: ${(err as Error).message}`,
      )
      return out
    }
    const root = resolveGrammarRoot()
    if (!root) {
      consola.warn(
        "[code_search] tree-sitter-wasms package not resolvable; structural ranking disabled",
      )
      return out
    }
    for (const [key, filename] of Object.entries(GRAMMAR_FILES)) {
      const wasmPath = path.join(root, filename)
      try {
        const lang = await Parser.Language.load(wasmPath)
        out.set(key, lang)
      } catch (err) {
        consola.warn(
          `[code_search] failed to load tree-sitter grammar '${key}' from ${filename}: ${(err as Error).message}`,
        )
      }
    }
    return out
  })()
  _grammarBundle = { ready }
  return _grammarBundle
}

// Kick off grammar pre-load at module import time. The brief calls
// this out explicitly: amortize the WASM init cost across module load
// rather than the first search call.
void getGrammarBundle().ready.catch(() => {
  /* errors already logged per-grammar */
})

function getLanguageKeyForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TO_LANG[ext] ?? null
}

/**
 * Tree cache. Keyed by canonical file path with mtime gate — on
 * mtime change the cache entry is invalidated (and the old Tree's
 * native memory is freed via `.delete()`). LRU eviction at
 * STRUCTURAL_CACHE_MAX entries; null trees indicate prior failure
 * and short-circuit re-parsing for the same mtime.
 */
interface CachedTree {
  mtimeMs: number
  /** null = tried, parse failed (or unsupported language). */
  tree: Parser.Tree | null
  /** Source bytes — we need them at structural-walk time to compute
   *  byte offsets from line numbers. Kept alongside the tree so the
   *  next call on the same (file, mtime) doesn't re-read. */
  source: string | null
}

const _treeCache = new Map<string, CachedTree>()

function cacheGet(absPath: string, mtimeMs: number): CachedTree | undefined {
  const cur = _treeCache.get(absPath)
  if (!cur) return undefined
  if (cur.mtimeMs !== mtimeMs) {
    // File changed since cache entry — discard.
    if (cur.tree) {
      try {
        cur.tree.delete()
      } catch {
        // Tree already collected
      }
    }
    _treeCache.delete(absPath)
    return undefined
  }
  // Touch for LRU ordering.
  _treeCache.delete(absPath)
  _treeCache.set(absPath, cur)
  return cur
}

function cachePut(absPath: string, entry: CachedTree): void {
  // Evict oldest if at cap. Map iteration order is insertion order
  // (and we re-insert on access in cacheGet), so the first key is
  // the oldest.
  while (_treeCache.size >= STRUCTURAL_CACHE_MAX) {
    const firstKey = _treeCache.keys().next().value
    if (firstKey === undefined) break
    const evicted = _treeCache.get(firstKey)
    if (evicted?.tree) {
      try {
        evicted.tree.delete()
      } catch {
        // Best effort
      }
    }
    _treeCache.delete(firstKey)
  }
  _treeCache.set(absPath, entry)
}

/**
 * Compute the absolute byte offset where line `lineNumber1` starts
 * in `source`. Lines are counted by LF; CRLF files have the same
 * line starts as LF files (the \r is part of the previous line's
 * content, not the line break). `lineNumber1` is 1-indexed to match
 * ripgrep's output. Returns -1 if the line is past EOF.
 */
function lineStartByte(source: string, lineNumber1: number): number {
  if (lineNumber1 <= 1) return 0
  let line = 1
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a /* \n */) {
      line += 1
      if (line === lineNumber1) return i + 1
    }
  }
  return -1
}

/**
 * Walk up from a matched identifier node looking for the closest
 * definition-shape ancestor (per the language's allowed types). When
 * we find one, verify the matched identifier is at the definition's
 * "name" slot — NOT inside a parameter type, a body, or a parent's
 * signature. Returns true iff this is a real definition site for
 * the identifier the rg submatch landed on.
 *
 * The walk has a small depth bound (6) — definition names sit very
 * close to their definition node in every supported grammar; deeper
 * walks risk false positives (e.g., matching `name` inside the body
 * of an enclosing function and concluding "yes, definition").
 */
function isDefiningSite(
  matchedNode: Parser.SyntaxNode,
  langKey: string,
): boolean {
  const defTypes = DEFINITION_NODE_TYPES[langKey]
  if (!defTypes) return false
  let cur: Parser.SyntaxNode | null = matchedNode.parent
  let depth = 0
  while (cur && depth < 6) {
    if (defTypes.has(cur.type)) {
      // Try the language's standard "name" field first. Almost all
      // grammars expose this for class/method/function/variable
      // declarations.
      const nameField = cur.childForFieldName("name")
      if (nameField && containsByteRange(nameField, matchedNode)) {
        return true
      }
      // C / C++ function_definition: name lives inside the
      // `declarator` field, possibly nested through pointer or
      // reference declarators. Same trick works for Java
      // field_declaration's `declarator` field.
      const declarator = cur.childForFieldName("declarator")
      if (declarator && containsByteRange(declarator, matchedNode)) {
        // The matched identifier is somewhere in the declarator
        // subtree. Confirm it's the first identifier-leaf — that
        // disambiguates `int foo(int bar)`'s `foo` (definition) from
        // its `bar` (parameter, also inside declarator).
        const first = firstIdentifierLeaf(declarator)
        if (first && first.startIndex === matchedNode.startIndex) {
          return true
        }
      }
      // Rust `impl_item` and Go `type_spec`: the identifier is in
      // the `type` field rather than `name`.
      const typeField = cur.childForFieldName("type")
      if (typeField && containsByteRange(typeField, matchedNode)) {
        const first = firstIdentifierLeaf(typeField)
        if (first && first.startIndex === matchedNode.startIndex) {
          return true
        }
      }
    }
    cur = cur.parent
    depth += 1
  }
  return false
}

function containsByteRange(
  outer: Parser.SyntaxNode,
  inner: Parser.SyntaxNode,
): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex
}

function firstIdentifierLeaf(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  if (IDENTIFIER_NODE_TYPES.has(node.type)) return node
  for (const child of node.namedChildren) {
    const r = firstIdentifierLeaf(child)
    if (r) return r
  }
  return null
}

interface StructuralPassResult {
  /** Indexes (into the input hits array) where AST confirmed the
   *  matched identifier is at a definition site. */
  confirmedHitIndexes: Set<number>
  /** null = success (entire top-N parsed within budget). String =
   *  budget exceeded mid-pass, with explanation suitable for surfacing
   *  to the model as the `notice` field (overridden by size-cap notice
   *  at the handler boundary when both fire). */
  fallback: string | null
}

/**
 * Run the structural-confirmation pass over the top-N already-ranked
 * BM25F hits. Wall-clock-bounded — checked between files, not mid-
 * parse (web-tree-sitter@0.22 doesn't expose a usable cancel hook).
 *
 * Per-file failure modes (file too big, language unsupported, parse
 * error, I/O error) are silent: the file's hits keep the regex
 * `symbol_context` heuristic. Only the wall-clock budget fires the
 * user-visible `fallback` message.
 */
async function runStructuralPass(opts: {
  hitsRanked: Array<{ hit: RawHit; index: number }>
  workspaceRoot: string
  topN: number
  budgetMs: number
  signal: AbortSignal
}): Promise<StructuralPassResult> {
  const result: StructuralPassResult = {
    confirmedHitIndexes: new Set(),
    fallback: null,
  }
  if (opts.hitsRanked.length === 0) return result

  if (opts.signal.aborted) return result

  const grammars = await getGrammarBundle().ready
  if (grammars.size === 0) {
    // No grammars loaded — log already done in getGrammarBundle.
    // Don't surface as user-facing fallback; this is a setup-side
    // failure, not a per-search budget overrun.
    return result
  }

  // Group hits by file so we parse each file once across all its
  // hits within the top-N slice.
  const cap = Math.min(opts.hitsRanked.length, opts.topN)
  const byFile = new Map<string, Array<{ hit: RawHit; index: number }>>()
  for (let i = 0; i < cap; i++) {
    const entry = opts.hitsRanked[i]
    const list = byFile.get(entry.hit.file) ?? []
    list.push(entry)
    byFile.set(entry.hit.file, list)
  }

  const t0 = Date.now()
  let filesParsed = 0
  let parsersUsed = new Map<string, Parser>()

  try {
    for (const [relFile, entries] of byFile) {
      if (opts.signal.aborted) break
      const elapsed = Date.now() - t0
      if (elapsed >= opts.budgetMs) {
        result.fallback =
          `structural budget exceeded after parsing ${filesParsed}/${cap} hits; ` +
          `retry with structural: "topN" or narrow your query`
        break
      }

      const langKey = getLanguageKeyForPath(relFile)
      if (!langKey) continue // unsupported extension — silent skip
      const lang = grammars.get(langKey)
      if (!lang) continue // grammar failed to load — silent skip

      const absPath = path.join(opts.workspaceRoot, relFile)
      let mtimeMs: number
      let size: number
      try {
        const st = statSync(absPath)
        mtimeMs = st.mtimeMs
        size = st.size
      } catch (err) {
        consola.debug(
          `[code_search] structural skip ${relFile} (stat failed: ${(err as Error).message})`,
        )
        continue
      }
      if (size > STRUCTURAL_MAX_FILE_BYTES) {
        consola.debug(
          `[code_search] structural skip ${relFile} (${size} bytes > cap)`,
        )
        continue
      }

      let cached = cacheGet(absPath, mtimeMs)
      if (!cached) {
        let source: string
        try {
          source = readFileSync(absPath, "utf8")
        } catch (err) {
          consola.debug(
            `[code_search] structural skip ${relFile} (read failed: ${(err as Error).message})`,
          )
          cachePut(absPath, { mtimeMs, tree: null, source: null })
          continue
        }
        let parser = parsersUsed.get(langKey)
        if (!parser) {
          parser = new Parser()
          parser.setLanguage(lang)
          parsersUsed.set(langKey, parser)
        }
        let tree: Parser.Tree | null = null
        try {
          tree = parser.parse(source)
        } catch (err) {
          consola.debug(
            `[code_search] tree-sitter parse failed for ${relFile}: ${(err as Error).message}`,
          )
        }
        cached = { mtimeMs, tree, source: tree ? source : null }
        cachePut(absPath, cached)
        filesParsed += 1
      }

      if (!cached.tree || !cached.source) continue

      // Walk every hit's matched identifier in this file.
      for (const entry of entries) {
        const lineStart = lineStartByte(cached.source, entry.hit.line)
        if (lineStart < 0) continue
        const matchByteStart = lineStart + entry.hit.match_start
        const matchByteEnd = lineStart + entry.hit.match_end
        let node: Parser.SyntaxNode | null
        try {
          node = cached.tree.rootNode.descendantForIndex(
            matchByteStart,
            matchByteEnd,
          )
        } catch {
          node = null
        }
        if (!node) continue
        // Climb to the nearest identifier-typed node, since
        // descendantForIndex may land on a parent for off-by-one
        // byte ranges in CRLF files.
        if (!IDENTIFIER_NODE_TYPES.has(node.type)) {
          let cur: Parser.SyntaxNode | null = node
          let depth = 0
          while (cur && !IDENTIFIER_NODE_TYPES.has(cur.type) && depth < 3) {
            // Try descending to an identifier leaf at the match
            // start before climbing — handles the case where the
            // grammar wraps the identifier in e.g. shorthand_*
            // patterns.
            const leaf = firstIdentifierLeaf(cur)
            if (leaf && leaf.startIndex === matchByteStart) {
              cur = leaf
              break
            }
            cur = cur.parent
            depth += 1
          }
          node = cur
        }
        if (!node || !IDENTIFIER_NODE_TYPES.has(node.type)) continue
        if (isDefiningSite(node, langKey)) {
          result.confirmedHitIndexes.add(entry.index)
        }
      }
    }
  } finally {
    // Tree-sitter Parser instances are reusable and we don't hold
    // them across calls; freeing keeps native memory clean.
    for (const parser of parsersUsed.values()) {
      try {
        parser.delete()
      } catch {
        // Best effort
      }
    }
    parsersUsed = new Map()
  }

  return result
}

interface FieldTexts {
  match_line: string
  context: string
  file_path: string
  symbol_context: string
}

function extractFields(hit: RawHit, astConfirmed: boolean): FieldTexts {
  const ctx = [...hit.context_before, ...hit.context_after].join("\n")
  let symbolContext: string
  if (astConfirmed) {
    // Tree-sitter confirmed: this is a real identifier-definition
    // site. Populate `symbol_context` with the matched identifier
    // text so the BM25F field-weight (2.5x) fires for this hit even
    // when the regex heuristic would have left the field empty —
    // the live correctness fix described in the brief.
    const ident = hit.matched_line.slice(hit.match_start, hit.match_end)
    // Guard: rg submatch offsets can be empty / out-of-range for
    // multiline matches — fall back to the matched line so we still
    // get a non-empty field.
    symbolContext = ident.length > 0 ? ident : hit.matched_line
  } else if (SYMBOL_REGEX.test(hit.matched_line.trimStart())) {
    // Regex heuristic remains in place for hits the AST hasn't
    // confirmed (top-N spillover, unsupported language, parse
    // error, budget overrun). Same field shape as v1.
    symbolContext = hit.matched_line
  } else {
    symbolContext = ""
  }
  return {
    match_line: hit.matched_line,
    context: ctx,
    file_path: hit.file.replace(/[/\\]/g, " "),
    symbol_context: symbolContext,
  }
}

interface ScoredHit {
  hit: RawHit
  score: number
  field_contributions: Record<string, number>
}

/**
 * BM25F score for the given hit set against the tokenized query.
 *
 *   BM25F(q, f) = Σ_t  IDF(t) · w_t,f / (w_t,f + k1)
 *
 *   w_t,f = Σ_field  b_field · tf_t,field,f /
 *                    ((1 − l_field) + l_field · len_field,f/avglen_field)
 *
 *   IDF(t) = log( (M − df(t) + 0.5) / (df(t) + 0.5) )
 *
 * Corpus stats are derived from the rg hit set itself — we have no
 * persistent index. M = number of files in the hit set; df(t) = how
 * many of those files contain token `t` in any field; avglen_f =
 * mean tokenized length of field `f` across those files. This is
 * the "compute corpus stats per-call" pattern, which works because
 * M ≤ a few hundred files in practice (sub-second).
 */
function bm25fScore(
  hits: ReadonlyArray<RawHit>,
  queryTokens: ReadonlyArray<string>,
  /**
   * Indexes (into `hits`) for which tree-sitter has confirmed the
   * matched identifier sits at a real definition site. Drives the
   * `extractFields` symbol_context override. Pass `undefined` (or an
   * empty Set) to score with the regex heuristic only — matches the
   * v1 behavior, used as the first pass before structural ranking
   * runs.
   */
  astConfirmedHits?: ReadonlySet<number>,
): Array<ScoredHit> {
  if (hits.length === 0 || queryTokens.length === 0) {
    return hits.map((h) => ({
      hit: h,
      score: 0,
      field_contributions: {
        match_line: 0,
        symbol_context: 0,
        file_path: 0,
        context: 0,
      },
    }))
  }

  // Per-file tokenization (cache by file path to avoid re-tokenizing
  // the same path across multiple hits in one file).
  const fileTokenCache = new Map<string, FieldTexts>()
  const perHitTokens: Array<Record<keyof FieldTexts, Array<string>>> = []
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const confirmed = astConfirmedHits?.has(i) ?? false
    const fields = extractFields(hit, confirmed)
    fileTokenCache.set(hit.file, fields)
    perHitTokens.push({
      match_line: tokenize(fields.match_line),
      context: tokenize(fields.context),
      file_path: tokenize(fields.file_path),
      symbol_context: tokenize(fields.symbol_context),
    })
  }

  // Distinct files for IDF.
  const filesSeen = new Set<string>()
  for (const hit of hits) filesSeen.add(hit.file)
  const M = filesSeen.size

  // df(t) per query token: number of distinct files where ANY field
  // contains t. We compute over the hit set; this is the per-call
  // corpus.
  const df = new Map<string, number>()
  const fileTokensByField: Record<keyof FieldTexts, Map<string, Set<string>>> = {
    match_line: new Map(),
    context: new Map(),
    file_path: new Map(),
    symbol_context: new Map(),
  }
  // First pass: build file → token-set per field, so df is per-file
  // not per-hit (multiple hits in one file shouldn't inflate df).
  for (let i = 0; i < hits.length; i++) {
    const file = hits[i].file
    const t = perHitTokens[i]
    for (const fname of Object.keys(t) as Array<keyof FieldTexts>) {
      let bucket = fileTokensByField[fname].get(file)
      if (!bucket) {
        bucket = new Set()
        fileTokensByField[fname].set(file, bucket)
      }
      for (const tok of t[fname]) bucket.add(tok)
    }
  }
  // Now compute df: count files containing the query token in any field.
  for (const qt of queryTokens) {
    const files = new Set<string>()
    for (const fname of Object.keys(fileTokensByField) as Array<keyof FieldTexts>) {
      for (const [file, tokSet] of fileTokensByField[fname]) {
        if (tokSet.has(qt)) files.add(file)
      }
    }
    df.set(qt, files.size)
  }

  // avglen per field — across files (one length per file, average them).
  const avglen: Record<keyof FieldTexts, number> = {
    match_line: 0,
    context: 0,
    file_path: 0,
    symbol_context: 0,
  }
  for (const fname of Object.keys(avglen) as Array<keyof FieldTexts>) {
    const lens: Array<number> = []
    const seen = new Set<string>()
    for (let i = 0; i < hits.length; i++) {
      if (seen.has(hits[i].file)) continue
      seen.add(hits[i].file)
      lens.push(perHitTokens[i][fname].length)
    }
    avglen[fname] = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 1
    if (avglen[fname] === 0) avglen[fname] = 1
  }

  // IDF per query token.
  const idf = new Map<string, number>()
  for (const qt of queryTokens) {
    const d = df.get(qt) ?? 0
    idf.set(qt, Math.log((M - d + 0.5) / (d + 0.5) + 1)) // +1 keeps IDF positive (Lucene convention)
  }

  // Score each hit.
  const out: Array<ScoredHit> = []
  for (let i = 0; i < hits.length; i++) {
    const tokens = perHitTokens[i]
    const contributions: Record<string, number> = {
      match_line: 0,
      symbol_context: 0,
      file_path: 0,
      context: 0,
    }
    for (const qt of queryTokens) {
      // Weighted TF across fields (the BM25F inner sum).
      let w = 0
      const perField: Record<string, number> = {
        match_line: 0,
        symbol_context: 0,
        file_path: 0,
        context: 0,
      }
      for (const fname of Object.keys(FIELD_BOOSTS) as Array<keyof FieldTexts>) {
        const tf = tokens[fname].filter((t) => t === qt).length
        if (tf === 0) continue
        const len = tokens[fname].length || 1
        const l = FIELD_LEN_NORMS[fname]
        const norm = 1 - l + l * (len / (avglen[fname] || 1))
        const fieldContrib = FIELD_BOOSTS[fname] * (tf / norm)
        w += fieldContrib
        perField[fname] = fieldContrib
      }
      if (w === 0) continue
      const termScore = (idf.get(qt) ?? 0) * (w / (w + BM25F_K1))
      // Attribute the term's contribution back to fields
      // proportionally to each field's share of w.
      for (const fname of Object.keys(perField)) {
        const share = perField[fname] / w
        contributions[fname] += termScore * share
      }
    }
    const total = Object.values(contributions).reduce((a, b) => a + b, 0)
    out.push({ hit: hits[i], score: total, field_contributions: contributions })
  }

  return out
}

// ============================================================
// Shoulder pruning
// ============================================================

interface PrunedResult {
  kept: Array<ScoredHit>
  prunedBelowShoulder: number
}

function shoulderPrune(scored: Array<ScoredHit>): PrunedResult {
  if (scored.length === 0) return { kept: [], prunedBelowShoulder: 0 }
  // Sort by score desc, then by (file, line) for determinism.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.hit.file !== b.hit.file) return a.hit.file < b.hit.file ? -1 : 1
    return a.hit.line - b.hit.line
  })
  const topScore = scored[0].score
  if (topScore <= 0) {
    // No ranking signal — return all (caller will apply limit).
    return { kept: scored, prunedBelowShoulder: 0 }
  }
  const threshold = topScore * SHOULDER_THRESHOLD
  let cut = scored.length
  for (let i = 0; i < scored.length; i++) {
    if (scored[i].score < threshold) {
      cut = i
      break
    }
  }
  return {
    kept: scored.slice(0, cut),
    prunedBelowShoulder: scored.length - cut,
  }
}

// ============================================================
// Snippet rendering
// ============================================================

function renderSnippet(hit: RawHit): string {
  const lines = [
    ...hit.context_before,
    hit.matched_line,
    ...hit.context_after,
  ]
  let snippet = lines.join("\n")
  if (Buffer.byteLength(snippet, "utf8") > MAX_SNIPPET_BYTES) {
    // Middle-elide. Preserve start and end so context survives.
    const buf = Buffer.from(snippet, "utf8")
    const halfCap = Math.floor((MAX_SNIPPET_BYTES - 16) / 2)
    snippet =
      buf.slice(0, halfCap).toString("utf8") +
      "\n... [truncated] ...\n" +
      buf.slice(buf.length - halfCap).toString("utf8")
  }
  return snippet
}

// ============================================================
// Main entry point
// ============================================================

export async function searchCode(
  rawInput: CodeSearchInput,
  externalSignal?: AbortSignal,
): Promise<CodeSearchResponse> {
  const t0 = Date.now()

  const inputErr = validateInputs(rawInput)
  if (inputErr) throw new Error(inputErr)

  const ws = validateWorkspace(rawInput.workspace)
  if (!ws.ok || !ws.canonical) {
    throw new Error(ws.error ?? "workspace validation failed")
  }

  const mode = rawInput.mode ?? "ranked"
  const structuralMode = rawInput.structural ?? "full"
  const limit = rawInput.limit ?? DEFAULT_LIMIT
  const contextLines = Math.min(
    rawInput.context_lines ?? DEFAULT_CONTEXT_LINES,
    MAX_CONTEXT_LINES,
  )

  // Identifier skeleton-form expansion. When the user's query is a
  // single identifier in any of the five canonical conventions, we
  // expand to all of them and feed rg a regex alternation. This is
  // the live-correctness fix for "rg getUserName" not finding
  // get_user_name. Regex mode is excluded — the user is explicit
  // about regex semantics there.
  const expansion =
    mode === "regex" ? null : expandIdentifierVariants(rawInput.query)
  const expansionPattern = expansion
    ? buildExpansionPattern(expansion)
    : undefined

  // Local AbortController combines: external signal, wall-time, and
  // any internal short-circuits (stdout cap, global limit). Single
  // place to fire abort from.
  const ac = new AbortController()
  const onExternal = (): void => ac.abort("external")
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort("external")
    else externalSignal.addEventListener("abort", onExternal, { once: true })
  }
  const wallTimer = setTimeout(() => ac.abort("timeout"), WALL_TIME_MS)
  wallTimer.unref()

  let parseResult: ParseResult
  let rgResolution: RipgrepResolution
  try {
    rgResolution = resolveRipgrep()
  } catch (err) {
    clearTimeout(wallTimer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternal)
    throw err
  }

  const args = buildRgArgs({
    mode,
    fileGlob: rawInput.file_glob,
    contextLines,
    query: rawInput.query,
    expansionPattern,
  })

  let child: ChildProcess
  try {
    child = spawn(rgResolution.rgPath, args, {
      cwd: ws.canonical, // TOCTOU mitigation: kernel-level pin
      shell: false, // never via shell
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    clearTimeout(wallTimer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternal)
    throw new Error(`failed to spawn ripgrep: ${(err as Error).message}`)
  }

  // Capture stderr as text (bounded to 64KB — rg errors are short,
  // but the existing 1MB byte cap stays as a runaway-input guard).
  // We surface stderr on exit code 2 so model gets actionable errors
  // (e.g. regex compile failures) rather than empty results.
  const STDERR_TEXT_CAP = 64 * 1024
  let stderrBytes = 0
  let stderrText = ""
  if (child.stderr) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += chunk.length
      if (stderrText.length < STDERR_TEXT_CAP) {
        stderrText = (stderrText + chunk).slice(0, STDERR_TEXT_CAP)
      }
      if (stderrBytes > 1024 * 1024) {
        // 1MB stderr is excessive — kill.
        ac.abort("stderr_cap")
      }
    })
  }

  // Track rg's exit code so we can distinguish "no matches" (code 1)
  // from a real error (code 2: bad regex, IO failure after our
  // workspace validation, etc.) Per `man rg`:
  //   0 = matches found
  //   1 = no matches (not an error)
  //   2 = error (regex, IO, ...)
  let exitCode: number | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exitCode = code
      resolve()
    })
  })

  try {
    parseResult = await parseRgJsonStream(child, {
      limit,
      contextLines,
      signal: ac.signal,
    })
  } finally {
    clearTimeout(wallTimer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternal)
    if (!child.killed) killChild(child)
  }

  // If the abort was due to timeout/cap/external, surface that.
  if (ac.signal.aborted && parseResult.hits.length === 0) {
    const reason = String(ac.signal.reason ?? "aborted")
    throw new Error(`code_search aborted (${reason})`)
  }

  // Surface rg errors (regex compile failures, etc.) to the caller.
  // Exit code 2 means "rg encountered an error" — typically a malformed
  // regex in mode="regex". Without this, an invalid regex returns
  // empty results with no indication of why; the model can't tell
  // "no matches" from "your pattern is broken." We re-check
  // !signal.aborted so timeout/cap-driven aborts (which also produce
  // non-zero exit) keep their existing error path above.
  //
  // Await rg's full exit before reading exitCode — the parseRgJsonStream
  // for-await terminates on stdout EOF, which may slightly precede the
  // child's 'close' event in Node's event-loop ordering.
  if (!ac.signal.aborted) {
    await exitPromise
  }
  if (
    exitCode !== null &&
    exitCode !== 0 &&
    exitCode !== 1 &&
    !ac.signal.aborted &&
    parseResult.hits.length === 0
  ) {
    const trimmed = stderrText.trim()
    const detail =
      trimmed.length > 0
        ? trimmed.replace(/^rg:\s*/i, "").slice(0, 600)
        : `ripgrep exited with code ${exitCode}`
    throw new Error(`code_search: ${detail}`)
  }

  // Apply ranking.
  let kept: Array<ScoredHit>
  let prunedBelowShoulder: number | undefined
  let notice: string | null = null
  if (mode === "ranked") {
    const queryTokens = tokenize(rawInput.query)
    // Pass 1: regex-only BM25F. Cheap and gives us a reliable
    // ordering to pick the top-N for structural confirmation.
    const pass1 = bm25fScore(parseResult.hits, queryTokens)
    pass1.sort((a, b) => b.score - a.score)
    const topN =
      structuralMode === "topN" ? STRUCTURAL_TOPN_FAST : STRUCTURAL_TOPN_FULL
    // Build (hit, original-index) entries for the top-N. The index
    // is into `parseResult.hits` so the AST-confirmed set lines up
    // with the pass-2 scoring loop.
    const indexByHit = new Map<RawHit, number>()
    for (let i = 0; i < parseResult.hits.length; i++) {
      indexByHit.set(parseResult.hits[i], i)
    }
    const hitsRanked = pass1
      .slice(0, Math.min(topN, pass1.length))
      .map((sh) => ({ hit: sh.hit, index: indexByHit.get(sh.hit) ?? -1 }))
      .filter((e) => e.index >= 0)

    const structural = await runStructuralPass({
      hitsRanked,
      workspaceRoot: ws.canonical,
      topN,
      budgetMs: STRUCTURAL_BUDGET_MS,
      signal: ac.signal,
    })
    notice = structural.fallback

    // Pass 2: re-score with AST confirmation. Corpus stats are
    // re-computed against the structurally-enriched symbol_context
    // fields so token IDFs reflect the new field contents.
    const pass2 = bm25fScore(
      parseResult.hits,
      queryTokens,
      structural.confirmedHitIndexes,
    )
    const pruned = shoulderPrune(pass2)
    kept = pruned.kept.slice(0, limit)
    prunedBelowShoulder = pruned.prunedBelowShoulder
  } else {
    // Literal / regex: ripgrep document order, no scoring.
    kept = parseResult.hits.map((h) => ({
      hit: h,
      score: 0,
      field_contributions: {} as Record<string, number>,
    }))
  }

  // Render output hits. rg paths are already relative to cwd
  // (we spawned with target ".") so no extra resolution needed.
  // Strip the leading "./" or ".\" that rg prepends when target=".".
  // Then normalize separators to "/" so output is platform-agnostic
  // (Windows rg returns "src\foo.ts"; models and tests expect "/").
  const results: Array<CodeSearchHit> = kept.map((sh) => {
    let file = sh.hit.file
    if (file.startsWith("./") || file.startsWith(".\\")) {
      file = file.slice(2)
    }
    file = file.replace(/\\/g, "/")
    const baseHit: CodeSearchHit = {
      file,
      line: sh.hit.line,
      snippet: renderSnippet(sh.hit),
      match_byte_range: [sh.hit.match_start, sh.hit.match_end],
    }
    if (mode === "ranked") {
      baseHit.score = round4(sh.score)
      baseHit.field_contributions = {
        match_line: round4(sh.field_contributions.match_line ?? 0),
        symbol_context: round4(sh.field_contributions.symbol_context ?? 0),
        file_path: round4(sh.field_contributions.file_path ?? 0),
        context: round4(sh.field_contributions.context ?? 0),
      }
    } else {
      baseHit.field_contributions = null
    }
    return baseHit
  })

  const elapsed_ms = Date.now() - t0

  // Telemetry breadcrumb. Per LOW-17: don't log raw query or
  // absolute paths unless explicitly enabled.
  const debugLog = process.env.GH_ROUTER_DEBUG_CODE_SEARCH === "1"
  consola.info(
    `[code_search] mode=${mode} structural=${structuralMode} ` +
      `expansion=${expansion ? expansion.length : 0} ` +
      `results=${results.length} truncated=${parseResult.truncated} ` +
      `scanned_files=${parseResult.scannedFiles} elapsed_ms=${elapsed_ms} ` +
      `abort=${parseResult.cancelled} rg=${rgResolution.source} ` +
      `notice=${notice ? "yes" : "no"}` +
      (debugLog ? ` query="${rawInput.query}" workspace="${ws.canonical}"` : ""),
  )

  return {
    results,
    truncated: parseResult.truncated,
    pruned_below_shoulder: mode === "ranked" ? prunedBelowShoulder : undefined,
    scanned_files: parseResult.scannedFiles,
    elapsed_ms,
    ranking:
      mode === "ranked"
        ? {
            algorithm: "BM25F",
            citation: "Robertson, Zaragoza, Taylor 2004",
            k1: BM25F_K1,
          }
        : { algorithm: "ripgrep_document_order" },
    notice,
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
