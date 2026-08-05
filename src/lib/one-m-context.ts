import { state } from "./state"

/**
 * Context-window threshold at which Claude Code's `[1m]` accounting unlock is
 * worth requesting. Shared by `pickClaudeDefault` (`./port`), the gateway
 * picker-row seed (`./server-setup`), and the native-subagent frontmatter
 * builder (`./codex-mcp-config`) so the three cannot drift apart.
 */
export const ONE_M_TOKENS = 1_000_000

/**
 * Whether the live Copilot catalog advertises a >=1M context window for this
 * exact model id.
 *
 * Exact-id match only — no slug translation, no family inference. Every caller
 * already holds a concrete catalog id (the seeded picker rows and the resolved
 * per-agent models both come from a catalog walk), and an inferred match could
 * silently attach `[1m]` to a sibling that does not serve 1M. `pickClaudeDefault`
 * keeps its own version-anchored regex scan because it resolves a FAMILY
 * (`opus-4.7` may ship as a `-1m` sibling slug), which is a different question.
 *
 * Returns false when the catalog is unavailable, so a thin or not-yet-populated
 * catalog degrades to bare ids (Claude Code then accounts at its 200K default —
 * under-accounting, never overflow).
 */
export function catalogAdvertises1M(id: string): boolean {
  const models = state.models?.data
  if (!models) return false
  const found = models.find((m) => m.id === id)
  return (found?.capabilities?.limits?.max_context_window_tokens ?? 0) >= ONE_M_TOKENS
}

/**
 * True when the user has opted out of 1M context accounting (HIPAA and similar
 * data-retention regimes).
 *
 * Deliberately PRESENCE-based rather than parsed as a boolean, because this
 * mirrors Claude Code's own gate verbatim — its `has1mContext` helper is
 * `if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) return false` over a raw env
 * read, so a literal `"0"` disables 1M there. Parsing it as a boolean here would
 * make the proxy attach a bracket that Claude Code then ignores: the decoration
 * and the accounting must agree in every case, so we match the quirk instead of
 * fixing it on one side only. An empty string is falsy in both.
 */
function oneMContextDisabled(): boolean {
  return (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT ?? "") !== ""
}

/**
 * Decorate a model id with the `[1m]` literal-bracket suffix iff the catalog
 * says the model serves >=1M context and the user has not opted out.
 *
 * The bracket is Claude Code's local context-accounting unlock. Its detector is
 * `/\[1m\]/i` applied to the model id with NO vendor gate, so it works for the
 * non-Claude gateway models exactly as it does for Opus — verified against the
 * installed 2.1.222 build, where the window resolver returns `1e6` on a bracket
 * match and otherwise falls through to a 200K default. Without the bracket a
 * 1M-context model like `gpt-5.6-sol` (1,050,000) is budgeted at 200K and
 * auto-compacts at roughly a fifth of its real window.
 *
 * The bracket never reaches Copilot: `resolveModel` (`./utils`) strips it before
 * the upstream call, and because the catalog window is >=1M its `resolvedIs1M`
 * check passes, so no spurious downgrade warning fires.
 *
 * Catalog-gating is what keeps this honest for sub-1M models: `gpt-5.3-codex`
 * (400K) and `gpt-5.4-mini` (400K) are left bare, so they keep Claude Code's
 * conservative 200K accounting rather than being over-budgeted into an overflow.
 */
export function withOneMSuffix(id: string): string {
  if (oneMContextDisabled()) return id
  return catalogAdvertises1M(id) ? `${id}[1m]` : id
}
