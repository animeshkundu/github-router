import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import {
  resolveCodexCliBackend,
  writePeerMcpRuntimeFiles,
} from "./lib/codex-mcp-config"
import { enableFileLogging } from "./lib/file-log-reporter"
import { getCodexVersion, launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
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
    let onShutdown: (() => Promise<void>) | undefined
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
        onShutdown = runtime.cleanup

        extraArgs.push("--mcp-config", runtime.mcpConfigPath)
        if ((args as Record<string, unknown>)["codex-mcp-only"] === true) {
          extraArgs.push("--strict-mcp-config")
        }

        const personaNames = runtime.personas.map((p) => p.agentName).join(", ")
        process.stderr.write(
          `Peer MCP wired (backend=${backend}, personas=[${personaNames}], `
            + `subagent .md files=${runtime.agentMdPaths.length}).\n`,
        )
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
