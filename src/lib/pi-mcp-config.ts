import fs from "node:fs/promises"
import path from "node:path"

import { profileDescriptor } from "./launch-profile"
import type { PiProfileId } from "./pi-models-settings"

/**
 * Pi's MCP surface for the router's scoped groups.
 *
 * `<Pi agent dir>/mcp.json` is Pi's OWN MCP configuration: built-in MCP reads
 * it at session start (`builtin:mcp`, Pi 0.99+), and the router's agent dir in
 * a Pi launch IS the per-launch mirror (`PI_CODING_AGENT_DIR`,
 * `getPiLaunchEnvVars`), so this file is per-launch and swept with the mirror.
 * Nothing here touches the user's real `~/.pi/agent`.
 *
 * Built-in MCP is why `pi-mcp-adapter` is gone from the helper bundle. Per Pi's
 * own `docs/mcp.md`, an installed extension that registers `/mcp` REPLACES
 * built-in MCP for the session, and Pi then never reads this file at all. The
 * adapter was a prerequisite for MCP before native support landed and is a
 * blocker for it now, so the two cannot coexist.
 *
 * Precedence is the reason every key carries the `gh-router-` prefix. Native Pi
 * reads user-level servers from this file and project servers from
 * `.pi/mcp.json` (once the project is trusted), and a project entry replaces a
 * same-named user-level entry as a whole. Keying a group as `ado` would
 * therefore hand the model the workspace's own `ado` server under a name we
 * meant for ours; `gh-router-ado` cannot be shadowed by accident.
 *
 * The bearer is written as an interpolation placeholder rather than a literal:
 * Pi expands `${VAR}` in `headers` from the child environment at connection
 * time, and `GH_ROUTER_HOOK_NONCE` is already in the Pi launch env
 * (`src/pi.ts`). A literal token would put a live secret on disk for the life
 * of the mirror.
 *
 * The mirror file is read-merge-written, and a file we cannot parse is left
 * exactly as it is: a config we do not understand is not ours to overwrite.
 */

/** Key prefix reserved for router-owned entries. Never emit a bare group name. */
export const PI_MCP_SERVER_PREFIX = "gh-router-"

/** Placeholder Pi expands from the Pi child env at connect time. */
export const PI_MCP_NONCE_PLACEHOLDER = "Bearer ${GH_ROUTER_HOOK_NONCE}"

/**
 * Workspace header placeholder.
 *
 * Native MCP sends no workspace of its own, and the worker tools refuse a call
 * that names neither an explicit `workspace` argument nor this header. The
 * generated extension set it by hand on its own `search`/`workers`/
 * `orchestrate` calls; with those calls gone, the header has to ride the server
 * entry or every worker call fails for want of a workspace. Sent on every
 * group: the proxy ignores it where it is unused.
 */
export const PI_MCP_WORKSPACE_PLACEHOLDER = "${GH_ROUTER_WORKSPACE}"

/**
 * Deferred, not direct.
 *
 * `deferred` keeps the tools out of the declared tool set until `tool_search`
 * loads a match, which Pi activates automatically for a deferred server. Two
 * reasons this is the right default rather than `direct`:
 *
 *   - every group is listed in the `mcp_servers` system-prompt section with its
 *     `description`, so discovery is intact without paying the declaration cost
 *     of ~60 tools on every request;
 *   - Pi waits up to 10 s at the first prompt for servers with `direct` tools
 *     to connect. `deferred` servers are not in that wait, so a slow or absent
 *     proxy cannot stall the session.
 */
export const PI_MCP_EXPOSURE = "deferred"

export interface PiMcpGroupEntry {
  /** Scoped MCP group name; also the suffix of the server key. */
  group: string
  /** One-line capability note, surfaced in the `mcp_servers` system prompt. */
  description: string
}

/** Router-owned server key for a scoped group, e.g. `ado` -> `gh-router-ado`. */
export function piMcpServerKey(group: string): string {
  return `${PI_MCP_SERVER_PREFIX}${group}`
}

