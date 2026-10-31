/**
 * The `cloudagent` MCP group: ten tools over the Microsoft Cloud Agent Job API v2.
 *
 * Cloud Agent runs an autonomous coding agent in the cloud against an Azure DevOps
 * repository. A job is created with a prompt, runs unattended for hours, and
 * ends with a written summary. That shape drives every decision here:
 *
 *   - The group is a sibling of `kusto` / `ado`, not a workflow step kind. The
 *     orchestration kernel in `./orchestration` is an in-process, strictly
 *     sequential DAG with no data binding and an in-memory ledger; a remote
 *     multi-hour job fits none of that. The calling model drives the chain and
 *     the Cloud Agent API is the ledger — `list_jobs` returns every job with its
 *     prompt, labels and outcome, so nothing is lost across a restart or a
 *     compaction.
 *   - A job is ONE-SHOT. There is no continuation, no follow-up message, no
 *     resume. Iteration is a sequence of jobs, and a follow-up carries the same
 *     repository/model/effort explicitly, which is why `create_job` echoes the
 *     normalized request it sent: the caller can copy it forward verbatim
 *     instead of guessing what the first job actually used.
 *   - A job's deliverable is its final `task_complete` call's `arguments.summary`,
 *     reachable only through `GET /jobs/{id}/logs` — 233 KB to 7.5 MB of chat
 *     history. `get_job` fetches that trace for a TERMINAL job only (and caches
 *     the answer), so the summary leads the result without every poll paying
 *     for a 7.5 MB body. `get_job_logs` is the explicit, digested read.
 *   - `toolDiffs` was `[]` on every sampled job, so "what changed" is derived
 *     from the trace (`./cloudagent-client` `readJobLogs`), never from that field.
 *
 * - `create_job` never runs on the service's unstated choice of model: a `tier`
 *   (easy / normal / complex) maps to a measured model at `max` effort, so the
 *   same prompt lands on the same model every session, and `list_models` exposes
 *   the live catalog so a caller can see what else exists and which effort
 *   values each model actually accepts (the ladder is not uniform).
 *
 * Read/write split: the seven read tools are enabled by `--cloudagent`,
 * `GH_ROUTER_ENABLE_CLOUDAGENT=1`, or discovery of an Azure DevOps git remote;
 * `create_job` / `create_pr_job` / `cancel_job` carry the `cloudagent_write`
 * capability and require the explicit flag (see `./cloudagent-flags`). A cloned
 * repository's `origin` must never be able to hand a model a "spend compute" tool.
 *
 * Every result text goes through `relaySafeText` last, so an oversized raw
 * trace spills to a durable file instead of being clipped at the relay.
 */

import type { McpToolCallContext, NonPersonaMcpTool } from "./peer-mcp-personas"
import {
  CloudAgentClient,
  CloudAgentError,
  type CloudAgentEnvironment,
  type CloudAgentJobInput,
  type CloudAgentJobMetadata,
  type CloudAgentPluginInfo,
  type CloudAgentPluginRef,
  type GenericJobRequest,
  buildGenericJobRequest,
  isTerminalJob,
  normalizeCloudAgentEnvironment,
  renderAgentPage,
  renderJob,
  renderJobPage,
  renderModelPage,
  renderPluginPage,
  renderPollHint,
  renderTrace,
  type CloudAgentAgentType,
  type CloudAgentCatalogPage,
  type CloudAgentCatalogQuery,
  MAX_CATALOG_TOP,
} from "./cloudagent-client"
import {
  getAzureRepoFromGit,
  resolveAzureRepoIds,
  type AzureRepoIdQuery,
  type AzureRepoIds,
} from "./azure-repo"
import { state } from "./state"
import { relaySafeText } from "./worker-agent/relay-cap"

const CLOUDAGENT_GROUP = "cloudagent" as const

// --- Model tiers -----------------------------------------------------------

export type CloudAgentTier = "easy" | "normal" | "complex"

export const CLOUDAGENT_DEFAULT_TIER: CloudAgentTier = "normal"

const CLOUDAGENT_TIERS: ReadonlyArray<CloudAgentTier> = ["easy", "normal", "complex"]

/**
 * The model and reasoning effort each `create_job` tier runs on.
 *
 * Measured against the live `GET /models` catalog on 2026-10-31: all three ids
 * exist and all three accept `max`. `claude-opus-4.8-fast` is flagged
 * `preview: true` there, which the tool description says out loud rather than
 * hiding — a preview model can change under the same id.
 *
 * Deliberately NOT derived from the catalog at call time. The catalog has 25
 * entries and no quality ordering, so no default can be computed from it;
 * picking one and stating it is the only honest option. A preset whose id has
 * disappeared fails loudly at the service (a 400 naming the model) instead of
 * silently drifting to whatever looks closest, and `list_models` is the check
 * a caller runs first in an unfamiliar environment.
 */
export const CLOUDAGENT_TIER_MODELS: Readonly<
  Record<CloudAgentTier, { model: string; reasoningEffort: string }>
> = Object.freeze({
  easy: { model: "claude-opus-4.8-fast", reasoningEffort: "max" },
  normal: { model: "gpt-6-astra", reasoningEffort: "max" },
  complex: { model: "claude-opus-5.5", reasoningEffort: "max" },
})

/**
 * The plugin that makes a pull-request job possible: branch, commit, push,
 * open and validate a pull request, watch checks, and edit work items.
 *
 * Measured live on 2026-10-31: `Company` scope, `enabledByDefault: false`, and
 * the whole 235-entry catalog has no default-enabled plugin at all. So the
 * capability is requested explicitly rather than inherited, and a rename shows
 * up as a synchronous 400 naming the plugin (`list_plugins` is the check).
 */
const AGENCY_CODING_PLUGIN = "agency-coding"

/**
 * `create_pr_job` runs on the `complex` preset. Turning a ticket into a
 * review-ready pull request is long-horizon work by definition, which is what
 * that preset is for; `create_job` keeps its own `normal` default.
 */
const PR_JOB_DEFAULT_TIER: CloudAgentTier = "complex"

// --- Client plumbing -------------------------------------------------------

/**
 * One client per environment, built lazily.
 *
 * There is no per-call environment argument and no configurable base URL: the
 * bearer token's Entra audience and the request destination are the same origin
 * by construction, so nothing the model writes can point the token at another
 * host. The environment (prod/ppe) is a launch decision (`--cloudagent-env`), which
 * is the `COPILOT_HOST_ALLOWLIST` argument applied by removing the knob rather
 * than validating it.
 */
const clients = new Map<CloudAgentEnvironment, CloudAgentClient>()

function cloudAgentClient(): CloudAgentClient {
  const environment = normalizeCloudAgentEnvironment(state.cloudAgentEnvironment ?? "prod")
  const existing = clients.get(environment)
  if (existing) return existing
  const client = new CloudAgentClient({ environment })
  clients.set(environment, client)
  return client
}

/** Test seam: drop the memoized clients so the next call rebuilds them. */
export function resetCloudAgentClientForTesting(): void {
  clients.clear()
  summaryCache.clear()
}

/** Test seam: install a client (with an injected fetch/token) for one environment. */
export function setCloudAgentClientForTesting(client: CloudAgentClient): void {
  clients.set(client.environment, client)
}

/**
 * The name-to-id lookup behind the `list_jobs` repository filter.
 *
 * It reaches Azure DevOps REST and mints its own Entra token through `az`, so
 * a unit test replaces it here instead of spawning a real subprocess or
 * reaching the network. `null` restores the production resolver.
 */
type RepoIdResolver = (
  query: AzureRepoIdQuery,
  signal?: AbortSignal,
) => Promise<AzureRepoIds>

const defaultRepoIdResolver: RepoIdResolver = resolveAzureRepoIds
let repoIdResolver: RepoIdResolver = defaultRepoIdResolver

export function setCloudAgentRepoIdResolverForTesting(
  resolver: RepoIdResolver | null,
): void {
  repoIdResolver = resolver ?? defaultRepoIdResolver
}

/**
 * Process-lifetime cache of a terminal job's deliverable, keyed by environment
 * and job id.
 *
 * `null` is meaningful and is why `Map.has` is never used as the predicate: it
 * records "the trace was read and it has no summary", which is the common case
 * for a FAILED job. Without the negative entry every poll of a failed job would
 * re-download a multi-megabyte trace to learn the same nothing.
 *
 * Bounded because job ids are unbounded and each value can be a long model
 * summary; FIFO eviction is enough — a re-read is one request, not a
 * correctness problem.
 */
const summaryCache = new Map<string, string | null>()
const SUMMARY_CACHE_MAX = 64

function cachedSummary(key: string): { hit: true; summary: string | null } | { hit: false } {
  if (!summaryCache.has(key)) return { hit: false }
  return { hit: true, summary: summaryCache.get(key) ?? null }
}

function storeSummary(key: string, summary: string | null): void {
  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next()
    if (!oldest.done) summaryCache.delete(oldest.value)
  }
  summaryCache.set(key, summary)
}

export function resetCloudAgentSummaryCacheForTesting(): void {
  summaryCache.clear()
}

// --- Argument helpers ------------------------------------------------------

