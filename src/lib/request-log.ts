import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

export interface RequestLogInfo {
  method: string
  path: string
  model?: string
  resolvedModel?: string
  inputTokens?: number
  outputTokens?: number
  status?: number
  streaming?: boolean
}

/**
 * Format a number with K/M suffix for compact display.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Build a context window summary: "in:1.2K out:50 ctx:1.2K/1M (0.1%)"
 */
function formatTokenInfo(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  model: Model | undefined,
): string | undefined {
  if (inputTokens === undefined) return undefined

  const parts: Array<string> = []
  const maxPrompt = model?.capabilities.limits.max_prompt_tokens

  if (maxPrompt) {
    const pct = ((inputTokens / maxPrompt) * 100).toFixed(1)
    parts.push(`in:${formatTokens(inputTokens)}/${formatTokens(maxPrompt)} (${pct}%)`)
  } else {
    parts.push(`in:${formatTokens(inputTokens)}`)
  }

  if (outputTokens !== undefined) {
    parts.push(`out:${formatTokens(outputTokens)}`)
  }

  return parts.join(" ")
}

/**
 * Print a single summary line for a completed request.
 *
 * Examples:
 *   POST /v1/messages  claude-opus-4.6-1m  in:1.2K/1M (0.1%) out:50  200  2.3s
 *   POST /v1/messages  claude-opus-4-6→claude-opus-4.6-1m  in:743/1M (0.1%)  200  198ms
 *   POST /v1/chat/completions  claude-sonnet-4  in:15 out:16  200  2.1s stream
 */
export function logRequest(
  info: RequestLogInfo,
  model: Model | undefined,
  startTime: number,
): void {
  const parts: Array<string> = []

  parts.push(`${info.method} ${info.path}`)

  // Model (show resolution arrow if remapped)
  if (info.resolvedModel && info.resolvedModel !== info.model) {
    parts.push(`${info.model}→${info.resolvedModel}`)
  } else if (info.resolvedModel ?? info.model) {
    parts.push((info.resolvedModel ?? info.model)!)
  }

  // Token info with context window fill
  const tokenInfo = formatTokenInfo(info.inputTokens, info.outputTokens, model)
  if (tokenInfo) {
    parts.push(tokenInfo)
  }

  // Status
  if (info.status !== undefined) {
    parts.push(String(info.status))
  }

  // Duration + streaming flag
  const elapsed = Date.now() - startTime
  const duration =
    elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
  parts.push(info.streaming ? `${duration} stream` : duration)

  consola.info(parts.join("  "))
}
