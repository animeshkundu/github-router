import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"
import { resolveTierModel } from "~/lib/first-mate/model-tiers"

type JsonRecord = Record<string, unknown>

interface MicroClassifyOptions<T> {
  system: string
  user: string
  schemaHint: string
  validate: (v: unknown) => T | null
  maxTokens?: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function firstMessageContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null
  const first = value.choices[0]
  if (!isRecord(first) || !isRecord(first.message)) return null
  return typeof first.message.content === "string" ? first.message.content : null
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function confidenceOf(value: JsonRecord): number | null {
  const confidence = value.confidence
  if (typeof confidence !== "number") return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  return confidence
}

function classifierSystemPrompt(system: string, schemaHint: string): string {
  return `${system}\nReply ONLY with a JSON object matching: ${schemaHint}. Include a numeric confidence field from 0 to 1. No markdown, prose, or extra text.`
}

export async function microClassify<T>(
  opts: MicroClassifyOptions<T>,
): Promise<{ value: T; confidence: number } | null> {
  const model = resolveTierModel("T0")
  if (!model) return null

  let response: Response
  try {
    response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: classifierSystemPrompt(opts.system, opts.schemaHint),
          },
          { role: "user", content: opts.user },
        ],
        temperature: 0,
        max_tokens: opts.maxTokens ?? 400,
        response_format: { type: "json_object" },
      }),
    })
  } catch (err) {
    consola.debug("first-mate micro-classifier fetch failed:", err)
    return null
  }

  try {
    const body: unknown = await response.json()
    const content = firstMessageContent(body)
    if (!content) return null

    const parsed = parseJsonObject(content)
    if (!parsed) return null

    const confidence = confidenceOf(parsed)
    if (confidence === null || confidence < 0.6) return null

    const value = opts.validate(parsed)
    if (value === null) return null

    return { value, confidence }
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

export async function classifyPlanReady(
  logExcerpt: string,
): Promise<{ planReady: boolean; planExcerpt: string } | null> {
  const result = await microClassify({
    system:
      "Decide whether a cloud-agent session log shows a completed implementation PLAN, not code or execution.",
    user: `Log excerpt:\n${logExcerpt}`,
    schemaHint:
      '{"planReady":boolean,"planExcerpt":"<=1200 chars from the completed plan, or empty","confidence":number}',
    maxTokens: 500,
    validate(value) {
      if (!isRecord(value)) return null
      const planReady = booleanValue(value.planReady)
      const planExcerpt = stringValue(value.planExcerpt)
      if (planReady === null || planExcerpt === null) return null
      return { planReady, planExcerpt: planExcerpt.slice(0, 1200) }
    },
  })

  return result?.value ?? null
}

export async function classifyQuestionAnswerable(
  question: string,
  acceptanceCriteria: string,
): Promise<{ answerable: boolean; answer?: string } | null> {
  const result = await microClassify({
    system:
      "Decide if the agent's question is answerable purely from the acceptance criteria. If yes, answer it tersely.",
    user: `Acceptance criteria:\n${acceptanceCriteria}\n\nAgent question:\n${question}`,
    schemaHint:
      '{"answerable":boolean,"answer":"present only when answerable","confidence":number}',
    validate(value) {
      if (!isRecord(value)) return null
      const answerable = booleanValue(value.answerable)
      if (answerable === null) return null
      const answer = stringValue(value.answer)
      if (!answerable) return { answerable }
      return answer === null ? null : { answerable, answer }
    },
  })

  return result?.value ?? null
}

export async function classifyFixAddressed(
  failureSummary: string,
  latestLogExcerpt: string,
): Promise<{ addressed: boolean } | null> {
  const result = await microClassify({
    system:
      "Decide whether the latest cloud-agent log indicates the summarized failure was addressed.",
    user: `Failure summary:\n${failureSummary}\n\nLatest log excerpt:\n${latestLogExcerpt}`,
    schemaHint: '{"addressed":boolean,"confidence":number}',
    validate(value) {
      if (!isRecord(value)) return null
      const addressed = booleanValue(value.addressed)
      return addressed === null ? null : { addressed }
    },
  })

  return result?.value ?? null
}

export async function classifyStuck(
  logExcerpt: string,
): Promise<{ stuck: boolean } | null> {
  const result = await microClassify({
    system:
      "Decide whether the cloud-agent log shows the agent is stuck, looping, blocked, or unable to proceed.",
    user: `Log excerpt:\n${logExcerpt}`,
    schemaHint: '{"stuck":boolean,"confidence":number}',
    validate(value) {
      if (!isRecord(value)) return null
      const stuck = booleanValue(value.stuck)
      return stuck === null ? null : { stuck }
    },
  })

  return result?.value ?? null
}