async function text(value: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return { content: [{ type: "text", text: await relaySafeText(value) }] }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new CloudAgentError(`\`${key}\` is required and must be a non-empty string.`, { retriable: false })
  }
  return value.trim()
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new CloudAgentError(`\`${key}\` must be a string when provided.`, { retriable: false })
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  // A model that fills every property of an optional schema sends 0 for "not
  // set" — the numeric counterpart of the empty string `optionalString` already
  // treats as absent. Where 0 is not a legal value for the field, rejecting it
  // turns an expression of absence into a failed call; where it IS legal
  // (`skip`), it passes through untouched.
  if (value === 0 && min > 0) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CloudAgentError(`\`${key}\` must be an integer from ${min} to ${max}.`, { retriable: false })
  }
  return value
}

function oneLine(value: string, max: number): string {
  const single = value.replace(/\s*\r?\n\s*/g, " ⏎ ")
  return single.length > max ? `${single.slice(0, max)}…` : single
}

// --- Repository resolution -------------------------------------------------

interface ResolvedRepository {
  organization: string
  project: string
  repository: string
  /** Present only when this tool read it off a checkout rather than being told. */
  inferredFrom?: string
}

function provenanceLine(repository: {
  organization: string
  project?: string
  repository?: string
  inferredFrom?: string
}): string | undefined {
  if (!repository.inferredFrom) return undefined
  const name = [repository.organization, repository.project, repository.repository]
    .filter((part) => part !== undefined)
    .join("/")
  return `[repository: ${name} (inferred from ${repository.inferredFrom})]`
}

/** The three components together, or none of them. A partial set is a typo. */
function repositoryFromArgs(args: Record<string, unknown>): ResolvedRepository | undefined {
  const organization = optionalString(args, "organization")
  const project = optionalString(args, "project")
  const repository = optionalString(args, "repository")
  const given = [organization, project, repository].filter((part) => part !== undefined).length
  if (given === 0) return undefined
  if (given < 3) {
    throw new CloudAgentError(
      "Pass all of `organization`, `project` and `repository`, or none of them and let the repository be read from a checkout. A partial set would either be guessed or silently ignored.",
      { retriable: false },
    )
  }
  return { organization: organization!, project: project!, repository: repository! }
}

/**
 * The repository a job runs against: the explicit triple, else whatever the
 * `workspace` checkout's git remote says.
 *
 * The workspace is resolved by the MCP boundary (`X-GH-Workspace`, or the
 * caller's own argument), and `ctx.workspaceSource` records which — that is the
 * difference between "you told me" and "I guessed", and only the guess gets a
 * provenance line. There is deliberately no `process.cwd()` fallback for
 * `create_job`: the proxy is started once from wherever the operator was, so a
 * stale cwd would spend real compute filing a job against the wrong repository.
 *
 * A FILTER is a different question with its own resolver
 * (`resolveRepositoryFilter`): it may name only the organization, and a
 * checkout it cannot read is reported as the reason the filter was dropped
 * rather than failing the call. Treating that as an error was tried and is
 * wrong in practice: a model that names its checkout on every call (Claude
 * Code fills optional properties rather than omitting them) turned every
 * `list_jobs` in a non-Azure-DevOps repository into an error, for a filter it
 * did not need.
 */
async function resolveRepository(
  args: Record<string, unknown>,
  ctx: McpToolCallContext | undefined,
  opts: { signal?: AbortSignal },
): Promise<ResolvedRepository> {
  const explicit = repositoryFromArgs(args)
  if (explicit) return explicit
  const { repository } = await repositoryFromWorkspace(args, ctx, { required: true, ...opts })
  return repository!
}

interface WorkspaceRepositoryResolution {
  repository?: ResolvedRepository
  /** Set when a workspace was named but could not be read as an Azure DevOps checkout. */
  unresolvedDetail?: string
}

/**
 * Read the repository off the named `workspace`'s git remote. `required`
 * decides whether a missing or unreadable checkout fails the call or is
 * reported back as the reason the repository was not used.
 */
async function repositoryFromWorkspace(
  args: Record<string, unknown>,
  ctx: McpToolCallContext | undefined,
  opts: { required: boolean; signal?: AbortSignal; requiredHint?: string },
): Promise<WorkspaceRepositoryResolution> {
  const workspace = optionalString(args, "workspace")
  const hint = opts.requiredHint ?? "`organization`, `project` and `repository`"
  if (!workspace) {
    if (!opts.required) return {}
    throw new CloudAgentError(
      `No repository: pass ${hint}, or \`workspace\` pointing at a checkout whose git remote is an Azure DevOps repository.`,
      { retriable: false },
    )
  }
  // Absolute-only, so a relative typo cannot silently resolve against whatever
  // directory the proxy happens to be in.
  if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(workspace)) {
    throw new CloudAgentError(
      `\`workspace\` must be an absolute path; got "${workspace}".`,
      { retriable: false },
    )
  }

  try {
    const info = await getAzureRepoFromGit(workspace, opts.signal)
    const repository: ResolvedRepository = {
      organization: info.organization,
      project: info.project,
      repository: info.repository,
      inferredFrom:
        ctx?.workspaceSource === "session"
          ? "this session's workspace"
          : "the workspace you passed",
    }
    return { repository }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (opts.required) {
      throw new CloudAgentError(
        `Could not read an Azure DevOps repository from "${workspace}": ${detail} `
        + "Pass `organization`, `project` and `repository` explicitly to skip the lookup.",
        { retriable: false },
      )
    }
    return {
      unresolvedDetail: `Could not read an Azure DevOps repository from "${workspace}": ${detail}`,
    }
  }
}

/**
 * The `list_jobs` filter, which is shallower than a job target: each deeper
 * component narrows within the one above it, and naming only the organization
 * is a valid, useful filter. Names are what the caller has; the service
 * matches the project and repository by ID, so the handler resolves those two
 * before the request is sent.
 */
interface RepositoryFilter {
  organization: string
  project?: string
  repository?: string
  /** Present only when the filter was read off a checkout rather than passed. */
  inferredFrom?: string
}

function repositoryFilterFromArgs(
  args: Record<string, unknown>,
): RepositoryFilter | undefined {
  const organization = optionalString(args, "organization")
  const project = optionalString(args, "project")
  const repository = optionalString(args, "repository")
  if (organization === undefined) {
    if (project !== undefined || repository !== undefined) {
      throw new CloudAgentError(
        "`project` and `repository` narrow within an `organization`, so pass `organization` with them. Omit all three to list every job this account can see, or to fall back to the workspace's repository.",
        { retriable: false },
      )
    }
    return undefined
  }
  if (project === undefined && repository !== undefined) {
    throw new CloudAgentError(
      "`repository` narrows within a `project`, so pass `organization` and `project` with it, or omit it to list every job in the project.",
      { retriable: false },
    )
  }
  return { organization, project, repository }
}

async function resolveRepositoryFilter(
  args: Record<string, unknown>,
  ctx: McpToolCallContext | undefined,
  signal?: AbortSignal,
): Promise<{ filter?: RepositoryFilter; unresolvedDetail?: string }> {
  const explicit = repositoryFilterFromArgs(args)
  if (explicit) return { filter: explicit }

  const resolution = await repositoryFromWorkspace(args, ctx, { required: false, signal })
  const inferred = resolution.repository
  if (!inferred) return { unresolvedDetail: resolution.unresolvedDetail }
  return {
    filter: {
      organization: inferred.organization,
      project: inferred.project,
      repository: inferred.repository,
      inferredFrom: inferred.inferredFrom,
    },
  }
}

// --- create_job ------------------------------------------------------------

const AGENT_TYPES: ReadonlyArray<CloudAgentAgentType> = ["Repo", "Organization", "Company", "Spec"]

function agentTypeValue(
  args: Record<string, unknown>,
  key: string,
): CloudAgentAgentType | undefined {
  const value = optionalString(args, key)
  if (!value) return undefined
  const match = AGENT_TYPES.find((type) => type.toLowerCase() === value.toLowerCase())
  if (!match) {
    throw new CloudAgentError(
      `\`${key}\` must be one of ${AGENT_TYPES.join(", ")}.`,
      { retriable: false },
    )
  }
  return match
}

function agentTypeArg(args: Record<string, unknown>): CloudAgentAgentType | undefined {
  return agentTypeValue(args, "agentType")
}

function agentInputsArg(args: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const value = args.agentInputs
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    throw new CloudAgentError("`agentInputs` must be an object of scalar values.", { retriable: false })
  }
  const inputs: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      inputs[key] = entry
      continue
    }
    throw new CloudAgentError(
      `\`agentInputs.${key}\` must be a string, number or boolean.`,
      { retriable: false },
    )
  }
  return Object.keys(inputs).length > 0 ? inputs : undefined
}

function pluginsArg(args: Record<string, unknown>): Array<CloudAgentPluginRef> | undefined {
  const value = args.plugins
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new CloudAgentError("`plugins` must be an array of plugin names.", { retriable: false })
  }
  const plugins: Array<CloudAgentPluginRef> = []
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new CloudAgentError("Every entry of `plugins` must be a non-empty plugin name.", { retriable: false })
    }
    plugins.push({ name: entry.trim() })
  }
  return plugins.length > 0 ? plugins : undefined
}

function metadataArg(args: Record<string, unknown>): CloudAgentJobMetadata | undefined {
  const value = args.metadata
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    throw new CloudAgentError(
      "`metadata` must be an object of short string labels, e.g. {\"chain\": \"research\", \"step\": \"1\"}.",
      { retriable: false },
    )
  }
  return value as CloudAgentJobMetadata
}

