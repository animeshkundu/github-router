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
 * Under `--bluebird` (`state.bluebirdEnabled`), the `semantic` and
 * `lexical` modes route through
 * the Bluebird Azure DevOps MCP server instead (the unified `code_search`
 * tool, with legacy tool-name compatibility); `exact|regex|ast` stay local, and
 * Bluebird errors surface as `source:"error"` with NO silent local
 * fallback.
 *
 * Provenance is carried in a FOUR-valued `source` field, independent of
 * `notice`:
 *   - "semantic"          colgrep/Bluebird ran and the index was fresh
 *   - "lexical"           the caller explicitly forced a lexical mode
 *   - "lexical-fallback"  a semantic/default query degraded to lexical
 *                         because the index wasn't ready
 *   - "error"             the Bluebird backend failed after retries; the
 *                         response carries `notice` with the cause
 * `notice` keeps the lexical backend's size-cap > structural priority, so
 * on a hit-heavy fallback the urgent size notice can win; `source` still
 * conveys "this was a fallback" unambiguously, and never conflates a
 * degraded result with a deliberately-forced lexical search.
 *
 * Contract split vs. `runSemanticSearch`: the runner itself stays
 * NO-FALLBACK (it returns honest status, never another engine). The
 * fallback lives only here, at the merged-tool layer.
 *
 * Import-cycle note: this module imports ONLY from `./code-search`,
 * `./colbert`, `./bluebird-client`, and `./state`. It must NOT import
 * `./mcp-capabilities`; that would close a cycle through `worker-agent`.
 * The colbert-availability decision is read from the leaf
 * `colbertSearchEnabled()`. (`./state` reaches `./bluebird-client` by
 * type-only import, and `./bluebird-client` reaches this module by
 * type-only import, so neither edge exists at runtime.)
 */

import path from "node:path"

import { BluebirdError, ensureBluebirdClient } from "./bluebird-client"
import {
  MAX_OUTLINE_ENTRIES_PER_FILE,
  searchCode,
  validateWorkspace,
  type CodeSearchResponse,
} from "./code-search"
import { colbertSearchEnabled, runSemanticSearch, runServiceSearch, serviceBackendEnabled } from "./colbert"
import type { SemanticSearchResult, SemanticStatus } from "./colbert/runner"
import { state } from "./state"
import { outlineFile } from "./tree-sitter-grammars"

export type UnifiedMode = "semantic" | "lexical" | "exact" | "regex" | "ast"

export type UnifiedSource = "semantic" | "lexical" | "lexical-fallback" | "error"

