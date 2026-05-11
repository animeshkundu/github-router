import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
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
 * The `peer-review-coordinator` Claude Code subagent — the strongest
 * auto-invocation lever per Phase 2A of the peer-MCP plan. It is NOT a
 * peer-MCP tool; it is a regular Claude Code subagent that runs inside
 * the spawned-claude context, has tool access to the peer MCP tools
 * (codex_critic, codex_reviewer, gemini_critic), and fans out + aggregates.
 *
 * The "use proactively" phrase in the description is the documented Claude
 * Code idiom for subagents the parent (Opus) should delegate to without
 * explicit user request — at the natural checkpoints listed below.
 *
 * Empirically the polling-loop reliability for "use proactively" is ~60%
 * (claude-code-guide expert estimate); the plan calls for an acceptance
 * test (≥7/10 sessions delegate at the right checkpoints) before declaring
 * "auto-invoked". If <7/10 we flip the optional PreToolUse hook on
 * ExitPlanMode to default-on (env-disable-able).
 */
function buildCoordinatorAgent(opts: {
  codexCli: boolean
  geminiAvailable: boolean
}): { description: string; prompt: string } {
  const peers: Array<string> = ["codex-critic"]
  if (opts.geminiAvailable) peers.push("gemini-critic")
  peers.push("codex-reviewer")

  const description =
    "Coordinates cross-lab adversarial review. **Use proactively before ExitPlanMode for non-trivial plans and after non-trivial commits** (>50 lines OR touching streaming/auth/concurrency/persistence/security). Routes to codex-critic / codex-reviewer / gemini-critic in parallel based on artifact type and aggregates findings. Cheaper than calling each peer manually for the common case where you want a multi-lab triangulation. The subagent has no access to your scrollback or CLAUDE.md — pass the artifact verbatim."

  const personaList = peers.map((p) => `- \`${p}\``).join("\n")

  const prompt = [
    "# Subagent: peer-review-coordinator",
    "",
    "You orchestrate cross-lab adversarial review for the lead orchestrator (Opus). You have access to these peer-MCP subagents:",
    "",
    personaList,
    "",
    "## When the lead invokes you",
    "",
    "The lead's brief will include an artifact (plan, design, diff, or code) and a goal (e.g. 'review before exit-plan', 'review the commit I just made', 'cross-check codex-critic's verdict'). Pick the right peers for the artifact type:",
    "",
    "- **Plan / design / architecture choice** → fan out to `codex-critic`"
      + (opts.geminiAvailable ? " AND `gemini-critic` in parallel" : "")
      + ". codex-reviewer is the wrong tool for plans (it's a code-specialist, not an architecture critic).",
    "- **Concrete diff or single file** → fan out to `codex-reviewer`"
      + (opts.geminiAvailable ? " AND `gemini-critic` (gemini for cross-lab triangulation)" : "")
      + ". For very small changes (<20 lines), one `codex-reviewer` call is enough.",
    "- **Tie-breaker after codex-critic has weighed in** → call `gemini-critic`"
      + (opts.geminiAvailable ? "" : " (NOT REGISTERED in this session — gemini-3.x not in catalog; tie-break unavailable)")
      + " with the artifact AND codex-critic's verdict for cross-lab cross-check.",
    "- **Long-context artifact (>100 KB)** → prefer `gemini-critic`"
      + (opts.geminiAvailable ? "" : " (NOT REGISTERED in this session)")
      + ". Otherwise, decompose into 2-4 batches and fan out across `codex-critic` calls in parallel.",
    "",
    "## Decomposition for large artifacts",
    "",
    "Each per-call MCP wait is bounded (~150s on Claude Code v2.1.138 per regression #50289). For artifacts >20 KB, split into 2-4 logical batches BY CONCERN (not by raw size — semantic batches give better per-batch reviews) and call peers in parallel. The proxy's MCP cap allows up to 8 in-flight calls. Aggregate findings yourself before reporting back.",
    "",
    "## Aggregation contract",
    "",
    "When fan-out completes, return a SEVERITY-GROUPED, DEDUPLICATED finding list. Format:",
    "",
    "  ## Findings",
    "  ### HIGH",
    "  1. <one-line title> — `<file:line>` — sources: codex-critic, gemini-critic (3-lab confirmed if applicable)",
    "     - bug: <one sentence>",
    "     - mitigation: <one sentence>",
    "  ### MEDIUM",
    "  ...",
    "  ### LOW",
    "  ...",
    "",
    "Cite which peer raised each finding. If two or more peers raised the SAME finding (cross-lab confirmation), call it out — those are the highest-confidence bugs.",
    "",
    "## What NOT to do",
    "",
    "- Do not paraphrase or summarize per-peer verdicts BEFORE aggregating; aggregate from the raw verdicts.",
    "- Do not invent severity labels not present in the source verdicts.",
    "- Do not call peers serially (waste of wall-clock); always fan out in parallel.",
    "- Do not consult yourself — you are the coordinator, not a critic.",
    "",
    "Self-reminder (read before every reply):",
    "  Did I fan out in parallel to the right peers for this artifact type?",
    "  Did I aggregate findings by severity, citing which peer raised each?",
    "  If two peers agreed, did I flag the cross-lab confirmation?",
  ].join("\n")

  return { description, prompt }
}

