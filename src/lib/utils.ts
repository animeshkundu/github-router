import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

/**
 * Beta values that VS Code Copilot Chat actually sends to the Copilot API.
 * Only these are forwarded; everything else (e.g. context-1m-*) is stripped
 * so our requests match what VS Code produces.
 */
const ALLOWED_BETA_PREFIXES = [
  "interleaved-thinking-",
  "context-management-",
  "advanced-tool-use-",
  "token-counting-",
]

/**
 * Filter an `anthropic-beta` header value, keeping only beta flags that
 * VS Code Copilot is known to send. Returns the filtered comma-separated
 * string, or undefined if nothing remains.
 */
export function filterBetaHeader(value: string): string | undefined {
  const filtered = value
    .split(",")
    .map((v) => v.trim())
    .filter(
      (v) =>
        v && ALLOWED_BETA_PREFIXES.some((prefix) => v.startsWith(prefix)),
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
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Family preference (opus→1m, codex→highest version)
 * 4. Normalized match (dots→dashes, letter-digit boundaries)
 * 5. Return as-is with a warning
 */
export function resolveModel(modelId: string): string {
  const models = state.models?.data
  if (!models) return modelId

  // 1. Exact match
  if (models.some((m) => m.id === modelId)) return modelId

  // 2. Case-insensitive match
  const lower = modelId.toLowerCase()
  const ciMatch = models.find((m) => m.id.toLowerCase() === lower)
  if (ciMatch) return ciMatch.id

  // 3. Family preference — before normalization so product aliases
  //    (opus→1m, codex→latest) take priority over fuzzy matches
  if (lower.includes("opus")) {
    const oneM = models.find(
      (m) => m.id.includes("opus") && m.id.endsWith("-1m"),
    )
    if (oneM) return oneM.id
  }

  if (lower.includes("codex")) {
    const codexModels = models.filter((m) => {
      const endpoints = m.supported_endpoints ?? []
      return (
        (m.id.includes("codex") || m.id.startsWith("gpt-5"))
        && !m.id.includes("mini")
        && (endpoints.length === 0 || endpoints.includes("/responses"))
      )
    })
    if (codexModels.length > 0) {
      codexModels.sort((a, b) =>
        b.id.localeCompare(a.id, undefined, { numeric: true }),
      )
      return codexModels[0].id
    }
  }

  // 4. Normalized match (dots → dashes, letter-digit boundaries)
  const normalized = normalizeModelId(modelId)
  const normMatch = models.find(
    (m) => normalizeModelId(m.id) === normalized,
  )
  if (normMatch) return normMatch.id

  // 5. No match — warn and return as-is
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

  // Fall back to the best available codex/gpt-5 model supporting /responses
  const codexModels = models.filter((m) => {
    const endpoints = m.supported_endpoints ?? []
    return (
      (m.id.includes("codex") || m.id.startsWith("gpt-5"))
      && !m.id.includes("mini")
      && (endpoints.length === 0 || endpoints.includes("/responses"))
    )
  })

  if (codexModels.length > 0) {
    codexModels.sort((a, b) =>
      b.id.localeCompare(a.id, undefined, { numeric: true }),
    )
    const best = codexModels[0].id
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