/**
 * Echo the normalized body the service received.
 *
 * This is what makes a follow-up job a follow-up: `GET /jobs/{id}` does not
 * return `modelConfiguration`, so nothing else can tell the caller which effort
 * and context tier the first job used. Showing it turns "inherit the settings"
 * into "copy these lines", which is verifiable instead of hoped for.
 */
function renderEffectiveRequest(request: GenericJobRequest): string {
  const lines: Array<string> = []
  const repository = request.context.repository
  const branch = repository.branch ? ` branch ${repository.branch}` : ""
  lines.push(`  repository: ${repository.organization}/${repository.project}/${repository.repository}${branch}`)
  if (request.prompt) lines.push(`  prompt: ${oneLine(request.prompt, 300)}`)
  if (request.customAgent) {
    const agent = request.customAgent
    const parts = [`  agent: ${agent.name}`]
    if (agent.type) parts.push(`(${agent.type})`)
    if (agent.pluginName) parts.push(`from plugin ${agent.pluginName}`)
    if (agent.inputs) {
      const inputs = Object.entries(agent.inputs).map(([key, value]) => `${key}=${String(value)}`)
      parts.push(`inputs: ${inputs.join(", ")}`)
    }
    lines.push(parts.join(" "))
  }
  if (request.plugins) lines.push(`  plugins: ${request.plugins.map((plugin) => plugin.name).join(", ")}`)
  if (request.additionalOptions?.pluginOptions?.includeDefaults) {
    lines.push("  default plugins: included")
  }
  const model = request.modelConfiguration
  if (model) {
    const parts: Array<string> = []
    if (model.model) parts.push(`model ${model.model}`)
    if (model.reasoningEffort) parts.push(`effort ${model.reasoningEffort}`)
    if (model.context) parts.push(`context ${model.context}`)
    if (parts.length > 0) lines.push(`  ${parts.join(", ")}`)
  }
  if (request.metadata) {
    const labels = Object.entries(request.metadata).map(([key, value]) => `${key}=${value}`)
    lines.push(`  metadata: ${labels.join(" ")}`)
  }
  return lines.join("\n")
}

// --- wait_for_job ----------------------------------------------------------

/**
 * The plan caps this at 50 s. Two reasons, and the second is the real one:
 * a raw-JSON MCP client is capped at ~60 s per call (Claude Code regression
 * #50289), and no wait that fits in one call can observe a terminal state anyway
 * — the fastest observed job took 13 minutes. So the contract is deliberately
 * "did the handoff take, or is this stuck in the queue?", which is the one
 * question a short wait can actually answer.
 */
