import path from "node:path"

import consola from "consola"

import { injectAttributionSuppressionIntoSettingsFile } from "../attribution-settings"
import {
  BUILTIN_SUBAGENT_DEFINITIONS,
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
  configureServePermissionsBypass,
  injectMcpServerAllowRules,
  sanitizeServeSettingsEnv,
} from "../mcp-permissions-settings"
import {
  agentToolsEnabled,
  browseAgentEnabled,
  browserCompoundToolsEnabled,
  browserToolsEnabled,
  fleetToolsEnabled,
  geminiAvailable,
  implementerSubagentModel,
  standInToolEnabled,
  workerToolsEnabled,
} from "../mcp-capabilities"
import { buildPlanReviewHookCommand, planReviewEnabled } from "../orchestration/plan-review-hook"
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

export interface ServeEnhancementOpts {
  /** Route Codex personas through a local `codex mcp-server` (stdio) when the backend resolved to "cli". */
  codexCli?: boolean
  /** True when the control plane is reachable beyond loopback (a --tunnel or --public-url is active). Gates the highest-blast-radius capabilities OFF by default: the server-side browser MCP (a session-hijack / SSRF / cloud-metadata primitive when reachable remotely) and first-mate (mints a repo+workflow GitHub write token). */
  tunnelExposed?: boolean
  /** Operator opt-in to expose the browser MCP over the tunnel despite the risk. */
  browseOverTunnel?: boolean
  /** Operator opt-in to expose first-mate over the tunnel despite the risk. */
  agentsOverTunnel?: boolean
  /** Operator opt-in to expose the fleet MCP over the tunnel despite the risk
   *  (fleet drives remote coding sessions with the operator's stored fleet
   *  credentials — an equal-or-higher blast radius than the browser MCP). */
  fleetOverTunnel?: boolean
}

const NOOP: ServeEnhancementsHandle = { cleanup: async () => {} }

/**
 * Wire the github-router enhancement layer into the router-owned
 * CLAUDE_CONFIG_DIR mirror so a CloudCLI-spawned Claude session gets the same
 * tools `github-router claude` provides:
 *   - the scoped MCP servers (peers / search / orchestrate, plus workers /
 *     decide / browser / fleet / first-mate when their gate passes) — the
 *     SDK-spawned claude reads them from the mirror's `.claude.json`,
 *   - the peer-critic / worker / implementer subagents (`.md` files written into
 *     the mirror's `agents/`),
 *   - the gh-* skills (research / orchestrate / floor-keeper / worker).
 *
 * Best-effort: on any failure Claude still works, just without the extras.
 * Must run AFTER `ensureClaudeConfigMirror()` and BEFORE CloudCLI is spawned.
 * Tab-specific bits (ai-or-die hooks, artifact review) are intentionally left
 * out — they don't apply to the serve control plane.
 */
