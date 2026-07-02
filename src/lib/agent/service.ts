import consola from "consola"

import { ghGraphQL } from "./graphql"
import { agentErrorFromResponse, ghRest, ghRestRaw } from "./rest"
import {
  AgentError,
  type AgentActor,
  type AgentKey,
  type AgentPRSummary,
  type AssignmentInput,
  type AssignmentResult,
  type CheckSummary,
  type CommentResult,
  type FailingCheckSummary,
  type IssueCreateInput,
  type IssueRef,
  type MergeResult,
  type PullRequestDiffSummary,
  type PullRequestFileSummary,
  type PullRequestState,
  type ReadyForReviewResult,
  type RepoNodeRef,
  type RepoRef,
  type RequiredChecksSummary,
  type RerunChecksResult,
  type ReviewResult,
  type UnassignmentResult,
  type WorkflowDispatchResult,
  type WorkflowJobSummary,
  type WorkflowRunSummary,
} from "./types"

const CACHE_TTL_MS = 5 * 60 * 1000
const FILE_SUMMARY_LIMIT = 50
const CHECK_SUMMARY_LIMIT = 20
const FAILING_CHECK_LIMIT = 5
const JOB_SUMMARY_LIMIT = 20

export const AGENT_LOGIN_MATCHERS: Record<AgentKey, RegExp> = {
  copilot: /^copilot(-swe-agent)?$/i,
  anthropic: /^anthropic-code-agent$/i,
  openai: /^openai-code-agent$/i,
}

const rosterCache = new Map<
  string,
  { timestamp: number; roster: Map<AgentKey, AgentActor> }
>()
const repoNodeCache = new Map<string, { timestamp: number; node: RepoNodeRef }>()

function repoCacheKey(repo: RepoRef): string {
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
}

function cached<T>(entry: { timestamp: number; value: T } | undefined): T | undefined {
  if (!entry) return undefined
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return undefined
  return entry.value
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}

function repoPath(repo: RepoRef): string {
  return `/repos/${segment(repo.owner)}/${segment(repo.repo)}`
}

function botAssigneeLogin(login: string): string {
  return login.toLowerCase().endsWith("[bot]") ? login : `${login}[bot]`
}

/** Classify a GitHub login to an agent key via the roster matchers, or null. */
function agentKeyForLogin(login: string): AgentKey | null {
  const normalized = login.replace(/\[bot\]$/i, "")
  for (const [key, matcher] of Object.entries(AGENT_LOGIN_MATCHERS) as [
    AgentKey,
    RegExp,
  ][]) {
    if (matcher.test(normalized)) return key
  }
  return null
}

function authorMatchesBot(authorLogin: string | undefined, botLogin: string): boolean {
  if (!authorLogin) return false
  const author = authorLogin.toLowerCase()
  const raw = botLogin.toLowerCase()
  if (author === raw || author === botAssigneeLogin(botLogin).toLowerCase()) return true
  // The coding agent authors PRs under a display login ("Copilot") distinct from
  // its assignee login ("copilot-swe-agent"); match when both map to the same
  // agent via the roster matchers.
  const authorKey = agentKeyForLogin(authorLogin)
  return authorKey !== null && authorKey === agentKeyForLogin(botLogin)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (!text.trim()) return {}

  try {
    return asRecord(JSON.parse(text)) ?? {}
  } catch (err) {
    throw new AgentError("UPSTREAM", "GitHub API returned invalid JSON", {
      cause: err,
    })
  }
}

interface SuggestedActorNode {
  login?: string | null
  __typename?: string | null
  id?: string | null
}

interface SuggestedActorsData {
  repository?: {
    suggestedActors?: {
      nodes?: SuggestedActorNode[] | null
    } | null
  } | null
}

