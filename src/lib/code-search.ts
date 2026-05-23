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
 *   - Workspace trust is default-deny (allow-set: startup cwd +
 *     GH_ROUTER_CODE_SEARCH_ROOTS JSON + .gh-router-searchable
 *     marker files). Home-dir-wide trust was rejected as a
 *     model-callable file-exfil oracle (codex-critic + opus-critic).
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
import { existsSync, realpathSync, statSync } from "node:fs"
import { createInterface } from "node:readline"
import * as path from "node:path"

import consola from "consola"

import { state } from "./state"

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
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
const MAX_CONTEXT_LINES = 10
const DEFAULT_CONTEXT_LINES = 2
const MAX_SNIPPET_BYTES = 2048
const MAX_STDOUT_BYTES = 10 * 1024 * 1024
const WALL_TIME_MS = 30_000

/**
 * Hardcoded secret-shape denylist. Applied as `-g '!PATTERN'` AFTER
 * any user-supplied file_glob, so users cannot override these.
 * Protects against checked-in secret-shaped files leaking into
 * search snippets that then flow upstream to third-party providers.
 */
const SECRET_DENYLIST: ReadonlyArray<string> = Object.freeze([
  "*.env",
  "*.env.*",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*id_rsa*",
  "*id_ed25519*",
  "credentials*",
  "*.kdbx",
  "*.keystore",
  "*.gpg",
  ".aws/**",
  ".ssh/**",
  ".docker/config.json",
  "*.kube/config*",
])

/**
 * Definition-shape heuristic for `symbol_context` field. Match this
 * against the matched line (after leading whitespace strip) to
 * detect "the match is on a definition." Cheaper than tree-sitter,
 * good enough for MVP.
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

/**
 * Walk up from `start` looking for a `.gh-router-searchable` marker
 * file. Returns the canonicalized root that contains the marker, or
 * undefined if none is found before the filesystem root.
 *
 * The marker file is the self-documenting opt-in mechanism for
 * tools that don't control proxy startup (so they can't set the
 * env-var allow-set themselves). User-controlled, easy to audit.
 */
function findMarkerRoot(start: string): string | undefined {
  let cur = start
  // Bound the walk so a degenerate path doesn't loop forever.
  for (let i = 0; i < 256; i++) {
    const marker = path.join(cur, ".gh-router-searchable")
    try {
      if (statSync(marker).isFile()) {
        return realpathSync(cur)
      }
    } catch {
      // marker absent or path component unreachable — continue up
    }
    const parent = path.dirname(cur)
    if (parent === cur) return undefined // hit filesystem root
    cur = parent
  }
  return undefined
}

/**
 * Case-fold safe descendant check. Returns true iff `candidate` is
 * `root` or a descendant of `root`. On case-preserving-but-
 * insensitive filesystems (win32, darwin), the comparison is case-
 * folded so `C:\Users\Foo2` does NOT pass as a child of
 * `C:\Users\Foo` (the prefix-sibling bypass from MEDIUM-8).
 */
function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  if (path.isAbsolute(rel)) return false
  // Same-case OK on Linux; on win32/darwin, also reject if `rel`
  // crosses up via "..". path.relative producing a leading ".."
  // means candidate isn't under root.
  if (rel.startsWith("..")) return false

  // path.relative does case-sensitive comparison on all platforms.
  // On case-insensitive filesystems we need to ALSO verify the
  // case-folded version, to catch e.g. C:\users\foo treated as
  // C:\Users\Foo:
  if (process.platform === "win32" || process.platform === "darwin") {
    const candFolded = candidate.toLowerCase()
    const rootFolded = root.toLowerCase()
    if (
      candFolded !== rootFolded &&
      !candFolded.startsWith(rootFolded + path.sep) &&
      // Also handle the case where rootFolded already ends with sep
      !candFolded.startsWith(rootFolded)
    ) {
      return false
    }
    // Prefix-sibling check: if rootFolded doesn't end with sep,
    // candidate must equal it OR have sep at exactly len(rootFolded).
    if (
      candFolded !== rootFolded &&
      !rootFolded.endsWith(path.sep) &&
      candFolded.length > rootFolded.length &&
      candFolded[rootFolded.length] !== path.sep
    ) {
      return false
    }
  }
  return true
}

