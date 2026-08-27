import consola from "consola"

import { getTextTokenCount, getTokenizerFromModel } from "~/lib/tokenizer"
import type { Model } from "~/services/copilot/get-models"

export interface SalvageResult {
  body: string
  salvaged: boolean
  elidedTokens?: number
}

type AnyRecord = Record<string, unknown>
type Replacement = {
  original: string
  replacement: string
  apply: () => void
}

/**
 * Keep enough room for Copilot's message framing and for small differences
 * between counting the JSON text here and counting the decoded request there.
 */
const PROMPT_WINDOW_RESERVE = 2_000
const TOOL_RESULT_STUB = "[earlier tool output elided to fit prompt window]"
const MESSAGE_TEXT_STUB = "[earlier message text elided to fit prompt window]"
const MARKER_RE = /^\[github-router: elided ~([0-9]+) tokens of older tool output to fit this model's prompt window\]$/

function markerText(tokens: number): string {
  return `[github-router: elided ~${tokens} tokens of older tool output to fit this model's prompt window]`
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null
}

function textReplacement(
  block: AnyRecord,
  replacement: string,
): Replacement | undefined {
  if (block.type !== "text" || typeof block.text !== "string") return undefined
  if (block.text === replacement) return undefined
  return {
    original: block.text,
    replacement,
    apply: () => {
      block.text = replacement
    },
  }
}

function collectToolResultReplacements(
  messages: Array<unknown>,
  lastMessageIndex: number,
): Array<Replacement> {
  const replacements: Array<Replacement> = []
  for (let i = 0; i < lastMessageIndex; i += 1) {
    const message = messages[i]
    if (
      !isRecord(message)
      || message.role !== "user"
      || !Array.isArray(message.content)
    ) {
      continue
    }
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      if (typeof block.content === "string") {
        if (block.content === TOOL_RESULT_STUB) continue
        const original = block.content
        replacements.push({
          original,
          replacement: TOOL_RESULT_STUB,
          apply: () => {
            block.content = TOOL_RESULT_STUB
          },
        })
        continue
      }
      if (!Array.isArray(block.content)) continue
      for (const nested of block.content) {
        if (!isRecord(nested)) continue
        const replacement = textReplacement(nested, TOOL_RESULT_STUB)
        if (replacement) replacements.push(replacement)
      }
    }
  }
  return replacements
}

function collectMessageTextReplacements(
  messages: Array<unknown>,
  lastMessageIndex: number,
): Array<Replacement> {
  const replacements: Array<Replacement> = []
  for (let i = 0; i < lastMessageIndex; i += 1) {
    const message = messages[i]
    if (!isRecord(message)) continue
    if (message.role !== "assistant" && message.role !== "user") continue

    if (typeof message.content === "string") {
      if (message.content === MESSAGE_TEXT_STUB) continue
      const original = message.content
      replacements.push({
        original,
        replacement: MESSAGE_TEXT_STUB,
        apply: () => {
          message.content = MESSAGE_TEXT_STUB
        },
      })
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block)) continue
      const replacement = textReplacement(block, MESSAGE_TEXT_STUB)
      if (replacement) replacements.push(replacement)
    }
  }
  return replacements
}

function hasSalvageStub(messages: Array<unknown>): boolean {
  for (const message of messages.slice(0, -1)) {
    if (!isRecord(message)) continue
    if (message.content === MESSAGE_TEXT_STUB) return true
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === "text" && block.text === MESSAGE_TEXT_STUB) return true
      if (block.type !== "tool_result") continue
      if (block.content === TOOL_RESULT_STUB) return true
      if (
        Array.isArray(block.content)
        && block.content.some(
          (nested) =>
            isRecord(nested)
            && nested.type === "text"
            && nested.text === TOOL_RESULT_STUB,
        )
      ) {
        return true
      }
    }
  }
  return false
}

function ensureMarker(messages: Array<unknown>): {
  block: AnyRecord
  priorElidedTokens: number
} | undefined {
  const last = messages.at(-1)
  if (!isRecord(last) || last.role !== "user") return undefined

  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }]
  }
  if (!Array.isArray(last.content)) return undefined

  for (const contentBlock of last.content) {
    if (!isRecord(contentBlock)) continue
    if (contentBlock.type !== "text" || typeof contentBlock.text !== "string") continue
    const match = MARKER_RE.exec(contentBlock.text)
    if (!match) continue
    // The visible marker has no private wire field that could prove ownership.
    // Canonical older stubs distinguish a prior salvage from coincidental user
    // text; on ambiguity, preserve the current turn and let upstream decide.
    if (!hasSalvageStub(messages)) return undefined
    const parsed = Number.parseInt(match[1]!, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined
    return { block: contentBlock, priorElidedTokens: parsed }
  }

  const block: AnyRecord = { type: "text", text: markerText(0) }
  last.content.push(block)
  return { block, priorElidedTokens: 0 }
}

