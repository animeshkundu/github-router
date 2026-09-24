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
 * Fallback Pi window (tokens) when a model has no pinned cheap-tier
 * threshold. Per-model rows use `piContextWindowFor` (tier threshold);
 * this constant remains the floor no role drops below.
 */
export const PI_PROFILE_CONTEXT_TOKENS = 200_000 as const
/** Provider key used in models.json and agent `provider/model` references. */
export const PI_PROVIDER_NAME = "gh-router" as const

const PI_MIN_VERSION_NOTE = "Requires Pi >= 0.80.10 and Node >= 22.19."

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
        /** Per-model API override (documented Pi capability) for a
         *  future chat-served model on this provider. Omitted when it
         *  matches the provider default. */
        api?: PiModelApi
      }>
    }
  >
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
 *
 * Every row is BARE (no `[1m]`) with its cheap-tier window from
 * `piContextWindowFor` (272K Luna/Sol, 200K Grok/unknown): Pi budgets
 * `contextWindow` per model, so each role gets its cheapest tier and
 * Long-tier (2x) pricing is structurally unreachable.
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
          const override = opts.apiOverrides?.[id]
          return {
            id,
            name: id,
            reasoning: true as const,
            input: ["text"],
            contextWindow: piContextWindowFor(id, entry?.maxContextTokens),
            maxTokens,
            ...(entry?.cost ? { cost: entry.cost } : {}),
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
  retry: { enabled: boolean; maxRetries: number }
  packages: Array<PiPackageEntry>
}

/**
 * Build the per-launch `settings.json`. Additive over the snapshotted
 * user settings (the launcher merges lists it owns): narrow model
 * scope, fixed thinking, limited toolset, derived compaction, and the
 * mode's package slice. Never disables retry/transport hardening.
 *
 * `pi-subagents` rides `peersEnabled` and loads extensions ONLY
 * (skills/prompts filtered out — the mode's own skills/prompts cover
 * the roster, so the third-party sets never reach Ctrl+O).
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
}): PiSettingsJson {
  const peers = opts.peers !== false
  const modelIds = piProfileModelIds(opts.profileId, { peers })
  return {
    defaultProvider: PI_PROVIDER_NAME,
    defaultModel: piLeadModel(opts.profileId),
    defaultThinkingLevel: piLeadThinking(opts.profileId),
    enabledModels: modelIds.map((id) => `${PI_PROVIDER_NAME}/${id}`),
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    compaction: derivePiCompactionSettings(opts.catalog, modelIds),
    retry: { enabled: true, maxRetries: 3 },
    packages: [
      ...(peers
        ? [{ source: "npm:pi-subagents", skills: [], prompts: [] } as PiPackageEntry]
        : []),
      "local:gh-router-pi",
    ],
  }
}

function agentFileName(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`
}

function roleDescription(
  profileId: PiProfileId,
  role: PiNativeRole,
): string {
  const oracleNote =
    "For risky decisions, ask the oracle subagent for a second opinion before acting.";
  if (role.name === "Explore") {
    return `Fast read-only recon: locate code, answer evidence questions, return compressed context. ${oracleNote}`
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
 * consume (`name/description/tools/model/thinking/max_turns`, plus
 * `allowedAgents` where the delegation graph has an edge). Bodies are
 * short execution contracts; workflow prose lives in skills so agent
 * files stay small enough to inline cheaply.
 */
export function buildPiAgentFiles(
  profileId: PiProfileId,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const role of piNativeRoles(profileId)) {
    const tools =
      role.name === "General-Purpose"
        ? "[read, bash, edit, write, grep, find, ls]"
        : "[read, grep, find, ls]";
    const lines = [
      "---",
      `name: ${role.name}`,
      `description: ${roleDescription(profileId, role)}`,
      `tools: ${tools}`,
      `model: ${PI_PROVIDER_NAME}/${role.model}`,
      `thinking: ${role.thinking}`,
      "max_turns: 80",
    ];
    if (profileId === "balanced" && role.name === "reviewer") {
      lines.push("allowedAgents: [Explore]");
    }
    if (role.name === "General-Purpose") {
      lines.push("allowedAgents: [reviewer]");
    }
    lines.push("---", "");
    if (role.name === "Explore") {
      lines.push(
        "You are a read-only scout. Never modify files. Search first, read second,",
        "return the smallest sufficient evidence: file paths, line spans, and short quotes.",
      );
    } else if (role.name === "reviewer") {
      lines.push(
        "You review a change that already exists. Reproduce failures before diagnosing.",
        "Report findings with file:line references; do not rewrite code outside small,",
        "clearly-marked suggestions.",
      );
    } else {
      lines.push(
        "You implement the scoped task and verify it (run the relevant tests).",
        "Hand behavior-changing results to reviewer when asked; otherwise summarize",
        "the diff and how it was verified.",
      );
    }
    files[`agents/${agentFileName(role.name)}`] = `${lines.join("\n")}\n`;
  }
  // Oracle consultant agent (both modes). Advisory only: challenges
  // assumptions, never edits.
  const oracle = [
    "---",
    "name: oracle",
    `description: Second opinion before acting. Challenges assumptions without editing. Use when the decision itself feels risky.`,
    "tools: [read, grep, find, ls]",
    `model: ${PI_PROVIDER_NAME}/${piOracleModel(profileId)}`,
    `thinking: ${piOracleThinking(profileId)}`,
    "max_turns: 40",
    "---",
    "",
    "You are an oracle: a second set of eyes. You see only the task context",
    "you are given — you have no repo memory beyond what you read now.",
    "Challenge assumptions, name what is missing, recommend; never execute.",
  ].join("\n");
  files[`agents/${agentFileName("oracle")}`] = `${oracle}\n`;
  // Advisor agent (cheapest only). Balanced stays advisor-free: no file,
  // no skill, no prompt, no prose — asserted by tests.
  const advisor = piAdvisorModel(profileId);
  if (advisor) {
    const body = [
      "---",
      "name: advisor",
      `description: Advisory plan review for the lead: review the final plan before it is presented. Never executes.`,
      "tools: [read, grep, find, ls]",
      `model: ${PI_PROVIDER_NAME}/${advisor.model}`,
      `thinking: ${advisor.thinking}`,
      "max_turns: 40",
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
      profileId === "balanced"
        ? `- Send work to reviewer ONLY when the change alters behavior.`
        : `- Send finished work to reviewer for assessment.`,
      `- Ask oracle for a second opinion when the decision itself feels risky.`,
      advisor
        ? `- Review the final plan with advisor (advisory) before presenting it.`
        : `- There is no advisor in this mode: oracle is the only consultant.`,
      `- Verify, don't vote: consultant verdicts never substitute for running the tests.`,
    );
  } else {
    lines.push(
      `- Peerless launch: no subagents or consultants in this session; plan, implement, and verify directly.`,
    );
  }
  lines.push("", `(${PI_MIN_VERSION_NOTE})`, "");
  return lines.join("\n");
}
