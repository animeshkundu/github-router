/**
 * Shared tree-sitter grammar layer.
 *
 * This module is the pure grammar-loading + constant-table layer
 * extracted from `src/lib/code-search.ts`. It owns:
 *
 *   - the extension → language and language → wasm-filename tables,
 *   - the per-language definition-node-type sets and the shared
 *     identifier-node-type set,
 *   - the lazy `web-tree-sitter` `Parser.init()` + grammar-load cache
 *     (`getGrammarBundle`), pre-warmed at module import time, and
 *   - `outlineFile`, a full structural outline of a single file.
 *
 * The BM25F scoring, the structural-confirmation pass, and the parsed-
 * tree LRU stay in `code-search.ts` — they are tightly coupled to the
 * ranking flow and would not survive a clean move. `code-search.ts`
 * imports the symbols here and continues to call the same functions, so
 * the extraction is behavior-preserving for the structural pass.
 *
 * There is exactly ONE `Parser.init()` and ONE grammar cache across the
 * whole process: every caller (the structural pass, `outlineFile`)
 * awaits the same `getGrammarBundle().ready` promise.
 */

import * as path from "node:path"
import { statSync } from "node:fs"
import { readFile } from "node:fs/promises"

import consola from "consola"
import Parser from "web-tree-sitter"

// ============================================================
// Constants
// ============================================================

/**
 * Cap the per-file size we'll parse. 1MB of source covers all
 * reasonable hand-written files; bigger files are almost always
 * generated code or vendored bundles whose AST signal is worthless
 * for ranking real definitions.
 */
export const STRUCTURAL_MAX_FILE_BYTES = 1024 * 1024

// ============================================================
// Language / grammar tables
// ============================================================

/**
 * Extension → grammar key. Grammars not in this map skip structural
 * parsing (the hit falls back to the regex SYMBOL_REGEX heuristic for
 * `symbol_context`). Keep this list aligned with `GRAMMAR_FILES`
 * below — adding a language requires both an extension mapping and a
 * `.wasm` to load.
 */
export const EXTENSION_TO_LANG: Readonly<Record<string, string>> = {
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
export const GRAMMAR_FILES: Readonly<Record<string, string>> = {
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
export const DEFINITION_NODE_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
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
export const IDENTIFIER_NODE_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier_pattern",
  "shorthand_property_identifier",
  "scoped_identifier",
  "name",
])

/**
 * Extension → grammar key resolution. Returns `null` for files with no
 * grammar (the caller falls back to the regex heuristic / skips the
 * structural pass).
 */
export function getLanguageKeyForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TO_LANG[ext] ?? null
}

// ============================================================
// Grammar loading (single shared Parser.init + cache)
// ============================================================

