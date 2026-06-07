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
import { performance } from "node:perf_hooks"
import { createInterface } from "node:readline"
import * as path from "node:path"

import consola from "consola"
import Parser from "web-tree-sitter"

import {
  confirmDefinitionSites,
  type FileOutlineEntry,
  type FileOutlineResult,
  getGrammarBundle,
  getLanguageKeyForPath,
  outlineFile,
  outlineFromTree,
  type StructuralHit,
  STRUCTURAL_MAX_FILE_BYTES,
} from "~/lib/tree-sitter-grammars"
import {
  getTreeSitterPool,
  type PoolJob,
  type TreeSitterPool,
} from "~/lib/tree-sitter-pool/pool"
import { resolveExecutable, runManagedExeCapture } from "~/lib/exec"
import { PATHS } from "~/lib/paths"
import { isSensitivePath } from "~/lib/worker-agent/paths"

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
 * Shoulder cut threshold: in DEFAULT (non-`complete`) ranked mode, drop
 * hits below this fraction of the top score for precision. `complete:
 * true` disables it — see `docs/code-search-floor.md`.
 */
const SHOULDER_THRESHOLD = 0.5

const MAX_QUERY_LEN = 1024
const MAX_GLOB_LEN = 512
const DEFAULT_LIMIT = 200
const MAX_CONTEXT_LINES = 10
/**
 * `summary: true` outlines at most this many distinct result files (in
 * result order) — a structural map of where the matches live, bounded
 * so a broad query doesn't trigger hundreds of tree-sitter parses.
 */
const CODE_SUMMARY_MAX_FILES = 10
/**
 * `scan: true` outlines the ENTIRE workspace (every non-ignored,
 * non-sensitive source file), not just the matched result files. Bounded
 * well above `CODE_SUMMARY_MAX_FILES` (a whole-workspace map is the whole
 * point) but still capped so a giant monorepo can't blow the 256 KB
 * response or stall the tree-sitter pool. On truncation the response
 * `notice` reports files-covered vs total.
 */
const SCAN_MAX_FILES = 400
/**
 * Per-file match cap applied in DEFAULT (non-`complete`) ranked mode:
 * keeps one match-dense file from filling the global limit and blinding
 * BM25F to the rest of the workspace. `complete: true` disables it (and
 * the shoulder cut) to return the full grep set — the floor guarantee.
 */
const RANKED_MAX_PER_FILE = 50
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
  /**
   * Structural summary, ON BY DEFAULT. The response carries a
   * tree-sitter STRUCTURAL OUTLINE (`outlines`) of the distinct files in
   * the result set (top-level symbols + line numbers), capped at the
   * first `CODE_SUMMARY_MAX_FILES` files in result order — a compact map
   * of where the matches live that augments, never replaces, `snippet`.
   * Set `summary: false` to omit it (e.g. when only the matching lines
   * are needed).
   */
  summary?: boolean
  /**
   * Exhaustiveness control. Default `false`: ranked mode applies a
   * precision shoulder cut (drops hits below 50% of the top score) and a
   * per-file match cap for cross-file diversity, so the model isn't
   * overwhelmed. `true`: BOTH are disabled, so ranked mode returns the
   * COMPLETE ripgrep match set (reordered by relevance), capped only by
   * the explicit `limit` — the provable floor (never drops a match grep
   * would return). When the default hides matches, the response `notice`
   * says so and points the model here.
   */
  complete?: boolean
  /**
   * Multi-line matching. Default `false` (line-oriented, the proven
   * floor). When `true`, ripgrep runs with `-U --multiline-dotall` so a
   * pattern can span newlines (e.g. `foo[\s\S]*?bar` across two lines).
   * The match snippet is the whole spanned region, capped to the snippet
   * byte budget; the reported `line` is the START of the span. Use it with
   * `mode: "regex"` — that is the only mode where a cross-line pattern is
   * expressible (the `query` validator rejects literal newlines, so a
   * literal/ranked multi-line LITERAL can't be typed). Composes with every
   * other param.
   */
  multiline?: boolean
  /**
   * Whole-workspace structural outline. Default `false`. When `true`,
   * `outlines` covers EVERY non-ignored, non-sensitive source file in the
   * workspace (a tree-sitter symbol map of the whole tree), not just the
   * files that text-matched `query`. Capped at `SCAN_MAX_FILES` and
   * budget-fitted into the response; on truncation `notice` reports
   * coverage. Use it to map an unfamiliar codebase's symbols in one call.
   * Independent of the match generation (the hit set still comes from the
   * query / `ast_pattern`).
   */
  scan?: boolean
  /**
   * ast-grep structural pattern. When set, match generation runs ast-grep
   * (`sg`) with this pattern INSTEAD of ripgrep — results come back in the
   * same `{file, line, snippet}` shape, so a multi-line AST construct the
   * line-oriented regex modes can't express is matched directly. Takes
   * PRECEDENCE over `query` for match generation (`query` is then ignored
   * for matching; it is still required by the schema but unused). Requires
   * ast-grep (`sg`) to be available (toolbelt bin dir or system PATH); if
   * it isn't, `code_search` returns no results plus a `notice` telling you
   * to run ast-grep directly or omit `ast_pattern` (it never silently
   * falls back to regex). Read-only subprocess, workspace-confined.
   */
  ast_pattern?: string
  /**
   * Language grammar for `ast_pattern` — REQUIRED whenever `ast_pattern` is
   * set. e.g. `"ts"`, `"tsx"`, `"js"`, `"jsx"`, `"py"`, `"rust"`, `"go"`,
   * `"java"`, `"cpp"`, `"c"`. ast-grep parses the pattern in this grammar;
   * WITHOUT it ast-grep cross-matches every language (e.g. matching markdown
   * prose) and returns garbage, so if `ast_pattern` is set but `ast_lang`
   * is omitted, `code_search` returns no results plus a `notice` asking for
   * it (it does NOT guess a language).
   */
  ast_lang?: string
}

export interface CodeSearchHit {
  file: string
  line: number
  snippet: string
  match_byte_range: [number, number]
  score?: number
  field_contributions?: Readonly<Record<string, number>> | null
  /**
   * Present (always `"definition"`) ONLY when the structural pass
   * AST-confirmed this hit is the symbol's definition site. Absent
   * otherwise — absence is NOT a claim that the hit is a usage (the hit
   * may simply not have been AST-checked: unsupported language, file over
   * the 1 MiB cap, parse error, or the structural budget was exhausted).
   */
  role?: "definition"
}