/**
 * Build the JSON payload for `claude --agents <path>`.
 *
 * Always includes the read-only personas applicable to the mode (gemini
 * is dropped if absent from the catalog); adds `codex-implementer` only
 * when `codexCli` is true. Always appends the `peer-review-coordinator`
 * meta-subagent — the strongest "use proactively" auto-invocation lever
 * per Phase 2A of the peer-MCP plan.
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
  out["peer-review-coordinator"] = buildCoordinatorAgent({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
  })
  return out
}

export interface PeerMcpRuntimeFiles {
  mcpConfigPath: string
  agentsPath: string
  /** .md subagent files written into ~/.claude/agents/ (Phase 2.5). The
   *  `--agents` JSON path is silently ignored by Claude Code v2.1.138's
   *  Task `subagent_type` enum (the JSON's subagents are only reachable
   *  via natural-language delegation). The .md files in the canonical
   *  agents directory ARE picked up by the enum, making the
   *  peer-review-coordinator + persona subagents directly invokable. */
  agentMdPaths: Array<string>
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
  /** Override for tests. Defaults to ~/.claude/agents (where Claude Code
   *  reads subagent .md files at session start). */
  agentsDir?: string
}

/**
 * Default location Claude Code reads subagent .md files from at session
 * startup. Files placed here populate the Task `subagent_type` enum.
 *
 * We pin to the user's `~/.claude/agents/` because `getClaudeCodeEnvVars`
 * sets `CLAUDE_CONFIG_DIR=$HOME/.claude` (the Spawned-CLI auth isolation
 * trick) — the spawned child reads from this exact path.
 */
function defaultAgentsDir(): string {
  return path.join(os.homedir(), ".claude", "agents")
}

/**
 * YAML frontmatter string-escape — sufficient for our use case where
 * descriptions can contain colons, quotes, newlines. Wraps the value
 * in double-quotes and escapes:
 *   - `\` and `"` (canonical YAML)
 *   - `\n`, `\r`, `\t` (whitespace controls — `\r` matters on Windows-edited
 *     literals; strict YAML 1.2 parsers reject raw `\r` in double-quoted
 *     scalars)
 *   - other C0 control chars (\x00-\x08, \x0B, \x0C, \x0E-\x1F) and
 *     DEL (\x7F) — encoded as `\xNN` so the YAML stays valid even if
 *     a future description sources data from an external file
 *
 * NOT a general-purpose YAML serializer; we control the inputs.
 */
function escapeYamlString(s: string): string {
  return (
    `"${
      s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        // The point of this regex IS to match control characters so we
        // can replace them with safe `\xNN` escapes — the lint rule's
        // concern (accidental control-char in regex) doesn't apply here.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) =>
          `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
        )
    }"`
  )
}

/**
 * Strict allowlist for subagent names — controls both the YAML
 * frontmatter `name:` field AND the filename suffix. Defense-in-depth:
 * even if a future contributor wires in a dynamic agent name from
 * outside, the validator at the top of `writePeerAgentMdFiles` rejects
 * anything that wouldn't be a safe bare YAML scalar AND a safe path
 * component.
 */
const VALID_AGENT_NAME = /^[a-z][a-z0-9-]*$/

/** Build a single subagent .md file body (frontmatter + system prompt). */
function buildAgentMd(spec: { name: string; description: string; prompt: string }): string {
  return [
    "---",
    `name: ${spec.name}`,
    `description: ${escapeYamlString(spec.description)}`,
    "---",
    "",
    spec.prompt,
    "",
  ].join("\n")
}

