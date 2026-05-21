import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import {
  autoUpdateClaude,
  checkClaudeVersion,
} from "./lib/claude-version-check"
import {
  injectPeerMcpIntoMirror,
  resolveCodexCliBackend,
  writePeerMcpRuntimeFiles,
} from "./lib/codex-mcp-config"
import { enableFileLogging } from "./lib/file-log-reporter"
import { getCodexVersion, launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import { ensureClaudeConfigMirror, removeOwnClaudeConfigMirror } from "./lib/paths"
import { buildPeerAwarenessSnippet } from "./lib/peer-mcp-personas"
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_FALLBACKS,
} from "./lib/port"
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
      description: "Override the default model for Claude Code",
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
        "Check for and install latest Claude Code on launch (throttled to once per hour via ~/.local/share/github-router/last-update-check). Set to false (--no-auto-update) to keep the current installed version. Falls back gracefully if npm/network unavailable.",
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
              await autoUpdateClaude(versionCheck.latestVersion)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              consola.warn(
                `Auto-update of Claude Code from ${versionCheck.installedVersion} to ${versionCheck.latestVersion} failed (${msg}); continuing with installed version. Run \`npm install -g @anthropic-ai/claude-code@latest\` manually to retry.`,
              )
            }
          } else {
            consola.warn(
              `Claude Code v${versionCheck.installedVersion} is installed; v${versionCheck.latestVersion} is available. Run with --auto-update (the default) to install on launch, or \`npm install -g @anthropic-ai/claude-code@latest\` manually.`,
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
    //     Anthropic-published slug (e.g. `claude-opus-4-7`) so Claude Code's
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
    const usingDefault = !args.model
    const requestedSlug = args.model ?? DEFAULT_CLAUDE_MODEL
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

        const runtime = await writePeerMcpRuntimeFiles(serverUrl, {
          codexCli: backend === "cli",
          geminiAvailable,
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
        process.stderr.write(
          `Peer MCP wired (backend=${backend}, personas=[${personaNames}], `
            + `subagent .md files=${runtime.agentMdPaths.length}, ${subagentVisibility}).\n`,
        )

        // Awareness snippet: append a short, non-prescriptive system-prompt
        // section telling Claude *what* peer-review tools exist and *when*
        // they tend to be useful — Claude decides *whether* to call them.
        // The auto-invocation triggers live in each MCP tool's own
        // `description` (the prescriptive layer); this snippet is the
        // awareness layer. Opt out with `GH_ROUTER_PEER_AWARENESS` set to
        // 0, false, no, off, or empty string (case-insensitive, trimmed)
        // — same surface as the CLAUDE_CODE_* opt-outs documented in
        // docs/claude-env-injection.md.
        const peerAwarenessOptOut = (
          process.env.GH_ROUTER_PEER_AWARENESS ?? "1"
        )
          .trim()
          .toLowerCase()
        const peerAwarenessDisabled =
          peerAwarenessOptOut === ""
          || peerAwarenessOptOut === "0"
          || peerAwarenessOptOut === "false"
          || peerAwarenessOptOut === "off"
          || peerAwarenessOptOut === "no"
        if (!peerAwarenessDisabled) {
          extraArgs.push(
            "--append-system-prompt",
            buildPeerAwarenessSnippet({
              codexCli: backend === "cli",
              geminiAvailable,
            }),
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
