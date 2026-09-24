import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { defineCommand, type ArgsDef } from "citty"
import consola from "consola"

import { checkPiVersion, updatePi } from "./lib/pi-version-check"
import { warnOnTierPriceDriftForModels } from "./lib/pi-tier-windows"
import {
  AIC_LEDGER_ENV,
  AIC_USER_STATUSLINE_ENV,
  buildAicStatusHookCommand,
  injectAicStatusLineIntoSettingsFile,
} from "./lib/aic-statusline-settings"
import { aicLedgerPath, sweepStaleAicLedgerFiles } from "./lib/aic-ledger"
import { resolveSelfInvocation } from "./lib/hook-launcher/self-invocation"
import {
  ensurePiAgentMirror,
  removeOwnPiAgentMirror,
  sweepStalePiAgentMirrors,
} from "./lib/pi-paths"
import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "./lib/pi-extension"
import {
  buildPiAgentFiles,
  buildPiAppendSystem,
  buildPiModelsJson,
  buildPiSettingsJson,
  piLeadModel,
  piProfileModelIds,
  type PiProfileId,
} from "./lib/pi-models-settings"
import { launchChild } from "./lib/launch"
import { registerLaunch, unregisterLaunch } from "./lib/launch-registry"
import { state } from "./lib/state"
import { runSelfUpdate } from "./lib/self-update"
import { enableFileLogging } from "./lib/file-log-reporter"
import { toolbeltEnabled } from "./lib/toolbelt"
import { provisionToolbelt } from "./lib/toolbelt/provision"
import { colbertDegradedWarning, provisionAndIndexColbert } from "./lib/colbert"
import { startKeepAwake, stopKeepAwake } from "./lib/keep-awake"
import { warmTreeSitterPool } from "./lib/tree-sitter-pool/pool"
import { provisionBrowserAssets } from "./lib/browser-mcp/provision"
import { browserToolsEnabled } from "./lib/mcp-capabilities"
import {
  formatBalancedPrerequisiteFailure,
  formatCheapestPrerequisiteFailure,
  profileDescriptor,
  resolveLaunchProfile,
  validateBalancedProfilePrerequisites,
  validateCheapestProfilePrerequisites,
} from "./lib/launch-profile"
import {
  getPiLaunchEnvVars,
  parseSharedArgs,
  setupAndServe,
  sharedServerArgs,
} from "./lib/server-setup"

export const piArgs = {
  ...sharedServerArgs,
  model: {
    alias: "m",
    type: "string",
    description:
      "Pi launch profile: cheapest (Luna-led, cheapest tier) or balanced (Sol-led, most-complex-tasks tier). Only these two aliases are supported for `github-router pi`.",
  },
  "update-check": {
    type: "boolean" as const,
    default: true,
    description:
      "Check the npm registry for a newer Pi release on launch (throttled hourly). Set to false (--no-update-check) to skip (offline/CI).",
  },
  "auto-update": {
    type: "boolean" as const,
    default: true,
    description:
      "Install the latest Pi on launch when stale (default). Set to false (--no-auto-update) to warn only.",
  },
} satisfies ArgsDef

/**
 * Forward child args: every raw token that is NOT one of github-router's
 * own declared flags (or that flag's consumed value); everything after a
 * literal `--` flows verbatim. Local copy of the claude.ts walk so this
 * module doesn't import the Claude launch graph.
 */
