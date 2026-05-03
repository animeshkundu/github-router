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
 *   context-1m-, skills-, files-api-, code-execution-, output-128k-.
 * 1M context is unlocked by selecting `claude-opus-4.7-1m-internal`
 * as the model id, not via a beta header.
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
]

/**
 * Filter an `anthropic-beta` header value, keeping only beta flags
 * in the active whitelist. Uses extended prefixes when --extended-betas
 * is enabled, VS Code-only prefixes otherwise.
 * Returns the filtered comma-separated string, or undefined if nothing remains.
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
        v && prefixes.some((prefix) => v.startsWith(prefix)),
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