export interface CodeSearchResponse {
  results: Array<CodeSearchHit>
  truncated: boolean
  scanned_files: number
  elapsed_ms: number
  ranking: {
    algorithm: "BM25F" | "ripgrep_document_order"
    citation?: string
    k1?: number
  }
  /**
   * Present only when `summary: true` was requested: a tree-sitter
   * structural outline of each distinct file in the result set (capped
   * at `CODE_SUMMARY_MAX_FILES`, in result order). Absent otherwise.
   */
  outlines?: Array<{ file: string; outline: Array<FileOutlineEntry> }>
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
  /** When true, skip the per-file `--max-count` cap (floor mode). */
  complete?: boolean
  /** When true, add `-U --multiline-dotall` so a pattern can span lines. */
  multiline?: boolean
}): Array<string> {
  const args: Array<string> = ["--json", "--no-binary", "--no-follow"]

  // Multi-line matching: `-U` lets a pattern span newlines, and
  // `--multiline-dotall` makes `.` match `\n` too (so `foo.*bar` crosses
  // lines). Opt-in only — the default stays line-oriented, which is the
  // proven recall floor. With `-F` (fixed-string) `-U` still matches a
  // multi-line literal; with regex it enables cross-line patterns.
  if (input.multiline) {
    args.push("-U", "--multiline-dotall")
  }

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

  // Per-file match cap in DEFAULT ranked mode (see RANKED_MAX_PER_FILE):
  // keeps one match-dense file from filling the global limit and blinding
  // BM25F. `complete: true` and literal/regex modes skip it so the full
  // match set is returned.
  if (input.mode === "ranked" && !input.complete) {
    args.push("--max-count", String(RANKED_MAX_PER_FILE))
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

  child.stdout.setEncoding("utf8") // match stderr treatment at line 1749
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
      // Defense-in-depth: strip NUL bytes that survive despite --no-binary
      // (e.g. if rg's binary detection is fooled by a file with NUL only
      // beyond the 8KB detection window). Resource accounting above uses
      // rawLine.length (honest); parsing below uses the sanitized line.
      const line = rawLine.includes("\0") ? rawLine.replace(/\0/g, "") : rawLine
      if (line.length === 0) continue

      let evt: RgEvent
      try {
        evt = JSON.parse(line) as RgEvent
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

/**
 * Normalize a ripgrep-relative path to the form used in the rendered output
 * (strip a leading "./" or ".\", convert "\" → "/"). Used to key the pooled
 * structural-outline map so the outline loop's lookup (which iterates rendered
 * result files) matches regardless of OS path separators or rg's "./" prefix.
 */
function normalizeRelFile(file: string): string {
  let f = file
  if (f.startsWith("./") || f.startsWith(".\\")) f = f.slice(2)
  return f.replace(/\\/g, "/")
}

// ============================================================
// Tree-sitter structural ranking
// ============================================================
//
// The grammar layer this pass depends on — the extension/grammar
// tables, the definition-/identifier-node-type sets, and the lazily
// initialized `web-tree-sitter` parser cache — lives in
// `~/lib/tree-sitter-grammars` and is imported at the top of this file.
// Only the BM25F-coupled tree cache + structural-confirmation walk stay
// here.

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

interface StructuralPassResult {
  /** Indexes (into the input hits array) where AST confirmed the
   *  matched identifier is at a definition site. */
  confirmedHitIndexes: Set<number>
  /** null = success (entire top-N parsed within budget). String =
   *  budget exceeded mid-pass, with explanation suitable for surfacing
   *  to the model as the `notice` field (overridden by size-cap notice
   *  at the handler boundary when both fire). */
  fallback: string | null
  /**
   * Outline entries the parse PRODUCED for each file, keyed by RELATIVE file
   * path. Populated ONLY on the worker-pool path: a `Tree` can't cross the
   * thread boundary, so Lever 1's in-process tree reuse can't apply across
   * threads — instead the pool returns outline entries alongside the confirm
   * result (the coalesced job), and `searchCode`'s outline loop reuses these
   * before falling back. On the in-process path this is undefined and the
   * outline loop reuses `_treeCache` directly, exactly as before.
   */
  outlinesByFile?: Map<string, Array<FileOutlineEntry>>
}

/**
 * Benchmark-only instrumentation. Zero cost in production: nothing writes
 * here unless `GH_ROUTER_BENCH_STRUCTURAL=1`. Exposes the actual number of
 * DISTINCT files the structural pass parsed (vs the ≤topN *hits* it
 * considered) and the wall-clock spent inside it, so the parallelism
 * benchmark can attribute end-to-end cost honestly rather than infer it.
 * Read + reset by `scripts/bench-code-search-parallelism.ts`.
 */
export interface BenchStructuralStats {
  calls: number
  filesParsed: number
  filesConsidered: number
  budgetHit: number
  parseMsTotal: number
}
const _benchStructural: BenchStructuralStats = {
  calls: 0,
  filesParsed: 0,
  filesConsidered: 0,
  budgetHit: 0,
  parseMsTotal: 0,
}
const _benchStructuralOn = (): boolean =>
  process.env.GH_ROUTER_BENCH_STRUCTURAL === "1"
export function __readBenchStructuralStats(): BenchStructuralStats {
  return { ..._benchStructural }
}
export function __resetBenchStructuralStats(): void {
  _benchStructural.calls = 0
  _benchStructural.filesParsed = 0
  _benchStructural.filesConsidered = 0
  _benchStructural.budgetHit = 0
  _benchStructural.parseMsTotal = 0
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
/**
 * Group the top-`topN` ranked hits by file, preserving rank order of files
 * (first-seen). Shared by the in-process and pooled structural passes so both
 * consider the identical file set. Each file maps to its hits' rg offsets +
 * the original hit index.
 */
function groupHitsByFile(
  hitsRanked: Array<{ hit: RawHit; index: number }>,
  topN: number,
): Map<string, Array<{ hit: RawHit; index: number }>> {
  const cap = Math.min(hitsRanked.length, topN)
  const byFile = new Map<string, Array<{ hit: RawHit; index: number }>>()
  for (let i = 0; i < cap; i++) {
    const entry = hitsRanked[i]
    const list = byFile.get(entry.hit.file) ?? []
    list.push(entry)
    byFile.set(entry.hit.file, list)
  }
  return byFile
}

/**
 * Run the structural-confirmation pass over the top-N ranked hits. Tries the
 * warm worker-thread parse pool first (parallel parses off the main event
 * loop — the measured win for concurrent `code` calls; see
 * `docs/research/tree-sitter-parallelism.md`); on pool unavailability,
 * disablement, or total pool failure it falls back to the in-process path,
 * which is behavior-identical to pre-Lever-2. Both paths produce the SAME
 * confirmed-index set for the same inputs (the shared `confirmDefinitionSites`
 * walk + order-independent Set merge), so the determinism test holds either
 * way.
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
  if (opts.hitsRanked.length === 0 || opts.signal.aborted) return result

  const grammars = await getGrammarBundle().ready
  if (grammars.size === 0) return result

  const byFile = groupHitsByFile(opts.hitsRanked, opts.topN)
  const cap = Math.min(opts.hitsRanked.length, opts.topN)
  const benchOn = _benchStructuralOn()
  if (benchOn) {
    _benchStructural.calls += 1
    _benchStructural.filesConsidered += byFile.size
  }

  const pool = getTreeSitterPool()
  if (pool) {
    const pooled = await runStructuralPassPooled({
      pool,
      byFile,
      grammars,
      workspaceRoot: opts.workspaceRoot,
      cap,
      budgetMs: opts.budgetMs,
      signal: opts.signal,
      benchOn,
    })
    if (pooled) return pooled
    // Pool returned null (total failure / unavailable mid-run) → fall through
    // to the in-process path below, which is the always-correct baseline.
  }

  return runStructuralPassInProcess({
    byFile,
    grammars,
    workspaceRoot: opts.workspaceRoot,
    cap,
    budgetMs: opts.budgetMs,
    signal: opts.signal,
    benchOn,
    result,
  })
}

/**
 * Pooled structural pass. Builds one COALESCED job per file (confirm + outline
 * in a single parse), dispatches across the pool under the wall-clock budget,
 * and merges replies order-independently. Returns `null` when the pool produced
 * no usable result (so the caller falls back in-process).
 */
async function runStructuralPassPooled(opts: {
  pool: TreeSitterPool
  byFile: Map<string, Array<{ hit: RawHit; index: number }>>
  grammars: Map<string, Parser.Language>
  workspaceRoot: string
  cap: number
  budgetMs: number
  signal: AbortSignal
  benchOn: boolean
}): Promise<StructuralPassResult | null> {
  const jobs: Array<PoolJob> = []
  // Per file: the list of hit indexes in dispatch order, so we can map the
  // worker's returned positions back to original hit indexes.
  const indexMap = new Map<string, Array<number>>()
  for (const [relFile, entries] of opts.byFile) {
    const langKey = getLanguageKeyForPath(relFile)
    if (!langKey || !opts.grammars.has(langKey)) continue
    const absPath = path.join(opts.workspaceRoot, relFile)
    let mtimeMs: number
    try {
      const st = statSync(absPath)
      if (st.size > STRUCTURAL_MAX_FILE_BYTES) continue
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }
    const confirmHits: Array<StructuralHit> = entries.map((e) => ({
      line: e.hit.line,
      matchStart: e.hit.match_start,
      matchEnd: e.hit.match_end,
    }))
    indexMap.set(
      relFile,
      entries.map((e) => e.index),
    )
    jobs.push({
      file: relFile,
      absPath,
      language: langKey,
      mtimeMs,
      confirmHits,
      // Coalesce the outline walk so a file used by both the structural pass
      // and the outline summary is parsed exactly once worker-side (the
      // threaded equivalent of Lever 1's in-process tree reuse).
      outline: true,
    })
  }

  const run = await opts.pool.parseFiles(jobs, {
    budgetMs: opts.budgetMs,
    signal: opts.signal,
  })
  if (!run) return null // pool unavailable / total failure → in-process fallback

  const confirmedHitIndexes = new Set<number>()
  const outlinesByFile = new Map<string, Array<FileOutlineEntry>>()
  for (const job of jobs) {
    const fileResult = run.byFile.get(job.file)
    if (!fileResult || !fileResult.ok) continue
    const origIndexes = indexMap.get(job.file) ?? []
    // Map worker-returned positions (into confirmHits) → original hit indexes.
    for (const pos of fileResult.confirmedHitIndexes) {
      const orig = origIndexes[pos]
      if (orig !== undefined) confirmedHitIndexes.add(orig)
    }
    if (fileResult.outlineEntries) {
      // Key by the normalized (rendered) path so the outline loop's lookup —
      // which iterates rendered result files — matches across OS separators.
      outlinesByFile.set(normalizeRelFile(job.file), fileResult.outlineEntries)
    }
  }

  if (opts.benchOn) {
    _benchStructural.filesParsed += run.byFile.size
    if (run.budgetHit) _benchStructural.budgetHit += 1
  }

  return {
    confirmedHitIndexes,
    fallback: run.budgetHit
      ? `structural budget exceeded after parsing ${run.byFile.size}/${opts.cap} hits; ` +
        `retry with structural: "topN" or narrow your query`
      : null,
    outlinesByFile,
  }
}

/**
 * In-process structural pass (the always-correct baseline; identical to
 * pre-Lever-2 behavior). Parses each file synchronously on the main thread,
 * caches the tree in `_treeCache` for the outline loop to reuse (Lever 1), and
 * walks each hit. Wall-clock-bounded — checked between files, not mid-parse
 * (web-tree-sitter@0.22 doesn't expose a usable cancel hook).
 *
 * Per-file failure modes (file too big, language unsupported, parse error, I/O
 * error) are silent: the file's hits keep the regex `symbol_context` heuristic.
 * Only the wall-clock budget fires the user-visible `fallback` message.
 */
function runStructuralPassInProcess(opts: {
  byFile: Map<string, Array<{ hit: RawHit; index: number }>>
  grammars: Map<string, Parser.Language>
  workspaceRoot: string
  cap: number
  budgetMs: number
  signal: AbortSignal
  benchOn: boolean
  result: StructuralPassResult
}): StructuralPassResult {
  const { byFile, grammars, cap, benchOn, result } = opts
  const t0 = Date.now()
  let filesParsed = 0
  let parsersUsed = new Map<string, Parser>()

  try {
    for (const [relFile, entries] of byFile) {
      if (opts.signal.aborted) break
      const elapsed = Date.now() - t0
      if (elapsed >= opts.budgetMs) {
        if (benchOn) _benchStructural.budgetHit += 1
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
          const pt0 = benchOn ? performance.now() : 0
          tree = parser.parse(source)
          if (benchOn) _benchStructural.parseMsTotal += performance.now() - pt0
        } catch (err) {
          consola.debug(
            `[code_search] tree-sitter parse failed for ${relFile}: ${(err as Error).message}`,
          )
        }
        cached = { mtimeMs, tree, source: tree ? source : null }
        cachePut(absPath, cached)
        filesParsed += 1
        if (benchOn) _benchStructural.filesParsed += 1
      }

      if (!cached.tree || !cached.source) continue

      // Confirm every hit's matched identifier via the SHARED walk — the same
      // `confirmDefinitionSites` the worker pool runs, so the in-process and
      // pooled paths produce byte-identical confirmed sets (the determinism
      // requirement). Returns positions into `entries`; map back to the
      // original hit indexes.
      const confirmedPositions = confirmDefinitionSites(
        cached.tree,
        cached.source,
        langKey,
        entries.map((e) => ({
          line: e.hit.line,
          matchStart: e.hit.match_start,
          matchEnd: e.hit.match_end,
        })),
        opts.signal,
      )
      for (const pos of confirmedPositions) {
        const entry = entries[pos]
        if (entry) result.confirmedHitIndexes.add(entry.index)
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
// Ranking order
// ============================================================

/**
 * Deterministic ranking order, in place: score desc, then (file, line)
 * ascending as a stable tiebreak.
 *
 * There is NO score-based cut. The floor guarantee (see
 * `docs/code-search-floor.md`) is that ranked mode never drops a hit
 * ripgrep would return — it returns exactly the ripgrep match set,
 * reordered, capped only by the explicit `limit`. An earlier
 * "shoulder prune" (drop below 50% of the top score) silently removed
 * real matches a `grep` would surface; it was removed.
 */
function sortByScore(scored: Array<ScoredHit>): void {
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.hit.file !== b.hit.file) return a.hit.file < b.hit.file ? -1 : 1
    return a.hit.line - b.hit.line
  })
}

/**
 * Default-mode precision filter: given a score-sorted array, keep the
 * prefix at or above `SHOULDER_THRESHOLD` × top score. Returns ALL when
 * there is no ranking signal (top score 0). Skipped entirely under
 * `complete: true` — the caller then gets the full ranked set.
 */
function shoulderCut(sorted: Array<ScoredHit>): Array<ScoredHit> {
  if (sorted.length === 0) return sorted
  const topScore = sorted[0].score
  if (topScore <= 0) return sorted
  const threshold = topScore * SHOULDER_THRESHOLD
  let cut = sorted.length
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].score < threshold) {
      cut = i
      break
    }
  }
  return sorted.slice(0, cut)
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
// ast-grep (structural pattern match generation)
// ============================================================

/**
 * Router credentials that must NEVER reach the ast-grep child. Same key
 * set as `dropColgrepSecrets` (colbert/provision.ts) and the worker-bash
 * env allowlist. We keep a LOCAL strip rather than importing
 * `dropColgrepSecrets` to avoid pulling the heavyweight colbert
 * provisioning module into the core code-search import graph. ast-grep is
 * a SHA-pinned local binary, but it is still a child process that could
 * be coaxed (config, network) — no router secret belongs in its env.
 */
const AST_GREP_SECRET_ENV_KEYS = [
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "COPILOT_TOKEN",
]

/**
 * Strip router credentials from a child-env COPY (never the live env).
 * Key matching is case-INSENSITIVE because Windows env names are
 * case-insensitive — `Github_Token` / `openai_api_key` must be dropped
 * too, or a mixed-case shell export would leak into the ast-grep child.
 */
function dropAstGrepSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const k of Object.keys(env)) {
    const up = k.toUpperCase()
    if (up.startsWith("GH_ROUTER_") || AST_GREP_SECRET_ENV_KEYS.includes(up)) {
      delete env[k]
    }
  }
  return env
}

