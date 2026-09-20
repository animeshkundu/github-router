/**
 * octocode config helpers — router-managed defaults + workspace overrides.
 *
 * Decision: "Use octocode's config" — we write a global
 * `~/.config/octocode/config.toml` with sane defaults (local fastembed,
 * graphrag on) and let per-workspace `.octocode.toml` override. We never
 * parse octocode's config; we only ensure the global file exists with our
 * minimum keys (merge-preserving unknown user keys is out of scope —
 * we create the file only when absent).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CODE_EMBEDDING_MODEL = "fastembed:jina-embeddings-v2-base-code";

export function globalConfigPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "octocode", "config.toml");
}

function defaultConfigToml(): string {
  return `# Managed by github-router (created once, preserved afterwards).
[code_embedding]
model = "${DEFAULT_CODE_EMBEDDING_MODEL}"

[graphrag]
enabled = true
`;
}

/**
 * Ensure the global octocode config exists. Creates it with router
 * defaults when absent; never overwrites an existing file.
 */
export async function ensureGlobalConfig(): Promise<string> {
  const p = globalConfigPath();
  if (existsSync(p)) return p;
  await mkdir(path.dirname(p), { recursive: true });
  try {
    await writeFile(p, defaultConfigToml(), { flag: "wx", mode: 0o600 });
  } catch {
    // Raced by another process — fine.
  }
  return p;
}

/** Read the global config raw (for diagnostics). Null when absent. */
export async function readGlobalConfig(): Promise<string | null> {
  try {
    return await readFile(globalConfigPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * OpenAI → octocode embedding model map. Unknown slugs fall back to the
 * local default (privacy-preserving, no API key needed).
 */
const MODEL_MAP: Readonly<Record<string, string>> = {
  "text-embedding-3-small": DEFAULT_CODE_EMBEDDING_MODEL,
  "text-embedding-3-large": DEFAULT_CODE_EMBEDDING_MODEL,
  "text-embedding-ada-002": DEFAULT_CODE_EMBEDDING_MODEL,
};

export function mapEmbeddingModel(openaiModel: string): string {
  return MODEL_MAP[openaiModel] ?? DEFAULT_CODE_EMBEDDING_MODEL;
}
