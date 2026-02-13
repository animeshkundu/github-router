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
 * Resolve a model name to the best available variant in the Copilot model list.
 * Prefers the 1M context variant for opus models.
 */
export function resolveModel(modelId: string): string {
  const models = state.models?.data
  if (!models) return modelId

  // Exact match — no remapping needed
  if (models.some((m) => m.id === modelId)) return modelId

  // For opus models, prefer the 1m variant
  if (modelId.toLowerCase().includes("opus")) {
    const oneM = models.find((m) => m.id.includes("opus") && m.id.endsWith("-1m"))
    if (oneM) return oneM.id
  }

  return modelId
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
