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

/** Models whose shim DEFAULT reasoning effort is xhigh (effort POLICY set). */
export const XHIGH_DEFAULT_SHIM_MODELS = ["gpt-5.6-sol", "gpt-5.5"] as const

/** Normalize a model id for policy comparison: strip a leading `vendor/`
 *  prefix and any trailing `[...]` decoration(s) (e.g. `[1m]`, `[1m][beta]`)
 *  plus trailing whitespace. */
function normalizeModelId(id: string): string {
  const noVendor = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  return noVendor.replace(/(?:\[[^\]]*\])+\s*$/, "")
}

/** True iff `id` (after normalization) is in the xhigh effort-policy set. */
export function shimDefaultsToXhigh(id: string): boolean {
  return (XHIGH_DEFAULT_SHIM_MODELS as ReadonlyArray<string>).includes(
    normalizeModelId(id),
  )
}