/**
 * Server keys a config declares, or `null` when the file is absent,
 * unreadable, or not a JSON object. `null` and `[]` are different answers:
 * one means "no evidence", the other "read it, nothing declared" — and the
 * shadow scan must not report a warning it cannot support.
 */
export function readMcpServerKeys(raw: string): Array<string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const servers = (parsed as Record<string, unknown>)["mcpServers"]
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return []
    return Object.keys(servers as Record<string, unknown>)
  } catch {
    return null
  }
}

/**
 * Under `deferred` exposure this line is the model's ONLY pre-search signal for
 * what a server is, so each one says what the group does and when to reach for
 * it rather than naming the server back at the model.
 *
 * Only the seven groups a Pi profile can reach are listed. `orchestrate`,
 * `decide`, `fleet` and `first-mate` sit outside every Pi profile's
 * `allowedGroups` (`src/lib/launch-profile.ts`), so `resolvePiSurfaces` can
 * never emit them and a description for them would be dead text.
 */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  peers: "Cross-lab adversarial reviewers (codex_critic, codex_reviewer, gemini_critic, gemini_reviewer, opus_critic) plus oracle, a stateless expert consultant. Reach for a critic when a plan or a diff needs a second lab's judgement; reach for oracle when repository evidence alone cannot settle a self-contained technical trade-off.",
  search: "Code and web search for this workspace. code is semantic-first with a labelled lexical fallback and reports which engine answered; web runs a Copilot-backed web search. Reach for code before broad file reads when you are locating code by meaning rather than by exact text.",
  workers: "Autonomous worker subagents that run their own agent loop on a scoped task: explore reads and searches, review also runs commands to verify, implement edits files in an isolated git worktree and returns the diff. Reach for a worker when the task is big enough that its context should not land in yours.",
  browser: "Drive a real Chrome or Edge tab: open, navigate, read the page, screenshot, click, type, evaluate JavaScript. Reach for it when the answer lives in a web UI rather than in the repository.",
  ado: "Azure DevOps for the open repository: repositories, work items, pipelines and wikis.",
  kusto: "Azure Data Explorer: query and management commands against the cluster named on each call, or the launch default.",
  cloudagent: "Microsoft Cloud Agent jobs: hand a prompt plus an Azure DevOps repository to a cloud coding agent, then poll it for hours and collect the answer. create_job, create_pr_job and cancel_job spend compute; confirm with the user before creating a job the user did not ask for.",
}

/** The `peers` half of `GROUP_DESCRIPTIONS.peers`, split out so the oracle's
 *  availability can be stated rather than assumed. */
const PEERS_ORACLE_SENTENCE =
  "oracle, a stateless expert consultant. Reach for oracle when repository evidence alone cannot settle a self-contained technical trade-off."

/** What the artifact tools do, in the same one-line voice. */
const PEERS_ARTIFACT_SENTENCE =
  "The artifact_* tools open a workspace file in the human review panel and drain the reviewer's comments and actions; reach for them when a human has to look at the result before work continues."

/**
 * The `peers` description for a profile's persona allow-list.
 *
 * `deferred` exposure makes this line the model's only pre-search signal, so
 * it may name only personas the MCP handler will actually answer: every
 * pinned profile registers a list (`undefined` means unrestricted), and
 * naming a critic a filtered launch answers with -32601 wastes the model's
 * turn. The critics are named only on an unrestricted surface; the oracle
 * and the artifact tools are named when their own gates admit them.
 *
 * Returns `""` when the group would hold nothing, so the caller can leave the
 * server unpublished rather than advertise an empty one.
 */
export function peersGroupDescription(
  personas: ReadonlySet<string> | undefined,
  artifactAvailable: boolean,
): string {
  if (personas === undefined) return GROUP_DESCRIPTIONS.peers
  const parts: Array<string> = []
  if (personas.has("oracle")) parts.push(PEERS_ORACLE_SENTENCE)
  if (artifactAvailable) parts.push(PEERS_ARTIFACT_SENTENCE)
  return parts.join(" ")
}

