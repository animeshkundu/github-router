import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { defineCommand, type ArgsDef } from "citty"
import consola from "consola"

import {
  meetsPiMinVersion,
  PI_MIN_VERSION,
  refreshPiInBackground,
  resolvePiRegistry,
} from "./lib/pi-version-check"
import { resolvePiCommand, type PiCommand } from "./lib/managed-install/pi-command"
import { scheduleBackgroundPiInstall } from "./lib/managed-install/update"
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
import { seedPiPackageCache, sweepStalePiPackageCaches } from "./lib/pi-package-cache"
import {
  buildPiExtensionSource,
  buildPiPrompts,
  buildPiSkills,
} from "./lib/pi-extension"
import {
  applyCosmeticUserOverrides,
  buildPiAgentFiles,
  buildPiAppendSystem,
  buildPiKeybindingsJson,
  buildPiLaunchCard,
  buildPiModelsJson,
  buildPiSettingsJson,
  mergePiKeybindingsSettings,
  mergeSubagentsSettings,
  piLeadModel,
  piProfileModelIds,
  piUsdCostFor,
  type PiProfileId,
} from "./lib/pi-models-settings"
import { launchChild } from "./lib/launch"
import { bridgeShadowWarnings, inspectMirrorPrecedence, planSkillWrites } from "./lib/pi-mirror-guards"
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
import {
  artifactToolsEnabled,
  browseAgentEnabled,
  browserToolsEnabled,
  adoToolsEnabled,
  cloudAgentToolsEnabled,
  kustoToolsEnabled,
  workiqToolsEnabled,
} from "./lib/mcp-capabilities"
import { resolvePiSurfaces, writePiMcpJson } from "./lib/pi-mcp-config"
import {
  formatBalancedPrerequisiteFailure,
  formatCheapestPrerequisiteFailure,
  formatLocalPrerequisiteFailure,
  profileDescriptor,
  resolveLaunchProfile,
  validateBalancedProfilePrerequisites,
  validateCheapestProfilePrerequisites,
  validateLocalProfilePrerequisites,
} from "./lib/launch-profile"
import { configureLocalEgress, localBaseUrl } from "./lib/local-egress"
import {
  isBalancedFamily,
  isCheapestFamily,
  isCheaplocalProfile,
  isLocalFamily,
} from "./lib/profile-family"
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
      "Pi launch profile: cheapest/cheapest2 (Luna-led, cheapest tier), balanced/balanced2 (Sol-led, most-complex-tasks tier), or local/local2 (the main loop and every subagent run against a local inference endpoint instead of Copilot; local allows no Copilot model at all, local2 allows only the Advisor and the Oracle, both on Sol). The `-2` aliases move the Sol tier from 5.6 to 6.1; cheapest2 also raises the Advisor to high, and balanced2's Oracle is Grok 4.7. Only these six aliases are supported for `github-router pi`.",
  },
  localport: {
    type: "string" as const,
    description:
      "Port of the LOCAL MODEL SERVER that `-m local` / `-m local2` forward the main loop to (not the proxy's own --port). Default 11111, giving https://localhost:11111/v1. Inert on every other profile.",
  },
  localurl: {
    type: "string" as const,
    description:
      "Full base URL, including the /v1 prefix, of the local inference endpoint for `-m local` / `-m local2` (e.g. http://localhost:11111/v1). Sets scheme/host/path, which --localport cannot. Mutually exclusive with --localport. Inert on every other profile.",
  },
  "pi-path": {
    type: "string" as const,
    description:
      "Run THIS Pi instead of the one on PATH or the managed copy (absolute path to a pi binary or script). Explicit: skips the version floor, the managed install, and the background refresh.",
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
      "Enable the SWE pipeline surface: delegation/review skills (gh-delegate, cheapest-family gh-advisor) and the review prompt shortcuts (/review, /parallel-review, cheapest-family /plan-review). Off by default; a bare launch advertises no skills or prompts.",
  },
  peers: {
    type: "boolean" as const,
    default: true,
    description:
      "Wire the peer/subagent floor: native agent files, the gh-oracle skill, the pi-subagents package, and the gh-router-peers MCP group (the personas and artifact review tools the chosen profile allows). Set to false (--no-peers) for a lead-only session; prereqs then validate the lead model only.",
  },
  helpers: {
    type: "boolean" as const,
    default: true,
    description:
      "Wire the helpful bundle: allowlisted pi-agent-extensions (sessions, ask_user, todos, handoff, context, analytics — no review/loop/footer, no files picker so Ctrl+Shift+O stays unambiguous for the UI), and pi-web-access when neither --search nor --browse is on. MCP is native Pi MCP now, so no adapter package is bundled. Set to false (--no-helpers) for pi-subagents + gh-router-pi only.",
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
  foreign: {
    type: "boolean" as const,
    default: false,
    description:
      "Bridge the project's and your Claude Code and Copilot artifacts: .claude/skills + .github/skills + .copilot/skills as Pi skills, .claude/commands + .github/prompts as prompt shortcuts, and .claude/agents + .github/agents as Pi subagents announced in one compact index and loaded on demand. Authored names are kept; a name already taken by the router, a pi-subagents builtin or your own agent/skill/command is renamed (skills, prompts) or reported (agents) rather than overwritten. Foreign `model:` is ignored — every bridged agent runs on the lead model. Off by default.",
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
    description:
      "Start the proxy server and launch the Pi coding agent (cheapest/balanced families, or a local model server)",
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
    // `cheaplocal` is a cheapest-family member, so the family check below
    // would accept it and then build a cheapest-shaped launch that names no
    // local provider at all. Pi support would need its model settings to
    // declare two providers for one profile; until then this is a refusal,
    // not a silent downgrade to `cheapest`.
    if (isCheaplocalProfile(launchProfileId)) {
      process.stderr.write(
        "github-router pi does not support -m cheaplocal: Pi's model settings bind one provider per profile, and cheaplocal's Advisor and Oracle are served by the local endpoint. Use -m cheapest or -m cheapest2 on Pi, or run `github-router claude -m cheaplocal`.\n",
      )
      process.exit(1)
    }
    if (
      !isCheapestFamily(launchProfileId) &&
      !isBalancedFamily(launchProfileId) &&
      !isLocalFamily(launchProfileId)
    ) {
      process.stderr.write(
        `github-router pi supports only -m cheapest, -m cheapest2, -m balanced, -m balanced2, -m local, and -m local2 (got ${JSON.stringify(args.model ?? "")}).\n`,
      )
      process.exit(1)
    }
    const profileId: PiProfileId = launchProfileId

    // Local egress is resolved once, before the server accepts requests, so
    // the same `--localport` / `--localurl` resolution serves both subcommands.
    try {
      configureLocalEgress({
        ...(typeof args.localurl === "string" ? { baseUrl: args.localurl } : {}),
        ...(typeof args.localport === "string" ? { port: args.localport } : {}),
        profileId,
      })
      if (isLocalFamily(profileId)) {
        consola.info(`[local] upstream ${localBaseUrl()}`)
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    }

    let server: Awaited<ReturnType<typeof setupAndServe>>["server"]
    let serverUrl: string
    // Pi resolution (default-on). `--pi-path` is an explicit override: it skips
    // every probe, the floor check, and the background refresh, because the user
    // named a binary and does not want our opinion about it.
    const piPath = typeof args["pi-path"] === "string" ? args["pi-path"].trim() : ""
    const updateCheck = (args as Record<string, unknown>)["update-check"] !== false
    const autoUpdate = (args as Record<string, unknown>)["auto-update"] !== false
    const managePi = updateCheck && piPath === ""
    let piCommand: PiCommand | null = null
    // Resolution overlaps server boot exactly like the old absent-Pi install
    // did: a cold managed install is ~10 s (66 MB) and there is no reason to
    // serialize it behind setup. Without Pi there is nothing to launch, so the
    // join below is still fail-closed.
    const pendingResolve: { promise: Promise<PiCommand | null> | null; abort: (() => void) | null } = {
      promise: null,
      abort: null,
    }
    if (managePi) {
      const controller = new AbortController()
      pendingResolve.abort = () => controller.abort()
      pendingResolve.promise = resolvePiCommand({ signal: controller.signal })
      pendingResolve.promise.catch(() => {
        // Observed at the join below; never an unhandled rejection.
      })
    } else if (piPath !== "") {
      piCommand = await resolvePiCommand({ piPath })
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
      pendingResolve.abort?.()
      consola.error("Failed to start server:", error instanceof Error ? error.message : error)
      process.exit(1)
    }

    void runSelfUpdate({ selfUpdate: args["self-update"] !== false })

    if (pendingResolve.promise) {
      // The blocking join: without a usable Pi there is nothing to launch.
      try {
        piCommand = await pendingResolve.promise
      } catch (err) {
        consola.debug("Pi resolution failed:", err)
      } finally {
        pendingResolve.promise = null
        pendingResolve.abort = null
      }
    }

    if (managePi) {
      // Two independent gates, both fail-closed: something runnable, and one
      // above the floor. `resolvePiCommand` already prefers a managed copy over
      // a below-floor PATH install, so landing here means neither exists.
      if (!piCommand || piCommand.command === "") {
        const detail = piCommand?.note ?? "no runnable `pi` was found"
        consola.error(
          `Cannot launch Pi: ${detail}\nInstall it with \`npm install -g @earendil-works/pi-coding-agent@latest --registry=${resolvePiRegistry()}\`, or run \`github-router update --pi\` to install the managed copy.`,
        )
        process.exit(1)
      }
      if (!meetsPiMinVersion(piCommand.version)) {
        consola.error(
          `Pi v${piCommand.version ?? "unknown"} (${piCommand.command}) is below the supported floor v${PI_MIN_VERSION}. Install a newer one with \`github-router update --pi\`, or pass --pi-path.`,
        )
        process.exit(1)
      }
      if (piCommand.note) consola.info(piCommand.note)
      if (autoUpdate) {
        if (piCommand.source === "path") {
          // A user-owned Pi keeps its own update channel (`-g` + the detached
          // post-exit waiter). Never rewrite a tree that is not ours.
          refreshPiInBackground({ autoUpdate })
        } else {
          // Managed: refresh on its own cadence, detached. The install writes a
          // NEW directory, so the running Pi holds nothing that is being
          // replaced.
          void scheduleBackgroundPiInstall().then(
            (detail) => consola.debug(`managed Pi refresh: ${detail}`),
            (err: unknown) => consola.debug("managed Pi refresh failed:", err),
          )
        }
      }
    }

    // Flag policy (mirrors the Claude launcher's house rules): peers are
    // default-ON (opt out with --no-peers); the SWE pipeline, like its
    // Claude namesake, is opt-IN with --swe. A bare launch advertises no
    // skills or prompts — only what Pi ships plus the mode identity.
    const peersEnabled = (args as Record<string, unknown>)["peers"] !== false
    const sweEnabled = (args as Record<string, unknown>)["swe"] === true
    // Foreign bridge: Claude Code (`.claude/`) and Copilot (`.github/`,
    // `~/.copilot/`) skills, commands and agents translated into Pi-native
    // form. Opt-in: it changes what the model can see at every turn (the
    // index) and adds agents to the roster.
    const foreignEnabled = (args as Record<string, unknown>)["foreign"] === true
    const helpersEnabled = (args as Record<string, unknown>)["helpers"] !== false
    const uiEnabled = (args as Record<string, unknown>)["ui"] !== false
    const searchEnabled =
      parsed.searchEnabled || process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
    const browseEnabled = browserToolsEnabled()
    // Which Pi surfaces this launch emits, in one place. `codeSearch` is the
    // Bluebird seam: Bluebird answers the `code` tool without `--search`, so
    // the generated seam follows it, while `pi-web-access` and the ColBERT
    // skill prose keep following `--search`. The group list mirrors the pinned
    // branch of `src/claude.ts` so both clients see the same servers for the
    // same profile. See `resolvePiSurfaces`.
    const surfaces = resolvePiSurfaces({
      profileId,
      searchEnabled,
      bluebirdEnabled: state.bluebirdEnabled === true,
      adoEnabled: adoToolsEnabled(),
      kustoEnabled: kustoToolsEnabled(),
      cloudAgentEnabled: cloudAgentToolsEnabled(),
      workiqEnabled: workiqToolsEnabled(),
      browseAgentAvailable: browseAgentEnabled(),
      directBrowserAvailable: browseEnabled,
      artifactToolsAvailable: artifactToolsEnabled(),
      peersEnabled,
    })

    // Pin-mode prerequisites against the live catalog (fail-closed).
    // Peerless launches validate the lead only (nothing else is consumed).
    // Local profiles need no catalog entry for any role they run locally;
    // `local2` validates only its Copilot-served Advisor.
    const prereqCheck = isLocalFamily(profileId)
      ? validateLocalProfilePrerequisites(state.models, profileId)
      : isCheapestFamily(profileId)
        ? validateCheapestProfilePrerequisites(
            state.models,
            { peers: peersEnabled },
            profileId,
          )
        : validateBalancedProfilePrerequisites(
            state.models,
            { peers: peersEnabled },
            profileId,
          )
    if (!prereqCheck.ok) {
      const message = isLocalFamily(profileId)
        ? formatLocalPrerequisiteFailure(prereqCheck.missing, profileId, "pi")
        : isCheapestFamily(profileId)
          ? formatCheapestPrerequisiteFailure(prereqCheck.missing, profileId)
          : formatBalancedPrerequisiteFailure(prereqCheck.missing, profileId)
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

    // Two Pi precedence rules silently defeat this launch's files, and both are
    // invisible from the outside, so report them once each and never touch the
    // user's files (see `inspectMirrorPrecedence`).
    const precedence = await inspectMirrorPrecedence(mirror, process.cwd())
    if (precedence.systemMd) {
      consola.warn(
        `Pi: ${path.join(mirror, "SYSTEM.md")} REPLACES Pi's default system prompt. gh-router's mode guidance is still appended to it, but any harness rules your SYSTEM.md leaves out are not restored. Remove it (or merge it into APPEND_SYSTEM.md) for the stock prompt.`,
      )
    }
    if (precedence.projectAppendSystem) {
      consola.warn(
        `Pi: ${precedence.projectAppendSystem} exists. If this project is trusted, Pi loads it INSTEAD of the gh-router mode digest (the mirror's APPEND_SYSTEM.md). Keep one or the other.`,
      )
    }

    // Foreign-agent definitions present but NOT bridged (no `--foreign`).
    // Only ever set on a launch without the flag, and only to report that the
    // artifacts exist — see `countForeignAgentFiles`.
    let foreignAvailable: number | undefined
    // Foreign-bridge result, filled inside the launch-file block below and
    // read by the launch card afterwards. Declared out here for the same
    // reason as `bridgeStats`: the card is printed after the try/catch.
    let foreignStats:
      | {
          agents: number
          renamed: Array<{ from: string; to: string }>
          skipped: Array<{ name: string; reason: string }>
          written: { skills: number; prompts: number; overwritten: number }
        }
      | undefined

    // `/v1/messages` launch binding. Minted here, before models.json is
    // written, because the local tier rows must carry it as a per-model
    // header: without the secret the proxy sees Pi's lead traffic as
    // unbound BYO and routes it to Copilot, so a local session gets
    // Copilot's "model is not supported" 400 for the bare `opus` id.
    // Registered further down with the same value.
    const launchSecret = randomBytes(32).toString("hex")

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
        buildPiModelsJson({
          serverUrl,
          profileId,
          catalog,
          peers: peersEnabled,
          // Local tier rows carry `x-claude-code-session-id` (the local server
          // rejects a request without one). Pi has no such header of its own,
          // so the launch seeds the same process-level id the proxy falls back
          // to for Claude Code.
          sessionId: state.sessionId,
          // Binds Pi's lead turns to THIS launch, the same channel Claude Code
          // gets through `ANTHROPIC_CUSTOM_HEADERS`. Copilot-served rows never
          // carry it: a bound launch whose profile is local routes to the
          // local endpoint, which is not where those ids belong.
          launchSecret,
        }),
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

      // Free `shift+tab` for plan mode. Pi reserves `app.thinking.cycle`
      // against extension overrides, so a registration alone is dropped with
      // "conflicts with built-in shortcut"; the conflict table is keyed by
      // key, so MOVING the action off `shift+tab` is what frees it. Moving
      // rather than emptying keeps thinking-level cycling reachable, and a
      // user who already moved it keeps their own key (see the merge helper).
      // Same layered shape as settings.json above.
      const keybindingsPath = path.join(mirror, "keybindings.json")
      let userKeybindings: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(keybindingsPath, "utf8")
        const parsedKeybindings = JSON.parse(raw) as unknown
        if (parsedKeybindings && typeof parsedKeybindings === "object") {
          userKeybindings = parsedKeybindings as Record<string, unknown>
        }
      } catch {
        userKeybindings = {}
      }
      await writeJsonFile(keybindingsPath, {
        ...mergePiKeybindingsSettings(userKeybindings, buildPiKeybindingsJson()),
      })
      // Point <mirror>/npm at the durable package cache entry so Pi's
      // per-boot `packages[]` install is a no-op on a hit (faster + silent:
      // npm's `added N packages` summary bypasses npm_config_loglevel). The
      // entry IS the tree Pi installs into — no copy in either direction, so
      // nothing here can be truncated by the launcher's 5 s shutdown budget.
      // A miss (cold/stale/flag-changed cache) installs into the entry, which
      // is exactly what makes the next launch a hit; a cache that cannot be
      // set up (no symlink privilege) installs into the mirror as before.
      const seed = await seedPiPackageCache(mirror, builtSettings.packages)
      // Cold is normal and a fallback is survivable, so neither warns; both
      // are worth one line under --debug when a launch looks slow.
      consola.debug(`Pi package cache: ${seed.reason}.`)

      // Memory bridge collection runs BEFORE the extension build so scoped
      // rules + stats can be embedded for lazy attach + /memory + /context.
      // Best-effort, never fatal. Honors --no-memory-bridge,
      // GH_ROUTER_PI_BRIDGE=0 / GH_ROUTER_DISABLE_PI_BRIDGE=1, and Pi's own
      // --no-context-files/-nc passthrough (never fight an explicit `-nc`).
      const bridgeDisabled =
        (args as Record<string, unknown>)["memory-bridge"] === false
        || process.env.GH_ROUTER_PI_BRIDGE === "0"
        || process.env.GH_ROUTER_DISABLE_PI_BRIDGE === "1"
      let bridgeStats: { staticFiles: number; scopedRules: number; imports: number; skipped: number; truncated: boolean; bytes: number } | undefined
      let bridgeScoped: Array<{ file: string; body: string; globs: Array<string>; source: string }> = []
      // The rendered block, held for the AGENTS.md write further down (the
      // `.gh-router-bridge.json` report needs `shadowedSkills`, which is only
      // known after the skill plan runs).
      let bridgeSection = ""
      let bridgeCollected: import("./lib/pi-memory-bridge").PiBridgeCollected | undefined
      // Whether the bridge contributes prompt text this launch. Drives the
      // digest's "follow it, do not restate it" line: naming AGENTS.md when no
      // bridged block exists would point the model at nothing. Deliberately
      // keyed on the RENDERED bytes, not on collection succeeding — a repo with
      // no Copilot/Claude files collects an empty set and writes no block.
      let bridgeActive = false
      if (!bridgeDisabled) {
        const passthrough = collectPiPassthroughArgs(rawArgs, piArgs)
        const noContext = passthrough.includes("--no-context-files") || passthrough.includes("-nc")
        if (!noContext) {
          try {
            const { PI_BRIDGE_STATIC_BUDGET_BYTES, buildMirrorBridgeSection, collectBridgeInputs } = await import(
              "./lib/pi-memory-bridge"
            )
            const collected = await collectBridgeInputs(process.cwd())
            const rendered = buildMirrorBridgeSection(collected, { repoRoot: process.cwd() })
            bridgeCollected = collected
            bridgeSection = rendered.section
            // The block's real byte count and truncation state are known only
            // after rendering, so they are reported here rather than guessed
            // from the collection. A silent cut is the defect this surfaces
            // (`/memory`, `/context`, the launch warning, the state file).
            bridgeStats = rendered.stats
            bridgeScoped = collected.scopedRules
            bridgeActive = rendered.stats.bytes > 0
            if (rendered.stats.truncated) {
              consola.warn(
                `Pi memory bridge: the bridged AGENTS.md block hit its ${Math.round(PI_BRIDGE_STATIC_BUDGET_BYTES / 1000)} KB budget and was cut to ${rendered.stats.bytes} bytes, so some rules are incomplete or omitted this launch. Raise the budget in src/lib/pi-memory-bridge.ts, or move detail into .claude/rules/ so it attaches on demand instead.`,
              )
            }
          } catch (err) {
            consola.debug("Pi memory bridge collection skipped:", err)
          }
        }
      }

      // Peer floor (agents + consult skills) rides --peers; the SWE
      // pipeline (delegate/advisor skills, review prompts) rides --swe AND
      // --peers (without agents + the subagent provider its prose dangles,
      // so peerless+swe emits none — see the heads-up below).
      // semantic-search prose rides --search. Bare launches write none.
      //
      // The router's own artifacts are built and WRITTEN before the foreign
      // bridge runs: the bridge reserves against exactly these names, so a
      // foreign `reviewer` or `/review` can never land on the router's copy,
      // and the reservation is against this launch's real output rather than
      // a stale mirror copy from the previous one.
      const routerAgentFiles = peersEnabled ? buildPiAgentFiles(profileId) : {}
      const routerSkills = buildPiSkills({ profileId, peers: peersEnabled, swe: sweEnabled, search: searchEnabled })
      const routerPrompts = buildPiPrompts({ profileId, swe: sweEnabled, peers: peersEnabled })
      for (const [rel, content] of Object.entries(routerAgentFiles)) {
        await writeTextFile(path.join(mirror, rel), content)
      }
      // A user skill of the same name wins: the mirror was seeded from
      // `~/.pi/agent` before this loop, so overwriting here would silently
      // destroy the user's own `gh-oracle`/`gh-delegate` skill.
      const skillPlan = await planSkillWrites(mirror, routerSkills)
      for (const skill of skillPlan.write) {
        await writeTextFile(path.join(mirror, "skills", skill.dir, "SKILL.md"), skill.content)
      }
      const shadowedSkills = skillPlan.shadowed.map(({ dir, file }) => ({ dir, file }))
      if (shadowedSkills.length > 0) {
        consola.warn(
          `Pi skills: kept your ${shadowedSkills.map((s) => `\`${s.dir}\``).join(", ")} instead of the router's copy (${shadowedSkills[0]?.file}). Remove the user skill to get the router's version back.`,
        )
      }
      for (const prompt of routerPrompts) {
        await writeTextFile(path.join(mirror, "prompts", `${prompt.name}.md`), prompt.content)
      }
      await writeTextFile(
        path.join(mirror, "APPEND_SYSTEM.md"),
        buildPiAppendSystem(profileId, {
          peers: peersEnabled,
          // Unconditional: `resolvePiSurfaces` pushes the `search` group on every
          // launch, so the `code` tool is always in the roster and its ordering
          // always deserves a line. `semanticReady` is the narrower question of
          // which engine will answer it, and only picks the variant.
          codeTool: true,
          semanticReady: surfaces.codeSearch,
          bridge: bridgeActive,
        }),
      )

      // Claude Code + Copilot artifacts (skills, prompts, agents). Skills are
      // always bridged; prompts and agents ride `--foreign`. Collisions are
      // resolved here, before any write and before any registration, against
      // the router's own names above and the user's. Agents are never written
      // as files — they become runtime registrations in the generated
      // extension (see `PiForeignExtensionInput`).
      let foreign: { agents: Array<{ name: string; description: string; body: string }>; index: string } | undefined
      if (foreignEnabled) {
        try {
          const {
            buildForeignAgentIndex,
            buildReservedNames,
            piForeignHomeDir,
            piForeignRepoRoot,
            planForeignArtifacts,
            writeForeignArtifacts,
          } = await import("./lib/pi-foreign-artifacts")
          // The git top-level, not the cwd: launching from a subdirectory is
          // ordinary, and every foreign root is repo-relative. The memory
          // bridge resolves the same way for the same reason.
          const repoRoot = await piForeignRepoRoot(process.cwd())
          const homeDir = piForeignHomeDir()
          const reservedNames = await buildReservedNames({
            mirrorDir: mirror,
            repoRoot,
            homeDir,
            // The stems of the agent files written just above: `agents/explore.md`
            // publishes `Explore`, which is what Pi resolves and what a foreign
            // `explore` must not shadow.
            emittedAgents: Object.keys(routerAgentFiles).map((rel) => path.basename(rel, ".md")),
            emittedSkills: routerSkills.map((skill) => skill.dir),
            emittedPrompts: routerPrompts.map((prompt) => prompt.name),
          })
          const plan = await planForeignArtifacts({
            repoRoot,
            homeDir,
            mirrorDir: mirror,
            reservedNames,
          })
          const written = await writeForeignArtifacts(mirror, plan)
          if (written.overwritten > 0) {
            // A tripwire, not a feature: the planner reserves every name the
            // router or the user already owns, so a non-zero count means the
            // reservation scan missed something and a foreign artifact just
            // replaced one. Say so instead of silently winning.
            consola.warn(
              `Pi foreign bridge: ${written.overwritten} existing file(s) were replaced. That is a bug in the name reservation, not expected behavior.`,
            )
          }
          foreign = {
            agents: plan.agents.map(({ name, description, body }) => ({ name, description, body })),
            index: buildForeignAgentIndex(plan.agents),
          }
          foreignStats = {
            agents: plan.agents.length,
            renamed: [
              ...plan.agents
                .filter((agent) => agent.renamedFrom)
                .map((agent) => ({ from: String(agent.renamedFrom), to: agent.name })),
              ...plan.skills
                .filter((skill) => skill.renamedFrom)
                .map((skill) => ({ from: String(skill.renamedFrom), to: skill.name })),
              ...plan.prompts
                .filter((prompt) => prompt.renamedFrom)
                .map((prompt) => ({ from: String(prompt.renamedFrom), to: prompt.name })),
            ],
            skipped: plan.skipped.map(({ name, reason }) => ({ name, reason })),
            written,
          }
        } catch (err) {
          consola.debug("Pi foreign bridge skipped:", err)
        }
      } else {
        // The bridge is invisible by design, so a user who HAS foreign
        // artifacts and never passes `--foreign` has no other way to learn the
        // flag exists. Counted (a `readdir` walk), never planned: nothing is
        // reserved and nothing is written. The count rides the launch card
        // because `enableFileLogging()` sinks consola's stdout in TUI mode —
        // an info line here would reach nobody.
        try {
          const { countForeignAgentFiles, piForeignHomeDir, piForeignRepoRoot } =
            await import("./lib/pi-foreign-artifacts")
          foreignAvailable = await countForeignAgentFiles({
            repoRoot: await piForeignRepoRoot(process.cwd()),
            homeDir: piForeignHomeDir(),
          })
        } catch (err) {
          consola.debug("Pi foreign artifact probe skipped:", err)
        }
      }

      await writeTextFile(
        path.join(mirror, "extensions", "gh-router-pi", "index.ts"),
        buildPiExtensionSource({
          profileId,
          bridge: bridgeStats ? { stats: bridgeStats, scopedRules: bridgeScoped } : undefined,
          foreign,
        }),
      )
      // Every scoped group reaches Pi through Pi's own `mcp.json` in the
      // mirror, which built-in MCP reads at session start
      // (`<Pi agent dir>/mcp.json`, Pi 0.99+). A user-owned `mcp.json` is
      // merged over, never replaced, and a project file that would shadow an
      // entry is reported rather than repaired.
      if (surfaces.groups.length > 0) {
        const written = await writePiMcpJson({
          mirrorDir: mirror,
          workspace: process.cwd(),
          serverUrl,
          groups: surfaces.groups,
          // Same id the local tier rows carry. No Pi profile reaches the two
          // local consultants today, so the header is inert on every launch it
          // is written for; it exists so a consult issued over `/mcp` is keyed
          // to this conversation the moment one does.
          sessionId: state.sessionId,
        })
        if (written.skippedReason) {
          consola.warn(
            `Pi MCP: left ${written.path} alone (${written.skippedReason}); the scoped groups are not exposed to Pi this launch.`,
          )
        } else {
          for (const { key, file } of written.shadowed) {
            consola.warn(
              `Pi MCP: ${file} declares "${key}" and outranks the mirror copy, so the router's version is not the one Pi will run. Rename that entry to keep both.`,
            )
          }
        }
      }
      // Static bridge synthesis into mirror AGENTS.md (Pi-native candidate).
      // The block was rendered above (its bytes decide whether the digest names
      // AGENTS.md at all); this writes it and records the report. Idempotent via
      // fenced replace, and an empty section strips a stale block this launcher
      // wrote on a previous run against a repo that has since lost its rules.
      if (bridgeCollected) {
        try {
          const { mergeBridgeIntoAgentsMd } = await import("./lib/pi-memory-bridge")
          const agentsPath = path.join(mirror, "AGENTS.md")
          let existing: string | undefined
          try {
            existing = await fs.readFile(agentsPath, "utf8")
          } catch {
            existing = undefined
          }
          // Whether the user already keeps their own instructions in this
          // mirror's AGENTS.md. If so, Pi has been reading AGENTS.md (and
          // skipping CLAUDE.md) since long before this launch, and the bridge
          // is not the reason the user's CLAUDE.md is unread.
          const userText = mergeBridgeIntoAgentsMd(existing, "").trim()
          const merged = mergeBridgeIntoAgentsMd(existing, bridgeSection)
          if (merged !== (existing ?? "")) await writeTextFile(agentsPath, merged)
          // Pi reads exactly ONE context file per directory, in the order
          // `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`. Both
          // directions of that rule hurt here, and neither is visible from the
          // outside, so each is reported once and nothing is repaired.
          const shadowWarnings = bridgeShadowWarnings(precedence, {
            bridgeActive,
            mirrorDir: mirror,
            userOwnsAgentsMd: userText.length > 0,
          })
          for (const warning of shadowWarnings) consola.warn(warning)
          await writeJsonFile(path.join(mirror, ".gh-router-bridge.json"), {
            stats: bridgeStats ?? null,
            deduped: bridgeCollected.deduped ?? 0,
            shadowedSkills,
            scopedRuleFiles: bridgeScoped.map((r) => r.file),
            // Everything a launch silently overrode or was overridden by, so the
            // next "why is my rule missing?" question has an answer on disk.
            precedence: {
              agentsOverride: precedence.agentsOverride ? path.join(mirror, "AGENTS.override.md") : null,
              userClaudeMd: precedence.userClaudeMd,
              systemMd: precedence.systemMd ? path.join(mirror, "SYSTEM.md") : null,
              projectAppendSystem: precedence.projectAppendSystem,
            },
          })
        } catch (err) {
          consola.debug("Pi memory bridge synthesis skipped:", err)
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
    const entry = registerLaunch({
      profileId,
      nonce,
      secret: launchSecret,
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
        // From the resolved decision, not from `state`: the Azure groups only
        // reach the session through the helpers bundle, so the card must name
        // exactly what the mirror carries.
        mcpGroups: surfaces.groups.map((g) => g.group),
        foreign: foreignStats
          ? {
              agents: foreignStats.agents,
              skills: foreignStats.written.skills,
              prompts: foreignStats.written.prompts,
              renamed: foreignStats.renamed,
              skipped: foreignStats.skipped,
            }
          : undefined,
        // Present-but-unbridged count: the only discovery path for `--foreign`.
        foreignAvailable,
        serverUrl,
      })}\n`,
    )
    if (sweEnabled && !peersEnabled) {
      process.stderr.write(
        "Note: --swe without --peers emits no delegate/review skills or prompts (no agents behind them in a peerless launch).\n",
      )
    }

    const { disposeBluebirdClients } = await import("./lib/bluebird-client")
    const { disposeAdoClients } = await import("./lib/ado-tools")
    launchChild(
      {
        kind: "pi",
        // Who to run. A managed Pi is `node <payload>/…/cli.js`, so this is an
        // argv PREFIX and `buildLaunchCommand` appends `--provider gh-router`
        // and the model/extra args after it. Undefined (the `--no-update-check`
        // path) keeps the historic `pi`-on-PATH behaviour.
        execArgs:
          piCommand && piCommand.command !== ""
            ? [piCommand.command, ...piCommand.args]
            : undefined,
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
          await disposeAdoClients()
          // No package-cache work here on purpose. Pi installs into the
          // durable entry through the mirror's `npm` link, so there is nothing
          // to copy back, and the next seed validates whatever this launch
          // left. Anything heavy here would be cut short by the launcher's 5 s
          // shutdown fail-safe — the 32 s copy this replaced was truncated on
          // every single exit. Just remove the per-launch mirror.
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
