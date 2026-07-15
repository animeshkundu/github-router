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
  type ClosePullRequestResult,
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

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false }
  let truncated = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8")
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1)
  return { value: truncated, truncated: true }
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
  body?: string | null
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
    .map((pull) => {
      const unitIdMarker = unitIdMarkerFromBody(pull.body)
      return {
        number: pull.number ?? 0,
        headSha: pull.head?.sha ?? "",
        headRef: pull.head?.ref ?? "",
        isDraft: pull.draft ?? false,
        ...(unitIdMarker !== undefined ? { unitIdMarker } : {}),
      }
    })
}

function unitIdMarkerFromBody(body: string | null | undefined): string | undefined {
  if (!body) return undefined
  const match = /\bunit-id:\s*([A-Za-z0-9-]+?)(?=\s|<|-->|$)/i.exec(body)
  return match?.[1]
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
  node_id?: string | null
  user?: { login?: string | null } | null
  state?: string | null
  body?: string | null
  submitted_at?: string | null
  commit_id?: string | null
}

export interface ReviewSummary {
  author: string
  /** COMMENTED | APPROVED | CHANGES_REQUESTED | ... */
  state: string
  bodyExcerpt: string
  submittedAt?: string
  /** The commit the review was made against — used to reject stale reviews. */
  commitId?: string
  /** GraphQL review node id — needed to dismiss a stale own review (A5). */
  nodeId?: string
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
    ...(review.commit_id ? { commitId: review.commit_id } : {}),
    ...(review.node_id ? { nodeId: review.node_id } : {}),
  }))
}

/**
 * A5 (5a) — dismiss a PR review by its GraphQL node id. Best-effort: any failure
 * (already dismissed, insufficient scope, race) is swallowed and reported as
 * `{dismissed:false}` — a failed dismiss must not abort the controller sweep.
 */
export async function dismissPullRequestReview(
  reviewNodeId: string,
  message?: string,
): Promise<{ dismissed: boolean }> {
  try {
    await ghGraphQL<unknown>(
      `mutation FirstMateDismissReview($pullRequestReviewId: ID!, $message: String!) {
        dismissPullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId, message: $message }) {
          pullRequestReview {
            id
            state
          }
        }
      }`,
      {
        pullRequestReviewId: reviewNodeId,
        message: message ?? "Superseded by a newer commit.",
      },
    )
    return { dismissed: true }
  } catch (err) {
    consola.debug(`first-mate: dismissPullRequestReview(${reviewNodeId}) skipped:`, err)
    return { dismissed: false }
  }
}

/**
 * The authenticated actor's login (`viewer { login }`). Exposed for the
 * controller dep surface; A5 ownership uses a body sentinel rather than author
 * identity (the solo operator's account may BE the router PAT), so this is a
 * diagnostic/roster helper, not the dismiss gate.
 */
export async function getSelfLogin(): Promise<string> {
  const data = await ghGraphQL<{ viewer?: { login?: string | null } | null }>(
    `query FirstMateViewer { viewer { login } }`,
    {},
  )
  return data.viewer?.login ?? ""
}


