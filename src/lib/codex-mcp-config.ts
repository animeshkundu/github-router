import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { buildCodexProviderConfigFlags } from "./launch"
import { PATHS, writeRuntimeFileSecure } from "./paths"
import {
  buildAgentPrompt,
  personasFor,
  type PersonaSpec,
} from "./peer-mcp-personas"

export type CodexMcpBackend = "http" | "cli"

interface ResolveBackendOpts {
  requested: boolean
  codexInfo: { ok: boolean; version?: string } | null
}

/**
 * Decide which MCP backend serves the codex personas.
 *
 *   - User passed `--codex-cli` AND codex 0.129+ is on PATH → "cli".
 *     The peer config registers `codex-cli` as a stdio MCP server
 *     spawning `codex mcp-server`; codex personas route there;
 *     gemini-critic stays on the HTTP backend (Codex CLI can't run
 *     Gemini).
 *   - User passed `--codex-cli` but codex is missing or < 0.129 →
 *     fallback to "http" with a warning. Never break
 *     `github-router claude` over a missing optional dep.
 *   - User did not pass `--codex-cli` → "http", read-only personas only.
 */
export function resolveCodexCliBackend(
  opts: ResolveBackendOpts,
): CodexMcpBackend {
  if (!opts.requested) return "http"
  if (!opts.codexInfo || !opts.codexInfo.ok) {
    const detail = opts.codexInfo?.version
      ? `installed version "${opts.codexInfo.version}" is too old (need 0.129+)`
      : "codex CLI not found on PATH"
    consola.warn(
      `--codex-cli requested but ${detail}; falling back to HTTP-only Codex MCP backend (codex-implementer will not be registered).`,
    )
    return "http"
  }
  return "cli"
}

interface BuildOpts {
  /** Whether the codex-cli stdio server should be added. */
  codexCli: boolean
  /** Whether gemini-3.1-pro-preview is in the live model catalog. */
  geminiAvailable: boolean
  /** Per-launch nonce for the HTTP /mcp Authorization header. */
  nonce: string
  /** Isolated CODEX_HOME for the stdio child (only used when codexCli). */
  codexHome: string
}

interface HttpMcpEntry {
  type: "http"
  url: string
  headers: Record<string, string>
}

interface StdioMcpEntry {
  command: string
  args: Array<string>
  env: Record<string, string>
}

export interface PeerMcpConfig {
  mcpServers: Record<string, HttpMcpEntry | StdioMcpEntry>
}

/**
 * Build the JSON payload for `claude --mcp-config <path>`.
 *
 * Always registers `gh-router-peers` (HTTP) — that's the home of all
 * read-only personas, and it's the only path Gemini can take. When
 * `codexCli` is true, also registers `codex-cli` (stdio) which spawns
 * `codex mcp-server` with the proxy's provider-config flags so codex
 * runs through our Copilot-routed billing path rather than its
 * default api.openai.com.
 */
export function buildPeerMcpConfig(
  serverUrl: string,
  opts: BuildOpts,
): PeerMcpConfig {
  const mcpServers: Record<string, HttpMcpEntry | StdioMcpEntry> = {
    "gh-router-peers": {
      type: "http",
      url: `${serverUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${opts.nonce}`,
      },
    },
  }

  if (opts.codexCli) {
    mcpServers["codex-cli"] = {
      command: "codex",
      args: ["mcp-server", ...buildCodexProviderConfigFlags(serverUrl)],
      env: {
        OPENAI_BASE_URL: `${serverUrl}/v1`,
        OPENAI_API_KEY: "dummy",
        CODEX_HOME: opts.codexHome,
      },
    }
  }

  return { mcpServers }
}

export type PeerAgentDefinitions = Record<
  string,
  { description: string; prompt: string }
>

/**
 * Build the JSON payload for `claude --agents <path>`.
 *
 * Always includes the read-only personas applicable to the mode (gemini
 * is dropped if absent from the catalog); adds `codex-implementer` only
 * when `codexCli` is true.
 */
export function buildPeerAgentDefinitions(
  opts: BuildOpts,
): PeerAgentDefinitions {
  const out: PeerAgentDefinitions = {}
  const personas = personasFor({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
  })
  for (const persona of personas) {
    out[persona.agentName] = {
      description: persona.description,
      prompt: buildAgentPrompt(persona, { codexCli: opts.codexCli }),
    }
  }
  return out
}

export interface PeerMcpRuntimeFiles {
  mcpConfigPath: string
  agentsPath: string
  nonce: string
  personas: Array<PersonaSpec>
  cleanup: () => Promise<void>
}

interface WriteOpts {
  codexCli: boolean
  geminiAvailable: boolean
  /** Override for tests. Defaults to PATHS.CODEX_HOME. */
  codexHome?: string
  /** Override for tests. Defaults to PATHS.CLAUDE_RUNTIME_DIR. */
  runtimeDir?: string
  /** Override for tests. Defaults to a fresh 32-byte hex nonce. */
  nonce?: string
}

/**
 * Generate a per-launch nonce, write the MCP config + agents JSON
 * tempfiles under `CLAUDE_RUNTIME_DIR` with mode 0o600 and `O_EXCL`,
 * and return a `cleanup()` to unlink them on shutdown.
 *
 * Filenames are `peer-mcp-<pid>.json` and `peer-agents-<pid>.json`
 * — PID-suffixed so the boot-time sweep (`sweepStaleRuntimeFiles` in
 * paths.ts) can drop orphans from crashed prior sessions without
 * disturbing live ones.
 */
export async function writePeerMcpRuntimeFiles(
  serverUrl: string,
  opts: WriteOpts,
): Promise<PeerMcpRuntimeFiles> {
  const nonce = opts.nonce ?? randomBytes(32).toString("hex")
  const runtimeDir = opts.runtimeDir ?? PATHS.CLAUDE_RUNTIME_DIR
  const codexHome = opts.codexHome ?? PATHS.CODEX_HOME
  // Defensive mkdir — `ensurePaths` already creates this in the normal
  // setupAndServe path, but if we're called from a context that didn't
  // run it (tests, future callers), don't fail with ENOENT.
  await fs.mkdir(runtimeDir, { recursive: true })
  if (process.platform !== "win32") {
    await fs.chmod(runtimeDir, 0o700).catch(() => {})
  }
  const mcpConfigPath = path.join(runtimeDir, `peer-mcp-${process.pid}.json`)
  const agentsPath = path.join(runtimeDir, `peer-agents-${process.pid}.json`)

  const mcpConfig = buildPeerMcpConfig(serverUrl, {
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    nonce,
    codexHome,
  })
  const agents = buildPeerAgentDefinitions({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    nonce,
    codexHome,
  })

  // If a prior same-PID file survived (boot sweep didn't run, or this
  // function is called twice in one lifecycle), unlink first so wx
  // succeeds. Letting wx fail loudly is correct from a security
  // standpoint, but here we're the same PID — there's no race window
  // a different process could exploit.
  await fs.unlink(mcpConfigPath).catch(() => {})
  await fs.unlink(agentsPath).catch(() => {})

  await writeRuntimeFileSecure(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))
  await writeRuntimeFileSecure(agentsPath, JSON.stringify(agents, null, 2))

  const personas = personasFor({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
  })

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      fs.unlink(mcpConfigPath),
      fs.unlink(agentsPath),
    ])
  }

  return { mcpConfigPath, agentsPath, nonce, personas, cleanup }
}
