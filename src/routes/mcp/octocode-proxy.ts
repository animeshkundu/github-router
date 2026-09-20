/**
 * octocode MCP bridge — tools/list entries + tools/call dispatch.
 *
 * Exposes octocode's code-intelligence tools through github-router's
 * `/mcp` surface. Workspace is resolved per call (explicit arg →
 * GH_ROUTER_WORKSPACE → git toplevel → cwd).
 */

import { resolveWorkspace } from "~/lib/octocode/workspace-detector";
import {
  OCTOCODE_TOOL_MAP,
  callOctocodePassthrough,
  isOctocodeTool,
} from "~/lib/octocode/proxy";

export interface OctocodeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function workspaceProp(): Record<string, unknown> {
  return {
    workspace: {
      type: "string",
      description: "Absolute workspace path. Defaults to the proxy launch directory when omitted.",
    },
  };
}

export const OCTOCODE_TOOL_DEFS: ReadonlyArray<OctocodeToolDef> = [
  {
    name: "semantic_search",
    description:
      "Meaning-ranked code search via octocode (hybrid embeddings + BM25). Best for natural-language queries. Falls back to lexical code_search when the index is cold.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Natural-language or symbol query." },
        limit: { type: "number", description: "Max hits (default 15)." },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "view_signatures",
    description: "File structure overview (symbols, signatures, imports) without reading full files.",
    inputSchema: {
      type: "object",
      required: ["file"],
      additionalProperties: false,
      properties: {
        file: { type: "string", description: "Workspace-relative file path." },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "graphrag",
    description: "Code knowledge-graph lookup: relationships (imports/calls/extends/implements), path finding, node overview.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Graph query (node id or question)." },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "structural_search",
    description: "AST pattern search (e.g. find `.unwrap()` calls, `new` instantiations).",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: { type: "string", description: "AST pattern." },
        language: { type: "string", description: "Language key (e.g. ts, py, rust)." },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "lsp_goto_definition",
    description: "Jump to a symbol's definition (requires language server).",
    inputSchema: {
      type: "object",
      required: ["file", "line", "character"],
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "lsp_find_references",
    description: "Find all usages of a symbol across the workspace.",
    inputSchema: {
      type: "object",
      required: ["file", "line", "character"],
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "lsp_hover",
    description: "Type info and documentation for a symbol.",
    inputSchema: {
      type: "object",
      required: ["file", "line", "character"],
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        ...workspaceProp(),
      },
    },
  },
  {
    name: "lsp_document_symbols",
    description: "All symbols in a file.",
    inputSchema: {
      type: "object",
      required: ["file"],
      additionalProperties: false,
      properties: { file: { type: "string" }, ...workspaceProp() },
    },
  },
  {
    name: "lsp_workspace_symbols",
    description: "Workspace-wide symbol search.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: { query: { type: "string" }, ...workspaceProp() },
    },
  },
  {
    name: "lsp_completion",
    description: "Code completions at a position.",
    inputSchema: {
      type: "object",
      required: ["file", "line", "character"],
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        ...workspaceProp(),
      },
    },
  },
];

export function octocodeToolDefs(): Array<OctocodeToolDef> {
  return [...OCTOCODE_TOOL_DEFS];
}

export interface OctocodeCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Dispatch a tools/call to octocode. Returns null when `name` is not an
 * octocode tool (caller falls through to the existing dispatch).
 */
export async function handleOctocodeCall(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OctocodeCallResult | null> {
  if (!isOctocodeTool(name)) return null;
  const explicit = typeof args.workspace === "string" ? args.workspace : undefined;
  let workspace: string;
  try {
    workspace = await resolveWorkspace(explicit);
  } catch (err) {
    return {
      content: [{ type: "text", text: `octocode: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  const rest: Record<string, unknown> = { ...args };
  delete rest.workspace;
  try {
    const text = await callOctocodePassthrough({
      workspace,
      tool: name,
      args: { ...rest, workspace },
      signal,
    });
    void OCTOCODE_TOOL_MAP[name];
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `octocode ${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
