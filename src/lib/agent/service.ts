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
  const match = /^\s*unit-id:\s*([^\s<]+)/im.exec(body)
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
): Promise<ReadyForReviewResult> {  await ghGraphQL<unknown>(
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