const WAIT_DEFAULT_S = 25
const WAIT_MAX_S = 50
const WAIT_POLL_MS = 3000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("wait_for_job was cancelled."))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error("wait_for_job was cancelled."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// --- Tools -----------------------------------------------------------------

const WORKSPACE_PROPERTY = {
  workspace: {
    type: "string",
    description:
      "Absolute path to a checkout whose git remote identifies the Azure DevOps repository. Default: the session workspace, when the client sends one; the repository is then read from that checkout's git remote.",
  },
} as const

/**
 * One optional repository, split across the three fields the API takes.
 *
 * All three are omitted together in the normal case: the workspace's git remote
 * supplies them and the result says so. They exist for the case where there is
 * no checkout to read, so the descriptions have to keep a model from filling
 * one or two of them as if they were independent filters.
 */
const REPOSITORY_PROPERTIES = {
  organization: {
    type: "string",
    description:
      "Azure DevOps organization. Default: read from `workspace`'s git remote. Omit it together with `project` and `repository` unless there is no checkout to read; a partial set is a failed call, not a partial filter.",
  },
  project: {
    type: "string",
    description:
      "Azure DevOps project. Default: read from `workspace`'s git remote. Only with `organization` and `repository`.",
  },
  repository: {
    type: "string",
    description:
      "Repository name inside the project. Default: read from `workspace`'s git remote. Only with `organization` and `project`.",
  },
} as const

/**
 * The same three names, as a FILTER rather than a job target.
 *
 * The shapes differ on purpose. A job needs one exact repository, so its three
 * fields are all-or-none. A filter is a narrowing, and the service matches the
 * organization by name, so naming only the organization is both legal and
 * useful; the project and repository then narrow within it. Each description
 * says what its default is and what it overlays, because a model that cannot
 * see the handler will otherwise fill in a guess.
 */
const FILTER_REPOSITORY_PROPERTIES = {
  organization: {
    type: "string",
    description:
      "Azure DevOps organization to narrow to. Default: read from `workspace`'s git remote. Pass it alone to list every job in the organization.",
  },
  project: {
    type: "string",
    description:
      "Azure DevOps project name, within `organization`. Default: the project read from `workspace`'s git remote. Requires `organization`.",
  },
  repository: {
    type: "string",
    description:
      "Repository name within `project`. Default: the repository read from `workspace`'s git remote. Requires `organization` and `project`.",
  },
} as const

/**
 * The same three names again, as the Azure DevOps CONTEXT a catalog scope reads.
 *
 * Measured live (2026-10-30), and the scopes do NOT want the same thing:
 *
 *  - `Repo` reads one repository, so it needs all three. Organization alone earns
 *    "ProjectName in Azure DevOps context is required for Repo agents/plugins",
 *    organization+project earns "RepositoryName ... is required", and
 *    organization+repository earns "Project is required when Repository is
 *    specified."
 *  - `Organization` reads an organization's own marketplace, so the organization
 *    alone is enough: org-only, org+project, org+repository and the full triple
 *    all answer identically. Demanding the other two here would make a caller
 *    with no checkout invent names the service never reads.
 *  - Company, Spec and untyped calls read no context at all.
 *
 * So the descriptions state per scope which names are required rather than
 * borrowing create_job's all-or-none job-target wording, which would read as if a
 * plain `list_plugins` call needed a repository.
 */
const CATALOG_REPOSITORY_PROPERTIES = {
  organization: {
    type: "string",
    description:
      "Azure DevOps organization the Repo and Organization scopes read. Required for both; the other scopes do not read it. Default: read from `workspace`'s git remote, or from the session workspace's checkout.",
  },
  project: {
    type: "string",
    description:
      "Azure DevOps project, for the Repo scope. Required there with `organization` and `repository`; the Organization scope and the others do not read it. Default: read from the checkout.",
  },
  repository: {
    type: "string",
    description:
      "Repository name inside `project`, for the Repo scope. Required there with `organization` and `project`; the Organization scope and the others do not read it. Default: read from the checkout.",
  },
} as const

const JOB_ID_PROPERTY = {
  jobId: { type: "string", description: "The job id returned by create_job or listed by list_jobs." },
} as const

// --- create_pr_job workflow ------------------------------------------------

/**
 * The engineering process `create_pr_job` prepends to every task.
 *
 * The Job API has no system-prompt field (a live validate probe on 2026-10-31
 * sent one, got a 200, and the field was ignored and not echoed), so the only
 * instruction surface is `prompt`. The directive is therefore literal text in
 * front of the caller's task, and the task is wrapped in <user_task> tags so
 * "how to work" and "what to build" stay distinguishable inside one string.
 *
 * The wording follows the frontier-model guidance current on 2026-10-31:
 * Anthropic's general prompting guide and its Claude Opus 5.5 guide. The
 * choices worth knowing before editing it:
 *
 *   - Name the early stops an unattended run tends to take (a status summary,
 *     an offer to continue, a decision list for a user who is not there) and
 *     say what to do instead. The Opus 5.5 guide is explicit about these.
 *   - Give delegation rules, not just permission: the same guide warns that
 *     models both over-spawn and under-spawn subagents.
 *   - Point at the actual request. A long procedural prompt otherwise invites
 *     the model to optimize the process rather than answer the task.
 *   - State outcomes and exit criteria rather than reasoning steps, and use
 *     plain phrasing instead of stacked emphasis.
 *
 * Keep the version marker, and bump it when the workflow changes: the tests
 * pin the structure, and the marker is what makes a job's behavior traceable
 * to the directive that produced it.
 */
const PR_JOB_WORKFLOW = `[github-router PR workflow v3]

# Role

You are an autonomous software engineer responsible for one repository and one request. Carry the request in <user_task> from understanding to a review-ready pull request whose required checks pass.

# The request

The text inside <user_task> at the end of this prompt is the actual request. Everything else in this prompt is process: how to work, not what to build. Read <user_task> before you plan or edit, restate it in your own words in your first status note, and check your work against it in every phase. If it is ambiguous, resolve the ambiguity in the way that best serves what it asks for and record the assumption. Do not substitute a different improvement for the one it asks for.

# Operating context

- This is a one-shot job. It cannot be resumed, and no one will answer questions while it runs.
- You start from a fresh clone of the repository and see only this prompt.
- Repository guidance (AGENTS.md, CLAUDE.md, CONTRIBUTING, build and test docs) is authoritative. Read it first. Where it conflicts with this prompt, follow the repository and note the conflict in your final report.
- Your tools include the checkout, a shell, and the coding plugin's Azure DevOps write tools for branches, commits, pushes, pull requests, pipelines, and work items.

# Definition of done

1. A pull request is open from a new branch against the repository's base branch.
2. Every required check for that pull request has passed, or each one that cannot pass has a precise written explanation.
3. The pull request links a work item.
4. Your final report contains the evidence described under Reporting.

# Staying in motion

This run is unattended. Nobody will reply while you work, so a turn that ends with a status report has nowhere to go.

- Put status notes in the same message as your next tool call, then continue.
- Keep a checklist of the request's parts, update it as you go, and keep working until every item is done or blocked.
- When something you started is still running, such as a background command or a subagent, wait for its result and continue.
- Stop only when the definition of done is met, or when a blocker genuinely needs a human, and then report the exact blocker.

# Working style

**Delegation.** Use subagents when work can run in parallel, needs isolated context, or splits into independent workstreams that do not share state: exploring separate areas, running independent checks, or reviewing work you produced. Do the sequential work, single-file edits, and steps that need accumulated context yourself. When your tooling supports it, use a separate subagent for the plan review and the implementation review, so the reviewer is independent of the author.

**Parallel calls.** When several tool calls are independent, issue them together rather than one at a time. Keep dependent calls sequential.

**Scope.** Make the changes the request needs and the changes they require to be correct. Do not add features, refactor surrounding code, or make improvements the request did not ask for. Every change in the plan and the diff should trace to the request or to the correctness of that change.

**Grounding.** Base claims on files you opened and command output you saw. Do not speculate about code you have not read.

**Quality.** Tests verify correctness; they do not define the solution. Implement the general behavior for all valid inputs rather than the values the tests happen to use. Do not hard-code results or add workarounds that only satisfy the checks.

**Reversibility.** Take local, reversible actions freely. Avoid destructive shortcuts: no force-push, no rewriting published history, no deleting branches, files, or data you do not understand.

# Process

Work through these phases in order. Parallelize only independent work.

## 1. Understand
Read the repository guidance, then the code, tests, history, and any named work item that the request touches. Confirm what the request actually asks for before proposing a solution. Be able to state the current behavior, the constraints, and the acceptance criteria.

## 2. Plan
Write one plan a reviewer could execute: the change surface, the smallest set of edits that satisfies the request, tests to add or update, the exact build and test commands, rollout and rollback, and the risks. Reuse existing utilities and patterns rather than adding new ones.

## 3. Review the plan
Give the plan and your evidence to an independent adversarial reviewer, a separate subagent when one is available. Ask it to attack the plan: wrong assumptions, missing surfaces, over-scoping, untested paths. Resolve each finding or record why it does not apply. Start implementation only after this review.

## 4. Implement
Make the change the reviewed plan describes. Add or update tests that would fail without it. Run the repository's documented format, build, analyzer, and test commands as you go. When something fails, fix the cause and keep tests, analyzers, and linters enabled as the repository configures them. Remove any temporary scripts or files you created before you finish.

## 5. Verify
Collect real evidence for every claim: command lines and their outcomes, build and test results, and any validation the repository requires. Empirical output beats assumption. If something cannot be verified from your environment, say so explicitly instead of implying it passed.

## 6. Review the implementation
Give the diff, the plan, and the verification output to an independent adversarial reviewer, a separate subagent when one is available. It looks for correctness bugs, edge cases, error handling, concurrency, security, and gaps between the diff and the plan. Fix real findings and re-run verification. Repeat until the review is clean or every remaining finding is recorded with a reason.

## 7. Open the pull request
Create a new branch from the base branch, commit in the repository's existing message style, push, and open a pull request. Write the title and description in a human voice: what changed, why, how it was validated, and what a reviewer should look at. Use plain prose without em dashes and without attribution trailers such as Co-Authored-By or generated-with footers, because the team's convention is that those read as machine output. When the request names a work item, link it to the pull request.

## 8. Get the build green
Watch the pull request's required checks and fix failures on the branch until they pass. While a check is queued or running, wait for it rather than guessing its outcome. If a check cannot pass because of permissions, credentials, an outage, or missing configuration, record its name, its state, and the exact step a human must take. When the repository has no pull request pipeline, run the documented local build and test commands and use their output as the green evidence.

## 9. Handle the work item
If the request named a work item, the pull request links that one and this phase is done. Otherwise, once the pull request exists and its required checks pass, create one in the Azure DevOps organization that hosts the repository, in the MSTeams project, not the Teamspace project. Look up recent work items assigned to you (System.AssignedTo = @Me) and reuse their area path, current sprint iteration, priority, and tags where they fit. Write the title and description in a human voice with no em dashes: what changed, why it matters, risk, and the validation evidence. Link the new work item to the pull request. If permissions or a missing project block creation, record the exact error, note it in the pull request description, and continue to Reporting rather than stopping the run.

# Reporting

Your final message is the handoff. Include:
- a one-line restatement of what was asked,
- the pull request id and link,
- the work item id and link,
- each check you observed with its final state,
- the commands you ran and their results,
- decisions you made without confirmation and why,
- anything open, unverified, or blocked, with the exact blocker.

# Working rules

- Keep secrets out of everything you emit or commit. Reference sensitive files such as .env, *.pem, and *.key by path only, and do not read their contents into output.
- Work on a new branch and open a pull request. The default branch stays untouched so a human can gate the change.
- Keep one logical change per pull request; unrelated fixes belong on their own branch.
- If the request is already satisfied, or cannot be done with the access you have, stop and report exactly what you found and what a human needs to do next.
- Leave the pull request open for review. Merging stays with a human.

# Task`

function composePrJobPrompt(task: string): string {
  return `${PR_JOB_WORKFLOW}\n\n<user_task>\n${task.trim()}\n</user_task>`
}

export const CLOUDAGENT_TOOLS: ReadonlyArray<NonPersonaMcpTool> = Object.freeze([
  {
    toolNameHttp: "create_job",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent_write",
    description:
      "Runs an autonomous coding agent in the Microsoft cloud against an Azure DevOps repository, and returns immediately with a job id. "
      + "A job is ONE-SHOT: it runs unattended for hours (median 221 minutes), cannot be messaged, and cannot be resumed — iteration means creating another job. "
      + "It works in its own cloud clone, not in your working tree; its final answer is retrieved with get_job. "
      + "Only `prompt` is needed in the normal case, or `agent` for a custom agent that carries its own instructions: the repository is read from the workspace's git remote, the model and reasoning effort come from `tier` (default normal), and every other argument has a working default, so supply one only to change that default — each description states its default and what overrides it. "
      + "Confirm with the user before creating a job they did not explicitly ask for: it spends real compute for hours. "
      + "After it returns, do not wait in one call — poll with get_job, or use wait_for_job once to confirm the job left the queue.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description:
            "What the cloud agent should do, in natural language. Required unless `agent` names a custom agent whose own instructions drive the job. This is the whole specification: the agent starts from a fresh clone and sees nothing else.",
        },
        ...REPOSITORY_PROPERTIES,
        branch: {
          type: "string",
          description:
            "Branch to start from. Default: the repository's default branch.",
        },
        ...WORKSPACE_PROPERTY,
        agent: {
          type: "string",
          description:
            "Name of a custom agent to run instead of the default one; see list_agents. Default: the service's standard agent, driven by `prompt`. A named agent's `inputs` are usually required.",
        },
        agentType: {
          type: "string",
          enum: [...AGENT_TYPES],
          description:
            "Scope the custom agent was registered at: Repo, Organization, Company or Spec. Only meaningful with `agent`; default: not sent.",
        },
        agentInputs: {
          type: "object",
          description:
            "Inputs the custom agent requires, as name/value pairs; list_agents lists the names. Default: none. Values are strings, numbers or booleans.",
        },
        plugins: {
          type: "array",
          items: { type: "string" },
          description:
            "Plugin names to load, from list_plugins. Plugins are the main capability selector — they give the agent skills, tools or house rules. Default: none, so the job runs on the agent's built-in capabilities plus whatever the service enables by default (list_plugins marks those `(enabled by default)`).",
        },
        includeDefaultPlugins: {
          type: "boolean",
          description:
            "Set true to load the service's default plugins alongside `plugins`. Default: not sent, so the service applies its own default; only set it when a job needs both the defaults and extra plugins.",
        },
        tier: {
          type: "string",
          enum: ["easy", "normal", "complex"],
          description:
            "Preset for model and reasoning effort. Default \"normal\". "
            + "easy = claude-opus-4.8-fast (a preview model) at max effort, for small well-specified changes; "
            + "normal = gpt-6-astra at max effort, the everyday coding tier; "
            + "complex = claude-opus-5.5 at max effort, for hard or long-horizon work. "
            + "Naming `model` replaces the preset's model AND discards its effort; `context` is independent of the tier. list_models shows the live catalog and each model's effort values.",
        },
        model: {
          type: "string",
          description:
            "Model the agent runs on. Default: the model of `tier` (normal = gpt-6-astra). Overriding it drops the tier's `max` reasoning effort as well, leaving the model's own default unless `reasoningEffort` is also passed — the effort ladder differs per model, so the tier value is not valid everywhere. list_models lists the ids and each model's effort values.",
        },
        reasoningEffort: {
          type: "string",
          description:
            "Reasoning effort for the job's model. Default: `max`, supplied by `tier`. The values are low, medium, high, xhigh and max, but each model accepts only a subset — list_models prints the ladder per model. Passing an effort without `model` keeps the tier's model.",
        },
        context: {
          type: "string",
          enum: ["default", "long_context"],
          description:
            "Context tier: \"default\" or \"long_context\". Default \"default\"; override with \"long_context\" for a job over a large repository.",
        },
        metadata: {
          type: "object",
          description:
            "Short string labels stored on the job and echoed by list_jobs, e.g. {\"chain\": \"research\", \"step\": \"1\"}. Default: none. Labels are how a later session finds this job, not a place to store content.",
        },
      },
    },
    async handler(args, signal, ctx) {
      // The signal reaches the LOCAL git probe only. It is deliberately not
      // passed to `createJob`: aborting a POST after the service accepted it
      // would leave a running job with no id to report, and there is no
      // idempotency key to retry against.
      const repository = await resolveRepository(args, ctx, { signal })
      const branch = optionalString(args, "branch")
      const agent = optionalString(args, "agent")
      const prompt = optionalString(args, "prompt")
      // Parsed once each: every one of these validates and may throw, and
      // evaluating it twice in a truthiness test would run the validation twice
      // for no gain (and read ambiguously).
      const agentType = agent ? agentTypeArg(args) : undefined
      const agentInputs = agent ? agentInputsArg(args) : undefined
      const plugins = pluginsArg(args)
      const model = resolveModelConfiguration(args)
      const metadata = metadataArg(args)

      const input: CloudAgentJobInput = {
        ...(prompt ? { prompt } : {}),
        repository: {
          organization: repository.organization,
          project: repository.project,
          repository: repository.repository,
          ...(branch ? { branch } : {}),
        },
        ...(agent
          ? {
              customAgent: {
                name: agent,
                ...(agentType ? { type: agentType } : {}),
                ...(agentInputs ? { inputs: agentInputs } : {}),
              },
            }
          : {}),
        ...(plugins ? { plugins } : {}),
        ...(args.includeDefaultPlugins === true ? { includeDefaultPlugins: true } : {}),
        modelConfiguration: model.modelConfiguration,
        ...(metadata ? { metadata } : {}),
      }

      const request = buildGenericJobRequest(input)
      // Deliberately no AbortSignal on the create. An aborted POST leaves the
      // caller with no job id for a job that may well exist and is now spending
      // compute, and the API offers no idempotency key to find it again. The
      // request is a single bounded POST, so letting it finish is the cheaper
      // failure mode.
      const job = await cloudAgentClient().createJob(request)

      const provenance = provenanceLine(repository)
      const lines = [renderJob(job, provenance ? { note: provenance } : {})]
      lines.push("")
      lines.push("effective request (the normalized body the service received):")
      lines.push(renderEffectiveRequest(request))
      lines.push(`  ${model.tierNote}`)
      lines.push("")
      lines.push(
        `next: the job is ${job.state ?? "created"}. Report the job id to the user and check with get_job jobId=${job.jobId} in about 10 minutes — a typical job runs for hours, so there is nothing to learn before then. wait_for_job tells you whether the handoff took (it leaves Queued) without waiting for the work.`,
      )
      return text(lines.join("\n"))
    },
  },
  {
    toolNameHttp: "create_pr_job",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent_write",
    description:
      "Runs an autonomous coding agent in the Microsoft cloud that takes one request from understanding to a review-ready pull request, and returns immediately with a job id. "
      + "It is create_job with three decisions already made: the `agency-coding` plugin is loaded (branch, commit, push, pull request, pipeline and work item tools), the model defaults to claude-opus-5.5 at max reasoning effort (the `complex` tier), and a fixed engineering workflow is prepended to `prompt`: research, a reviewed plan, implementation with tests, an independent adversarial review of the change, the pull request, a green build, and a work item that links it. "
      + "You supply the task in `prompt`; the workflow and its conventions are added automatically, so do not restate them. "
      + "A job is ONE-SHOT: it runs unattended for hours (median 221 minutes), cannot be messaged, and cannot be resumed. "
      + "The job leaves its pull request open for a human to review and never merges. "
      + "Confirm with the user before creating a job they did not explicitly ask for: it spends real compute for hours. "
      + "After it returns, poll with get_job, or use wait_for_job once to confirm the job left the queue.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description:
            "The task, written as a brief rather than a one-liner: the outcome wanted, how the caller will know it is done, constraints, relevant links, and the work item id if one already exists. This is the request the job answers; the workflow, plugin and model come from the tool, so do not restate them. The agent starts from a fresh clone and sees nothing else.",
        },
        ...REPOSITORY_PROPERTIES,
        branch: {
          type: "string",
          description:
            "Branch to start from. Default: the repository's default branch.",
        },
        ...WORKSPACE_PROPERTY,
        tier: {
          type: "string",
          enum: ["easy", "normal", "complex"],
          description:
            "Preset for model and reasoning effort. Default \"complex\": claude-opus-5.5 at max effort, because this workflow is long-horizon work. "
            + "easy = claude-opus-4.8-fast (a preview model) at max effort, for small well-specified changes; "
            + "normal = gpt-6-astra at max effort, the everyday coding tier. "
            + "Naming `model` replaces the preset's model AND discards its effort; `context` is independent of the tier. list_models shows the live catalog and each model's effort values.",
        },
        model: {
          type: "string",
          description:
            "Model the agent runs on. Default: claude-opus-5.5, the model of the `complex` tier. Overriding it drops the tier's `max` reasoning effort as well, leaving the model's own default unless `reasoningEffort` is also passed; the effort ladder differs per model. list_models lists the ids and each model's effort values.",
        },
        reasoningEffort: {
          type: "string",
          description:
            "Reasoning effort for the job's model. Default: `max`, supplied by `tier`. The values are low, medium, high, xhigh and max, but each model accepts only a subset; list_models prints the ladder per model. Passing an effort without `model` keeps the tier's model.",
        },
        context: {
          type: "string",
          enum: ["default", "long_context"],
          description:
            "Context tier: \"default\" or \"long_context\". Default \"default\"; override with \"long_context\" for a job over a large repository.",
        },
        metadata: {
          type: "object",
          description:
            "Short string labels stored on the job and echoed by list_jobs, e.g. {\"chain\": \"research\", \"step\": \"1\"}. Default: none. Labels are how a later session finds this job, not a place to store content.",
        },
      },
    },
    async handler(args, signal, ctx) {
      // Same split as create_job: the signal reaches the LOCAL git probe only.
      // Aborting the POST after the service accepted it would leave a running
      // job with no id to report, and there is no idempotency key to retry on.
      const repository = await resolveRepository(args, ctx, { signal })
      const branch = optionalString(args, "branch")
      const task = optionalString(args, "prompt")
      if (!task) {
        // The schema marks `prompt` required, but a raw JSON caller can omit
        // it, and an empty task would spend hours of compute on nothing.
        throw new CloudAgentError(
          "`prompt` is required: it is the task the job works on, and the fixed workflow cannot supply one.",
          { retriable: false },
        )
      }
      const model = resolveModelConfiguration(args, PR_JOB_DEFAULT_TIER)
      const metadata = metadataArg(args)

      const request = buildGenericJobRequest({
        prompt: composePrJobPrompt(task),
        repository: {
          organization: repository.organization,
          project: repository.project,
          repository: repository.repository,
          ...(branch ? { branch } : {}),
        },
        plugins: [{ name: AGENCY_CODING_PLUGIN }],
        modelConfiguration: model.modelConfiguration,
        ...(metadata ? { metadata } : {}),
      })
      const job = await cloudAgentClient().createJob(request)

      const provenance = provenanceLine(repository)
      const lines = [renderJob(job, provenance ? { note: provenance } : {})]
      lines.push("")
      lines.push("effective request (the normalized body the service received):")
      lines.push(renderEffectiveRequest(request))
      lines.push(`  ${model.tierNote}`)
      lines.push("")
      lines.push(
        `next: the job is ${job.state ?? "created"}. Report the job id to the user and poll with get_job jobId=${job.jobId}; a typical run takes hours. wait_for_job tells you whether the handoff took without waiting for the work.`,
      )
      return text(lines.join("\n"))
    },
  },
  {
    toolNameHttp: "cancel_job",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent_write",
    description:
      "Stops a running Cloud Agent job. IRREVERSIBLE: a cancelled job cannot be resumed, and work it had not yet pushed is lost. "
      + "The service acknowledges the request immediately and stops the job asynchronously, so poll get_job afterwards until the state is terminal. "
      + "Only cancel when the job is clearly wrong or no longer wanted — a long-running job is normal, not stuck.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      additionalProperties: false,
      properties: { ...JOB_ID_PROPERTY },
    },
    async handler(args, signal) {
      const jobId = requiredString(args, "jobId")
      const result = await cloudAgentClient().cancelJob(jobId, signal)
      if (result.alreadyCancelled && result.job) {
        return text(
          renderJob(result.job, {
            note: "the job was already cancelled; nothing further will happen to it.",
          }),
        )
      }
      return text(
        `Cancellation requested for job ${jobId}.\n`
        + `next: the service stops the job asynchronously — check with get_job jobId=${jobId} in about a minute until the state is terminal.`,
      )
    },
  },
  {
    toolNameHttp: "get_job",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "The current state of one Cloud Agent job, and — once the job has finished — its deliverable, which is the agent's final summary and leads the result. "
      + "Use this to poll a job you created. On a job that is still running the result ends with how long to wait before checking again; a typical job runs for hours, so polling more often than that only repeats the same answer. "
      + "A job that ended in a failure is reported as a normal result with its outcome and who is responsible, not as an error.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      additionalProperties: false,
      properties: { ...JOB_ID_PROPERTY },
    },
    async handler(args, signal) {
      const jobId = requiredString(args, "jobId")
      const job = await getJobWithSummary(jobId, signal)
      const lines = [
        renderJob(job.job, job.summary !== null ? { summary: job.summary } : {}),
      ]
      // Only a FINISHED job can be said to have produced nothing. A running job
      // also has no summary yet, and telling its caller "it never called
      // task_complete" would be a false negative on every poll.
      if (job.summary === null && isTerminalJob(job.job)) {
        lines.push("")
        lines.push(
          "summary: none — the job never called task_complete, so it produced no deliverable. get_job_logs shows the trace that explains what it did instead.",
        )
      }
      if (isTerminalJob(job.job)) {
        lines.push("")
        lines.push(
          `next: the job is finished. get_job_logs jobId=${jobId} has the digested trace: what it ran, which files it changed, and the last tool result.`,
        )
      } else {
        lines.push("")
        lines.push(renderPollHint(job.job))
      }
      return text(lines.join("\n"))
    },
  },
  {
    toolNameHttp: "list_jobs",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "Lists the Cloud Agent jobs this account can see, newest first, as one line each with state, outcome, repository and prompt. "
      + "This is the durable ledger of dispatched work: every job carries its prompt, its labels and its outcome, so a chain of jobs can be reconstructed in a later session or after a compaction. "
      + "Call it with no arguments in the common case: it narrows to the workspace's Azure DevOps repository and returns the first page of 25 jobs. "
      + "Narrowing is optional and additive — `organization` alone lists every job in that organization, `organization` plus `project` lists a project, and all three list one repository; names you pass override the ones read from a checkout. "
      + "There is no state filter: the service silently ignores one, so filter the returned lines yourself.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...FILTER_REPOSITORY_PROPERTIES,
        ...WORKSPACE_PROPERTY,
        pullRequestId: {
          type: "number",
          description: "Only jobs that produced this pull request. Default: every pull request.",
        },
        pageSize: {
          type: "number",
          description: "How many jobs to return, 1-100. Default 25.",
        },
        continuationToken: {
          type: "string",
          description:
            "Opaque token from a previous page whose result said more were available. Default: the first page.",
        },
      },
    },
    async handler(args, signal, ctx) {
      const resolution = await resolveRepositoryFilter(args, ctx, signal)
      const filter = resolution.filter
      const pageSize = optionalInt(args, "pageSize", 1, 100)
      const pullRequestId = optionalInt(args, "pullRequestId", 1, Number.MAX_SAFE_INTEGER)

      const notes: Array<string> = []
      let projectId: string | undefined
      let repositoryId: string | undefined
      if (filter?.project) {
        try {
          const ids = await repoIdResolver(
            {
              organization: filter.organization,
              project: filter.project,
              ...(filter.repository ? { repository: filter.repository } : {}),
            },
            signal,
          )
          projectId = ids.projectId
          repositoryId = ids.repositoryId
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          if (!filter.inferredFrom) {
            // The caller asked for this narrowing. A ledger that looks filtered
            // and is not is the exact failure the argument exists to prevent,
            // so refuse and name the two ways out.
            throw new CloudAgentError(
              `${detail} Pass only \`organization\` to narrow by organization, or omit all three to list every job this account can see.`,
              { retriable: false },
            )
          }
          // A filter read off a checkout rather than asked for: keep the
          // organization (which needs no lookup), drop the rest, and say so.
          notes.push(
            `[filter: organization "${filter.organization}" only — ${detail} The project and repository read from ${filter.inferredFrom} were dropped.]`,
          )
        }
      }

      const page = await cloudAgentClient().listJobs(
        {
          organization: filter?.organization,
          project: projectId,
          repository: repositoryId,
          pullRequestId,
          pageSize,
          continuationToken: optionalString(args, "continuationToken"),
        },
        signal,
      )

      const inferred =
        filter?.inferredFrom && filter.project && filter.repository && projectId !== undefined
      if (inferred) {
        notes.push(provenanceLine({ ...filter, project: filter.project!, repository: filter.repository! })!)
      }
      if (!filter) {
        notes.push(
          resolution.unresolvedDetail
            ? `[repository: not filtered — ${resolution.unresolvedDetail} Pass organization, project and repository explicitly to filter by one repository.]`
            : "[repository: not filtered — no repository was given and none could be read from a checkout, so this lists every job the account can see]",
        )
      }
      const lines = [...notes, renderJobPage(page)]
      if (page.data.length > 0) {
        lines.push("")
        lines.push(
          `next: get_job jobId=<id> for one job's state and deliverable; get_job_logs jobId=<id> for what it actually did.`,
        )
      }
      return text(lines.join("\n"))
    },
  },
  {
    toolNameHttp: "wait_for_job",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "Waits a short, bounded time for a Cloud Agent job to leave the queue, i.e. for the service to allocate compute and start it. "
      + "Returns as soon as the job starts running, reaches a terminal state, or the wait expires — \"still Queued after 25 s\" is a normal answer, not an error. "
      + "Use it once after create_job to confirm the handoff took. Do not use it to wait for the work: jobs run for hours (median 221 min), so use get_job for that.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      additionalProperties: false,
      properties: {
        ...JOB_ID_PROPERTY,
        max_wait_s: {
          type: "number",
          description: `Seconds to wait, 1-${WAIT_MAX_S}. Default ${WAIT_DEFAULT_S}.`,
        },
      },
    },
    async handler(args, signal) {
      const jobId = requiredString(args, "jobId")
      const maxWaitS = optionalInt(args, "max_wait_s", 1, WAIT_MAX_S) ?? WAIT_DEFAULT_S
      const client = cloudAgentClient()
      const startedAt = Date.now()
      const deadline = startedAt + maxWaitS * 1000

      let job = await client.getJob(jobId, signal)
      let polls = 1
      while (!isTerminalJob(job) && !hasLeftQueue(job) && Date.now() < deadline) {
        await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())), signal)
        job = await client.getJob(jobId, signal)
        polls++
      }

      const elapsedS = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      if (isTerminalJob(job)) {
        const summary = await summaryFor(client, jobId, signal)
        const lines = [renderJob(job, summary !== null ? { summary } : {})]
        if (summary === null) {
          lines.push("")
          lines.push("summary: none — the job never called task_complete, so it produced no deliverable.")
        }
        lines.push("")
        lines.push(`next: the job finished within ${elapsedS} s. get_job_logs jobId=${jobId} has the digested trace.`)
        return text(lines.join("\n"))
      }

      const lines = [
        renderJob(job, {
          note: hasLeftQueue(job)
            ? `the handoff took: the job left the queue within ${elapsedS} s (${polls} poll(s)).`
            : `still ${job.state ?? "queued"} after ${elapsedS} s (${polls} poll(s)) — the service has not allocated compute yet.`,
        }),
      ]
      lines.push("")
      lines.push(
        hasLeftQueue(job)
          ? "next: the job is running. Check with get_job in about 10 minutes; a typical job runs for hours."
          : "next: nothing is wrong yet — a job can sit in the queue. Check again with get_job in about 2 minutes; if it is still queued much longer, the queue is the problem, not the job.",
      )
      return text(lines.join("\n"))
    },
  },
  {
    toolNameHttp: "get_job_logs",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "The trace of a Cloud Agent job: what it did and what it left behind. "
      + "The default digest gives the deliverable summary (when the job produced one), a tool-use histogram, the files it changed, its last message, and the final tool result — which is how a multi-hour, multi-thousand-message run becomes readable. "
      + "Use mode \"full\" only when the digest is genuinely not enough: the raw trace is often several megabytes and is written to a file with a short preview returned.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      additionalProperties: false,
      properties: {
        ...JOB_ID_PROPERTY,
        mode: {
          type: "string",
          enum: ["digest", "full"],
          description: "Default \"digest\": a readable summary. \"full\" returns the raw trace text, spilled to a file when large.",
        },
        tail: {
          type: "number",
          description: "How many of the most recent tool calls the digest lists, 1-50. Default 12.",
        },
      },
    },
    async handler(args, signal) {
      const jobId = requiredString(args, "jobId")
      const tail = optionalInt(args, "tail", 1, 50)
      const mode = optionalString(args, "mode") ?? "digest"
      if (mode !== "digest" && mode !== "full") {
        throw new CloudAgentError('`mode` must be "digest" or "full".', { retriable: false })
      }
      const client = cloudAgentClient()
      if (mode === "full") {
        return text(await client.getJobLogsText(jobId, signal))
      }
      const logs = await client.getJobLogs(jobId, signal)
      // Warm the summary cache from the trace we just parsed: a caller reading
      // the digest almost always polls get_job too, and the answer is already here.
      if (logs.summary) storeSummary(summaryKey(jobId), logs.summary)
      return text(renderTrace(logs, tail !== undefined ? { tail } : {}))
    },
  },
  {
    toolNameHttp: "list_plugins",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "Lists the plugins a Cloud Agent job can load: skills, tools and house rules the agent gets when the plugin is named in create_job's `plugins`. "
      + "This is the main capability selector — a plain prompt runs the agent with the default capabilities only. "
      + "The catalog is large (hundreds of entries): call it with no arguments for the first page of 50, page with `top`/`skip`, or pass `name_contains` to search the WHOLE catalog, in which case `top`/`skip` window the matches instead of the catalog.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          description:
            "Plugin scope to filter on. The known choices are Repo, Organization, Company and Spec, the same vocabulary create_job's `agentType` accepts. Default: every scope. "
            + "Repo and Organization read a repository's or an organization's own catalog: Repo needs `organization`, `project` and `repository`, Organization needs only `organization`, and by default both are read from the checkout this session is in.",
        },
        ...CATALOG_REPOSITORY_PROPERTIES,
        ...WORKSPACE_PROPERTY,
        name_contains: {
          type: "string",
          description:
            "Search the whole catalog for plugin names containing this text, case-insensitively. The service has no name filter, so the proxy pages through the catalog itself; `top` and `skip` then window the MATCHES, not the catalog. Default: no search, so the result is a page of the catalog.",
        },
        top: {
          type: "number",
          description:
            "Page size, 1-100. Default: 50, both for the catalog page and for the maximum number of `name_contains` matches.",
        },
        skip: {
          type: "number",
          description:
            "How many entries to skip, for paging. With `name_contains`, how many matches to skip. Default 0, the first page.",
        },
      },
    },
    async handler(args, signal, ctx) {
      const { query, context } = await catalogQuery(args, ctx, signal)
      // The context is only present when the scopes needed it, and when it was
      // inferred the answer is about a repository the caller did not name, so
      // the provenance line leads — same rule as create_job.
      const provenance = context ? provenanceLine(context) : undefined
      const withProvenance = (body: string) => (provenance ? `${provenance}\n${body}` : body)
      const needle = optionalString(args, "name_contains")?.toLowerCase()
      if (!needle) {
        return text(withProvenance(renderPluginPage(await cloudAgentClient().listPlugins(query, signal))))
      }

      const scan = await scanPluginCatalog(query, signal)
      const matches = scan.value.filter((plugin) => plugin.name.toLowerCase().includes(needle))
      const skip = query.skip ?? 0
      const limit = query.top ?? DEFAULT_PLUGIN_MATCH_LIMIT
      const window = matches.slice(skip, skip + limit)
      const scanned = scan.capped
        ? `the first ${scan.scanned} of ${scan.totalCount ?? "?"} plugin(s) — narrow with \`type\``
        : scan.totalCount !== undefined
          ? `all ${scan.totalCount} plugin(s)`
          : `the ${scan.scanned} plugin(s) the service returned`
      // The header states the search space, not just the hit count: "0 matches"
      // is only trustworthy if the caller can see the whole catalog was read.
      // The measured catalog is 233 entries, so a page-sized filter would have
      // missed most plugins while looking like an answer.
      const header = matches.length === 0
        ? `[name_contains "${needle}": no plugin name contains it, searched ${scanned}]`
        : `[name_contains "${needle}": ${matches.length} match(es) in ${scanned}${
            window.length < matches.length ? `, showing ${skip + 1}-${skip + window.length}` : ""
          }]`
      const page: CloudAgentCatalogPage<CloudAgentPluginInfo> = {
        value: window,
        ...(scan.errors ? { errors: scan.errors } : {}),
      }
      return text(withProvenance([header, renderPluginPage(page)].join("\n")))
    },
  },
  {
    toolNameHttp: "list_agents",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "Lists the custom agents a Cloud Agent job can run with create_job's `agent`, together with the input names each one requires. "
      + "This is the only place those input names appear: the service rejects a job whose agent is missing a required input, so read this before naming an agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          description:
            "Agent scope to filter on. The known choices are Repo, Organization, Company and Spec, the same vocabulary create_job's `agentType` accepts. Default: every scope. "
            + "Repo lists the agents a repository defines, which is where custom agents that need `agentInputs` usually live; it needs `organization`, `project` and `repository`, or a checkout to read them from. Organization lists an organization's agents and needs only `organization`.",
        },
        ...CATALOG_REPOSITORY_PROPERTIES,
        ...WORKSPACE_PROPERTY,
        top: {
          type: "number",
          description: "Page size, 1-100. Default: the service's own page size.",
        },
        skip: {
          type: "number",
          description: "How many entries to skip, for paging. Default 0, the first page.",
        },
      },
    },
    async handler(args, signal, ctx) {
      const { query, context } = await catalogQuery(args, ctx, signal)
      const page = await cloudAgentClient().listAgents(query, signal)
      const provenance = context ? provenanceLine(context) : undefined
      return text(provenance ? `${provenance}\n${renderAgentPage(page)}` : renderAgentPage(page))
    },
  },
  {
    toolNameHttp: "list_models",
    group: CLOUDAGENT_GROUP,
    capability: "cloudagent",
    description:
      "Lists the models a Cloud Agent job can run on, from the service's live catalog, with each model's context window, output limit, reasoning-effort values and any notice the service attaches (for example a scheduled deprecation). "
      + "This is the vocabulary create_job's `model` draws from, and the check to run before relying on a tier in an unfamiliar environment: create_job's presets name specific ids — easy = claude-opus-4.8-fast at max effort, normal = gpt-6-astra at max effort (the default), complex = claude-opus-5.5 at max effort — and a preset whose id is gone fails at the service. "
      + "The list is global: it is identical for every repository and organization, which is why it takes no arguments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async handler(_args, signal) {
      const models = await cloudAgentClient().listModels(signal)
      const presets = CLOUDAGENT_TIERS.map((tier) => {
        const preset = CLOUDAGENT_TIER_MODELS[tier]
        const suffix = tier === CLOUDAGENT_DEFAULT_TIER ? " (default)" : ""
        return `${tier} = ${preset.model} at ${preset.reasoningEffort} effort${suffix}`
      }).join("; ")
      return text(`create_job tier presets: ${presets}.\n${renderModelPage(models)}`)
    },
  },
])

