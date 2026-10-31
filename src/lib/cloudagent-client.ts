/**
 * Cloud Agent Job API v2 client.
 *
 * Cloud Agent is Microsoft's internal service that runs an agent session against an
 * Azure DevOps repository. A v2 job is described by a prompt and an optional
 * custom agent, so it covers non-PR work (open work items, review a branch,
 * answer a question) that the v1 PR-centric endpoint could not express.
 *
 * **The origin is fixed per environment and is deliberately NOT configurable.**
 * The bearer token's audience is the environment's own Entra resource, so a
 * caller-supplied base URL would hand the token to an arbitrary host. That is
 * the same reasoning that makes a per-call Kusto cluster require a shape check:
 * here the set is small and known, so it is a two-value enum instead of a check.
 * `GH_ROUTER_CLOUDAGENT_TOKEN` overrides the TOKEN (for tests and manual runs), not
 * the destination.
 *
 * **Auth** is `az account get-access-token --resource <app-id-uri>` through the
 * shared `AzCliAccessTokenCache`, so a stale token is re-minted on a 401 and
 * concurrent calls share one `az` process. The CLI appends `/.default` itself;
 * passing the literal scope form to `--resource` is not the documented shape.
 * The token is held in memory only: unlike the GitHub credential there is no
 * token file, and nothing here writes one. Interactive login is disabled — the
 * group can be enabled by repository discovery, and a device-code prompt raised
 * inside a spawned `claude` session is invisible to the user and reads as a
 * hang, so a missing session fails fast with `az login` advice instead.
 *
 * **Retry policy is per endpoint, because only some calls are safe to repeat.**
 * Reads, `POST /v2/jobs/validate` (creates nothing) and cancellation (the
 * service documents a repeated cancel as safe) retry on 429/5xx. `POST /v2/jobs`
 * does NOT: a 5xx there may arrive after the job was created, so an automatic
 * resend could bill and run the same work twice. A 401 on any endpoint still
 * gets the one re-mint retry, because a rejected request had no effect.
 */

import { AzCliAccessTokenCache, describeAzFailure } from "./azure-cli-token"
import { parseRetryAfter, sanitizeRemoteDetail, sleep } from "./remote-mcp-client"

/** Token override for tests and manual runs. Never logged. */
export const CLOUDAGENT_TOKEN_ENV = "GH_ROUTER_CLOUDAGENT_TOKEN"

export const CLOUDAGENT_ENVIRONMENTS = ["prod", "ppe"] as const
export type CloudAgentEnvironment = (typeof CLOUDAGENT_ENVIRONMENTS)[number]

/**
 * Base URL plus the Entra resource (App ID URI) whose `/.default` scope the
 * token is minted for. The docs list bare client-ID `aud` values as accepted
 * legacy alternates; the App ID URI is the form `az --resource` takes.
 */
const ENVIRONMENT_ENDPOINTS: Record<CloudAgentEnvironment, { baseUrl: string; resource: string }> = {
  prod: {
    baseUrl: "https://copilotswe.app.prod.gitops.startclean.microsoft.com/api/agency",
    resource: "api://81bbac67-d541-4a6d-a48b-b1c0f9a57888",
  },
  ppe: {
    baseUrl: "https://copilotswe.app.ppe.gitops.startclean.microsoft.com/api/agency",
    resource: "api://99d8628b-dd58-4123-b33c-7e82ddf37571",
  },
}

/**
 * The origin a request for this environment goes to. Exposed so no caller or
 * test transcribes the URL: the token's audience and its destination are the
 * same mapping by construction, and `tests/bluebird-test-isolation.test.ts`
 * reads it from the source to keep live origins out of fixtures.
 */
export function cloudAgentBaseUrl(environment: CloudAgentEnvironment): string {
  return ENVIRONMENT_ENDPOINTS[environment].baseUrl
}

/** Normalize a launch value. Throws on anything but the two known names. */
export function normalizeCloudAgentEnvironment(value: string): CloudAgentEnvironment {
  const raw = value.trim().toLowerCase()
  if (raw === "prod" || raw === "production") return "prod"
  if (raw === "ppe") return "ppe"
  throw new CloudAgentError(
    `Unknown Cloud Agent environment "${value}". Use "prod" or "ppe".`,
    { retriable: false },
  )
}

export interface CloudAgentErrorOptions {
  retriable?: boolean
  status?: number
  retryAfterMs?: number
}

export class CloudAgentError extends Error {
  readonly retriable: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(message: string, opts: CloudAgentErrorOptions = {}) {
    super(sanitizeRemoteDetail(message))
    this.name = "CloudAgentError"
    this.retriable = opts.retriable ?? false
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

/**
 * Wire-shape byte caps. The default bounds a job or catalog response; logs get
 * a larger one because a transcript with tool diffs is legitimately megabytes
 * and refusing it would leave the model with nothing. Both are byte budgets, so
 * both are measured with `Buffer.byteLength` rather than `text.length`.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_LOGS_BYTES = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

/**
 * Backoff for a retriable verdict on an endpoint whose retry is safe. Mirrors
 * the shared remote-MCP transport and the Kusto client: 1/2/4 s, with a
 * service `Retry-After` winning when present.
 */
const CLOUDAGENT_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000]

/**
 * Read a response body under `cap`, in BYTES. A declared `content-length` that
 * already exceeds the cap is refused before buffering; a chunked or header-less
 * response falls back to the post-read byte count, which is the only signal
 * left. The socket is released either way so a refused body is not drained.
 */
async function readBoundedBody(res: Response, cap: number, what: string): Promise<string> {
  const declaredHeader = res.headers.get("content-length")
  const declared = declaredHeader ? Number(declaredHeader) : Number.NaN
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {})
    throw new CloudAgentError(
      `Cloud Agent ${what} declared ${declared} bytes, over the ${Math.floor(cap / (1024 * 1024))} MiB client cap.`,
      { retriable: false },
    )
  }
  const text = await res.text()
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > cap) {
    throw new CloudAgentError(
      `Cloud Agent ${what} exceeded the ${Math.floor(cap / (1024 * 1024))} MiB client cap (${bytes} bytes).`,
      { retriable: false },
    )
  }
  return text
}

// --- Wire types ------------------------------------------------------------
//
// Deliberately loose: every field except `jobId` is optional, because the docs
// state that older payloads and historical rows carry only `state` / `result` /
// `reason`. A renderer that assumed the modern shape would crash on history.

export type CloudAgentAgentType = "Repo" | "Organization" | "Company" | "Spec"

export interface CloudAgentRepositoryRef {
  /** Always `"ado"`; the only provider the API documents. */
  $type: "ado"
  organization: string
  project: string
  repository: string
  branch?: string
}

export interface CloudAgentCustomAgentRef {
  name: string
  type?: CloudAgentAgentType
  pluginName?: string
  inputs?: Record<string, string | number | boolean>
}

export interface CloudAgentPluginRef {
  name: string
  type?: CloudAgentAgentType
}

export interface CloudAgentModelConfiguration {
  model?: string
  reasoningEffort?: string
  context?: "default" | "long_context"
}

/** Free-form string labels carried on a job and echoed back by the API. */
export type CloudAgentJobMetadata = Record<string, string>

/** The v2 request body. Built by `buildGenericJobRequest`, never by the tools. */
export interface GenericJobRequest {
  prompt?: string
  context: { repository: CloudAgentRepositoryRef }
  customAgent?: CloudAgentCustomAgentRef
  plugins?: Array<CloudAgentPluginRef>
  additionalOptions?: { pluginOptions?: { includeDefaults?: boolean } }
  modelConfiguration?: CloudAgentModelConfiguration
  metadata?: CloudAgentJobMetadata
}

/** A validated, provider-neutral description of the job a caller wants. */
export interface CloudAgentJobInput {
  prompt?: string
  repository: { organization: string; project: string; repository: string; branch?: string }
  customAgent?: CloudAgentCustomAgentRef
  plugins?: Array<CloudAgentPluginRef>
  includeDefaultPlugins?: boolean
  modelConfiguration?: CloudAgentModelConfiguration
  metadata?: CloudAgentJobMetadata
}

/**
 * Assemble the v2 wire body.
 *
 * The one rule the service enforces itself: `prompt` may be omitted when a
 * custom agent is supplied, and the request is rejected when BOTH are absent.
 * Checking it here turns a network round trip into an immediate, actionable
 * message — and because `validate_job` shares this builder, a caller learns the
 * same thing without creating anything.
 */