export function collectPiPassthroughArgs(
  rawArgs: ReadonlyArray<string>,
  argsDef: ArgsDef,
): string[] {
  const known = new Set<string>()
  const stringTyped = new Set<string>()
  for (const [name, def] of Object.entries(argsDef)) {
    const rawAlias = "alias" in def ? def.alias : undefined
    const aliases =
      rawAlias === undefined ? [] : Array.isArray(rawAlias) ? rawAlias : [rawAlias]
    for (const n of [name, ...aliases]) {
      known.add(n)
      if (def.type === "string") stringTyped.add(n)
    }
  }
  const forwarded: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i]
    if (tok === "--") {
      forwarded.push(...rawArgs.slice(i + 1))
      break
    }
    if (tok === "-" || !tok.startsWith("-")) {
      forwarded.push(tok)
      continue
    }
    const doubleDash = tok.startsWith("--")
    const afterDashes = tok.slice(doubleDash ? 2 : 1)
    const eq = afterDashes.indexOf("=")
    const rawName = eq >= 0 ? afterDashes.slice(0, eq) : afterDashes
    const hasInlineValue = eq >= 0
    const negated = doubleDash && rawName.startsWith("no-")
    const baseName = negated ? rawName.slice(3) : rawName
    const isKnown = known.has(rawName) || (negated && known.has(baseName))
    if (!isKnown) {
      forwarded.push(tok)
      continue
    }
    const consumesValue =
      !negated
      && !hasInlineValue
      && stringTyped.has(rawName)
      && i + 1 < rawArgs.length
      && rawArgs[i + 1] !== "--"
      && !rawArgs[i + 1].startsWith("-")
    if (consumesValue) i++
  }
  return forwarded
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function writeTextFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, { mode: 0o600 })
}