export interface PiSurfaceDecision {
  /** ColBERT / `--search` surfaces: `pi-web-access`, the semantic skill, the launch card. */
  search: boolean
  /** The semantic search seam. Bluebird serves the same tool, different engine. */
  codeSearch: boolean
  /** Which engine answers `code`; Bluebird wins when both are on. */
  codeSearchBackend: "colbert" | "bluebird"
  /** Scoped groups to publish to Pi as native MCP servers. */
  groups: Array<PiMcpGroupEntry>
}

/**
 * The one place that decides which Pi surfaces this launch emits.
 *
 * `search` and `codeSearch` are deliberately separate. `searchEnabled` feeds
 * three consumers today, and Bluebird must move exactly one of them: it does
 * not serve `pi-web-access` (a Copilot-backed fetch/find package gated on the
 * same flag), and the skill prose it would enable is ColBERT-specific. What
 * Bluebird does serve is `code` — `runUnifiedCodeSearch` routes `semantic` and
 * `lexical` through it whenever `state.bluebirdEnabled` is set — so an Azure
 * checkout with Bluebird auto-enabled and no `--search` still deserves the
 * group.
 *
 * Group selection reproduces the pinned-profile branch of the Claude launcher
 * (`src/claude.ts`) instead of inventing a second policy, so a Pi session and a
 * `github-router claude -m cheapest2` session see the same servers:
 * `peers` (unless `--no-peers`), `search`, `workers` only when the browse agent
 * is available, `browser` under `--browse`, and the three Azure groups under
 * their own predicates. Everything is then filtered through
 * `profileDescriptor(profileId).allowedGroups`, which is
 * `{peers, search, browser, ado, kusto, cloudagent}` for `local`/`local2` and
 * adds `workers` for the other four Pi profiles — so `orchestrate`, `decide`,
 * `fleet` and `first-mate` stay off everywhere.
 */
export function resolvePiSurfaces(opts: {
  profileId: PiProfileId
  searchEnabled: boolean
  bluebirdEnabled: boolean
  adoEnabled: boolean
  kustoEnabled: boolean
  cloudAgentEnabled: boolean
  /** Browse-worker gate (`browseAgentEnabled()`), which also requires the model. */
  browseAgentAvailable: boolean
  /** Direct browser-control gate (`browserToolsEnabled()`), the `--browse` opt-in. */
  directBrowserAvailable: boolean
  /** Artifact review gate (`artifactToolsEnabled()`), which lives in `peers`. */
  artifactToolsAvailable: boolean
  peersEnabled: boolean
}): PiSurfaceDecision {
  const codeSearchBackend = opts.bluebirdEnabled ? "bluebird" : "colbert"
  const descriptor = profileDescriptor(opts.profileId)
  const allowed = descriptor.allowedGroups
  const groups: Array<PiMcpGroupEntry> = []
  const push = (group: string, description = GROUP_DESCRIPTIONS[group]): void => {
    if (allowed && !allowed.has(group)) return
    if (!description) return
    groups.push({ group, description })
  }

  if (opts.peersEnabled) {
    // `local` registers an empty persona allow-list and keeps the group for
    // the artifact tools, so the description follows the allow-list and the
    // group is published only when it will hold at least one tool.
    push("peers", peersGroupDescription(descriptor.personaAllowlist, opts.artifactToolsAvailable))
  }
  push("search")
  if (opts.browseAgentAvailable) push("workers")
  if (opts.directBrowserAvailable) push("browser")
  if (opts.adoEnabled) push("ado")
  if (opts.kustoEnabled) push("kusto")
  if (opts.cloudAgentEnabled) push("cloudagent")

  return {
    search: opts.searchEnabled,
    codeSearch: opts.searchEnabled || opts.bluebirdEnabled,
    codeSearchBackend,
    groups,
  }
}

