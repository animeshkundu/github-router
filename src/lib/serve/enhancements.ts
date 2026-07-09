import path from "node:path"

import consola from "consola"

import { injectAttributionSuppressionIntoSettingsFile } from "../attribution-settings"
import {
  injectPeerMcpIntoMirror,
  resolveGroupKeysFromMirror,
  writePeerMcpRuntimeFiles,
} from "../codex-mcp-config"
import { INJECTED_SKILLS, writeInjectedSkill } from "../injected-skills"
import {
  browseAgentEnabled,
  browserToolsEnabled,
  geminiAvailable,
  implementerSubagentModel,
  standInToolEnabled,
  workerToolsEnabled,
} from "../mcp-capabilities"
import { PATHS } from "../paths"
import type { McpGroup } from "../peer-mcp-personas"
import { state } from "../state"

export interface ServeEnhancementsHandle {
  cleanup: () => Promise<void>
}

const NOOP: ServeEnhancementsHandle = { cleanup: async () => {} }

/**
 * Wire the github-router enhancement layer into the router-owned
 * CLAUDE_CONFIG_DIR mirror so a CloudCLI-spawned Claude session gets the same
 * tools `github-router claude` provides:
 *   - the scoped MCP servers (peers / search / orchestrate, plus workers /
 *     decide / browser when their gate passes) — the SDK-spawned claude reads
 *     them from the mirror's `.claude.json`,
 *   - the peer-critic / worker / implementer subagents (`.md` files written into
 *     the mirror's `agents/`),
 *   - the gh-* skills (research / orchestrate / floor-keeper / worker).
 *
 * Best-effort: on any failure Claude still works, just without the extras.
 * Must run AFTER `ensureClaudeConfigMirror()` and BEFORE CloudCLI is spawned.
 * The operator/tab-specific bits (first-mate, ai-or-die hooks, artifact review)
 * are intentionally left out — they don't apply to the serve control plane.
 */
export async function provisionServeEnhancements(
  serverUrl: string,
): Promise<ServeEnhancementsHandle> {
  try {
    const enabledGroups: McpGroup[] = ["peers", "search", "orchestrate"]
    if (workerToolsEnabled()) enabledGroups.push("workers")
    if (standInToolEnabled()) enabledGroups.push("decide")
    if (browserToolsEnabled()) enabledGroups.push("browser")

    const gem = geminiAvailable()
    const { keys: groupKeys } = await resolveGroupKeysFromMirror(enabledGroups)

    const runtime = await writePeerMcpRuntimeFiles(serverUrl, {
      codexCli: false,
      geminiAvailable: gem,
      groupKeys,
      workerToolsAvailable: workerToolsEnabled(),
      browseAvailable: browseAgentEnabled(),
      implementerModel: implementerSubagentModel(),
    })
    // The proxy's /mcp handler authorizes tool calls against this per-launch
    // nonce (the same value baked into the mirrored mcpServers Authorization).
    state.peerMcpNonce = runtime.nonce

    const injected = await injectPeerMcpIntoMirror(serverUrl, {
      codexCli: false,
      geminiAvailable: gem,
      groupKeys,
      nonce: runtime.nonce,
    })

    // gh-* skills, minus the operator/tab-specific ones (first-mate, artifact).
    let skillsWritten = 0
    for (const s of INJECTED_SKILLS) {
      if (s.name.startsWith("gh-first-mate") || s.name === "gh-artifact-review") {
        continue
      }
      const r = await writeInjectedSkill(s.name, s.md).catch(() => ({
        written: false,
      }))
      if (r.written) skillsWritten++
    }

    // Suppress AI attribution in the mirror's settings.json (no-op if the user
    // already configured it).
    await injectAttributionSuppressionIntoSettingsFile(
      path.join(PATHS.CLAUDE_CONFIG_DIR, "settings.json"),
    ).catch(() => {})

    const servers = injected.ok
      ? injected.serversAdded.join(", ")
      : "parent-only (user mcpServers collision)"
    consola.info(
      `github-router tools wired into Claude sessions: MCP [${servers}], ${runtime.personas.length} subagents, ${skillsWritten} skills.`,
    )
    return { cleanup: runtime.cleanup }
  } catch (err) {
    consola.warn(
      `Could not wire the github-router MCP/skills layer: ${
        err instanceof Error ? err.message : String(err)
      }. Claude still works, without the extra tools.`,
    )
    return NOOP
  }
}
