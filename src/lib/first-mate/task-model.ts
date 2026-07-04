import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_MODEL_FALLBACKS } from "~/lib/port"
import { state } from "~/lib/state"
import { resolveModel } from "~/lib/utils"

/**
 * Resolve the model the GitHub cloud coding agent should run a first-mate task
 * with. Pure + catalog-injectable so it is unit-testable without global state.
 *
 * - `chosen` set (a mission `default_model` or a per-unit override): normalize
 *   it via {@link resolveModel} (the same slug cascade the proxy uses at request
 *   time) and, when a live catalog is available, REQUIRE the normalized id to be
 *   present — an explicitly-chosen model that Copilot can't serve THROWS rather
 *   than being silently swapped for a fallback (a silent class-switch could send
 *   the task to a weaker/wrong model the operator never asked for).
 * - `chosen` unset: default to {@link DEFAULT_CODEX_MODEL} (gpt-5.5), walking
 *   {@link DEFAULT_CODEX_MODEL_FALLBACKS} only when a catalog says the preferred
 *   default is absent (older Copilot tiers).
 *
 * When no catalog is available (tests, pre-fetch) nothing is enforced: an
 * explicit choice is returned normalized, an absent choice returns the default.
 *
 * @param chosen  the per-unit model, else the mission default, else undefined
 * @param catalog optional catalog override (defaults to the live `state.models`)
 */
export function resolveCloudAgentModel(
  chosen: string | undefined,
  catalog?: ReadonlyArray<{ id: string }> | null,
): string {
  const models = catalog ?? state.models?.data
  const ids =
    models && models.length > 0 ? new Set(models.map((m) => m.id)) : undefined

  const trimmed = typeof chosen === "string" ? chosen.trim() : ""
  if (trimmed.length > 0) {
    const normalized = resolveModel(trimmed)
    if (ids !== undefined && !ids.has(normalized)) {
      throw new Error(
        `Cloud-agent model "${chosen}" (resolved "${normalized}") is not in the Copilot catalog. ` +
          `Pick a model listed by \`github-router models\`, or omit it to use the ${DEFAULT_CODEX_MODEL} default.`,
      )
    }
    return normalized
  }

  // Unspecified → the default, walking fallbacks only when a catalog is present
  // and the preferred default is absent for this tier.
  if (ids === undefined) return DEFAULT_CODEX_MODEL
  for (const candidate of [DEFAULT_CODEX_MODEL, ...DEFAULT_CODEX_MODEL_FALLBACKS]) {
    if (ids.has(candidate)) return candidate
  }
  return DEFAULT_CODEX_MODEL
}
