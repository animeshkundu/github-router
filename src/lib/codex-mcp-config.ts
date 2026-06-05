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
  GROUP_META,
  MCP_GROUPS,
  type McpGroup,
} from "./peer-mcp-personas"

/**
 * Resolved `mcpServers` config key per enabled group. Bare preferred key
 * (`peers`/`search`/…) or the `gh-router-<group>` fallback on collision;
 * a group absent from the map is either disabled (gate off at launch) or
 * skipped because BOTH its bare AND prefixed keys collided with a user
 * entry. See `resolveGroupKeysFromMirror`.
 */
export type ResolvedGroupKeys = Partial<Record<McpGroup, string>>

/** The `peers` server is always enabled, so its resolved key always exists;
 *  this convenience reads it with the bare-key fallback for safety. */
function peersKeyOf(groupKeys: ResolvedGroupKeys): string {
  return groupKeys.peers ?? GROUP_META.peers.preferredKey
}

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
  /** Resolved config key per enabled group — one `mcpServers` HTTP entry is
   *  emitted per present key, pointing at its scoped `/mcp/<group>` URL. */
  groupKeys: ResolvedGroupKeys
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
 * Build the JSON payload for `claude --mcp-config <path>` (and the same
 * entries that get merged into the mirrored `.claude.json`).
 *
 * Emits one HTTP `mcpServers` entry per enabled group present in
 * `opts.groupKeys`, each pointing at its scoped `/mcp/<group>` endpoint
 * under the resolved (bare or prefixed-fallback) config key. When
 * `codexCli` is true, also registers `codex-cli` (stdio) which spawns
 * `codex mcp-server` with the proxy's provider-config flags so codex runs
 * through our Copilot-routed billing path rather than its default
 * api.openai.com.
 */