// --- Shared handler helpers ------------------------------------------------

function tierArg(
  args: Record<string, unknown>,
  defaultTier: CloudAgentTier = CLOUDAGENT_DEFAULT_TIER,
): CloudAgentTier {
  const raw = optionalString(args, "tier")
  if (raw === undefined) return defaultTier
  const normalized = raw.toLowerCase()
  const match = CLOUDAGENT_TIERS.find((tier) => tier === normalized)
  if (match) return match
  const options = CLOUDAGENT_TIERS
    .map((tier) => `${tier} = ${CLOUDAGENT_TIER_MODELS[tier].model} at ${CLOUDAGENT_TIER_MODELS[tier].reasoningEffort} effort`)
    .join(", ")
  throw new CloudAgentError(
    `\`tier\` must be easy, normal or complex (got "${raw}"). ${options}.`,
    { retriable: false },
  )
}

/**
 * Resolve `tier`, `model`, `reasoningEffort` and `context` into the wire
 * `modelConfiguration`, plus one line explaining what the tier contributed.
 *
 * Precedence, and why: a tier supplies a model AND an effort. Naming a `model`
 * replaces the whole preset rather than only its model, because the effort
 * ladder differs per model — measured live, 8 of 25 models do not accept `max`
 * — so carrying the preset's `max` onto a caller-chosen model would inject a
 * value that caller never asked for and the service may reject. An explicit
 * `reasoningEffort` is always honored, with or without `model`.
 *
 * The explanation line exists because `GET /jobs/{id}` never returns
 * `modelConfiguration`: a follow-up job can only copy values the caller can
 * SEE were used, and "effort: max" without saying it came from the tier reads
 * like something the caller chose.
 */
