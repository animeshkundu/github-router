import { getSessionLog } from "./capi"
import { ghRest } from "./rest"
import type {
  RepoRef,
  StartTaskInput,
  TaskCancelResult,
  TaskFollowUpResult,
  TaskStartResult,
  TaskStatusResult,
} from "./types"

export const AGENT_TASKS_API_VERSION = "2026-03-10"

const LOG_EXCERPT_LIMIT = 4000
const TRUNCATED_MARKER = "…[truncated]…"
const FOLLOW_UP_TASK_PATH_SUFFIX = "" // TODO verify preview endpoint shape.
const CANCEL_TASK_PATH_SUFFIX = "/cancel" // TODO verify preview endpoint shape.

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}

function repoTasksPath(repo: RepoRef): string {
  return `/agents/repos/${segment(repo.owner)}/${segment(repo.repo)}/tasks`
}

function taskPath(repo: RepoRef, taskId: string): string {
  return `${repoTasksPath(repo)}/${segment(taskId)}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function numberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function collectText(record: Record<string, unknown> | undefined): string[] {
  if (!record) return []

  const nested = [
    asRecord(record.task),
    asRecord(record.session),
    asRecord(record.progress),
    asRecord(record.result),
  ]
  const textKeys = [
    "session_log",
    "sessionLog",
    "log",
    "logs",
    "progress",
    "plan",
    "summary",
    "status_text",
    "statusText",
    "message",
  ]

  const chunks: string[] = []
  for (const candidate of [record, ...nested]) {
    for (const key of textKeys) {
      const value = candidate?.[key]
      if (typeof value === "string" && value.trim().length > 0) {
        chunks.push(value)
      }
    }
  }
  return chunks
}

function compactKnownKeysSummary(record: Record<string, unknown> | undefined): string {
  if (!record) return "preview task response was not an object"
  const keys = Object.keys(record).slice(0, 30)
  return `preview task response keys: ${JSON.stringify(keys)}`
}

function tailExcerpt(text: string): string {
  if (text.length <= LOG_EXCERPT_LIMIT) return text
  return `${TRUNCATED_MARKER}${text.slice(-(LOG_EXCERPT_LIMIT - TRUNCATED_MARKER.length))}`
}

function taskPrUrl(record: Record<string, unknown> | undefined): string | undefined {
  const direct = stringField(record, ["pr_url", "prUrl", "pull_request_url", "pullRequestUrl"])
  if (direct) return direct

  const pullRequest = asRecord(record?.pull_request) ?? asRecord(record?.pullRequest)
  return stringField(pullRequest, ["html_url", "url"])
}

function taskPrNumber(record: Record<string, unknown> | undefined): number | null | undefined {
  const direct = numberField(record, ["pr", "pr_number", "prNumber", "pull_request_number"])
  if (direct !== undefined) return direct

  const pullRequest = asRecord(record?.pull_request) ?? asRecord(record?.pullRequest)
  const nested = numberField(pullRequest, ["number"])
  return nested ?? undefined
}

function latestSessionId(record: Record<string, unknown> | undefined): string | undefined {
  const sessions = record?.sessions
  if (!Array.isArray(sessions) || sessions.length === 0) return undefined
  // The most recent session (last in the array) drives the live plan/progress.
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const id = stringField(asRecord(sessions[i]), ["id", "session_id", "sessionId"])
    if (id) return id
  }
  return undefined
}

export async function startTask(
  repo: RepoRef,
  input: StartTaskInput,
): Promise<TaskStartResult> {
  const body: Record<string, unknown> = { prompt: input.prompt }
  if (input.baseRef !== undefined) body.base_ref = input.baseRef
  if (input.model !== undefined) body.model = input.model
  if (input.createPullRequest !== undefined) {
    body.create_pull_request = input.createPullRequest
  }

  const response = await ghRest<Record<string, unknown>>("POST", repoTasksPath(repo), {
    apiVersion: AGENT_TASKS_API_VERSION,
    body,
  })
  const taskId = stringField(response, ["task_id", "taskId", "id"]) ?? ""
  const state = stringField(response, ["state", "status"]) ?? "unknown"
  return { taskId, state }
}

export async function getTask(repo: RepoRef, taskId: string): Promise<TaskStatusResult> {
  const response = await ghRest<Record<string, unknown>>("GET", taskPath(repo, taskId), {
    apiVersion: AGENT_TASKS_API_VERSION,
  })
  const record = asRecord(response)

  // The real plan/progress lives in the Copilot-host session log, keyed by the
  // task detail's session id. Best-effort: on any CAPI miss we fall back to
  // whatever text the api.github.com task response carried.
  const sessionId = latestSessionId(record)
  const sessionLog = sessionId ? await getSessionLog(sessionId) : null

  const fallbackText = collectText(record).join("\n\n")
  const logExcerpt =
    sessionLog?.excerpt && sessionLog.excerpt.length > 0
      ? sessionLog.excerpt
      : tailExcerpt(fallbackText.length > 0 ? fallbackText : compactKnownKeysSummary(record))

  return {
    taskId: stringField(record, ["task_id", "taskId", "id"]) ?? taskId,
    state: stringField(record, ["state", "status"]) ?? "unknown",
    prUrl: taskPrUrl(record),
    pr: taskPrNumber(record),
    logExcerpt,
    ...(sessionId ? { sessionId } : {}),
  }
}

export async function followUpTask(
  repo: RepoRef,
  taskId: string,
  prompt: string,
): Promise<TaskFollowUpResult> {
  await ghRest<unknown>("POST", `${taskPath(repo, taskId)}${FOLLOW_UP_TASK_PATH_SUFFIX}`, {
    apiVersion: AGENT_TASKS_API_VERSION,
    body: { prompt },
  })
  return { ok: true }
}

export async function cancelTask(
  repo: RepoRef,
  taskId: string,
): Promise<TaskCancelResult> {
  await ghRest<unknown>("POST", `${taskPath(repo, taskId)}${CANCEL_TASK_PATH_SUFFIX}`, {
    apiVersion: AGENT_TASKS_API_VERSION,
  })
  return { cancelled: true }
}