export async function provisionServeEnhancements(
  serverUrl: string,
  opts: ServeEnhancementOpts = {},
): Promise<ServeEnhancementsHandle> {
  try {
    const tunnelExposed = opts.tunnelExposed === true
    const browseAllowed = browserToolsEnabled() && (!tunnelExposed || opts.browseOverTunnel === true)
    const firstMateAllowed = agentToolsEnabled() && (!tunnelExposed || opts.agentsOverTunnel === true)
    const fleetAllowed = fleetToolsEnabled() && (!tunnelExposed || opts.fleetOverTunnel === true)

    const enabledGroups: McpGroup[] = ["peers", "search", "orchestrate"]
    if (workerToolsEnabled()) enabledGroups.push("workers")
    if (standInToolEnabled()) enabledGroups.push("decide")
    if (browseAllowed) enabledGroups.push("browser")
    if (fleetAllowed) enabledGroups.push("fleet")
    if (firstMateAllowed) enabledGroups.push("first-mate")

    const gem = geminiAvailable()
    const { keys: groupKeys } = await resolveGroupKeysFromMirror(enabledGroups)

    const runtime = await writePeerMcpRuntimeFiles(serverUrl, {
      codexCli: opts.codexCli === true,
      geminiAvailable: gem,
      groupKeys,
      workerToolsAvailable: workerToolsEnabled(),
      browseAvailable: browseAllowed && browseAgentEnabled(),
      implementerModel: implementerSubagentModel(),
      // Serve-only: register Claude Code's built-in Explore/Plan/general-purpose
      // subagents (the Agent SDK doesn't) so the model's habitual Agent() calls
      // resolve. Never passed by `github-router claude` (would shadow the CLI's
      // native built-ins).
      builtinSubagents: BUILTIN_SUBAGENT_DEFINITIONS,
    })
    // The proxy's /mcp handler authorizes tool calls against this per-launch
    // nonce (the same value baked into the mirrored mcpServers Authorization).
    state.peerMcpNonce = runtime.nonce

    const injected = await injectPeerMcpIntoMirror(serverUrl, {
      codexCli: opts.codexCli === true,
      geminiAvailable: gem,
      groupKeys,
      nonce: runtime.nonce,
    })

    const peerSnippet = buildPeerAwarenessSnippet({
      codexCli: opts.codexCli === true,
      geminiAvailable: gem,
      workerToolsAvailable: workerToolsEnabled(),
      standInAvailable: standInToolEnabled(),
      browseAvailable: browseAllowed,
      compoundBrowseAvailable: browseAllowed && browserCompoundToolsEnabled(),
      powerBrowseAvailable: browseAllowed && state.powerBrowseEnabled,
      agentToolsAvailable: firstMateAllowed,
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

    // Strip serve-inappropriate CLAUDE_CODE_* env keys the user may have set in
    // their real settings.json — notably CLAUDE_CODE_COORDINATOR_MODE, which
    // CloudCLI applies via settingSources and which strips the single serve chat
    // agent down to delegation-only tools (a direct Glob/Read/Bash then fails
    // "not enabled in this context"). UNCONDITIONAL: a working toolset is needed
    // even when GH_ROUTER_SERVE_NO_AUTO_APPROVE=1 keeps permission prompts on.
    const strip = await sanitizeServeSettingsEnv(settingsPath).catch((err) => {
      consola.warn(`Could not sanitize serve settings env: ${String(err)}`)
      return { removed: [] as string[] }
    })
    if (strip.removed.length) {
      consola.info(`Serve: removed ${strip.removed.join(", ")} from the mirror settings (single-agent surface).`)
    }

    // Match `github-router claude`'s default `--dangerously-skip-permissions`:
    // set the mirror's permission default to bypass (no per-tool prompts) AND
    // clear the mirrored allow-list. Opt out with GH_ROUTER_SERVE_NO_AUTO_APPROVE=1.
    if (process.env.GH_ROUTER_SERVE_NO_AUTO_APPROVE !== "1") {
      await configureServePermissionsBypass(settingsPath).catch((err) =>
        consola.warn(`Could not set serve permission defaults: ${String(err)}`),
      )
    }

    // Auto-approve github-router's injected MCP servers via `mcp__<server>` allow
    // rules (on the resolved keys). Redundant under the bypass default above, but
    // load-bearing the moment a serve user switches the composer to PLAN mode:
    // plan mode re-gates tools, and MCP tools (search / peers / workers / …) are
    // exactly the research surface wanted while planning. Runs AFTER the bypass
    // config so the entries survive its allow-list clear. Uses the authoritative
    // injected-server list (`injected.serversAdded` — includes the `codex-cli`
    // stdio server), falling back to the resolved keys + codex-cli on collision.
    const injectedServerKeys = injected.ok
      ? injected.serversAdded
      : [
          ...Object.values(groupKeys).filter((k): k is string => Boolean(k)),
          ...(opts.codexCli === true ? ["codex-cli"] : []),
        ]
    await injectMcpServerAllowRules(settingsPath, injectedServerKeys).catch((err) =>
      consola.warn(`Could not auto-approve injected MCP servers: ${String(err)}`),
    )

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
        const modes = activeDispatchModes({ browse: browseAllowed && browseAgentEnabled() })
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

    if (planReviewEnabled()) {
      try {
        const command = buildPlanReviewHookCommand(process.execPath, process.argv[1])
        // Advisory PostToolUse(ExitPlanMode) hook: non-blocking; findings surface on the next prompt.
        // NOTE (unverified): confirm CloudCLI's Agent-SDK chat actually fires the ExitPlanMode lifecycle;
        // if it never triggers this is a harmless no-op.
        await injectStopHookIntoSettingsFile(settingsPath, command, "PostToolUse", undefined, "ExitPlanMode")
      } catch (err) {
        consola.warn(`Could not register the advisory plan-review hook: ${String(err)}`)
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
