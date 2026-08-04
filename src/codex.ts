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
import { colbertDegradedWarning, provisionAndIndexColbert } from "./lib/colbert"
import { startKeepAwake } from "./lib/keep-awake"
import { warmTreeSitterPool } from "./lib/tree-sitter-pool/pool"
import { provisionBrowserAssets } from "./lib/browser-mcp/provision"
import { hasSupportedBrowserInstalled } from "./lib/browser-mcp/browser-detect"
import { resolveCodexModel, resolveModel } from "./lib/utils"

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

    // Surface a terminally-failed semantic index to the HUMAN (see the note
    // in claude.ts). Fire-and-forget; lexical search still works.
    void colbertDegradedWarning()
      .then((warning) => {
        if (warning) process.stderr.write(`${warning}\n`)
      })
      .catch(() => {})

    // Best-effort, bounded launch warm-up: ready one tree-sitter worker.
    // Opt out with GH_ROUTER_DISABLE_TS_POOL_WARMUP=1.
    void warmTreeSitterPool()

    // Best-effort: keep the machine awake while the proxy/Codex session
    // runs (win32 default-on; opt out GH_ROUTER_DISABLE_KEEP_AWAKE=1).
    // Self-registered SIGINT/SIGTERM/exit reaper releases the assertion.
    startKeepAwake()

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

    // For the implicit-default path only: honor the explicit fallback order
    // (DEFAULT_CODEX_MODEL, then DEFAULT_CODEX_MODEL_FALLBACKS led by gpt-5.5)
    // by cache presence BEFORE resolveCodexModel's codex-slug-preferring
    // "best /responses model" safety net. `resolveModel` (NOT resolveCodexModel)
    // walks the chain, so the codex-slug preference can't shadow an
    // earlier-in-chain named fallback (e.g. gpt-5.5) that IS present. The
    // resolveCodexModel result above stays as the FINAL safety net, used only
    // when none of the named chain entries is in the catalog.
    if (usingDefault && state.models) {
      const inCache = (id: string) =>
        state.models?.data.some((m) => m.id === id) ?? false
      const firstPresent = [DEFAULT_CODEX_MODEL, ...DEFAULT_CODEX_MODEL_FALLBACKS]
        .map((id) => resolveModel(id))
        .find((id) => inCache(id))
      if (firstPresent) {
        if (firstPresent !== codexModel) {
          consola.info(
            `Default model "${DEFAULT_CODEX_MODEL}" not in your Copilot model list; falling back to "${firstPresent}".`,
          )
        }
        codexModel = firstPresent
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
