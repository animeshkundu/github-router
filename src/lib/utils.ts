import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getCopilotChatVersion } from "~/services/get-copilot-version"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

/**
 * Beta prefixes VS Code Copilot Chat v0.43 actually sends.
 * Default mode — makes proxy traffic indistinguishable from VS Code.
 */
const VSCODE_BETA_PREFIXES = [
  "interleaved-thinking-",
  "context-management-",
  "advanced-tool-use-",
]

/**
 * Extended beta prefixes for Claude CLI compatibility.
 * Enabled via --extended-betas flag. Includes all betas confirmed
 * to work with the Copilot API.
 *
 * Notably absent (Copilot 400s on these — verified live):
 *   context-1m-, skills-, files-api-, code-execution-, output-128k-,
 *   advisor-tool- (see EXPLICITLY_STRIPPED_BETA_PREFIXES below).
 * 1M context is unlocked by selecting `claude-opus-4.7-1m-internal`
 * as the model id, not via a beta header.
 *
 * Empirical verification (2026-05-11 against api.enterprise.githubcopilot.com):
 *   task-budgets-2026-03-13          → 200 ACCEPTED (cost-ceiling leverage)
 *   token-efficient-tools-2026-03-28 → 200 ACCEPTED (per-tool token saving)
 *   summarize-connector-text-2026-03-13 → 200 (Anthropic-internal feature flag,
 *     won't fire for non-ant users; allowlisted defensively for ant edge case)
 *   afk-mode-2026-01-31              → 200 (Anthropic-internal feature flag)
 *   cli-internal-2026-02-09          → 200 (USER_TYPE=ant only)
 *   oauth-2025-04-20                 → 200 (Files-API path; Files-API itself
 *     is not supportable via Copilot, but the header alone is harmless)
 *   prompt-caching-scope-2026-01-05  → 200 even with body cache_control.scope
 *     stripped (already covered by `prompt-caching-` prefix above)
 */
const EXTENDED_BETA_PREFIXES = [
  ...VSCODE_BETA_PREFIXES,
  "claude-code-",
  "effort-",
  "prompt-caching-",
  "computer-use-",
  "pdfs-",
  "max-tokens-",
  "token-counting-",
  "compact-",
  "structured-outputs-",
  "fast-mode-",
  "mcp-client-",
  "mcp-servers-",
  "redact-thinking-",
  "web-search-",
  // Empirically accepted by Copilot, sent by Claude Code v2.1.138+
  "task-budgets-",
  "token-efficient-tools-",
  // Anthropic-internal feature flags (won't reach proxy from non-ant users
  // due to Bun build-time dead-code elimination, but allowlisted so the rare
  // ant-user / managed-deployment case flows cleanly).
  "summarize-connector-text-",
  "afk-mode-",
  "cli-internal-",
  "oauth-",
]

/**
 * Beta prefixes the proxy explicitly STRIPS even from the extended
 * allowlist (and even if a future leverage mode broadens the allowlist
 * further). Defensive layer: today's allowlist-only filter would already
 * drop these because they're not in any allowlist, but keeping an
 * explicit deny-list catches future changes that broaden allow rules
 * (e.g. a hypothetical pattern-based mode that lets `claude-*` through).
 *
 * Empirical (2026-05-11): Copilot returns HTTP 400
 *   `unsupported beta header(s): advisor-tool-2026-03-01`
 * on every request that includes `advisor-tool-`. Stripping it is the
 * difference between a working request (no ADVISOR semantics) and a
 * fully-failed request. Document upstream limitation in CLAUDE.md.
 */
const EXPLICITLY_STRIPPED_BETA_PREFIXES = [
  "advisor-tool-",
] as const

/**
 * Filter an `anthropic-beta` header value, keeping only beta flags
 * in the active whitelist AND not in the explicit-strip list.
 * Uses extended prefixes when --extended-betas is enabled, VS Code-only
 * prefixes otherwise. Returns the filtered comma-separated string,
 * or undefined if nothing remains.
 */
export function filterBetaHeader(value: string): string | undefined {
  const prefixes = state.extendedBetas
    ? EXTENDED_BETA_PREFIXES
    : VSCODE_BETA_PREFIXES
  const filtered = value
    .split(",")
    .map((v) => v.trim())
    .filter(
      (v) =>
        v
        && prefixes.some((prefix) => v.startsWith(prefix))
        && !EXPLICITLY_STRIPPED_BETA_PREFIXES.some((p) => v.startsWith(p)),
    )
    .join(",")
  return filtered || undefined
}