function resolveModelConfiguration(
  args: Record<string, unknown>,
  defaultTier: CloudAgentTier = CLOUDAGENT_DEFAULT_TIER,
): {
  modelConfiguration: NonNullable<CloudAgentJobInput["modelConfiguration"]>
  tierNote: string
} {
  const tier = tierArg(args, defaultTier)
  const preset = CLOUDAGENT_TIER_MODELS[tier]
  const explicitModel = optionalString(args, "model")
  const explicitEffort = optionalString(args, "reasoningEffort")
  const context = optionalString(args, "context")
  if (context !== undefined && context !== "default" && context !== "long_context") {
    throw new CloudAgentError('`context` must be "default" or "long_context".', { retriable: false })
  }
  const model = explicitModel ?? preset.model
  const reasoningEffort = explicitEffort ?? (explicitModel ? undefined : preset.reasoningEffort)
  const modelConfiguration: NonNullable<CloudAgentJobInput["modelConfiguration"]> = {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(context ? { context } : {}),
  }
  const defaultLabel = tier === defaultTier ? ", the default" : ""
  let tierNote: string
  if (!explicitModel) {
    tierNote = explicitEffort
      ? `tier: ${tier}${defaultLabel} — its model ${model}; the effort you passed replaced its ${preset.reasoningEffort}.`
      : `tier: ${tier}${defaultLabel} — supplied model ${model} and effort ${preset.reasoningEffort}.`
  } else if (explicitEffort) {
    tierNote = `tier: ${tier}${defaultLabel} — replaced by model ${model}; the effort you passed replaced its ${preset.reasoningEffort}.`
  } else {
    tierNote = `tier: ${tier}${defaultLabel} — replaced by model ${model}, so its ${preset.reasoningEffort} effort was dropped and the model's own default applies.`
  }
  return { modelConfiguration, tierNote }
}

