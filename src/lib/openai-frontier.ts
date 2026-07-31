/**
 * OpenAI frontier models + shim effort policy.
 *
 * Dependency-free leaf so BOTH `mcp-capabilities.ts` (model SELECTION) and the
 * hot `anthropic-translate` shim path (effort POLICY) can import without pulling
 * the heavy mcp-capabilities transitive deps (colbert/browser/worker) into the
 * shim. The selection list and the effort-policy set are deliberately SEPARATE
 * constants (same members today) so a future frontier model added for selection
 * does not silently inherit the xhigh effort default.
 */

/** Preference-ordered OpenAI frontier reasoning models (SELECTION list). */
export const OPENAI_FRONTIER_MODELS = ["gpt-5.6-sol", "gpt-5.5"] as const

/** Models whose shim reasoning effort becomes xhigh when the operator opts in
 *  with `GH_ROUTER_FRONTIER_XHIGH_DEFAULT=1` (effort POLICY set).
 *
 *  This is opt-IN, not the default. The shim maps a client's level to the
 *  identical provider level and injects only `high` when the client sends no
 *  `thinking` block at all; forcing xhigh here would silently override the level
 *  the user chose. The set is retained so the opt-in restores the previous
 *  behavior exactly, targeting the same models it used to. */
export const XHIGH_DEFAULT_SHIM_MODELS = ["gpt-5.6-sol", "gpt-5.5"] as const

/** Normalize a model id for policy comparison: strip a leading `vendor/`
 *  prefix and any trailing `[...]` decoration(s) (e.g. `[1m]`, `[1m][beta]`)
 *  plus trailing whitespace. */
function normalizeModelId(id: string): string {
  const noVendor = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  return noVendor.replace(/(?:\[[^\]]*\])+\s*$/, "")
}

/** True iff `id` (after normalization) is in the xhigh effort-policy set. Only
 *  consulted when `GH_ROUTER_FRONTIER_XHIGH_DEFAULT=1` opts in. */
export function shimDefaultsToXhigh(id: string): boolean {
  return (XHIGH_DEFAULT_SHIM_MODELS as ReadonlyArray<string>).includes(
    normalizeModelId(id),
  )
}
