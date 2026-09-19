/**
 * Semantic code-unit extraction (Phase 2b).
 *
 * The next-plaid service is a generic multi-vector document store — unlike
 * colgrep it does NOT parse code. This module owns the code-aware half:
 * tree-sitter parsing (reusing the warm grammar bundle + definition tables
 * from `~/lib/tree-sitter-grammars`), unit scoping (top-level + class-like
 * members — the same navigable scope as outlines), and structured-text
 * construction for embedding.
 *
 * Unit text mirrors colgrep's high-signal layers with the cheap subset:
 * name, signature (first line), leading doc comment, normalized file path,
 * and capped body. Call-graph / data-flow layers are deliberately omitted
 * in v1 (that analysis is computed by colgrep but never returned in our
 * responses today — see the Phase 2 plan — so nothing observable is lost).
 *
 * Pure file-level functions (no index state here): the service owns
 * storage/incremental logic; the freshness sidecar owns per-file hashes.
 * `extractUnits` never throws — per-file failures surface as `notice`.
 */

import { readFile } from "node:fs/promises"
import { statSync } from "node:fs"

import {
  collectUnitNodes,
  DEFINITION_NODE_TYPES,
  getGrammarBundle,
  getLanguageKeyForPath,
  STRUCTURAL_MAX_FILE_BYTES,
} from "~/lib/tree-sitter-grammars"
import { Parser } from "web-tree-sitter"

/** Max unit body chars embedded (~500 tokens). Longer bodies truncate. */
export const UNIT_MAX_BODY_CHARS = 2000
/** Max signature chars (first line(s) of the unit). */
const UNIT_MAX_SIGNATURE_CHARS = 300

export interface CodeUnit {
  /** Stable within a file: `${relPath}:${line}:${name}`. */
  unit_id: string
  /** Workspace-relative path with forward slashes. */
  file: string
  name: string
  /** Tree-sitter node type (function_definition, class_declaration, …). */
  kind: string
  /** 1-indexed start line. */
  line: number
  /** 1-indexed end line (inclusive). */
  end_line: number
  /** First source line of the unit (the declaration signature). */
  signature: string
  /** Full unit text, capped at UNIT_MAX_BODY_CHARS. */
  code: string
  /** Leading doc comment lines, if any (JSDoc / docstring / XML doc). */
  docstring?: string
}

export interface ExtractUnitsResult {
  units: Array<CodeUnit>
  language: string | null
  notice?: string
}

/**
 * Normalize a file path for embedding: separators → spaces, snake_case /
 * CamelCase split (mirrors colgrep's path normalization AND the BM25F
 * `file_path` field, so lexical and semantic agree on path tokens).
 * `src/utils/HttpClient.ts` → `src utils Http Client ts`.
 */
export function normalizePathForEmbedding(relPath: string): string {
  const noSep = relPath.replace(/[/\\]/g, " ")
  const noExt = noSep.replace(/\.[A-Za-z0-9]+$/, " $&")
  return noExt
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .flatMap((piece) => {
      const parts = piece.match(
        /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g,
      )
      return parts ?? [piece]
    })
    .join(" ")
}

/**
 * Leading doc comment for the unit starting at 1-indexed `startLine`:
 * consecutive comment-ish lines directly above (//, #, *, <!--, """, ''',
 * ///), blank-line-terminated. Language-agnostic and AST-free — runs on
 * raw source lines so it needs no per-language comment grammar.
 */
export function leadingDocComment(
  sourceLines: ReadonlyArray<string>,
  startLine1: number,
): string | undefined {
  const out: Array<string> = []
  for (let i = startLine1 - 2; i >= 0; i--) {
    const line = sourceLines[i].trim()
    if (line.length === 0) break
    if (
      line.startsWith("//")
      || line.startsWith("#")
      || line.startsWith("*")
      || line.startsWith("<!--")
      || line.startsWith('"""')
      || line.startsWith("'''")
    ) {
      out.unshift(sourceLines[i].trim())
      if (out.length >= 10) break
    } else {
      break
    }
  }
  return out.length > 0 ? out.join("\n") : undefined
}