/**
 * Resolve the ast-grep binary. Checks the toolbelt bin dir (where the
 * proxy materializes `sg` + `ast-grep`) AND the system PATH, trying `sg`
 * first then `ast-grep`. Returns an ABSOLUTE path or `null` when neither
 * is found. `resolveExecutable` honors PATHEXT on Windows and excludes
 * the cwd (no planted-`sg.exe` vector). The toolbelt dir is searched by
 * prepending it to a PATH copy so the same resolver handles both sources.
 */
export function resolveAstGrep(): string | null {
  const toolbeltDir = PATHS.TOOLBELT_BIN_DIR
  // `sg` is the toolbelt's alias for ast-grep, but it is ONLY trusted from
  // OUR toolbelt dir — on Linux a bare `sg` on the system PATH is
  // `/usr/bin/sg` (the shadow-utils setgid command), NOT ast-grep. Resolving
  // that ran the wrong binary in CI (the ast_pattern tests failed because
  // setgid produced no matches). So search `sg` in the toolbelt dir ONLY.
  const sgInToolbelt = resolveExecutable("sg", {
    env: { ...process.env, PATH: toolbeltDir },
  })
  if (sgInToolbelt) return sgInToolbelt
  // `ast-grep` is the unambiguous name — safe from the toolbelt OR the system
  // PATH (no system command collides with it).
  const astGrep = resolveExecutable("ast-grep", {
    env: {
      ...process.env,
      PATH: `${toolbeltDir}${path.delimiter}${pathEnvValue()}`,
    },
  })
  if (astGrep) return astGrep
  return null
}

