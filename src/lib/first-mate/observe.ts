import consola from "consola"

import {
  findAgentPRs,
  getPullRequestState,
  getRequiredChecksForSha,
} from "~/lib/agent/service"
import { getTask } from "~/lib/agent/tasks"
import type {
  AgentPRSummary,
  PullRequestState,
  RepoRef as AgentRepoRef,
  TaskStatusResult,
} from "~/lib/agent/types"
import type { Observed, ProviderState, UnitRow } from "~/lib/first-mate/types"

const PROVIDER_STATES = new Set<ProviderState>([
  "none",
  "queued",
  "in_progress",
  "waiting_for_user",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
])

function agentRepo(unit: UnitRow): AgentRepoRef {
  return { owner: unit.repo.owner, repo: unit.repo.name }
}

function providerState(value: string | undefined, fallback: ProviderState): ProviderState {
  if (value && PROVIDER_STATES.has(value as ProviderState)) {
    return value as ProviderState
  }
  return fallback
}

function normalizePrState(value: string | undefined): string {
  if (!value) return "OPEN"
  const upper = value.toUpperCase()
  if (upper === "OPEN" || upper === "CLOSED" || upper === "MERGED") return upper
  return value
}

function parsePrNumberFromUrl(value: string | undefined): number | null {
  if (!value) return null
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(value)
  if (!match) return null
  const parsed = Number.parseInt(match[1]!, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function taskPrNumber(task: TaskStatusResult | null): number | null {
  if (!task) return null
  if (typeof task.pr === "number" && Number.isInteger(task.pr) && task.pr > 0) {
    return task.pr
  }
  return parsePrNumberFromUrl(task.prUrl)
}

function firstSummaryNumber(prs: AgentPRSummary[]): number | null {
  const summary = prs.find((pr) => Number.isInteger(pr.number) && pr.number > 0)
  return summary?.number ?? null
}

function branchMatchNumber(prs: AgentPRSummary[], branch: string | undefined): number | null {
  if (!branch) return null
  const match = prs.find((pr) => pr.headRef === branch && Number.isInteger(pr.number) && pr.number > 0)
  return match?.number ?? null
}

function primaryPrNumber(
  unit: UnitRow,
  task: TaskStatusResult | null,
  prs: AgentPRSummary[],
): number | null {
  if (unit.pr !== null && unit.pr > 0) return unit.pr
  // Correlate by branch first (unambiguous when several same-bot units each
  // have their own PR); fall back to the task's own PR link, then any bot PR.
  return (
    branchMatchNumber(prs, unit.branch ?? task?.branch ?? undefined) ??
    taskPrNumber(task) ??
    firstSummaryNumber(prs)
  )
}

async function getTaskSafe(
  repo: AgentRepoRef,
  taskId: string | null,
): Promise<TaskStatusResult | null> {
  if (!taskId) return null
  try {
    return await getTask(repo, taskId)
  } catch (err) {
    consola.debug("first-mate observe: task read skipped:", err)
    return null
  }
}

async function findPrsSafe(
  repo: AgentRepoRef,
  unit: UnitRow,
): Promise<AgentPRSummary[]> {
  // findAgentPRs searches by bot AUTHOR (it ignores the issue number), so it
  // works for task-based units too — do NOT gate on unit.issue. Without this,
  // a build task that opens a PR would never be discovered (its task detail
  // carries no pr_url; the branch/PR is only findable by author + head ref).
  try {
    return await findAgentPRs(repo, {
      issueNumber: unit.issue ?? 0,
      botLogin: unit.botLogin,
    })
  } catch (err) {
    consola.debug("first-mate observe: PR discovery skipped:", err)
    return []
  }
}

async function getPullRequestStateSafe(
  repo: AgentRepoRef,
  pr: number | null,
): Promise<PullRequestState | null> {
  if (pr === null) return null
  try {
    return await getPullRequestState(repo, pr)
  } catch (err) {
    consola.debug("first-mate observe: PR state read skipped:", err)
    return null
  }
}

async function getCiSafe(
  repo: AgentRepoRef,
  headSha: string,
): Promise<Observed["ci"] | undefined> {
  if (headSha.length === 0) return undefined
  try {
    const checks = await getRequiredChecksForSha(repo, headSha)
    return { rollup: checks.rollup }
  } catch (err) {
    consola.debug("first-mate observe: required checks read skipped:", err)
    return undefined
  }
}

function observedPrs(
  summaries: AgentPRSummary[],
  primaryState: PullRequestState | null,
): Observed["prs"] {
  const prs = new Map<number, Observed["prs"][number]>()
  for (const summary of summaries) {
    if (!Number.isInteger(summary.number) || summary.number <= 0) continue
    prs.set(summary.number, {
      number: summary.number,
      headSha: summary.headSha,
      isDraft: summary.isDraft,
      state: "OPEN",
    })
  }

  if (primaryState) {
    const summary = prs.get(primaryState.number)
    const state = normalizePrState(primaryState.state)
    prs.set(primaryState.number, {
      number: primaryState.number,
      headSha: primaryState.headSha || summary?.headSha || "",
      isDraft: primaryState.isDraft,
      state,
      merged: state === "MERGED",
    })
  }

  return [...prs.values()]
}

function externalMutation(
  unit: UnitRow,
  primaryState: PullRequestState | null,
): Observed["externalMutation"] | undefined {
  if (!primaryState || unit.terminal || unit.cancelledBy === "controller") {
    return undefined
  }

  const state = normalizePrState(primaryState.state)
  if (state === "MERGED") return "merged"
  if (state === "CLOSED") return "closed"
  return undefined
}

export async function observeUnit(unit: UnitRow): Promise<Observed> {
  const repo = agentRepo(unit)
  const task = await getTaskSafe(repo, unit.taskId)
  // Remember the agent's branch (parsed from the session log) so later observes
  // can correlate the right PR to this unit even before its PR is linked.
  if (task?.branch && task.branch.length > 0) unit.branch = task.branch
  const provider = providerState(task?.state, unit.provider)
  const prSummaries = await findPrsSafe(repo, unit)
  const primaryNumber = primaryPrNumber(unit, task, prSummaries)
  const primaryState = await getPullRequestStateSafe(repo, primaryNumber)
  const ci = primaryState ? await getCiSafe(repo, primaryState.headSha) : undefined
  const reviewDecision = primaryState ? primaryState.reviewDecision ?? null : undefined

  const mutation = externalMutation(unit, primaryState)

  // The distilled session log carries the agent's plan/reasoning/progress and,
  // when it is blocked, the question it is asking. Feed both to the engine so
  // the plan-ready / stuck / question micro-classifiers have real evidence.
  const logExcerpt = task?.logExcerpt && task.logExcerpt.length > 0 ? task.logExcerpt : undefined
  const question = provider === "waiting_for_user" ? logExcerpt : undefined

  return {
    provider,
    prs: observedPrs(prSummaries, primaryState),
    ...(ci ? { ci } : {}),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(mutation ? { externalMutation: mutation } : {}),
    ...(logExcerpt ? { logExcerpt } : {}),
    ...(question ? { question } : {}),
  }
}