export function buildGenericJobRequest(input: CloudAgentJobInput): GenericJobRequest {
  const prompt = input.prompt?.trim() ?? ""
  if (!prompt && !input.customAgent) {
    throw new CloudAgentError(
      "A job needs either `prompt` or `agent`. Supply `prompt` to describe the work, or `agent` to run a custom agent (whose own instructions then drive the job).",
      { retriable: false },
    )
  }

  const branch = input.repository.branch?.trim()
  const repository: CloudAgentRepositoryRef = {
    $type: "ado",
    organization: input.repository.organization.trim(),
    project: input.repository.project.trim(),
    repository: input.repository.repository.trim(),
    ...(branch ? { branch } : {}),
  }

  const request: GenericJobRequest = {
    context: { repository },
  }
  // Omitted rather than sent empty: the service treats an empty prompt as
  // absent, so sending "" would be equivalent but noisy on the wire and in the
  // stored job.
  if (prompt) request.prompt = prompt

  if (input.customAgent) {
    const agent: CloudAgentCustomAgentRef = { name: input.customAgent.name.trim() }
    if (input.customAgent.type) agent.type = input.customAgent.type
    if (input.customAgent.pluginName?.trim()) agent.pluginName = input.customAgent.pluginName.trim()
    if (input.customAgent.inputs && Object.keys(input.customAgent.inputs).length > 0) {
      agent.inputs = input.customAgent.inputs
    }
    request.customAgent = agent
  }

  if (input.plugins && input.plugins.length > 0) {
    request.plugins = input.plugins.map((plugin) => ({
      name: plugin.name.trim(),
      ...(plugin.type ? { type: plugin.type } : {}),
    }))
  }

  if (input.includeDefaultPlugins === true) {
    request.additionalOptions = { pluginOptions: { includeDefaults: true } }
  }

  const model = input.modelConfiguration?.model?.trim()
  const effort = input.modelConfiguration?.reasoningEffort?.trim()
  const contextTier = input.modelConfiguration?.context
  if (model || effort || contextTier) {
    request.modelConfiguration = {
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(contextTier ? { context: contextTier } : {}),
    }
  }

  const metadata = normalizeJobMetadata(input.metadata)
  if (metadata) request.metadata = metadata

  return request
}

/**
 * Bound the label map a caller can attach to a job.
 *
 * The labels are how a caller finds its own jobs again (a `list_jobs` row
 * prints them), so they are deliberately free-form. They are also the one
 * request field whose size a model controls without limit, and a job record is
 * stored and echoed on every later read, so a whole report pasted into a label
 * would be paid for on every poll. Rejecting is the honest bound: truncating a
 * label would change the value the caller later searches for.
 */
const MAX_METADATA_ENTRIES = 32
const MAX_METADATA_KEY_CHARS = 128
const MAX_METADATA_VALUE_CHARS = 256

function normalizeJobMetadata(metadata: CloudAgentJobMetadata | undefined): CloudAgentJobMetadata | undefined {
  if (!metadata) return undefined
  const entries = Object.entries(metadata)
  if (entries.length === 0) return undefined
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new CloudAgentError(
      `\`metadata\` has ${entries.length} entries; at most ${MAX_METADATA_ENTRIES} are allowed. These are short labels (chain, step, issue), not a place to store content.`,
      { retriable: false },
    )
  }
  const normalized: CloudAgentJobMetadata = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "")
    if (!key) {
      throw new CloudAgentError("`metadata` keys must be non-empty strings.", { retriable: false })
    }
    if (key.length > MAX_METADATA_KEY_CHARS || value.length > MAX_METADATA_VALUE_CHARS) {
      throw new CloudAgentError(
        `\`metadata\` entry "${key.slice(0, 40)}" is too long: keys are limited to ${MAX_METADATA_KEY_CHARS} characters and values to ${MAX_METADATA_VALUE_CHARS}. These are short labels, not a place to store content.`,
        { retriable: false },
      )
    }
    normalized[key] = value
  }
  return normalized
}

// --- Responses -------------------------------------------------------------

export interface CloudAgentModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CloudAgentPipelineRun {
  definitionId?: number
  runId?: number
}

export interface CloudAgentJob {
  jobId: string
  operationId?: string
  state?: string
  /** Legacy classifier verdict: Pending | Success | Failure | Cancelled. */
  result?: string
  /** Legacy diagnostic text. */
  reason?: string
  outcomeCode?: string
  outcomeDescription?: string
  /** Responsibility attribution: Pending | Succeeded | UserError | InfraError | Cancelled | Unknown. */
  jobOutcomeType?: string
  createdAt?: string
  updatedAt?: string
  prompt?: string
  requesterName?: string
  isRetryable?: boolean
  repository?: string
  pullRequestId?: number
  sourceBranch?: string
  targetBranch?: string
  workItemIds?: Array<number>
  pullRequestTags?: Array<string>
  /** The model the job was CREATED with (the request's `modelName`). */
  modelName?: string
  /** The model the session ended on, which differs when the agent switched. */
  currentModel?: string
  modelUsage?: Record<string, CloudAgentModelUsage | null>
  /** Caller-supplied labels, echoed back verbatim. */
  metadata?: CloudAgentJobMetadata
  /** Plugins the job asked for, by name. */
  plugins?: Array<string>
  /** Constant `"Agency"` today; kept because it is the platform discriminator. */
  agentPlatform?: string
  /** Where the job was started from: `Hub`, `WebApi`, `EventTrigger`, … */
  source?: string
  /** Human name of the account that started the job. */
  initiatingUserName?: string
  /** The service queues a job until `scheduling.dispatchAfter`. */
  dispatchAfter?: string
  /** The Azure Pipelines run backing the job, when the response carries one. */
  pipelineRun?: CloudAgentPipelineRun
  /** Commit the agent ran against, when the service recorded one. */
  commitMetadata?: Record<string, string>
}

export interface CloudAgentJobPage {
  data: Array<CloudAgentJob>
  continuationToken?: string
  hasMore: boolean
}

export interface CloudAgentAgentInfo {
  name: string
  type?: string
  engine?: string
  description?: string
  inputs?: Record<string, { type?: string; required?: boolean; description?: string }>
}

export interface CloudAgentPluginInfo {
  name: string
  type?: string
  description?: string
  enabledByDefault?: boolean
}

/**
 * One model a job may name in `model`, from the undocumented but live
 * `GET /models` catalog (measured 2026-10-31: 25 entries).
 *
 * Flattened from the wire's `capabilities.supports` / `capabilities.limits`
 * nesting because no renderer needs the wrapper levels, and optional
 * throughout: the endpoint is undocumented, so a field that stops being sent
 * must degrade to "not stated" rather than fail the call.
 */
export interface CloudAgentModelInfo {
  id: string
  vendor?: string
  preview?: boolean
  /** The ceiling the service advertises. There is no tier dimension here:
   *  `context: "long_context"` is accepted on every model but published nowhere. */
  maxContextWindowTokens?: number
  maxOutputTokens?: number
  /** Effort values this model accepts, in the service's own order (low … max). */
  reasoningEffort?: Array<string>
  /** Advisory text, e.g. a planned deprecation. */
  notices?: Array<string>
  /** Premium-request multiplier; 1 is the ordinary rate. */
  billingMultiplier?: number
}

export interface CloudAgentCatalogPage<T> {
  value: Array<T>
  totalCount?: number
  top?: number
  skip?: number
  errors?: Array<string>
}

/** One recorded tool call, paired with the result the trace stored for it. */
export interface CloudAgentToolCall {
  name: string
  /** Arguments exactly as recorded. Frequently `{}`: several of the agent's
   *  own tools (notably `apply_patch`) are logged with their arguments
   *  stripped, which is why `toolDiffs` cannot be the source of "what changed". */
  args: Record<string, unknown>
  /** The user-facing result text (`result.content`), when one was recorded. */
  result?: string
  /** The internal detail the service kept for a few tools. On an agent-run tool
   *  this is sometimes a git diff, which is the only place a real diff appears
   *  in the trace — every sampled job reported `toolDiffs: []`. */
  detail?: string
}

export interface CloudAgentJobLogs {
  id?: string
  createdAt?: string
  updatedAt?: string
  /** Chat-history messages, including the ones the digest ignores. */
  messageCount: number
  /** `task_complete.arguments.summary` — the job's deliverable, verbatim. */
  summary?: string
  /** Assistant prose in order, with the empty entries the trace is full of dropped. */
  assistantTexts: Array<string>
  /** Every recorded tool call, in order. */
  toolCalls: Array<CloudAgentToolCall>
  /** Tool name to call count, most frequent first. */
  histogram: Array<{ name: string; count: number }>
  /** Files the trace evidences a write to, in first-seen order. */
  changedFiles: Array<string>
  /** Items whose `$type` this parser does not model. Reported, never guessed at. */
  unrecognizedItems: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

/**
 * A timestamp, with Go's zero time treated as absent.
 *
 * A validated-but-never-created job reports `createdAt: "0001-01-01T00:00:00"`
 * and so do some logs envelopes (measured). Rendering that as a creation time
 * would state something false, so it is dropped instead.
 */
function timestampField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key)
  if (!value) return undefined
  if (value.startsWith("0001-01-01")) return undefined
  return value
}

