/**
 * Cheapest-only Sol → Luna prompt rewrite (additive, fail-open).
 *
 * The cheapest lead (`gpt-6-luna`) is the mini-tier analog: it follows
 * explicit, short, structured briefs far better than vague prompts (see the
 * OpenAI GPT-4.1 / GPT-5-mini prompting guides). This module is the pure
 * decision + formatting layer for that rewrite. It never touches the network
 * itself: all IO is injected so tests run with fakes and no Copilot spend.
 *
 * Design (per researched plan):
 *   - cheapest profile only, initial top-level prompt only, non-trivial only
 *     (caller passes the `isNonTrivialPrompt` verdict in — this module does
 *     not import the hook to avoid a dependency cycle).
 *   - static context pack first (user prompt + AGENTS.md/CLAUDE.md + repo
 *     structure + search snippets), all capped for cache-friendliness.
 *   - rewriter is `gpt-5.6-sol` bare 200K at medium effort (the existing
 *     cheapest Advisor identity), via the caller's `inferSol`.
 *   - adaptive turn budget: 3 tool turns by default, up to 5 only when Sol
 *     self-flags deep grounding. Sol is told the budget and may use zero
 *     tools and rewrite immediately.
 *   - output is an ADDITIVE advisory brief for Luna; the original prompt is
 *     never replaced. Empty/error/timeout yields null and the caller falls
 *     back to the existing V2 scope/goal path.
 */

export const CHEAPEST_REWRITE_MODEL = "gpt-5.6-sol" as const
export const CHEAPEST_REWRITE_EFFORT = "medium" as const

/** Default tool-turn budget for ordinary non-trivial prompts. */
export const CHEAPEST_REWRITE_DEFAULT_TURNS = 3
/** Extended budget reserved for the hardest prompts (Sol must flag it). */
export const CHEAPEST_REWRITE_MAX_TURNS = 5

/** Wall-clock budget for the whole rewrite (search + Sol), ms. */
export const CHEAPEST_REWRITE_TIMEOUT_MS = 20_000
/** Max chars per search-result blob fed to Sol. */
export const CHEAPEST_REWRITE_SEARCH_CAP = 6 * 1024
/** Max chars of repo guidance files (AGENTS.md / CLAUDE.md) fed to Sol. */
export const CHEAPEST_REWRITE_GUIDANCE_CAP = 4 * 1024
/** Max chars of structural repo info fed to Sol. */
export const CHEAPEST_REWRITE_STRUCTURE_CAP = 2 * 1024
/** Max chars of the wrapped Luna brief (keeps Luna-facing brief short). */
export const CHEAPEST_REWRITE_BRIEF_CAP = 2_000

/** Flag Sol emits when it needs the extended 5-turn budget. */
export const DEEP_GROUNDING_FLAG = "needs_deep_grounding=true" as const
/** Follow-up signal: Sol names one more targeted query to ground. */
export const NEED_MORE_PREFIX = "NEED_MORE:" as const

export interface CheapestRewriteEligibility {
  /** Launch profile id (only `"cheapest"` is eligible). */
  profile?: string
  /** Caller-computed `isNonTrivialPrompt(prompt)` verdict (regex, zero cost). */
  promptIsNonTrivial: boolean
  /** Master steer switch already resolved (false = findings only). */
  steerEnabled: boolean
  /** True when `GH_ROUTER_DISABLE_CHEAPEST_REWRITE` opts out. */
  rewriteDisabled: boolean
}

export function isCheapestRewriteDisabledEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GH_ROUTER_DISABLE_CHEAPEST_REWRITE ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function isCheapestRewriteEligible(input: CheapestRewriteEligibility): boolean {
  if (!input.steerEnabled) return false
  if (input.rewriteDisabled) return false
  if (input.profile !== "cheapest") return false
  return input.promptIsNonTrivial
}

/** Adaptive budget: 5 only on Sol's explicit deep-grounding flag, else 3. */
export function resolveRewriteTurnBudget(solText: string | null | undefined): number {
  if (typeof solText === "string" && solText.includes(DEEP_GROUNDING_FLAG)) {
    return CHEAPEST_REWRITE_MAX_TURNS
  }
  return CHEAPEST_REWRITE_DEFAULT_TURNS
}

/** Extract a single follow-up query Sol names via `NEED_MORE: <query>. */
export function parseNeedMoreQuery(solText: string): string {
  const idx = solText.indexOf(NEED_MORE_PREFIX)
  if (idx < 0) return ""
  return solText
    .slice(idx + NEED_MORE_PREFIX.length)
    .split("\n", 1)[0]
    ?.trim()
    .slice(0, 280) ?? ""
}

