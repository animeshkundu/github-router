import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectLspForWorkspace } from "../src/lib/octocode/lsp-detector";
import { mapEmbeddingModel, DEFAULT_CODE_EMBEDDING_MODEL } from "../src/lib/octocode/config";
import { isOctocodeTool, OCTOCODE_TOOL_MAP } from "../src/lib/octocode/proxy";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "octo-lsp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lsp detector", () => {
  test("detects rust via Cargo.toml", () => {
    writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    const d = detectLspForWorkspace(dir);
    expect(d.servers).toContain("rust-analyzer");
    expect(d.languages).toContain("rust");
  });

  test("detects typescript via package.json", () => {
    writeFileSync(path.join(dir, "package.json"), "{}\n");
    const d = detectLspForWorkspace(dir);
    expect(d.servers).toContain("typescript-language-server");
  });

  test("detects go via extension fallback", () => {
    mkdirSync(path.join(dir, "cmd"), { recursive: true });
    writeFileSync(path.join(dir, "cmd", "main.go"), "package main\n");
    const d = detectLspForWorkspace(dir);
    expect(d.servers).toContain("gopls");
  });

  test("empty dir yields no servers", () => {
    const d = detectLspForWorkspace(dir);
    expect(d.servers).toEqual([]);
    expect(d.csv).toBe("");
  });

  test("missing dir yields empty", () => {
    const d = detectLspForWorkspace(path.join(dir, "nope"));
    expect(d.csv).toBe("");
  });
});

describe("embedding model map", () => {
  test("known OpenAI slugs map to local default", () => {
    expect(mapEmbeddingModel("text-embedding-3-small")).toBe(DEFAULT_CODE_EMBEDDING_MODEL);
    expect(mapEmbeddingModel("text-embedding-ada-002")).toBe(DEFAULT_CODE_EMBEDDING_MODEL);
  });

  test("unknown slugs fall back to local default", () => {
    expect(mapEmbeddingModel("voyage-code-3")).toBe(DEFAULT_CODE_EMBEDDING_MODEL);
  });
});

describe("tool map", () => {
  test("all expected tools present", () => {
    for (const t of [
      "semantic_search",
      "view_signatures",
      "graphrag",
      "structural_search",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_hover",
      "lsp_document_symbols",
      "lsp_workspace_symbols",
      "lsp_completion",
    ] as const) {
      expect(isOctocodeTool(t)).toBe(true);
      expect(OCTOCODE_TOOL_MAP[t]).toBe(t);
    }
  });

  test("unknown tool rejected", () => {
    expect(isOctocodeTool("code")).toBe(false);
    expect(isOctocodeTool("")).toBe(false);
  });
});