/**
 * Normalize a model ID for fuzzy comparison: lowercase, replace dots with
 * dashes, insert dash at letter→digit boundaries, and collapse repeated
 * dashes. E.g. "gpt5.3-codex" → "gpt-5-3-codex", "GPT-5.3-Codex" → "gpt-5-3-codex".
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(/-{2,}/g, "-")
}

/**
 * Resolve a model name to the best available variant in the Copilot model list.
 *
 * Resolution cascade:
 * 0. `[1m]` literal-bracket suffix: strip, delegate, warn if downgraded.
 *    Bracketed slug must never reach Copilot (400s on it). See cc-backup
 *    `src/utils/context.ts:35-40` for Claude Code's 1M unlock mechanism.
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Family preference (opus→1m, codex→highest version)
 * 4. Normalized match (dots→dashes, letter-digit boundaries)
 * 5. Anthropic dated-slug retry: if the input matches `claude-...-YYYYMMDD`,
 *    strip the date and re-run the cascade once. Family-guarded so non-claude
 *    8-digit suffixes can't be mis-stripped; runs after Steps 1-4 so explicit
 *    version pinning (a dated catalog id matched at Step 1) always wins.
 * 6. Return as-is with a warning
 */
export function resolveModel(modelId: string): string {
  const models = state.models?.data
  if (!models) return modelId

  // [1m] literal-bracket suffix: Claude Code's request for 1M context
  // accounting. cc-backup `src/utils/context.ts:35-40` has1mContext
  // matches `/\[1m\]/i`; getContextWindowForModel returns 1_000_000
  // when true. parseUserSpecifiedModel (model.ts:445-506) reattaches
  // the bracket after alias resolution, so Claude Code SENDS the
  // bracketed slug verbatim on the wire (`model: "claude-opus-4-7[1m]"`).
  // Copilot doesn't recognize the bracket → 400.
  //
  // Strip for the catalog lookup and delegate. If the stripped
  // resolution lands on a `-1m` variant (enterprise opus path via
  // family preference), perfect — the upstream call routes to the 1M
  // backend and Claude Code's local accounting was right. Otherwise
  // (non-enterprise for opus, or any [1m] on sonnet/haiku where
  // Copilot has no -1m backend), warn and return the 200K resolution
  // so the request still succeeds — at the cost of Claude Code
  // over-accounting context against the proxy (it will compact early
  // because it thinks the window is 1M).
  //
  // Bounded recursion: the stripped form no longer matches the regex,
  // so the inner resolveModel call cannot re-enter this branch.
  const oneMMatch = modelId.match(/^(.*)\[1m\]$/i)
  if (oneMMatch) {
    const stripped = oneMMatch[1]
    const resolved = resolveModel(stripped)
    if (!/-1m(?:$|-)/.test(resolved)) {
      consola.warn(
        `Model "${modelId}" requested 1M context but no -1m backend is in Copilot's catalog for this tier/family; downgrading upstream to "${resolved}" (200K). Claude Code's local context accounting will still assume 1M — expect premature auto-compact. Drop the [1m] suffix (or unset CLAUDE_CODE_DISABLE_1M_CONTEXT if you set it) to silence.`,
      )
    }
    return resolved
  }

  // 1. Exact match
  if (models.some((m) => m.id === modelId)) return modelId

  // 2. Case-insensitive match
  const lower = modelId.toLowerCase()
  const ciMatch = models.find((m) => m.id.toLowerCase() === lower)
  if (ciMatch) return ciMatch.id

  // 3. Family preference — before normalization so product aliases
  //    (opus→1m, codex→latest) take priority over fuzzy matches
  if (lower.includes("opus")) {
    // Match ...-1m or ...-1m-<anything> (e.g. claude-opus-4.7-1m-internal).
    // Prefer the 1M variant whose major.minor matches the requested version,
    // otherwise find() would silently downgrade claude-opus-4.7 to a
    // claude-opus-4.6-1m if the latter happens to come first in the list.
    // Accept both dotted ("opus-4.7") and dashed ("opus-4-7") inputs —
    // Claude Code historically sends the dashed form.
    const oneMs = models.filter(
      (m) => m.id.includes("opus") && /-1m(?:$|-)/.test(m.id),
    )
    const versionMatch = lower.match(/opus-(\d+)[.-](\d+)/)
    const requestedVersion =
      versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : undefined
    const preferred = requestedVersion
      ? oneMs.find((m) => m.id.includes(`opus-${requestedVersion}-`))
      : undefined
    const oneM = preferred ?? oneMs[0]
    if (oneM) return oneM.id
  }

  if (lower.includes("codex")) {
    const codexModels = models.filter(
      (m) => m.id.includes("codex") && !m.id.includes("mini"),
    )
    if (codexModels.length > 0) {
      codexModels.sort((a, b) => b.id.localeCompare(a.id))
      return codexModels[0].id
    }
  }

  // 4. Normalized match (dots → dashes, letter-digit boundaries)
  const normalized = normalizeModelId(modelId)
  const normMatch = models.find(
    (m) => normalizeModelId(m.id) === normalized,
  )
  if (normMatch) return normMatch.id

  // 5. Anthropic dated-slug retry. Claude Code's /model UI ships Anthropic's
  //    published slugs (e.g. "claude-haiku-4-5-20251001") that carry a
  //    -YYYYMMDD suffix Copilot's catalog doesn't use. Strip the date and
  //    re-run the cascade once so the request maps to the floating tag
  //    (claude-haiku-4.5). Family-guarded to `claude-` so a hypothetical
  //    "gpt-...-20260101" can't be silently stripped. Bounded recursion:
  //    the stripped id no longer matches the regex, so the retry's own
  //    Step 5 is a no-op.
  const dateStripped = modelId.replace(/^(claude-[\w.-]+)-20\d{6}$/i, "$1")
  if (dateStripped !== modelId) {
    const retried = resolveModel(dateStripped)
    // resolveModel returns the input unchanged on miss; treat unchanged-and-
    // not-in-catalog as miss to avoid logging a misleading "resolved" hop.
    const retryHit =
      retried !== dateStripped || models.some((m) => m.id === dateStripped)
    if (retryHit) {
      consola.info(
        `Resolved Anthropic dated slug "${modelId}" → "${retried}" (stripped -YYYYMMDD; pass an explicit catalog id to pin a snapshot)`,
      )
      return retried
    }
  }

  // 6. Legacy family fallback. Claude Code's settings.json may pin slugs
  //    whose Copilot equivalent does not exist (e.g. claude-3-7-sonnet-20250219
  //    or claude-sonnet-4-0 — neither is in Copilot's enterprise catalog as
  //    of 2026-05-11; a request for either returns HTTP 400 "model not
  //    supported"). Step 5's dated-retry strips the date but the resulting
  //    "claude-3-7-sonnet" still has no Copilot equivalent. Rather than
  //    dead-end the request, fall back to the highest available family
  //    member (sonnet → highest sonnet, haiku → highest haiku). Surfaces
  //    via consola.info so the user sees the substitution. Opus is already
  //    handled by the family preference in Step 3.
  //
  //    Guards (codex-reviewer findings):
  //      (a) Family fires only for `claude-` prefixed inputs — protects
  //          against custom-sonnet-future or any non-Anthropic provider
  //          coincidentally containing "sonnet"/"haiku" in its slug.
  //      (b) Family token must be word-bounded (`-sonnet-` / `-sonnet$`)
  //          so a hypothetical claude-supersonnet-* doesn't match.
  //      (c) Sort uses numeric collation (`{numeric: true}`) so a future
  //          claude-sonnet-4.10 sorts higher than claude-sonnet-4.6
  //          (lexicographic alone would invert).
  if (lower.startsWith("claude-")) {
    const matchSonnet = /(?:^|-)sonnet(?:-|$)/.test(lower)
    const matchHaiku = /(?:^|-)haiku(?:-|$)/.test(lower)
    if (matchSonnet || matchHaiku) {
      const family = matchSonnet ? "sonnet" : "haiku"
      const familyMembers = models.filter((m) =>
        new RegExp(`(?:^|-)${family}(?:-|$|\\.)`).test(m.id),
      )
      if (familyMembers.length > 0) {
        familyMembers.sort((a, b) =>
          b.id.localeCompare(a.id, undefined, { numeric: true }),
        )
        const best = familyMembers[0].id
        consola.info(
          `Model "${modelId}" not in Copilot catalog; falling back to highest available "${best}" (legacy ${family} slug). Pin a current catalog id to silence.`,
        )
        return best
      }
    }
  }

  // 7. No match — warn and return as-is
  consola.warn(
    `Model "${modelId}" not found in Copilot model list. Available: ${models.map((m) => m.id).join(", ")}`,
  )
  return modelId
}

