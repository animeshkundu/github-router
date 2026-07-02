import { withDecisionsMutation } from "~/lib/first-mate/decisions"
import type { RepoRef } from "~/lib/first-mate/types"

export interface ApprovalRecord {
  decisionId: string
  repo: RepoRef
  pr: number
  headSha: string
  baseSha?: string
  diffDigest?: string
  requiredCheckIds?: string[]
  floorRunId?: string
  status: "approved"
  consumed: boolean
  createdMs: number
  consumedMs?: number
}

function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  )
}

function approvedRecord(
  a: Omit<ApprovalRecord, "status" | "consumed" | "createdMs">,
): ApprovalRecord {
  const approval: ApprovalRecord = {
    decisionId: a.decisionId,
    repo: a.repo,
    pr: a.pr,
    headSha: a.headSha,
    status: "approved",
    consumed: false,
    createdMs: Date.now(),
  }

  if (a.baseSha !== undefined) approval.baseSha = a.baseSha
  if (a.diffDigest !== undefined) approval.diffDigest = a.diffDigest
  if (a.requiredCheckIds !== undefined) {
    approval.requiredCheckIds = [...a.requiredCheckIds]
  }
  if (a.floorRunId !== undefined) approval.floorRunId = a.floorRunId

  return approval
}

/**
 * Record a human merge/irreversible approval in the durable decisions ledger.
 *
 * This function belongs only on the human-approval path: the model is never
 * given a tool that can call it, so an approval is a durable controller fact
 * rather than agent-authored text the model could forge.
 */
export async function recordApproval(
  a: Omit<ApprovalRecord, "status" | "consumed" | "createdMs">,
): Promise<void> {
  await withDecisionsMutation((decisions) => {
    const decision = decisions.find((entry) => entry.decisionId === a.decisionId)
    if (!decision) {
      throw new Error(`Cannot record approval for unknown decision ${a.decisionId}`)
    }

    decision.approval = approvedRecord(a)
  })
}

export async function verifyAndConsumeApproval(args: {
  repo: RepoRef
  pr: number
  liveHeadSha: string
  liveBaseSha?: string
}): Promise<{ ok: boolean; reason?: string }> {
  return withDecisionsMutation((decisions) => {
    const approvals = decisions
      .map((decision) => decision.approval)
      .filter(
        (entry): entry is ApprovalRecord =>
          entry !== undefined &&
          sameRepo(entry.repo, args.repo) &&
          entry.pr === args.pr,
      )

    if (approvals.length === 0) return { ok: false, reason: "no_approval" }

    const approval = approvals
      .filter((entry) => !entry.consumed)
      .sort((a, b) => b.createdMs - a.createdMs)[0]

    if (approval === undefined) return { ok: false, reason: "replayed" }
    if (approval.headSha !== args.liveHeadSha) {
      return { ok: false, reason: "head_moved" }
    }
    if (
      approval.baseSha !== undefined &&
      approval.baseSha !== args.liveBaseSha
    ) {
      return { ok: false, reason: "base_moved" }
    }

    approval.consumed = true
    approval.consumedMs = Date.now()
    return { ok: true }
  })
}