/** A `Dictionary<string,string>`, honouring only string values. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const map: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") map[key] = entry
  }
  return Object.keys(map).length > 0 ? map : undefined
}

function numberArray(value: unknown): Array<number> | undefined {
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
  return numbers.length > 0 ? numbers : undefined
}

function stringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  return strings.length > 0 ? strings : undefined
}

function usageFrom(value: unknown): CloudAgentModelUsage | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const usage: CloudAgentModelUsage = {}
  const input = numberField(value, "inputTokens")
  const output = numberField(value, "outputTokens")
  const cacheRead = numberField(value, "cacheReadTokens")
  const cacheWrite = numberField(value, "cacheWriteTokens")
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  return usage
}

/** Read one job from either shape: `context.repository` (v2) or `azDoContext`. */
export function readJob(value: unknown): CloudAgentJob {
  if (!isRecord(value)) {
    throw new CloudAgentError("Cloud Agent returned a job that was not an object.", { retriable: true })
  }
  const jobId = stringField(value, "jobId") ?? stringField(value, "id")
  if (!jobId) {
    throw new CloudAgentError("Cloud Agent returned a job without a jobId.", { retriable: true })
  }
  const job: CloudAgentJob = { jobId }

  const operationId = stringField(value, "operationId")
  if (operationId) job.operationId = operationId
  const state = stringField(value, "state")
  if (state) job.state = state
  const result = stringField(value, "result")
  if (result) job.result = result
  const reason = stringField(value, "reason")
  if (reason) job.reason = reason
  const createdAt = timestampField(value, "createdAt")
  if (createdAt) job.createdAt = createdAt
  const updatedAt = timestampField(value, "updatedAt")
  if (updatedAt) job.updatedAt = updatedAt
  const prompt = stringField(value, "prompt")
  if (prompt) job.prompt = prompt
  const jobOutcomeType = stringField(value, "jobOutcomeType")
  if (jobOutcomeType) job.jobOutcomeType = jobOutcomeType
  const retryable = booleanField(value, "isRetryable")
  if (retryable !== undefined) job.isRetryable = retryable

  // Request provenance. `modelName` is what the job was created with, which is
  // NOT the same as `sessionMetrics.currentModel` (what it ended on): a job can
  // start on one model and finish on another, and reporting one as the other
  // would hide that.
  const modelName = stringField(value, "modelName")
  if (modelName) job.modelName = modelName
  const agentPlatform = stringField(value, "agentPlatform")
  if (agentPlatform) job.agentPlatform = agentPlatform
  const source = stringField(value, "source")
  if (source) job.source = source
  const metadata = stringMap(value.metadata)
  if (metadata) job.metadata = metadata
  const commitMetadata = stringMap(value.commitMetadata)
  if (commitMetadata) job.commitMetadata = commitMetadata
  const initiating = value.initiatingUser
  if (isRecord(initiating)) {
    const name = stringField(initiating, "name") ?? stringField(initiating, "email")
    if (name) job.initiatingUserName = name
  }
  const scheduling = value.scheduling
  if (isRecord(scheduling)) {
    const dispatchAfter = timestampField(scheduling, "dispatchAfter")
    if (dispatchAfter) job.dispatchAfter = dispatchAfter
  }
  // `plugins` is an array of `{name, type}` refs on a job and would be bare
  // strings on nothing this service returns; accepting both costs one line and
  // avoids a silently empty selector.
  const rawPlugins = value.plugins
  if (Array.isArray(rawPlugins)) {
    const names = rawPlugins
      .map((entry) => (typeof entry === "string" ? entry : isRecord(entry) ? stringField(entry, "name") : undefined))
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    if (names.length > 0) job.plugins = names
  }
  // A created job reports `pipelineRun`; a validated one reports `compute`.
  // Both are the Azure Pipelines run that backs the job.
  for (const key of ["pipelineRun", "compute"] as const) {
    const entry = value[key]
    if (!isRecord(entry)) continue
    const run: CloudAgentPipelineRun = {}
    const definitionId = numberField(entry, "definitionId")
    const runId = numberField(entry, "runId")
    if (definitionId !== undefined && definitionId >= 0) run.definitionId = definitionId
    if (runId !== undefined && runId >= 0) run.runId = runId
    if (run.definitionId !== undefined || run.runId !== undefined) {
      job.pipelineRun = run
      break
    }
  }

  const outcome = value.outcome
  if (isRecord(outcome)) {
    const code = stringField(outcome, "code")
    if (code) job.outcomeCode = code
    const description = stringField(outcome, "description")
    if (description) job.outcomeDescription = description
  }

  const requester = value.requester
  if (isRecord(requester)) {
    const name = stringField(requester, "name")
    if (name) job.requesterName = name
  }

  // v2 create/get carry `context.repository`; the v1-shaped reader carries
  // `azDoContext`. Both are rendered the same way.
  const context = value.context
  if (isRecord(context) && isRecord(context.repository)) {
    const repository = context.repository
    const organization = stringField(repository, "organization")
    const project = stringField(repository, "project")
    const name = stringField(repository, "repository")
    if (organization && project && name) job.repository = `${organization}/${project}/${name}`
    const branch = stringField(repository, "branch")
    if (branch) job.sourceBranch = branch
  }
  const azDo = value.azDoContext
  if (isRecord(azDo)) {
    const organization = stringField(azDo, "organization")
    const project = stringField(azDo, "projectName")
    const name = stringField(azDo, "repositoryName")
    if (organization && project && name) job.repository = `${organization}/${project}/${name}`
    const pullRequestId = numberField(azDo, "pullRequestId")
    if (pullRequestId !== undefined) job.pullRequestId = pullRequestId
    const source = stringField(azDo, "sourceBranchName")
    if (source) job.sourceBranch = source
    const target = stringField(azDo, "targetBranchName")
    if (target) job.targetBranch = target
    const workItemIds = numberArray(azDo.workItemIds)
    if (workItemIds) job.workItemIds = workItemIds
    const tags = stringArray(azDo.pullRequestTags)
    if (tags) job.pullRequestTags = tags
  }

  const metrics = value.sessionMetrics
  if (isRecord(metrics)) {
    const currentModel = stringField(metrics, "currentModel")
    if (currentModel) job.currentModel = currentModel
    const modelMetrics = metrics.modelMetrics
    if (isRecord(modelMetrics)) {
      const usage: Record<string, CloudAgentModelUsage | null> = {}
      for (const [model, entry] of Object.entries(modelMetrics)) {
        const parsed = usageFrom(entry)
        // `undefined` means malformed, `null` means the service recorded a
        // null entry (documented as possible on historical rows).
        if (parsed !== undefined) usage[model] = parsed
      }
      if (Object.keys(usage).length > 0) job.modelUsage = usage
    }
  }

  return job
}

export function readJobPage(value: unknown): CloudAgentJobPage {
  if (!isRecord(value)) {
    throw new CloudAgentError("Cloud Agent returned a job list that was not an object.", { retriable: true })
  }
  const rawData = value.data
  if (!Array.isArray(rawData)) {
    throw new CloudAgentError("Cloud Agent returned a job list without a `data` array.", { retriable: true })
  }
  const data = rawData.map((entry) => readJob(entry))
  const page: CloudAgentJobPage = {
    data,
    hasMore: value.hasMore === true,
  }
  const token = stringField(value, "continuationToken")
  if (token) page.continuationToken = token
  return page
}

export function readAgentPage(value: unknown): CloudAgentCatalogPage<CloudAgentAgentInfo> {
  return readCatalogPage(value, "agents", readAgent)
}

export function readPluginPage(value: unknown): CloudAgentCatalogPage<CloudAgentPluginInfo> {
  return readCatalogPage(value, "plugins", readPlugin)
}

/**
 * `GET /models` answers `{ "models": [...] }` (measured live 2026-10-31), not
 * the `value`/`totalCount` page shape the plugin and agent catalogs use, and
 * it takes no filters: the service ignores repository and organization here.
 */
export function readModelList(value: unknown): Array<CloudAgentModelInfo> {
  if (!isRecord(value)) {
    throw new CloudAgentError("Cloud Agent returned a model list that was not an object.", { retriable: true })
  }
  const raw = value.models
  if (!Array.isArray(raw)) {
    throw new CloudAgentError("Cloud Agent returned a model list without a `models` array.", { retriable: true })
  }
  return raw.filter(isRecord).map(readModel)
}

function readCatalogPage<T>(
  value: unknown,
  what: string,
  readEntry: (entry: Record<string, unknown>) => T,
): CloudAgentCatalogPage<T> {
  if (!isRecord(value)) {
    throw new CloudAgentError(`Cloud Agent returned a ${what} list that was not an object.`, { retriable: true })
  }
  const raw = value.value
  if (!Array.isArray(raw)) {
    throw new CloudAgentError(`Cloud Agent returned a ${what} list without a \`value\` array.`, { retriable: true })
  }
  const page: CloudAgentCatalogPage<T> = {
    value: raw.filter(isRecord).map(readEntry),
  }
  const totalCount = numberField(value, "totalCount")
  if (totalCount !== undefined) page.totalCount = totalCount
  const top = numberField(value, "top")
  if (top !== undefined) page.top = top
  const skip = numberField(value, "skip")
  if (skip !== undefined) page.skip = skip
  const errors = value.errors
  if (Array.isArray(errors)) {
    const messages = errors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    if (messages.length > 0) page.errors = messages
  }
  return page
}

function readAgent(entry: Record<string, unknown>): CloudAgentAgentInfo {
  const agent: CloudAgentAgentInfo = { name: stringField(entry, "name") ?? "?" }
  const type = stringField(entry, "type")
  if (type) agent.type = type
  const engine = stringField(entry, "engine")
  if (engine) agent.engine = engine
  const description = stringField(entry, "description")
  if (description) agent.description = description
  const inputs = entry.inputs
  if (isRecord(inputs)) {
    const declared: NonNullable<CloudAgentAgentInfo["inputs"]> = {}
    for (const [key, raw] of Object.entries(inputs)) {
      if (!isRecord(raw)) continue
      declared[key] = {
        ...(stringField(raw, "type") ? { type: stringField(raw, "type")! } : {}),
        ...(booleanField(raw, "required") !== undefined ? { required: booleanField(raw, "required")! } : {}),
        ...(stringField(raw, "description") ? { description: stringField(raw, "description")! } : {}),
      }
    }
    if (Object.keys(declared).length > 0) agent.inputs = declared
  }
  return agent
}

