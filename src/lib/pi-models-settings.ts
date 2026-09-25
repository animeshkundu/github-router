import {
  BALANCED_PROFILE_MODELS,
  BALANCED_PROFILE_NATIVE_EFFORTS,
  BALANCED_PROFILE_ORACLE_EFFORT,
  BALANCED_PROFILE_ORACLE_MODEL,
} from "./balanced-profile-contract"
import {
  CHEAPEST_PROFILE_ADVISOR_EFFORT,
  CHEAPEST_PROFILE_ADVISOR_MODEL,
  CHEAPEST_PROFILE_MODELS,
  CHEAPEST_PROFILE_NATIVE_EFFORTS,
  CHEAPEST_PROFILE_ORACLE_EFFORT,
  CHEAPEST_PROFILE_ORACLE_MODEL,
} from "./cheapest-profile-contract"
import { piContextWindowFor } from "./pi-tier-windows"

export type PiProfileId = "cheapest" | "balanced"

/** Minimal catalog view the Pi builders need (adapted from state.models). */
export interface PiCatalogModel {
  id: string
  maxContextTokens: number
  maxPromptTokens: number
  maxOutputTokens?: number
  efforts: ReadonlyArray<string>
  /** Canonical endpoint kinds, e.g. "responses" | "chat" | "messages". */
  endpoints: ReadonlyArray<string>
  /**
   * Whether the model accepts image input (`supports.vision`). Absent
   * means unknown — models.json fails OPEN (`["text","image"]`) so Pi's
   * native image paths (@path/--file/paste/read) stay available and the
   * proxy preflight remains the backstop. Only an explicit `false`
   * advertises text-only.
   */
  vision?: boolean
  /** Decoded-byte per-image limit (`limits.vision.max_prompt_image_size`). */
  maxImageBytes?: number
  /**
   * Per-1M USD costs (converted from catalog units by the launcher).
   * All-or-nothing: Pi silently rejects the whole provider when any of
   * the four figures is missing, so the launcher emits `cost` only when
   * input, output, cacheRead AND cacheWrite are all known.
   */
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

/**
 * Pi thinking levels that can appear in `thinkingLevelMap`. `off` is
 * omitted: it means "no reasoning" and is never mapped to a provider
 * value.
 */
export const PI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

/**
 * Build a Pi `thinkingLevelMap` from a catalog `reasoning_effort`
 * allowlist: supported levels map to themselves, unsupported to `null`
 * (Pi hides them in `/thinking`). Returns `undefined` when the catalog
 * carries no effort signal so Pi falls back to its own defaults rather
 * than a guessed map.
 */
export function piThinkingLevelMapFor(
  efforts: ReadonlyArray<string> | undefined,
): Record<string, string | null> | undefined {
  if (!efforts || efforts.length === 0) return undefined
  const set = new Set(efforts)
  const map: Record<string, string | null> = {}
  for (const level of PI_THINKING_LEVELS) {
    map[level] = set.has(level) ? level : null
  }
  return map
}

/**
 * Fallback Pi window (tokens) when a model has no pinned cheap-tier
 * threshold. Per-model rows use `piContextWindowFor` (tier threshold);
 * this constant remains the floor no role drops below.
 */
export const PI_PROFILE_CONTEXT_TOKENS = 200_000 as const
/** Provider key used in models.json and agent `provider/model` references. */
export const PI_PROVIDER_NAME = "gh-router" as const

const PI_MIN_VERSION_NOTE = "Requires Pi >= 0.87.1 and Node >= 22.19."

export function piLeadModel(profileId: PiProfileId): string {
  return profileId === "cheapest"
    ? CHEAPEST_PROFILE_MODELS.lead
    : BALANCED_PROFILE_MODELS.lead
}

export function piLeadThinking(profileId: PiProfileId): string {
  // Cheapest lead runs at max effort; balanced at medium (frontier
  // reasoning without the pricey tiers).
  return profileId === "cheapest" ? "max" : "medium"
}

export function piOracleModel(profileId: PiProfileId): string {
  return profileId === "cheapest"
    ? CHEAPEST_PROFILE_ORACLE_MODEL
    : BALANCED_PROFILE_ORACLE_MODEL
}

export function piOracleThinking(profileId: PiProfileId): string {
  return profileId === "cheapest"
    ? CHEAPEST_PROFILE_ORACLE_EFFORT
    : BALANCED_PROFILE_ORACLE_EFFORT
}

/** Cheapest-only advisor. Balanced is advisor-free by design: undefined. */
export function piAdvisorModel(
  profileId: PiProfileId,
): { model: string; thinking: string } | undefined {
  if (profileId !== "cheapest") return undefined
  return {
    model: CHEAPEST_PROFILE_ADVISOR_MODEL,
    thinking: CHEAPEST_PROFILE_ADVISOR_EFFORT,
  }
}

export interface PiNativeRole {
  name: "Explore" | "General-Purpose" | "reviewer"
  model: string
  thinking: string
  readOnly: boolean
}

export function piNativeRoles(profileId: PiProfileId): Array<PiNativeRole> {
  if (profileId === "cheapest") {
    return [
      {
        name: "Explore",
        model: CHEAPEST_PROFILE_MODELS.explore,
        thinking: CHEAPEST_PROFILE_NATIVE_EFFORTS.Explore,
        readOnly: true,
      },
      {
        name: "General-Purpose",
        model: CHEAPEST_PROFILE_MODELS["General-Purpose"],
        thinking: CHEAPEST_PROFILE_NATIVE_EFFORTS["General-Purpose"],
        readOnly: false,
      },
      {
        name: "reviewer",
        model: CHEAPEST_PROFILE_MODELS.reviewer,
        thinking: CHEAPEST_PROFILE_NATIVE_EFFORTS.reviewer,
        readOnly: true,
      },
    ]
  }
  return [
    {
      name: "Explore",
      model: BALANCED_PROFILE_MODELS.explore,
      thinking: BALANCED_PROFILE_NATIVE_EFFORTS.Explore,
      readOnly: true,
    },
    {
      name: "General-Purpose",
      model: BALANCED_PROFILE_MODELS["General-Purpose"],
      thinking: BALANCED_PROFILE_NATIVE_EFFORTS["General-Purpose"],
      readOnly: false,
    },
    {
      name: "reviewer",
      model: BALANCED_PROFILE_MODELS.reviewer,
      thinking: BALANCED_PROFILE_NATIVE_EFFORTS.reviewer,
      readOnly: true,
    },
  ]
}

/**
 * Every model id Pi must see for this profile. Peerless launches
 * (`peers: false`) register the lead only — no peer or native-role model
 * is consumed, so none is exposed to the picker or budgeted.
 */
export function piProfileModelIds(
  profileId: PiProfileId,
  opts: { peers?: boolean } = {},
): Array<string> {
  const ids = new Set<string>([piLeadModel(profileId)])
  if (opts.peers !== false) {
    ids.add(piOracleModel(profileId))
    for (const r of piNativeRoles(profileId)) ids.add(r.model)
    const advisor = piAdvisorModel(profileId)
    if (advisor) ids.add(advisor.model)
  }
  return [...ids]
}

export type PiModelApi = "openai-completions" | "openai-responses"

export interface PiModelsJson {
  providers: Record<
    string,
    {
      baseUrl: string
      api: PiModelApi
      apiKey: string
      /** Send the dummy bearer; the proxy ignores auth but Pi treats
       *  auth-present providers as picker-usable. */
      authHeader: true
      models: Array<{
        id: string
        name: string
        reasoning: true
        input: Array<string>
        contextWindow: number
        /** Pi requires an output limit; the proxy 400s values < 16. */
        maxTokens: number
        cost?: {
          input: number
          output: number
          cacheRead?: number
          cacheWrite?: number
        }
        /**
         * Maps Pi thinking levels to provider values; `null` hides the
         * level in `/thinking`. Derived from the catalog
         * `reasoning_effort` allowlist; omitted when the catalog carries
         * no effort signal.
         */
        thinkingLevelMap?: Record<string, string | null>
        /**
         * Per-model image encode budget so Pi resizes BEFORE sending
         * instead of the proxy dropping after sending. Conservative
         * docs-example values (1568px, 512KiB encoded, q75) clamped
         * further when a model publishes a smaller image-size limit.
         */
        inputLimits?: {
          images?: {
            resize?: {
              maxWidth?: number
              maxHeight?: number
              maxBytes?: number
              jpegQuality?: number
            }
          }
        }
        /** Per-model API override (documented Pi capability) for a
         *  future chat-served model on this provider. Omitted when it
         *  matches the provider default. */
        api?: PiModelApi
      }>
    }
  >
}

/**
 * Conservative per-model image resize Pi applies before sending.
 * Docs-example values: 1568px, 512KiB encoded payload, JPEG quality 75.
 * Well under Copilot's 3MiB decoded limit and ample for UI screenshots
 * (measured ~35KB PNG), so sends stay fast and cheap. A model publishing
 * a smaller `max_prompt_image_size` clamps `maxBytes` further via
 * `piImageResizeFor` (encoded budget scaled from the decoded limit).
 */
export const PI_IMAGE_RESIZE_MAX_WIDTH: number = 1568
export const PI_IMAGE_RESIZE_MAX_HEIGHT: number = 1568
export const PI_IMAGE_RESIZE_MAX_BYTES: number = 524288
export const PI_IMAGE_RESIZE_JPEG_QUALITY: number = 75

/**
 * Derive the `inputLimits.images.resize` budget for a model row.
 * Returns `undefined` for text-only models (explicit `vision === false`).
 * Otherwise the conservative defaults, with `maxBytes` clamped to the
 * decoded catalog limit scaled to encoded units when that limit is
 * smaller than the default budget.
 */
export function piImageResizeFor(
  vision: boolean | undefined,
  maxImageBytes: number | undefined,
): PiModelsJson["providers"][string]["models"][number]["inputLimits"] | undefined {
  if (vision === false) return undefined
  let maxBytes = PI_IMAGE_RESIZE_MAX_BYTES
  if (
    typeof maxImageBytes === "number"
    && Number.isFinite(maxImageBytes)
    && maxImageBytes > 0
  ) {
    // Encoded payload inflates ~4/3 over decoded bytes; scale the
    // decoded catalog limit into encoded units before clamping.
    const scaled = Math.floor(maxImageBytes * 4 / 3)
    if (scaled < maxBytes) maxBytes = Math.max(scaled, 1)
  }
  return {
    images: {
      resize: {
        maxWidth: PI_IMAGE_RESIZE_MAX_WIDTH,
        maxHeight: PI_IMAGE_RESIZE_MAX_HEIGHT,
        maxBytes,
        jpegQuality: PI_IMAGE_RESIZE_JPEG_QUALITY,
      },
    },
  }
}

/**
 * Derive a per-model Responses/Completions API from catalog endpoints.
 * Returns `undefined` when the catalog carries no endpoint signal so the
 * caller falls back to the provider default. A Responses-capable model
 * stays on the provider default; a chat-only model overrides to
 * completions.
 */
export function piApiForEndpoints(
  endpoints: ReadonlyArray<string> | undefined,
): PiModelApi | undefined {
  if (!endpoints || endpoints.length === 0) return undefined
  const lower = endpoints.map((e) => e.toLowerCase())
  const hasResponses = lower.some((e) => e.includes("responses"))
  if (hasResponses) return "openai-responses"
  if (lower.some((e) => e.includes("chat") || e.includes("completion"))) {
    return "openai-completions"
  }
  return undefined
}

/**
 * Fallback per-request output cap when the catalog carries no
 * max_output_tokens. Matches the documented Luna/Grok 128K ceiling;
 * the live catalog always wins. Never below the proxy's 16-token floor.
 */
export const PI_MAX_TOKENS_FALLBACK = 128_000 as const

/** Catalog price units per USD (billing-doc USD x 100 — verified on
 *  luna/sol/opus live-vs-doc pairs). Pi cost metadata wants USD/1M;
 *  the ratio is spike-verified against the footer math at runtime. */
export const PI_CATALOG_UNITS_PER_USD = 100 as const

export interface PiCatalogTokenPrices {
  batch_size?: number
  input_price?: number
  output_price?: number
  cache_price?: number
  cache_read_price?: number
  cache_write_price?: number
}

/**
 * Per-1M USD cost for a models.json row, or undefined when unknown.
 *
 * ALL-OR-NOTHING (verified live): Pi silently rejects the entire
 * provider when any of the four figures is missing, surfacing only as
 * `Unknown provider`. A missing figure therefore omits `cost`
 * entirely — guessing zero would under-report real spend, and a
 * partial object breaks the launch.
 */
export function piUsdCostFor(
  prices: PiCatalogTokenPrices | undefined,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const batch = prices?.batch_size
  const usdPer1M = (v: number | undefined): number | undefined =>
    typeof batch === "number" && Number.isSafeInteger(batch) && batch > 0
    && typeof v === "number" && Number.isFinite(v) && v >= 0
      ? v / 1e9 * 1e6 / batch / PI_CATALOG_UNITS_PER_USD
      : undefined
  const input = usdPer1M(prices?.input_price)
  const output = usdPer1M(prices?.output_price)
  const cacheRead = usdPer1M(prices?.cache_read_price ?? prices?.cache_price)
  const cacheWrite = usdPer1M(prices?.cache_write_price)
  if (
    input === undefined
    || output === undefined
    || cacheRead === undefined
    || cacheWrite === undefined
  ) {
    return undefined
  }
  return { input, output, cacheRead, cacheWrite }
}

/**
 * Build the `models.json` provider entry pointing Pi at the running
 * proxy as an ordinary OpenAI-compatible endpoint (the documented
 * Ollama/vLLM pattern — no provider-override extension needed).
 *
 * The provider speaks `openai-responses`: every roster model is
 * Responses-only on Copilot, and Pi POSTs `{baseUrl}/responses` for
 * that API — i.e. our `/v1/responses`, the Codex-proven path. Sending
 * these models to `/v1/chat/completions` is a Copilot 400 (observed).
 * A model whose catalog endpoints lack Responses (future chat-served
 * model) overrides per-model via `piApiForEndpoints`.
 *
 * Every row is BARE (no `[1m]`) with its cheap-tier window from
 * `piContextWindowFor` (272K Luna/Sol, 200K Grok/unknown): Pi budgets
 * `contextWindow` per model, so each role gets its cheapest tier and
 * Long-tier (2x) pricing is structurally unreachable.
 *
 * Vision is fail-open: only an explicit catalog `vision === false`
 * advertises `["text"]`; unknown models advertise `["text","image"]`
 * so Pi's native image paths (@path/--file/paste/read) stay available
 * and the proxy vision preflight (drop-with-note + learned upstream
 * ceilings) remains the backstop. Vision rows also carry
 * `inputLimits.images.resize` so Pi resizes before sending instead of
 * paying a send-then-drop round trip, and `thinkingLevelMap` from the
 * catalog `reasoning_effort` allowlist so Pi never offers an effort
 * tier Copilot would 400.
 */
export function buildPiModelsJson(opts: {
  serverUrl: string
  profileId: PiProfileId
  catalog?: ReadonlyArray<PiCatalogModel>
  peers?: boolean
  /** Provider-level API; uniform Responses roster needs no overrides. */
  api?: PiModelApi
  apiOverrides?: Readonly<Record<string, PiModelApi>>
}): PiModelsJson {
  const baseUrl = `${opts.serverUrl.replace(/\/+$/, "")}/v1`
  const providerApi = opts.api ?? "openai-responses"
  return {
    providers: {
      [PI_PROVIDER_NAME]: {
        baseUrl,
        api: providerApi,
        apiKey: "dummy",
        authHeader: true as const,
        models: piProfileModelIds(opts.profileId, { peers: opts.peers }).map((id) => {
          const entry = opts.catalog?.find((m) => m.id === id)
          const out = entry?.maxOutputTokens
          const maxTokens =
            typeof out === "number" && Number.isFinite(out) && out >= 16
              ? Math.floor(out)
              : PI_MAX_TOKENS_FALLBACK
          const endpointApi = piApiForEndpoints(entry?.endpoints)
          const override = opts.apiOverrides?.[id] ?? endpointApi
          const thinkingLevelMap = piThinkingLevelMapFor(entry?.efforts)
          const inputLimits = piImageResizeFor(entry?.vision, entry?.maxImageBytes)
          return {
            id,
            name: id,
            reasoning: true as const,
            input: entry?.vision === false ? ["text"] : ["text", "image"],
            contextWindow: piContextWindowFor(id, entry?.maxContextTokens),
            maxTokens,
            ...(entry?.cost ? { cost: entry.cost } : {}),
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
            ...(inputLimits ? { inputLimits } : {}),
            ...(override && override !== providerApi ? { api: override } : {}),
          }
        }),
      },
    },
  }
}

export interface PiCompactionSettings {
  enabled: true
  reserveTokens: number
  keepRecentTokens: number
  modelOverrides: Record<
    string,
    { reserveTokens: number; keepRecentTokens: number }
  >
}

/**
 * Derive Pi compaction budgets from live catalog `max_prompt_tokens`
 * ceilings AND each model's cheap-tier window — the Pi-native analogue
 * of `deriveAutoCompactWindowTokens`. Pi triggers at
 * `contextWindow − reserveTokens` per active model; the trigger must sit
 * below BOTH the tier price cliff and Copilot's acceptance ceiling:
 *   reserve(id) = window(id) − floor(min(prompt, window) × 0.85),
 *   clamped to [16384, 100000]. keepRecentTokens stays 20000.
 * The global reserve is the max over models (every model's trigger is
 * safe); overrides carry each model's own value. Unknown catalog (no
 * prompt metadata) → Pi built-in defaults so a missing signal can never
 * disable compaction.
 */
export function derivePiCompactionSettings(
  catalog: ReadonlyArray<PiCatalogModel> | undefined,
  modelIds: ReadonlyArray<string>,
): PiCompactionSettings {
  const FALLBACK = {
    enabled: true as const,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    modelOverrides: {},
  }
  if (!catalog || catalog.length === 0) return FALLBACK
  const perModel = new Map<string, number>()
  for (const id of modelIds) {
    const entry = catalog.find((m) => m.id === id)
    const window = piContextWindowFor(id, entry?.maxContextTokens)
    const prompt = entry?.maxPromptTokens ?? 0
    const ceiling =
      Number.isFinite(prompt) && prompt > 0 ? Math.min(prompt, window) : window
    perModel.set(
      id,
      Math.min(100_000, Math.max(16384, window - Math.floor(ceiling * 0.85))),
    )
  }
  if (perModel.size === 0) return FALLBACK
  const global = Math.max(...perModel.values())
  const modelOverrides: PiCompactionSettings["modelOverrides"] = {}
  for (const [id, reserve] of perModel) {
    modelOverrides[`${PI_PROVIDER_NAME}/${id}`] = {
      reserveTokens: reserve,
      keepRecentTokens: 20000,
    }
  }
  return {
    enabled: true,
    reserveTokens: global,
    keepRecentTokens: 20000,
    modelOverrides,
  }
}

/**
 * A Pi `packages[]` entry: either a bare source string (load everything
 * the package declares) or the object form narrowing which resource types
 * load. Object filters can only NARROW the package manifest — they never
 * expose undeclared resources.
 */
export type PiPackageEntry =
  | string
  | {
    source: string
    extensions?: Array<string>
    skills?: Array<string>
    prompts?: Array<string>
    themes?: Array<string>
  }

export interface PiSettingsJson {
  defaultProvider: string
  defaultModel: string
  defaultThinkingLevel: string
  enabledModels: Array<string>
  defaultTools: Array<string>
  compaction: PiCompactionSettings
  /**
   * Per-model startup thinking levels keyed by exact `provider/modelId`.
   * Keeps the picker on tiers the catalog actually supports so Pi never
   * sends an effort Copilot would 400.
   */
  modelThinkingLevels?: Record<string, string>
  /** Inline-image display in capable terminals; part of the native
   *  image loop (paste/attach → see → reason). `showTerminalProgress`
   *  emits OSC 9;4 tab progress (unsupported terminals ignore it). */
  terminal?: {
    showImages?: boolean
    imageWidthCells?: number
    showTerminalProgress?: boolean
  }
  /**
   * Markdown rendering. Mermaid diagrams stream-render in the TUI
   * (pure display — zero tokens); pinned so a future Pi default change
   * cannot silently drop it. Cosmetic-overridable like the other look keys.
   */
  markdown?: {
    mermaid?: "off" | "final" | "streaming"
  }
  /** Native image pipeline switches. `autoResize` keeps sends under
   *  Copilot's image-size limit; `blockImages` is never set (that would
   *  reintroduce the text-only block at the settings layer). */
  images?: {
    autoResize?: boolean
    blockImages?: boolean
  }
  /** Preferred transport for multi-transport providers. */
  transport?: "auto" | "sse" | "websocket" | "websocket-cached"
  /**
   * Condense the post-update changelog. Display-only noise reduction
   * on update days; zero tokens, fully reversible below.
   */
  collapseChangelog?: boolean
  /**
   * Hide thinking blocks in the transcript. Default-on: reasoning
   * effort still applies, only the display is suppressed. Toggle at
   * runtime via `/settings`; never affects cost or behavior.
   */
  hideThinkingBlock?: boolean
  /**
   * Companion config for the bundled `pi-claude-code-ui` package
   * (which reads flat settings keys): `false` keeps its fixed
   * Claude-style palette regardless of the active Pi theme instead of
   * deriving chrome colors from it. Gated on the `ui` bundle — inert
   * and therefore omitted when the package is not loaded.
   */
  themeAdaptive?: boolean
  /**
   * Claude-Code-style one-line tool rows (same companion package):
   * `summary`/`count` collapse completed calls to a single summary
   * line instead of multi-line previews (expandable via Ctrl+O).
   * Gated on the `ui` bundle like `themeAdaptive`.
   */
  groupToolCalls?: boolean
  readOutputMode?: "hidden" | "summary" | "preview"
  searchOutputMode?: "hidden" | "count" | "preview"
  mcpOutputMode?: "hidden" | "summary" | "preview"
  bashOutputMode?: "opencode" | "summary" | "preview"
  /**
   * Transparent tool-row backgrounds (no heavy chrome — closest to
   * Claude Code's chromeless rows). Same companion-package gating as
   * the other cc-ui keys.
   */
  toolBackground?: "default" | "transparent" | "outlines" | "border"
  /**
   * Active Pi theme. Default is the genuine Claude Code dark palette
   * (provided by the bundled theme package below); light-terminal
   * users can pick `claude-code-light` (or any installed theme) and
   * — like every other look key — their own snapshot value wins.
   */
  theme?: string
  /** Branch-summary token budget for session-tree navigation. */
  branchSummary?: {
    reserveTokens?: number
    skipPrompt?: boolean
  }
  retry: {
    enabled: boolean
    maxRetries: number
    /**
     * Provider-level retries stay at 0: provider retries delay Pi from
     * handling quota/usage-limit errors itself, and the proxy already
     * owns transient retry below the agent.
     */
    provider?: {
      maxRetries?: number
    }
  }
  packages: Array<PiPackageEntry>
  /**
   * Subagent overrides. Only `agentOverrides` with `disabled` flags is
   * emitted: the builtin `scout`/`worker`/`researcher`/`evidence-auditor`
   * agents are hidden so habitual invocations resolve deterministically
   * via our own agents' `aliases` instead of running shadow rosters,
   * and the `claude-code`/`codex-exec`/`cursor-agent` families (+ their
   * `-writer` variants) are hidden because they shell out to other CLIs
   * with the operator's own auth — off-proxy, off-ledger, off-cost-control.
   * `delegate` stays enabled (append-mode, inherits the lead model, so it
   * is cost-safe and fills the lightweight-subtask path our roster lacks).
   * `reviewer`/`oracle` need no entry: our same-named files shadow them.
   */
  subagents?: {
    agentOverrides?: Record<string, { disabled?: boolean }>
  }
}

/**
 * Presentational settings keys that stay user-customizable. When the
 * snapshotted user settings already define one of these, the user's
 * value wins over the built default at launch-merge time (see
 * `applyCosmeticUserOverrides`). Everything else the builder emits —
 * models, tools, thinking levels, compaction, retry, packages — stays
 * built-wins: those are the cost contract, not a preference.
 */
export const PI_COSMETIC_SETTING_KEYS = [
  "hideThinkingBlock",
  "theme",
  "themeAdaptive",
  "groupToolCalls",
  "readOutputMode",
  "searchOutputMode",
  "mcpOutputMode",
  "bashOutputMode",
  "toolBackground",
  "terminal",
  "images",
  "markdown",
  "collapseChangelog",
] as const

export type PiCosmeticSettingKey = (typeof PI_COSMETIC_SETTING_KEYS)[number]

/**
 * Overlay user-defined presentational values onto built settings.
 * Only keys listed in `PI_COSMETIC_SETTING_KEYS` that are actually
 * present (not `undefined`) in `userSettings` override — so a user
 * `~/.pi/agent/settings.json` with e.g. `"hideThinkingBlock": false`
 * or `"readOutputMode": "preview"` keeps their look, while everyone
 * else gets the Claude-Code-like defaults. Returns the picked
 * overrides (empty object when the user customized nothing).
 */
export function applyCosmeticUserOverrides(
  userSettings: Record<string, unknown> | undefined,
  builtSettings: PiSettingsJson,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  if (!userSettings) return overrides
  const built = builtSettings as unknown as Record<string, unknown>
  for (const key of PI_COSMETIC_SETTING_KEYS) {
    if (!(key in userSettings)) continue
    const value = userSettings[key]
    if (value === undefined) continue
    if (!(key in built)) continue
    overrides[key] = value
  }
  return overrides
}

/**
 * Helpful third-party bundle, wired extensions-only (skills/prompts/
 * themes filtered out so third-party prose never reaches Ctrl+O — same
 * policy as `pi-subagents`). Router-owned surfaces stay excluded:
 * no statusline/footer package (built into `local:gh-router-pi`), no
 * compaction replacers, no provider/model overriders.
 *
 * - `pi-mcp-adapter`: MCP servers as one proxy tool instead of hundreds
 *   of definitions (context/cost win).
 * - `pi-web-access`: search/fetch/PDF-extract fallback. Only wired when
 *   the launch has neither `--search` nor `--browse`, otherwise it
 *   double-pays our ColBERT/browser surfaces.
 * - `pi-agent-extensions`: allowlisted stable extensions only
 *   (sessions, structured questions, todos, handoff, context
 *   dashboards, notifications, analytics). `review`/`loop`/`workflow`/
 *   `control` overlap our delegate/review pipeline and `powerline-footer`
 *   would fight the router-owned AIC footer, so all are excluded.
 *   `files` is deliberately excluded too: it registers `ctrl+shift+o`
 *   (file browser), colliding with `pi-claude-code-ui`'s `ctrl+shift+o`
 *   (extra tool detail) — Pi warns and the files binding dies, so
 *   shipping it only buys noise. `@file` mentions + the `context`
 *   dashboard + `read`/`ls`/`find` cover the need.
 */
export const PI_HELPERS_MCP_ADAPTER: PiPackageEntry = {
  source: "npm:pi-mcp-adapter",
  skills: [],
  prompts: [],
}

export const PI_HELPERS_WEB_ACCESS: PiPackageEntry = {
  source: "npm:pi-web-access",
  skills: [],
  prompts: [],
}

/** Verified manifest paths (pi-agent-extensions 0.5.x). Bare relative
 * form, NO `./` prefix: Pi matches package-filter patterns with
 * minimatch against root-relative paths, and a `./` prefix matches
 * nothing (observed live: zero extensions loaded, silent).
 * `extensions/files/index.ts` is intentionally absent: it owns
 * `ctrl+shift+o`, which `pi-claude-code-ui` also registers. */
export const PI_HELPERS_AGENT_EXTENSIONS: PiPackageEntry = {
  source: "npm:pi-agent-extensions",
  extensions: [
    "extensions/sessions/index.ts",
    "extensions/ask-user/index.ts",
    "extensions/handoff/index.ts",
    "extensions/notify/index.ts",
    "extensions/context/index.ts",
    "extensions/todos/index.ts",
    "extensions/answer/index.ts",
    "extensions/cwd-history/index.ts",
    "extensions/session-breakdown/index.ts",
  ],
  skills: [],
  prompts: [],
  themes: [],
}

/** Claude-look UI bundle: transcript grouping, Shiki diffs, Ctrl+O
 * previews. Default-on (purely presentational — zero model cost);
 * opt out with `--no-ui`. `pi-code` behaviors stay a docs recipe:
 * its `/memory` + `/context` commands would collide with the
 * router-owned pair in `gh-router-pi`, and Pi offers no per-command
 * filtering inside one extension. */
export const PI_UI_PACKAGES: ReadonlyArray<PiPackageEntry> = Object.freeze([
  "npm:pi-claude-code-ui",
])

/**
 * Claude Code dark theme (`#D77757` coral and friends) from
 * `better-claude-code-ui`, which ships six CC palettes. Themes-only:
 * extensions/skills/prompts are explicitly emptied so none of the
 * package's status line, footer, or tool rendering loads and fights
 * the router-owned footer or `pi-claude-code-ui`. Theme files are
 * pure JSON data — loading the whole `./theme` dir costs nothing at
 * runtime and leaves all six CC variants pickable via `/settings`,
 * with `claude-code-dark` the default (see `PI_CC_DARK_THEME`).
 */
export const PI_CC_THEME_PACKAGE: PiPackageEntry = {
  source: "npm:better-claude-code-ui",
  // Bare relative glob, NO `./` prefix (see note above): minimatch
  // matches manifest files by root-relative path, so `./theme` selects
  // nothing and the theme silently fails to load. All six CC variants
  // load as pure JSON data (zero runtime cost); the default is
  // `claude-code-dark`, light-terminal users pick `claude-code-light`.
  themes: ["theme/*.json"],
  extensions: [],
  skills: [],
  prompts: [],
}

/** Default Pi theme: genuine Claude Code dark palette. */
export const PI_CC_DARK_THEME = "claude-code-dark" as const

/** Built-in tools enabled at startup (Pi-native set incl. Windows). */
export const PI_DEFAULT_TOOLS: ReadonlyArray<string> = Object.freeze([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
])

/**
 * Build the per-launch `settings.json`. Additive over the snapshotted
 * user settings (the launcher merges lists it owns): narrow model
 * scope, fixed thinking, limited toolset, derived compaction, and the
 * mode's package slice. Never disables retry/transport hardening.
 *
 * `pi-subagents` rides `peersEnabled` and loads extensions ONLY
 * (skills/prompts filtered out — the mode's own skills/prompts cover
 * the roster, so the third-party sets never reach Ctrl+O).
 * The helpful bundle rides `helpers` (default on, peers-gated):
 * `pi-mcp-adapter` + allowlisted `pi-agent-extensions` always, plus
 * `pi-web-access` only when neither search nor browse is on (otherwise
 * it double-pays our ColBERT/browser surfaces). The `--ui` bundle
 * (`pi-code`, `pi-claude-code-ui`) is opt-in.
 * The statusline footer is built into `local:gh-router-pi` (no
 * third-party statusline package: the community bridge reads only the
 * user's real global/project settings and never sees the launch mirror,
 * so it cannot drive a per-launch footer).
 */
export function buildPiSettingsJson(opts: {
  profileId: PiProfileId
  searchEnabled: boolean
  browseEnabled: boolean
  catalog?: ReadonlyArray<PiCatalogModel>
  peers?: boolean
  helpers?: boolean
  ui?: boolean
}): PiSettingsJson {
  const peers = opts.peers !== false
  const helpers = opts.helpers !== false && peers
  const webAccess = helpers && !opts.searchEnabled && !opts.browseEnabled
  const ui = opts.ui !== false
  const modelIds = piProfileModelIds(opts.profileId, { peers })
  const modelThinkingLevels: Record<string, string> = {}
  modelThinkingLevels[`${PI_PROVIDER_NAME}/${piLeadModel(opts.profileId)}`] =
    piLeadThinking(opts.profileId)
  for (const role of piNativeRoles(opts.profileId)) {
    modelThinkingLevels[`${PI_PROVIDER_NAME}/${role.model}`] = role.thinking
  }
  modelThinkingLevels[`${PI_PROVIDER_NAME}/${piOracleModel(opts.profileId)}`] =
    piOracleThinking(opts.profileId)
  const advisor = piAdvisorModel(opts.profileId)
  if (advisor) {
    modelThinkingLevels[`${PI_PROVIDER_NAME}/${advisor.model}`] =
      advisor.thinking
  }
  return {
    defaultProvider: PI_PROVIDER_NAME,
    defaultModel: piLeadModel(opts.profileId),
    defaultThinkingLevel: piLeadThinking(opts.profileId),
    enabledModels: modelIds.map((id) => `${PI_PROVIDER_NAME}/${id}`),
    defaultTools: [...PI_DEFAULT_TOOLS],
    modelThinkingLevels,
    terminal: { showImages: true, imageWidthCells: 60, showTerminalProgress: true },
    markdown: { mermaid: "streaming" },
    collapseChangelog: true,
    images: { autoResize: true, blockImages: false },
    transport: "auto",
    hideThinkingBlock: true,
    ...(ui
      ? {
          themeAdaptive: false,
          groupToolCalls: true,
          readOutputMode: "summary" as const,
          searchOutputMode: "count" as const,
          mcpOutputMode: "summary" as const,
          bashOutputMode: "summary" as const,
          toolBackground: "transparent" as const,
          theme: PI_CC_DARK_THEME,
        }
      : {}),
    branchSummary: { reserveTokens: 16384, skipPrompt: false },
    compaction: derivePiCompactionSettings(opts.catalog, modelIds),
    retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 0 } },
    packages: [
      ...(peers
        ? [{ source: "npm:pi-subagents", skills: [], prompts: [] } as PiPackageEntry]
        : []),
      ...(helpers ? [PI_HELPERS_MCP_ADAPTER, PI_HELPERS_AGENT_EXTENSIONS] : []),
      ...(webAccess ? [PI_HELPERS_WEB_ACCESS] : []),
      ...(ui ? [...PI_UI_PACKAGES, PI_CC_THEME_PACKAGE] : []),
      "local:gh-router-pi",
    ],
    // Disabled builtins ride `peers` like the package itself: peerless
    // launches have no delegation floor at all, so nothing to disambiguate.
    ...(peers
      ? {
          subagents: {
            agentOverrides: {
              scout: { disabled: true },
              worker: { disabled: true },
              researcher: { disabled: true },
              "evidence-auditor": { disabled: true },
              // External-CLI families (0.71+): shell out to other CLIs
              // with ambient auth. Off-proxy and off-ledger — never in a
              // cost-controlled launch.
              "claude-code": { disabled: true },
              "claude-code-writer": { disabled: true },
              "codex-exec": { disabled: true },
              "codex-exec-writer": { disabled: true },
              "cursor-agent": { disabled: true },
              "cursor-agent-writer": { disabled: true },
            },
          },
        }
      : {}),
  }
}