/**
 * Test-only override for the ast-grep resolver. `undefined` = use the real
 * `resolveAstGrep`. Set to a function (e.g. `() => null` to force the
 * binary-absent path deterministically even on a host that HAS sg) via
 * `__setAstGrepResolverForTest`. Mirrors the `__readBenchStructuralStats`
 * test-export convention already used in this module.
 */
let _astGrepResolverOverride: (() => string | null) | undefined

export function __setAstGrepResolverForTest(
  fn: (() => string | null) | undefined,
): void {
  _astGrepResolverOverride = fn
}

/** Resolve ast-grep, honoring the test override when set. */
function resolveAstGrepForRun(): string | null {
  return (_astGrepResolverOverride ?? resolveAstGrep)()
}

/** Read PATH case-insensitively from the live env. */
function pathEnvValue(): string {
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === "path") return process.env[key] ?? ""
  }
  return ""
}

/** One `sg run --json=stream` JSON-line shape (only the fields we read). */
interface AstGrepMatch {
  text?: string
  lines?: string
  file?: string
  range?: {
    start?: { line?: number; column?: number }
    end?: { line?: number; column?: number }
  }
}

interface AstGrepResult {
  /** RawHit set (relative paths, 1-indexed lines). */
  hits: Array<RawHit>
  /** Non-null when something the model can act on fired (binary missing,
   *  truncated, timed out, error) — surfaced as the response `notice`. */
  notice: string | null
}