function readPlugin(entry: Record<string, unknown>): CloudAgentPluginInfo {
  const plugin: CloudAgentPluginInfo = { name: stringField(entry, "name") ?? "?" }
  const type = stringField(entry, "type")
  if (type) plugin.type = type
  const description = stringField(entry, "description")
  if (description) plugin.description = description
  const enabled = booleanField(entry, "enabledByDefault")
  if (enabled !== undefined) plugin.enabledByDefault = enabled
  return plugin
}

function readModel(entry: Record<string, unknown>): CloudAgentModelInfo {
  const model: CloudAgentModelInfo = { id: stringField(entry, "id") ?? "?" }
  const vendor = stringField(entry, "vendor")
  if (vendor) model.vendor = vendor
  const preview = booleanField(entry, "preview")
  if (preview !== undefined) model.preview = preview
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined
  const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined
  const limits = capabilities && isRecord(capabilities.limits) ? capabilities.limits : undefined
  const efforts = supports?.reasoningEffort
  if (Array.isArray(efforts)) {
    const known = efforts.filter((effort): effort is string => typeof effort === "string" && effort.trim().length > 0)
    if (known.length > 0) model.reasoningEffort = known
  }
  const context = limits ? numberField(limits, "maxContextWindowTokens") : undefined
  if (context !== undefined) model.maxContextWindowTokens = context
  const output = limits ? numberField(limits, "maxOutputTokens") : undefined
  if (output !== undefined) model.maxOutputTokens = output
  const billing = isRecord(entry.billing) ? entry.billing : undefined
  const multiplier = billing ? numberField(billing, "multiplier") : undefined
  if (multiplier !== undefined) model.billingMultiplier = multiplier
  const info = entry.infoMessages
  if (Array.isArray(info)) {
    const notices = info
      .map((message) => (isRecord(message) ? stringField(message, "message") : undefined))
      .filter((message): message is string => message !== undefined)
    if (notices.length > 0) model.notices = notices
  }
  return model
}

// --- Logs ------------------------------------------------------------------

/**
 * Parsing of `GET /jobs/{id}/logs`, whose shape is undocumented but was
 * measured against prod traces (233 KB–7.5 MB, 372–3991 messages):
 *
 * - `chatHistory` is a list of `{role: {label}, items: [...]}` where **every
 *   message carries exactly one item**, so the item list is walked but never
 *   assumed flat.
 * - Exactly three item types appear: `TextContent {text}`,
 *   `FunctionCallContent {id, functionName, arguments}` and
 *   `FunctionResultContent {callId, result}`. Calls and results are joined on
 *   the call's `id` matching the result's `callId` — nothing else correlates
 *   them, and a result of `null` is normal (measured on 6–21 rows per trace).
 * - `TextContent` is frequently EMPTY: 127 of 178 in one trace. Those carry no
 *   information and are dropped, which is why `assistantTexts` is not
 *   `messageCount`-shaped.
 * - `result` is `{content}` or `{content, detailedContent}`; `detailedContent`
 *   is the same text with a status prefix, except on a few agent-run tools
 *   where it is the only place a real diff appears. `toolDiffs` is `[]` on
 *   every sampled job, so it is never read.
 * - The deliverable is `task_complete.arguments.summary` — NOT the last
 *   assistant message, which is usually narration. A failed job has no
 *   `task_complete` at all.
 */
export function readJobLogs(value: unknown): CloudAgentJobLogs {
  if (!isRecord(value)) {
    throw new CloudAgentError("Cloud Agent returned job logs that were not an object.", { retriable: true })
  }
  const logs: CloudAgentJobLogs = {
    messageCount: 0,
    assistantTexts: [],
    toolCalls: [],
    histogram: [],
    changedFiles: [],
    unrecognizedItems: 0,
  }
  const id = stringField(value, "id")
  if (id) logs.id = id
  const createdAt = timestampField(value, "createdAt")
  if (createdAt) logs.createdAt = createdAt
  const updatedAt = timestampField(value, "updatedAt")
  if (updatedAt) logs.updatedAt = updatedAt

  // A queued job legitimately has no history yet; that is an empty trace, not a
  // malformed response. Only a non-object body is an error.
  const history = Array.isArray(value.chatHistory) ? value.chatHistory : []
  logs.messageCount = history.length

  const callsById = new Map<string, CloudAgentToolCall>()
  const results = new Map<string, { result?: string; detail?: string }>()
  const seenFiles = new Set<string>()
  const changedFiles: Array<string> = []
  const addFile = (raw: string): void => {
    const path = normalizeTracePath(raw)
    if (!path || seenFiles.has(path)) return
    seenFiles.add(path)
    changedFiles.push(path)
  }

  for (const message of history) {
    if (!isRecord(message)) {
      logs.unrecognizedItems++
      continue
    }
    const role = isRecord(message.role) ? stringField(message.role, "label") : undefined
    const items = Array.isArray(message.items) ? message.items : []
    if (items.length === 0) {
      logs.unrecognizedItems++
      continue
    }
    for (const item of items) {
      if (!isRecord(item)) {
        logs.unrecognizedItems++
        continue
      }
      const type = stringField(item, "$type")
      if (type === "TextContent") {
        const text = stringField(item, "text")
        // Only assistant prose: the trace also holds the submitted prompt under
        // a `user` label, and putting that in `assistantTexts` would make the
        // digest look like the agent's own words.
        if (text && role === "assistant") logs.assistantTexts.push(text)
        continue
      }
      if (type === "FunctionCallContent") {
        const name = stringField(item, "functionName")
        if (!name) {
          logs.unrecognizedItems++
          continue
        }
        const args = argumentsField(item.arguments)
        const call: CloudAgentToolCall = { name, args }
        const callId = stringField(item, "id")
        if (callId) callsById.set(callId, call)
        logs.toolCalls.push(call)
        if (name === "task_complete") {
          const summary = stringField(args, "summary")
          // Last one wins: a retried completion supersedes the earlier attempt.
          if (summary) logs.summary = summary
        }
        if (WRITE_TOOL_NAMES.has(name)) {
          const path = args.path ?? args.file_path
          if (typeof path === "string") addFile(path)
        }
        continue
      }
      if (type === "FunctionResultContent") {
        const callId = stringField(item, "callId")
        const raw = item.result
        const result = isRecord(raw) ? stringField(raw, "content") : undefined
        const detail = isRecord(raw) ? stringField(raw, "detailedContent") : undefined
        if (callId && (result || detail)) {
          results.set(callId, { ...(result ? { result } : {}), ...(detail ? { detail } : {}) })
        }
        // Any result can hold a diff: the agent usually produces one by running
        // `git diff` in a shell, so restricting this to write tools would miss
        // every changed file the shell reported.
        if (result) collectDiffPaths(result, addFile)
        if (detail) collectDiffPaths(detail, addFile)
        continue
      }
      logs.unrecognizedItems++
    }
  }

  for (const [callId, found] of results) {
    const call = callsById.get(callId)
    if (!call) continue
    if (found.result) call.result = found.result
    if (found.detail) call.detail = found.detail
  }

  const counts = new Map<string, number>()
  for (const call of logs.toolCalls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  logs.histogram = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  logs.changedFiles = changedFiles
  return logs
}

/**
 * Tools whose `path`/`file_path` argument names a file the agent changed.
 *
 * Deliberately a small allowlist: `view`, `grep`, `glob` and the `ado-*` readers
 * also take a path, and counting a read as a change would fill the digest with
 * files the job only looked at. `apply_patch` is absent because the service
 * records its arguments as `{}` — its diff is recovered from the result text.
 */
const WRITE_TOOL_NAMES = new Set(["edit", "create", "write"])

/**
 * Session scaffolding the agent writes for itself, not part of the repository
 * change. Matched on normalized repository-relative paths so a real source file
 * that merely contains the word is not dropped.
 */
const SCAFFOLDING_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.engram\//,
  /^\.copilot\//,
  /\/session-state\//,
  /^home\//,
  /^tmp\//,
  // The agent's own runtime, measured on a live Windows job: plugin bundles are
  // staged under `%LOCALAPPDATA%\agency\plugins\sessions\` and review artifacts
  // under `%TEMP%\agency-review\`. Those are absolute paths, so the
  // checkout-prefix strips below leave them intact, and one real job reported 15
  // such scratch files ahead of the single source file it actually edited.
  // Anchored on the AppData segment so a repository file that merely lives in a
  // directory called `cloudagent` is unaffected.
  /\/appdata\/local\/(?:agency|temp)\//i,
]

/**
 * Normalize a path from a tool argument or a diff header to a
 * repository-relative POSIX path.
 *
 * The agent runs inside an Azure Pipelines checkout, so its own paths carry the
 * agent's prefix, and both measured forms appear in real traces:
 * `/mnt/vss/_work/1/s/packages/...` (Linux) and `F:\1\s\source\...` (Windows).
 * Diff headers from git are already relative (`a/source/...`).
 */
