/**
 * Unified, semantic-first code search; the single source of truth behind
 * BOTH the MCP `code` tool (`src/lib/peer-mcp-personas.ts`) and the worker
 * subagent's internal `code_search` tool (`src/lib/worker-agent/tools.ts`).
 *
 * Default behaviour (omitted mode or `mode:"semantic"`) ranks by MEANING
 * via ColBERT (colgrep) and TRANSPARENTLY falls back to lexical BM25F when
 * the per-workspace index isn't ready (building / stale / unavailable /
 * failed) or colgrep isn't provisioned on this host. The forced lexical
 * family (`lexical|exact|regex|ast`) never touches colgrep.
 *
 * Provenance is carried in a THREE-valued `source` field, independent of
 * `notice`:
 *   - "semantic"          colgrep ran and the index was fresh
 *   - "lexical"           the caller explicitly forced a lexical mode
 *   - "lexical-fallback"  a semantic/default query degraded to lexical
 *                         because the index wasn't ready
 * `notice` keeps the lexical backend's size-cap > structural priority, so
 * on a hit-heavy fallback the urgent size notice can win; `source` still
 * conveys "this was a fallback" unambiguously, and never conflates a
 * degraded result with a deliberately-forced lexical search.
 *
 * Contract split vs. `runSemanticSearch`: the runner itself stays
 * NO-FALLBACK (it returns honest status, never another engine). The
 * fallback lives only here, at the merged-tool layer.
 *
 * Import-cycle note: this module imports ONLY from `./code-search` and
 * `./colbert` (both leaves w.r.t. the worker-agent graph). It must NOT
 * import `./mcp-capabilities`; that would close a cycle through
 * `worker-agent`. The colbert-availability decision is read from the leaf
 * `colbertSearchEnabled()`.
 */

import { searchCode, type CodeSearchResponse } from "./code-search"
import { colbertSearchEnabled, runSemanticSearch } from "./colbert"
import type { SemanticSearchResult, SemanticStatus } from "./colbert/runner"

export type UnifiedMode = "semantic" | "lexical" | "exact" | "regex" | "ast"

export type UnifiedSource = "semantic" | "lexical" | "lexical-fallback"

export interface UnifiedCodeSearchInput {
  query: string
  workspace: string
  /** Omitted ⇒ `"semantic"`. */
  mode?: UnifiedMode
  file_glob?: string
  limit?: number
  context_lines?: number
  structural?: "full" | "topN"
  summary?: boolean
  complete?: boolean
  multiline?: boolean
  scan?: boolean
  ast_pattern?: string
  ast_lang?: string
  /** Semantic mode only: colgrep `-e` regex pre-filter. */
  pattern?: string
}

/**
 * Minimal union row. `role` appears only on lexical hits (AST-confirmed
 * definition); `endLine`/`name`/`score` only on `source:"semantic"` rows.
 */
export interface UnifiedResultRow {
  file: string
  line: number
  snippet: string
  role?: "definition"
  endLine?: number
  name?: string
  score?: number
}

export interface UnifiedCodeSearchResult {
  source: UnifiedSource
  results: Array<UnifiedResultRow>
  notice?: string
  /** Only ever present on the lexical path (semantic rows carry none). */
  outlines?: CodeSearchResponse["outlines"]
  truncated?: boolean
}

/** Map the unified mode onto `searchCode`'s internal `mode` enum. */
function lexicalSearchCodeMode(mode: UnifiedMode): "ranked" | "literal" | "regex" {
  switch (mode) {
    case "exact":
      return "literal"
    case "regex":
      return "regex"
    // "lexical", "ast", and the semantic-fallback path all rank.
    default:
      return "ranked"
  }
}

/** Status-specific, actionable fallback hint. */
function fallbackNoticeFor(status: SemanticStatus): string {
  switch (status) {
    case "building":
      return 'semantic index is building; returned lexical results. Retry mode:"semantic" shortly'
    case "stale":
      return 'semantic index predates the current HEAD/tree; returned lexical results. Retry mode:"semantic" after the background re-index'
    case "unavailable":
      return 'no semantic index for this workspace yet (a background build was started); returned lexical results. Retry mode:"semantic" shortly'
    case "failed":
      return "semantic index build failed for this workspace; returned lexical results"
    default:
      return "returned lexical results"
  }
}