/** File text, or `null` when it is absent or unreadable. */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return null
  }
}

export interface PiMcpJsonResult {
  /** The mirror file, written or not. */
  path: string
  /** Keys written by this call. */
  added: Array<string>
  /** Pre-existing keys preserved untouched, ours sorted first. */
  preserved: Array<string>
  /**
   * Project-scoped definitions that would replace one of ours, with the file
   * that declares them. Reported, never repaired: those files belong to the
   * user.
   */
  shadowed: Array<{ key: string; file: string }>
  /** Set when an existing mirror file could not be parsed; nothing was written. */
  skippedReason?: string
}

/**
 * The project-scoped file native Pi reads. `.mcp.json` and
 * `.pi/mcp-adapter.json` were adapter-only inputs and are gone with it: warning
 * about a file Pi never reads would be a false positive.
 */
const PROJECT_MCP_FILES = [path.join(".pi", "mcp.json")]

/**
 * Write one remote entry per group into `<mirrorDir>/mcp.json`.
 *
 * Never throws for an unreadable or malformed existing file: it returns a
 * result the caller can warn about. Callers gate on the group being enabled
 * before calling; this function trusts the list it is given.
 */
export async function writePiMcpJson(opts: {
  mirrorDir: string
  workspace: string
  serverUrl: string
  groups: Array<PiMcpGroupEntry>
}): Promise<PiMcpJsonResult> {
  const target = path.join(opts.mirrorDir, "mcp.json")
  let existing: Record<string, unknown> = {}
  let existingServers: Record<string, unknown> = {}

  const raw = await readIfPresent(target)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          path: target,
          added: [],
          preserved: [],
          shadowed: [],
          skippedReason: "not a JSON object",
        }
      }
      existing = parsed as Record<string, unknown>
      const servers = existing["mcpServers"]
      existingServers =
        servers && typeof servers === "object" && !Array.isArray(servers)
          ? (servers as Record<string, unknown>)
          : {}
    } catch {
      return {
        path: target,
        added: [],
        preserved: [],
        shadowed: [],
        skippedReason: "malformed JSON",
      }
    }
  }

  const added: Array<string> = []
  const nextServers: Record<string, unknown> = { ...existingServers }
  for (const group of opts.groups) {
    const key = piMcpServerKey(group.group)
    added.push(key)
    // The key namespace is router-owned, so an existing entry under our own
    // name is a replacement, not a user asset. Anything else is left alone.
    nextServers[key] = {
      type: "http",
      url: `${opts.serverUrl}/mcp/${group.group}`,
      headers: {
        Authorization: PI_MCP_NONCE_PLACEHOLDER,
        "X-GH-Workspace": PI_MCP_WORKSPACE_PLACEHOLDER,
      },
      exposure: PI_MCP_EXPOSURE,
      description: group.description,
    }
  }

  const shadowed = await findShadowedKeys(opts.workspace, added)
  const preserved = Object.keys(existingServers)
    .filter((key) => !added.includes(key))
    .sort()

  await fs.mkdir(opts.mirrorDir, { recursive: true })
  await fs.writeFile(
    target,
    `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`,
    { mode: 0o600 },
  )

  return { path: target, added, preserved, shadowed }
}

/**
 * Which of `keys` a project-scoped file would replace. A file that cannot be
 * read or parsed is skipped silently: it yields no evidence either way, and a
 * false warning about a config we merely failed to parse is worse than a
 * missing one.
 */
async function findShadowedKeys(
  workspace: string,
  keys: Array<string>,
): Promise<Array<{ key: string; file: string }>> {
  const found: Array<{ key: string; file: string }> = []
  for (const rel of PROJECT_MCP_FILES) {
    const file = path.join(workspace, rel)
    const raw = await readIfPresent(file)
    if (raw === null) continue
    const declared = readMcpServerKeys(raw)
    if (!declared) continue
    for (const key of keys) {
      if (declared.includes(key)) found.push({ key, file })
    }
  }
  return found
}
