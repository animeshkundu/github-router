import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)

const fakeHome = mkdtempSync(path.join(os.tmpdir(), "gh-router-stable-assets-"))

mock.module("node:os", () => ({
  default: { ...os, homedir: () => fakeHome },
  ...os,
  homedir: () => fakeHome,
}))

const { PATHS } = await import("../../src/lib/paths")
const {
  __resetTreeSitterAssetsForTests,
  provisionTreeSitterAssets,
} = await import("../../src/lib/tree-sitter-assets/provision")

// Provision before importing code-search: tree-sitter preloads at module init,
// so this ordering proves Parser.init and Language.load consume the stable
// copies rather than a registry already populated from node_modules.
await provisionTreeSitterAssets()
const ripgrep = require("@vscode/ripgrep") as { rgPath: string }
mkdirSync(PATHS.TOOLBELT_BIN_DIR, { recursive: true })
const stableRg = path.join(
  PATHS.TOOLBELT_BIN_DIR,
  process.platform === "win32" ? "rg.exe" : "rg",
)
copyFileSync(ripgrep.rgPath, stableRg)
if (process.platform !== "win32") chmodSync(stableRg, 0o755)

const savedPath = process.env.PATH
process.env.PATH = ""
const {
  __resetRipgrepResolverForTest,
  resolveRipgrep,
  searchCode,
} = await import("../../src/lib/code-search")
const { resolveGrammarRoot } = await import("../../src/lib/tree-sitter-grammars")

beforeAll(() => {
  __resetRipgrepResolverForTest()
})

afterAll(() => {
  process.env.PATH = savedPath
  __resetRipgrepResolverForTest()
  __resetTreeSitterAssetsForTests()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe("stable code-search assets", () => {
  test("resolves the router-owned ripgrep copy without PATH", () => {
    const resolved = resolveRipgrep()
    expect(resolved.source).toBe("toolbelt")
    expect(resolved.rgPath).toBe(
      path.join(
        PATHS.TOOLBELT_BIN_DIR,
        process.platform === "win32" ? "rg.exe" : "rg",
      ),
    )
  })

  test("loads grammars and returns structural metadata from stable copies", async () => {
    const grammarRoot = resolveGrammarRoot()
    expect(grammarRoot).toBe(PATHS.TREE_SITTER_ASSETS_DIR)
    expect(existsSync(path.join(grammarRoot!, "tree-sitter-typescript.wasm"))).toBe(
      true,
    )
    expect(existsSync(path.join(grammarRoot!, "tree-sitter.wasm"))).toBe(true)

    const workspace = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "gh-router-stable-search-")),
    )
    try {
      writeFileSync(
        path.join(workspace, "service.ts"),
        [
          "export function stableAssetHandler(): string {",
          '  return "ok"',
          "}",
          "stableAssetHandler()",
        ].join("\n") + "\n",
      )
      const result = await searchCode({
        query: "stableAssetHandler",
        workspace,
        mode: "ranked",
        structural: "full",
        summary: true,
        limit: 20,
      })
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results.some((hit) => hit.role === "definition")).toBe(true)
      expect(
        result.outlines?.some((file) =>
          file.outline.some((entry) => entry.name === "stableAssetHandler"),
        ),
      ).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
