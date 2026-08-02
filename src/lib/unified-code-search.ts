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

import path from "node:path"

import { searchCode, type CodeSearchResponse } from "./code-search"
import { colbertSearchEnabled, runSemanticSearch } from "./colbert"
import type { SemanticSearchResult, SemanticStatus } from "./colbert/runner"
import { outlineFile } from "./tree-sitter-grammars"

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
  /** Navigable declarations for up to the first 10 distinct result files. */
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

/**
 * Status-specific, actionable fallback hint. The semantic index isn't ready,
 * so the model got LEXICAL results (great for exact symbols, sparse for a
 * natural-language phrase since the lexical backend matches literally). Tell
 * it both levers: retry `mode:"semantic"` shortly (the index is self-healing
 * in the background) OR re-query now with specific symbol/keyword terms.
 */
/**
 * Per-file cap on outline entries in a SEARCH response.
 *
 * `outlineFile`'s own cap is 1000 symbols, which is right for a deliberate
 * outline of one file the caller asked for. It is far too high here: outlines
 * are attached to up to 10 files the caller did NOT ask for, as orientation
 * alongside the hits. A single large test file can contribute hundreds of
 * entries and dominate the response, which is the opposite of the compact map
 * this field is supposed to be — the caller pays that context whether or not
 * they ever open the file.
 *
 * Capped rather than removed because the map itself is useful; only its tail
 * is. The parser-level cap is deliberately left alone so other consumers of
 * `outlineFile` keep full fidelity.
 */
const MAX_OUTLINE_ENTRIES_PER_FILE = 60

const FALLBACK_GUIDANCE_MARKER = 'retry mode:"semantic"'
const FALLBACK_GUIDANCE =
  `${FALLBACK_GUIDANCE_MARKER} shortly, or re-query now with specific symbol/keyword terms`

function fallbackNoticeFor(status: SemanticStatus): string {
  const tail = FALLBACK_GUIDANCE
  switch (status) {
    case "building":
      return `semantic index is building; returned lexical keyword matches — ${tail}`
    case "stale":
      return `semantic index predates the current HEAD/tree (a background re-index was started); returned lexical keyword matches — ${tail}`
    case "unavailable":
      return `no semantic index for this workspace yet (a background build was started); returned lexical keyword matches — ${tail}`
    case "failed":
      return `semantic index unavailable (build failing — see proxy logs); returned lexical keyword matches — ${tail}`
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

/** Preserve runner-specific context while guaranteeing actionable guidance once. */
function semanticFallbackNotice(sem: SemanticSearchResult): string {
  if (!sem.notice) return fallbackNoticeFor(sem.status)
  if (sem.notice.includes(FALLBACK_GUIDANCE_MARKER)) return sem.notice
  return `${sem.notice} — ${FALLBACK_GUIDANCE}`
}

async function outlinesForSemanticResults(
  input: UnifiedCodeSearchInput,
  results: Array<UnifiedResultRow>,
  signal?: AbortSignal,
): Promise<CodeSearchResponse["outlines"]> {
  if (input.summary === false) return undefined
  const seen = new Set<string>()
  const files: Array<string> = []
  for (const result of results) {
    if (seen.has(result.file)) continue
    seen.add(result.file)
    files.push(result.file)
    if (files.length >= 10) break
  }

  const outlines: NonNullable<CodeSearchResponse["outlines"]> = []
  const deadline = Date.now() + 2000
  const workspace = path.resolve(input.workspace)
  for (const file of files) {
    if (signal?.aborted || Date.now() > deadline) break
    const abs = path.resolve(workspace, file)
    const rel = path.relative(workspace, abs)
    // Semantic rows should already be workspace-relative. Fail closed if a
    // malformed/upstream row is absolute or escapes rather than outlining an
    // unrelated file outside the caller's workspace.
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
    const outlined = await outlineFile(abs, signal)
    outlines.push({
      file,
      outline: outlined.outline.slice(0, MAX_OUTLINE_ENTRIES_PER_FILE),
    })
  }
  return outlines
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
    notice: joinNotice(resp.notice ?? undefined, emptyPhraseHint(input, resp.results.length)),
    outlines: resp.outlines,
    truncated: resp.truncated,
  }
}

/**
 * Hint emitted when a multi-word lexical query matches nothing.
 *
 * Observed, and only this much is verified: a natural-language multi-word query
 * can return `results: []` on this backend even when the individual words all
 * appear in the repository, and the same question answered instantly via a
 * single identifier or a plain `Grep`. A blind capability audit hit exactly that
 * on a real lookup and concluded the code did not exist.
 *
 * The mechanism is NOT fully characterised. The audit proposed contiguous-phrase
 * matching; that explanation does not survive testing, because other multi-word
 * queries whose words are spread across lines do return hits. So this hint
 * deliberately describes the SYMPTOM and the recovery, and claims nothing about
 * the cause.
 *
 * It is worth emitting regardless of mechanism: a bare empty result reads as
 * "not in this repository" rather than "that query shape did not work", and this
 * project's own guidance steers callers here before `Grep`. A silently empty
 * result is worse than a missing tool, because a missing tool routes you
 * elsewhere and an empty one convinces you. The advice it gives (retry a single
 * identifier, or use regex) is correct for a genuine no-match too, so the hint
 * costs nothing when the repository really lacks the term.
 */
function emptyPhraseHint(
  input: UnifiedCodeSearchInput,
  hitCount: number,
): string | undefined {
  if (hitCount > 0) return undefined
  if (input.mode === "regex" || input.mode === "ast") return undefined
  const terms = input.query.trim().split(/\s+/).filter(Boolean)
  if (terms.length < 2) return undefined
  // Suggest a term that is actually retryable. Naively taking the last token
  // recommends `sized?` for "where is the timeout sized?", which is punctuation
  // noise and would produce a second false negative — the exact failure this
  // hint exists to prevent. Strip non-identifier characters, keep only tokens
  // that survive as identifiers, and prefer the longest (the most specific
  // symbol-like word). If nothing qualifies, give the advice without an example
  // rather than a bad one.
  const candidate = terms
    .map((t) => t.replace(/[^A-Za-z0-9_]/g, ""))
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))
    .sort((a, b) => b.length - a.length)[0]
  const retry = candidate ? ` (e.g. \`${candidate}\`)` : ""
  return (
    `no hits for a multi-word query. This can happen even when the words all `
    + `appear in the repository, so do NOT read this as "not present". Retry with a `
    + `single identifier${retry}, or use \`mode: "regex"\` or grep, before `
    + `concluding the code is absent.`
  )
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
    const results = (sem.results ?? []).map((r) => ({
      file: r.file,
      line: r.line,
      snippet: r.snippet,
      ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.score !== undefined ? { score: r.score } : {}),
    }))
    return {
      source: "semantic",
      results,
      outlines: await outlinesForSemanticResults(input, results, signal),
      ...(sem.notice ? { notice: sem.notice } : {}),
    }
  }

  // building | stale | unavailable | failed → transparent lexical fallback.
  const r = await runLexical(input, "lexical", "lexical-fallback", signal)
  return {
    ...r,
    notice: joinNotice(r.notice, semanticFallbackNotice(sem)),
  }
}