export function buildPeerMcpConfig(
  serverUrl: string,
  opts: BuildOpts,
): PeerMcpConfig {
  const mcpServers: Record<string, HttpMcpEntry | StdioMcpEntry> = {}

  for (const group of MCP_GROUPS) {
    const key = opts.groupKeys[group]
    if (!key) continue // group disabled at launch, or both keys collided
    mcpServers[key] = {
      type: "http",
      url: `${serverUrl}/mcp/${GROUP_META[group].urlSuffix}`,
      headers: {
        Authorization: `Bearer ${opts.nonce}`,
      },
    }
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
  // opus-critic is always registered (Anthropic models are always present
  // in the Copilot catalog), so no `geminiAvailable`-style guard is
  // required. Order: codex-critic first (strongest reasoning, cross-lab),
  // opus-critic second (largest context window — 1M when available),
  // gemini-critic third (third-lab triangulation, formal reasoning, only
  // when registered), codex-reviewer last (code-specialist, line-level).
  const peers: Array<string> = ["codex-critic", "opus-critic"]
  if (opts.geminiAvailable) peers.push("gemini-critic")
  peers.push("codex-reviewer")

  const description =
    "Coordinates cross-lab adversarial review across codex-critic, opus-critic, gemini-critic, codex-reviewer. Use proactively before non-trivial plans and after non-trivial commits. Always pass artifacts verbatim — peers are fresh-context."

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
    "- **Plan / design / architecture choice** → fan out to `codex-critic` (gpt-5.5, strongest reasoning, cross-lab)"
      + (opts.geminiAvailable ? " AND `gemini-critic` (third-lab triangulation, strong on formal reasoning) in parallel" : "")
      + ". codex-reviewer is the wrong tool for plans (it's a code-specialist, not an architecture critic).",
    "- **Concrete diff or single file** → fan out to `codex-reviewer` (gpt-5.3-codex, line-level code specialist, fastest at ~16s)"
      + (opts.geminiAvailable ? " AND `gemini-critic` for cross-lab triangulation" : "")
      + ". For very small changes (<20 lines), one `codex-reviewer` call is enough.",
    "- **Large artifact** → the only peers that take a large artifact WHOLE are `codex-critic` (gpt-5.5, ≈922K-token input window) and `opus-critic` (Opus-4.7-1M, ≈936K-token input on enterprise catalogs; ≈168K otherwise). Route the full artifact to those for cross-lab coverage. `codex-reviewer` (≈272K) and `gemini-critic` (≈136K) have small windows — see Decomposition below: never summarize or downsize the request to squeeze a large artifact into a small-window peer.",
    "- **Formal reasoning, proofs, or invariants** → prefer `gemini-critic`"
      + (opts.geminiAvailable ? " (gemini-3.1-pro, strong on math and formally-stated properties)" : " (NOT REGISTERED in this session — gemini-3.x not in catalog)")
      + ".",
    "- **Tie-breaker after codex-critic has weighed in** → call `gemini-critic`"
      + (opts.geminiAvailable ? "" : " (NOT REGISTERED in this session)")
      + " or `opus-critic` with the artifact AND codex-critic's verdict for cross-check.",
    "- **Fast sanity check** → `opus-critic` (~22s, same lab as lead but fresh context — catches confabulation and motivated reasoning).",
    "",
    "## Decomposition for large artifacts",
    "",
    "Route by the peer's real PROMPT WINDOW (input tokens): `codex-critic` gpt-5.5 ≈922K · `opus-critic` Opus-4.7-1M ≈936K (enterprise catalogs; ≈168K otherwise) · `codex-reviewer` gpt-5.3-codex ≈272K · `gemini-critic` gemini-3.1-pro ≈136K. The proxy REJECTS (with an actionable message) any single call whose brief exceeds the target peer's window — it will NOT silently truncate, because dropping lines from a review artifact is worse than a clear error. So: send the full artifact only to peers whose window fits it (large artifacts → `codex-critic` and/or `opus-critic`). When a peer's window is too small (commonly `gemini-critic` at ≈136K, or `codex-reviewer` at ≈272K), do NOT summarize or downsize the request to include it — either skip that peer, or split the artifact into 2-4 logical batches BY CONCERN (not by raw size — semantic batches give better per-batch reviews) that each fit, and call in parallel. Use the big-window peers for the whole and reserve a small-window peer like gemini for the concerns it can actually hold. The proxy's MCP cap allows up to 8 in-flight calls. Aggregate findings yourself before reporting back. (Separately, on the JSON transport a per-effort `predictedTooLong` byte cap still guards the ~60s tools/call timeout for non-SSE clients; Claude Code uses SSE, which streams with heartbeats and isn't subject to that cap.)",
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
  const peersKey = peersKeyOf(opts.groupKeys)
  for (const persona of personas) {
    out[persona.agentName] = {
      description: persona.description,
      prompt: buildAgentPrompt(persona, { codexCli: opts.codexCli, peersKey }),
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
  /** Resolved config keys per enabled group (from `resolveGroupKeysFromMirror`).
   *  Threaded into both the --mcp-config payload and the persona .md routing
   *  strings so every reference points at OUR server even after a collision
   *  fallback. */
  groupKeys: ResolvedGroupKeys
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
 * We point at the router-owned `PATHS.CLAUDE_CONFIG_DIR/agents/` because
 * `getClaudeCodeEnvVars` sets `CLAUDE_CONFIG_DIR=PATHS.CLAUDE_CONFIG_DIR`
 * (the snapshot-mirror substrate fix that gives spawned teammates an
 * authenticatable on-disk credential). The user's own custom-agent .md
 * files were copied into this same dir by `ensureClaudeConfigMirror`,
 * so writing peer-* files here doesn't conflict — and the boot-time
 * sweep is scoped to peer-* names only via the persona-name allowlist.
 */
function defaultAgentsDir(): string {
  return path.join(PATHS.CLAUDE_CONFIG_DIR, "agents")
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

export type InjectPeerMcpResult =
  | { ok: true; serversAdded: ReadonlyArray<string> }
  | {
      ok: false
      reason: "user-has-conflicting-entry"
      conflictingServers: ReadonlyArray<string>
    }

interface InjectOpts {
  codexCli: boolean
  geminiAvailable: boolean
  /** Resolved config keys per enabled group (from `resolveGroupKeysFromMirror`).
   *  Collision-free by construction, so the merge below never overwrites a
   *  user entry. */
  groupKeys: ResolvedGroupKeys
  /** Per-launch nonce — must match what writePeerMcpRuntimeFiles wrote
   *  so the proxy's /mcp Authorization check passes. */
  nonce: string
  /** Override for tests. Defaults to PATHS.CODEX_HOME. */
  codexHome?: string
  /** Override for tests. Defaults to PATHS.CLAUDE_CONFIG_DIR (per-launch). */
  claudeConfigDir?: string
}

/**
 * Read just the `mcpServers` object from a mirrored `.claude.json` (or `{}`
 * on missing / malformed). Used by `resolveGroupKeysFromMirror` to detect
 * which of our bare group keys would collide with a user-side entry.
 */
async function readMcpServersSnapshot(
  target: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const servers = (parsed as Record<string, unknown>).mcpServers
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        return servers as Record<string, unknown>
      }
    }
  } catch {
    // Missing / unparsable → treat as no existing servers (a fresh mirror).
  }
  return {}
}

/**
 * Resolve a config-entry key for each enabled group, defending against
 * collisions with the user's own `mcpServers`. Prefer the bare key
 * (`peers`/`search`/…); on collision walk the numbered fallback sequence
 * `gh-router-<group>`, `gh-router-<group>-2`, `gh-router-<group>-3`, …
 * until a free name is found. This NEVER skips and NEVER returns a name the
 * user already owns: every enabled group is guaranteed a key WE control, so
 * a capability is never silently dropped AND the model is never routed at
 * the user's same-named server (the caller threads these resolved keys into
 * both the `mcpServers` entries AND the persona `.md` routing strings). The
 * `skipped` field is retained for API stability but is always empty now.
 *
 * Reads the mirror snapshot once; the caller passes the result to BOTH
 * `writePeerMcpRuntimeFiles` and `injectPeerMcpIntoMirror`. The mirror is a
 * per-launch dir written ONLY by us (after `ensureClaudeConfigMirror`
 * snapshotted the user's config) and nothing mutates it between this read
 * and `injectPeerMcpIntoMirror`'s write, so the two reads see identical
 * state — no TOCTOU window, and the inject-side defensive conflict check
 * never fires for these resolved keys.
 */
export async function resolveGroupKeysFromMirror(
  enabledGroups: ReadonlyArray<McpGroup>,
  claudeConfigDir?: string,
): Promise<{ keys: ResolvedGroupKeys; skipped: Array<McpGroup> }> {
  const dir = claudeConfigDir ?? PATHS.CLAUDE_CONFIG_DIR
  const existing = await readMcpServersSnapshot(path.join(dir, ".claude.json"))
  const keys: ResolvedGroupKeys = {}
  for (const group of enabledGroups) {
    const bare = GROUP_META[group].preferredKey
    if (existing[bare] === undefined) {
      keys[group] = bare
      continue
    }
    // Bare key taken — walk the prefixed sequence until a free name.
    let candidate = `gh-router-${group}`
    let n = 1
    while (existing[candidate] !== undefined) {
      n += 1
      candidate = `gh-router-${group}-${n}`
    }
    keys[group] = candidate
  }
  return { keys, skipped: [] }
}

/**
 * Mutate the mirrored `<CLAUDE_CONFIG_DIR>/.claude.json` to add the
 * `gh-router-peers` entry (and `codex-cli` when enabled) under
 * `mcpServers`. This is the load-bearing fix for subagent MCP visibility.
 *
 * Subagents — Agent-tool subagents, forks, and agent-teams subprocesses
 * — discover MCP servers from persistent scopes (`.claude.json` and
 * project-scope `.mcp.json`), NOT from the parent's `--mcp-config` CLI
 * flag. Writing into the per-launch mirror's `.claude.json` makes the
 * MCP entry visible to subagents transparently: they inherit
 * `CLAUDE_CONFIG_DIR` from the parent's env, so they read the same
 * config file we just mutated.
 *
 * Safety:
 *   - Refuses to overwrite a same-named user-side entry (the snapshot
 *     copied their `.claude.json` first, so an existing entry would
 *     belong to the user). Returns `{ ok: false }` so the caller can
 *     fall back to leaving `--mcp-config` in place for the parent.
 *   - Preserves all other top-level fields and other `mcpServers`
 *     entries.
 *   - Atomic write: temp-file with `wx` (`O_CREAT | O_EXCL`) followed by
 *     `rename`, mirroring the synthetic-credentials write pattern in
 *     `ensureClaudeConfigMirror`. Mode 0o600. The per-launch
 *     `CLAUDE_CONFIG_DIR` means there are no cross-launch racers.
 */
export async function injectPeerMcpIntoMirror(
  serverUrl: string,
  opts: InjectOpts,
): Promise<InjectPeerMcpResult> {
  const dir = opts.claudeConfigDir ?? PATHS.CLAUDE_CONFIG_DIR
  const target = path.join(dir, ".claude.json")

  // 1. Read existing snapshot (or {} if missing / malformed). We do NOT
  //    fail loudly on parse error — start fresh and let the proxy
  //    session run. Logging the warn surfaces the underlying corruption
  //    for the user to investigate.
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(target, "utf8")
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      } else {
        consola.warn(
          `injectPeerMcpIntoMirror: ${target} parsed to non-object `
            + `(typeof=${typeof parsed}); discarding contents and starting fresh.`,
        )
      }
    } catch (err) {
      consola.warn(
        `injectPeerMcpIntoMirror: cannot parse ${target} as JSON; `
          + `starting fresh (existing contents will be overwritten):`,
        err,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug(
        `injectPeerMcpIntoMirror: cannot read ${target}:`,
        err,
      )
    }
    // Either ENOENT (first-ever launch, no user .claude.json) or some
    // other read error. Either way, start fresh.
  }

  // 2. Normalize `mcpServers` to an object (clobber if user had it set
  //    to a non-object value — that's already broken; our overwrite
  //    won't make it worse and the warn flags it).
  let mcpServers: Record<string, unknown>
  const rawServers = existing.mcpServers
  if (
    rawServers !== undefined
    && rawServers !== null
    && typeof rawServers === "object"
    && !Array.isArray(rawServers)
  ) {
    mcpServers = rawServers as Record<string, unknown>
  } else {
    if (rawServers !== undefined && rawServers !== null) {
      consola.warn(
        `injectPeerMcpIntoMirror: mcpServers field in ${target} is not an `
          + `object (typeof=${typeof rawServers}); replacing with our entry.`,
      )
    }
    mcpServers = {}
  }

  // 3. Build our desired entries from the SAME builder used for
  //    --mcp-config so the two channels never drift. Keys are pre-resolved
  //    (collision-free) by `resolveGroupKeysFromMirror`.
  const peerConfig = buildPeerMcpConfig(serverUrl, {
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    groupKeys: opts.groupKeys,
    nonce: opts.nonce,
    codexHome: opts.codexHome ?? PATHS.CODEX_HOME,
  })

  // 4. Defensive: the resolved keys are collision-free by construction, so
  //    this should never fire. If it somehow does (a racing mutation of the
  //    mirror between resolution and now), refuse to overwrite the user's
  //    entry and let the caller fall back to --mcp-config (parent-only).
  const conflicts: Array<string> = []
  for (const name of Object.keys(peerConfig.mcpServers)) {
    if (mcpServers[name] !== undefined) conflicts.push(name)
  }
  if (conflicts.length > 0) {
    consola.warn(
      `injectPeerMcpIntoMirror: your ~/.claude/.claude.json already has `
        + `mcpServers entries named [${conflicts.join(", ")}]; refusing to `
        + `overwrite. Subagents will not see those tools — only the parent `
        + `session via --mcp-config fallback. To resolve, rename the `
        + `user-side server(s) (e.g. via \`claude mcp remove\`) and relaunch.`,
    )
    return {
      ok: false,
      reason: "user-has-conflicting-entry",
      conflictingServers: conflicts,
    }
  }

  // 5. Merge our entries; preserve everything else.
  for (const [name, entry] of Object.entries(peerConfig.mcpServers)) {
    mcpServers[name] = entry
  }
  existing.mcpServers = mcpServers

  // 6. Atomic temp+rename. Same pattern as the synthetic .credentials.json
  //    write in ensureClaudeConfigMirror. Per-launch dir means there are
  //    no cross-launch racers; EEXIST on the tempfile is essentially
  //    impossible (per-pid + 8-hex random). Mode 0o600 to match the
  //    upstream Claude Code file perms.
  const desiredJson = JSON.stringify(existing, null, 2) + "\n"
  await fs.mkdir(dir, { recursive: true })
  const tempPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, desiredJson, { mode: 0o600, flag: "wx" })
    await fs.rename(tempPath, target)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }

  return { ok: true, serversAdded: Object.keys(peerConfig.mcpServers) }
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
    groupKeys: opts.groupKeys,
    nonce,
    codexHome,
  })
  const agents = buildPeerAgentDefinitions({
    codexCli: opts.codexCli,
    geminiAvailable: opts.geminiAvailable,
    groupKeys: opts.groupKeys,
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
