import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import {
  checkClaudeVersion,
  updateClaude,
} from "./lib/claude-version-check"
import { runSelfUpdate } from "./lib/self-update"
import {
  injectPeerMcpIntoMirror,
  resolveCodexCliBackend,
  resolveGroupKeysFromMirror,
  writePeerMcpRuntimeFiles,
} from "./lib/codex-mcp-config"
import { enableFileLogging } from "./lib/file-log-reporter"
import { getCodexVersion, launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import { ensureClaudeConfigMirror, removeOwnClaudeConfigMirror } from "./lib/paths"
import { buildPeerAwarenessSnippet, type McpGroup } from "./lib/peer-mcp-personas"
import { appendPeerAwarenessToMirroredClaudeMd, appendToolbeltAwarenessToMirroredClaudeMd, prependStyleDirectiveToMirroredClaudeMd } from "./lib/claude-md-injection"
import { availableToolCommands, buildToolbeltAwareness, toolbeltEnabled } from "./lib/toolbelt"
import { provisionToolbelt } from "./lib/toolbelt/provision"
import { provisionAndIndexColbert } from "./lib/colbert"
import { startKeepAwake, stopKeepAwake } from "./lib/keep-awake"
import { provisionBrowserAssets } from "./lib/browser-mcp/provision"
import {
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
  pickClaudeDefault,
} from "./lib/port"
import {
  browserToolsEnabled,
  standInToolEnabled,
  workerToolsEnabled,
} from "./lib/mcp-capabilities"
import {
  getClaudeCodeEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"
import { state } from "./lib/state"
import { resolveModel } from "./lib/utils"

export const claude = defineCommand({
  meta: {
    name: "claude",
    description: "Start the proxy server and launch Claude Code",
  },
  args: {
    ...sharedServerArgs,
    model: {
      alias: "m",
      type: "string",
      description:
        "Override the default model for Claude Code. Accepts a full slug (e.g. claude-opus-4-7) or an Opus family shorthand (e.g. 4.7, 4.8, 4.6) which expands to the best variant for that family — adding the [1m] suffix when a 1M-context backend is in the catalog.",
    },
    "codex-mcp": {
      type: "boolean" as const,
      default: true,
      description:
        "Wire peer-model MCP personas (codex-critic, codex-reviewer, gemini-critic) into the spawned Claude Code session",
    },
    "codex-cli": {
      type: "boolean" as const,
      default: false,
      description:
        "Add a `codex mcp-server` stdio backend so codex-implementer can mutate files. Requires codex CLI 0.129+; gracefully falls back to HTTP-only if absent.",
    },
    "codex-mcp-only": {
      type: "boolean" as const,
      default: false,
      description:
        "Pass --strict-mcp-config to claude code so only github-router's MCP servers are loaded (hides user's existing MCP servers)",
    },
    stealth: {
      type: "boolean" as const,
      default: false,
      description:
        "Opt back into VS Code-only beta header filtering. Loses leverage features (task budgets, token-efficient tools, prompt caching, etc.) but minimizes the wire-fingerprint difference from VS Code Copilot Chat. By default the `claude` subcommand enables extended/leverage betas because the spawned Claude Code already identifies itself via UA and other headers — partial stealth doesn't buy much.",
    },
    "auto-update": {
      type: "boolean" as const,
      default: true,
      description:
        "Check for and install the latest Claude Code on launch via `claude update` (throttled to once per hour via ~/.local/share/github-router/last-update-check). `claude update` respects the real install method (native installer or npm), so it never creates a conflicting second install; builds too old to support it fall back to `npm install -g @anthropic-ai/claude-code@latest`. Set to false (--no-auto-update) to check and warn only. Falls back gracefully if claude/npm/network unavailable.",
    },
    "update-check": {
      type: "boolean" as const,
      default: true,
      description:
        "Check the npm registry for a newer Claude Code version on launch and warn if stale (non-blocking ~500ms cost). Set to false (--no-update-check) to skip the check entirely (useful for offline/CI). Independent from --auto-update: --no-update-check implies no auto-install (nothing to install since we never check).",
    },
  },
  async run({ args }) {
    if (!process.stdout.isTTY) {
      consola.error("The claude subcommand requires a TTY (interactive terminal).")
      process.exit(1)
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)

    // Phase E P2.2: stealth-vs-leverage policy.
    // The `claude` subcommand defaults to LEVERAGE mode (extended-betas
    // ON) because the spawned Claude Code already identifies itself via
    // UA / editor-version / x-app headers — partial stealth doesn't
    // meaningfully reduce the wire fingerprint, and the cost of stealth
    // is losing features the user explicitly chose to install Claude
    // Code for (--max-budget-usd, token-efficient tools, prompt caching,
    // structured outputs, MCP, etc.).
    //
    // The `--stealth` flag opts back into the VS Code-only filter for
    // users who specifically want minimal wire diff over leverage.
    // The shared `--extended-betas` flag still works (treated as alias).
    //
    // Note: `advisor-tool-` is stripped in BOTH modes regardless of this
    // setting (Phase A: Copilot 400s on it). ADVISOR will be served via
    // Phase I's proxy-side translate path independently.
    if (args.stealth) {
      // Stealth wins if explicitly requested.
      parsed.extendedBetas = false
      consola.info(
        "Stealth mode: VS Code-only beta filtering. Leverage features disabled.",
      )
    } else if (!args["extended-betas"]) {
      // No explicit --extended-betas AND no --stealth → default ON.
      parsed.extendedBetas = true
    }
    // If user passed --extended-betas explicitly, parsed already reflects it.

    // Phase H P2: Claude Code version check + opt-in auto-update.
    // Default: check + auto-install if newer version available
    // (throttled to once per hour). The user explicitly chose to install
    // a Claude Code wrapper — they want the latest features and bug
    // fixes. Opt-out via --no-auto-update (check only, warn) or
    // --no-update-check (silence entirely). Best-effort: skips silently
    // if npm is offline or claude is not on PATH. The check happens
    // BEFORE setupAndServe so a stale version doesn't get spawned.
    if (args["update-check"] !== false) {
      try {
        const versionCheck = await checkClaudeVersion({
          noCheck: false,
        })
        if (versionCheck.skipped && versionCheck.skipReason === "no-claude") {
          // Claude isn't on PATH — let launchChild surface the more
          // contextual "claude not found" error in the spawn step.
          consola.debug(
            "claude --version probe failed; skipping auto-update.",
          )
        } else if (versionCheck.skipped && versionCheck.skipReason === "no-npm") {
          // npm view failed — likely offline. Don't block launch.
          consola.debug(
            "npm view @anthropic-ai/claude-code failed; skipping auto-update check (likely offline).",
          )
        } else if (
          versionCheck.needsUpdate
          && versionCheck.installedVersion
          && versionCheck.latestVersion
        ) {
          if (args["auto-update"] !== false) {
            try {
              await updateClaude(versionCheck.latestVersion)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              consola.warn(
                `Auto-update of Claude Code from ${versionCheck.installedVersion} to ${versionCheck.latestVersion} failed (${msg}); continuing with installed version. Run \`claude update\` (or \`npm install -g @anthropic-ai/claude-code@latest\`) manually to retry.`,
              )
            }
          } else {
            consola.warn(
              `Claude Code v${versionCheck.installedVersion} is installed; v${versionCheck.latestVersion} is available. Run with --auto-update (the default) to install on launch, or \`claude update\` manually.`,
            )
          }
        }
      } catch (err) {
        // Whole version-check should never block launch.
        consola.debug("Claude version check failed:", err)
      }
    }

    let server: Awaited<ReturnType<typeof setupAndServe>>["server"]
    let serverUrl: string
    try {
      const result = await setupAndServe({
        ...parsed,
        port: parsed.port, // undefined = random port
        silent: true,
      })
      server = result.server
      serverUrl = result.serverUrl
    } catch (error) {
      consola.error("Failed to start server:", error instanceof Error ? error.message : error)
      process.exit(1)
    }

    // Queue a best-effort self-update of github-router itself (detached,
    // applies next launch). Fire-and-forget so the bounded npm probe
    // never delays spawning Claude Code.
    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    // Provision the router-owned CLAUDE_CONFIG_DIR with our synthetic
    // .credentials.json + a snapshot copy of the user's ~/.claude/.
    // The spawned Claude Code (and any teammates it spawns via the
    // agent-teams primitive) reads this dir instead of ~/.claude/,
    // finds our synthetic credential, and authenticates — closing the
    // teammate-spawn allowlist gap that drops ANTHROPIC_AUTH_TOKEN.
    // See ensureClaudeConfigMirror in src/lib/paths.ts.
    //
    // Run BEFORE enableFileLogging so a fatal credentials-write failure
    // surfaces on the user's terminal (we only throw on the credentials
    // write — copy failures of individual user files are debug-logged
    // and skipped).
    try {
      await ensureClaudeConfigMirror()
    } catch (err) {
      consola.error(
        `Failed to provision CLAUDE_CONFIG_DIR mirror: ${
          err instanceof Error ? err.message : String(err)
        }. Spawned Claude Code would not be able to authenticate.`,
      )
      process.exit(1)
    }

    enableFileLogging() // redirect errors/warnings to file; suppress terminal output

    // Two slugs flow through this code:
    //   * `chosenSlug` — the value we set for `ANTHROPIC_MODEL`. Must be an
    //     Anthropic-published slug (e.g. `claude-opus-4-8`) so Claude Code's
    //     hardcoded `/model` registry matches it and the UI shows the right
    //     menu entry. The proxy's resolver translates this back to a Copilot
    //     slug at request time, so the actual upstream call still works.
    //   * `resolvedSlug` — the Copilot-side slug after `resolveModel`. Used
    //     only for cache-presence validation (fallback chain) and the
    //     launch banner.
    //
    // For the implicit-default path only, we walk
    // DEFAULT_CLAUDE_MODEL_FALLBACKS when neither the default nor any
    // earlier fallback resolves to a model present in the Copilot cache.
    // Explicit `--model` is respected as-is — including Copilot slugs
    // (which Claude Code's UI won't recognize, but power users may want
    // for explicit pinning).
    // `-m 4.7` / `-m 4.8` shorthand: treat a bare "N.M" value as an
    // Opus-family preference and let pickClaudeDefault pick the best
    // variant for that family (adding [1m] when an opus-N.M-1m backend
    // exists in the catalog). Full slugs and any non-matching string
    // continue to pass through unchanged. `usingDefault` stays false
    // for shorthand so the DEFAULT_CLAUDE_MODEL_FALLBACKS walk doesn't
    // override an explicit family request with the next-older Opus.
    const usingDefault = !args.model
    const opusFamilyShorthand = args.model?.match(/^(\d+\.\d+)$/)?.[1]
    const requestedSlug = opusFamilyShorthand
      ? pickClaudeDefault(opusFamilyShorthand)
      : (args.model ?? pickClaudeDefault())
    let chosenSlug = requestedSlug
    let resolvedSlug = resolveModel(chosenSlug)

    if (usingDefault && state.models) {
      const inCache = (slug: string) =>
        state.models?.data.some((m) => m.id === resolveModel(slug)) ?? false
      if (!inCache(chosenSlug)) {
        for (const fallback of DEFAULT_CLAUDE_MODEL_FALLBACKS) {
          if (inCache(fallback)) {
            consola.info(
              `Default model "${chosenSlug}" not in your Copilot model list; falling back to "${fallback}".`,
            )
            chosenSlug = fallback
            resolvedSlug = resolveModel(fallback)
            break
          }
        }
      }
    }

    if (resolvedSlug !== chosenSlug) {
      consola.info(`Model "${chosenSlug}" resolved to "${resolvedSlug}"`)
    }
    const modelEntry = state.models?.data.find((m) => m.id === resolvedSlug)
    if (!modelEntry) {
      const available = listModelsForEndpoint("/v1/messages")
      consola.warn(
        `Model "${resolvedSlug}" not found. Available claude models: ${available.join(", ")}`,
      )
    }

    // Banner shows the round-trip so the user sees both names. Claude Code's
    // UI will display the chosenSlug; Copilot upstream sees resolvedSlug.
    const banner =
      chosenSlug === resolvedSlug
        ? chosenSlug
        : `${chosenSlug} → ${resolvedSlug}`
    // Print to stderr directly — consola's terminal reporter is already gone
    process.stderr.write(`Server ready on ${serverUrl}, launching Claude Code (${banner})...\n`)

    const envVars = getClaudeCodeEnvVars(serverUrl, chosenSlug)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    // LLM toolbelt: materialize curated CLI tools (rg/fd/jq/sd/sg/yq)
    // into the router bin dir prepended to the agent's PATH (the prepend
    // itself is done in getClaudeCodeEnvVars). Materialization runs in
    // the BACKGROUND so it never delays launch; the awareness one-liner
    // lists EVERY curated tool reachable this launch (system installs +
    // the toolbelt bin), appended to the mirrored CLAUDE.md so the main
    // agent AND descendants know which fast tools to prefer. Best-effort.
    if (toolbeltEnabled()) {
      void provisionToolbelt().catch((err) =>
        consola.debug("Toolbelt provisioning failed:", err),
      )
      const toolbeltLine = buildToolbeltAwareness(availableToolCommands())
      if (toolbeltLine) {
        try {
          await appendToolbeltAwarenessToMirroredClaudeMd(toolbeltLine)
        } catch (err) {
          consola.warn(
            `Toolbelt CLAUDE.md append failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }

    // Best-effort ColBERT semantic-search provision + background index of
    // the launch cwd (if a git repo). ON by default; never blocks launch,
    // never throws. Opt out with GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1.
    void provisionAndIndexColbert()

    // Best-effort: keep the machine awake while the proxy/Claude Code
    // session runs (win32 default-on; opt out GH_ROUTER_DISABLE_KEEP_AWAKE=1).
    // Released via stopKeepAwake() in the shutdown chain below AND via the
    // module's own self-registered SIGINT/SIGTERM/exit reaper.
    startKeepAwake()

    // Best-effort: materialize the browser extension + bridge into the
    // stable app-dir and stamp the running version, so a one-time "Load
    // unpacked" survives npx/bunx upgrades. Gated on --browse; never
    // blocks launch, never throws.
    if (browserToolsEnabled()) {
      void provisionBrowserAssets().catch((err) =>
        consola.debug("Browser extension provisioning failed:", err),
      )
    }

    // Peer-MCP wiring. Default-on. When enabled:
    //   1. Decide between HTTP backend (always works, read-only personas)
    //      and the `--codex-cli` stdio backend (requires codex 0.129+,
    //      adds the implementer persona).
    //   2. Probe the live Copilot catalog for gemini-3.1-pro-preview.
    //   3. Generate a per-launch nonce, write the MCP config tempfile
    //      under PATHS.CLAUDE_RUNTIME_DIR with mode 0o600, AND write
    //      one .md subagent file per peer agent into ~/.claude/agents/
    //      (Phase 2.5 — `--agents` JSON does NOT populate Claude Code's
    //      Task subagent_type enum on v2.1.138; .md files in the canonical
    //      agents dir do).
    //   4. Inject `--mcp-config <path>` into the spawned Claude Code's
    //      argv. Add `--strict-mcp-config` if the user explicitly opts
    //      out of their existing MCP servers. The `--agents` JSON path
    //      is intentionally NOT passed: the .md registration in the
    //      canonical agents dir is the authoritative surface.
    //   5. Plumb `cleanup()` into launchChild's onShutdown so tempfiles
    //      are unlinked on signal exit.
    //
    // The per-launch CLAUDE_CONFIG_DIR mirror is ALWAYS cleaned up on
    // shutdown (regardless of codex-mcp), since `ensureClaudeConfigMirror`
    // above always provisioned it. We chain the peer-MCP cleanup
    // (if any) ahead of the mirror removal so files inside the mirror
    // get unlinked first via known paths; the recursive `fs.rm` is
    // belt-and-braces for everything else.
    const baseShutdown = async (): Promise<void> => {
      await stopKeepAwake()
      await removeOwnClaudeConfigMirror()
    }
    let onShutdown: () => Promise<void> = baseShutdown
    const codexMcpEnabled = (args as Record<string, unknown>)["codex-mcp"] !== false
    if (codexMcpEnabled) {
      try {
        const requestedCli =
          ((args as Record<string, unknown>)["codex-cli"] as boolean | undefined) ?? false
        const backend = resolveCodexCliBackend({
          requested: requestedCli,
          codexInfo: requestedCli ? getCodexVersion() : null,
        })
        const geminiAvailable =
          state.models?.data.some((m) => /^gemini-3\..*pro/i.test(m.id)) ?? false
        if (!geminiAvailable) {
          consola.info(
            "gemini-3.1-pro-preview not found in your Copilot model catalog; gemini-critic persona will not be registered.",
          )
        }

        // Which scoped MCP servers to register. `peers` + `search` are
        // always on; `workers` / `decide` / `browser` only when their gate
        // passes at launch (avoids registering a server whose tools would
        // all be filtered out of tools/list). Resolve each group's
        // `.claude.json` config key ONCE (bare, or `gh-router-<group>` on
        // collision) and thread it into every channel — the mcpServers
        // entries, the persona .md routing strings, and the awareness
        // snippet — so a user-side `browser`/`search` MCP never silently
        // hijacks or drops one of ours.
        const enabledGroups: Array<McpGroup> = ["peers", "search"]
        if (workerToolsEnabled()) enabledGroups.push("workers")
        if (standInToolEnabled()) enabledGroups.push("decide")
        if (browserToolsEnabled()) enabledGroups.push("browser")
        const { keys: groupKeys, skipped: skippedGroups } =
          await resolveGroupKeysFromMirror(enabledGroups)

        const runtime = await writePeerMcpRuntimeFiles(serverUrl, {
          codexCli: backend === "cli",
          geminiAvailable,
          groupKeys,
        })
        state.peerMcpNonce = runtime.nonce
        onShutdown = async (): Promise<void> => {
          await runtime.cleanup()
          await baseShutdown()
        }

        // Subagent MCP visibility: inject `gh-router-peers` (and the
        // `codex-cli` stdio entry when enabled) into the mirrored
        // `<CLAUDE_CONFIG_DIR>/.claude.json` so subagents — Agent-tool
        // subagents, forks, agent-teams subprocesses — discover the peer
        // MCP from persistent (user-scope) config rather than the parent's
        // ephemeral --mcp-config CLI flag. Same nonce as runtime files
        // (the proxy validates Authorization against the launch nonce
        // regardless of which channel the request came through).
        //
        // On collision with a user-side entry of the same name, this
        // returns ok:false; we then keep --mcp-config as the fallback so
        // at least the parent session retains the peer tools (subagents
        // remain blind in that case, by design — explicit branch, not
        // silent precedence).
        const injected = await injectPeerMcpIntoMirror(serverUrl, {
          codexCli: backend === "cli",
          geminiAvailable,
          groupKeys,
          nonce: runtime.nonce,
        })

        // Channel selection: prefer the mirror (subagent-visible) when
        // injection succeeded. Only fall back to --mcp-config when
        // injection refused due to a user-side collision. Pushing BOTH
        // would register the same server name twice (mirror + CLI flag),
        // which is ambiguous across Claude Code versions.
        if (!injected.ok) {
          extraArgs.push("--mcp-config", runtime.mcpConfigPath)
          if ((args as Record<string, unknown>)["codex-mcp-only"] === true) {
            extraArgs.push("--strict-mcp-config")
          }
        } else if ((args as Record<string, unknown>)["codex-mcp-only"] === true) {
          // User asked for strict-MCP-only but the mirror inject path
          // can't enforce that (other user-scope MCPs already in the
          // mirror's snapshot are visible). Warn so the flag's mismatch
          // with the new behavior is obvious.
          consola.warn(
            "--codex-mcp-only has no effect when peer MCP is wired via the "
              + "mirrored .claude.json (the user's existing user-scope MCPs in "
              + "the snapshot are still visible). Pass --no-codex-mcp to skip "
              + "peer-MCP wiring entirely.",
          )
        }

        const personaNames = runtime.personas.map((p) => p.agentName).join(", ")
        const subagentVisibility = injected.ok
          ? `subagent-visible (mirrored mcpServers: [${injected.serversAdded.join(", ")}])`
          : `subagent-INVISIBLE (collision on user-side mcpServers: [${injected.conflictingServers.join(", ")}]; parent-only via --mcp-config)`
        const skippedNote =
          skippedGroups.length > 0
            ? ` WARNING: groups [${skippedGroups.join(", ")}] skipped — both the bare and \`gh-router-<group>\` keys collide with your own mcpServers; those tools are unavailable this session (rename the user-side server to re-enable).`
            : ""
        process.stderr.write(
          `Peer MCP wired (backend=${backend}, personas=[${personaNames}], `
            + `subagent .md files=${runtime.agentMdPaths.length}, ${subagentVisibility}).${skippedNote}\n`,
        )

        // Awareness snippet: append a short, descriptive system-prompt
        // section telling Claude *what* peer-review tools exist — Claude
        // decides *whether* to call them based on each tool's own
        // `description` (the routing layer). This is the awareness layer.
        //
        // Delivery is dual-surface, both unconditional:
        //   1. --append-system-prompt — system-turn position, strongest
        //      attention weight; reaches the main agent only.
        //   2. <CLAUDE_CONFIG_DIR>/CLAUDE.md (appended) — user-turn
        //      <claudeMd> wrapper; reaches Agent-tool subagents and
        //      agent-teams teammates that inherit CLAUDE_CONFIG_DIR but
        //      not --append-system-prompt.
        //
        // Capability gates: worker_* and stand_in mentions are gated on
        // the same predicates the /mcp tools/list uses (workerToolsEnabled
        // / standInToolEnabled), so the snippet never names a tool that
        // is missing from the live catalog.
        //
        // Previously gated by GH_ROUTER_PEER_AWARENESS (default-on).
        // The flag was dropped (per plan: it served no purpose now that
        // the snippet is default-on across both surfaces). Existing
        // `GH_ROUTER_PEER_AWARENESS=0` shell exports are silent no-ops.
        const peerSnippet = buildPeerAwarenessSnippet({
          codexCli: backend === "cli",
          geminiAvailable,
          workerToolsAvailable: workerToolsEnabled(),
          standInAvailable: standInToolEnabled(),
          browseAvailable: state.browseEnabled,
          powerBrowseAvailable: state.powerBrowseEnabled,
          groupKeys,
        })
        extraArgs.push("--append-system-prompt", peerSnippet)
        // Ordering invariant: this MUST run AFTER ensureClaudeConfigMirror()
        // has resolved (above in this same handler), so the snapshot of
        // the user's ~/.claude/CLAUDE.md is already in place before we
        // append our marker block. The helper's own mirror-only safety
        // guard rejects writes outside CLAUDE_CONFIG_DIR as defence in
        // depth. Failures warn-and-continue — the main agent already has
        // the awareness via --append-system-prompt, so this surface is
        // descendant-reach enhancement, not a launch-blocker.
        try {
          await appendPeerAwarenessToMirroredClaudeMd(peerSnippet)
        } catch (err) {
          consola.warn(
            `Peer-awareness CLAUDE.md append failed (main agent still covered via --append-system-prompt): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
        // Style directive: prepend a short writing/communication style
        // directive at the TOP of the mirrored CLAUDE.md so every
        // spawned agent reads it first. Independent marker fence from
        // the peer-awareness block, so the two coexist (style at top,
        // user content in the middle, peer-awareness at the bottom).
        // Best-effort like the append above.
        try {
          await prependStyleDirectiveToMirroredClaudeMd()
        } catch (err) {
          consola.warn(
            `Style-directive CLAUDE.md prepend failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      } catch (err) {
        consola.warn(
          `Peer MCP wiring failed (claude will launch without it): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    launchChild(
      { kind: "claude-code", envVars, extraArgs, model: chosenSlug },
      server,
      { onShutdown },
    )
  },
})