/**
 * Combine the lexical backend's own notice (size-cap / structural, the
 * urgent "you're missing results" signal) with a fallback hint, keeping a
 * single string. The lexical notice stays primary; the hint is appended so
 * neither is lost.
 */
function joinNotice(
  primary: string | undefined,
  secondary: string | undefined,
): string | undefined {
  if (primary && secondary) return `${primary} (${secondary})`
  // `||` (not `??`) so an empty-string primary still yields the secondary.
  return primary || secondary || undefined
}

async function runLexical(
  input: UnifiedCodeSearchInput,
  mode: UnifiedMode,
  source: UnifiedSource,
  signal?: AbortSignal,
): Promise<UnifiedCodeSearchResult> {
  const isAst = mode === "ast"
  const resp = await searchCode(
    {
      query: input.query,
      workspace: input.workspace,
      mode: lexicalSearchCodeMode(mode),
      file_glob: input.file_glob,
      limit: input.limit,
      context_lines: input.context_lines,
      structural: input.structural,
      summary: input.summary,
      complete: input.complete,
      multiline: input.multiline,
      scan: input.scan,
      ast_pattern: isAst ? input.ast_pattern : undefined,
      ast_lang: isAst ? input.ast_lang : undefined,
    },
    signal,
  )
  return {
    source,
    results: resp.results.map((h) => ({
      file: h.file,
      line: h.line,
      snippet: h.snippet,
      ...(h.role ? { role: h.role } : {}),
    })),
    notice: resp.notice ?? undefined,
    outlines: resp.outlines,
    truncated: resp.truncated,
  }
}

/**
 * Route a unified code-search request. Throws only on input/workspace
 * validation failure (propagated from `searchCode`); callers wrap in
 * try/catch exactly as they do today for `searchCode`.
 */
export async function runUnifiedCodeSearch(
  input: UnifiedCodeSearchInput,
  signal?: AbortSignal,
): Promise<UnifiedCodeSearchResult> {
  const mode: UnifiedMode = input.mode ?? "semantic"

  // Forced lexical family; never touch colgrep.
  if (mode !== "semantic") {
    return runLexical(input, mode, "lexical", signal)
  }

  // Semantic / default. If colgrep isn't attemptable on this host, go
  // straight to lexical (labelled as a fallback so the caller knows it
  // didn't get a meaning-ranked result).
  if (!colbertSearchEnabled()) {
    const r = await runLexical(input, "lexical", "lexical-fallback", signal)
    return {
      ...r,
      notice: joinNotice(
        r.notice,
        "semantic search unavailable on this host; returned lexical results",
      ),
    }
  }

  // The runner returns honest statuses, but a transport/internal error
  // could still throw; the merged tool's "transparent fallback" promise
  // must hold even then, so guard the call and fall back to lexical.
  let sem: SemanticSearchResult
  try {
    sem = await runSemanticSearch({
      query: input.query,
      workspace: input.workspace,
      limit: input.limit,
      pattern: input.pattern,
      signal,
    })
  } catch {
    const r = await runLexical(input, "lexical", "lexical-fallback", signal)
    return {
      ...r,
      notice: joinNotice(
        r.notice,
        "semantic search errored; returned lexical results",
      ),
    }
  }

  if (sem.status === "ready") {
    return {
      source: "semantic",
      results: (sem.results ?? []).map((r) => ({
        file: r.file,
        line: r.line,
        snippet: r.snippet,
        ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.score !== undefined ? { score: r.score } : {}),
      })),
      ...(sem.notice ? { notice: sem.notice } : {}),
    }
  }

  // building | stale | unavailable | failed → transparent lexical fallback.
  const r = await runLexical(input, "lexical", "lexical-fallback", signal)
  return {
    ...r,
    notice: joinNotice(r.notice, fallbackNoticeFor(sem.status)),
  }
}