export async function resolveAgentRoster(
  repo: RepoRef,
): Promise<Map<AgentKey, AgentActor>> {
  const key = repoCacheKey(repo)
  const cacheEntry = rosterCache.get(key)
  const roster = cached(
    cacheEntry ? { timestamp: cacheEntry.timestamp, value: cacheEntry.roster } : undefined,
  )
  if (roster) return roster

  const data = await ghGraphQL<SuggestedActorsData>(
    `query FirstMateSuggestedActors($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes {
            login
            __typename
            ... on Bot {
              id
            }
          }
        }
      }
    }`,
    { owner: repo.owner, name: repo.repo },
  )

  const nextRoster = new Map<AgentKey, AgentActor>()
  for (const node of data.repository?.suggestedActors?.nodes ?? []) {
    if (!node.login || !node.id || node.__typename !== "Bot") continue
    for (const [agentKey, matcher] of Object.entries(AGENT_LOGIN_MATCHERS) as [
      AgentKey,
      RegExp,
    ][]) {
      if (!matcher.test(node.login)) continue
      if (!nextRoster.has(agentKey)) {
        nextRoster.set(agentKey, { login: node.login, botId: node.id })
      }
    }
  }

  rosterCache.set(key, { timestamp: Date.now(), roster: nextRoster })
  return nextRoster
}

export async function resolveAgentActor(
  repo: RepoRef,
  key: AgentKey,
): Promise<AgentActor> {
  const roster = await resolveAgentRoster(repo)
  const actor = roster.get(key)
  if (actor) return actor

  const available = [...roster.keys()].join(", ") || "none"
  throw new AgentError(
    "AGENT_NOT_AVAILABLE",
    `Agent ${key} is not available for ${repo.owner}/${repo.repo}; available: ${available}`,
  )
}

interface RepoNodeData {
  repository?: {
    id?: string | null
    defaultBranchRef?: {
      name?: string | null
    } | null
  } | null
}

export async function resolveRepoNode(repo: RepoRef): Promise<RepoNodeRef> {
  const key = repoCacheKey(repo)
  const cacheEntry = repoNodeCache.get(key)
  const node = cached(
    cacheEntry ? { timestamp: cacheEntry.timestamp, value: cacheEntry.node } : undefined,
  )
  if (node) return node

  const data = await ghGraphQL<RepoNodeData>(
    `query FirstMateRepositoryNode($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        defaultBranchRef {
          name
        }
      }
    }`,
    { owner: repo.owner, name: repo.repo },
  )

  const repositoryId = data.repository?.id
  if (!repositoryId) {
    throw new AgentError("NOT_FOUND", `Repository ${repo.owner}/${repo.repo} was not found`)
  }

  const nextNode: RepoNodeRef = {
    repositoryId,
    defaultBranch: data.repository?.defaultBranchRef?.name ?? "",
  }
  repoNodeCache.set(key, { timestamp: Date.now(), node: nextNode })
  return nextNode
}

interface IssueRestResponse {
  number?: number
  node_id?: string
  html_url?: string
  url?: string
}

export async function createIssue(
  repo: RepoRef,
  input: IssueCreateInput,
): Promise<IssueRef> {
  const issue = await ghRest<IssueRestResponse>("POST", `${repoPath(repo)}/issues`, {
    body: { title: input.title, body: input.body },
  })

  return {
    number: issue.number ?? 0,
    nodeId: issue.node_id ?? "",
    url: issue.html_url ?? issue.url ?? "",
  }
}