function normalizeTracePath(raw: string): string | undefined {
  let path = raw.trim().replace(/\\/g, "/")
  path = path.replace(/^"|"$/g, "")
  if (!path) return undefined
  path = path.replace(/^\/?mnt\/vss\/_work\/\d+\/s\//, "")
  // The Windows checkout root carries one extra segment: the measured form is
  // `F:\s\source\...`, so stripping `F:/1/s/` alone would leave `source/`
  // glued to every path. Optional because the Linux form above has no such
  // segment.
  path = path.replace(/^[A-Za-z]:\/\d+\/s\/(?:source\/)?/, "")
  path = path.replace(/^\.\//, "").replace(/^\/+/, "")
  if (!path || path === "dev/null") return undefined
  if (SCAFFOLDING_PATH_PATTERNS.some((pattern) => pattern.test(path))) return undefined
  return path
}

/** Tool `arguments`, which arrive as an object and occasionally as JSON text. */
function argumentsField(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Collect `diff --git` header paths from a result body.
 *
 * The guard keeps the common case (no diff) to one `includes`, since a trace can
 * hold several megabytes of results and the regex would otherwise scan it all.
 */
function collectDiffPaths(text: string, addFile: (path: string) => void): void {
  if (!text.includes("diff --git ")) return
  const header = /^diff --git (.+)$/gm
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const path = diffHeaderPath(match[1]!)
    if (path) addFile(path)
  }
}

/** `a/<path> b/<path>`, quoted by git when the path needs it. */
function diffHeaderPath(header: string): string | undefined {
  const stripped = header.trim()
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(stripped)
  if (quoted) return quoted[2]
  // Greedy on the first group so a path that itself contains " b/" still
  // splits at the last separator.
  const plain = /^a\/(.+) b\/(.+)$/.exec(stripped)
  if (plain) return plain[2]
  return undefined
}

// --- Rendering -------------------------------------------------------------

const MAX_PROMPT_CHARS = 800
const MAX_DESCRIPTION_CHARS = 400
const MAX_RENDERED_ROWS = 200

function truncate(value: string, max: number): string {
  const single = value.replace(/\s*\r?\n\s*/g, " ⏎ ")
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/**
 * Render one job as labelled lines instead of wire JSON.
 *
 * `result` and `jobOutcomeType` are BOTH printed, with their distinct meanings
 * spelled out. The docs warn that a job can be `state: Completed` with
 * `outcome.code: Succeeded` while `result` is `Failure` — the classifier judged
 * the WORK unsuccessful. Dropping either field would leave the model inferring
 * one from the other, which is the exact mistake the doc calls out.
 */
export function renderJob(job: CloudAgentJob, opts: { summary?: string; note?: string } = {}): string {
  const lines: Array<string> = [`Job ${job.jobId}`]
  if (opts.note) lines.push(opts.note)
  // The deliverable comes before every diagnostic field. A model quotes the top
  // of a tool result, so a summary below five metadata lines is a summary the
  // caller never uses.
  if (opts.summary) {
    lines.push("")
    lines.push("summary (the job's deliverable):")
    lines.push(opts.summary)
    lines.push("")
  }
  if (job.state) lines.push(`state: ${job.state}`)
  if (job.outcomeCode) {
    lines.push(
      job.outcomeDescription
        ? `outcome: ${job.outcomeCode} — ${truncate(job.outcomeDescription, MAX_DESCRIPTION_CHARS)}`
        : `outcome: ${job.outcomeCode}`,
    )
  }
  if (job.jobOutcomeType) lines.push(`jobOutcomeType (who is responsible): ${job.jobOutcomeType}`)
  if (job.result) lines.push(`result (legacy classifier verdict on the work): ${job.result}`)
  // A successful job carries the placeholder "No reason provided.", which reads
  // as a problem when printed. Only a reason that says something is shown.
  if (job.reason && job.reason.trim().toLowerCase() !== "no reason provided.") {
    lines.push(`reason (legacy diagnostic): ${truncate(job.reason, MAX_DESCRIPTION_CHARS)}`)
  }
  if (job.repository) lines.push(`repository: ${job.repository}`)
  if (job.metadata) {
    const labels = Object.entries(job.metadata).map(([key, value]) => `${key}=${value}`)
    if (labels.length > 0) lines.push(`metadata: ${labels.join(" ")}`)
  }
  if (job.plugins && job.plugins.length > 0) lines.push(`plugins: ${job.plugins.join(", ")}`)
  if (job.pullRequestId !== undefined) {
    const branches = job.sourceBranch && job.targetBranch
      ? ` (${job.sourceBranch} -> ${job.targetBranch})`
      : job.sourceBranch ? ` (${job.sourceBranch})` : ""
    lines.push(`pull request: #${job.pullRequestId}${branches}`)
  } else if (job.sourceBranch) {
    lines.push(`branch: ${job.sourceBranch}`)
  }
  if (job.workItemIds && job.workItemIds.length > 0) {
    lines.push(`work items: ${job.workItemIds.join(", ")}`)
  }
  if (job.pullRequestTags && job.pullRequestTags.length > 0) {
    lines.push(`pull request tags: ${job.pullRequestTags.join(", ")}`)
  }
  if (job.prompt) lines.push(`prompt: ${truncate(job.prompt, MAX_PROMPT_CHARS)}`)
  if (job.requesterName) lines.push(`requested by: ${job.requesterName}`)
  if (job.initiatingUserName && job.initiatingUserName !== job.requesterName) {
    lines.push(`initiated by: ${job.initiatingUserName}`)
  }
  if (job.source) lines.push(`started from: ${job.source}`)
  if (job.createdAt) lines.push(`created: ${job.createdAt}`)
  if (job.updatedAt) lines.push(`updated: ${job.updatedAt}`)
  if (job.dispatchAfter) lines.push(`dispatch after: ${job.dispatchAfter} (the job waits in the queue until then)`)
  // `definitionId: 0` is a sentinel on a real job, so only a positive value is
  // worth a line; `runId` alone is enough to find the Azure Pipelines run.
  if (job.pipelineRun?.runId !== undefined) {
    const definition = job.pipelineRun.definitionId !== undefined && job.pipelineRun.definitionId > 0
      ? ` (definition ${job.pipelineRun.definitionId})`
      : ""
    lines.push(`pipeline run id: ${job.pipelineRun.runId}${definition}`)
  }
  if (job.isRetryable !== undefined) lines.push(`retryable: ${job.isRetryable ? "yes" : "no"}`)
  if (job.modelName) lines.push(`model requested: ${job.modelName}`)
  if (job.currentModel && job.currentModel !== job.modelName) {
    lines.push(`model at session end: ${job.currentModel}`)
  }
  if (job.modelUsage) {
    const usage = Object.entries(job.modelUsage).map(([model, entry]) => {
      if (entry === null) return `${model}: (recorded as null)`
      const parts: Array<string> = []
      if (entry.inputTokens !== undefined) parts.push(`in ${entry.inputTokens}`)
      if (entry.outputTokens !== undefined) parts.push(`out ${entry.outputTokens}`)
      if (entry.cacheReadTokens !== undefined) parts.push(`cache read ${entry.cacheReadTokens}`)
      if (entry.cacheWriteTokens !== undefined) parts.push(`cache write ${entry.cacheWriteTokens}`)
      return `${model}: ${parts.length > 0 ? parts.join(", ") : "(no token counts)"}`
    })
    if (usage.length > 0) lines.push(`tokens: ${usage.join("; ")}`)
  }
  return lines.join("\n")
}

/**
 * States that mean the job will not change again, so a poll is pointless and a
 * `get_job` answer is final.
 *
 * Lowercased because the service uses PascalCase (`Completed`) while older
 * rows and docs also spell `Succeeded`; both spellings of cancel appear in the
 * wild. Deliberately matched by name rather than by "anything not InProgress",
 * so a state this file has never seen stays non-terminal and keeps being
 * polled instead of being declared finished.
 */
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "succeeded",
])

export function isTerminalJob(job: CloudAgentJob): boolean {
  return job.state !== undefined && TERMINAL_JOB_STATES.has(job.state.trim().toLowerCase())
}

/**
 * Queued is the state before compute is allocated. `wait_for_job` exists to
 * distinguish "still queued" from "started", so it needs this as much as it
 * needs terminality.
 */
export function isQueuedJob(job: CloudAgentJob): boolean {
  return job.state !== undefined && job.state.trim().toLowerCase() === "queued"
}

/**
 * The cadence line on a live poll.
 *
 * Without it a model re-polls on every turn against a job whose minimum
 * observed runtime is 13 minutes (median 221), which burns context and tokens
 * to learn nothing. The elapsed figure is what tells the caller whether a
 * multi-hour job is young or overdue.
 */
export function renderPollHint(job: CloudAgentJob, now: number = Date.now()): string {
  const elapsed = elapsedMinutes(job.createdAt, now)
  const since = elapsed !== undefined ? `job created ${elapsed} min ago` : "creation time not reported"
  if (isQueuedJob(job)) {
    return `next: check again in ~2 min; ${since}. Still queued means no compute has been allocated yet — if this persists well past a few minutes the queue is the problem, not the job.`
  }
  return `next: check again in ~10 min; ${since}. A typical job runs for hours, so checking more often than that will only repeat this answer.`
}

function elapsedMinutes(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined
  const started = Date.parse(iso)
  if (Number.isNaN(started)) return undefined
  const minutes = Math.floor((now - started) / 60_000)
  return minutes < 0 ? undefined : minutes
}

/**
 * Render a digested trace: what the job did, and what it left behind.
 *
 * The trace is the only place a job's work is visible — `toolDiffs` is `[]` on
 * every sampled job — but it is also 233 KB to 7.5 MB, so the digest is what
 * makes it usable: a one-line histogram conveys the shape of four thousand
 * messages, and the changed files answer "what did it touch" without reading
 * the run.
 *
 * The final tool call's result is shown because for a FAILED job there is no
 * `task_complete` summary, and the last thing the agent saw before dying is the
 * only diagnosis available.
 */
export function renderTrace(logs: CloudAgentJobLogs, opts: { tail?: number } = {}): string {
  const tail = opts.tail ?? 12
  const lines: Array<string> = []
  const counts = `${logs.messageCount} message(s), ${logs.toolCalls.length} tool call(s)`
  lines.push(logs.id ? `trace for job ${logs.id}: ${counts}` : `trace: ${counts}`)
  if (logs.createdAt) {
    lines.push(`recorded: ${logs.createdAt}${logs.updatedAt ? ` -> ${logs.updatedAt}` : ""}`)
  }

  if (logs.summary) {
    lines.push("")
    lines.push("summary (the job's deliverable):")
    lines.push(logs.summary)
  } else if (logs.toolCalls.length > 0) {
    lines.push("")
    lines.push(
      "summary: none — the job never called task_complete, so it produced no deliverable. A job that fails has no summary; read the recent tool calls below for why.",
    )
  }

  if (logs.histogram.length > 0) {
    lines.push("")
    lines.push(`tool use: ${logs.histogram.map((entry) => `${entry.name}=${entry.count}`).join(" ")}`)
  }

  if (logs.changedFiles.length > 0) {
    const shown = logs.changedFiles.slice(0, MAX_CHANGED_FILES)
    lines.push("")
    lines.push(`changed files (${logs.changedFiles.length})${logs.changedFiles.length > shown.length ? `, first ${shown.length}` : ""}:`)
    for (const file of shown) lines.push(`  ${file}`)
    if (logs.changedFiles.length > shown.length) {
      lines.push(`  … ${logs.changedFiles.length - shown.length} more; mode: "full" has the whole trace.`)
    }
  }

  const last = lastAssistantText(logs.assistantTexts)
  if (last) {
    lines.push("")
    lines.push(`last agent message: ${truncate(last, MAX_LAST_MESSAGE_CHARS)}`)
  }

  if (logs.toolCalls.length > 0) {
    const calls = logs.toolCalls.slice(-Math.max(tail, 0))
    if (calls.length > 0) {
      lines.push("")
      lines.push(`recent tool calls (last ${calls.length}):`)
      for (const call of calls) lines.push(`  ${renderToolCall(call)}`)
    }
    // The final result belongs to the final call, rendered directly beneath it
    // so the diagnosis is attached to the call that produced it rather than
    // appearing as an unlabelled block at the end.
    const finalResult = lastToolResult(logs.toolCalls)
    if (finalResult) {
      lines.push("")
      lines.push("final tool result (the last thing the agent saw):")
      lines.push(finalResult)
    }
  }

  if (logs.unrecognizedItems > 0) {
    lines.push("")
    lines.push(
      `note: ${logs.unrecognizedItems} trace item(s) were not in a shape this proxy models and were skipped; they are present in mode: "full".`,
    )
  }

  return lines.join("\n")
}

const MAX_CHANGED_FILES = 40
const MAX_LAST_MESSAGE_CHARS = 1200
const MAX_TOOL_RESULT_CHARS = 1500

function lastAssistantText(texts: ReadonlyArray<string>): string | undefined {
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index]?.trim()
    if (text) return text
  }
  return undefined
}

