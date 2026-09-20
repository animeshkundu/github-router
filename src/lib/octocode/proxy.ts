/**
 * octocode MCP proxy — tool mapping + typed helpers for github-router.
 *
 * This is the single integration point the rest of the proxy uses:
 *   - `octocodeSemanticSearch()` replaces colbert `runSemanticSearch`.
 *   - `octocodeEmbeddings()` replaces the Copilot `/embeddings` proxy.
 *   - `OCTOCODE_TOOL_MAP` drives the `/mcp` tools/list + tools/call bridge.
 */

import { callOctocodeTool } from "./workspace-manager";

export const OCTOCODE_TOOL_MAP = {
  semantic_search: "semantic_search",
  view_signatures: "view_signatures",
  graphrag: "graphrag",
  structural_search: "structural_search",
  lsp_goto_definition: "lsp_goto_definition",
  lsp_find_references: "lsp_find_references",
  lsp_hover: "lsp_hover",
  lsp_document_symbols: "lsp_document_symbols",
  lsp_workspace_symbols: "lsp_workspace_symbols",
  lsp_completion: "lsp_completion",
} as const;

export type OctocodeToolName = keyof typeof OCTOCODE_TOOL_MAP;

export function isOctocodeTool(name: string): name is OctocodeToolName {
  return name in OCTOCODE_TOOL_MAP;
}

export interface OctocodeMcpContent {
  type: string;
  text?: string;
}

export interface OctocodeMcpResult {
  content?: Array<OctocodeMcpContent>;
  isError?: boolean;
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as OctocodeMcpResult;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
    }
  }
  return JSON.stringify(result ?? null);
}

export interface OctocodeSemanticHit {
  file: string;
  line: number;
  score: number;
  snippet: string;
  name?: string;
}

export interface OctocodeSemanticResult {
  results: Array<OctocodeSemanticHit>;
  raw: string;
}

/**
 * Semantic code search via octocode. Returns parsed hits best-effort —
 * callers fall back to lexical `code_search` on throw.
 */
export async function octocodeSemanticSearch(opts: {
  workspace: string;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<OctocodeSemanticResult> {
  const raw = await callOctocodeTool(
    opts.workspace,
    "semantic_search",
    {
      query: opts.query,
      limit: opts.limit ?? 15,
    },
    { signal: opts.signal },
  );
  const text = extractText(raw);
  return { results: parseSemanticHits(text), raw: text };
}

function parseSemanticHits(text: string): Array<OctocodeSemanticHit> {
  // Try structured JSON first (octocode CLI shape), else empty.
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      const out: Array<OctocodeSemanticHit> = [];
      for (const item of parsed as Array<Record<string, unknown>>) {
        if (typeof item.file !== "string") continue;
        out.push({
          file: item.file,
          line: typeof item.line === "number" ? item.line : 1,
          score: typeof item.score === "number" ? item.score : 0,
          snippet: typeof item.snippet === "string" ? item.snippet : "",
          ...(typeof item.name === "string" ? { name: item.name } : {}),
        });
      }
      return out;
    }
  } catch {
    // fall through — unstructured text, no hits to parse
  }
  return [];
}

export interface OctocodeEmbeddingResult {
  data: Array<{ embedding: Array<number>; index: number }>;
}

/**
 * Code embeddings via octocode's local fastembed (no API key).
 * Throws when the backend is unavailable — caller maps to HTTP 502.
 */
export async function octocodeEmbeddings(opts: {
  workspace: string;
  input: string | Array<string>;
  signal?: AbortSignal;
}): Promise<OctocodeEmbeddingResult> {
  const inputs = Array.isArray(opts.input) ? opts.input : [opts.input];
  const raw = await callOctocodeTool(
    opts.workspace,
    "semantic_search",
    {
      // octocode has no standalone embed tool over MCP; request embeddings
      // via the search backend's embedding path when exposed, else throw.
      // NOTE: if the server lacks an embed tool this throws and the caller
      // falls back to Copilot /embeddings (see create-embeddings.ts).
      query: inputs[0] ?? "",
      limit: 0,
      mode: "embeddings",
      inputs,
    },
    { signal: opts.signal },
  );
  if (raw && typeof raw === "object") {
    const r = raw as unknown as OctocodeEmbeddingResult;
    if (Array.isArray(r.data)) return { data: r.data };
  }
  throw new Error("octocode embeddings unavailable (no embed tool)");
}

/** Generic passthrough for graphrag / structural / lsp tools. */
export async function callOctocodePassthrough(opts: {
  workspace: string;
  tool: OctocodeToolName;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const raw = await callOctocodeTool(opts.workspace, OCTOCODE_TOOL_MAP[opts.tool], opts.args, {
    signal: opts.signal,
  });
  return extractText(raw);
}
