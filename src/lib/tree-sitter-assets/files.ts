/** WASM assets code search loads from tree-sitter-wasms. */
export const TREE_SITTER_GRAMMAR_FILES: Readonly<Record<string, string>> = {
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

export const TREE_SITTER_RUNTIME_FILE = "tree-sitter.wasm"