/**
 * System prompt for the Sol rewriter. Names the turn budget explicitly so
 * Sol knows what it is doing, how many turns it has, that zero-tool
 * immediate rewrite is allowed, and that the output serves Luna (mini-tier:
 * explicit, short, flat, outcome-first with stop rules).
 */
export function buildSolRewriteSystem(opts: {
  searchEnabled: boolean
  bluebirdEnabled: boolean
  turnBudget: number
}): string {
  const searchNoun = opts.bluebirdEnabled
    ? "Bluebird lexical + semantic code search"
    : opts.searchEnabled
      ? "local lexical + semantic code search"
      : "lexical code search"
  return (
    `You are a prompt-rewriting advisor for a coding agent. A cheap mini-tier model (Luna) `
    + `will execute the user's request. Your job is to rewrite it into a SHORT structured brief that lets Luna do its best work.\n`
    + `Turn budget: you have at most ${opts.turnBudget} tool turns TOTAL (search/read). You may use ZERO tools and rewrite immediately when the static context already suffices — do not pad turns. `
    + `If the task is large/cross-cutting and the context is genuinely insufficient, you may emit "${DEEP_GROUNDING_FLAG}" plus one line "${NEED_MORE_PREFIX} <single targeted query>" to earn follow-up grounding; otherwise finish now.\n`
    + `Grounding available: ${searchNoun} results, repo guidance (AGENTS.md/CLAUDE.md), and repo structure are in your context. Prefer targeted reads over full-file reads.\n`
    + `Rules for the brief (tuned for a mini-tier executor):\n`
    + `1. Outcome-first: state the user's OWN goal as one measurable objective, in their terms. Do NOT invent new requirements or acceptance criteria.\n`
    + `2. Explicit + literal: flat numbered steps in order; front-load the key constraints; no nested hierarchies; no contradictory instructions.\n`
    + `3. Tool rules: lexical search first (exact symbols/files/errors, zero model cost), semantic second for intent drift, Explore only when search is insufficient.\n`
    + `4. Scope: name the files/symbols in play with file:line when known, or state the gap explicitly — never guess.\n`
    + `5. Stop rules: when Luna is done, what check settles it (build/test/read), and when to ask vs proceed.\n`
    + `6. Keep it SHORT (under ~300 words). Respond with the brief body only, no preamble.`
  )
}

export interface StaticContextPack {
  prompt: string
  agentsMd: string
  claudeMd: string
  repoStructure: string
  searchContext: string
}

/** Assemble the capped static pack Sol sees (static-first for cache hits). */
export function buildStaticContextPack(pack: StaticContextPack): string {
  const parts: Array<string> = [`USER REQUEST:\n${pack.prompt}`]
  if (pack.agentsMd.trim().length > 0) {
    parts.push(`REPO GUIDANCE (AGENTS.md):\n${pack.agentsMd.slice(0, CHEAPEST_REWRITE_GUIDANCE_CAP)}`)
  }
  if (pack.claudeMd.trim().length > 0) {
    parts.push(`REPO GUIDANCE (CLAUDE.md):\n${pack.claudeMd.slice(0, CHEAPEST_REWRITE_GUIDANCE_CAP)}`)
  }
  if (pack.repoStructure.trim().length > 0) {
    parts.push(`REPO STRUCTURE:\n${pack.repoStructure.slice(0, CHEAPEST_REWRITE_STRUCTURE_CAP)}`)
  }
  if (pack.searchContext.trim().length > 0) {
    parts.push(pack.searchContext)
  }
  return parts.join("\n\n")
}

/**
 * Wrap Sol's raw brief as the additive Luna-facing block. Returns "" when
 * Sol produced nothing usable (caller treats that as fail-open).
 */
export function wrapLunaBrief(solText: string): string {
  const body = solText
    .replace(DEEP_GROUNDING_FLAG, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(NEED_MORE_PREFIX))
    .join("\n")
    .trim()
  if (body.length === 0) return ""
  const capped = body.length > CHEAPEST_REWRITE_BRIEF_CAP
    ? `${body.slice(0, CHEAPEST_REWRITE_BRIEF_CAP).trimEnd()}…`
    : body
  return (
    `LUNA BRIEF (advisory, additive — the original request above still stands):\n${capped}`
  )
}