export async function assignAgent(
  repo: RepoRef,
  input: AssignmentInput,
): Promise<AssignmentResult> {
  try {
    // replaceActorsForAssignable REPLACES ALL assignees, so this is only safe
    // on a freshly-created issue owned by the first-mate flow.
    await ghGraphQL<unknown>(
      `mutation FirstMateAssignAgent($issueNodeId: ID!, $botId: ID!) {
        replaceActorsForAssignable(input: {
          assignableId: $issueNodeId,
          actorIds: [$botId]
        }) {
          assignable {
            ... on Issue {
              id
            }
          }
        }
      }`,
      { issueNodeId: input.issueNodeId, botId: input.botId },
      { features: "issues_copilot_assignment_api_support" },
    )
    return { assigned: true, via: "graphql" }
  } catch (graphqlErr) {
    const reason = graphqlErr instanceof AgentError ? graphqlErr.code : "unknown"
    consola.debug(`GraphQL assignment failed (${reason}); trying REST fallback`)

    try {
      await ghRest<unknown>(
        "POST",
        `${repoPath(repo)}/issues/${segment(input.issueNumber)}/assignees`,
        { body: { assignees: [botAssigneeLogin(input.botLogin)] } },
      )
      return { assigned: true, via: "rest" }
    } catch (restErr) {
      throw new AgentError("ASSIGN_FAILED", "Failed to assign agent to issue", {
        cause: { graphqlErr, restErr },
      })
    }
  }
}

export async function unassignAgent(
  repo: RepoRef,
  input: { issueNumber: number; botLogin: string },
): Promise<UnassignmentResult> {
  await ghRest<unknown>(
    "DELETE",
    `${repoPath(repo)}/issues/${segment(input.issueNumber)}/assignees`,
    { body: { assignees: [botAssigneeLogin(input.botLogin)] } },
  )
  return { unassigned: true }
}

interface PullRestResponse {
  number?: number
  draft?: boolean
  user?: { login?: string | null } | null
  head?: { sha?: string | null; ref?: string | null } | null
}

export async function findAgentPRs(
  repo: RepoRef,
  input: { issueNumber: number; botLogin: string; branch?: string },
): Promise<AgentPRSummary[]> {
  void input.issueNumber
  const pulls = await ghRest<PullRestResponse[]>(
    "GET",
    `${repoPath(repo)}/pulls?state=all&per_page=100`,
  )

  return pulls
    .filter((pull) => {
      // The branch is the authoritative per-task correlator. The Agent-Tasks
      // API authors EVERY PR as "Copilot" regardless of the requested model, so
      // author matching cannot identify a non-copilot unit's PR — prefer the
      // branch whenever we know it, and fall back to author only otherwise.
      if (input.branch !== undefined && input.branch.length > 0) {
        return pull.head?.ref === input.branch
      }
      return authorMatchesBot(pull.user?.login ?? undefined, input.botLogin)
    })
    .map((pull) => ({
      number: pull.number ?? 0,
      headSha: pull.head?.sha ?? "",
      headRef: pull.head?.ref ?? "",
      isDraft: pull.draft ?? false,
    }))
}

// GitHub Copilot code review is requested via the standard review-request
// endpoint with this exact bot login (verified empirically: the bare "Copilot"
// / "copilot-swe-agent" forms 201 but silently no-op; only the [bot] form
// registers and produces a review). Copilot always posts a COMMENTED review
// (never approve/request-changes), so the findings — not the state — are the
// signal the verifier judges. See docs/first-mate-design.md.
export const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer[bot]"

/**
 * Request a code review from `reviewerLogin` on a PR. Best-effort: a 422
 * (already requested / not a collaborator) or any other error is swallowed and
 * reported as `requested:false` — a failed review request must not abort the
 * controller sweep.
 */
export async function requestReview(
  repo: RepoRef,
  pr: number,
  reviewerLogin: string,
): Promise<{ requested: boolean }> {
  try {
    await ghRest<unknown>(
      "POST",
      `${repoPath(repo)}/pulls/${segment(pr)}/requested_reviewers`,
      { body: { reviewers: [reviewerLogin] } },
    )
    return { requested: true }
  } catch (err) {
    consola.debug(`first-mate: requestReview(${reviewerLogin}) on PR #${pr} skipped:`, err)
    return { requested: false }
  }
}

interface ReviewRestResponse {
  user?: { login?: string | null } | null
  state?: string | null
  body?: string | null
  submitted_at?: string | null
}

