import path from "node:path"

import consola from "consola"

import { injectAttributionSuppressionIntoSettingsFile } from "../attribution-settings"
import {
  injectPeerMcpIntoMirror,
  resolveGroupKeysFromMirror,
  workersKeyOf,
  writePeerMcpRuntimeFiles,
} from "../codex-mcp-config"
import {
  appendPeerAwarenessToMirroredClaudeMd,
  appendToolbeltAwarenessToMirroredClaudeMd,
  OPERATING_DEFAULTS_DIRECTIVE,
  prependOperatingDefaultsToMirroredClaudeMd,
  prependStyleDirectiveToMirroredClaudeMd,
} from "../claude-md-injection"
import { INJECTED_SKILLS, writeInjectedSkill } from "../injected-skills"
import {
  browseAgentEnabled,
  browserCompoundToolsEnabled,
  browserToolsEnabled,
  geminiAvailable,
  implementerSubagentModel,
  standInToolEnabled,
  workerToolsEnabled,
} from "../mcp-capabilities"
import { buildPromptSubmitHookCommand } from "../orchestration/prompt-submit-hook"
import { injectStopHookIntoSettingsFile } from "../orchestration/stop-gate-hook"
import { PATHS } from "../paths"
import { buildPeerAwarenessSnippet, type McpGroup } from "../peer-mcp-personas"
import { state } from "../state"
import { availableToolCommands, buildToolbeltAwareness, toolbeltEnabled } from "../toolbelt"
import {
  activeDispatchModes,
  buildWorkerGuardHookCommand,
  guardToolMatcher,
} from "../worker-dispatch"

export interface ServeEnhancementsHandle {
  cleanup: () => Promise<void>
  nonce?: string
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

    const peerSnippet = buildPeerAwarenessSnippet({
      codexCli: false,
      geminiAvailable: gem,
      workerToolsAvailable: workerToolsEnabled(),
      standInAvailable: standInToolEnabled(),
      browseAvailable: browserToolsEnabled(),
      compoundBrowseAvailable: browserCompoundToolsEnabled(),
      powerBrowseAvailable: state.powerBrowseEnabled,
      agentToolsAvailable: false,
      implementerAvailable: implementerSubagentModel() != null,
      groupKeys,
    })

    await appendPeerAwarenessToMirroredClaudeMd(peerSnippet).catch((err) =>
      consola.warn(`Peer-awareness CLAUDE.md append failed: ${String(err)}`),
    )
    await prependStyleDirectiveToMirroredClaudeMd().catch((err) =>
      consola.warn(`Style-directive CLAUDE.md prepend failed: ${String(err)}`),
    )
    await prependOperatingDefaultsToMirroredClaudeMd(OPERATING_DEFAULTS_DIRECTIVE).catch((err) =>
      consola.warn(`Operating-defaults CLAUDE.md prepend failed: ${String(err)}`),
    )
    if (toolbeltEnabled()) {
      const toolbeltLine = buildToolbeltAwareness(availableToolCommands())
      if (toolbeltLine) {
        await appendToolbeltAwarenessToMirroredClaudeMd(toolbeltLine).catch((err) =>
          consola.warn(`Toolbelt CLAUDE.md append failed: ${String(err)}`),
        )
      }
    }

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

    const settingsPath = path.join(PATHS.CLAUDE_CONFIG_DIR, "settings.json")

    // Suppress AI attribution in the mirror's settings.json (no-op if the user
    // already configured it).
    await injectAttributionSuppressionIntoSettingsFile(settingsPath).catch(() => {})

    if (workerToolsEnabled()) {
      const promptCmd = buildPromptSubmitHookCommand(process.execPath, process.argv[1])
      await injectStopHookIntoSettingsFile(settingsPath, promptCmd, "UserPromptSubmit", 45).catch(
        (err) => consola.warn(`Could not register the UserPromptSubmit hook: ${String(err)}`),
      )

      if (!injected.ok) {
        consola.warn(
          "Workers non-blocking guard NOT registered: subagent MCP injection fell back to parent-only, so worker-* dispatchers cannot reach the workers server. Raw worker tools remain usable on the main thread.",
        )
      } else if (process.env.GH_ROUTER_DISABLE_WORKER_GUARD !== "1") {
        const workersKey = workersKeyOf(groupKeys)
        const modes = activeDispatchModes({ browse: browseAgentEnabled() })
        const cmd = buildWorkerGuardHookCommand(
          process.execPath,
          process.argv[1],
          workersKey,
          modes,
        )
        const matcher = guardToolMatcher(workersKey, modes)
        await injectStopHookIntoSettingsFile(settingsPath, cmd, "PreToolUse", 10, matcher).catch(
          (err) => consola.warn(`Could not register the workers PreToolUse guard hook: ${String(err)}`),
        )
      } else {
        consola.info(
          "Workers non-blocking guard disabled via GH_ROUTER_DISABLE_WORKER_GUARD=1; raw worker tools remain callable on the main thread.",
        )
      }
    }

    const servers = injected.ok
      ? injected.serversAdded.join(", ")
      : "parent-only (user mcpServers collision)"
    consola.info(
      `github-router tools wired into Claude sessions: MCP [${servers}], ${runtime.personas.length} subagents, ${skillsWritten} skills.`,
    )
    return { cleanup: runtime.cleanup, nonce: runtime.nonce }
  } catch (err) {
    consola.warn(
      `Could not wire the github-router MCP/skills layer: ${
        err instanceof Error ? err.message : String(err)
      }. Claude still works, without the extra tools.`,
    )
    return NOOP
  }
}