function renderToolCall(call: CloudAgentToolCall): string {
  const args = Object.keys(call.args).length > 0 ? ` ${truncate(JSON.stringify(call.args), 200)}` : ""
  return `${call.name}${args}`
}

/**
 * A bounded slice of the final call's result, from the END where possible: the
 * failure is at the tail of a build log, and the head is boilerplate.
 */
function lastToolResult(calls: ReadonlyArray<CloudAgentToolCall>): string | undefined {
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]
    const text = (call?.detail ?? call?.result ?? "").trim()
    if (!text) continue
    const bounded = text.length > MAX_TOOL_RESULT_CHARS
      ? `…${text.slice(text.length - MAX_TOOL_RESULT_CHARS)}`
      : text
    return bounded
  }
  return undefined
}

/** One line per job, so a page of 25 costs a screen rather than a transcript. */
/**
 * Compact `{chain=research step=1 +2}` label for a list row.
 *
 * Metadata is the only field on a job that a caller controls and can search by,
 * so a listing that dropped it would make the chain convention (`create_job`
 * stores `{chain, step}`) invisible exactly where a model looks for the earlier
 * steps. Capped at four pairs / 60 characters because this rides on one line of
 * a page that can hold 100 rows; the remainder is counted, not printed.
 */
const PAGE_LABEL_PAIRS = 4
const PAGE_LABEL_CHARS = 60

export function renderMetadataBrief(metadata?: Record<string, string>): string {
  if (!metadata) return ""
  const pairs = Object.entries(metadata).filter(([, value]) => value.length > 0)
  if (pairs.length === 0) return ""
  const shown: Array<string> = []
  let budget = PAGE_LABEL_CHARS
  for (const [key, value] of pairs.slice(0, PAGE_LABEL_PAIRS)) {
    const pair = `${key}=${value}`
    if (shown.length > 0 && pair.length > budget) break
    shown.push(pair)
    budget -= pair.length + 1
  }
  const hidden = pairs.length - shown.length
  return `[${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}]`
}

export function renderJobPage(page: CloudAgentJobPage): string {
  if (page.data.length === 0) return "No jobs matched."
  const rows = page.data.map((job) => {
    const state = job.state ?? "?"
    const outcome = job.outcomeCode ?? job.result ?? ""
    const when = job.createdAt ?? ""
    const repo = job.repository ?? ""
    const pr = job.pullRequestId !== undefined ? `PR#${job.pullRequestId}` : ""
    const labels = renderMetadataBrief(job.metadata)
    const prompt = job.prompt ? truncate(job.prompt, 120) : ""
    const tail = [repo, pr, labels, prompt].filter((part) => part.length > 0).join("  ")
    return `${job.jobId}  ${state}${outcome ? `  ${outcome}` : ""}  ${when}${tail ? `  ${tail}` : ""}`
  })
  const lines = [`${page.data.length} job(s):`, ...rows]
  if (page.hasMore) {
    lines.push("")
    lines.push(
      page.continuationToken
        ? `More results available. Pass continuationToken "${page.continuationToken}" to continue.`
        : "More results available, but the service returned no continuationToken.",
    )
  }
  return lines.join("\n")
}

/**
 * Render an agents or plugins page.
 *
 * Agent `inputs` are printed because they are the only way a caller can fill
 * `customAgent.inputs` correctly: the service rejects a job whose agent is
 * missing a required input, and nothing else in the surface reveals the names.
 */
export function renderAgentPage(page: CloudAgentCatalogPage<CloudAgentAgentInfo>): string {
  const header = catalogHeader("agent", page)
  if (page.value.length === 0) return finishCatalog(header, [], page, "No agents matched.")
  const rows = page.value.slice(0, MAX_RENDERED_ROWS).map((agent) => {
    const head = `  ${agent.name}${agent.type ? ` [${agent.type}]` : ""}${agent.engine ? ` (engine: ${agent.engine})` : ""}`
    const lines = [head]
    if (agent.description) lines.push(`    ${truncate(agent.description, MAX_DESCRIPTION_CHARS)}`)
    if (agent.inputs) {
      const inputs = Object.entries(agent.inputs).map(([key, spec]) => {
        const kind = spec.type ?? "unknown"
        const required = spec.required === true ? "required" : "optional"
        const description = spec.description ? ` — ${truncate(spec.description, 200)}` : ""
        return `${key} (${kind}, ${required})${description}`
      })
      lines.push(`    inputs: ${inputs.join("; ")}`)
    }
    return lines.join("\n")
  })
  return finishCatalog(header, rows, page)
}

export function renderPluginPage(page: CloudAgentCatalogPage<CloudAgentPluginInfo>): string {
  const header = catalogHeader("plugin", page)
  if (page.value.length === 0) return finishCatalog(header, [], page, "No plugins matched.")
  const rows = page.value.slice(0, MAX_RENDERED_ROWS).map((plugin) => {
    const flags = [
      plugin.type ? `[${plugin.type}]` : "",
      plugin.enabledByDefault === true ? "(enabled by default)" : "",
    ].filter((part) => part.length > 0).join(" ")
    const description = plugin.description ? ` — ${truncate(plugin.description, MAX_DESCRIPTION_CHARS)}` : ""
    return `  ${plugin.name}${flags ? ` ${flags}` : ""}${description}`
  })
  return finishCatalog(header, rows, page)
}

/**
 * Render the model catalog.
 *
 * Effort values are printed per row because the ladder is not uniform: measured
 * live, 8 of 25 models do not accept `max`, so a caller that assumes every
 * model takes the tier default would get a 400 it could have avoided by
 * reading the row. `modelPickerCategory` and `modelPickerEnabled` are
 * deliberately dropped — they describe a UI grouping, not a capability.
 */
