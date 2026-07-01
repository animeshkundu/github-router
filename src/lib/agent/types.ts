export const AGENT_ERROR_CODES = [
  "AGENT_NOT_AVAILABLE",
  "NO_WRITE_ACCESS",
  "ASSIGN_FAILED",
  "RATE_LIMITED",
  "AUTH_REVOKED",
  "HEAD_MOVED",
  "GRAPHQL_FEATURE",
  "NOT_FOUND",
  "UPSTREAM",
] as const

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number]

export class AgentError extends Error {
  code: AgentErrorCode
  cause?: unknown

  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "AgentError"
    this.code = code
    this.cause = options?.cause
  }
}

export interface RepoRef {
  owner: string
  repo: string
}

export type AgentKey = "copilot" | "anthropic" | "openai"

export interface AgentActor {
  login: string
  botId: string
}

export interface RepoNodeRef {
  repositoryId: string
  defaultBranch?: string
}

export interface IssueRef {
  number: number
  nodeId: string
  url: string
}

export interface IssueCreateInput {
  title: string
  body: string
}

export interface AssignmentInput {
  issueNodeId: string
  issueNumber: number
  botId: string
  botLogin: string
}

export interface AssignmentResult {
  assigned: true
  via: "graphql" | "rest"
}

export interface UnassignmentResult {
  unassigned: true
}

export interface AgentPRSummary {
  number: number
  headSha: string
  headRef: string
  isDraft: boolean
}

export interface PullRequestState {
  number: number
  title: string
  isDraft: boolean
  state: string
  mergeable?: string | null
  reviewDecision?: string | null
  headSha: string
  baseRef: string
  baseSha?: string
  authorLogin?: string
}

export interface CheckSummary {
  id: number
  name: string
  conclusion?: string | null
}

export interface FailingCheckSummary {
  name: string
  url?: string
}

export interface RequiredChecksSummary {
  rollup: "pending" | "passing" | "failing" | "none"
  checks: CheckSummary[]
  failing: FailingCheckSummary[]
  runningCount: number
}

export interface PullRequestFileSummary {
  path: string
  additions: number
  deletions: number
  status: string
}

export interface PullRequestDiffSummary {
  files: PullRequestFileSummary[]
  totalAdditions: number
  totalDeletions: number
  fileCount: number
  truncated: boolean
}

export interface CommentResult {
  url: string
}

export interface ReviewResult {
  reviewId: number
  state: string
}

export interface WorkflowDispatchResult {
  dispatched: true
}

export interface RerunChecksResult {
  rerun: true
}

export interface WorkflowJobSummary {
  name: string
  status?: string | null
  conclusion?: string | null
}

export interface WorkflowRunSummary {
  status?: string | null
  conclusion?: string | null
  jobs: WorkflowJobSummary[]
}

export interface MergeResult {
  merged: true
  sha: string
}

export interface ReadyForReviewResult {
  ready: true
}

export interface StartTaskInput {
  prompt: string
  baseRef?: string
  model?: string
  createPullRequest?: boolean
}

export interface TaskStartResult {
  taskId: string
  state: string
}

export interface TaskStatusResult {
  taskId: string
  state: string
  prUrl?: string
  pr?: number | null
  logExcerpt: string
  /** Copilot-host session id (from the task detail) that fed `logExcerpt`. */
  sessionId?: string
  /** The branch the agent checked out, parsed from the session log. */
  branch?: string
}

export interface TaskFollowUpResult {
  ok: true
}

export interface TaskCancelResult {
  cancelled: true
}
