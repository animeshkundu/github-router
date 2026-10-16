import fs from "node:fs/promises"
import path from "node:path"

/**
 * Pi's MCP surface for the router's scoped groups.
 *
 * `<Pi agent dir>/mcp.json` is Pi's own MCP configuration (the file `pi mcp add`
 * writes), and `pi-mcp-adapter` reads it as a compatibility input on Pi 0.99+.
 * Pi's agent dir in a router launch IS the per-launch mirror
 * (`PI_CODING_AGENT_DIR`, `getPiLaunchEnvVars`), so this file is per-launch and
 * swept with the mirror. Nothing here touches the user's real `~/.pi/agent`.
 *
 * Precedence is the reason every key carries the `gh-router-` prefix. In the
 * adapter's load order the mirror file is #4, while `.mcp.json` (#7),
 * `.pi/mcp.json` (#8) and `.pi/mcp-adapter.json` (#9) all win over it and
 * replace a same-named server as a whole. Keying a group as `ado` would
 * therefore hand the model the workspace's own `ado` server under a name we
 * meant for ours; `gh-router-ado` cannot be shadowed by accident.
 *
 * The bearer is written as an interpolation placeholder rather than a literal:
 * the adapter expands `${VAR}` in `headers` from the child environment at
 * connection time, and `GH_ROUTER_HOOK_NONCE` is already in the Pi launch env
 * (`src/pi.ts`). A literal token would put a live secret on disk for the life
 * of the mirror.
 *
 * The mirror file is read-merge-written, and a file we cannot parse is left
 * exactly as it is: a config we do not understand is not ours to overwrite.
 */

/** Key prefix reserved for router-owned entries. Never emit a bare group name. */
export const PI_MCP_SERVER_PREFIX = "gh-router-"

/** Placeholder the adapter expands from the Pi child env at connect time. */
export const PI_MCP_NONCE_PLACEHOLDER = "Bearer ${GH_ROUTER_HOOK_NONCE}"

export interface PiMcpGroupEntry {
  /** Scoped MCP group name; also the suffix of the server key. */
  group: string
  /** One-line capability note. The adapter forwards `description` verbatim. */
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
 * The adapter forwards `description` verbatim, so this is the model's only
 * pre-search signal for what a server is. Kept to what every tool in the group
 * actually does; read-only is a property of the group's default surface, not a
 * promise about every call.
 */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  ado: "Azure DevOps for the open repository: repositories, work items, pipelines and wikis.",
  kusto: "Azure Data Explorer: query and management commands against the configured cluster.",
}

export interface PiSurfaceDecision {
  /** ColBERT / `--search` surfaces: `pi-web-access`, the semantic skill, the launch card. */
  search: boolean
  /** The generated `code_search` seam. Bluebird serves the same tool, different engine. */
  codeSearch: boolean
  /** Which engine answers `code_search`; Bluebird wins when both are on. */
  codeSearchBackend: "colbert" | "bluebird"
  /** Azure groups to publish to Pi. Empty unless the adapter ships. */
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
 * checkout with Bluebird auto-enabled and no `--search` still deserves the seam.
 *
 * The Azure groups ride the adapter, which only exists when `helpers` and
 * `peers` both hold (`buildPiSettingsJson` adds it as `helpers && peers`).
 * Writing the config without the adapter would leave it inert at best: the file
 * is also Pi's own built-in MCP config, so an ungated write would expose the
 * groups through a backend this path has never validated.
 */
export function resolvePiSurfaces(opts: {
  searchEnabled: boolean
  bluebirdEnabled: boolean
  adoEnabled: boolean
  kustoEnabled: boolean
  helpersEnabled: boolean
  peersEnabled: boolean
}): PiSurfaceDecision {
  const codeSearchBackend = opts.bluebirdEnabled ? "bluebird" : "colbert"
  const groups: Array<PiMcpGroupEntry> = []
  if (opts.helpersEnabled && opts.peersEnabled) {
    if (opts.adoEnabled) groups.push({ group: "ado", description: GROUP_DESCRIPTIONS["ado"]! })
    if (opts.kustoEnabled) {
      groups.push({ group: "kusto", description: GROUP_DESCRIPTIONS["kusto"]! })
    }
  }
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

/** Project-scoped files the adapter reads, in its own precedence order. */
const PROJECT_MCP_FILES = [
  path.join(".mcp.json"),
  path.join(".pi", "mcp.json"),
  path.join(".pi", "mcp-adapter.json"),
]

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
      headers: { Authorization: PI_MCP_NONCE_PLACEHOLDER },
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
