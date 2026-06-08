import process from "node:process"

import { defineCommand } from "citty"
import consola from "consola"

import { enableFileLogging } from "./lib/file-log-reporter"
import { launchChild } from "./lib/launch"
import { listModelsForEndpoint } from "./lib/model-validation"
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_MODEL_FALLBACKS,
} from "./lib/port"
import {
  getCodexEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"
import { runSelfUpdate } from "./lib/self-update"
import { state } from "./lib/state"
import { toolbeltEnabled } from "./lib/toolbelt"
import { provisionToolbelt } from "./lib/toolbelt/provision"
import { provisionAndIndexColbert } from "./lib/colbert"
import { provisionBrowserAssets } from "./lib/browser-mcp/provision"
import { hasSupportedBrowserInstalled } from "./lib/browser-mcp/browser-detect"
import { resolveCodexModel } from "./lib/utils"

export const codex = defineCommand({
  meta: {
    name: "codex",
    description: "Start the proxy server and launch Codex CLI",
  },
  args: {
    ...sharedServerArgs,
    model: {
      alias: "m",
      type: "string",
      description: "Override the default model for Codex CLI",
    },
  },
  async run({ args }) {
    if (!process.stdout.isTTY) {
      consola.error("The codex subcommand requires a TTY (interactive terminal).")
      process.exit(1)
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)

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

    // Best-effort self-update (detached, applies next launch).
    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    // Materialize the LLM toolbelt in the background (PATH prepend is in
    // getCodexEnvVars). Best-effort; never blocks launch.
    if (toolbeltEnabled()) {
      void provisionToolbelt().catch(() => {})
    }

    // Best-effort ColBERT semantic-search provision + background index of
    // the launch cwd. ON by default; never blocks launch, never throws.
    void provisionAndIndexColbert()

    // Best-effort: materialize the browser extension + bridge into the
    // stable app-dir and stamp the running version. Gated inline (browse
    // opt-in + a supported browser) rather than via browserToolsEnabled()
    // so the codex command path doesn't eagerly pull the compressor /
    // worker-agent graph. Never blocks launch, never throws.
    const browseOptIn =
      state.browseEnabled || process.env.GH_ROUTER_ENABLE_BROWSE === "1"
    if (browseOptIn && hasSupportedBrowserInstalled()) {
      void provisionBrowserAssets().catch((err) =>
        consola.debug("Browser extension provisioning failed:", err),
      )
    }

    const usingDefault = !args.model
    const requestedModel = args.model ?? DEFAULT_CODEX_MODEL

    // Resolve model before printing success message (so we show the actual model)
    // but enable file logging first so resolution warnings go to file, not terminal
    enableFileLogging()

    let codexModel = resolveCodexModel(requestedModel)
    if (codexModel !== requestedModel) {
      consola.info(`Model "${requestedModel}" resolved to "${codexModel}"`)
    }

    // For the implicit-default path only, walk DEFAULT_CODEX_MODEL_FALLBACKS
    // when the default isn't in the resolved Copilot model list. Layered on
    // top of resolveCodexModel's "best /responses model" fallback — that
    // remains the final safety net when every named fallback misses.
    if (usingDefault && state.models) {
      const inCache = (id: string) =>
        state.models?.data.some((m) => m.id === id) ?? false
      if (!inCache(codexModel)) {
        for (const fallback of DEFAULT_CODEX_MODEL_FALLBACKS) {
          const resolved = resolveCodexModel(fallback)
          if (inCache(resolved)) {
            consola.info(
              `Default model "${codexModel}" not in your Copilot model list; falling back to "${resolved}".`,
            )
            codexModel = resolved
            break
          }
        }
      }
    }

    // Validate model exists in Copilot model list
    const modelEntry = state.models?.data.find((m) => m.id === codexModel)
    if (!modelEntry) {
      const available = listModelsForEndpoint("/responses")
      consola.warn(
        `Model "${codexModel}" not found. Available codex models: ${available.join(", ")}`,
      )
    } else {
      const ctx = modelEntry.capabilities?.limits?.max_context_window_tokens
      if (ctx) consola.info(`Model context window: ${ctx.toLocaleString()} tokens`)
    }

    // Print to stderr directly — consola's terminal reporter is already gone
    process.stderr.write(`Server ready on ${serverUrl}, launching Codex CLI (${codexModel})...\n`)

    const envVars = getCodexEnvVars(serverUrl)
    const extraArgs = ((args as unknown as Record<string, unknown>)._ as string[]) ?? []

    launchChild(
      {
        kind: "codex",
        envVars,
        extraArgs,
        model: codexModel,
        serverUrl,
      },
      server,
    )
  },
})