export function renderModelPage(models: ReadonlyArray<CloudAgentModelInfo>): string {
  if (models.length === 0) return "No models were returned."
  const rows = models.slice(0, MAX_RENDERED_ROWS).map((model) => {
    const tags = [model.vendor, model.preview === true ? "preview" : undefined]
      .filter((part): part is string => part !== undefined && part.length > 0)
    const details = [
      model.maxContextWindowTokens !== undefined ? `context ${formatTokenCount(model.maxContextWindowTokens)}` : "",
      model.maxOutputTokens !== undefined ? `max output ${formatTokenCount(model.maxOutputTokens)}` : "",
      model.reasoningEffort && model.reasoningEffort.length > 0 ? `effort ${model.reasoningEffort.join("/")}` : "",
      model.billingMultiplier !== undefined && model.billingMultiplier > 1 ? `cost ×${model.billingMultiplier}` : "",
    ].filter((part) => part.length > 0)
    const lines = [`  ${model.id}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""}${details.length > 0 ? ` — ${details.join("; ")}` : ""}`]
    for (const notice of model.notices ?? []) lines.push(`    note: ${truncate(notice, 240)}`)
    return lines.join("\n")
  })
  const header = models.length > MAX_RENDERED_ROWS
    ? `${models.length} model(s) (first ${MAX_RENDERED_ROWS} shown):`
    : `${models.length} model(s):`
  return [header, ...rows].join("\n")
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 100) / 100}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function catalogHeader(kind: string, page: CloudAgentCatalogPage<unknown>): string {
  const total = page.totalCount !== undefined ? ` of ${page.totalCount}` : ""
  const window = [
    page.top !== undefined ? `top ${page.top}` : "",
    page.skip !== undefined && page.skip > 0 ? `skip ${page.skip}` : "",
  ].filter((part) => part.length > 0).join(", ")
  return `${page.value.length}${total} ${kind}(s)${window ? ` (${window})` : ""}:`
}

/**
 * Render a page and, when the service explained itself, say so.
 *
 * A Repo or Organization scope answers HTTP 200 with an empty page and the
 * reason in `errors` ("Marketplace manifest not found at …"), so an empty
 * result is usually not "nothing exists" but "the thing this scope reads
 * looked elsewhere". Dropping the reason made those two indistinguishable.
 * On a non-empty page the errors classify the rows instead, hence the
 * different label: `reason:` explains an emptiness, `partial results:`
 * qualifies a list.
 */
function finishCatalog(
  header: string,
  rows: Array<string>,
  page: CloudAgentCatalogPage<unknown>,
  empty?: string,
): string {
  const lines = [header, ...rows]
  if (rows.length === 0 && empty) lines.push(`  ${empty}`)
  if (page.value.length > MAX_RENDERED_ROWS) {
    lines.push(`  … ${page.value.length - MAX_RENDERED_ROWS} more not rendered; raise \`skip\` to page.`)
  }
  if (page.errors && page.errors.length > 0) {
    const label = rows.length === 0 ? "reason" : "partial results"
    lines.push(`${label}: ${page.errors.map((error) => truncate(error, 300)).join("; ")}`)
  }
  return lines.join("\n")
}

// --- Transport -------------------------------------------------------------

export interface CloudAgentClientOpts {
  environment: CloudAgentEnvironment
  /** Test seam: replaces the `az`-backed token cache. */
  tokenProvider?: (signal?: AbortSignal) => Promise<string>
  /** Test seam: replaces global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Test seam: replaces the retry ladder. An empty array makes every retriable
   * verdict final, so a suite asserts the VERDICT without paying the backoff.
   */
  retryDelaysMs?: ReadonlyArray<number>
}

/**
 * One successful response, as both a parsed value and the bytes it came from.
 *
 * The raw text is kept because the log trace is the one endpoint whose body can
 * legitimately be handed to the caller untouched, and re-serializing a 7.5 MB
 * trace to get it back doubles peak memory to produce something that is not
 * byte-identical to what the service sent.
 */
interface CloudAgentResult {
  value: unknown
  text: string
}

/**
 * Process-lifetime token cache, keyed by the Entra RESOURCE rather than the
 * base URL: two environments are two audiences, and a token minted for one is
 * not accepted by the other.
 */
const cloudAgentTokenCache = new AzCliAccessTokenCache()

export class CloudAgentClient {
  readonly environment: CloudAgentEnvironment
  readonly baseUrl: string
  private readonly resource: string
  private readonly fetchImpl: typeof fetch
  private readonly tokenProvider: (signal?: AbortSignal) => Promise<string>
  private readonly retryDelaysMs: ReadonlyArray<number>

  constructor(opts: CloudAgentClientOpts) {
    this.environment = opts.environment
    const endpoints = ENVIRONMENT_ENDPOINTS[opts.environment]
    this.baseUrl = endpoints.baseUrl
    this.resource = endpoints.resource
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.tokenProvider = opts.tokenProvider ?? ((signal) => getCloudAgentToken(this.resource, signal))
    this.retryDelaysMs = opts.retryDelaysMs ?? CLOUDAGENT_RETRY_DELAYS_MS
  }

  /**
   * One logical request: attempt, classify, retry when the caller marked the
   * call safe to repeat. A 401 is retried exactly once for EVERY method,
   * including `createJob`, because a rejected request had no effect — that is
   * not the same as replaying a write that may have landed.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown
      query?: Record<string, string | number | undefined>
      signal?: AbortSignal
      retry: boolean
      cap: number
      what: string
    },
  ): Promise<CloudAgentResult> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attemptOnce(method, path, opts)
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err
        if (err instanceof CloudAgentError && err.status === 401 && !refreshed) {
          refreshed = true
          continue
        }
        const retriable = err instanceof CloudAgentError ? err.retriable : true
        if (!opts.retry || !retriable || attempt >= this.retryDelaysMs.length) throw err
        const hint = err instanceof CloudAgentError ? err.retryAfterMs : undefined
        await sleep(hint ?? this.retryDelaysMs[attempt]!, opts.signal)
      }
    }
  }

  private async attemptOnce(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown
      query?: Record<string, string | number | undefined>
      signal?: AbortSignal
      cap: number
      what: string
    },
  ): Promise<CloudAgentResult> {
    const token = await this.tokenProvider(opts.signal)
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"))
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error("Cloud Agent request timed out")), REQUEST_TIMEOUT_MS)
    timer.unref?.()

    let res: Response
    try {
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(opts.body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: controller.signal,
        })
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted")
        throw new CloudAgentError(`Cloud Agent transport failed: ${sanitizeRemoteDetail(err)}`, {
          retriable: true,
        })
      }

      if (res.status === 401) {
        // The cached token is no longer accepted. Drop it so the retry (and
        // every later call) mints a fresh one instead of replaying the dead
        // value.
        cloudAgentTokenCache.invalidate(this.resource)
        throw new CloudAgentError(
          "Cloud Agent rejected the access token (HTTP 401). Verify `az login` targets the tenant that owns Cloud Agent, then retry.",
          { retriable: false, status: 401 },
        )
      }
      if (res.status === 403) {
        // A valid identity without the entitlement: do NOT invalidate the
        // token, and do not tell the operator to re-authenticate against a
        // credential that is fine. The service's own text names the missing
        // grant, so it is read and reported rather than replaced by a guess.
        const detail = await readBoundedBody(res, opts.cap, opts.what)
        throw new CloudAgentError(
          `Cloud Agent refused the request (HTTP 403): ${cloudAgentErrorDetail(detail)} `
            + "The token was accepted; this is an authorization verdict for the repository or the caller.",
          { retriable: false, status: 403 },
        )
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"))
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        throw new CloudAgentError(`Cloud Agent responded with HTTP ${res.status}.`, {
          retriable: true,
          status: res.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        })
      }
      const text = await readBoundedBody(res, opts.cap, opts.what)
      if (!res.ok) {
        if (res.status === 404) {
          // A job id is the composite "<org>-<uuid>" string the service prints,
          // not the UUID inside it, so the most likely cause of a 404 here is a
          // truncated id rather than a deleted job. "HTTP 404: Not Found" gives
          // the model nothing to change; naming the format turns a dead end
          // into the next call.
          const jobId = jobIdFromPath(path)
          if (jobId) {
            throw new CloudAgentError(
              `No job with id "${jobId}" exists in the ${this.environment} environment (HTTP 404). `
                + "A job id is the full \"<org>-<uuid>\" string that create_job and list_jobs return; "
                + "a bare UUID does not resolve. list_jobs shows the ids this account can see.",
              { retriable: false, status: 404 },
            )
          }
        }
        throw new CloudAgentError(
          `Cloud Agent responded with HTTP ${res.status}: ${cloudAgentErrorDetail(text)}`,
          { retriable: false, status: res.status },
        )
      }
      if (!text.trim()) return { value: null, text }
      try {
        return { value: JSON.parse(text) as unknown, text }
      } catch {
        throw new CloudAgentError("Cloud Agent returned a response that was not JSON.", { retriable: true })
      }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  /** `POST /v2/jobs` — creates the job. NOT retried (see the module comment). */
  async createJob(request: GenericJobRequest, signal?: AbortSignal): Promise<CloudAgentJob> {
    const { value } = await this.request("POST", "/v2/jobs", {
      body: request,
      retry: false,
      cap: MAX_RESPONSE_BYTES,
      what: "job",
      ...(signal ? { signal } : {}),
    })
    return readJob(value)
  }