/**
 * Run ast-grep with `pattern` over `workspaceCanonical` and return its
 * matches in `RawHit` shape (relativized, 1-indexed). Read-only,
 * workspace-confined, secret-stripped, stdout-capped, timeout-bounded.
 *
 * Security posture (mirrors `src/lib/colbert/runner.ts`):
 *   - `runManagedExeCapture(absExe, argv, {shell:false})` — pattern and
 *     workspace are ARGV elements, never a shell string. A workspace path
 *     containing `%`, `&`, `|`, quotes, or spaces cannot inject a command
 *     on Windows (no cmd.exe in the path; CreateProcess resolves the
 *     `.exe` directly).
 *   - `dropAstGrepSecrets` strips every `GH_ROUTER_*` + the named
 *     credential keys from the child env copy.
 *   - workspace is the absolute, realpath-canonicalized directory; the
 *     binary's own `.gitignore` handling scopes the file universe (same
 *     ignore semantics as ripgrep here).
 */
async function runAstGrep(opts: {
  pattern: string
  lang: string | undefined
  workspaceCanonical: string
  limit: number
  signal: AbortSignal
}): Promise<AstGrepResult> {
  const binary = resolveAstGrepForRun()
  if (!binary) {
    return {
      hits: [],
      notice:
        "ast_pattern requires ast-grep (sg), which isn't available here; " +
        "the model can run ast-grep directly or omit ast_pattern",
    }
  }
  // `--lang` is REQUIRED for correct matching. Without it ast-grep parses
  // the pattern against every language's grammar and emits cross-language
  // false positives (e.g. matching markdown prose). A missing/malformed
  // lang therefore fails closed with an actionable notice rather than
  // returning garbage. The token is validated (ast-grep lang ids are short
  // ascii) before it reaches the argv — though shell:false already makes it
  // non-injectable, this gives a clean notice instead of an sg error.
  if (!opts.lang || !/^[A-Za-z0-9_+-]{1,20}$/.test(opts.lang)) {
    return {
      hits: [],
      notice:
        "ast_pattern requires ast_lang (the grammar to parse the pattern), " +
        "e.g. 'ts' | 'tsx' | 'js' | 'py' | 'rust' | 'go'",
    }
  }

  // `sg run -p <pattern> --lang <lang> --json=stream <workspace>` — VERIFIED
  // on ast-grep 0.43.0. `--json=stream` emits one JSON object per line. The
  // workspace is passed as an absolute positional; sg then reports `file` as
  // an absolute path, which we relativize below.
  const args = [
    "run",
    "-p",
    opts.pattern,
    "--lang",
    opts.lang,
    "--json=stream",
    opts.workspaceCanonical,
  ]

  let res
  try {
    res = await runManagedExeCapture(binary, args, {
      cwd: opts.workspaceCanonical,
      env: dropAstGrepSecrets({ ...process.env }),
      timeoutMs: WALL_TIME_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    })
  } catch {
    return {
      hits: [],
      notice: "ast-grep failed to launch; omit ast_pattern or run it directly",
    }
  }

  if (opts.signal.aborted) {
    return { hits: [], notice: null }
  }
  if (res.timedOut) {
    return {
      hits: [],
      notice: "ast-grep timed out; narrow the pattern or run it directly",
    }
  }
  // sg exits 1 on "no matches" (not an error). Any other non-zero with no
  // stdout is a real failure (bad pattern, IO). We don't surface raw
  // stderr (it can embed source); a class label is enough.
  if (res.code !== null && res.code !== 0 && res.code !== 1 && !res.stdout) {
    return {
      hits: [],
      notice:
        "ast-grep returned an error (check the pattern syntax) or omit ast_pattern",
    }
  }

  const hits: Array<RawHit> = []
  for (const rawLine of res.stdout.split("\n")) {
    if (hits.length >= opts.limit) break
    const line = rawLine.trim()
    if (line.length === 0) continue
    let m: AstGrepMatch
    try {
      m = JSON.parse(line) as AstGrepMatch
    } catch {
      continue // skip a partial/garbage line rather than fail the call
    }
    if (typeof m.file !== "string") continue
    // Confine: drop any path ast-grep reports that resolves OUTSIDE the
    // workspace (e.g. a symlink it traversed). `relativizeToWorkspace`
    // returns null on escape; we skip rather than emit an absolute system
    // path. Then apply the sensitive-path denylist (defense-in-depth, same
    // as the scan path) so a hit never surfaces a credential file.
    const rel = relativizeToWorkspace(m.file, opts.workspaceCanonical)
    if (rel === null) continue
    const abs = path.join(opts.workspaceCanonical, rel)
    if (isSensitivePath(abs, opts.workspaceCanonical)) continue
    const startLine = m.range?.start?.line
    // sg is 0-indexed; our contract is 1-indexed.
    const line1 = typeof startLine === "number" ? startLine + 1 : 1
    const snippetSrc =
      typeof m.text === "string" && m.text.length > 0
        ? m.text
        : typeof m.lines === "string"
          ? m.lines
          : ""
    hits.push({
      file: normalizeRelFile(rel),
      line: line1,
      matched_line: snippetSrc,
      // ast-grep offsets are into the file, not the snippet line; we don't
      // expose a byte range for AST hits, so 0:0 (renderSnippet uses the
      // whole matched_line; the symbol_context slice path is never reached
      // because AST hits render literal, not ranked).
      match_start: 0,
      match_end: 0,
      context_before: [],
      context_after: [],
    })
  }

  const truncatedBySize = res.stdoutTruncated || hits.length >= opts.limit
  return {
    hits,
    notice: truncatedBySize
      ? "ast-grep results were truncated (size cap or limit reached); " +
        "narrow the pattern or raise limit"
      : null,
  }
}

