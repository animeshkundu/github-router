#!/usr/bin/env bun
/**
 * Opt-in direct evidence harness for long-lived prompt-cache retention.
 *
 * Without GH_ROUTER_RUN_CACHE_TTL_PROBE=1 this prints usage and exits 0.
 * The harness calls the production Copilot clients directly; it never spawns
 * Claude Code and never routes through the proxy HTTP endpoint.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import {
  buildSaltedSystemPrefix,
  buildTtlProbeResponsesPayload,
  computeTtlProbeVerdict,
  normalizeTtlProbeClaudeUsage,
  normalizeTtlProbeResponsesUsage,
  parseTtlProbeArm,
  randomSaltHex,
  ttlProbeIdentityFingerprint,
} from "~/lib/cache-probe"
import { runCommandCapture } from "~/lib/exec"
import { ensurePaths, PATHS } from "~/lib/paths"
import { applyClaudeCachePolicy } from "~/lib/prompt-cache"
import { state } from "~/lib/state"
import {
  setupCopilotToken,
  setupGitHubToken,
  type StopCopilotTokenRefresh,
} from "~/lib/token"
import { getPackageVersion } from "~/lib/version"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesApiResponse,
} from "~/services/copilot/create-responses"
import { getModels } from "~/services/copilot/get-models"
import type { Model } from "~/services/copilot/get-models"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

const USAGE = `Direct cache-TTL probe (costs real Copilot budget)

  GH_ROUTER_RUN_CACHE_TTL_PROBE=1 bun run probe:cache-ttl [--arm claude|gpt|all]

Environment:
  GH_ROUTER_CACHE_TTL_CLAUDE_DELAY_SEC  default 360, bounded 1..86400
  GH_ROUTER_CACHE_TTL_GPT_DELAY_SEC     default 3600, bounded 1..86400
  GH_ROUTER_CACHE_TTL_TRIALS            default 1, bounded 1..5
  GH_ROUTER_CACHE_TTL_OUTPUT            optional artifact path
`

const MAX_DELAY_SECONDS = 86_400
const MAX_TRIALS = 5
const CLAUDE_DELAY_DEFAULT = 360
const GPT_DELAY_DEFAULT = 3_600
const COMPARISON_NOTE =
  "arms use distinct cache identities and no verified shared namespace"

type Arm = "claude" | "gpt"
type Policy = "default" | "ttl-1h" | "default-retention" | "retention-24h"

/** Numeric usage snapshot only. Never contains raw provider response fields. */
export interface TtlProbeUsageSnapshot {
  inputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheFieldsPresent?: boolean
}

interface CallResult {
  /** Canonical numeric view of the raw provider usage, before normalization. */
  rawUsage?: TtlProbeUsageSnapshot
  /** Format-specific normalized view used by the verdict helper. */
  normalizedUsage?: TtlProbeUsageSnapshot
  /** Stable error classification only; never the raw error message. */
  errorClass?: string
}

export interface TtlProbeArmEvidence {
  identityFingerprint: string
  policy: Policy
  endpoint: "/v1/messages" | "/responses"
  model: string
  configuredDelaySeconds: number
  actualDelaySeconds: number
  cold: CallResult
  warm: CallResult
  verdict: ReturnType<typeof computeTtlProbeVerdict>
}

interface TrialResult {
  control: TtlProbeArmEvidence
  ttl: TtlProbeArmEvidence
}