export interface ReviewSummary {
  author: string
  /** COMMENTED | APPROVED | CHANGES_REQUESTED | ... */
  state: string
  bodyExcerpt: string
  submittedAt?: string
}

const REVIEW_BODY_LIMIT = 4000

/** Compact review summaries for a PR (author + state + hard-truncated body). */
export async function getPullRequestReviews(
  repo: RepoRef,
  pr: number,
): Promise<ReviewSummary[]> {
  const reviews = await ghRest<ReviewRestResponse[]>(
    "GET",
    `${repoPath(repo)}/pulls/${segment(pr)}/reviews?per_page=50`,
  )
  return (reviews ?? []).map((review) => ({
    author: review.user?.login ?? "",
    state: review.state ?? "",
    bodyExcerpt: (review.body ?? "").slice(0, REVIEW_BODY_LIMIT),
    ...(review.submitted_at ? { submittedAt: review.submitted_at } : {}),
  }))
}


interface PullRequestGraphQLData {
  repository?: {
    pullRequest?: {
      number?: number | null
      title?: string | null
      isDraft?: boolean | null
      state?: string | null
      mergeable?: string | null
      reviewDecision?: string | null
      headRefOid?: string | null
      baseRefName?: string | null
      baseRefOid?: string | null
      author?: { login?: string | null } | null
    } | null
  } | null
}

export async function getPullRequestState(
  repo: RepoRef,
  pr: number,
): Promise<PullRequestState> {
  const data = await ghGraphQL<PullRequestGraphQLData>(
    `query FirstMatePullRequestState($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          number
          title
          isDraft
          state
          mergeable
          reviewDecision
          headRefOid
          baseRefName
          baseRefOid
          author {
            login
          }
        }
      }
    }`,
    { owner: repo.owner, name: repo.repo, number: pr },
  )

  const pullRequest = data.repository?.pullRequest
  if (!pullRequest) {
    throw new AgentError("NOT_FOUND", `Pull request #${pr} was not found`)
  }

  let baseSha = pullRequest.baseRefOid ?? undefined
  let baseRef = pullRequest.baseRefName ?? ""
  if (!baseSha || !baseRef) {
    const restPull = await ghRest<{
      base?: { sha?: string | null; ref?: string | null } | null
    }>("GET", `${repoPath(repo)}/pulls/${segment(pr)}`)
    baseSha = baseSha ?? restPull.base?.sha ?? undefined
    baseRef = baseRef || restPull.base?.ref || ""
  }

  return {
    number: pullRequest.number ?? pr,
    title: pullRequest.title ?? "",
    isDraft: pullRequest.isDraft ?? false,
    state: pullRequest.state ?? "UNKNOWN",
    mergeable: pullRequest.mergeable,
    reviewDecision: pullRequest.reviewDecision,
    headSha: pullRequest.headRefOid ?? "",
    baseRef,
    baseSha,
    authorLogin: pullRequest.author?.login ?? undefined,
  }
}

interface CheckRunRestResponse {
  check_runs?: Array<{
    id?: number
    name?: string
    status?: string | null
    conclusion?: string | null
    html_url?: string | null
    details_url?: string | null
  }>
}

function isFailingConclusion(conclusion: string | null | undefined): boolean {
  return [
    "action_required",
    "cancelled",
    "failure",
    "startup_failure",
    "timed_out",
  ].includes(conclusion ?? "")
}

