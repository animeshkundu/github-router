import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { defineCommand, type ArgsDef } from "citty"
import consola from "consola"

import { ensurePiInstalled, getInstalledPiVersion, meetsPiMinVersion, refreshPiInBackground, updatePi } from "./lib/pi-version-check"
import { warnOnTierPriceDriftForModels } from "./lib/pi-tier-windows"
import {
  AIC_LEDGER_ENV,
  buildAicStatusHookCommand,
} from "./lib/aic-statusline-settings"
import { PI_STATUS_COMMAND_ENV } from "./lib/pi-statusline"
import {
  aicLedgerPath,
  aicSnapshot,
  formatAicExitSummary,
  removeAicLedgerFile,
  sweepStaleAicLedgerFiles,
} from "./lib/aic-ledger"
import {
  discountedUsdForSnapshot,
  formatDiscountedCostTable,
} from "./lib/copilot-discount"
import { resolveSelfInvocation } from "./lib/hook-launcher/self-invocation"
import {
  ensurePiAgentMirror,
  removeOwnPiAgentMirror,
  sweepStalePiAgentMirrors,
} from "./lib/pi-paths"
import {
  seedPiPackageCache,
  savePiPackageCache,
  sweepStalePiPackageCaches,
} from "./lib/pi-package-cache"
import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "./lib/pi-extension"
import {
  applyCosmeticUserOverrides,
  buildPiAgentFiles,
  buildPiAppendSystem,
  buildPiLaunchCard,
  buildPiModelsJson,
  buildPiSettingsJson,
  mergeSubagentsSettings,
  piLeadModel,
  piProfileModelIds,
  piUsdCostFor,
  type PiPackageEntry,
  type PiProfileId,
} from "./lib/pi-models-settings"
import { launchChild } from "./lib/launch"
import { registerLaunch, unregisterLaunch } from "./lib/launch-registry"
import { PATHS } from "./lib/paths"
import { state } from "./lib/state"
import { runSelfUpdate } from "./lib/self-update"
import { enableFileLogging } from "./lib/file-log-reporter"
import { toolbeltEnabled } from "./lib/toolbelt"
import { provisionToolbelt } from "./lib/toolbelt/provision"
import { getPackageVersion } from "./lib/version"
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
      "Verify Pi is installed and above the supported floor on launch (fast local probe), and refresh it in the background (throttled hourly). Set to false (--no-update-check) to skip both (offline/CI).",
  },
  "auto-update": {
    type: "boolean" as const,
    default: true,
    description:
      "Refresh Pi in the background (throttled hourly): probe npm and queue a post-exit install when newer, without delaying launch. Set to false (--no-auto-update) to disable background updates (the install floor is still enforced).",
  },
  swe: {
    type: "boolean" as const,
    default: false,
    description:
      "Enable the SWE pipeline surface: delegation/review skills (gh-delegate, cheapest-only gh-advisor) and the review prompt shortcuts (/review, /parallel-review, cheapest-only /plan-review). Off by default; a bare launch advertises no skills or prompts.",
  },
  peers: {
    type: "boolean" as const,
    default: true,
    description:
      "Wire the peer/subagent floor: native agent files, the oracle tool (plus cheapest-only advisor), the gh-oracle skill, and the pi-subagents package. Set to false (--no-peers) for a lead-only session; prereqs then validate the lead model only.",
  },
  helpers: {
    type: "boolean" as const,
    default: true,
    description:
      "Wire the helpful bundle: pi-mcp-adapter, allowlisted pi-agent-extensions (sessions, ask_user, todos, handoff, context, analytics — no review/loop/footer, no files picker so Ctrl+Shift+O stays unambiguous for the UI), and pi-web-access when neither --search nor --browse is on. Set to false (--no-helpers) for pi-subagents + gh-router-pi only.",
  },
  ui: {
    type: "boolean" as const,
    default: true,
    description:
      "Load the Claude-look transcript UI (pi-claude-code-ui: grouped rows, Shiki diffs, Ctrl+O previews). Presentational only, zero model cost. Set to false (--no-ui) for stock Pi rendering.",
  },
  "memory-bridge": {
    type: "boolean" as const,
    default: true,
    description:
      "Bridge Copilot (.github/copilot-instructions.md, .github/instructions/*.instructions.md) and Claude (.claude/rules/, .claude/CLAUDE.md, ~/.claude/CLAUDE.md) memory into Pi. Static repo-wide slice synthesizes into the mirror AGENTS.md; path-scoped rules lazy-attach. Set to false (--no-memory-bridge) for Pi-native discovery only.",
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
    // Pi install / update (default-on, throttled, best-effort).
    const updateCheck = (args as Record<string, unknown>)["update-check"] !== false
    const autoUpdate = (args as Record<string, unknown>)["auto-update"] !== false
    // Fast foreground gate: `pi --version` is local (milliseconds) and
    // decides everything launch-critical. Network (npm view) and installs
    // never block a healthy launch — see below.
    let installedVersion: string | null = null
    // Pending fresh install when Pi is absent: started before server boot
    // so the two overlap, joined fail-closed right after setup.
    const pendingInstall: { promise: Promise<string> | null; abort: (() => void) | null } = {
      promise: null,
      abort: null,
    }
    if (updateCheck) {
      try {
        installedVersion = await getInstalledPiVersion()
      } catch (err) {
        consola.debug("Pi presence probe failed:", err)
      }
      if (installedVersion === null) {
        // Pi absent: it must be installed before launch, but the install
        // starts NOW so it overlaps server boot instead of following it.
        // Joined (fail-closed) right after setup; aborted if setup fails
        // so a doomed launch never leaves a half-written global install.
        const controller = new AbortController()
        pendingInstall.abort = () => controller.abort()
        pendingInstall.promise = ensurePiInstalled({ signal: controller.signal })
        pendingInstall.promise.catch(() => {
          // Observed at the join below; never an unhandled rejection.
        })
      }
    }
    try {
      // Quiet boot: with stored auth there is no interactive flow to
      // display, so info-level setup chatter (versions, re-login,
      // token refreshes) is held back and the launch card below carries
      // the same facts elegantly. Warn+error always show. Skipped for
      // explicit --verbose/--show-token, and never applied without
      // stored auth (first-time device flow must stay visible).
      const quietBoot =
        existsSync(PATHS.GITHUB_TOKEN_PATH) && !parsed.verbose && !parsed.showToken
      const priorLevel = consola.level
      if (quietBoot) consola.level = 1
      let setupResult: Awaited<ReturnType<typeof setupAndServe>>
      try {
        setupResult = await setupAndServe({
          ...parsed,
          port: parsed.port,
          silent: true,
        })
      } finally {
        if (quietBoot) consola.level = priorLevel
      }
      server = setupResult.server
      serverUrl = setupResult.serverUrl
    } catch (error) {
      pendingInstall.abort?.()
      consola.error("Failed to start server:", error instanceof Error ? error.message : error)
      process.exit(1)
    }

    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    if (pendingInstall.promise) {
      // The blocking join: without Pi there is nothing to launch.
      // Same failure contract as a sequential install, minus the wait.
      try {
        installedVersion = await pendingInstall.promise
      } catch (err) {
        consola.error(
          `Pi is not installed and automatic install failed (${err instanceof Error ? err.message : String(err)}). Install it with \`npm install -g @earendil-works/pi-coding-agent\`, then retry.`,
        )
        process.exit(1)
      } finally {
        pendingInstall.promise = null
        pendingInstall.abort = null
      }
    }

    if (updateCheck && installedVersion !== null) {
      if (!meetsPiMinVersion(installedVersion)) {
        // Below the floor Pi cannot serve the roster correctly: upgrade
        // foreground and re-verify, fail closed. `latest` needs no
        // registry probe — npm resolves it at install time.
        if (autoUpdate) {
          try {
            await updatePi("latest")
            installedVersion = await getInstalledPiVersion()
          } catch (err) {
            consola.error(
              `Installed Pi v${installedVersion} is below the supported floor and auto-upgrade failed (${err instanceof Error ? err.message : String(err)}). Upgrade manually: \`npm install -g @earendil-works/pi-coding-agent@latest\`.`,
            )
            process.exit(1)
          }
        }
        if (!meetsPiMinVersion(installedVersion)) {
          consola.error(
            `Installed Pi v${installedVersion} is below the supported floor. Upgrade: \`npm install -g @earendil-works/pi-coding-agent@latest\`.`,
          )
          process.exit(1)
        }
      } else {
        // Healthy: freshness refreshes in the background (throttled npm
        // probe, detached post-exit install when newer). Never blocks,
        // never throws, never touches this session's validated install.
        refreshPiInBackground({ autoUpdate })
      }
    }

    // Flag policy (mirrors the Claude launcher's house rules): peers are
    // default-ON (opt out with --no-peers); the SWE pipeline, like its
    // Claude namesake, is opt-IN with --swe. A bare launch advertises no
    // skills or prompts — only what Pi ships plus the mode identity.
    const peersEnabled = (args as Record<string, unknown>)["peers"] !== false
    const sweEnabled = (args as Record<string, unknown>)["swe"] === true
    const helpersEnabled = (args as Record<string, unknown>)["helpers"] !== false
    const uiEnabled = (args as Record<string, unknown>)["ui"] !== false
    const searchEnabled =
      parsed.searchEnabled || process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
    const browseEnabled = browserToolsEnabled()

    // Pin-mode prerequisites against the live catalog (fail-closed).
    // Peerless launches validate the lead only (nothing else is consumed).
    const prereqCheck =
      profileId === "cheapest"
        ? validateCheapestProfilePrerequisites(state.models, { peers: peersEnabled })
        : validateBalancedProfilePrerequisites(state.models, { peers: peersEnabled })
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
      void sweepStalePiPackageCaches()
    } catch (err) {
      consola.error(
        `Failed to provision Pi config mirror: ${err instanceof Error ? err.message : String(err)}.`,
      )
      process.exit(1)
    }

    enableFileLogging()

    // The exact `packages[]` slice for this launch (flag-dependent), used
    // to key the persistent npm-package cache: seed before Pi boots, save
    // on shutdown before the mirror is removed.
    let packagesForCache: Array<PiPackageEntry> = []

    // Generate the mode's Pi files into the mirror.
    try {
      const catalog = state.models?.data.map((m) => {
        const cost = piUsdCostFor(m.billing?.token_prices)
        return {
          id: m.id,
          maxContextTokens: m.capabilities?.limits?.max_context_window_tokens ?? 0,
          maxPromptTokens: m.capabilities?.limits?.max_prompt_tokens ?? 0,
          maxOutputTokens: m.capabilities?.limits?.max_output_tokens ?? 0,
          efforts: m.capabilities?.supports?.reasoning_effort ?? [],
          endpoints: m.supported_endpoints ?? [],
          vision: m.capabilities?.supports?.vision,
          maxImageBytes: m.capabilities?.limits?.vision?.max_prompt_image_size,
          ...(cost ? { cost } : {}),
        }
      })
      await writeJsonFile(
        path.join(mirror, "models.json"),
        buildPiModelsJson({ serverUrl, profileId, catalog, peers: peersEnabled }),
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
      // Merge over snapshotted user settings: our keys win, user keys survive.
      // Exception: `subagents.agentOverrides` deep-merges (ours as defaults,
      // user's entries win per-agent) so emitting our builtin disables never
      // wipes a user's own overrides — a shallow spread would replace the
      // whole object.
      const builtSettings = buildPiSettingsJson({ profileId, searchEnabled, browseEnabled, catalog, peers: peersEnabled, helpers: helpersEnabled, ui: uiEnabled })
      const mergedSubagents = mergeSubagentsSettings(
        userSettings["subagents"],
        builtSettings.subagents,
      )
      // Presentational keys stay user-customizable: a look the user set
      // in their own settings (thinking visibility, Claude palette,
      // one-line tool rows, terminal/images) wins over our defaults,
      // while load-bearing keys stay built-wins (cost contract).
      const cosmeticOverrides = applyCosmeticUserOverrides(userSettings, builtSettings)
      await writeJsonFile(settingsPath, {
        ...userSettings,
        ...builtSettings,
        ...cosmeticOverrides,
        ...(mergedSubagents ? { subagents: mergedSubagents } : {}),
      })
      // Pre-seed <mirror>/npm from the durable package cache so Pi's
      // per-boot `packages[]` install is a no-op on a hit (faster + silent:
      // npm's `added N packages` summary bypasses npm_config_loglevel).
      // Misses (cold/stale/flag-changed cache) install from the registry
      // as before and are saved back on shutdown for the next launch.
      packagesForCache = [...builtSettings.packages]
      const cacheHit = await seedPiPackageCache(mirror, packagesForCache)
      if (cacheHit) {
        consola.debug("Pi package cache hit: mirror pre-seeded, skipping registry install.")
      }

      // Memory bridge collection runs BEFORE the extension build so scoped
      // rules + stats can be embedded for lazy attach + /memory + /context.
      // Best-effort, never fatal. Honors --no-memory-bridge,
      // GH_ROUTER_PI_BRIDGE=0 / GH_ROUTER_DISABLE_PI_BRIDGE=1, and Pi's own
      // --no-context-files/-nc passthrough (never fight an explicit `-nc`).
      const bridgeDisabled =
        (args as Record<string, unknown>)["memory-bridge"] === false
        || process.env.GH_ROUTER_PI_BRIDGE === "0"
        || process.env.GH_ROUTER_DISABLE_PI_BRIDGE === "1"
      let bridgeStats: { staticFiles: number; scopedRules: number; imports: number; skipped: number } | undefined
      let bridgeScoped: Array<{ file: string; body: string; globs: Array<string>; source: string }> = []
      if (!bridgeDisabled) {
        const passthrough = collectPiPassthroughArgs(rawArgs, piArgs)
        const noContext = passthrough.includes("--no-context-files") || passthrough.includes("-nc")
        if (!noContext) {
          try {
            const { collectBridgeInputs } = await import("./lib/pi-memory-bridge")
            const collected = await collectBridgeInputs(process.cwd())
            bridgeStats = {
              staticFiles:
                collected.copilotInstructions.length
                + collected.unscopedRules.length
                + collected.userGlobal.length,
              scopedRules: collected.scopedRules.length,
              imports: collected.imports.length,
              skipped: collected.skipped.length,
            }
            bridgeScoped = collected.scopedRules
            // Stash full collection for the AGENTS.md synthesis below.
            ;(globalThis as Record<string, unknown>).__ghRouterBridgeCollected = collected
          } catch (err) {
            consola.debug("Pi memory bridge collection skipped:", err)
          }
        }
      }

      await writeTextFile(
        path.join(mirror, "extensions", "gh-router-pi", "index.ts"),
        buildPiExtensionSource({
          profileId,
          searchEnabled,
          browseEnabled,
          peers: peersEnabled,
          bridge: bridgeStats ? { stats: bridgeStats, scopedRules: bridgeScoped } : undefined,
        }),
      )
      // Peer floor (agents + consult skills) rides --peers; the SWE
      // pipeline (delegate/advisor skills, review prompts) rides --swe AND
      // --peers (without agents + the subagent provider its prose dangles,
      // so peerless+swe emits none — see the heads-up below).
      // semantic-search prose rides --search. Bare launches write none.
      if (peersEnabled) {
        const agentFiles = buildPiAgentFiles(profileId)
        for (const [rel, content] of Object.entries(agentFiles)) {
          await writeTextFile(path.join(mirror, rel), content)
        }
      }
      for (const skill of buildPiSkills({ profileId, peers: peersEnabled, swe: sweEnabled, search: searchEnabled })) {
        await writeTextFile(path.join(mirror, "skills", skill.dir, "SKILL.md"), skill.content)
      }
      for (const prompt of buildPiPrompts({ profileId, swe: sweEnabled, peers: peersEnabled })) {
        await writeTextFile(path.join(mirror, "prompts", `${prompt.name}.md`), prompt.content)
      }
      await writeTextFile(path.join(mirror, "APPEND_SYSTEM.md"), buildPiAppendSystem(profileId, { peers: peersEnabled }))

      // Static bridge synthesis into mirror AGENTS.md (Pi-native candidate).
      // Uses the collection stashed above; idempotent via fenced replace.
      try {
        const collected = (globalThis as Record<string, unknown>).__ghRouterBridgeCollected as
          | import("./lib/pi-memory-bridge").PiBridgeCollected
          | undefined
        if (collected) {
          const { buildMirrorBridgeSection, mergeBridgeIntoAgentsMd } = await import("./lib/pi-memory-bridge")
          const { section } = buildMirrorBridgeSection(collected, { repoRoot: process.cwd() })
          const agentsPath = path.join(mirror, "AGENTS.md")
          let existing: string | undefined
          try {
            existing = await fs.readFile(agentsPath, "utf8")
          } catch {
            existing = undefined
          }
          await writeTextFile(agentsPath, mergeBridgeIntoAgentsMd(existing, section))
          await writeJsonFile(path.join(mirror, ".gh-router-bridge.json"), {
            stats: bridgeStats ?? null,
            scopedRuleFiles: bridgeScoped.map((r) => r.file),
          })
        }
      } catch (err) {
        consola.debug("Pi memory bridge synthesis skipped:", err)
      } finally {
        try {
          delete (globalThis as Record<string, unknown>).__ghRouterBridgeCollected
        } catch {
          // ignore
        }
      }
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
    // the discounted actual (`~$`) in Pi's footer, rendered by the mode's
    // own `gh-router-pi` extension (same `internal-aic-status` runner the
    // Claude launcher drives — one renderer, identical segments). The
    // command travels via `GH_ROUTER_AIC_STATUS_COMMAND` env, never a
    // settings block: the community bridge only reads the user's real
    // global/project settings and never sees the launch mirror, so a
    // mirror-injected block would be dead config. Router-wins by
    // architecture (the footer is extension-owned); opt out with
    // GH_ROUTER_DISABLE_AIC_STATUSLINE=1. Fail-open: a broken runner
    // degrades to no statusline, never a broken launch.
    let aicLedgerEnv: string | undefined
    let aicStatusCommandEnv: string | undefined
    if (process.env.GH_ROUTER_DISABLE_AIC_STATUSLINE !== "1") {
      try {
        void sweepStaleAicLedgerFiles()
        const selfInvocation = await resolveSelfInvocation()
        aicStatusCommandEnv = buildAicStatusHookCommand(selfInvocation)
        aicLedgerEnv = aicLedgerPath()
        consola.info(
          `Status line wired via the gh-router-pi footer for ${profileId} (shared internal-aic-status runner).`,
        )
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
    // mode's group/persona allow-list so /mcp enforces it server-side;
    // peerless launches drop the peers group + persona allow-list to match
    // the unwritten tools.
    const descriptor = profileDescriptor(profileId)
    const nonce = randomBytes(32).toString("hex")
    const secret = randomBytes(32).toString("hex")
    const entry = registerLaunch({
      profileId,
      nonce,
      secret,
      allowedGroups: peersEnabled
        ? descriptor.allowedGroups
        : new Set(
            [...(descriptor.allowedGroups ?? [])].filter((g) => g !== "peers"),
          ),
      allowedPersonas: peersEnabled ? descriptor.personaAllowlist : new Set<string>(),
    })

    const extraArgs = collectPiPassthroughArgs(rawArgs, piArgs)
    const lead = piLeadModel(profileId)
    const modelIds = piProfileModelIds(profileId, { peers: peersEnabled })
    // One elegant preamble (stderr, no reporter icons or timestamps).
    // Replaces both the gated setup chatter and the old single line:
    // same facts, three aligned lines.
    process.stderr.write(
      `${buildPiLaunchCard({
        version: getPackageVersion(),
        profileId,
        accountType: parsed.accountType,
        login: state.githubUserLogin,
        copilotVersion: state.copilotVersion,
        vsCodeVersion: state.vsCodeVersion,
        lead,
        modelCount: modelIds.length,
        peers: peersEnabled,
        helpers: helpersEnabled && peersEnabled,
        ui: uiEnabled,
        swe: sweEnabled,
        search: searchEnabled,
        browse: browseEnabled,
        serverUrl,
      })}\n`,
    )
    if (sweEnabled && !peersEnabled) {
      process.stderr.write(
        "Note: --swe without --peers emits no delegate/review skills or prompts (no agents behind them in a peerless launch).\n",
      )
    }

    const { disposeBluebirdClients } = await import("./lib/bluebird-client")
    launchChild(
      {
        kind: "pi",
        envVars: {
          ...getPiLaunchEnvVars(mirror),
          GH_ROUTER_HOOK_MCP_URL: serverUrl,
          GH_ROUTER_HOOK_NONCE: nonce,
          // Launch workspace for the Pi MCP bridge (code_search default +
          // X-GH-Workspace header). The proxy is long-lived; the agent is
          // not — only the launcher knows where the caller actually is.
          GH_ROUTER_WORKSPACE: process.cwd(),
          // Balanced nests reviewer→Explore under General-Purpose, i.e.
          // lead→General-Purpose→reviewer→Explore (3 deep); the default
          // nesting guard is 2 and would fail the deepest edge closed.
          PI_SUBAGENT_MAX_DEPTH: "3",
          ...(aicLedgerEnv ? { [AIC_LEDGER_ENV]: aicLedgerEnv } : {}),
          ...(aicStatusCommandEnv
            ? { [PI_STATUS_COMMAND_ENV]: aicStatusCommandEnv }
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
          // Persist this launch's installed <mirror>/npm for the next
          // launch's pre-seed (keyed by the exact packages[] slice), then
          // remove the per-launch mirror as before. Best-effort, never
          // fatal — a failed save just means the next boot reinstalls.
          await savePiPackageCache(mirror, packagesForCache)
          await removeOwnPiAgentMirror()
          await removeAicLedgerFile()
        },
        // Session AIC total + discounted per-model cost table, printed
        // after cleanup on every exit path. The table is default-on (not
        // debug-gated): every value in it is upstream-measured, and the
        // ~$ column carries the same static-discount approximation as the
        // status line. Per-model credit splits stay verbose-only — they
        // imply billing-grade attribution the estimates can't support.
        onExitSummary: () => {
          const snapshot = aicSnapshot()
          if (snapshot.requests === 0 || snapshot.totalNanoAiu <= 0) {
            return undefined
          }
          const summary = formatAicExitSummary(snapshot, {
            verbose: consola.level >= 4,
          })
          const table = formatDiscountedCostTable(
            snapshot,
            discountedUsdForSnapshot(snapshot),
          )
          return table ? `${summary}\n${table}` : summary
        },
      },
    )
  },
})