/**
 * Relativize an ast-grep-reported file path against the workspace. sg
 * reports absolute paths when handed an absolute positional. Returns the
 * workspace-relative path, or `null` when the path resolves OUTSIDE the
 * workspace (e.g. a traversed symlink) — the caller drops such hits rather
 * than emit an absolute system path. A relative input that stays inside is
 * returned as-is; normalizeRelFile cleans separators afterward.
 */
function relativizeToWorkspace(
  file: string,
  workspaceCanonical: string,
): string | null {
  try {
    const abs = path.resolve(workspaceCanonical, file)
    const rel = path.relative(workspaceCanonical, abs)
    // Empty rel = the workspace dir itself (not a file hit); ".." / absolute
    // = escaped. Either way, not a valid in-workspace file hit.
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null
    }
    return rel
  } catch {
    return null
  }
}

// ============================================================
// Whole-workspace file enumeration (scan mode)
// ============================================================

/**
 * Enumerate every non-ignored file in the workspace via `rg --files`
 * (respecting `.gitignore` / `.ignore` exactly like the search path),
 * then drop sensitive-shaped paths (`.env*`, `*.pem`, `id_rsa*`, `.git/`
 * interior, `.ssh/`, …) via the shared worker denylist. Returns paths
 * RELATIVE to the workspace, in rg's enumeration order, capped at
 * `SCAN_MAX_FILES`.
 *
 * `total` is the count of enumerated source files BEFORE the cap (after
 * the sensitive-path filter), so the caller can disclose coverage when
 * the outline set is truncated.
 */