export const pi = defineCommand({
  meta: {
    name: "pi",
    description: "Start the proxy server and launch the Pi coding agent (cheapest/balanced)",
  },
  args: piArgs,
  async run({ args, rawArgs }) {
    const headless = rawArgs.includes("--print") || rawArgs.includes("--mode")
    if (!process.stdout.isTTY && !headless) {
      consola.error("The pi subcommand requires a TTY (interactive terminal), or use --print/--mode for headless runs.")
      process.exit(1)
    }

    const parsed = parseSharedArgs(args as unknown as Record<string, unknown>)
    const launchProfileId = resolveLaunchProfile(args.model)
    if (launchProfileId !== "cheapest" && launchProfileId !== "balanced") {
      process.stderr.write(
        `github-router pi supports only -m cheapest and -m balanced (got ${JSON.stringify(args.model ?? "")}). ` +
          `Run plain \`github-router pi -m cheapest\` or \`github-router pi -m balanced\`.\n`,
      )
      process.exit(1)
    }
    const profileId = launchProfileId as PiProfileId

    let server: Awaited<ReturnType<typeof setupAndServe>>["server"]
    let serverUrl: string
    try {
      const result = await setupAndServe({
        ...parsed,
        port: parsed.port,
        silent: true,
      })
      server = result.server
      serverUrl = result.serverUrl
    } catch (error) {
      consola.error("Failed to start server:", error instanceof Error ? error.message : error)
      process.exit(1)
    }

    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    // Pi install / update (default-on, throttled, best-effort).
    const updateCheck = (args as Record<string, unknown>)["update-check"] !== false
    const autoUpdate = (args as Record<string, unknown>)["auto-update"] !== false
    if (updateCheck) {
      try {
        const check = await checkPiVersion()
        if (!check.installed) {
          try {
            await updatePi("latest")
            const retry = await checkPiVersion({ force: true })
            if (!retry.installed) {
              throw new Error("install did not place pi on PATH")
            }
          } catch (err) {
            consola.error(
              `Pi is not installed and automatic install failed (${err instanceof Error ? err.message : String(err)}). Install it with \`npm install -g @earendil-works/pi-coding-agent\`, then retry.`,
            )
            process.exit(1)
          }
        } else if (check.needsMinUpgrade) {
          if (autoUpdate && check.latestVersion) {
            try {
              await updatePi(check.latestVersion)
            } catch (err) {
              consola.error(
                `Installed Pi v${check.installedVersion} is below the supported floor and auto-upgrade failed. Upgrade manually: \`npm install -g @earendil-works/pi-coding-agent@latest\`.`,
              )
              void err
              process.exit(1)
            }
          } else {
            consola.error(
              `Installed Pi v${check.installedVersion} is below the supported floor. Upgrade: \`npm install -g @earendil-works/pi-coding-agent@latest\`.`,
            )
            process.exit(1)
          }
        } else if (check.needsUpdate && check.latestVersion) {
          if (autoUpdate) {
            try {
              await updatePi(check.latestVersion)
            } catch (err) {
              consola.warn(
                `Auto-update of Pi to ${check.latestVersion} failed (${err instanceof Error ? err.message : String(err)}); continuing with installed v${check.installedVersion}.`,
              )
            }
          } else {
            consola.warn(
              `Pi v${check.installedVersion} is installed; v${check.latestVersion} is available. Run with --auto-update (the default) to install on launch.`,
            )
          }
        }
      } catch (err) {
        consola.debug("Pi version check failed:", err)
      }
    }

    // Pin-mode prerequisites against the live catalog (fail-closed).
    const prereqCheck =
      profileId === "cheapest"
        ? validateCheapestProfilePrerequisites(state.models)
        : validateBalancedProfilePrerequisites(state.models)
    if (!prereqCheck.ok) {
      const message =
        profileId === "cheapest"
          ? formatCheapestPrerequisiteFailure(prereqCheck.missing)
          : formatBalancedPrerequisiteFailure(prereqCheck.missing)
      consola.error(message)
      process.stderr.write(`${message}\n`)
      process.exit(1)
    }

    // Isolated Pi mirror + stale sweep (never the user's real ~/.pi/agent).
    let mirror: string
    try {
      mirror = await ensurePiAgentMirror()
      await sweepStalePiAgentMirrors()
    } catch (err) {
      consola.error(
        `Failed to provision Pi config mirror: ${err instanceof Error ? err.message : String(err)}.`,
      )
      process.exit(1)
    }

    enableFileLogging()

    // Generate the mode's Pi files into the mirror.
    try {
      const searchEnabled =
        parsed.searchEnabled || process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
      const browseEnabled = browserToolsEnabled()
      const catalog = state.models?.data.map((m) => ({
        id: m.id,
        maxContextTokens: m.capabilities?.limits?.max_context_window_tokens ?? 0,
        maxPromptTokens: m.capabilities?.limits?.max_prompt_tokens ?? 0,
        efforts: m.capabilities?.supports?.reasoning_effort ?? [],
        endpoints: m.supported_endpoints ?? [],
      }))
      await writeJsonFile(
        path.join(mirror, "models.json"),
        buildPiModelsJson({ serverUrl, profileId, catalog }),
      )

      // Merge over snapshotted user settings: our keys win, user keys survive.
      const settingsPath = path.join(mirror, "settings.json")
      let userSettings: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(settingsPath, "utf8")
        const parsedSettings = JSON.parse(raw) as unknown
        if (parsedSettings && typeof parsedSettings === "object") {
          userSettings = parsedSettings as Record<string, unknown>
        }
      } catch {
        userSettings = {}
      }
      await writeJsonFile(settingsPath, {
        ...userSettings,
        ...buildPiSettingsJson({ profileId, searchEnabled, browseEnabled, catalog }),
      })

      await writeTextFile(
        path.join(mirror, "extensions", "gh-router-pi", "index.ts"),
        buildPiExtensionSource({ profileId, searchEnabled, browseEnabled }),
      )
      const agentFiles = buildPiAgentFiles(profileId)
      for (const [rel, content] of Object.entries(agentFiles)) {
        await writeTextFile(path.join(mirror, rel), content)
      }
      for (const skill of buildPiSkills(profileId)) {
        await writeTextFile(path.join(mirror, "skills", skill.dir, "SKILL.md"), skill.content)
      }
      for (const prompt of buildPiPrompts(profileId)) {
        await writeTextFile(path.join(mirror, "prompts", `${prompt.name}.md`), prompt.content)
      }
      await writeTextFile(path.join(mirror, "APPEND_SYSTEM.md"), buildPiAppendSystem(profileId))
    } catch (err) {
      consola.error(
        `Failed to write Pi launch files: ${err instanceof Error ? err.message : String(err)}.`,
      )
      process.exit(1)
    }

    // Tier-table drift guard: loud warning when live catalog input prices
    // disagree with the pinned cheap-tier thresholds. Separate block (own
    // try/catch) so a drift-check bug can never fail a launch. Warn-only.
    try {
      warnOnTierPriceDriftForModels(state.models?.data)
    } catch (err) {
      consola.debug("Pi tier drift check skipped:", err)
    }

    // AIC status line: this session's AI-credit total (`[AIC 12.42]`) plus
    // the discounted actual (`~$`) in Pi's footer via the `pi-statusline`
    // package (Claude-command contract: `internal-aic-status` runs
    // unchanged). The mirror is disposable, so router-wins is safe; a
    // user command is still sidecarred, never executed. Best-effort;
    // opt out with GH_ROUTER_DISABLE_AIC_STATUSLINE=1. Fail-open: a
    // broken runner degrades to no statusline, never a broken launch.
    let aicLedgerEnv: string | undefined
    let aicUserStatuslineEnv: string | undefined
    if (process.env.GH_ROUTER_DISABLE_AIC_STATUSLINE !== "1") {
      try {
        void sweepStaleAicLedgerFiles()
        const selfInvocation = await resolveSelfInvocation()
        const statusCommand = buildAicStatusHookCommand(selfInvocation)
        const injected = await injectAicStatusLineIntoSettingsFile(
          path.join(mirror, "settings.json"),
          statusCommand,
          { routerWins: true },
        )
        if (injected.written) {
          aicLedgerEnv = aicLedgerPath()
          if (injected.mode === "wrapped" && injected.userCommand) {
            aicUserStatuslineEnv = injected.userCommand
          }
          if (injected.mode === "forced") {
            consola.info(
              `Pinned status line installed natively for ${profileId}; a pre-existing statusLine was backed up in this launch's isolated settings and will not run.`,
            )
          }
        }
      } catch (err) {
        consola.warn(
          `AIC status line skipped: ${
            err instanceof Error ? err.message : String(err)
          }.`,
        )
      }
    }

    if (toolbeltEnabled()) {
      void provisionToolbelt().catch((err) =>
        consola.debug("Toolbelt provisioning failed:", err),
      )
    }
    void provisionAndIndexColbert()
    void colbertDegradedWarning(undefined, { logsToFile: true })
      .then((warning) => {
        if (warning) process.stderr.write(`${warning}\n`)
      })
      .catch(() => {})
    void warmTreeSitterPool()
    startKeepAwake()
    if (browserToolsEnabled()) {
      void provisionBrowserAssets().catch((err) =>
        consola.debug("Browser extension provisioning failed:", err),
      )
    }

    // Launch binding: the Pi extension reaches the proxy's /mcp with this
    // nonce (same channel as the Claude hooks). Descriptor carries the
    // mode's group/persona allow-list so /mcp enforces it server-side.
    const descriptor = profileDescriptor(profileId)
    const nonce = randomBytes(32).toString("hex")
    const secret = randomBytes(32).toString("hex")
    const entry = registerLaunch({
      profileId,
      nonce,
      secret,
      allowedGroups: descriptor.allowedGroups,
      allowedPersonas: descriptor.personaAllowlist,
    })

    const extraArgs = collectPiPassthroughArgs(rawArgs, piArgs)
    const lead = piLeadModel(profileId)
    process.stderr.write(
      `Server ready on ${serverUrl}, launching Pi (${profileId} lead ${lead}, models ${piProfileModelIds(profileId).length})...\n`,
    )

    const { disposeBluebirdClients } = await import("./lib/bluebird-client")
    launchChild(
      {
        kind: "pi",
        envVars: {
          ...getPiLaunchEnvVars(mirror),
          GH_ROUTER_HOOK_MCP_URL: serverUrl,
          GH_ROUTER_HOOK_NONCE: nonce,
          ...(aicLedgerEnv ? { [AIC_LEDGER_ENV]: aicLedgerEnv } : {}),
          ...(aicUserStatuslineEnv
            ? { [AIC_USER_STATUSLINE_ENV]: aicUserStatuslineEnv }
            : {}),
        },
        extraArgs,
        model: lead,
        serverUrl,
      },
      server,
      {
        onShutdown: async () => {
          unregisterLaunch(entry.launchId)
          await stopKeepAwake()
          await disposeBluebirdClients()
          await removeOwnPiAgentMirror()
        },
      },
    )
  },
})