export interface CheapestRewriteIO {
  /** One `mcp__search__code` call; returns raw result text ("" on failure). */
  searchCode: (query: string, mode: "lexical" | "semantic", signal?: AbortSignal) => Promise<string>
  /** One Sol `/v1/responses` inference at medium effort; returns text ("" on failure). */
  inferSol: (system: string, user: string, signal?: AbortSignal) => Promise<string>
  /** Static repo guidance + structure (read by the caller via fs, capped). */
  staticPack: () => Promise<Omit<StaticContextPack, "prompt" | "searchContext">>
  /** One-shot flag: true when this session already spent its rewrite. */
  hasRewriteRun: (sessionId: string) => Promise<boolean>
  /** Record the spend (attempt-marking: called before running). Idempotent. */
  markRewriteRun: (sessionId: string) => Promise<void>
  /** Wall-clock budget for search + Sol (default 20s). */
  timeoutMs?: number
}

/**
 * Run the adaptive rewrite. Returns the wrapped Luna brief, or null when
 * anything is missing/empty/over-budget so the caller falls back to the
 * existing V2 scope/goal path. Never throws to the orchestrator.
 */
export async function runCheapestRewrite(input: {
  prompt: string
  searchEnabled: boolean
  bluebirdEnabled: boolean
  io: CheapestRewriteIO
}): Promise<string | null> {
  const timeoutMs = input.io.timeoutMs ?? CHEAPEST_REWRITE_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async (): Promise<string | null> => {
      const semanticAvailable = input.searchEnabled || input.bluebirdEnabled
      const [lexical, semantic, statik] = await Promise.all([
        input.io.searchCode(input.prompt, "lexical", controller.signal).catch(() => ""),
        semanticAvailable
          ? input.io.searchCode(input.prompt, "semantic", controller.signal).catch(() => "")
          : Promise.resolve(""),
        input.io.staticPack().catch(() => ({ agentsMd: "", claudeMd: "", repoStructure: "" })),
      ])
      const searchContext = semanticAvailable
        ? `Lexical search results:\n${lexical.slice(0, CHEAPEST_REWRITE_SEARCH_CAP)}\n\nSemantic search results:\n${semantic.slice(0, CHEAPEST_REWRITE_SEARCH_CAP)}`
        : `Lexical search results:\n${lexical.slice(0, CHEAPEST_REWRITE_SEARCH_CAP)}`
      const user = buildStaticContextPack({
        prompt: input.prompt,
        agentsMd: statik.agentsMd,
        claudeMd: statik.claudeMd,
        repoStructure: statik.repoStructure,
        searchContext,
      })
      const first = await input.io
        .inferSol(
          buildSolRewriteSystem({
            searchEnabled: input.searchEnabled,
            bluebirdEnabled: input.bluebirdEnabled,
            turnBudget: CHEAPEST_REWRITE_DEFAULT_TURNS,
          }),
          user,
          controller.signal,
        )
        .catch(() => "")
      if (!first || first.trim().length === 0) return null

      // Adaptive extension: only when Sol flags deep grounding AND names a
      // follow-up query AND turns remain (3 used → up to 5). One extra
      // grounding round + one final re-inference, then stop regardless.
      const budget = resolveRewriteTurnBudget(first)
      const followUp = parseNeedMoreQuery(first)
      if (budget !== CHEAPEST_REWRITE_MAX_TURNS || followUp.length === 0) {
        const brief = wrapLunaBrief(first)
        return brief.length > 0 ? brief : null
      }
      const extra = await input.io.searchCode(followUp, "lexical", controller.signal).catch(() => "")
      if (extra.trim().length === 0) {
        const brief = wrapLunaBrief(first)
        return brief.length > 0 ? brief : null
      }
      const second = await input.io
        .inferSol(
          buildSolRewriteSystem({
            searchEnabled: input.searchEnabled,
            bluebirdEnabled: input.bluebirdEnabled,
            turnBudget: CHEAPEST_REWRITE_MAX_TURNS,
          }),
          `${user}\n\nFOLLOW-UP GROUNDING for "${followUp}":\n${extra.slice(0, CHEAPEST_REWRITE_SEARCH_CAP)}\n\nRewrite the brief with this grounding (same rules, short).`,
          controller.signal,
        )
        .catch(() => "")
      const brief = wrapLunaBrief(second.trim().length > 0 ? second : first)
      return brief.length > 0 ? brief : null
    })()
    work.catch(() => {})
    const raced = await Promise.race<string | null | "__timeout__">([
      work,
      new Promise<"__timeout__">((resolve) => {
        timer = setTimeout(() => resolve("__timeout__"), timeoutMs)
      }),
    ])
    if (raced === "__timeout__" || raced === null) return null
    return raced
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}