export interface GrammarBundle {
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
export function resolveGrammarRoot(): string | null {
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
export function getGrammarBundle(): GrammarBundle {
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

// ============================================================
// File outline (full structural definition tree)
// ============================================================

/**
 * Robustness bound on outline entries per file. Normal source is far
 * under it; generated/pathological files hit it and `outlineFile` then
 * sets a `notice` so the model knows the map was truncated.
 */
const MAX_OUTLINE_ENTRIES = 1000

export interface FileOutlineEntry {
  kind: string
  name: string
  line: number
  /** Definition nesting depth: 0 = top-level, 1 = member of a top-level
   *  definition (e.g. a class method), 2 = nested inside that, … */
  depth: number
}

export interface FileOutlineResult {
  outline: Array<FileOutlineEntry>
  language: string | null
  notice?: string
}

/**
 * First identifier-typed named child found in a pre-order walk. Mirrors
 * the structural-pass helper in `code-search.ts` (kept local here so
 * the grammar module has no dependency back on the ranking layer).
 */
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

/**
 * Derive a human-readable name for a definition node. Tries the
 * grammar's standard `name` field first, then the `declarator` /
 * `type` fields (C/C++/Java declarators, Rust/Go type specs), then any
 * identifier-typed named child as a last resort. Returns `null` when no
 * name can be recovered — the caller skips such nodes.
 */
function deriveDefinitionName(node: Parser.SyntaxNode): string | null {
  const nameField = node.childForFieldName("name")
  if (nameField && nameField.text.length > 0) return nameField.text

  const declarator = node.childForFieldName("declarator")
  if (declarator) {
    const leaf = firstIdentifierLeaf(declarator)
    if (leaf && leaf.text.length > 0) return leaf.text
  }

  const typeField = node.childForFieldName("type")
  if (typeField) {
    const leaf = firstIdentifierLeaf(typeField)
    if (leaf && leaf.text.length > 0) return leaf.text
  }

  // Fall back to the first identifier-typed named child anywhere in the
  // subtree (handles grammars that don't expose a `name` field for a
  // given definition shape).
  const fallback = firstIdentifierLeaf(node)
  if (fallback && fallback.text.length > 0) return fallback.text

  return null
}

/**
 * Collect EVERY definition node from the parse tree — top-level AND
 * nested (class methods, methods' inner functions, nested classes, …) —
 * so the outline is a COMPLETE structural map the model can rely on to
 * decide what to read. Recurses through non-definition wrappers (TS
 * `export_statement`, Python `decorated_definition`, C++
 * `template_declaration`, …) at the same depth, and INTO each definition
 * at depth+1 to surface its members.
 *
 * `defTypes` is the language's definition-node-type set. Each node yields
 * one entry; the `name` is derived per `deriveDefinitionName` (a node
 * with no recoverable name is skipped, but the walk still descends into
 * it so its named members aren't lost). Bounded at `MAX_OUTLINE_ENTRIES`.
 */
function collectDefinitions(
  root: Parser.SyntaxNode,
  defTypes: ReadonlySet<string>,
  signal?: AbortSignal,
): Array<FileOutlineEntry> {
  const out: Array<FileOutlineEntry> = []

  const visit = (node: Parser.SyntaxNode, depth: number): void => {
    if (signal?.aborted || out.length >= MAX_OUTLINE_ENTRIES) return
    for (const child of node.namedChildren) {
      if (signal?.aborted || out.length >= MAX_OUTLINE_ENTRIES) return
      if (defTypes.has(child.type)) {
        const name = deriveDefinitionName(child)
        if (name !== null) {
          out.push({
            kind: child.type,
            name,
            line: child.startPosition.row + 1,
            depth,
          })
        }
        // Recurse INTO the definition to surface nested members — this
        // is the "don't miss" fix. A name-less definition is still
        // descended (at depth+1) so its members aren't dropped.
        visit(child, depth + 1)
        continue
      }
      // Non-definition wrapper (export/decorator/template/…) — recurse at
      // the SAME depth so the wrapped definition keeps its real level.
      visit(child, depth)
    }
  }

  visit(root, 0)
  return out
}

/**
 * Build a `FileOutlineResult` from an ALREADY-PARSED tree — walk-only,
 * no read / parse / `delete`. The tree's ownership stays with the caller
 * (e.g. the code-search structural pass's `_treeCache`), so this lets the
 * outline step REUSE a tree the structural pass already parsed instead of
 * re-reading + re-parsing the file. Never throws.
 */
export function outlineFromTree(
  tree: Parser.Tree,
  language: string,
  signal?: AbortSignal,
): FileOutlineResult {
  if (signal?.aborted) return { outline: [], language }
  const defTypes = DEFINITION_NODE_TYPES[language]
  if (!defTypes) {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }
  try {
    const outline = collectDefinitions(tree.rootNode, defTypes, signal)
    if (signal?.aborted) return { outline: [], language }
    // Order by line ascending. The walk is pre-order (parent before
    // child), and JS sort is stable, so a parent and its same-line first
    // member keep parent-first order.
    outline.sort((a, b) => a.line - b.line)
    if (outline.length >= MAX_OUTLINE_ENTRIES) {
      return {
        outline,
        language,
        notice: `outline truncated at ${MAX_OUTLINE_ENTRIES} symbols (very large file)`,
      }
    }
    return { outline, language }
  } catch {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }
}

/**
 * Full structural outline of a single file — EVERY definition, top-level
 * AND nested (functions, classes, methods, nested functions, interfaces,
 * type aliases, enums, including exported / decorated / templated
 * wrappers). Each entry carries a `depth` (0 = top-level). Reuses the
 * shared grammar bundle and the same `Parser` the structural pass uses
 * — no second `Parser.init()`.
 *
 * Never throws. The failure modes are surfaced as `notice` strings with
 * an empty `outline`:
 *   - unsupported file type → `language: null`, "no structural outline
 *     for this file type"
 *   - file larger than the 1 MiB parse cap → `language` set, "file too
 *     large for structural outline"
 *   - any parse error / grammar-load miss → `language` set, "outline
 *     unavailable (parse error)"
 *
 * Honors `signal`: bails cleanly (empty outline, no notice) when the
 * caller aborts before/while parsing.
 */
export async function outlineFile(
  absPath: string,
  signal?: AbortSignal,
): Promise<FileOutlineResult> {
  if (signal?.aborted) return { outline: [], language: null }

  // 1. Language detection. Unsupported types never reach the parser.
  const language = getLanguageKeyForPath(absPath)
  if (!language) {
    return {
      outline: [],
      language: null,
      notice: "no structural outline for this file type",
    }
  }

  // 2. Size gate. Bigger than the parse cap → skip (almost always
  //    generated / vendored code).
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }
  if (size > STRUCTURAL_MAX_FILE_BYTES) {
    return {
      outline: [],
      language,
      notice: "file too large for structural outline",
    }
  }

  if (signal?.aborted) return { outline: [], language }

  // 3. Grammar load. A missing grammar (init failure, prune) degrades
  //    gracefully to the parse-error notice rather than throwing.
  const grammars = await getGrammarBundle().ready
  if (signal?.aborted) return { outline: [], language }
  const lang = grammars.get(language)
  if (!lang) {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }

  const defTypes = DEFINITION_NODE_TYPES[language]
  if (!defTypes) {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }

  // 4. Read + parse + walk. Any failure → parse-error notice, never a
  //    throw. The Parser and Tree are freed in `finally` so native
  //    memory doesn't leak (outlineFile doesn't share the structural
  //    pass's tree cache).
  let source: string
  try {
    source = await readFile(absPath, "utf8")
  } catch {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
  }

  if (signal?.aborted) return { outline: [], language }

  let parser: Parser | null = null
  let tree: Parser.Tree | null = null
  try {
    parser = new Parser()
    parser.setLanguage(lang)
    tree = parser.parse(source)
    if (!tree) {
      return { outline: [], language, notice: "outline unavailable (parse error)" }
    }
    // Walk the freshly-parsed tree (the `finally` below frees it).
    return outlineFromTree(tree, language, signal)
  } catch {
    return { outline: [], language, notice: "outline unavailable (parse error)" }
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
