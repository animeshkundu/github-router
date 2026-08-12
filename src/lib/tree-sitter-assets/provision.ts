/*
 * Copy the tree-sitter runtime WASM and the grammar subset code search uses
 * out of the package tree and into APP_DIR.
 *
 * bunx commonly installs packages under the OS temp directory. Temp reapers
 * can remove those files while leaving the directory skeleton, so resolving
 * node_modules again is not a durability strategy. The stable copies here are
 * best-effort fallbacks: initial startup can still use node_modules, while a
 * later startup survives after that tree has been reaped.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import consola from "consola"

import { PATHS } from "../paths"
import {
  TREE_SITTER_GRAMMAR_FILES,
  TREE_SITTER_RUNTIME_FILE,
} from "./files"

const PUBLISH_ATTEMPTS = 3

let _provisioned = false
let _inFlight: Promise<void> | undefined

/** @internal — reset module state between test cases. */
export function __resetTreeSitterAssetsForTests(): void {
  _provisioned = false
  _inFlight = undefined
}

/**
 * Materialize every required WASM asset. Single-flight and success-cached;
 * transient failures remain retryable. Never throws to the launcher.
 */
export function provisionTreeSitterAssets(): Promise<void> {
  if (_provisioned) return Promise.resolve()
  if (_inFlight) return _inFlight
  _inFlight = Promise.resolve()
    .then(() => provisionImpl())
    .then((complete) => {
      if (complete) _provisioned = true
    })
    .finally(() => {
      _inFlight = undefined
    })
  return _inFlight
}

function provisionImpl(): boolean {
  try {
    const require = createRequire(import.meta.url)
    const grammarPackage = require.resolve("tree-sitter-wasms/package.json")
    const grammarRoot = path.join(path.dirname(grammarPackage), "out")
    const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm")
    const destination = PATHS.TREE_SITTER_ASSETS_DIR
    mkdirSync(destination, { recursive: true })

    let complete = publishAsset(
      runtime,
      path.join(destination, TREE_SITTER_RUNTIME_FILE),
    )
    for (const filename of Object.values(TREE_SITTER_GRAMMAR_FILES)) {
      const published = publishAsset(
        path.join(grammarRoot, filename),
        path.join(destination, filename),
      )
      complete = published && complete
    }
    return complete
  } catch (err) {
    consola.debug("[tree-sitter-assets] provisioning skipped:", err)
    return false
  }
}

/**
 * Publish through a unique same-directory temporary file. Never remove the
 * destination first: a concurrent parser must see either the prior complete
 * file or the new complete file, never a missing/partial path. A losing racer
 * accepts the winner when its bytes match the source.
 */
function publishAsset(source: string, destination: string): boolean {
  let bytes: Buffer
  try {
    bytes = readFileSync(source)
  } catch {
    return false
  }
  if (matchesContent(destination, bytes)) return true

  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    const tmp = `${destination}.${process.pid}-${attempt}.tmp`
    try {
      writeFileSync(tmp, bytes)
      renameSync(tmp, destination)
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best-effort */
      }
      if (matchesContent(destination, bytes)) return true
    }
  }
  return false
}

/**
 * Whether the published file is byte-identical to the source.
 *
 * Content, not size: a grammar upgrade that happens to keep the same byte
 * length would otherwise never propagate, and the stale copy would shadow the
 * package's newer file permanently — a silent, self-perpetuating wrong answer.
 * The size check first keeps the common case to one `stat`.
 */
function matchesContent(file: string, bytes: Buffer): boolean {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size !== bytes.byteLength) return false
    return readFileSync(file).equals(bytes)
  } catch {
    return false
  }
}

/**
 * Whether the stable directory holds the COMPLETE asset set: the runtime plus
 * every grammar.
 *
 * Callers must gate on the whole set, never on the one file they are about to
 * read. web-tree-sitter enforces a language-ABI version between the runtime and
 * the grammars, so adopting a stable runtime while grammars still come from the
 * package tree (or the reverse) can pair mismatched builds. That surfaces as a
 * caught `Language.load` failure, which silently disables structural ranking —
 * the exact silent degradation this whole change is meant to end.
 */
export function stableTreeSitterAssetsComplete(): boolean {
  const dir = PATHS.TREE_SITTER_ASSETS_DIR
  const required = [
    TREE_SITTER_RUNTIME_FILE,
    ...Object.values(TREE_SITTER_GRAMMAR_FILES),
  ]
  return required.every((name) => {
    try {
      return statSync(path.join(dir, name)).isFile()
    } catch {
      return false
    }
  })
}