export async function getRequiredChecksForSha(
  repo: RepoRef,
  sha: string,
): Promise<RequiredChecksSummary> {
  const response = await ghRest<CheckRunRestResponse>(
    "GET",
    `${repoPath(repo)}/commits/${segment(sha)}/check-runs`,
  )
  // The Copilot code-review bot registers its own check-run
  // ("copilot-pull-request-reviewer": success). That is a REVIEW marker, not a
  // test — counting it would report ci_rollup "passing" for a PR whose actual
  // lint/test suite never ran. Exclude review-bot check-runs from CI.
  const checkRuns = (response.check_runs ?? []).filter(
    (check) => !/pull-request-reviewer/i.test(check.name ?? ""),
  )
  const runningCount = checkRuns.filter(
    (check) => check.status !== "completed" || !check.conclusion,
  ).length
  const failingRuns = checkRuns.filter((check) => isFailingConclusion(check.conclusion))

  let rollup: RequiredChecksSummary["rollup"] = "none"
  if (checkRuns.length > 0) {
    if (failingRuns.length > 0) rollup = "failing"
    else if (runningCount > 0) rollup = "pending"
    else rollup = "passing"
  }

  const checks: CheckSummary[] = checkRuns.slice(0, CHECK_SUMMARY_LIMIT).map((check) => ({
    id: check.id ?? 0,
    name: check.name ?? "",
    conclusion: check.conclusion,
  }))
  const failing: FailingCheckSummary[] = failingRuns
    .slice(0, FAILING_CHECK_LIMIT)
    .map((check) => ({
      name: check.name ?? "",
      url: check.html_url ?? check.details_url ?? undefined,
    }))

  return { rollup, checks, failing, runningCount }
}

const workflowCache = new Map<string, { timestamp: number; value: boolean }>()

interface ContentsEntry {
  name?: string
  type?: string
}

/**
 * Whether the repo has any GitHub Actions workflow on `ref`. Lets the
 * controller distinguish "genuinely no CI" (route to cross-lab verify) from
 * "CI configured but checks not registered yet" (keep waiting) when a commit's
 * check-run rollup is "none". Cached per repo+ref; a 404 (no dir) means no CI.
 */
export async function repoHasWorkflows(repo: RepoRef, ref: string): Promise<boolean> {
  const key = `${repoPath(repo)}@${ref}`
  const hit = cached(workflowCache.get(key))
  if (hit !== undefined) return hit

  let value = false
  try {
    const entries = await ghRest<ContentsEntry[]>(
      "GET",
      `${repoPath(repo)}/contents/.github/workflows?ref=${segment(ref)}`,
    )
    value =
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          entry.type === "file" && /\.ya?ml$/i.test(entry.name ?? ""),
      )
  } catch (err) {
    // 404 → no workflows dir → no CI. Other errors: assume no CI (best-effort).
    if (!(err instanceof AgentError && err.code === "NOT_FOUND")) {
      consola.debug("first-mate: workflow probe failed, assuming no CI:", err)
    }
    value = false
  }

  workflowCache.set(key, { timestamp: Date.now(), value })
  return value
}

interface PullFileRestResponse {
  filename?: string
  additions?: number
  deletions?: number
  status?: string
}

export async function getPullRequestDiffSummary(
  repo: RepoRef,
  pr: number,
): Promise<PullRequestDiffSummary> {
  const files = await ghRest<PullFileRestResponse[]>(
    "GET",
    `${repoPath(repo)}/pulls/${segment(pr)}/files?per_page=100`,
  )
  const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const compactFiles: PullRequestFileSummary[] = files
    .slice(0, FILE_SUMMARY_LIMIT)
    .map((file) => ({
      path: file.filename ?? "",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      status: file.status ?? "",
    }))

  return {
    files: compactFiles,
    totalAdditions,
    totalDeletions,
    fileCount: files.length,
    truncated: files.length > FILE_SUMMARY_LIMIT,
  }
}

export async function postComment(
  repo: RepoRef,
  number: number,
  body: string,
): Promise<CommentResult> {
  const comment = await ghRest<{ html_url?: string; url?: string }>(
    "POST",
    `${repoPath(repo)}/issues/${segment(number)}/comments`,
    { body: { body } },
  )
  return { url: comment.html_url ?? comment.url ?? "" }
}