interface PullRequestGraphQLData {
  repository?: {
    pullRequest?: {
      id?: string | null
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
          id
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
    nodeId: pullRequest.id ?? undefined,
  }
}

interface CheckRunRestResponse {
  total_count?: number
  check_runs?: Array<{
    id?: number
    name?: string
    status?: string | null
    conclusion?: string | null
    html_url?: string | null
    details_url?: string | null
  }>
}

// The check-runs API has NO authoritative aggregate state (unlike the legacy
// /status API's top-level `state`), so a failing/pending run sitting on an
// un-fetched page is invisible and would yield a spurious "passing" rollup —
// a real bypass for a matrix CI with >30 runs (GitHub's default page size).
// Enumerate ALL runs (per_page=100); if a repo has more than PER_PAGE*MAX_PAGES
// runs we cannot confirm green and FAIL-CLOSED (treat as pending → refuse merge).
const CHECK_RUNS_PER_PAGE = 100
const CHECK_RUNS_MAX_PAGES = 20

interface CombinedStatusRestResponse {
  state?: string | null
  total_count?: number
  statuses?: Array<{
    state?: string | null
    context?: string | null
    target_url?: string | null
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
  // Enumerate every check-run page — a single page (≤30 by default) can hide a
  // failing run behind an all-green first page. `checkRunsIncomplete` is set only
  // when the repo exceeds our page cap so we can never miss a red tail silently.
  const allCheckRuns: NonNullable<CheckRunRestResponse["check_runs"]> = []
  let checkRunsIncomplete = false
  {
    let page = 1
    let total = 0
    for (;;) {
      const response = await ghRest<CheckRunRestResponse>(
        "GET",
        `${repoPath(repo)}/commits/${segment(sha)}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
      )
      const runs = response.check_runs ?? []
      if (page === 1) total = response.total_count ?? runs.length
      allCheckRuns.push(...runs)
      if (allCheckRuns.length >= total || runs.length === 0) break
      page += 1
      if (page > CHECK_RUNS_MAX_PAGES) {
        checkRunsIncomplete = true
        break
      }
    }
  }
  // The Copilot code-review bot registers its own check-run
  // ("copilot-pull-request-reviewer": success). That is a REVIEW marker, not a
  // test — counting it would report ci_rollup "passing" for a PR whose actual
  // lint/test suite never ran. Exclude review-bot check-runs from CI.
  const checkRuns = allCheckRuns.filter(
    (check) => !/pull-request-reviewer/i.test(check.name ?? ""),
  )
  const runningCount = checkRuns.filter(
    (check) => check.status !== "completed" || !check.conclusion,
  ).length
  const failingRuns = checkRuns.filter((check) => isFailingConclusion(check.conclusion))

  // ALSO fold in the legacy Commit Status API (CircleCI/Travis/Jenkins and any
  // required status context): a repo on the Status API can have a red/pending
  // REQUIRED status while registering ZERO check-runs — reporting rollup "none"
  // for that would let evaluateMergeSafety merge over failing/pending CI.
  // GitHub returns state:"pending" with total_count:0 for a commit that has NO
  // statuses at all, so the legacy signal is folded ONLY when at least one
  // status context exists — otherwise a modern Actions-only repo (zero legacy
  // statuses) would be spuriously reported pending and blocked from merge.
  const statusResponse = await ghRest<CombinedStatusRestResponse>(
    "GET",
    `${repoPath(repo)}/commits/${segment(sha)}/status`,
  )
  const legacyStatuses = statusResponse.statuses ?? []
  const hasLegacyStatuses =
    (statusResponse.total_count ?? 0) > 0 || legacyStatuses.length > 0
  const legacyState = (statusResponse.state ?? "").toLowerCase()
  const legacyFailing = hasLegacyStatuses && (legacyState === "failure" || legacyState === "error")
  const legacyPending = hasLegacyStatuses && legacyState === "pending"
  const failingLegacy = hasLegacyStatuses
    ? legacyStatuses.filter((s) => {
        const st = (s.state ?? "").toLowerCase()
        return st === "failure" || st === "error"
      })
    : []

  const anyFailing = failingRuns.length > 0 || legacyFailing
  // An un-enumerated check-run tail (repo exceeds the page cap) is treated as
  // pending — we cannot prove those runs are green, so the rollup must not be
  // "passing".
  const anyPending = runningCount > 0 || legacyPending || checkRunsIncomplete
  const anySignal = checkRuns.length > 0 || hasLegacyStatuses || checkRunsIncomplete

  let rollup: RequiredChecksSummary["rollup"] = "none"
  if (anySignal) {
    if (anyFailing) rollup = "failing"
    else if (anyPending) rollup = "pending"
    else rollup = "passing"
  }

  const checks: CheckSummary[] = checkRuns.slice(0, CHECK_SUMMARY_LIMIT).map((check) => ({
    id: check.id ?? 0,
    name: check.name ?? "",
    conclusion: check.conclusion,
  }))
  const failing: FailingCheckSummary[] = [
    ...failingRuns.map((check) => ({
      name: check.name ?? "",
      url: check.html_url ?? check.details_url ?? undefined,
    })),
    ...failingLegacy.map((s) => ({
      name: s.context ?? "",
      url: s.target_url ?? undefined,
    })),
  ].slice(0, FAILING_CHECK_LIMIT)

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
 * FAIL-SAFE: a 404 resolves to `false` (genuinely no workflows dir), but ANY
 * other probe error is INDETERMINATE and is RE-THROWN — resolving an
 * indeterminate probe to "no workflows" would permit a merge on an unverifiable
 * CI picture. The caller treats a throw as NOT-green (refuse).
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
    // 404 → no workflows dir → genuinely no CI (cache + return false). ANY other
    // error is INDETERMINATE: do NOT resolve it to "no workflows" (fail-open) —
    // re-throw so the caller refuses to merge on an unverifiable CI picture.
    if (err instanceof AgentError && err.code === "NOT_FOUND") {
      value = false
    } else {
      consola.debug("first-mate: workflow probe failed (indeterminate CI):", err)
      throw err
    }
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

/**
 * Post a comment that @-mentions the GitHub Copilot cloud agent so it iterates
 * on the SAME branch/PR. A bare `REQUEST_CHANGES` review does NOT wake the cloud
 * agent — the `@copilot` mention in an issue/PR comment is what actually
 * triggers it to push a follow-up commit. Thin wrapper over `postComment` that
 * prepends the mention; the caller supplies the consolidated fix instructions.
 */
export async function mentionCopilot(
  repo: RepoRef,
  pr: number,
  body: string,
): Promise<CommentResult> {
  return postComment(repo, pr, `@copilot ${body}`)
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

/**
 * Close a pull request WITHOUT merging it, via REST
 * `PATCH /repos/{owner}/{repo}/pulls/{pr}` with `{ state: "closed" }`. A merged
 * PR cannot be closed this way (GitHub rejects it), so callers that must not
 * touch a merged PR should gate on `getPullRequestState` first. Idempotent for
 * an already-closed PR (GitHub returns the closed PR object).
 */
export async function closePullRequest(
  repo: RepoRef,
  pr: number,
): Promise<ClosePullRequestResult> {
  const result = await ghRest<{ state?: string | null }>(
    "PATCH",
    `${repoPath(repo)}/pulls/${segment(pr)}`,
    { body: { state: "closed" } },
  )
  return { closed: true, state: result.state ?? "closed" }
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

export interface UpdateBranchResult {
  updated: boolean
  message?: string
}

/** Update a PR branch only while its head still matches the caller's observation. */
export async function updateBranch(
  repo: RepoRef,
  pr: number,
  expectedHeadSha: string,
): Promise<UpdateBranchResult> {
  const response = await ghRestRaw(
    "PUT",
    `${repoPath(repo)}/pulls/${segment(pr)}/update-branch`,
    { body: { expected_head_sha: expectedHeadSha } },
  )
  const result = await readJsonObject(response)
  if (response.status === 422) {
    return {
      updated: false,
      ...(stringValue(result.message) ? { message: stringValue(result.message) } : {}),
    }
  }
  if (!response.ok) throw agentErrorFromResponse(response, "Pull request branch update failed")
  return {
    updated: true,
    ...(stringValue(result.message) ? { message: stringValue(result.message) } : {}),
  }
}

export interface InboundIssueSummary {
  number: number
  title: string
  authorLogin: string
  isBot: boolean
  labels: string[]
  createdAt: string
  updatedAt: string
}

export interface InboundPullRequestSummary extends InboundIssueSummary {
  isDraft: boolean
  headSha: string
}

interface InboundIssueRestResponse {
  number?: number
  title?: string | null
  user?: { login?: string | null; type?: string | null } | null
  labels?: Array<string | { name?: string | null }>
  pull_request?: unknown
  draft?: boolean | null
  head?: { sha?: string | null } | null
  created_at?: string | null
  updated_at?: string | null
}

const INBOUND_PER_PAGE = 100
const INBOUND_MAX_PAGES = 2

async function listInboundPages(
  repo: RepoRef,
  resource: "issues" | "pulls",
): Promise<InboundIssueRestResponse[]> {
  const items: InboundIssueRestResponse[] = []
  for (let page = 1; page <= INBOUND_MAX_PAGES; page += 1) {
    const batch = await ghRest<InboundIssueRestResponse[]>(
      "GET",
      `${repoPath(repo)}/${resource}?state=open&per_page=${INBOUND_PER_PAGE}&page=${page}`,
    )
    items.push(...batch)
    if (batch.length < INBOUND_PER_PAGE) break
  }
  return items.slice(0, INBOUND_PER_PAGE * INBOUND_MAX_PAGES)
}

function inboundAuthor(item: InboundIssueRestResponse): {
  authorLogin: string
  isBot: boolean
} {
  const authorLogin = item.user?.login ?? ""
  return {
    authorLogin,
    isBot: item.user?.type === "Bot" || /\[bot\]$/i.test(authorLogin),
  }
}

function inboundLabels(item: InboundIssueRestResponse): string[] {
  return (item.labels ?? []).flatMap((label) => {
    if (typeof label === "string") return [label]
    return label.name ? [label.name] : []
  })
}

export async function listInboundIssues(repo: RepoRef): Promise<InboundIssueSummary[]> {
  const issues = await listInboundPages(repo, "issues")
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({
      number: issue.number ?? 0,
      title: issue.title ?? "",
      ...inboundAuthor(issue),
      labels: inboundLabels(issue),
      createdAt: issue.created_at ?? "",
      updatedAt: issue.updated_at ?? "",
    }))
}

export async function listInboundPRs(
  repo: RepoRef,
): Promise<InboundPullRequestSummary[]> {
  const pulls = await listInboundPages(repo, "pulls")
  return pulls.map((pull) => ({
    number: pull.number ?? 0,
    title: pull.title ?? "",
    ...inboundAuthor(pull),
    labels: inboundLabels(pull),
    isDraft: pull.draft ?? false,
    createdAt: pull.created_at ?? "",
    updatedAt: pull.updated_at ?? "",
    headSha: pull.head?.sha ?? "",
  }))
}

export interface BranchProtectionSpec {
  requiredStatusCheckContexts: string[]
  strict: boolean
  requiredApprovingReviewCount: number
  requireLinearHistory: boolean
  requireConversationResolution: boolean
}

export interface BranchProtectionResult {
  rulesetId: number
  action: "created" | "updated"
}

interface RulesetRestResponse {
  id?: number
  name?: string | null
  target?: string | null
}

/** Create or replace the first-mate-managed branch ruleset for one branch. */
export async function configureBranchProtection(
  repo: RepoRef,
  branch: string,
  spec: BranchProtectionSpec,
): Promise<BranchProtectionResult> {
  const name = `first-mate:${branch}`
  const existing = await ghRest<RulesetRestResponse[]>(
    "GET",
    `${repoPath(repo)}/rulesets?per_page=100`,
  )
  const current = existing.find((ruleset) => ruleset.name === name && ruleset.target === "branch")
  const body = {
    name,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: [`refs/heads/${branch}`], exclude: [] },
    },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: spec.requiredStatusCheckContexts.map((context) => ({ context })),
          strict_required_status_checks_policy: spec.strict,
        },
      },
      {
        type: "pull_request",
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: spec.requiredApprovingReviewCount,
          required_review_thread_resolution: spec.requireConversationResolution,
        },
      },
      ...(spec.requireLinearHistory ? [{ type: "required_linear_history" }] : []),
    ],
  }
  const action = current?.id === undefined ? "created" : "updated"
  const result = await ghRest<RulesetRestResponse>(
    current?.id === undefined ? "POST" : "PUT",
    current?.id === undefined
      ? `${repoPath(repo)}/rulesets`
      : `${repoPath(repo)}/rulesets/${segment(current.id)}`,
    { body },
  )
  return { rulesetId: result.id ?? current?.id ?? 0, action }
}

export interface EnvironmentReviewer {
  type: "User" | "Team"
  id: number
}

export interface EnsureEnvironmentOptions {
  waitTimer?: number
  reviewers?: EnvironmentReviewer[]
  preventSelfReview?: boolean
}

export async function ensureEnvironment(
  repo: RepoRef,
  name: string,
  opts: EnsureEnvironmentOptions = {},
): Promise<{ name: string; created: boolean }> {
  const body: Record<string, unknown> = {}
  if (opts.waitTimer !== undefined) body.wait_timer = opts.waitTimer
  if (opts.reviewers !== undefined) body.reviewers = opts.reviewers
  if (opts.preventSelfReview !== undefined) body.prevent_self_review = opts.preventSelfReview

  const response = await ghRestRaw(
    "PUT",
    `${repoPath(repo)}/environments/${segment(name)}`,
    { body },
  )
  if (!response.ok) throw agentErrorFromResponse(response, "Environment update failed")
  const result = await readJsonObject(response)
  return { name: stringValue(result.name) ?? name, created: response.status === 201 }
}

export interface CreateReleaseInput {
  tagName: string
  targetCommitish?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  generateReleaseNotes?: boolean
}

export interface ReleaseSummary {
  id: number
  tagName: string
  url: string
  isLatest?: boolean
}

interface ReleaseRestResponse {
  id?: number
  tag_name?: string | null
  html_url?: string | null
  url?: string | null
}

function releaseSummary(release: ReleaseRestResponse, isLatest?: boolean): ReleaseSummary {
  return {
    id: release.id ?? 0,
    tagName: release.tag_name ?? "",
    url: release.html_url ?? release.url ?? "",
    ...(isLatest !== undefined ? { isLatest } : {}),
  }
}

export async function createRelease(
  repo: RepoRef,
  input: CreateReleaseInput,
): Promise<ReleaseSummary> {
  const body: Record<string, unknown> = { tag_name: input.tagName }
  if (input.targetCommitish !== undefined) body.target_commitish = input.targetCommitish
  if (input.name !== undefined) body.name = input.name
  if (input.body !== undefined) body.body = input.body
  if (input.draft !== undefined) body.draft = input.draft
  if (input.prerelease !== undefined) body.prerelease = input.prerelease
  if (input.generateReleaseNotes !== undefined) {
    body.generate_release_notes = input.generateReleaseNotes
  }
  const release = await ghRest<ReleaseRestResponse>(
    "POST",
    `${repoPath(repo)}/releases`,
    { body, retry: false },
  )
  return releaseSummary(release)
}

export async function getLatestRelease(repo: RepoRef): Promise<ReleaseSummary | null> {
  const response = await ghRestRaw("GET", `${repoPath(repo)}/releases/latest`)
  if (response.status === 404) return null
  if (!response.ok) throw agentErrorFromResponse(response, "Latest release lookup failed")
  const release = await readJsonObject(response) as ReleaseRestResponse
  return releaseSummary(release, true)
}

export type SecurityFeatureStatus = "enabled" | "disabled"

export interface RepoSettings {
  description?: string
  homepage?: string
  hasIssues?: boolean
  hasProjects?: boolean
  hasWiki?: boolean
  hasDiscussions?: boolean
  securityAndAnalysis?: {
    advancedSecurity?: SecurityFeatureStatus
    secretScanning?: SecurityFeatureStatus
    secretScanningPushProtection?: SecurityFeatureStatus
  }
  enablePrivateVulnerabilityReporting?: true
}

export async function updateRepoSettings(
  repo: RepoRef,
  settings: RepoSettings,
): Promise<{ appliedFields: string[] }> {
  const body: Record<string, unknown> = {}
  const appliedFields: string[] = []
  const fields = [
    ["description", settings.description],
    ["homepage", settings.homepage],
    ["has_issues", settings.hasIssues],
    ["has_projects", settings.hasProjects],
    ["has_wiki", settings.hasWiki],
    ["has_discussions", settings.hasDiscussions],
  ] as const
  for (const [field, value] of fields) {
    if (value === undefined) continue
    body[field] = value
    appliedFields.push(field)
  }
  if (settings.securityAndAnalysis !== undefined) {
    const securityAndAnalysis: Record<string, { status: SecurityFeatureStatus }> = {}
    const securityFields = [
      ["advanced_security", settings.securityAndAnalysis.advancedSecurity],
      ["secret_scanning", settings.securityAndAnalysis.secretScanning],
      ["secret_scanning_push_protection", settings.securityAndAnalysis.secretScanningPushProtection],
    ] as const
    for (const [field, value] of securityFields) {
      if (value === undefined) continue
      securityAndAnalysis[field] = { status: value }
      appliedFields.push(`security_and_analysis.${field}`)
    }
    if (Object.keys(securityAndAnalysis).length > 0) body.security_and_analysis = securityAndAnalysis
  }

  if (Object.keys(body).length > 0) {
    await ghRest<unknown>("PATCH", repoPath(repo), { body })
  }
  if (settings.enablePrivateVulnerabilityReporting === true) {
    await ghRest<unknown>("PUT", `${repoPath(repo)}/private-vulnerability-reporting`)
    appliedFields.push("private_vulnerability_reporting")
  }
  return { appliedFields }
}

export type PagesSourceOptions =
  | { buildType: "workflow" }
  | { buildType: "legacy"; branch: string; path?: "/" | "/docs" }

export async function setPagesSource(
  repo: RepoRef,
  opts: PagesSourceOptions,
): Promise<{ configured: boolean; url?: string }> {
  const body = opts.buildType === "workflow"
    ? { build_type: "workflow" }
    : {
        build_type: "legacy",
        source: { branch: opts.branch, path: opts.path ?? "/" },
      }
  const result = await ghRest<{ html_url?: string | null }>(
    "POST",
    `${repoPath(repo)}/pages`,
    { body, retry: false },
  )
  return {
    configured: true,
    ...(result.html_url ? { url: result.html_url } : {}),
  }
}

export interface CreateRepoInput {
  name: string
  org?: string
  private?: boolean
  description?: string
  autoInit?: boolean
  gitignoreTemplate?: string
  licenseTemplate?: string
}

export interface CreateRepoResult {
  owner: string
  name: string
  url: string
  defaultBranch: string
}

export class RepoAlreadyExistsError extends Error {
  readonly code = "already-exists"

  constructor(name: string, org?: string) {
    super(`Repository ${org ? `${org}/` : ""}${name} already exists or is unavailable`)
    this.name = "RepoAlreadyExistsError"
  }
}

/** Create a personal or organization repository without retrying the non-idempotent POST. */
export async function createRepo(input: CreateRepoInput): Promise<CreateRepoResult> {
  const body: Record<string, unknown> = { name: input.name }
  if (input.private !== undefined) body.private = input.private
  if (input.description !== undefined) body.description = input.description
  if (input.autoInit !== undefined) body.auto_init = input.autoInit
  if (input.gitignoreTemplate !== undefined) body.gitignore_template = input.gitignoreTemplate
  if (input.licenseTemplate !== undefined) body.license_template = input.licenseTemplate
  const path = input.org ? `/orgs/${segment(input.org)}/repos` : "/user/repos"
  const response = await ghRestRaw("POST", path, { body, retry: false })
  if (response.status === 422) throw new RepoAlreadyExistsError(input.name, input.org)
  if (!response.ok) throw agentErrorFromResponse(response, "Repository creation failed")
  const result = await readJsonObject(response)
  const owner = asRecord(result.owner)
  return {
    owner: stringValue(owner?.login) ?? input.org ?? "",
    name: stringValue(result.name) ?? input.name,
    url: stringValue(result.html_url) ?? stringValue(result.url) ?? "",
    defaultBranch: stringValue(result.default_branch) ?? "",
  }
}

export interface WorkflowFailureDetail {
  failingJobs: Array<{ name: string; url: string; failedSteps: string[] }>
  annotations: Array<{ path: string; line: number; level: string; message: string }>
  truncated: boolean
}

interface WorkflowFailureJob {
  id?: number
  check_run_id?: number
  check_run_url?: string | null
  name?: string | null
  html_url?: string | null
  conclusion?: string | null
  steps?: Array<{ name?: string | null; conclusion?: string | null }>
}

function checkRunIdForJob(job: WorkflowFailureJob): number | undefined {
  if (job.check_run_id !== undefined) return job.check_run_id
  const match = /\/check-runs\/(\d+)(?:\?|$)/.exec(job.check_run_url ?? "")
  return match ? Number(match[1]) : undefined
}

export async function getWorkflowRunFailedLogs(
  repo: RepoRef,
  runId: number,
  opts: { maxBytes?: number; maxJobs?: number; maxAnnotations?: number } = {},
): Promise<WorkflowFailureDetail> {
  const maxBytes = Math.max(1024, opts.maxBytes ?? 16 * 1024)
  const maxJobs = Math.min(20, Math.max(1, opts.maxJobs ?? 10))
  const maxAnnotations = Math.min(100, Math.max(1, opts.maxAnnotations ?? 50))
  const response = await ghRest<{ jobs?: WorkflowFailureJob[] }>(
    "GET",
    `${repoPath(repo)}/actions/runs/${segment(runId)}/jobs?per_page=100`,
  )
  const failed = (response.jobs ?? []).filter((job) => job.conclusion === "failure")
  let truncated = failed.length > maxJobs
  const failingJobs = failed.slice(0, maxJobs).map((job) => {
    const failedSteps = (job.steps ?? [])
      .filter((step) => step.conclusion === "failure")
      .map((step) => step.name ?? "")
    if (failedSteps.length > 20) truncated = true
    return {
      name: job.name ?? "",
      url: job.html_url ?? "",
      failedSteps: failedSteps.slice(0, 20),
    }
  })
  const annotations: WorkflowFailureDetail["annotations"] = []
  for (const job of failed.slice(0, maxJobs)) {
    const checkRunId = checkRunIdForJob(job)
    if (checkRunId === undefined || annotations.length >= maxAnnotations) continue
    try {
      const items = await ghRest<Array<{
        path?: string | null
        start_line?: number | null
        annotation_level?: string | null
        message?: string | null
      }>>(
        "GET",
        `${repoPath(repo)}/check-runs/${segment(checkRunId)}/annotations?per_page=100`,
      )
      for (const item of items) {
        if (annotations.length >= maxAnnotations) {
          truncated = true
          break
        }
        const candidate = {
          path: item.path ?? "",
          line: item.start_line ?? 0,
          level: item.annotation_level ?? "",
          message: item.message ?? "",
        }
        if (Buffer.byteLength(JSON.stringify({ failingJobs, annotations: [...annotations, candidate] })) > maxBytes) {
          truncated = true
          break
        }
        annotations.push(candidate)
      }
    } catch (err) {
      consola.debug(`first-mate: annotations for check-run ${checkRunId} unavailable:`, err)
    }
  }
  while (Buffer.byteLength(JSON.stringify({ failingJobs, annotations })) > maxBytes) {
    if (annotations.length > 0) {
      annotations.pop()
      truncated = true
      continue
    }
    const lastJob = failingJobs.at(-1)
    if (!lastJob) break
    const lastStep = lastJob.failedSteps.at(-1)
    if (lastStep !== undefined) {
      lastJob.failedSteps.pop()
      truncated = true
      continue
    }
    const name = truncateUtf8(lastJob.name, Math.max(64, Math.floor(maxBytes / 4)))
    const url = truncateUtf8(lastJob.url, Math.max(64, Math.floor(maxBytes / 4)))
    if (name.truncated || url.truncated) {
      lastJob.name = name.value
      lastJob.url = url.value
      truncated = true
      continue
    }
    failingJobs.pop()
    truncated = true
  }
  return { failingJobs, annotations, truncated }
}

export interface PullRequestDiffContent {
  files: Array<{
    filename: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }>
  truncated: boolean
}

export async function getPullRequestDiffContent(
  repo: RepoRef,
  pr: number,
  opts: { maxBytes?: number; maxPatchBytes?: number } = {},
): Promise<PullRequestDiffContent> {
  const maxBytes = Math.max(1024, opts.maxBytes ?? 24 * 1024)
  const maxPatchBytes = Math.min(maxBytes, Math.max(256, opts.maxPatchBytes ?? 12 * 1024))
  const files: PullRequestDiffContent["files"] = []
  let truncated = false
  for (let page = 1; page <= 2; page += 1) {
    const batch = await ghRest<Array<PullFileRestResponse & { patch?: string | null }>>(
      "GET",
      `${repoPath(repo)}/pulls/${segment(pr)}/files?per_page=100&page=${page}`,
    )
    for (const file of batch) {
      const candidate: PullRequestDiffContent["files"][number] = {
        filename: file.filename ?? "",
        status: file.status ?? "",
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      }
      if (file.patch !== undefined && file.patch !== null) {
        const patch = truncateUtf8(file.patch, maxPatchBytes)
        candidate.patch = patch.value
        truncated ||= patch.truncated
      }
      if (Buffer.byteLength(JSON.stringify({ files: [...files, candidate] })) > maxBytes) {
        truncated = true
        return { files, truncated }
      }
      files.push(candidate)
    }
    if (batch.length < 100) return { files, truncated }
  }
  return { files, truncated: true }
}

export interface ReviewCommentSummary {
  path: string
  line: number
  author: string
  bodyExcerpt: string
}

export async function getReviewComments(repo: RepoRef, pr: number): Promise<ReviewCommentSummary[]> {
  const comments = await ghRest<Array<{
    path?: string | null
    line?: number | null
    original_line?: number | null
    user?: { login?: string | null } | null
    body?: string | null
  }>>("GET", `${repoPath(repo)}/pulls/${segment(pr)}/comments?per_page=100`)
  return comments.slice(0, 100).map((comment) => ({
    path: comment.path ?? "",
    line: comment.line ?? comment.original_line ?? 0,
    author: comment.user?.login ?? "",
    bodyExcerpt: (comment.body ?? "").slice(0, REVIEW_BODY_LIMIT),
  }))
}

export interface BranchRulesetSummary {
  ruleTypes: string[]
  requiredChecks: string[]
  strict: boolean
  requiredApprovingReviewCount: number
}

export async function getBranchRuleset(
  repo: RepoRef,
  branch: string,
): Promise<BranchRulesetSummary> {
  const rules = await ghRest<Array<{
    type?: string | null
    parameters?: {
      required_status_checks?: Array<{ context?: string | null }>
      strict_required_status_checks_policy?: boolean
      required_approving_review_count?: number
    } | null
  }>>("GET", `${repoPath(repo)}/rules/branches/${segment(branch)}`)
  const requiredChecks = rules.flatMap((rule) =>
    (rule.parameters?.required_status_checks ?? []).flatMap((check) =>
      check.context ? [check.context] : [],
    ),
  ).slice(0, 100)
  return {
    ruleTypes: [...new Set(rules.flatMap((rule) => rule.type ? [rule.type] : []))].slice(0, 50),
    requiredChecks,
    strict: rules.some((rule) => rule.parameters?.strict_required_status_checks_policy === true),
    requiredApprovingReviewCount: Math.max(
      0,
      ...rules.map((rule) => rule.parameters?.required_approving_review_count ?? 0),
    ),
  }
}

export interface AlertCountResult {
  enabled: boolean
  count?: number
  truncated?: boolean
}

function countFromLink(response: Response): number | undefined {
  const link = response.headers.get("link") ?? ""
  const last = link.split(",").find((part) => /rel="last"/.test(part))
  const match = last ? /[?&]page=(\d+)/.exec(last) : undefined
  return match ? Number(match[1]) : undefined
}

async function getAlertCount(
  repo: RepoRef,
  resource: "code-scanning" | "dependabot",
  stateName: string,
): Promise<AlertCountResult> {
  const response = await ghRestRaw(
    "GET",
    `${repoPath(repo)}/${resource}/alerts?state=${segment(stateName)}&per_page=1`,
  )
  if (response.status === 403 || response.status === 404) return { enabled: false }
  if (!response.ok) throw agentErrorFromResponse(response, `${resource} alert lookup failed`)
  const count = countFromLink(response)
  const body = await response.json().catch(() => [])
  const fallbackCount = Array.isArray(body) ? body.length : 0
  return { enabled: true, count: count ?? fallbackCount }
}

export function getCodeScanningAlertCount(
  repo: RepoRef,
  stateName = "open",
): Promise<AlertCountResult> {
  return getAlertCount(repo, "code-scanning", stateName)
}

export function getDependabotAlertCount(
  repo: RepoRef,
  stateName = "open",
): Promise<AlertCountResult> {
  return getAlertCount(repo, "dependabot", stateName)
}

export interface CommunityProfileSummary {
  healthPercentage: number
  files: Record<string, boolean>
}

export async function getCommunityProfile(repo: RepoRef): Promise<CommunityProfileSummary> {
  const result = await ghRest<{
    health_percentage?: number
    files?: Record<string, unknown>
  }>("GET", `${repoPath(repo)}/community/profile`)
  const files: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(result.files ?? {}).slice(0, 50)) {
    files[name] = value !== null && value !== false
  }
  return { healthPercentage: result.health_percentage ?? 0, files }
}

export interface PagesStatus {
  enabled: boolean
  status?: string
  cname?: string
  htmlUrl?: string
  buildType?: string
}

export async function getPagesStatus(repo: RepoRef): Promise<PagesStatus> {
  const response = await ghRestRaw("GET", `${repoPath(repo)}/pages`)
  if (response.status === 404) return { enabled: false }
  if (!response.ok) throw agentErrorFromResponse(response, "Pages status lookup failed")
  const result = await readJsonObject(response)
  return {
    enabled: true,
    ...(stringValue(result.status) ? { status: stringValue(result.status) } : {}),
    ...(stringValue(result.cname) ? { cname: stringValue(result.cname) } : {}),
    ...(stringValue(result.html_url) ? { htmlUrl: stringValue(result.html_url) } : {}),
    ...(stringValue(result.build_type) ? { buildType: stringValue(result.build_type) } : {}),
  }
}

export interface LatestDeploymentStatus {
  environment: string
  state: string
  targetUrl?: string
  createdAt: string
}

export async function getLatestDeploymentStatus(
  repo: RepoRef,
  opts: { environment?: string } = {},
): Promise<LatestDeploymentStatus | null> {
  const environment = opts.environment
    ? `&environment=${segment(opts.environment)}`
    : ""
  const deployments = await ghRest<Array<{
    id?: number
    environment?: string | null
  }>>("GET", `${repoPath(repo)}/deployments?per_page=1${environment}`)
  const deployment = deployments[0]
  if (!deployment?.id) return null
  const statuses = await ghRest<Array<{
    state?: string | null
    target_url?: string | null
    environment_url?: string | null
    created_at?: string | null
  }>>(
    "GET",
    `${repoPath(repo)}/deployments/${segment(deployment.id)}/statuses?per_page=1`,
  )
  const status = statuses[0]
  if (!status) return null
  return {
    environment: deployment.environment ?? opts.environment ?? "",
    state: status.state ?? "",
    ...(status.environment_url ?? status.target_url
      ? { targetUrl: status.environment_url ?? status.target_url ?? undefined }
      : {}),
    createdAt: status.created_at ?? "",
  }
}

export interface LiveTextResult {
  ok: boolean
  status: number
  text: string
  finalUrl: string
}

export async function fetchLiveText(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<LiveTextResult> {
  const maxBytes = Math.min(1024 * 1024, Math.max(1024, opts.maxBytes ?? 64 * 1024))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(100, opts.timeoutMs ?? 10_000))
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal })
    const reader = response.body?.getReader()
    if (!reader) return { ok: response.ok, status: response.status, text: "", finalUrl: response.url }
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - size
      chunks.push(value.subarray(0, remaining))
      size += Math.min(value.byteLength, remaining)
      if (value.byteLength > remaining || size >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
      finalUrl: response.url,
    }
  } catch {
    return { ok: false, status: 0, text: "", finalUrl: url }
  } finally {
    clearTimeout(timeout)
  }
}

export interface CommitFileEntry {
  path: string
  content: string
}

export type CommitMode = "add-missing-only" | "overwrite-approved"

export interface CommitFilesResult {
  committed: string[]
  preserved: string[]
}

export class CommitFilesError extends Error {
  readonly code: "branch-not-found" | "api-error"
  readonly cause?: unknown

  constructor(message: string, code: "branch-not-found" | "api-error", options?: { cause?: unknown }) {
    super(message)
    this.name = "CommitFilesError"
    this.code = code
    this.cause = options?.cause
  }
}

interface CommitGitRefResponse {
  object?: {
    sha?: string | null
  } | null
}

interface CommitGitCommitResponse {
  tree?: {
    sha?: string | null
  } | null
}

interface CommitGitBlobResponse {
  sha?: string | null
}

interface CommitGitTreeResponse {
  sha?: string | null
}

interface CommitGitCreateCommitResponse {
  sha?: string | null
}

interface CommitTreeEntry {
  path: string
  mode: "100644"
  type: "blob"
  sha: string
}

export async function commitFiles(
  repo: string,
  branch: string,
  files: CommitFileEntry[],
  opts: { mode?: CommitMode; message?: string } = {},
): Promise<CommitFilesResult> {
  const parsedRepo = parseCommitRepoSlug(repo)
  const normalizedBranch = normalizeCommitBranch(branch)
  const mode = opts.mode ?? "add-missing-only"
  const message = opts.message ?? "scaffold: seed agentic-dev conventions"
  const normalizedFiles = files.map((file) => ({
    path: normalizeCommitFilePath(file.path),
    content: file.content,
  }))

  let ref: CommitGitRefResponse
  try {
    ref = await ghRest<CommitGitRefResponse>(
      "GET",
      `${repoPath(parsedRepo)}/git/ref/heads/${gitRefBranchPath(normalizedBranch)}`,
    )
  } catch (err) {
    if (err instanceof AgentError && err.code === "NOT_FOUND") {
      throw new CommitFilesError(
        `Branch ${normalizedBranch} was not found in ${repo}`,
        "branch-not-found",
        { cause: err },
      )
    }
    throw new CommitFilesError("Failed to read branch ref", "api-error", { cause: err })
  }

  const parentSha = ref.object?.sha
  if (!parentSha) {
    throw new CommitFilesError("Branch ref did not include a commit sha", "api-error")
  }

  const committedCandidates: CommitFileEntry[] = []
  const preserved: string[] = []
  for (const file of normalizedFiles) {
    const exists = await commitFileExists(parsedRepo, file.path, normalizedBranch)
    if (exists && mode === "add-missing-only") {
      preserved.push(file.path)
    } else {
      committedCandidates.push(file)
    }
  }

  if (committedCandidates.length === 0) {
    return { committed: [], preserved }
  }

  try {
    const parentCommit = await ghRest<CommitGitCommitResponse>(
      "GET",
      `${repoPath(parsedRepo)}/git/commits/${segment(parentSha)}`,
    )
    const baseTree = parentCommit.tree?.sha
    if (!baseTree) {
      throw new CommitFilesError("Parent commit did not include a tree sha", "api-error")
    }

    const tree: CommitTreeEntry[] = []
    for (const file of committedCandidates) {
      const blob = await ghRest<CommitGitBlobResponse>("POST", `${repoPath(parsedRepo)}/git/blobs`, {
        body: {
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        },
      })
      const blobSha = blob.sha
      if (!blobSha) {
        throw new CommitFilesError(`Blob response for ${file.path} did not include a sha`, "api-error")
      }
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blobSha })
    }

    const nextTree = await ghRest<CommitGitTreeResponse>("POST", `${repoPath(parsedRepo)}/git/trees`, {
      body: { base_tree: baseTree, tree },
    })
    const nextTreeSha = nextTree.sha
    if (!nextTreeSha) {
      throw new CommitFilesError("Tree response did not include a sha", "api-error")
    }

    const nextCommit = await ghRest<CommitGitCreateCommitResponse>(
      "POST",
      `${repoPath(parsedRepo)}/git/commits`,
      { body: { message, tree: nextTreeSha, parents: [parentSha] } },
    )
    const nextCommitSha = nextCommit.sha
    if (!nextCommitSha) {
      throw new CommitFilesError("Commit response did not include a sha", "api-error")
    }

    await ghRest<unknown>("PATCH", `${repoPath(parsedRepo)}/git/refs/heads/${gitRefBranchPath(normalizedBranch)}`, {
      body: { sha: nextCommitSha },
    })

    return {
      committed: committedCandidates.map((file) => file.path),
      preserved,
    }
  } catch (err) {
    if (err instanceof CommitFilesError) throw err
    throw new CommitFilesError("Failed to commit files", "api-error", { cause: err })
  }
}

async function commitFileExists(repo: RepoRef, path: string, branch: string): Promise<boolean> {
  try {
    await ghRest<unknown>(
      "GET",
      `${repoPath(repo)}/contents/${repoContentPath(path)}?ref=${segment(branch)}`,
    )
    return true
  } catch (err) {
    if (err instanceof AgentError && err.code === "NOT_FOUND") return false
    throw new CommitFilesError(`Failed to check whether ${path} exists`, "api-error", { cause: err })
  }
}

function parseCommitRepoSlug(value: string): RepoRef {
  const trimmed = value.trim()
  const parts = trimmed.split("/")
  if (
    parts.length !== 2
    || parts[0] === undefined
    || parts[1] === undefined
    || parts[0].trim() === ""
    || parts[1].trim() === ""
  ) {
    throw new CommitFilesError(
      `repo must be an owner/repo string; got ${JSON.stringify(value)}`,
      "api-error",
    )
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() }
}

function normalizeCommitBranch(value: string): string {
  const trimmed = value.trim()
  const withoutRefsPrefix = trimmed.startsWith("refs/heads/")
    ? trimmed.slice("refs/heads/".length)
    : trimmed.startsWith("heads/")
      ? trimmed.slice("heads/".length)
      : trimmed
  if (withoutRefsPrefix === "" || withoutRefsPrefix.includes("\\")) {
    throw new CommitFilesError(
      `branch must be a non-empty branch name; got ${JSON.stringify(value)}`,
      "api-error",
    )
  }
  return withoutRefsPrefix
}

function normalizeCommitFilePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new CommitFilesError(
      `file path must be a relative POSIX repository path; got ${JSON.stringify(value)}`,
      "api-error",
    )
  }
  const drivePrefix = /^[A-Za-z]:\//.test(trimmed)
  const parts = trimmed.split("/")
  if (
    drivePrefix
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CommitFilesError(
      `file path must be a safe relative repository path; got ${JSON.stringify(value)}`,
      "api-error",
    )
  }
  return parts.join("/")
}

function repoContentPath(path: string): string {
  return path.split("/").map(segment).join("/")
}

function gitRefBranchPath(branch: string): string {
  return branch.split("/").map(segment).join("/")
}

export function __resetAgentServiceCachesForTests(): void {
  rosterCache.clear()
  repoNodeCache.clear()
  workflowCache.clear()
}