function parseBoundedPositive(name: string, fallback: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be between 1 and ${max}`)
  }
  return value
}

function parseArm(): Arm | "all" {
  return parseTtlProbeArm(process.argv.slice(2))
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) return code
    if (error instanceof Error && error.name) return error.name
  }
  return "unknown"
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/** Keep only known numeric usage fields for the safe artifact. */
function rawUsageSnapshot(value: unknown): TtlProbeUsageSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const inputDetails = raw.input_tokens_details
  const promptDetails = raw.prompt_tokens_details
  const details = [inputDetails, promptDetails].filter(
    (detail): detail is Record<string, unknown> =>
      !!detail && typeof detail === "object" && !Array.isArray(detail),
  )
  const firstNumber = (...values: ReadonlyArray<unknown>): number | undefined => {
    return values.find(nonNegativeFinite)
  }
  const inputTokens = firstNumber(raw.input_tokens, raw.prompt_tokens)
  const cacheReadInputTokens = firstNumber(
    raw.cache_read_input_tokens,
    ...details.map((detail) => detail.cached_tokens),
  )
  const cacheCreationInputTokens = firstNumber(
    raw.cache_creation_input_tokens,
    raw.cache_write_tokens,
    ...details.flatMap((detail) => [
      detail.cache_write_tokens,
      detail.cache_creation_tokens,
    ]),
  )
  if (
    inputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheCreationInputTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens }
}

async function callClaude(body: string): Promise<CallResult> {
  try {
    const response = await createMessages(body)
    const json = await response.json() as Record<string, unknown>
    return {
      rawUsage: rawUsageSnapshot(json.usage),
      normalizedUsage: normalizeTtlProbeClaudeUsage(json.usage),
    }
  } catch (error) {
    return { errorClass: errorClass(error) }
  }
}

async function callGpt(
  payload: ReturnType<typeof buildTtlProbeResponsesPayload>,
): Promise<CallResult> {
  try {
    const response = await createResponses(payload) as ResponsesApiResponse
    return {
      rawUsage: rawUsageSnapshot(response.usage),
      normalizedUsage: normalizeTtlProbeResponsesUsage(response.usage ?? {}),
    }
  } catch (error) {
    return { errorClass: errorClass(error) }
  }
}

function claudePayload(model: string, salt: string, ttl?: "1h"): string {
  return applyClaudeCachePolicy(
    JSON.stringify({
      model,
      max_tokens: 16,
      system: buildSaltedSystemPrefix(8_000, salt),
      tools: [{
        name: "peer_critic",
        description: "Return a concise independent review.",
        input_schema: {
          type: "object",
          required: ["context"],
          properties: { context: { type: "string" } },
          additionalProperties: false,
        },
      }],
      messages: [{ role: "user", content: `cache-ttl-probe-${salt}` }],
    }),
    ttl === undefined
      ? { workload: "reusable-prefix" }
      : { workload: "reusable-prefix", ttl },
  )
}

function findClaudeModel(models: ReadonlyArray<Model>): Model | undefined {
  return models.find((model) => model.id === "claude-opus-5")
}

function findModel(
  models: ReadonlyArray<Model>,
  id: string,
): Model | undefined {
  return models.find((model) => model.id === id)
}

function monotonicSeconds(): number {
  return Number(process.hrtime.bigint()) / 1_000_000_000
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
}

async function runPair(args: {
  model: string
  delaySeconds: number
  evidenceFloorSeconds: number
  endpoint: TtlProbeArmEvidence["endpoint"]
  controlPolicy: Policy
  ttlPolicy: Policy
  controlRequest: () => {
    identity: string
    call: () => Promise<CallResult>
  }
  ttlRequest: () => {
    identity: string
    call: () => Promise<CallResult>
  }
}): Promise<{ control: TtlProbeArmEvidence; ttl: TtlProbeArmEvidence }> {
  const runArm = async (
    request: () => { identity: string; call: () => Promise<CallResult> },
    policy: Policy,
  ): Promise<TtlProbeArmEvidence> => {
    const prepared = request()
    const cold = await prepared.call()
    const beforeSleep = monotonicSeconds()
    await sleep(args.delaySeconds)
    const actualDelaySeconds = monotonicSeconds() - beforeSleep
    const warm = await prepared.call()
    return {
      identityFingerprint: prepared.identity,
      policy,
      endpoint: args.endpoint,
      model: args.model,
      configuredDelaySeconds: args.delaySeconds,
      actualDelaySeconds,
      cold,
      warm,
      verdict: computeTtlProbeVerdict({
        cold: cold.normalizedUsage,
        warm: warm.normalizedUsage,
        failed: Boolean(cold.errorClass || warm.errorClass),
        configuredDelaySeconds: args.delaySeconds,
        actualDelaySeconds,
        evidenceFloorSeconds: args.evidenceFloorSeconds,
      }),
    }
  }

  const control = await runArm(args.controlRequest, args.controlPolicy)
  const ttl = await runArm(args.ttlRequest, args.ttlPolicy)
  return { control, ttl }
}

async function runClaudeTrial(
  model: Model,
  delaySeconds: number,
): Promise<TrialResult> {
  const controlBody = claudePayload(model.id, randomSaltHex())
  const ttlBody = claudePayload(model.id, randomSaltHex(), "1h")
  return runPair({
    model: model.id,
    delaySeconds,
    evidenceFloorSeconds: CLAUDE_DELAY_DEFAULT,
    endpoint: "/v1/messages",
    controlPolicy: "default",
    ttlPolicy: "ttl-1h",
    controlRequest: () => ({
      identity: ttlProbeIdentityFingerprint(controlBody),
      call: () => callClaude(controlBody),
    }),
    ttlRequest: () => ({
      identity: ttlProbeIdentityFingerprint(ttlBody),
      call: () => callClaude(ttlBody),
    }),
  })
}

async function runGptTrial(
  model: Model,
  delaySeconds: number,
): Promise<TrialResult> {
  const controlPayload = buildTtlProbeResponsesPayload({
    model: model.id,
    salt: randomSaltHex(),
  })
  const ttlPayload = buildTtlProbeResponsesPayload({
    model: model.id,
    salt: randomSaltHex(),
    retention: "24h",
  })
  return runPair({
    model: model.id,
    delaySeconds,
    evidenceFloorSeconds: GPT_DELAY_DEFAULT,
    endpoint: "/responses",
    controlPolicy: "default-retention",
    ttlPolicy: "retention-24h",
    controlRequest: () => ({
      identity: ttlProbeIdentityFingerprint(controlPayload),
      call: () => callGpt(controlPayload),
    }),
    ttlRequest: () => ({
      identity: ttlProbeIdentityFingerprint(ttlPayload),
      call: () => callGpt(ttlPayload),
    }),
  })
}

async function commitSha(): Promise<string> {
  try {
    const result = await runCommandCapture(
      ["git", "rev-parse", "HEAD"],
      { cwd: REPO_ROOT, timeoutMs: 10_000 },
    )
    return result.code === 0 ? result.stdout.trim() || "unknown" : "unknown"
  } catch {
    return "unknown"
  }
}

function outputPath(): string {
  const configured = process.env.GH_ROUTER_CACHE_TTL_OUTPUT
  if (configured) return path.resolve(configured)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(PATHS.APP_DIR, "cache-probe", `cache-ttl-${stamp}.json`)
}

async function main(): Promise<void> {
  if (process.env.GH_ROUTER_RUN_CACHE_TTL_PROBE !== "1") {
    console.log(USAGE)
    return
  }

  const arm = parseArm()
  const claudeDelay = parseBoundedPositive(
    "GH_ROUTER_CACHE_TTL_CLAUDE_DELAY_SEC",
    CLAUDE_DELAY_DEFAULT,
    MAX_DELAY_SECONDS,
  )
  const gptDelay = parseBoundedPositive(
    "GH_ROUTER_CACHE_TTL_GPT_DELAY_SEC",
    GPT_DELAY_DEFAULT,
    MAX_DELAY_SECONDS,
  )
  const trials = parseBoundedPositive(
    "GH_ROUTER_CACHE_TTL_TRIALS",
    1,
    MAX_TRIALS,
  )
  const exploratory =
    claudeDelay < CLAUDE_DELAY_DEFAULT || gptDelay < GPT_DELAY_DEFAULT
  if (exploratory) {
    console.warn(
      "Configured delay is below the first-pass boundary; results are exploratory.",
    )
  }

  await ensurePaths()
  await setupGitHubToken()
  let stopRefresh: StopCopilotTokenRefresh | undefined
  const results: Record<string, unknown> = {}
  try {
    stopRefresh = await setupCopilotToken()
    const catalogResponse = await getModels()
    state.models = catalogResponse
    const catalog = catalogResponse.data

    if (arm === "claude" || arm === "all") {
      const model = findClaudeModel(catalog)
      if (!model) {
        results.claude = {
          model: null,
          trials: [],
          verdict: "INCONCLUSIVE",
          errorClass: "model_unavailable",
        }
      } else {
        const claudeResult: { model: string; trials: Array<TrialResult> } = {
          model: model.id,
          trials: [],
        }
        for (let index = 0; index < trials; index++) {
          const trial = await runClaudeTrial(model, claudeDelay)
          claudeResult.trials.push(trial)
          console.log(
            `claude trial ${index + 1}: control=${trial.control.verdict.verdict} `
              + `ttl=${trial.ttl.verdict.verdict}`,
          )
        }
        results.claude = claudeResult
      }
    }

    if (arm === "gpt" || arm === "all") {
      const model = findModel(catalog, "gpt-5.5")
      if (!model) {
        results.gpt = {
          model: null,
          trials: [],
          verdict: "INCONCLUSIVE",
          errorClass: "model_unavailable",
        }
      } else {
        const gptResult: { model: string; trials: Array<TrialResult> } = {
          model: model.id,
          trials: [],
        }
        for (let index = 0; index < trials; index++) {
          const trial = await runGptTrial(model, gptDelay)
          gptResult.trials.push(trial)
          console.log(
            `gpt trial ${index + 1}: control=${trial.control.verdict.verdict} `
              + `ttl=${trial.ttl.verdict.verdict}`,
          )
        }
        results.gpt = gptResult
      }
    }
  } finally {
    stopRefresh?.()
  }

  const artifact = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    commitSha: await commitSha(),
    routerVersion: getPackageVersion(),
    arm,
    comparison: {
      status: "not_evaluated",
      reason: COMPARISON_NOTE,
    },
    config: {
      claudeDelaySeconds: claudeDelay,
      gptDelaySeconds: gptDelay,
      trials,
      exploratory,
    },
    results,
  }
  const file = outputPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(`Evidence artifact: ${file}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`cache-ttl probe failed: ${errorClass(error)}`)
    process.exitCode = 1
  }
}