/**
 * The arguments shared by `list_plugins` and `list_agents`.
 *
 * `top` is omitted when the caller did not ask for it, and that is load-bearing:
 * `GET /plugins` returns 50 of 233 by default and rejects `top > 100` with a 400
 * unless `marketplace` is set, so a default page size here would either shrink
 * what the service gives an unprompted call or provoke that 400.
 *
 * The Azure DevOps context is resolved separately (`catalogContext`) because
 * only the Repo and Organization scopes require one.
 */
async function catalogQuery(
  args: Record<string, unknown>,
  ctx: McpToolCallContext | undefined,
  signal?: AbortSignal,
): Promise<{ query: CloudAgentCatalogQuery; context?: CatalogContext }> {
  const type = agentTypeValue(args, "type")
  const top = optionalInt(args, "top", 1, MAX_CATALOG_TOP)
  const skip = optionalInt(args, "skip", 0, Number.MAX_SAFE_INTEGER)
  const context = await catalogContext(args, ctx, type, signal)
  return {
    query: {
      ...(type ? { type } : {}),
      ...(context
        ? {
            organization: context.organization,
            ...(context.project ? { project: context.project } : {}),
            ...(context.repository ? { repository: context.repository } : {}),
          }
        : {}),
      ...(top !== undefined ? { top } : {}),
      ...(skip !== undefined ? { skip } : {}),
    },
    ...(context ? { context } : {}),
  }
}