async function enumerateWorkspaceFiles(opts: {
  rgPath: string
  workspaceCanonical: string
  signal: AbortSignal
  /** Absolute wall-clock deadline (Date.now() ms) — the search-phase
   *  `wallTimer` is already cleared by the time scan runs, so the
   *  enumeration self-bounds against this. */
  deadlineMs: number
}): Promise<{ files: Array<string>; total: number; capped: boolean }> {
  const files: Array<string> = []
  let total = 0
  let capped = false

  if (opts.signal.aborted) return { files, total, capped }

  let child: ChildProcess
  try {
    // `--no-follow`: don't traverse symlinks (matches the search path's
    // scoping; keeps enumeration inside the workspace tree). stderr is
    // IGNORED, not piped: an undrained stderr pipe can fill its OS buffer
    // (e.g. rg "Permission denied" spam on Windows) and deadlock the child,
    // which would defeat the deadline check below (it only runs per stdout
    // line). rg's file LIST goes to stdout; stderr is non-essential here.
    child = spawn(opts.rgPath, ["--files", "--no-follow"], {
      cwd: opts.workspaceCanonical, // kernel-level pin, same as the search path
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return { files, total, capped }
  }

  // Async spawn failures (ENOENT/EACCES) emit an 'error' event rather than
  // throwing; without a listener Node escalates it to an uncaught crash.
  // A no-op listener lets the for-await loop end naturally and we return
  // whatever (nothing) was enumerated.
  child.on("error", () => {})

  // Out-of-band kill at the deadline. The per-line deadline check below
  // only fires when rg emits a line; this guarantees termination even if
  // rg stalls before its first line on a pathological tree.
  const deadlineTimer = setTimeout(
    () => killChild(child),
    Math.max(0, opts.deadlineMs - Date.now()),
  )
  deadlineTimer.unref()

  const onAbort = (): void => killChild(child)
  opts.signal.addEventListener("abort", onAbort, { once: true })

  try {
    if (!child.stdout) return { files, total, capped }
    child.stdout.setEncoding("utf8")
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let stdoutBytes = 0
    for await (const rawLine of rl) {
      if (opts.signal.aborted || Date.now() > opts.deadlineMs) {
        killChild(child)
        break
      }
      // Byte-accurate cap (multibyte UTF-8 paths must not undercount).
      stdoutBytes += Buffer.byteLength(rawLine, "utf8") + 1
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        killChild(child)
        break
      }
      const rel = normalizeRelFile(rawLine.trim())
      if (rel.length === 0) continue
      // Defensive containment re-check: rg --files emits workspace-relative
      // paths, but never trust a subprocess unconditionally — reject any
      // absolute or `..`-escaping path before joining.
      if (path.isAbsolute(rel) || rel.split("/").includes("..")) continue
      // Skip files whose extension has no tree-sitter grammar — outlining
      // them would just parse-fail. Cheap pre-filter before the cap so the
      // cap counts outlineable files, not READMEs.
      if (!getLanguageKeyForPath(rel)) continue
      // Drop credential-shaped paths (defense-in-depth — the outline would
      // surface symbol names from a sensitive file).
      const abs = path.join(opts.workspaceCanonical, rel)
      if (isSensitivePath(abs, opts.workspaceCanonical)) continue
      total += 1
      if (files.length < SCAN_MAX_FILES) {
        files.push(rel)
      } else {
        capped = true
      }
    }
  } catch {
    // Best-effort: return whatever we enumerated.
  } finally {
    clearTimeout(deadlineTimer)
    opts.signal.removeEventListener("abort", onAbort)
    if (!child.killed) killChild(child)
  }

  return { files, total, capped }
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

  // ast_pattern takes PRECEDENCE over the regex query for match
  // generation: when set, matches come from ast-grep, not ripgrep, and
  // are rendered in literal (document-order) shape — BM25F doesn't apply
  // to AST hits. `query` is still required by the schema but unused for
  // matching. The whole-workspace `scan` outline is independent and still
  // runs afterward either way.
  const astPattern =
    typeof rawInput.ast_pattern === "string" && rawInput.ast_pattern.length > 0
      ? rawInput.ast_pattern
      : undefined
  const astLang =
    typeof rawInput.ast_lang === "string" && rawInput.ast_lang.length > 0
      ? rawInput.ast_lang
      : undefined
  // Effective ranking mode: AST hits are never BM25F-scored (there is no
  // text-token relevance signal for a structural match), so force the
  // literal render path for them.
  const effectiveMode = astPattern ? "literal" : mode

  // Identifier skeleton-form expansion. When the user's query is a
  // single identifier in any of the five canonical conventions, we
  // expand to all of them and feed rg a regex alternation. This is
  // the live-correctness fix for "rg getUserName" not finding
  // get_user_name. Regex mode is excluded — the user is explicit
  // about regex semantics there.
  const expansion =
    astPattern || mode === "regex"
      ? null
      : expandIdentifierVariants(rawInput.query)
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
  let astNotice: string | null = null
  let rgResolution: RipgrepResolution
  try {
    rgResolution = resolveRipgrep()
  } catch (err) {
    clearTimeout(wallTimer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternal)
    throw err
  }

  if (astPattern) {
    // ----- ast-grep match generation (precedence over ripgrep) -----
    let astRes: AstGrepResult
    try {
      astRes = await runAstGrep({
        pattern: astPattern,
        lang: astLang,
        workspaceCanonical: ws.canonical,
        limit,
        signal: ac.signal,
      })
    } finally {
      clearTimeout(wallTimer)
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternal)
      }
    }
    if (ac.signal.aborted && astRes.hits.length === 0) {
      const reason = String(ac.signal.reason ?? "aborted")
      throw new Error(`code_search aborted (${reason})`)
    }
    astNotice = astRes.notice
    parseResult = {
      hits: astRes.hits,
      scannedFiles: 0,
      truncated: astRes.hits.length >= limit,
      cancelled: ac.signal.aborted,
      stdoutBytes: 0,
    }
  } else {
    parseResult = await runRipgrep()
  }

  // Inlined ripgrep generation: spawn + parse + exit-code error mapping.
  // Hoisted into a closure so the ast_pattern branch above can bypass it
  // cleanly while preserving the exact original control flow (and the
  // load-bearing cancel-race / exit-code handling) on the default path.
  async function runRipgrep(): Promise<ParseResult> {
    const args = buildRgArgs({
      mode,
      fileGlob: rawInput.file_glob,
      contextLines,
      query: rawInput.query,
      expansionPattern,
      complete: rawInput.complete,
      multiline: rawInput.multiline,
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
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternal)
      }
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

    let pr: ParseResult
    try {
      pr = await parseRgJsonStream(child, {
        limit,
        contextLines,
        signal: ac.signal,
      })
    } finally {
      clearTimeout(wallTimer)
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternal)
      }
      if (!child.killed) killChild(child)
    }

    // If the abort was due to timeout/cap/external, surface that.
    if (ac.signal.aborted && pr.hits.length === 0) {
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
      pr.hits.length === 0
    ) {
      const trimmed = stderrText.trim()
      const detail =
        trimmed.length > 0
          ? trimmed.replace(/^rg:\s*/i, "").slice(0, 600)
          : `ripgrep exited with code ${exitCode}`
      throw new Error(`code_search: ${detail}`)
    }
    return pr
  }


  // Apply ranking.
  let kept: Array<ScoredHit>
  // Stable keys (`file:line:byteStart:byteEnd`) of hits the structural
  // pass AST-confirmed as definition sites — used to tag those hits with
  // `role: "definition"` at render time. A logical key (not object
  // identity) so a clone/rehydrate in scoring can't silently drop the
  // tag. Only populated in ranked mode (the only mode that runs the
  // structural pass). It NEVER claims "usage": absence of the tag is not
  // a claim, since a hit may simply not have been AST-checked.
  let confirmedKeys: Set<string> | undefined
  let notice: string | null = null
  /**
   * Outlines the structural pass already computed (worker-pool path only),
   * keyed by RELATIVE file path. The outline loop reuses these before falling
   * back to `_treeCache` / `outlineFile` — the threaded equivalent of Lever 1's
   * tree reuse (a Tree can't cross threads, so the pool ships outline entries
   * instead). Undefined on the in-process path, where `_treeCache` reuse
   * applies directly.
   */
  let structuralOutlines: Map<string, Array<FileOutlineEntry>> | undefined
  if (effectiveMode === "ranked") {
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
    structuralOutlines = structural.outlinesByFile
    // Pass 2: re-score with AST confirmation. Corpus stats are
    // re-computed against the structurally-enriched symbol_context
    // fields so token IDFs reflect the new field contents.
    const pass2 = bm25fScore(
      parseResult.hits,
      queryTokens,
      structural.confirmedHitIndexes,
    )
    // Accumulate every actionable notice (structural-budget fallback +
    // the two default-mode precision disclosures) so none silently
    // overwrites another.
    const notices: Array<string> = []
    if (structural.fallback) notices.push(structural.fallback)

    // Floor vs precision. `complete: true` returns the full ranked set
    // (capped only by `limit`). The default applies the precision
    // shoulder cut + per-file cap — but discloses BOTH, so a miss is
    // never silent: the model can always recover the full set with
    // `complete: true`.
    sortByScore(pass2)
    if (rawInput.complete) {
      kept = pass2.slice(0, limit)
    } else {
      const cut = shoulderCut(pass2)
      const hidden = pass2.length - cut.length
      kept = cut.slice(0, limit)
      if (hidden > 0) {
        notices.push(
          `${hidden} lower-relevance match${hidden === 1 ? "" : "es"} ` +
            `hidden by precision pruning — pass complete:true for the full set`,
        )
      }
      // Per-file cap disclosure. ripgrep's `--max-count` silently
      // truncates a file at RANKED_MAX_PER_FILE; we can't know the true
      // count, but a file AT the cap was (probably) truncated — disclose
      // it so the cap, like the shoulder cut, is never a silent miss.
      const perFileCounts = new Map<string, number>()
      for (const h of parseResult.hits) {
        perFileCounts.set(h.file, (perFileCounts.get(h.file) ?? 0) + 1)
      }
      let cappedFiles = 0
      for (const c of perFileCounts.values()) {
        if (c >= RANKED_MAX_PER_FILE) cappedFiles++
      }
      if (cappedFiles > 0) {
        notices.push(
          `${cappedFiles} file${cappedFiles === 1 ? "" : "s"} hit the ` +
            `per-file match cap — pass complete:true for every match`,
        )
      }
    }
    notice = notices.length > 0 ? notices.join(" · ") : null

    // Confirmed-definition keys (stable file:line:byte-range, NOT object
    // identity) for the render-time `role` tag.
    confirmedKeys = new Set<string>()
    for (const idx of structural.confirmedHitIndexes) {
      const h = parseResult.hits[idx]
      if (h) {
        confirmedKeys.add(
          `${h.file}:${h.line}:${h.match_start}:${h.match_end}`,
        )
      }
    }
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
    const file = normalizeRelFile(sh.hit.file)
    const baseHit: CodeSearchHit = {
      file,
      line: sh.hit.line,
      snippet: renderSnippet(sh.hit),
      match_byte_range: [sh.hit.match_start, sh.hit.match_end],
    }
    if (effectiveMode === "ranked") {
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
    if (
      confirmedKeys?.has(
        `${sh.hit.file}:${sh.hit.line}:${sh.hit.match_start}:${sh.hit.match_end}`,
      )
    ) {
      baseHit.role = "definition"
    }
    return baseHit
  })

  // Structural summary is ON by default — outline the distinct files in
  // the result set (capped, in result order) unless the caller opts out
  // with `summary: false`. `scan: true` instead outlines the ENTIRE
  // workspace (every non-ignored, non-sensitive source file), up to
  // SCAN_MAX_FILES, so the model gets a whole-tree symbol map in one call.
  // Reuses the shared tree-sitter outliner; each file is bounded by its
  // own 1 MiB parse cap and the outliner never throws. Computed BEFORE
  // `elapsed_ms` so telemetry reflects the real latency.
  let outlines:
    | Array<{ file: string; outline: Array<FileOutlineEntry> }>
    | undefined
  let scanNotice: string | null = null
  const wantScan = rawInput.scan === true
  // A whole-workspace scan (enumerate + outline up to SCAN_MAX_FILES) is
  // the heaviest path and runs AFTER the search-phase wallTimer is torn
  // down, so it self-bounds against this absolute deadline.
  const scanDeadline = Date.now() + WALL_TIME_MS
  if (rawInput.summary !== false || wantScan) {
    let distinct: Array<string>
    if (wantScan) {
      // Whole-workspace enumeration (respects ignore rules; sensitive
      // paths + non-outlineable extensions filtered). Capped at
      // SCAN_MAX_FILES; coverage disclosed via `scanNotice` on truncation.
      const enumed = await enumerateWorkspaceFiles({
        rgPath: rgResolution.rgPath,
        workspaceCanonical: ws.canonical,
        signal: ac.signal,
        deadlineMs: scanDeadline,
      })
      distinct = enumed.files
      if (enumed.capped) {
        scanNotice =
          `scan outlined ${enumed.files.length} of ${enumed.total} workspace ` +
          `source files (capped at ${SCAN_MAX_FILES}); narrow with file_glob ` +
          `or inspect a sub-tree for full coverage`
      }
    } else {
      const seen = new Set<string>()
      distinct = []
      for (const r of results) {
        if (seen.has(r.file)) continue
        seen.add(r.file)
        distinct.push(r.file)
        if (distinct.length >= CODE_SUMMARY_MAX_FILES) break
      }
    }
    outlines = []
    // A whole-workspace scan shares the single `scanDeadline` across
    // enumeration + outlining; the result-summary path keeps its tight
    // 2s self-bound.
    const outlineDeadline = wantScan ? scanDeadline : Date.now() + 2000
    for (const file of distinct) {
      // Self-bound: the wall-clock timer + external-signal listener are
      // already torn down by here, so cap the outline pass independently.
      if (ac.signal.aborted || Date.now() > outlineDeadline) break
      const abs = path.resolve(ws.canonical, file)
      let result: FileOutlineResult | undefined
      // 1. Reuse the worker-pool's already-computed outline (the threaded
      //    equivalent of Lever 1: the pool parsed this file and shipped its
      //    outline entries alongside the confirm result). `file` is the
      //    normalized result path, matching how the pool keyed its map.
      const pooled = structuralOutlines?.get(file)
      if (pooled) {
        result = { outline: pooled, language: getLanguageKeyForPath(abs) }
      }
      // 2. Else reuse the in-process structural pass's cached tree when it's
      //    still fresh — avoids re-reading + re-parsing a file we already
      //    parsed this call. `outlineFromTree` is walk-only and does NOT free
      //    the tree (the cache owns it). On any miss / mtime change / unknown
      //    lang, fall back to a full `outlineFile`.
      if (!result) {
        try {
          const cached = cacheGet(abs, statSync(abs).mtimeMs)
          if (cached?.tree) {
            const lang = getLanguageKeyForPath(abs)
            if (lang) result = outlineFromTree(cached.tree, lang, ac.signal)
          }
        } catch {
          // fall through to a full parse
        }
      }
      const o = result ?? (await outlineFile(abs, ac.signal))
      // Skip files with no recoverable symbols in scan mode so the map
      // stays a list of real symbol-bearing files, not empty noise.
      if (wantScan && o.outline.length === 0) continue
      outlines.push({ file, outline: o.outline })
    }
  }

  // Merge every actionable notice: ast-grep diagnostics + scan coverage +
  // the ranked-mode precision/structural notice. Joined with ` · ` so none
  // overwrites another (same convention as the ranked-mode notice merge).
  const finalNotices: Array<string> = []
  if (astNotice) finalNotices.push(astNotice)
  if (scanNotice) finalNotices.push(scanNotice)
  if (notice) finalNotices.push(notice)
  const mergedNotice = finalNotices.length > 0 ? finalNotices.join(" · ") : null

  const elapsed_ms = Date.now() - t0

  // Telemetry breadcrumb. Per LOW-17: don't log raw query or
  // absolute paths unless explicitly enabled.
  const debugLog = process.env.GH_ROUTER_DEBUG_CODE_SEARCH === "1"
  consola.info(
    `[code_search] mode=${effectiveMode}${astPattern ? " ast_pattern" : ""}` +
      `${wantScan ? " scan" : ""}${rawInput.multiline ? " multiline" : ""} ` +
      `structural=${structuralMode} ` +
      `expansion=${expansion ? expansion.length : 0} ` +
      `results=${results.length} truncated=${parseResult.truncated} ` +
      `outlines=${outlines ? outlines.length : 0} ` +
      `scanned_files=${parseResult.scannedFiles} elapsed_ms=${elapsed_ms} ` +
      `abort=${parseResult.cancelled} rg=${rgResolution.source} ` +
      `notice=${mergedNotice ? "yes" : "no"}` +
      (debugLog ? ` query="${rawInput.query}" workspace="${ws.canonical}"` : ""),
  )

  return {
    results,
    truncated: parseResult.truncated,
    scanned_files: parseResult.scannedFiles,
    elapsed_ms,
    ranking:
      effectiveMode === "ranked"
        ? {
            algorithm: "BM25F",
            citation: "Robertson, Zaragoza, Taylor 2004",
            k1: BM25F_K1,
          }
        : { algorithm: "ripgrep_document_order" },
    outlines,
    notice: mergedNotice,
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