function agentFileName(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`
}

/**
 * Deep-merge the `subagents` settings key across the snapshot/user and
 * built layer. Only `agentOverrides` merges (per-agent, user wins);
 * every other `subagents` sub-key follows the standard rule (built wins
 * when present, else user survives). Non-object inputs are ignored so a
 * corrupt user file degrades to built-only instead of crashing launch.
 */
export function mergeSubagentsSettings(
  userSubagents: unknown,
  builtSubagents: PiSettingsJson["subagents"],
): Record<string, unknown> | undefined {
  const user =
    userSubagents && typeof userSubagents === "object" && !Array.isArray(userSubagents)
      ? (userSubagents as Record<string, unknown>)
      : undefined
  const built = (builtSubagents ?? undefined) as Record<string, unknown> | undefined
  if (!user && !built) return undefined
  const userOverrides =
    user?.["agentOverrides"] && typeof user["agentOverrides"] === "object" && !Array.isArray(user["agentOverrides"])
      ? (user["agentOverrides"] as Record<string, unknown>)
      : undefined
  const builtOverrides = built?.["agentOverrides"] as Record<string, unknown> | undefined
  const mergedOverrides =
    userOverrides || builtOverrides
      ? { ...builtOverrides, ...userOverrides }
      : undefined
  return {
    ...user,
    ...built,
    ...(mergedOverrides ? { agentOverrides: mergedOverrides } : {}),
  }
}

function roleDescription(
  profileId: PiProfileId,
  role: PiNativeRole,
): string {
  // Nested-delegation channel note: General-Purpose is the only native
  // role with a nesting grant, so only it can consult the oracle subagent
  // directly. Explore/reviewer are leaves; they surface open questions in
  // their report and the lead (or General-Purpose) consults oracle.
  const oracleNote =
    "May consult the oracle subagent when a decision feels risky.";
  if (role.name === "Explore") {
    return "Fast read-only recon: locate code, answer evidence questions, return compressed context."
  }
  if (role.name === "General-Purpose") {
    return profileId === "balanced"
      ? `General implementation and follow-through on scoped tasks. May hand the result to reviewer only when the change alters behavior. ${oracleNote}`
      : `General implementation and follow-through on scoped tasks. May hand the result to reviewer for assessment. ${oracleNote}`
  }
  return profileId === "balanced"
    ? "Behavior-changing review only: assess a change, narrow scope with search first, delegate targeted discovery to Explore rather than sweeping the repo."
    : "Code review and assessment, including reproducing and root-causing a failure.";
}

/**
 * Build `.md` agent definitions for the mode's native roster, in the
 * OpenCode/pi-subagents-lite frontmatter format Pi delegation tools
 * consume (`name/description/tools/model/thinking`, plus `allowedAgents`
 * where the delegation graph has an edge). Bodies are
 * short execution contracts; workflow prose lives in skills so agent
 * files stay small enough to inline cheaply.
 *
 * Load-bearing semantics (verified against pi-subagents docs + source):
  * - `reviewer`/`oracle` intentionally SHADOW the same-named builtins
  *   wholesale (user scope wins; omitted fields are NOT inherited). That
  *   is how the roster pins gh-router models/thinking for cost control.
  *   The shadowed `advisor` alias dies with the builtin oracle definition,
  *   which is why `advisor` ships as its own file on cheapest.
  *   Shadowing deliberately does NOT inherit `contact_supervisor` on
  *   reviewer (leaf) or `defaultContext: fork` on oracle (fresh keeps
  *   the cold-start consultant contract).
  * - `allowedAgents` only narrows an existing nesting grant, so every
  *   delegating agent also sets `allowNestedSubagents: true` and lists
  *   `subagent` in `tools`. Depth reaches 3 on balanced
  *   (lead → General-Purpose → reviewer → Explore), covered by
  *   `PI_SUBAGENT_MAX_DEPTH=3` in the launch env (default guard is 2).
  * - `async: false` on every file: foreground children run in-process
  *   with the parent's full tool registry. The detached background
  *   runner demonstrably drops read/bash from its registry (observed
  *   live as "requested unavailable child tools: [read, bash]"),
  *   failing every strict-allowlist child it touches.
  * - Deliberately NO `output:`/`defaultReads`/`defaultProgress` file
  *   bindings: single-shot launches resolve relative outputs under
  *   per-run artifact dirs while `defaultReads` resolves against the
  *   child cwd and skips missing files silently — a lead-mediated
  *   Explore→General-Purpose file handoff never fires. Handoff is inline
  *   prose via the delegating brief instead. `defaultProgress` is doubly
  *   out: its default dir is the repo cwd (untracked litter, no cleanup).
 * - `advertise: true` puts custom agents in the parent prompt catalog
 *   (default false); `aliases` catch habitual builtin invocations
 *   (`scout`, `worker`, …) deterministically since those builtins are
 *   disabled in settings.
 * - `inheritProjectContext: true` keeps bridged repo rules (AGENTS.md)
 *   visible to children; `defaultContext: fresh` pins the cold-start
 *   contract explicitly instead of relying on implicit fallback.
 */
export function buildPiAgentFiles(
  profileId: PiProfileId,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const role of piNativeRoles(profileId)) {
    const isImplementer = role.name === "General-Purpose"
    const isReviewer = role.name === "reviewer"
    // `watchdog_diff` (diff-anchored review) is provided by the
    // pi-subagents runtime, like the delegation primitives — no extra
    // package needed. Balanced reviewer additionally lists `subagent`:
    // it holds the roster's other nesting grant (→ Explore) and the
    // grant is inert without it.
    //
    // Bare comma form (no brackets), matching every pi-subagents
    // builtin file. `contact_supervisor` appears ONLY on the writer:
    // it is a blocked-child escalation channel, meaningless on leaves
    // (reviewer/Explore just return; supervisor pings from them are
    // noise that costs a turn each).
    const tools = isImplementer
      ? "read, grep, find, ls, bash, edit, write, subagent, contact_supervisor"
      : isReviewer
        ? profileId === "balanced"
          ? "read, grep, find, ls, watchdog_diff, subagent"
          : "read, grep, find, ls, watchdog_diff"
        : "read, grep, find, ls, bash";
    const lines = [
      "---",
      `name: ${role.name}`,
      `description: ${roleDescription(profileId, role)}`,
      `tools: ${tools}`,
      `model: ${PI_PROVIDER_NAME}/${role.model}`,
      `thinking: ${role.thinking}`,
      "advertise: true",
      // Foreground by default. pi-subagents launches workflow children
      // async (detached runner) by default, and the runner's tool
      // registry demonstrably drops read/bash (observed live:
      // "requested unavailable child tools: [read, bash]"), failing
      // every strict-allowlist child. Foreground children run in-process
      // with the parent's full registry — nesting works, no spawn
      // overhead, no runner cost. Explicit call values still win.
      "async: false",
      "systemPromptMode: replace",
      "inheritProjectContext: true",
      "defaultContext: fresh",
    ];
    if (role.name === "Explore") {
      // `scout` alias absorbs habitual builtin invocations (the builtin is
      // disabled in settings). Handoff is inline prose: the lead pastes
      // brief excerpts into the next brief (see gh-delegate skill).
      // Bare form (no brackets): the aliases/allowedAgents splitter does
      // not understand YAML flow lists — `[reviewer, oracle]` parses as
      // `'[reviewer'` + `'oracle]'` and fails the run (observed live).
      lines.push("aliases: scout");
    }
    if (isImplementer) {
      // Aliases absorb builtin `worker` traffic (`developer/coder` plus
      // `implementer/develop`, all builtin-worker aliases);
      // `acceptanceRole: writer` restores the builtin worker's acceptance
      // inference that shadowing would otherwise drop.
      lines.push(
        "aliases: worker, developer, coder, implementer, develop",
        "acceptanceRole: writer",
        "allowNestedSubagents: true",
        "allowedAgents: reviewer, oracle",
      );
    }
    if (profileId === "balanced" && isReviewer) {
      lines.push("allowNestedSubagents: true", "allowedAgents: Explore");
    }
    lines.push("---", "");
    if (role.name === "Explore") {
      lines.push(
        "You are a read-only scout. Never modify files.",
        "Use bash only for non-interactive inspection.",
        "Search first, read second: return the smallest sufficient evidence — entry points,",
        "key types and functions, data flow, files likely to need changes, constraints and",
        "open questions — with exact file paths and line ranges.",
      );
    } else if (isReviewer) {
      lines.push(
        "You are a disciplined review subagent. Inspect the actual change; verify from code,",
        "tests, and docs — never guess. Cover intent match, correctness and edge cases,",
        "test coverage, side effects, and minimality.",
        "Report findings with file:line evidence ranked P0 (blocker) / P1 (should fix) / P2 (nit),",
        "ending with one of: Merge verdict: BLOCK, Merge verdict: OK, Merge verdict: OK with notes.",
        "You have no shell: cite the test commands for the lead to run rather than executing them.",
        "Do not rewrite code outside small, clearly-marked suggestions.",
      );
    } else {
      lines.push(
        "You are the single writer thread. Execute the assigned task with narrow, coherent edits;",
        "the lead remains the decision authority. Work from the brief's pasted context,",
        "then implement minimally and verify by running the relevant tests.",
        "If the work reveals an unapproved decision you cannot safely resolve, stop and escalate",
        "instead of guessing; never leave placeholders or TODOs.",
        "Hand behavior-changing results to reviewer when asked; otherwise summarize the diff,",
        "validation, risks, and next step.",
      );
    }
    files[`agents/${agentFileName(role.name)}`] = `${lines.join("\n")}\n`;
  }
  // Oracle consultant agent (both modes). Advisory only: challenges
  // assumptions, never edits. Cold-start fresh context matches the MCP
  // `peers/oracle` tool contract (stateless query + context, no transcript),
  // deliberately unlike the builtin's forked decision-consistency role.
  const oracle = [
    "---",
    "name: oracle",
    "description: Second opinion before acting. Challenges assumptions without editing. Use when the decision itself feels risky.",
    "tools: read, grep, find, ls, bash",
    `model: ${PI_PROVIDER_NAME}/${piOracleModel(profileId)}`,
    `thinking: ${piOracleThinking(profileId)}`,
    "advertise: true",
    "async: false",
    "systemPromptMode: replace",
    "inheritProjectContext: true",
    "defaultContext: fresh",
    "---",
    "",
    "You are an oracle: a second set of eyes. You see only the task context",
    "you are given — you have no repo memory beyond what you read now.",
    "Inspect the code yourself with read/grep/find/ls before opining.",
    "Challenge assumptions, name what is missing, recommend; never execute.",
  ].join("\n");
  files[`agents/${agentFileName("oracle")}`] = `${oracle}\n`;
  // Advisor agent (cheapest only). Genuinely new role — the builtin has no
  // separate advisor file (`advisor` is just an alias of builtin oracle, lost
  // in shadowing). Balanced stays advisor-free: no file, no skill, no prompt,
  // no prose — asserted by tests.
  const advisor = piAdvisorModel(profileId);
  if (advisor) {
    const body = [
      "---",
      "name: advisor",
      "description: Advisory plan review for the lead: review the final plan before it is presented. Never executes.",
      "tools: read, grep, find, ls",
      `model: ${PI_PROVIDER_NAME}/${advisor.model}`,
      `thinking: ${advisor.thinking}`,
      "advertise: true",
      "async: false",
      "systemPromptMode: replace",
      "inheritProjectContext: true",
      "defaultContext: fresh",
      "---",
      "",
      "You review the lead's final plan and give advisory feedback only.",
      "Confirm or challenge approach, scope, and verification steps.",
      "You never implement, and your verdict never substitutes for verification.",
    ].join("\n");
    files[`agents/${agentFileName("advisor")}`] = `${body}\n`;
  }
  return files;
}

export interface PiLaunchCardOpts {
  version: string
  profileId: PiProfileId
  accountType: string
  /** GitHub login; omitted when setup never resolved it. */
  login?: string
  copilotVersion?: string
  vsCodeVersion?: string
  lead: string
  modelCount: number
  peers: boolean
  helpers: boolean
  ui: boolean
  swe: boolean
  search: boolean
  browse: boolean
  serverUrl: string
}

/**
 * One elegant three-line launch summary for the `pi` preamble,
 * written directly to stderr (no reporter icons or timestamps).
 * Missing facts are omitted, never printed as blanks — a first run
 * that never resolved versions still renders cleanly.
 */
export function buildPiLaunchCard(opts: PiLaunchCardOpts): string {
  const surface: Array<string> = []
  surface.push(opts.peers ? "peers" : "peerless")
  if (opts.peers && opts.helpers) surface.push("helpers")
  if (opts.ui) surface.push("ui")
  if (opts.swe) surface.push("swe")
  if (opts.search) surface.push("search")
  if (opts.browse) surface.push("browse")
  const identity = [
    opts.accountType,
    opts.login,
    opts.copilotVersion ? `copilot chat ${opts.copilotVersion}` : undefined,
    opts.vsCodeVersion ? `vscode ${opts.vsCodeVersion}` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0)
  return [
    `github-router v${opts.version} · pi (${opts.profileId})`,
    `  ${identity.join(" · ")}`,
    `  lead ${opts.lead} · ${opts.modelCount} models · ${surface.join(" ")} · ${opts.serverUrl}`,
  ].join("\n")
}

/**
 * Short operating digest appended to APPEND_SYSTEM.md (prompt-cache-stable).
 * Mode identity — always injected. Peer consult sentences drop out under
 * `peers: false` so the digest never names tools that don't exist.
 */
export function buildPiAppendSystem(
  profileId: PiProfileId,
  opts: { peers?: boolean } = {},
): string {
  const peers = opts.peers !== false;
  const advisor = peers ? piAdvisorModel(profileId) : undefined;
  const lines = [
    `# gh-router ${profileId} mode`,
    "",
    `- Lead owns planning directly; there is no Plan subagent.`,
  ];
  if (peers) {
    lines.push(
      `- Delegate FREELY to Explore for discovery and General-Purpose for scoped work.`,
      `- Call subagent directly (agent + task); save workflows for genuinely parallel fanout.`,
      profileId === "balanced"
        ? `- Send work to reviewer ONLY when the change alters behavior.`
        : `- Send finished work to reviewer for assessment.`,
      `- Ask oracle for a second opinion when the decision itself feels risky.`,
      advisor
        ? `- Review the final plan with advisor (advisory) before presenting it.`
        : `- There is no advisor in this mode: oracle is the only consultant.`,
      `- Verify, don't vote: consultant verdicts never substitute for running the tests.`,
      `- After any subagent work completes, always write the final answer yourself.`,
    );
  } else {
    lines.push(
      `- Peerless launch: no subagents or consultants in this session; plan, implement, and verify directly.`,
    );
  }
  lines.push("", `(${PI_MIN_VERSION_NOTE})`, "");
  return lines.join("\n");
}