export async function submitReview(
  repo: RepoRef,
  pr: number,
  event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE" | string,
  body?: string,
): Promise<ReviewResult> {
  const requestBody: Record<string, unknown> = { event }
  if (body !== undefined) requestBody.body = body

  const review = await ghRest<{ id?: number; state?: string }>(
    "POST",
    `${repoPath(repo)}/pulls/${segment(pr)}/reviews`,
    { body: requestBody },
  )
  return { reviewId: review.id ?? 0, state: review.state ?? "" }
}

export async function dispatchWorkflow(
  repo: RepoRef,
  input: { workflow: string | number; ref: string; inputs?: Record<string, string> },
): Promise<WorkflowDispatchResult> {
  const requestBody: Record<string, unknown> = { ref: input.ref }
  if (input.inputs !== undefined) requestBody.inputs = input.inputs

  const response = await ghRestRaw(
    "POST",
    `${repoPath(repo)}/actions/workflows/${segment(input.workflow)}/dispatches`,
    { body: requestBody },
  )
  if (response.status !== 204) {
    throw agentErrorFromResponse(response, "Workflow dispatch failed")
  }
  return { dispatched: true }
}

export async function rerunChecks(
  repo: RepoRef,
  input: { runId: number; failedOnly?: boolean },
): Promise<RerunChecksResult> {
  const suffix = input.failedOnly ? "rerun-failed-jobs" : "rerun"
  const response = await ghRestRaw(
    "POST",
    `${repoPath(repo)}/actions/runs/${segment(input.runId)}/${suffix}`,
  )
  if (!response.ok) throw agentErrorFromResponse(response, "Rerun checks failed")
  return { rerun: true }
}

export async function getWorkflowRun(
  repo: RepoRef,
  runId: number,
): Promise<WorkflowRunSummary> {
  const run = await ghRest<{ status?: string | null; conclusion?: string | null }>(
    "GET",
    `${repoPath(repo)}/actions/runs/${segment(runId)}`,
  )
  const jobs = await ghRest<{
    jobs?: Array<{ name?: string; status?: string | null; conclusion?: string | null }>
  }>("GET", `${repoPath(repo)}/actions/runs/${segment(runId)}/jobs`)

  return {
    status: run.status,
    conclusion: run.conclusion,
    jobs: (jobs.jobs ?? []).slice(0, JOB_SUMMARY_LIMIT).map<WorkflowJobSummary>((job) => ({
      name: job.name ?? "",
      status: job.status,
      conclusion: job.conclusion,
    })),
  }
}

export async function mergePullRequest(
  repo: RepoRef,
  input: { pr: number; method?: "merge" | "squash" | "rebase"; expectedHeadSha: string },
): Promise<MergeResult> {
  const response = await ghRestRaw(
    "PUT",
    `${repoPath(repo)}/pulls/${segment(input.pr)}/merge`,
    {
      body: {
        merge_method: input.method ?? "squash",
        sha: input.expectedHeadSha,
      },
    },
  )

  if (response.status === 405 || response.status === 409) {
    throw new AgentError("HEAD_MOVED", "Pull request head moved or is not mergeable")
  }
  if (!response.ok) throw agentErrorFromResponse(response, "Pull request merge failed")

  const result = await readJsonObject(response)
  if (result.merged === false) {
    throw new AgentError(
      "UPSTREAM",
      stringValue(result.message) ?? "GitHub did not merge the pull request",
    )
  }

  return { merged: true, sha: stringValue(result.sha) ?? "" }
}

export async function markReadyForReview(
  prNodeId: string,
): Promise<ReadyForReviewResult> {
  await ghGraphQL<unknown>(
    `mutation FirstMateReadyForReview($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          id
        }
      }
    }`,
    { pullRequestId: prNodeId },
  )
  return { ready: true }
}

export function __resetAgentServiceCachesForTests(): void {
  rosterCache.clear()
  repoNodeCache.clear()
}