/**
 * Structured text for one unit — what gets embedded. Field order mirrors
 * colgrep's (name → signature → description → path → code) so ranking
 * behavior stays close to the ColBERT sidecar it replaces.
 */
export function buildUnitText(unit: CodeUnit, relPath: string): string {
  const parts = [`${labelForKind(unit.kind)}: ${unit.name}`]
  if (unit.signature && unit.signature !== unit.name) {
    parts.push(`Signature: ${unit.signature}`)
  }
  if (unit.docstring) parts.push(`Description: ${unit.docstring}`)
  parts.push(`File: ${normalizePathForEmbedding(relPath)}`)
  parts.push(`Code:\n${unit.code}`)
  return parts.join("\n")
}

function labelForKind(kind: string): string {
  if (kind.includes("class")) return "Class"
  if (kind.includes("interface")) return "Interface"
  if (kind.includes("struct")) return "Struct"
  if (kind.includes("enum")) return "Enum"
  if (kind.includes("namespace") || kind.includes("module")) return "Namespace"
  if (kind.includes("method") || kind.includes("function")) return "Function"
  if (kind.includes("property")) return "Property"
  if (kind.includes("field")) return "Field"
  return "Symbol"
}

/**
 * Extract indexable units from one file. Read + parse + walk; frees the
 * tree before returning (units carry plain strings, never live nodes).
 * Never throws — failures surface as `notice` with empty `units`.
 */
export async function extractUnits(
  absPath: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<ExtractUnitsResult> {
  if (signal?.aborted) return { units: [], language: null }
  const language = getLanguageKeyForPath(absPath)
  if (!language) {
    return { units: [], language: null, notice: "no grammar for this file type" }
  }
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    return { units: [], language, notice: "unreadable file" }
  }
  if (size > STRUCTURAL_MAX_FILE_BYTES) {
    return { units: [], language, notice: "file too large" }
  }
  const grammars = await getGrammarBundle().ready
  if (signal?.aborted) return { units: [], language }
  const lang = grammars.get(language)
  const defTypes = DEFINITION_NODE_TYPES[language]
  if (!lang || !defTypes) {
    return { units: [], language, notice: "grammar unavailable" }
  }
  let source: string
  try {
    source = await readFile(absPath, "utf8")
  } catch {
    return { units: [], language, notice: "unreadable file" }
  }
  if (signal?.aborted) return { units: [], language }

  let parser: Parser | null = null
  let tree: import("web-tree-sitter").Tree | null = null
  try {
    parser = new Parser()
    parser.setLanguage(lang)
    tree = parser.parse(source)
    if (!tree) return { units: [], language, notice: "parse failed" }
    const sourceLines = source.split("\n")
    const slashRel = relPath.replace(/\\/g, "/")
    const units: Array<CodeUnit> = []
    for (const u of collectUnitNodes(tree.rootNode, defTypes, signal)) {
      if (signal?.aborted) break
      const line = u.node.startPosition.row + 1
      const endLine = u.node.endPosition.row + 1
      const firstLine = (sourceLines[line - 1] ?? "").trim().slice(0, UNIT_MAX_SIGNATURE_CHARS)
      const body = u.node.text.length > UNIT_MAX_BODY_CHARS
        ? u.node.text.slice(0, UNIT_MAX_BODY_CHARS) + "\n…[truncated]"
        : u.node.text
      units.push({
        unit_id: `${slashRel}:${line}:${u.name}`,
        file: slashRel,
        name: u.name,
        kind: u.kind,
        line,
        end_line: endLine,
        signature: firstLine,
        code: body,
        ...(leadingDocComment(sourceLines, line) !== undefined
          ? { docstring: leadingDocComment(sourceLines, line) as string }
          : {}),
      })
    }
    // Deterministic order: line ascending (walk is pre-order; stable sort
    // keeps parent-before-child on ties, matching outline ordering).
    units.sort((a, b) => a.line - b.line)
    return { units, language }
  } catch {
    return { units: [], language, notice: "parse failed" }
  } finally {
    if (tree) {
      try {
        tree.delete()
      } catch {
        // already collected
      }
    }
    if (parser) {
      try {
        parser.delete()
      } catch {
        // already collected
      }
    }
  }
}