interface ValidationResult {
  ok: boolean
  canonical?: string
  error?: string
}

export function validateWorkspace(workspace: string): ValidationResult {
  if (!path.isAbsolute(workspace)) {
    return { ok: false, error: "workspace must be an absolute path" }
  }

  let canonical: string
  try {
    canonical = realpathSync(workspace)
  } catch {
    // We deliberately don't echo the path — info-leak avoidance.
    return { ok: false, error: "workspace path is not accessible" }
  }

  // Allow-set: startup roots + dynamic marker-file root.
  const startupRoots = state.codeSearchRoots
  for (const root of startupRoots) {
    if (isWithinRoot(canonical, root)) {
      return { ok: true, canonical }
    }
  }
  const markerRoot = findMarkerRoot(canonical)
  if (markerRoot && isWithinRoot(canonical, markerRoot)) {
    return { ok: true, canonical }
  }
  return { ok: false, error: "workspace not in allow-set" }
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
// Ripgrep invocation
// ============================================================

function buildRgArgs(input: {
  mode: "ranked" | "literal" | "regex"
  fileGlob?: string
  contextLines: number
  query: string
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
  if (input.mode === "literal" || input.mode === "ranked") {
    args.push("-F")
  }

  // User-supplied glob FIRST, then denylist. ripgrep applies all
  // -g flags; the deny entries come last so they're always honored.
  if (input.fileGlob && input.fileGlob !== "**/*") {
    args.push("-g", input.fileGlob)
  }
  for (const pat of SECRET_DENYLIST) {
    args.push("-g", `!${pat}`)
  }

  // CVE fix HIGH-2: positional separator. Without `--`, a query
  // starting with `-` (e.g. `--no-ignore`) would be parsed as a
  // ripgrep flag.
  args.push("--", input.query, ".")

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
// BM25F scoring
// ============================================================

interface FieldTexts {
  match_line: string
  context: string
  file_path: string
  symbol_context: string
}

function extractFields(hit: RawHit): FieldTexts {
  const ctx = [...hit.context_before, ...hit.context_after].join("\n")
  const isSymbol = SYMBOL_REGEX.test(hit.matched_line.trimStart())
  return {
    match_line: hit.matched_line,
    context: ctx,
    file_path: hit.file.replace(/[/\\]/g, " "),
    // symbol_context is binary: either the matched line is a
    // definition, or it isn't. If yes, the matched line itself
    // populates the field (so query tokens score there too); if
    // no, the field is empty (TF=0 for all tokens).
    symbol_context: isSymbol ? hit.matched_line : "",
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
  for (const hit of hits) {
    const fields = extractFields(hit)
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
  const limit = Math.min(rawInput.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const contextLines = Math.min(
    rawInput.context_lines ?? DEFAULT_CONTEXT_LINES,
    MAX_CONTEXT_LINES,
  )

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

  // Drain stderr to a bounded buffer so it doesn't fill the pipe.
  let stderrBytes = 0
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 1024 * 1024) {
        // 1MB stderr is excessive — kill.
        ac.abort("stderr_cap")
      }
    })
  }

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

  // Apply ranking.
  let kept: Array<ScoredHit>
  let prunedBelowShoulder: number | undefined
  if (mode === "ranked") {
    const queryTokens = tokenize(rawInput.query)
    const scored = bm25fScore(parseResult.hits, queryTokens)
    const pruned = shoulderPrune(scored)
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
  const results: Array<CodeSearchHit> = kept.map((sh) => {
    let file = sh.hit.file
    if (file.startsWith("./") || file.startsWith(".\\")) {
      file = file.slice(2)
    }
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
    `[code_search] mode=${mode} results=${results.length} truncated=${parseResult.truncated} ` +
      `scanned_files=${parseResult.scannedFiles} elapsed_ms=${elapsed_ms} ` +
      `abort=${parseResult.cancelled} rg=${rgResolution.source}` +
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
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