/**
 * Write per-launch subagent .md files into the user's `~/.claude/agents/`
 * directory so they appear in Claude Code's Task `subagent_type` enum
 * (which `--agents` JSON files do NOT, per claude-code-guide expert).
 *
 * Filenames follow `peer-<pid>-<rand>-<agentName>.md` so the boot-time
 * sweep (`sweepStalePeerAgentMdFiles` in paths.ts) can drop orphans
 * from crashed prior proxy sessions without touching the user's other
 * `.claude/agents/` files. The `name:` field in the frontmatter is the
 * canonical agent identifier — matching across files would cause Claude
 * Code to (un)deterministically pick one, so concurrent proxies running
 * the same agents need different filenames but resolve to the same
 * agent name (intended — they're the same subagent, just registered
 * twice).
 *
 * Returns the file paths plus a cleanup() that unlinks them.
 */
export async function writePeerAgentMdFiles(
  agents: Record<string, { description: string; prompt: string }>,
  opts: { agentsDir?: string; fileSuffix: string },
): Promise<{ paths: Array<string>; cleanup: () => Promise<void> }> {
  // Validate every agent name BEFORE touching the filesystem. Defense-
  // in-depth against a future contributor wiring in a dynamic name from
  // outside (--agent flag, MCP tool registration, etc.). Names appear
  // in BOTH the filename (path-traversal vector if unvalidated) and the
  // YAML frontmatter `name:` field (parser-confusion if it contains
  // YAML indicator chars). The strict regex matches only safe lowercase
  // identifiers — every current persona/coordinator name passes.
  for (const name of Object.keys(agents)) {
    if (!VALID_AGENT_NAME.test(name)) {
      throw new Error(
        `writePeerAgentMdFiles: invalid agent name ${JSON.stringify(name)} — `
          + `must match ${VALID_AGENT_NAME.source}`,
      )
    }
  }
  const dir = opts.agentsDir ?? defaultAgentsDir()
  await fs.mkdir(dir, { recursive: true })
  const paths: Array<string> = []
  try {
    for (const [name, def] of Object.entries(agents)) {
      const filePath = path.join(dir, `peer-${opts.fileSuffix}-${name}.md`)
      // Same idempotency pattern as the JSON tempfiles: unlink first so
      // O_EXCL succeeds even if a same-suffix file somehow survived.
      await fs.unlink(filePath).catch(() => {})
      await writeRuntimeFileSecure(
        filePath,
        buildAgentMd({ name, description: def.description, prompt: def.prompt }),
      )
      paths.push(filePath)
    }
  } catch (err) {
    // Partial-failure cleanup: if iteration N fails (disk full, EPERM,
    // EEXIST race), the N-1 successfully-written files would otherwise
    // be orphans the caller has no handle to. Unlink the partials before
    // re-throwing so the boot sweep doesn't have to deal with them.
    await Promise.allSettled(paths.map((p) => fs.unlink(p)))
    throw err
  }
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(paths.map((p) => fs.unlink(p)))
  }
  return { paths, cleanup }
}

/**
 * Generate a per-launch nonce, write the MCP config + agents JSON
 * tempfiles under `CLAUDE_RUNTIME_DIR` with mode 0o600 and `O_EXCL`,
 * and return a `cleanup()` to unlink them on shutdown.
 *
 * Filenames are `peer-mcp-<pid>-<rand>.json` and `peer-agents-<pid>-<rand>.json`.
 * The PID prefix is what the boot-time sweep (`sweepStaleRuntimeFiles` in
 * paths.ts) keys off to drop orphans from crashed prior sessions; the
 * random suffix prevents two concurrent calls within the same process
 * from clobbering each other's files (e.g., a proxy that internally
 * relaunches its spawned child without restarting itself).
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
  // 4-byte random suffix gives 2^32 distinct names per PID — collision-free
  // for any realistic count of in-process re-invocations.
  const fileSuffix = `${process.pid}-${randomBytes(4).toString("hex")}`
  const mcpConfigPath = path.join(runtimeDir, `peer-mcp-${fileSuffix}.json`)
  const agentsPath = path.join(runtimeDir, `peer-agents-${fileSuffix}.json`)

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

  // Phase 2.5: also write the same agents as .md files into
  // ~/.claude/agents/ — this is the registry Claude Code's Task
  // `subagent_type` enum reads from at session start. The `--agents`
  // JSON path above is kept for inspection / future-proofing but the
  // .md files are what makes the subagents actually invokable from
  // Opus's tool surface.
  const mdResult = await writePeerAgentMdFiles(agents, {
    agentsDir: opts.agentsDir,
    fileSuffix,
  })

  const personas = personasFor({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
  })

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      fs.unlink(mcpConfigPath),
      fs.unlink(agentsPath),
      mdResult.cleanup(),
    ])
  }

  return {
    mcpConfigPath,
    agentsPath,
    agentMdPaths: mdResult.paths,
    nonce,
    personas,
    cleanup,
  }
}