/**
 * The Azure DevOps context a catalog call reads: the organization always, and
 * the project/repository only when the caller supplied them.
 */
interface CatalogContext {
  organization: string
  project?: string
  repository?: string
  inferredFrom?: string
}

/**
 * The context a catalog scope reads, from the caller's arguments or a checkout.
 *
 * Each scope is held only to what it actually reads (measured live 2026-10-30;
 * see `CATALOG_REPOSITORY_PROPERTIES`): `Repo` needs the triple, `Organization`
 * needs the organization alone, and the rest read no context, so a partial set
 * supplied to those is not an error — the call simply does not use it. Requiring
 * more than the service does is its own failure mode: it turns a working
 * question into a refusal.
 *
 * The context is only resolved when the call can use it. An untyped, Company or
 * Spec call costs no git probe and cannot fail on a machine that is not in an
 * Azure DevOps checkout — the `list_jobs` lesson, where inferring eagerly turned
 * every call in an unrelated repository into an error for a filter it did not
 * need.
 */
async function catalogContext(
  args: Record<string, unknown>,
  ctx: McpToolCallContext | undefined,
  type: CloudAgentAgentType | undefined,
  signal?: AbortSignal,
): Promise<CatalogContext | undefined> {
  if (type !== "Repo" && type !== "Organization") return undefined

  const organization = optionalString(args, "organization")
  const project = optionalString(args, "project")
  const repository = optionalString(args, "repository")

  if (type === "Repo") {
    const given = [organization, project, repository].filter((part) => part !== undefined).length
    if (given > 0 && given < 3) {
      throw new CloudAgentError(
        "The Repo scope lists one repository's catalog, so it reads all of `organization`, `project` and `repository`; pass all three, or none of them and let them be read from a checkout. A partial set would either be guessed or silently ignored.",
        { retriable: false },
      )
    }
    if (given === 3) {
      return { organization: organization!, project: project!, repository: repository! }
    }
  } else {
    if (organization) {
      // Project and repository are not read here, but forwarding them is
      // measured harmless, so what the caller gave is what the service receives.
      return { organization, ...(project ? { project } : {}), ...(repository ? { repository } : {}) }
    }
    if (project || repository) {
      throw new CloudAgentError(
        "The Organization scope reads an organization's catalog, so it needs `organization`; `project` and `repository` do not identify it. Pass `organization`, or none of the three and let them be read from a checkout.",
        { retriable: false },
      )
    }
  }

  const hint = type === "Repo" ? "`organization`, `project` and `repository`" : "`organization`"
  const { repository: inferred } = await repositoryFromWorkspace(args, ctx, {
    required: true,
    requiredHint: hint,
    ...(signal ? { signal } : {}),
  })
  return inferred!
}

/** Matches returned by a filtered `list_plugins` when the caller gave no `top`. */
const DEFAULT_PLUGIN_MATCH_LIMIT = 50

/**
 * How many catalog entries a name search pages through before it stops.
 *
 * The measured catalog is 233 entries, so three pages cover it; the cap only
 * bounds a catalog that grew by an order of magnitude, and the result says when
 * it was hit so a truncated search is never read as an empty one.
 */
const PLUGIN_SCAN_CAP = 1000

/**
 * Read the plugin catalog page by page.
 *
 * `GET /plugins` has no name filter and refuses `top > 100`, so answering "is
 * there a plugin for X?" from a single page would miss most of the catalog
 * while looking like an answer. Paging lives here so the tool handler stays a
 * filter. `skip` is the service's own offset, verified live: 233 entries over
 * three pages, no overlap.
 */
async function scanPluginCatalog(
  base: CloudAgentCatalogQuery,
  signal?: AbortSignal,
): Promise<{
  value: Array<CloudAgentPluginInfo>
  scanned: number
  totalCount?: number
  capped: boolean
  errors?: Array<string>
}> {
  const seen = new Set<string>()
  const value: Array<CloudAgentPluginInfo> = []
  // A Repo or Organization scope answers 200 with an empty page and the reason
  // in `errors` (measured: "Marketplace manifest not found at
  // .github/plugin/marketplace.json"). Across a scan those reasons repeat on
  // every page, so they are deduped and reported once.
  const serviceErrors = new Set<string>()
  const add = (page: CloudAgentCatalogPage<CloudAgentPluginInfo>): number => {
    for (const error of page.errors ?? []) serviceErrors.add(error)
    for (const plugin of page.value) {
      // The catalog is live, so a page boundary can shift between requests; a
      // duplicate name would otherwise render twice and count as two matches.
      if (seen.has(plugin.name)) continue
      seen.add(plugin.name)
      value.push(plugin)
    }
    return page.value.length
  }
  const result = (scanned: number, totalCount: number | undefined, capped: boolean) => ({
    value,
    scanned,
    ...(totalCount !== undefined ? { totalCount } : {}),
    capped,
    ...(serviceErrors.size > 0 ? { errors: [...serviceErrors] } : {}),
  })

  // Measured 2026-10-29: one `GET /plugins` costs 2-11 s regardless of page
  // size, so three sequential pages made a name search take 40 s. The first
  // page carries `totalCount`, so the remaining pages are fetched concurrently:
  // the search costs two round trips instead of one per page.
  const first = await cloudAgentClient().listPlugins({ ...base, top: MAX_CATALOG_TOP, skip: 0 }, signal)
  let scanned = add(first)
  const totalCount = first.totalCount
  if (first.value.length < MAX_CATALOG_TOP) return result(scanned, totalCount, false)
  if (totalCount === undefined) {
    // No total to page against: fall back to reading forward until a short page.
    for (;;) {
      const page = await cloudAgentClient().listPlugins(
        { ...base, top: MAX_CATALOG_TOP, skip: scanned },
        signal,
      )
      scanned += add(page)
      if (page.value.length < MAX_CATALOG_TOP) return result(scanned, undefined, false)
      if (scanned >= PLUGIN_SCAN_CAP) return result(scanned, undefined, true)
    }
  }
  const lastPage = Math.min(
    Math.ceil(totalCount / MAX_CATALOG_TOP),
    Math.ceil(PLUGIN_SCAN_CAP / MAX_CATALOG_TOP),
  )
  const offsets: Array<number> = []
  for (let skip = MAX_CATALOG_TOP; skip < lastPage * MAX_CATALOG_TOP; skip += MAX_CATALOG_TOP) {
    offsets.push(skip)
  }
  const pages = await Promise.all(
    offsets.map((skip) =>
      cloudAgentClient().listPlugins({ ...base, top: MAX_CATALOG_TOP, skip }, signal),
    ),
  )
  for (const page of pages) scanned += add(page)
  return result(scanned, totalCount, totalCount > PLUGIN_SCAN_CAP)
}

/** Queued is the only state that means "compute has not been allocated". */
function hasLeftQueue(job: { state?: string }): boolean {
  return job.state !== undefined && job.state.trim().toLowerCase() !== "queued"
}

function summaryKey(jobId: string): string {
  const environment = normalizeCloudAgentEnvironment(state.cloudAgentEnvironment ?? "prod")
  return `${environment}:${jobId}`
}

/**
 * The job plus its deliverable for a terminal job.
 *
 * A terminal state is the only time the trace is worth fetching, and the answer
 * is cached in BOTH directions (`null` = read, no summary). A failure to read
 * the trace must not fail the call: the state and outcome are the more useful
 * half of the answer, so the summary degrades to `null` with the reason attached
 * to the note rather than throwing away a successful poll.
 */
async function getJobWithSummary(
  jobId: string,
  signal?: AbortSignal,
): Promise<{ job: Awaited<ReturnType<CloudAgentClient["getJob"]>>; summary: string | null }> {
  const client = cloudAgentClient()
  const job = await client.getJob(jobId, signal)
  if (!isTerminalJob(job)) return { job, summary: null }
  return { job, summary: await summaryFor(client, jobId, signal) }
}

async function summaryFor(
  client: CloudAgentClient,
  jobId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = summaryKey(jobId)
  const cached = cachedSummary(key)
  if (cached.hit) return cached.summary
  try {
    const logs = await client.getJobLogs(jobId, signal)
    const summary = logs.summary ?? null
    storeSummary(key, summary)
    return summary
  } catch {
    // Not cached: a transient read failure must not poison the cache for the
    // rest of the process, and the next poll is allowed to try again.
    return null
  }
}