/**
 * Resolve a codex model ID, falling back to the best available codex model.
 * Used by the codex subcommand for model selection.
 */
export function resolveCodexModel(modelId: string): string {
  const resolved = resolveModel(modelId)
  const models = state.models?.data
  if (!models) return resolved

  // Check if the resolved model exists in the model list
  if (models.some((m) => m.id === resolved)) return resolved

  // Fall back to the best available codex-class model. The /responses
  // endpoint is the discriminator — gpt-5.5 dropped the -codex suffix but
  // still routes through /responses. Prefer explicit -codex ids when both
  // exist, otherwise pick the highest version-like id.
  const candidates = models.filter((m) => {
    const endpoints = m.supported_endpoints ?? []
    if (m.id.includes("mini") || m.id.includes("nano")) return false
    return endpoints.length === 0 || endpoints.includes("/responses")
  })

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const aCodex = a.id.includes("codex") ? 1 : 0
      const bCodex = b.id.includes("codex") ? 1 : 0
      if (aCodex !== bCodex) return bCodex - aCodex
      return b.id.localeCompare(a.id)
    })
    const best = candidates[0].id
    consola.warn(`Model "${modelId}" not available, using "${best}" instead`)
    return best
  }

  return resolved
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

export const cacheCopilotVersion = async () => {
  const version = await getCopilotChatVersion()
  state.copilotVersion = version

  consola.info(`Using Copilot Chat version: ${version}`)
}