  /** `POST /v2/jobs/validate` — same body, creates nothing, safe to repeat. */
  async validateJob(request: GenericJobRequest, signal?: AbortSignal): Promise<CloudAgentJob> {
    const { value } = await this.request("POST", "/v2/jobs/validate", {
      body: request,
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "validation",
      ...(signal ? { signal } : {}),
    })
    return readJob(value)
  }

  /** `GET /jobs/{jobId}` — the only source of a job's current outcome. */
  async getJob(jobId: string, signal?: AbortSignal): Promise<CloudAgentJob> {
    const { value } = await this.request("GET", `/jobs/${assertJobId(jobId)}`, {
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "job",
      ...(signal ? { signal } : {}),
    })
    return readJob(value)
  }

  /** `GET /jobs` — jobs the authenticated caller can see. */
  async listJobs(
    query: {
      organization?: string
      project?: string
      repository?: string
      pullRequestId?: number
      pageSize?: number
      continuationToken?: string
    } = {},
    signal?: AbortSignal,
  ): Promise<CloudAgentJobPage> {
    const { value } = await this.request("GET", "/jobs", {
      query: {
        organization: query.organization,
        project: query.project,
        repository: query.repository,
        pullRequestId: query.pullRequestId,
        pageSize: query.pageSize,
        continuationToken: query.continuationToken,
      },
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "job list",
      ...(signal ? { signal } : {}),
    })
    return readJobPage(value)
  }

  /**
   * `POST /jobs/{jobId}/cancel`. The v1-shaped route, deliberately: the docs
   * state there is no `/v2/.../cancel`.
   *
   * 202 means "requested" and carries no body; 200 means the job is already
   * cancelled and carries the job. Both are returned as a verdict because the
   * caller's next action is the same either way — poll `getJob` until a
   * terminal state — but only the 200 can report a final outcome immediately.
   */
  async cancelJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<{ alreadyCancelled: boolean; job?: CloudAgentJob }> {
    const id = assertJobId(jobId)
    const { value } = await this.request("POST", `/jobs/${id}/cancel`, {
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "cancel request",
      ...(signal ? { signal } : {}),
    })
    if (value === null) return { alreadyCancelled: false }
    return { alreadyCancelled: true, job: readJob(value) }
  }

  /** `GET /jobs/{jobId}/logs`, parsed into the digest shape. */
  async getJobLogs(jobId: string, signal?: AbortSignal): Promise<CloudAgentJobLogs> {
    const { value } = await this.fetchLogs(jobId, signal)
    return readJobLogs(value)
  }

  /**
   * `GET /jobs/{jobId}/logs`, returned as the service's own bytes.
   *
   * For a caller who wants the whole trace after the digest showed them where
   * to look. The text comes from the response body, so it is neither
   * re-serialized nor re-parsed; the MCP boundary's `relaySafeText` then spills
   * anything over its cap to a file, which is what makes a 7.5 MB trace
   * recoverable rather than clipped.
   */
  async getJobLogsText(jobId: string, signal?: AbortSignal): Promise<string> {
    const { text } = await this.fetchLogs(jobId, signal)
    return text
  }

  private async fetchLogs(jobId: string, signal?: AbortSignal): Promise<CloudAgentResult> {
    const id = assertJobId(jobId)
    const result = await this.request("GET", `/jobs/${id}/logs`, {
      retry: true,
      cap: MAX_LOGS_BYTES,
      what: "job logs",
      ...(signal ? { signal } : {}),
    })
    if (!isRecord(result.value)) {
      throw new CloudAgentError("Cloud Agent returned job logs that were not an object.", { retriable: true })
    }
    return result
  }

  /** `GET /plugins` — what a job can load. */
  async listPlugins(
    query: CloudAgentCatalogQuery = {},
    signal?: AbortSignal,
  ): Promise<CloudAgentCatalogPage<CloudAgentPluginInfo>> {
    const { value } = await this.request("GET", "/plugins", {
      query: catalogQueryParams(query),
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "plugin list",
      ...(signal ? { signal } : {}),
    })
    return readPluginPage(value)
  }

  /** `GET /agents` — what a `customAgent` can name, and the inputs it needs. */
  async listAgents(
    query: CloudAgentCatalogQuery = {},
    signal?: AbortSignal,
  ): Promise<CloudAgentCatalogPage<CloudAgentAgentInfo>> {
    const { value } = await this.request("GET", "/agents", {
      query: catalogQueryParams(query),
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "agent list",
      ...(signal ? { signal } : {}),
    })
    return readAgentPage(value)
  }

  /**
   * `GET /models` — what a job's `modelConfiguration.model` may name.
   *
   * Undocumented but live (measured 2026-10-31): the response is global, so
   * repository and organization filters are not accepted here at all.
   */
  async listModels(signal?: AbortSignal): Promise<Array<CloudAgentModelInfo>> {
    const { value } = await this.request("GET", "/models", {
      retry: true,
      cap: MAX_RESPONSE_BYTES,
      what: "model list",
      ...(signal ? { signal } : {}),
    })
    return readModelList(value)
  }
}

export interface CloudAgentCatalogQuery {
  type?: string
  organization?: string
  project?: string
  repository?: string
  branch?: string
  top?: number
  skip?: number
}

/**
 * The catalog page size the service accepts without a `marketplace` filter,
 * which this surface does not expose. Above it the service answers 400, so a
 * caller asking for 200 learns the limit here instead of from an upstream
 * error that names no cause.
 */
export const MAX_CATALOG_TOP = 100

function catalogQueryParams(query: CloudAgentCatalogQuery): Record<string, string | number | undefined> {
  if (query.top !== undefined) {
    if (!Number.isInteger(query.top) || query.top < 1 || query.top > MAX_CATALOG_TOP) {
      throw new CloudAgentError(
        `\`top\` must be an integer from 1 to ${MAX_CATALOG_TOP}; the service rejects a larger page. Use \`skip\` to page through the rest.`,
        { retriable: false },
      )
    }
  }
  if (query.skip !== undefined && (!Number.isInteger(query.skip) || query.skip < 0)) {
    throw new CloudAgentError("`skip` must be a non-negative integer.", { retriable: false })
  }
  return {
    type: query.type,
    organization: query.organization,
    project: query.project,
    repository: query.repository,
    branch: query.branch,
    top: query.top,
    skip: query.skip,
  }
}

/**
 * A job id is interpolated into the request path, so a value containing `/` or
 * `..` would silently address a different endpoint. The service's ids are
 * GUID-shaped; this accepts that plus a conservative superset.
 */
/** `"/jobs/<id>"` or `"/jobs/<id>/logs"` → `<id>`; any other path → `null`. */
function jobIdFromPath(path: string): string | null {
  const match = /^\/jobs\/([^/]+)/.exec(path)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function assertJobId(jobId: string): string {
  const trimmed = jobId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
    throw new CloudAgentError(
      "`jobId` is not a valid Cloud Agent job id. Pass the value returned by create_job, or list_jobs to find it.",
      { retriable: false },
    )
  }
  return trimmed
}

function cloudAgentErrorDetail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "no detail"
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // A repository-validation failure comes back as a bare JSON STRING, so the
    // body is `"Failed to retrieve repository information…"` — quoted. Handing
    // that to the model with its quotes is how a plain sentence gets read as an
    // encoded payload.
    if (typeof parsed === "string" && parsed.trim()) {
      return sanitizeRemoteDetail(parsed.trim()).slice(0, 800)
    }
    if (isRecord(parsed)) {
      // The service has shipped several error envelopes; probe the shapes that
      // carry human-readable text before falling back to the raw body.
      for (const key of ["message", "detail", "title", "error"]) {
        const value = parsed[key]
        if (typeof value === "string" && value.trim()) {
          return sanitizeRemoteDetail(value).slice(0, 800)
        }
        if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
          return sanitizeRemoteDetail(value.message).slice(0, 800)
        }
      }
      const errors = parsed.errors
      if (Array.isArray(errors) && errors.length > 0) {
        const messages = errors
          .map((entry) => (typeof entry === "string"
            ? entry
            : isRecord(entry) && typeof entry.message === "string" ? entry.message : ""))
          .filter((entry) => entry.trim().length > 0)
        if (messages.length > 0) return sanitizeRemoteDetail(messages.join("; ")).slice(0, 800)
      }
    }
  } catch {
    // Fall through to the raw (sanitized, truncated) text.
  }
  return sanitizeRemoteDetail(trimmed).slice(0, 800)
}

/**
 * Token source: explicit env first (tests/manual), else the `az` ladder.
 *
 * `allowInteractiveLogin` is FALSE, unlike the Kusto client. The group can be
 * enabled by repository discovery rather than by an explicit operator flag, and
 * it can be reached from inside a spawned `claude` session where a device-code
 * prompt is invisible to the user and reads as a hang on a tool call that was
 * supposed to return in seconds. A missing or expired session therefore fails
 * fast with `describeAzFailure`'s "run `az login`" advice instead of opening a
 * browser nobody is looking at.
 */
export async function getCloudAgentToken(resource: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  const env = process.env[CLOUDAGENT_TOKEN_ENV]?.trim()
  if (env) return env
  try {
    return await cloudAgentTokenCache.get(resource, {
      ...(signal ? { signal } : {}),
      allowInteractiveLogin: false,
    })
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    throw new CloudAgentError(describeAzFailure("Cloud Agent", err), { retriable: false })
  }
}