export interface UnifiedCodeSearchInput {
  query: string
  workspace: string
  /** Omitted ⇒ `"semantic"`. */
  mode?: UnifiedMode
  file_glob?: string
  limit?: number
  context_lines?: number
  structural?: "full" | "topN"
  /** Per-result outlines are on by default; `false` omits them. */
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
  /**
   * Freshness of `source:"semantic"` results. `"stale"` = served from an
   * index predating a small content delta (see `stale_files`); the model
   * should re-query shortly or drop to lexical for exactness. Absent on
   * lexical rows (ripgrep always reads the live tree) and on fresh rows.
   */
  freshness?: "fresh" | "stale"
  /** Files changed since the index (present iff freshness is "stale"). */
  stale_files?: number
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
 * it both levers: retry `mode:"semantic"` (the index is self-healing in the
 * background) OR re-query now with specific symbol/keyword terms.
 *
 * "shortly" was too vague and cost a real recovery. A build takes MINUTES on a
 * large repo, and after a failed build the FIRST query is consumed triggering
 * the re-kick and still returns a fallback. So a caller who retried once,
 * seconds later, saw a second fallback and concluded the tool was broken
 * rather than mid-repair. Observed end to end on this repo: query, then
 * ~5 minutes of `building`, then `ready`. Naming the timescale and the
 * one-query-to-trigger behaviour is what turns "it's still broken" into
 * "it's coming back".
 *
 * The wording stays a range rather than a number: build time scales with
 * repository size, so a hard figure would be wrong for most callers.
 */

const FALLBACK_GUIDANCE_MARKER = 'retry mode:"semantic"'
const FALLBACK_GUIDANCE =
  `${FALLBACK_GUIDANCE_MARKER} in minutes or use exact symbols`

function fallbackNoticeFor(status: SemanticStatus): string {
  const tail = FALLBACK_GUIDANCE
  switch (status) {
    case "building":
      return `semantic index building — returned lexical matches; ${tail}`
    case "stale":
      return `semantic index stale (HEAD moved) — re-index started, returned lexical matches; ${tail}`
    case "unavailable":
      return `no semantic index yet — build started, returned lexical matches; ${tail}`
    case "failed":
      // The recovery path most likely to be misread as a dead tool: this very
      // query is what schedules the rebuild, so it CANNOT return semantic
      // results itself. Say so, or the next fallback reads as no progress.
      return `semantic index failed — this query started a background rebuild, returned lexical matches; ${tail}`
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
    const normalized = file.replaceAll("\\", "/").replace(/^\/+/, "")
    if (!normalized || normalized.includes("\0") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) continue
    if (normalized.split("/").some((part) => part === "..")) continue
    const abs = path.resolve(workspace, normalized)
    const rel = path.relative(workspace, abs)
    // Semantic rows should already be workspace-relative. Fail closed if a
    // malformed/upstream row is absolute or escapes rather than outlining an
    // unrelated file outside the caller's workspace.
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
    try {
      const outlined = await outlineFile(abs, signal)
      outlines.push({
        file: normalized,
        outline: outlined.outline.slice(0, MAX_OUTLINE_ENTRIES_PER_FILE),
      })
    } catch {
      // Outline enrichment is optional; preserve the valid remote hit.
    }
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
 * Bluebird backend for the `semantic` and `lexical` modes. `exact|regex|ast`
 * never reach here (they stay local by contract). Errors surface as
 * `source:"error"` — the `--bluebird` promise is "Bluebird or a visible
 * error", never a silent local fallback that would mask an auth/outage
 * problem as a relevance problem.
 */
async function runBluebird(
  input: UnifiedCodeSearchInput,
  mode: "semantic" | "lexical",
  signal?: AbortSignal,
): Promise<UnifiedCodeSearchResult> {
  const limit = input.limit ?? 200
  try {
    const workspace = validateWorkspace(input.workspace)
    if (!workspace.ok || !workspace.canonical) {
      throw new Error(workspace.error ?? "workspace path is not accessible")
    }
    // Lazy provision against the query's workspace ("the repo we are
    // working with"). The runtime-owned manager isolates workspaces and
    // scopes; it is not selected through process-global state.
    const client = await ensureBluebirdClient(workspace.canonical, signal)
    const rows = mode === "semantic"
      ? await client.doVectorSearch(input.query, {
        limit,
        file_glob: input.file_glob,
        signal,
      })
      : await client.searchFileContent(input.query, {
        limit,
        file_glob: input.file_glob,
        signal,
      })
    const results = rows.slice(0, limit).map((r) => ({
      file: r.file,
      line: r.line,
      snippet: r.snippet,
      ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.score !== undefined ? { score: r.score } : {}),
    }))
    const outlines = await outlinesForSemanticResults(input, results, signal)
    return {
      source: mode,
      results,
      ...(outlines ? { outlines } : {}),
    }
  } catch (err) {
    if (signal?.aborted) throw err
    const detail = err instanceof BluebirdError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
    return {
      source: "error",
      results: [],
      notice:
        `Bluebird ${mode} search failed: ${detail} `
        + `(no local fallback under --bluebird; retry, or use mode:"exact"/"regex"/"ast" for the local engine)`,
    }
  }
}

/**
 * Route a unified code-search request. Throws only on input/workspace
 * validation failure (propagated from `searchCode`); callers wrap in
 * try/catch exactly as they do today for `searchCode`.
 *
 * Under `--bluebird` (initialized client present), `semantic` (the
 * default) and `lexical` route through Bluebird; `exact|regex|ast` stay
 * local. Bluebird failures return `source:"error"` with the cause in
 * `notice` — never a silent local fallback.
 */
export async function runUnifiedCodeSearch(
  input: UnifiedCodeSearchInput,
  signal?: AbortSignal,
): Promise<UnifiedCodeSearchResult> {
  const mode: UnifiedMode = input.mode ?? "semantic"

  // --bluebird: semantic (default) and lexical route through Bluebird;
  // exact|regex|ast stay local (see runBluebird).
  if (state.bluebirdEnabled === true && (mode === "semantic" || mode === "lexical")) {
    return runBluebird(input, mode, signal)
  }

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
        "semantic search is off (launch with --search to enable); returned lexical results",
      ),
    }
  }

  // Service backend first (opt-in via GH_ROUTER_SEMANTIC_BACKEND=service).
  // Fallback chain: service → colgrep CLI → lexical. Any service miss
  // falls THROUGH to the colgrep path below, never straight to lexical,
  // so a half-provisioned service degrades gracefully instead of hiding
  // a working colgrep index.
  if (serviceBackendEnabled()) {
    try {
      const svc = await runServiceSearch({
        query: input.query,
        workspace: input.workspace,
        limit: input.limit,
        signal,
      })
      if (svc.status === "ready") {
        const results = (svc.results ?? []).map((r) => ({
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
          ...(svc.freshness ? { freshness: svc.freshness } : {}),
          ...(svc.stale_files !== undefined ? { stale_files: svc.stale_files } : {}),
        }
      }
    } catch {
      // fall through to the colgrep path
    }
  }

  // The runner returns honest statuses, but a transport/internal error
  // could still throw; the merged tool's "transparent fallback" promise
  // must hold even then, so guard the call and fall back to lexical.
  // serveStale: an LLM editing session dirties the tree constantly; a
  // refuse-when-stale policy would make semantic permanently unavailable
  // during those sessions. Small content deltas serve labeled.
  let sem: SemanticSearchResult
  try {
    sem = await runSemanticSearch({
      query: input.query,
      workspace: input.workspace,
      limit: input.limit,
      pattern: input.pattern,
      signal,
      serveStale: true,
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
      // Serve-while-stale labels: the model must know when results predate
      // recent edits (it can re-query or drop to lexical for exactness).
      ...(sem.freshness ? { freshness: sem.freshness } : {}),
      ...(sem.stale_files !== undefined ? { stale_files: sem.stale_files } : {}),
    }
  }

  // building | stale | unavailable | failed → transparent lexical fallback.
  const r = await runLexical(input, "lexical", "lexical-fallback", signal)
  return {
    ...r,
    notice: joinNotice(r.notice, semanticFallbackNotice(sem)),
  }
}