async function fragmentTokenSavings(
  replacement: Replacement,
  encoding: string,
): Promise<number> {
  const [before, after] = await Promise.all([
    getTextTokenCount(JSON.stringify(replacement.original), encoding),
    getTextTokenCount(JSON.stringify(replacement.replacement), encoding),
  ])
  return before - after
}

/**
 * Last-resort history salvage for requests that escaped the client's normal
 * compaction path. Protected content is never rewritten, and the original
 * string is returned unless a complete, valid-looking salvage fits the live
 * model budget.
 */
export async function salvageOversizedPrompt(
  rawBody: string,
  model: Model | undefined,
): Promise<SalvageResult> {
  const unchanged: SalvageResult = { body: rawBody, salvaged: false }
  if (!model) return unchanged
  const maxPromptTokens = model.capabilities?.limits?.max_prompt_tokens
  if (
    typeof maxPromptTokens !== "number"
    || !Number.isFinite(maxPromptTokens)
    || maxPromptTokens <= 0
  ) {
    return unchanged
  }

  const budget = Math.floor(maxPromptTokens) - PROMPT_WINDOW_RESERVE
  if (budget <= 0) return unchanged

  // Every supported tokenizer is byte-level, so its token count cannot exceed
  // the UTF-8 byte count. Bodies below this floor cannot overflow the budget and
  // avoid loading or running the tokenizer on the normal request path.
  if (Buffer.byteLength(rawBody, "utf8") <= budget) return unchanged

  const encoding = getTokenizerFromModel(model)
  let initialTokens: number
  try {
    initialTokens = await getTextTokenCount(rawBody, encoding)
  } catch (error) {
    consola.debug("Prompt-window salvage tokenization failed; allowing request:", error)
    return unchanged
  }
  if (initialTokens <= budget) return unchanged

  let body: AnyRecord
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return unchanged
    }
    body = parsed
  } catch {
    return unchanged
  }

  const messages = body.messages as Array<unknown>
  const marker = ensureMarker(messages)
  if (!marker) return unchanged

  // Tool output is usually both the bulkiest and the most reproducible history.
  // Exhaust it oldest-first before degrading ordinary conversation text.
  const replacements = [
    ...collectToolResultReplacements(messages, messages.length - 1),
    ...collectMessageTextReplacements(messages, messages.length - 1),
  ]

  let newlyElidedTokens = 0
  // Track the running total from per-fragment deltas instead of re-counting the
  // whole body after every replacement. Replacing one substring changes the
  // body's token count by very nearly that fragment's own delta, so this is a
  // close estimate, and it is only ever used to decide WHEN to spend an exact
  // count. A ~3MB body re-tokenized once per replacement would be hundreds of
  // full passes and would stall the request it is trying to rescue.
  let estimatedTokens = initialTokens
  for (const replacement of replacements) {
    let savings: number
    try {
      savings = await fragmentTokenSavings(replacement, encoding)
    } catch (error) {
      consola.debug("Prompt-window salvage tokenization failed; allowing request:", error)
      return unchanged
    }
    if (savings <= 0) continue

    replacement.apply()
    newlyElidedTokens += savings
    estimatedTokens -= savings
    const totalElidedTokens = marker.priorElidedTokens + newlyElidedTokens
    marker.block.text = markerText(totalElidedTokens)

    // Not close enough to be worth an exact count yet.
    if (estimatedTokens > budget) continue

    let serialized: string
    let finalTokens: number
    try {
      serialized = JSON.stringify(body)
      finalTokens = await getTextTokenCount(serialized, encoding)
    } catch (error) {
      consola.debug("Prompt-window salvage serialization failed; allowing request:", error)
      return unchanged
    }
    if (finalTokens > budget) {
      // The estimate was optimistic. Re-anchor on the measured truth so the
      // next crossing is judged against a real number, and keep shrinking.
      estimatedTokens = finalTokens
      continue
    }

    consola.warn(
      `Prompt-window salvage: model=${model.id} tokens=${initialTokens} budget=${budget} elided=${totalElidedTokens}`,
    )
    return {
      body: serialized,
      salvaged: true,
      elidedTokens: totalElidedTokens,
    }
  }

  // Immutable system/current-turn/thinking content can itself exceed the
  // ceiling. Sending a lossy body that still cannot fit would add degradation
  // without preventing the upstream error, so fail open with the original.
  return unchanged
}
