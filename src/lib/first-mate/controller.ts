import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import {
  assignAgent as realAssignAgent,
  COPILOT_REVIEWER_LOGIN,
  createIssue as realCreateIssue,
  findAgentPRs as realFindAgentPRs,
  getPullRequestState as realGetPullRequestState,
  markReadyForReview as realMarkReadyForReview,
  mergePullRequest as realMergePullRequest,
  requestReview as realRequestReview,
  rerunChecks as realRerunChecks,
  resolveAgentActor as realResolveAgentActor,
  resolveAgentRoster as realResolveAgentRoster,
  postComment as realPostComment,
  submitReview as realSubmitReview,
} from "~/lib/agent/service"
import {
  cancelTask as realCancelTask,
  followUpTask as realFollowUpTask,
  startTask as realStartTask,
} from "~/lib/agent/tasks"
import type { RepoRef as AgentRepoRef } from "~/lib/agent/types"
import { PATHS } from "~/lib/paths"
import { recordApproval as realRecordApproval, verifyAndConsumeApproval as realVerifyAndConsumeApproval } from "~/lib/first-mate/approval"
import {
  classifyFixAddressed as realClassifyFixAddressed,
  classifyPlanReady as realClassifyPlanReady,
  classifyQuestionAnswerable as realClassifyQuestionAnswerable,
  classifyStuck as realClassifyStuck,
} from "~/lib/first-mate/classifier"
import {
  findByKey as realFindByKey,
  markAnswered as realMarkAnswered,
  upsertDecision as realUpsertDecision,
  type DecisionRecord,
} from "~/lib/first-mate/decisions"
import {
  buildDecisionPacket as realBuildDecisionPacket,
  type DecisionPacketInput,
} from "~/lib/first-mate/decision-packet"
import {
  loadAllUnits as realLoadAllUnits,
  readMissions as realReadMissions,
  type Mission,
} from "~/lib/first-mate/registry"
import {
  pruneTerminal as realPruneTerminal,
  upsertUnit as realUpsertUnit,
} from "~/lib/first-mate/ledger"
import { observeUnit as realObserveUnit } from "~/lib/first-mate/observe"
import {
  classify,
  nextAction,
} from "~/lib/first-mate/state-machine"
import {
  DEFAULT_POLICY,
  type Action,
  type AgentKey,
  type ModelRequestKind,
  type Observed,
  type Policy,
  type ProviderState,
  type RepoRef,
  type UnitRow,
} from "~/lib/first-mate/types"

export interface ControllerDeps {
  loadAllUnits: typeof realLoadAllUnits
  readMissions: typeof realReadMissions
  upsertUnit: typeof realUpsertUnit
  pruneTerminal: typeof realPruneTerminal
  observeUnit: typeof realObserveUnit
  classifyPlanReady: typeof realClassifyPlanReady
  classifyQuestionAnswerable: typeof realClassifyQuestionAnswerable
  classifyFixAddressed: typeof realClassifyFixAddressed
  classifyStuck: typeof realClassifyStuck
  verifyAndConsumeApproval: typeof realVerifyAndConsumeApproval
  recordApproval: typeof realRecordApproval
  upsertDecision: typeof realUpsertDecision
  findByKey: typeof realFindByKey
  markAnswered: typeof realMarkAnswered
  startTask: typeof realStartTask
  followUpTask: typeof realFollowUpTask
  cancelTask: typeof realCancelTask
  createIssue: typeof realCreateIssue
  resolveAgentActor: typeof realResolveAgentActor
  resolveAgentRoster: typeof realResolveAgentRoster
  assignAgent: typeof realAssignAgent
  findAgentPRs: typeof realFindAgentPRs
  getPullRequestState: typeof realGetPullRequestState
  postComment: typeof realPostComment
  submitReview: typeof realSubmitReview
  requestReview: typeof realRequestReview
  rerunChecks: typeof realRerunChecks
  mergePullRequest: typeof realMergePullRequest
  markReadyForReview: typeof realMarkReadyForReview
  buildDecisionPacket: typeof realBuildDecisionPacket
  writeDecisionPacketHtml: (packetId: string, html: string) => Promise<string>
}

export interface AdvanceInput {
  modelAnswers?: ModelAnswer[]
  humanDecisions?: HumanDecision[]
  policy?: Partial<Policy>
  maxInFlightPerProvider?: number
  topK?: number
}

export interface ModelAnswer {
  requestId: string
  // Verdict shape depends on the model request kind.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verdict: any
}

export interface HumanDecision {
  requestId: string
  choice: string
}

export interface ModelRequest {
  requestId: string
  kind: ModelRequestKind
  missionId: string
  repo: RepoRef
  issue: number | null
  pr: number | null
  payload: Record<string, unknown>
}

export interface HumanRequest {
  requestId: string
  decisionId: string
  missionId: string
  repo: RepoRef
  issue: number | null
  pr: number | null
  reason: string
  packetHtmlPath?: string
}

export interface BoardRow {
  missionId: string
  title: string
  repos: string[]
  counts: Record<string, number>
  blocked: number
}

export interface AdvanceResult {
  board: BoardRow[]
  needsModel: ModelRequest[]
  needsHuman: HumanRequest[]
  applied: string[]
  nextWakeAt: number | null
  /**
   * Ready-to-use self-wake delay in seconds, clamped to the scheduler's
   * [60, 3600] range, or `null` when the portfolio is idle (no active units).
   * The skill feeds this straight to the scheduler and uses `null` as the
   * signal to DISARM the heartbeat — no client-side arithmetic.
   */
  nextWakeSeconds: number | null
}

interface Evidence {
  planExcerpt?: string
  logExcerpt?: string
  question?: string
  suggestedAnswer?: string
  failureSummary?: string
  latestLogExcerpt?: string
  runId?: number
  prNodeId?: string
}

interface QueuedRequest<T> {
  request: T
  sortKey: number
  order: number
}

const MODEL_KINDS: ModelRequestKind[] = [
  "review_plan",
  "answer_agent_question",
  "author_fix",
  "judge_review",
]

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

const DEFAULT_MAX_IN_FLIGHT_PER_PROVIDER = 6
const DEFAULT_TOP_K = 6

export const defaultDeps: ControllerDeps = {
  loadAllUnits: realLoadAllUnits,
  readMissions: realReadMissions,
  upsertUnit: realUpsertUnit,
  pruneTerminal: realPruneTerminal,
  observeUnit: realObserveUnit,
  classifyPlanReady: realClassifyPlanReady,
  classifyQuestionAnswerable: realClassifyQuestionAnswerable,
  classifyFixAddressed: realClassifyFixAddressed,
  classifyStuck: realClassifyStuck,
  verifyAndConsumeApproval: realVerifyAndConsumeApproval,
  recordApproval: realRecordApproval,
  upsertDecision: realUpsertDecision,
  findByKey: realFindByKey,
  markAnswered: realMarkAnswered,
  startTask: realStartTask,
  followUpTask: realFollowUpTask,
  cancelTask: realCancelTask,
  createIssue: realCreateIssue,
  resolveAgentActor: realResolveAgentActor,
  resolveAgentRoster: realResolveAgentRoster,
  assignAgent: realAssignAgent,
  findAgentPRs: realFindAgentPRs,
  getPullRequestState: realGetPullRequestState,
  postComment: realPostComment,
  submitReview: realSubmitReview,
  requestReview: realRequestReview,
  rerunChecks: realRerunChecks,
  mergePullRequest: realMergePullRequest,
  markReadyForReview: realMarkReadyForReview,
  buildDecisionPacket: realBuildDecisionPacket,
  writeDecisionPacketHtml,
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_")
  return cleaned.length > 0 ? cleaned : "_"
}

async function writeDecisionPacketHtml(
  packetId: string,
  html: string,
): Promise<string> {
  const dir = path.join(PATHS.FIRST_MATE_DIR, "packets")
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${sanitizeSegment(packetId)}.html`)
  await fs.writeFile(target, html, { mode: 0o600 })
  return target
}

function agentRepo(repo: RepoRef): AgentRepoRef {
  return { owner: repo.owner, repo: repo.name }
}

function unitHandle(unit: UnitRow): string {
  return String(unit.issue ?? unit.taskId)
}

function requestIdFor(unit: UnitRow, kind: ModelRequestKind): string {
  return `${unit.missionId}:${unitHandle(unit)}:${kind}`
}

function humanRequestBase(unit: UnitRow, type: string): string {
  return `${unit.missionId}:${unitHandle(unit)}:${type}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Compact single-line error text for the `applied` audit trail. */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, " ").slice(0, 200)
}

function compact(value: string | undefined, max = 1200): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 16)}…[truncated]…`
}

function providerState(value: string, fallback: ProviderState): ProviderState {
  return PROVIDER_STATES.has(value as ProviderState)
    ? (value as ProviderState)
    : fallback
}

function missionMap(missions: Mission[]): Map<string, Mission> {
  return new Map(missions.map((mission) => [mission.id, mission]))
}

function repoLabel(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
}

function sortKey(unit: UnitRow): number {
  return unit.lastCheckedMs ?? unit.lastSteer?.atMs ?? 0
}

function findModelTarget(
  units: UnitRow[],
  requestId: string,
): { unit: UnitRow; kind: ModelRequestKind } | undefined {
  for (const unit of units) {
    for (const kind of MODEL_KINDS) {
      if (requestIdFor(unit, kind) === requestId) return { unit, kind }
    }
  }
  return undefined
}

function mergePolicy(input: Partial<Policy> | undefined): Policy {
  return { ...DEFAULT_POLICY, ...(input ?? {}) }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function observedRecord(observed: Observed): Record<string, unknown> {
  return observed as unknown as Record<string, unknown>
}

function initialEvidence(observed: Observed): Evidence {
  const record = observedRecord(observed)
  return {
    planExcerpt: stringValue(record.planExcerpt),
    logExcerpt: stringValue(record.logExcerpt),
    question:
      stringValue(record.question) ??
      stringValue(record.agentQuestion) ??
      stringValue(record.prompt),
    suggestedAnswer: stringValue(record.suggestedAnswer),
    failureSummary:
      stringValue(record.failureSummary) ??
      stringValue(record.ciExcerpt) ??
      stringValue(record.reviewExcerpt),
    latestLogExcerpt: stringValue(record.latestLogExcerpt),
    runId: numberValue(record.runId),
    prNodeId: stringValue(record.prNodeId),
  }
}

async function fillFuzzyFields(
  unit: UnitRow,
  mission: Mission,
  observed: Observed,
  deps: ControllerDeps,
): Promise<Evidence> {
  const evidence = initialEvidence(observed)

  if (
    observed.provider === "completed" &&
    observed.prs.length === 0 &&
    observed.planReady === undefined &&
    evidence.logExcerpt !== undefined
  ) {
    const result = await deps.classifyPlanReady(evidence.logExcerpt)
    if (result !== null) {
      observed.planReady = result.planReady
      // The T0 classifier may extract an empty planExcerpt (its schema allows
      // "or empty"); never let that clobber the real log — leave planExcerpt
      // undefined so the payload falls back to logExcerpt.
      if (result.planExcerpt.length > 0) evidence.planExcerpt = result.planExcerpt
    }
    // Stash the plan (or raw log) durably so an approve can re-dispatch a build
    // task carrying it, even after the model's context is gone.
    unit.planExcerpt = evidence.planExcerpt ?? evidence.logExcerpt
  }

  if (
    observed.provider === "waiting_for_user" &&
    observed.agentQuestionAnswerableFromAC === undefined &&
    evidence.question !== undefined
  ) {
    const result = await deps.classifyQuestionAnswerable(
      evidence.question,
      mission.acceptanceCriteria,
    )
    if (result !== null) {
      observed.agentQuestionAnswerableFromAC = result.answerable
      evidence.suggestedAnswer = result.answer
    }
  }

  if (
    unit.lastSteer !== undefined &&
    observed.steerAcknowledged === undefined &&
    evidence.failureSummary !== undefined &&
    evidence.latestLogExcerpt !== undefined
  ) {
    const result = await deps.classifyFixAddressed(
      evidence.failureSummary,
      evidence.latestLogExcerpt,
    )
    if (result !== null) observed.steerAcknowledged = result.addressed
  }

  if (
    observed.provider === "in_progress" &&
    observed.steerAcknowledged === undefined &&
    evidence.logExcerpt !== undefined
  ) {
    const result = await deps.classifyStuck(evidence.logExcerpt)
    if (result !== null && result.stuck) observed.steerAcknowledged = false
  }

  return evidence
}

function updateUnitFromObservedPrs(unit: UnitRow, observed: Observed): void {
  if (observed.prs.length !== 1) return
  const pr = observed.prs[0]!
  unit.pr = pr.number
  unit.headSha = pr.headSha || unit.headSha
}

function modelPayload(
  kind: ModelRequestKind,
  unit: UnitRow,
  mission: Mission,
  observed: Observed,
  evidence: Evidence,
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    goal: compact(mission.goal, 1000),
    acceptance_criteria: compact(mission.acceptanceCriteria, 1600),
    house_rules: compact(mission.houseRules, 1000),
    unit_title: compact(unit.title, 500),
    repo: repoLabel(unit.repo),
    issue: unit.issue,
    pr: unit.pr,
    phase: unit.phase,
    validation: unit.validation,
    head_sha: unit.headSha,
    base_sha: unit.baseSha,
  }

  if (kind === "review_plan") {
    return {
      ...common,
      // Falsy fallback (not ??) so an empty planExcerpt yields the raw log.
      plan_excerpt: compact(evidence.planExcerpt || evidence.logExcerpt, 1200),
    }
  }

  if (kind === "answer_agent_question") {
    return {
      ...common,
      question: compact(evidence.question, 1000),
      suggested_answer_from_ac: compact(evidence.suggestedAnswer, 1000),
      answerable_from_acceptance_criteria:
        observed.agentQuestionAnswerableFromAC ?? null,
    }
  }

  if (kind === "author_fix") {
    return {
      ...common,
      failure_summary: compact(
        evidence.failureSummary ?? `${unit.validation} on PR #${unit.pr ?? "unknown"}`,
        1400,
      ),
      ci_rollup: observed.ci?.rollup,
      review_decision: observed.reviewDecision,
      floor_verdict: observed.floor,
    }
  }

  return {
    ...common,
    review_summary: compact(evidence.failureSummary, 1400),
    plan_excerpt: compact(unit.planExcerpt, 1000),
    ci_rollup: observed.ci?.rollup,
    floor_verdict: observed.floor,
  }
}

function buildModelRequest(
  unit: UnitRow,
  mission: Mission,
  kind: ModelRequestKind,
  observed: Observed,
  evidence: Evidence,
): ModelRequest {
  return {
    requestId: requestIdFor(unit, kind),
    kind,
    missionId: unit.missionId,
    repo: unit.repo,
    issue: unit.issue,
    pr: unit.pr,
    payload: modelPayload(kind, unit, mission, observed, evidence),
  }
}

function isMergeEscalation(unit: UnitRow, reason: string): boolean {
  return unit.validation === "floor_passed" || reason.toLowerCase().includes("merge")
}

function decisionType(unit: UnitRow, reason: string): string {
  return isMergeEscalation(unit, reason) ? "merge_approval" : "human_decision"
}

function inputFingerprint(
  unit: UnitRow,
  observed: Observed,
  reason: string,
): string {
  const observedHead = observed.prs.length === 1 ? observed.prs[0]?.headSha : undefined
  return [
    `pr=${unit.pr ?? "none"}`,
    `head=${unit.headSha ?? observedHead ?? "none"}`,
    `base=${unit.baseSha ?? "none"}`,
    `validation=${unit.validation}`,
    `artifact=${unit.artifact}`,
    `reason=${reason}`,
  ].join("|")
}

function decisionKeyFor(
  unit: UnitRow,
  observed: Observed,
  reason: string,
): { decisionKey: string; fingerprint: string; type: string } {
  const type = decisionType(unit, reason)
  const fingerprint = inputFingerprint(unit, observed, reason)
  return {
    type,
    fingerprint,
    decisionKey: `${humanRequestBase(unit, type)}:${fingerprint}`,
  }
}

function decisionOptions(type: string): DecisionPacketInput["options"] {
  if (type === "merge_approval") {
    return [
      {
        id: "approve_merge",
        label: "Approve merge",
        consequence:
          "If a matching durable approval is recorded, the next wake may merge the live PR head.",
        recommended: true,
      },
      {
        id: "hold",
        label: "Hold",
        consequence: "The controller will leave the PR open and ask again later.",
      },
      {
        id: "abandon",
        label: "Abandon",
        consequence: "The unit will be marked terminal without merging.",
      },
    ]
  }

  return [
    {
      id: "continue",
      label: "Continue manually",
      consequence: "A human should decide the next implementation step.",
      recommended: true,
    },
    {
      id: "abandon",
      label: "Abandon",
      consequence: "The unit will be marked terminal without merging.",
    },
  ]
}

function packetInput(
  unit: UnitRow,
  mission: Mission,
  observed: Observed,
  reason: string,
  type: string,
): DecisionPacketInput {
  const pr = unit.pr ?? (observed.prs.length === 1 ? observed.prs[0]?.number ?? null : null)
  return {
    type,
    tldr:
      type === "merge_approval"
        ? `Merge approval needed for ${unit.title}`
        : `${mission.goal}: ${reason}`,
    question:
      type === "merge_approval"
        ? `Approve merging ${repoLabel(unit.repo)} PR #${pr ?? "unknown"}?`
        : `How should first mate proceed? ${reason}`,
    options: decisionOptions(type),
    evidence: {
      prSummary: pr === null ? undefined : `${repoLabel(unit.repo)} PR #${pr}`,
      ciExcerpt: observed.ci?.rollup,
      floorVerdict: observed.floor ?? unit.validation,
      links:
        pr === null
          ? undefined
          : [
              {
                label: `PR #${pr}`,
                url: `https://github.com/${unit.repo.owner}/${unit.repo.name}/pull/${pr}`,
              },
            ],
    },
    missionId: unit.missionId,
    repo: unit.repo,
    unit: { issue: unit.issue, pr },
  }
}

function isAbandonChoice(choice: string): boolean {
  const normalized = choice.toLowerCase()
  return normalized.includes("abandon") || normalized.includes("cancel")
}

function isApproveMergeChoice(choice: string): boolean {
  const normalized = choice.toLowerCase()
  return normalized.includes("approve") || normalized === "merge"
}

async function applyModelAnswer(
  answer: ModelAnswer,
  units: UnitRow[],
  missions: Mission[],
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const target = findModelTarget(units, answer.requestId)
  if (target === undefined) {
    consola.debug(`first-mate controller ignored unknown model answer ${answer.requestId}`)
    return
  }

  const { unit, kind } = target
  const verdict = asRecord(answer.verdict) ?? {}
  const repo = agentRepo(unit.repo)

  if (kind === "review_plan") {
    const decision = stringValue(verdict.decision)
    const mission = missions.find((entry) => entry.id === unit.missionId)
    if (decision === "approve") {
      // The plan task is one-shot (can't be steered into building). Re-dispatch
      // a FRESH build task carrying the approved plan (stashed on the unit).
      // Flip to the build phase ONLY on a successful dispatch, so a missing
      // mission or a failed startTask leaves the unit in plan for a clean retry.
      if (mission !== undefined) {
        const task = await dispatchWithOutbox(unit, deps, ({ idempotencyKey, promptTag }) =>
          deps.startTask(repo, {
            prompt: buildPrompt(unit, mission) + promptTag,
            createPullRequest: true,
            idempotencyKey,
          }),
        )
        if (task) {
          unit.taskId = task.taskId
          unit.provider = providerState(task.state, "queued")
          unit.phase = "build"
          unit.dispatchMode = "build"
          unit.implementerLab = unit.agent
          unit.lastSteer = { atMs: Date.now() }
          applied.push(`approved plan → dispatched build for ${unit.missionId}:${unitHandle(unit)}`)
        }
      }
    } else if (decision === "refine") {
      // Re-run planning: a fresh plan task carrying the refinement (the prior
      // plan task is one-shot). Unit stays in the plan phase for another review.
      const instruction =
        stringValue(verdict.instruction) ?? "Refine the plan with more concrete implementation steps."
      if (mission !== undefined) {
        const prompt = `${planPrompt(unit, mission)}\n\nRefine your previous plan per this feedback:\n${instruction}`
        const task = await dispatchWithOutbox(unit, deps, ({ idempotencyKey, promptTag }) =>
          deps.startTask(repo, { prompt: prompt + promptTag, createPullRequest: false, idempotencyKey }),
        )
        if (task) {
          unit.taskId = task.taskId
          unit.provider = providerState(task.state, "queued")
          unit.phase = "plan"
          unit.dispatchMode = "plan"
          unit.planExcerpt = undefined
          unit.lastSteer = { atMs: Date.now() }
          applied.push(`requested plan refinement for ${unit.missionId}:${unitHandle(unit)}`)
        }
      }
    }
  } else if (kind === "author_fix") {
    const instruction =
      stringValue(verdict.instruction) ?? "Fix the reported validation failure and update the PR."
    // Steer through the PR, the agent's two-way channel — the Agent-Tasks task
    // is one-shot (POST /tasks/{id} → 405, no follow-up). A REQUEST_CHANGES
    // review is the agent's cue to push a fix. If there's no PR yet the agent
    // is still working; the retry counter still advances so a stuck unit
    // eventually escalates.
    if (unit.pr !== null) {
      await deps.submitReview(repo, unit.pr, "REQUEST_CHANGES", instruction)
    }
    unit.retries += 1
    unit.phase = "fix"
    unit.lastSteer = { sha: unit.headSha ?? undefined, atMs: Date.now() }
    applied.push(`sent fix instruction for ${unit.missionId}:${unitHandle(unit)}`)
  } else if (kind === "answer_agent_question") {
    const answerText = stringValue(verdict.answer)
    // The agent surfaces questions in its PR thread; answer there via a comment.
    if (answerText !== undefined && unit.pr !== null) {
      await deps.postComment(repo, unit.pr, answerText)
      unit.lastSteer = { sha: unit.headSha ?? undefined, atMs: Date.now() }
      applied.push(`answered agent question for ${unit.missionId}:${unitHandle(unit)}`)
    }
  } else if (kind === "judge_review") {
    // Only a unit the engine actually placed into verification can receive a
    // floor verdict. Without this guard a forged judge_review could fabricate
    // `floor_passed` on any unit and (combined with a merge approval) merge an
    // unverified PR. verifierAssigned is set by the engine's assign_verifier
    // step, never by an answer.
    const inVerify =
      unit.verifierAssigned === true
      && (unit.validation === "review_pending"
        || unit.validation === "ci_passed"
        || unit.validation === "no_ci"
        || unit.validation === "floor_pending")
    if (!inVerify) {
      consola.debug(
        `first-mate: ignoring judge_review for ${unit.missionId}:${unitHandle(unit)} — unit is not in a verification state`,
      )
      return
    }
    const passed = booleanValue(verdict.pass) === true
    unit.validation = passed ? "floor_passed" : "floor_failed"
    // Bind the verdict to the head it was judged against (BOTH pass and fail) so
    // classify preserves it until a new commit — a failed verdict must not
    // revert to floor_pending and re-emit judge_review in a loop; it routes to
    // author_fix, and the agent's fix (a new head) re-triggers verification.
    unit.floorSha = unit.headSha ?? null
    // Post the verdict as a real PR review so the floor decision is visible on
    // the portal (and an APPROVE counts toward any required-review protection).
    // Best-effort: a review-post failure must not lose the recorded verdict.
    if (unit.pr !== null) {
      const reason = stringValue(verdict.reason) ?? (passed ? "Verified: meets acceptance criteria." : "Changes requested by cross-lab verification.")
      try {
        await deps.submitReview(repo, unit.pr, passed ? "APPROVE" : "REQUEST_CHANGES", reason)
      } catch (err) {
        consola.debug(`first-mate: posting judge verdict review failed for ${unit.missionId}:${unitHandle(unit)}:`, err)
      }
    }
    applied.push(`recorded verifier judgment (${passed ? "pass" : "fail"}) for ${unit.missionId}:${unitHandle(unit)}`)
  }

  await deps.upsertUnit(unit.repo, unit)
}

async function applyHumanDecision(
  decision: HumanDecision,
  units: UnitRow[],
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const record = await deps.findByKey(decision.requestId)
  const decisionId =
    record?.decisionId ??
    units.find((unit) => unit.blockingDecisionId === decision.requestId)
      ?.blockingDecisionId

  if (decisionId === undefined || decisionId === null) {
    consola.debug(`first-mate controller ignored unknown human decision ${decision.requestId}`)
    return
  }

  await deps.markAnswered(decisionId, decision.choice, "human")

  for (const unit of units.filter((row) => row.blockingDecisionId === decisionId)) {
    unit.blockingDecisionId = null
    if (isAbandonChoice(decision.choice)) {
      unit.terminal = true
      unit.phase = "done"
      unit.cancelledBy = "external"
    } else if (isApproveMergeChoice(decision.choice) && unit.pr !== null) {
      // SAFETY: an "approve" records a merge approval ONLY for a unit that is
      // genuinely merge-ready right now (floor_passed). Combined with the
      // judge_review guard, this stops a forged approve on an unrelated or
      // unverified decision from producing a merge approval.
      if (unit.validation !== "floor_passed") {
        consola.debug(
          `first-mate: ignoring merge approval for ${unitHandle(unit)} — unit is not floor_passed`,
        )
        await deps.upsertUnit(unit.repo, unit)
        continue
      }
      // Record a durable, single-use approval BOUND TO THE LIVE head/base the
      // engine fetches itself (never model-supplied). The merge gate
      // (maybeMergeWithApproval) re-validates + consumes it, this same wake.
      //
      // v1 guarantee (open item #2): the human's Approve is relayed by the
      // model. The approval can ONLY exist for a floor_passed unit whose LIVE
      // head still equals the head the floor verdict was recorded against
      // (`floorSha`) — a moved head is refused and re-verifies. It is
      // engine-bound to the live head/base, single-use, and re-validated at
      // consume. So a relay can at most merge the CURRENT verified-green PR,
      // never arbitrary/unapproved content. A server-side ai-or-die panel read
      // is the hardening follow-up for a fully model-unforgeable path.
      try {
        const live = await deps.getPullRequestState(agentRepo(unit.repo), unit.pr)
        const staleHead =
          unit.floorSha != null
          && unit.floorSha.length > 0
          && live.headSha !== unit.floorSha
        if (staleHead) {
          consola.warn(
            `first-mate: refusing merge approval for ${repoLabel(unit.repo)}#${live.number} — head moved since the floor verdict; re-verification required`,
          )
        } else if (live.headSha.length > 0) {
          await deps.recordApproval({
            decisionId,
            repo: unit.repo,
            pr: live.number,
            headSha: live.headSha,
            baseSha: live.baseSha,
          })
          applied.push(
            `recorded merge approval for ${repoLabel(unit.repo)}#${live.number}`,
          )
        }
      } catch (err) {
        consola.debug("first-mate: could not record merge approval", err)
      }
    }
    await deps.upsertUnit(unit.repo, unit)
  }

  applied.push(`recorded human decision ${decision.choice}`)
}

async function applySubmittedAnswers(
  input: AdvanceInput,
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const units = await deps.loadAllUnits()
  const missions = await deps.readMissions()
  for (const answer of input.modelAnswers ?? []) {
    // Isolate each answer: a single failing steer/dispatch must not abort the
    // whole sweep. Record the failure in the audit trail and continue.
    try {
      if (answer.requestId.startsWith("decompose:")) {
        await applyDecomposeAnswer(answer, missions, deps, applied)
      } else {
        await applyModelAnswer(answer, units, missions, deps, applied)
      }
    } catch (err) {
      consola.warn(`first-mate: model answer ${answer.requestId} failed to apply:`, err)
      applied.push(`error applying answer ${answer.requestId}: ${errText(err)}`)
    }
  }
  for (const decision of input.humanDecisions ?? []) {
    try {
      await applyHumanDecision(decision, units, deps, applied)
    } catch (err) {
      consola.warn(`first-mate: human decision ${decision.requestId} failed to apply:`, err)
      applied.push(`error applying decision ${decision.requestId}: ${errText(err)}`)
    }
  }
}

/** Parse an "owner/name" repo string into a RepoRef. */
function parseRepoRef(value: string | undefined): RepoRef | undefined {
  if (value === undefined) return undefined
  const parts = value.split("/")
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    return undefined
  }
  return { owner: parts[0]!, name: parts[1]! }
}

function asAgentKey(value: string | undefined): AgentKey | undefined {
  return value === "copilot" || value === "anthropic" || value === "openai"
    ? value
    : undefined
}

/**
 * Turn a model `decompose` answer into queued units. This is the mission→units
 * step: `start_mission` only registers the mission; `advance` emits one
 * `decompose` request per unit-less active mission, and the model answers with
 * `{ units: [{ title, repo?, agent?, dependsOn? }] }`. Each unit gets a stable
 * `id` so it survives the queued→dispatched transition without duplicating.
 */
async function applyDecomposeAnswer(
  answer: ModelAnswer,
  missions: Mission[],
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const missionId = answer.requestId.slice("decompose:".length)
  const mission = missions.find((m) => m.id === missionId)
  if (mission === undefined) return
  const verdict = asRecord(answer.verdict) ?? {}
  const rawUnits = Array.isArray(verdict.units) ? verdict.units : []
  let created = 0
  for (const raw of rawUnits) {
    const spec = asRecord(raw) ?? {}
    const title = stringValue(spec.title)
    if (title === undefined || title.length === 0) continue
    const repo = parseRepoRef(stringValue(spec.repo)) ?? mission.repos[0]
    if (repo === undefined) continue
    const dependsOn = Array.isArray(spec.dependsOn)
      ? spec.dependsOn.filter((n): n is number => typeof n === "number")
      : []
    const unit: UnitRow = {
      id: randomUUID(),
      missionId,
      repo,
      issue: null,
      pr: null,
      taskId: null,
      agent: asAgentKey(stringValue(spec.agent)) ?? "copilot",
      botLogin: "",
      dispatchMode: "plan",
      provider: "none",
      phase: "plan",
      artifact: "no_pr",
      validation: "unknown",
      retries: 0,
      dependsOn,
      title,
    }
    await deps.upsertUnit(repo, unit)
    created += 1
  }
  if (created > 0) applied.push(`decomposed ${missionId} into ${created} unit(s)`)
}

async function maybeMergeWithApproval(
  unit: UnitRow,
  observed: Observed,
  evidence: Evidence,
  deps: ControllerDeps,
  applied: string[],
): Promise<boolean> {
  if (unit.validation !== "floor_passed" && observed.floor !== "passed") return false

  const pr = unit.pr ?? (observed.prs.length === 1 ? observed.prs[0]?.number ?? null : null)
  if (pr === null) return false

  const live = await deps.getPullRequestState(agentRepo(unit.repo), pr)
  unit.pr = live.number
  unit.headSha = live.headSha || unit.headSha
  unit.baseSha = live.baseSha ?? unit.baseSha
  unit.branch = live.baseRef || unit.branch

  // SAFETY: the floor verdict must be for the exact head we're about to merge.
  // A moved head means the verified state is stale — refuse and let the unit
  // re-verify against the new head (an approval bound to a different head is
  // also rejected by verifyAndConsumeApproval).
  if (
    unit.floorSha != null
    && unit.floorSha.length > 0
    && live.headSha.length > 0
    && live.headSha !== unit.floorSha
  ) {
    return false
  }

  const head = live.headSha.length > 0 ? live.headSha : unit.headSha ?? undefined
  if (head === undefined || head.length === 0) return false

  const approval = await deps.verifyAndConsumeApproval({
    repo: unit.repo,
    pr: live.number,
    liveHeadSha: head,
    liveBaseSha: live.baseSha,
  })
  if (!approval.ok) return false

  if (live.isDraft && evidence.prNodeId !== undefined) {
    await deps.markReadyForReview(evidence.prNodeId)
  }
  // TODO wire markReadyForReview when getPullRequestState exposes a PR node id.

  await deps.mergePullRequest(agentRepo(unit.repo), {
    pr: live.number,
    expectedHeadSha: head,
  })
  unit.terminal = true
  unit.phase = "done"
  unit.artifact = "pr_merged"
  unit.validation = "floor_passed"
  applied.push(`merged ${repoLabel(unit.repo)}#${live.number}`)
  await deps.upsertUnit(unit.repo, unit)
  return true
}

async function createHumanRequest(
  unit: UnitRow,
  mission: Mission,
  observed: Observed,
  reason: string,
  deps: ControllerDeps,
): Promise<HumanRequest> {
  const { decisionKey, fingerprint, type } = decisionKeyFor(unit, observed, reason)
  const existing = await deps.findByKey(decisionKey)
  let record: DecisionRecord | undefined =
    existing?.status === "pending" ? existing : undefined
  let packetHtmlPath: string | undefined

  if (record === undefined) {
    const packet = deps.buildDecisionPacket(
      packetInput(unit, mission, observed, reason, type),
    )
    packetHtmlPath = await deps.writeDecisionPacketHtml(packet.packetId, packet.html)
    record = {
      decisionId: packet.decisionId,
      decisionKey,
      type,
      status: "pending",
      packetId: packet.packetId,
      inputFingerprint: fingerprint,
      options: decisionOptions(type).map((option) => ({ id: option.id })),
      createdMs: Date.now(),
    }
    await deps.upsertDecision(record)
  }

  unit.blockingDecisionId = record.decisionId
  return {
    requestId: decisionKey,
    decisionId: record.decisionId,
    missionId: unit.missionId,
    repo: unit.repo,
    issue: unit.issue,
    pr: unit.pr,
    reason,
    ...(packetHtmlPath !== undefined ? { packetHtmlPath } : {}),
  }
}

async function assignVerifier(
  unit: UnitRow,
  deps: ControllerDeps,
  applied: string[],
): Promise<boolean> {
  if (unit.pr === null) return false

  // Cross-lab verification that actually happens on the GitHub portal: request
  // a Copilot code review on the PR. It posts a COMMENTED review whose findings
  // the lead then judges (judge_review) — the lead / peer critics are a
  // different lab than the copilot producer, so producer≠checker holds at the
  // decision. (The other cloud agents cannot be requested as reviewers; only
  // Copilot code review is served — see docs/first-mate-design.md.)
  await deps.requestReview(agentRepo(unit.repo), unit.pr, COPILOT_REVIEWER_LOGIN)
  unit.verifierAssigned = true
  unit.verifierSha = unit.headSha ?? undefined
  unit.validation = "floor_pending"
  unit.lastSteer = { atMs: Date.now() }
  applied.push(
    `requested Copilot code review for ${unit.missionId}:${unitHandle(unit)} PR #${unit.pr}`,
  )
  return true
}

async function executeAction(
  action: Action,
  unit: UnitRow,
  mission: Mission,
  observed: Observed,
  evidence: Evidence,
  policy: Policy,
  deps: ControllerDeps,
  needsModel: QueuedRequest<ModelRequest>[],
  needsHuman: QueuedRequest<HumanRequest>[],
  applied: string[],
  order: number,
): Promise<void> {
  void policy
  switch (action.kind) {
    case "dispatch":
      return
    case "steer":
      consola.debug("first-mate controller received direct steer action; v1 skips it")
      return
    case "assign_verifier":
      if (await assignVerifier(unit, deps, applied)) return
      needsHuman.push({
        request: await createHumanRequest(
          unit,
          mission,
          observed,
          "no different-lab verifier is available",
          deps,
        ),
        sortKey: sortKey(unit),
        order,
      })
      return
    case "rerun_ci":
      if (evidence.runId !== undefined) {
        await deps.rerunChecks(agentRepo(unit.repo), {
          runId: evidence.runId,
          failedOnly: true,
        })
        applied.push(`reran checks for ${unit.missionId}:${unitHandle(unit)}`)
      }
      return
    case "cancel":
      if (unit.taskId !== null) await deps.cancelTask(agentRepo(unit.repo), unit.taskId)
      unit.terminal = true
      unit.phase = "done"
      unit.cancelledBy = "controller"
      applied.push(`cancelled ${unit.missionId}:${unitHandle(unit)}`)
      return
    case "mark_done":
      unit.terminal = true
      unit.phase = "done"
      applied.push(`marked done ${unit.missionId}:${unitHandle(unit)}`)
      return
    case "ask_model":
      needsModel.push({
        request: buildModelRequest(unit, mission, action.request, observed, evidence),
        sortKey: sortKey(unit),
        order,
      })
      return
    case "escalate_human":
      needsHuman.push({
        request: await createHumanRequest(
          unit,
          mission,
          observed,
          action.reason,
          deps,
        ),
        sortKey: sortKey(unit),
        order,
      })
      return
    case "merge":
    case "mark_rebase":
    case "noop":
      return
  }
}

function isUndispatched(unit: UnitRow): boolean {
  // A unit with a pending dispatch-intent is NOT undispatched: a task may have
  // been created but the taskId not yet persisted (crash window). Re-dispatching
  // it would duplicate. Recovery, not the dispatch wave, resolves a pending intent.
  return unit.provider === "none" && unit.taskId === null && unit.dispatch === undefined
}

/** A dispatch that was interrupted mid-flight (intent persisted, no taskId yet). */
function isDispatchInterrupted(unit: UnitRow): boolean {
  return unit.dispatch !== undefined && unit.taskId === null
}

function isActiveMissionUnit(unit: UnitRow, missions: Map<string, Mission>): boolean {
  return missions.get(unit.missionId)?.status === "active"
}

function isActiveUnit(unit: UnitRow, missions: Map<string, Mission>): boolean {
  return isActiveMissionUnit(unit, missions) && unit.terminal !== true
}

function isInFlight(unit: UnitRow): boolean {
  return (
    unit.terminal !== true &&
    unit.taskId !== null &&
    (unit.provider === "queued" ||
      unit.provider === "in_progress" ||
      unit.provider === "waiting_for_user")
  )
}

function depsSatisfied(unit: UnitRow, units: UnitRow[]): boolean {
  return unit.dependsOn.every((issue) =>
    units.some(
      (candidate) =>
        candidate.missionId === unit.missionId &&
        candidate.issue === issue &&
        candidate.terminal === true &&
        candidate.artifact === "pr_merged",
    ),
  )
}

function activeCountsByAgent(units: UnitRow[]): Map<AgentKey, number> {
  const counts = new Map<AgentKey, number>()
  for (const unit of units) {
    if (!isInFlight(unit)) continue
    counts.set(unit.agent, (counts.get(unit.agent) ?? 0) + 1)
  }
  return counts
}

function planPrompt(unit: UnitRow, mission: Mission): string {
  const parts = [
    `Mission goal:\n${mission.goal}`,
    `Acceptance criteria:\n${mission.acceptanceCriteria}`,
    `Work unit:\n${unit.title}`,
    "Analyze the repository and produce a concrete, step-by-step implementation plan for this work unit: the files you will change, the approach, key risks, and how each acceptance criterion will be verified. Do NOT edit code or open a pull request yet — output the plan and stop. It will be reviewed before implementation.",
  ]
  if (mission.houseRules !== undefined) parts.splice(2, 0, `House rules:\n${mission.houseRules}`)
  return parts.join("\n\n")
}

function buildPrompt(unit: UnitRow, mission: Mission): string {
  const parts = [
    `Mission goal:\n${mission.goal}`,
    `Acceptance criteria:\n${mission.acceptanceCriteria}`,
    `Work unit:\n${unit.title}`,
  ]
  if (mission.houseRules !== undefined) parts.push(`House rules:\n${mission.houseRules}`)
  if (unit.planExcerpt !== undefined && unit.planExcerpt.trim().length > 0) {
    parts.push(`Approved plan (implement this):\n${unit.planExcerpt.trim()}`)
  }
  parts.push(
    "Implement this work unit end-to-end on a new branch and open a pull request for review. Follow the approved plan above. Keep the change focused on this unit and do not modify unrelated files. If anything about the acceptance criteria is ambiguous, make a reasonable choice and note it in the PR description.",
  )
  return parts.join("\n\n")
}

/**
 * Durable dispatch outbox. Persists a dispatch-intent (with a correlation id)
 * BEFORE the irreversible startTask, so a crash in the startTask→persist window
 * leaves the unit marked (not `isUndispatched`) and is never blind-re-dispatched.
 * `start` receives the correlation id to embed in the prompt and send as the
 * Idempotency-Key. On success the intent is cleared (in memory; the caller's
 * upsertUnit persists it alongside the taskId). On throw the intent stays
 * pending on disk (unknown outcome — recovery, not re-dispatch, resolves it).
 * Returns null when the API returned no taskId — treated as ambiguous, so the
 * intent is LEFT pending (recovery escalates; never auto-re-dispatch).
 */
async function dispatchWithOutbox(
  unit: UnitRow,
  deps: ControllerDeps,
  start: (c: { idempotencyKey: string; promptTag: string }) => Promise<{ taskId: string; state: string }>,
): Promise<{ taskId: string; state: string } | null> {
  const id = randomUUID()
  unit.dispatch = { id, requestedMs: Date.now(), attempts: (unit.dispatch?.attempts ?? 0) + 1 }
  await deps.upsertUnit(unit.repo, unit) // persist intent BEFORE the side effect (hard stop if this throws)
  const task = await start({ idempotencyKey: id, promptTag: `\n\n<!-- fm-dispatch:${id} -->` })
  // Empty taskId on a 2xx is AMBIGUOUS (a task may have been created but the id
  // not echoed) — leave the intent pending so recovery escalates rather than
  // auto-re-dispatching into a possible duplicate. Only a real id clears it.
  if (task.taskId.length === 0) return null
  unit.dispatch = undefined
  return task
}

async function dispatchUnit(
  unit: UnitRow,
  mission: Mission,
  deps: ControllerDeps,
): Promise<void> {
  const repo = agentRepo(unit.repo)
  const actor = await deps.resolveAgentActor(repo, unit.agent)

  // Plan-first: the initial task produces an implementation plan (readable from
  // its session log via the CAPI client) and stops — no PR yet. On approval,
  // applyModelAnswer re-dispatches a fresh build task carrying the plan.
  // Dispatched through the outbox so a crash never blind-re-dispatches.
  const task = await dispatchWithOutbox(unit, deps, ({ idempotencyKey, promptTag }) =>
    deps.startTask(repo, {
      prompt: planPrompt(unit, mission) + promptTag,
      createPullRequest: false,
      idempotencyKey,
    }),
  )
  // A definitive no-task response clears the intent and leaves the unit
  // undispatched to retry next wake; a startTask THROW leaves the intent pending
  // (handled by recovery). We no longer auto-fall-back to issue-assignment on a
  // throw — that is a second irreversible side effect with an unknown outcome.
  if (task === null) return
  unit.taskId = task.taskId
  unit.provider = providerState(task.state, "queued")
  unit.botLogin = actor.login
  unit.dispatchMode = "plan"
  unit.phase = "plan"
  unit.implementerLab = unit.agent
  unit.lastSteer = { atMs: Date.now() }
}

async function dispatchWave(
  units: UnitRow[],
  missions: Map<string, Mission>,
  maxInFlightPerProvider: number,
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const counts = activeCountsByAgent(units)
  const candidates = units
    .filter((unit) => isActiveUnit(unit, missions))
    // A unit parked on a human decision must never be (re-)dispatched — it is
    // awaiting an answer, not capacity. Guard here in addition to the main
    // loop's skip so the dispatch wave can't resurrect a blocked unit.
    .filter((unit) => !unit.blockingDecisionId)
    .filter(isUndispatched)
    .filter((unit) => depsSatisfied(unit, units))
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => sortKey(a.unit) - sortKey(b.unit) || a.index - b.index)

  for (const { unit } of candidates) {
    const current = counts.get(unit.agent) ?? 0
    if (current >= maxInFlightPerProvider) continue
    const mission = missions.get(unit.missionId)
    if (mission === undefined) continue

    // Isolate each dispatch: a startTask throw (unknown outcome) leaves this
    // unit's intent pending on disk (recovery escalates it next wake) and must
    // not abort the wave for the other eligible units.
    try {
      await dispatchUnit(unit, mission, deps)
      counts.set(unit.agent, current + 1)
      await deps.upsertUnit(unit.repo, unit)
      applied.push(`dispatched ${unit.missionId}:${unitHandle(unit)} to ${unit.agent}`)
    } catch (err) {
      consola.warn(`first-mate: dispatch of ${unit.missionId}:${unitHandle(unit)} failed:`, err)
      applied.push(`error dispatching ${unit.missionId}:${unitHandle(unit)}: ${errText(err)}`)
    }
  }
}

function buildBoard(units: UnitRow[], missions: Mission[]): BoardRow[] {
  const rows: BoardRow[] = []
  for (const mission of missions.filter((entry) => entry.status === "active")) {
    const missionUnits = units.filter((unit) => unit.missionId === mission.id)
    const counts: Record<string, number> = {}
    for (const unit of missionUnits) {
      counts[unit.phase] = (counts[unit.phase] ?? 0) + 1
    }
    rows.push({
      missionId: mission.id,
      title: mission.goal,
      repos: mission.repos.map(repoLabel),
      counts,
      blocked: missionUnits.filter((unit) => unit.blockingDecisionId).length,
    })
  }
  return rows
}

function compareQueued<T>(a: QueuedRequest<T>, b: QueuedRequest<T>): number {
  return a.sortKey - b.sortKey || a.order - b.order
}

function capQueued<T>(entries: QueuedRequest<T>[], topK: number): T[] {
  return entries.sort(compareQueued).slice(0, topK).map((entry) => entry.request)
}

function nextWakeAt(units: UnitRow[], missions: Map<string, Mission>): number | null {  const active = units.filter((unit) => isActiveUnit(unit, missions))
  if (active.length === 0) return null

  const now = Date.now()
  if (
    active.some(
      (unit) => unit.validation === "ci_running" || unit.provider === "in_progress",
    )
  ) {
    return now + 90_000
  }

  if (
    active.every(
      (unit) =>
        Boolean(unit.blockingDecisionId) ||
        unit.provider === "none" ||
        unit.provider === "queued",
    )
  ) {
    return now + 900_000
  }

  return now + 300_000
}

// Scheduler bounds: ScheduleWakeup clamps to [60, 3600]s and cron granularity
// is 60s, so the self-wake delay we hand the skill lives in that range.
const MIN_WAKE_SECONDS = 60
const MAX_WAKE_SECONDS = 3600

function wakeSeconds(wakeAt: number | null): number | null {
  if (wakeAt === null) return null
  const seconds = Math.round((wakeAt - Date.now()) / 1000)
  return Math.min(MAX_WAKE_SECONDS, Math.max(MIN_WAKE_SECONDS, seconds))
}

async function pruneTerminalRepos(
  units: UnitRow[],
  deps: ControllerDeps,
): Promise<void> {
  const repos = new Map<string, RepoRef>()
  for (const unit of units) {
    if (unit.terminal !== true) continue
    repos.set(repoLabel(unit.repo), unit.repo)
  }
  for (const repo of repos.values()) {
    await deps.pruneTerminal(repo)
  }
}

/**
 * Single-pass deterministic controller wake. Real deployments should wrap this
 * in a per-repo lock before durable ledger writes; the engine itself is kept
 * dependency-injected so tests can run without network or filesystem effects.
 */
export async function advance(
  input: AdvanceInput = {},
  deps: ControllerDeps = defaultDeps,
): Promise<AdvanceResult> {
  const applied: string[] = []
  const needsModel: QueuedRequest<ModelRequest>[] = []
  const needsHuman: QueuedRequest<HumanRequest>[] = []
  const policy = mergePolicy(input.policy)
  const maxInFlightPerProvider = positiveInteger(
    input.maxInFlightPerProvider,
    DEFAULT_MAX_IN_FLIGHT_PER_PROVIDER,
  )
  const topK = positiveInteger(input.topK, DEFAULT_TOP_K)

  await applySubmittedAnswers(input, deps, applied)

  const units = await deps.loadAllUnits()
  const missions = await deps.readMissions()
  const missionsById = missionMap(missions)
  let order = 0

  for (const unit of units.filter((row) => isActiveUnit(row, missionsById))) {
    const requestOrder = order
    order += 1

    if (unit.blockingDecisionId) continue
    if (isUndispatched(unit)) continue

    const mission = missionsById.get(unit.missionId)
    if (mission === undefined) continue

    // Isolate each unit: a transient observe/classify/dispatch/steer failure on
    // one unit must not abort the global sweep across every other mission.
    try {
      // Recovery: a dispatch-intent that persisted but never recorded a taskId
      // means a prior wake crashed mid-dispatch. NEVER blind-re-dispatch (would
      // duplicate); surface it to a human with the correlation id so any orphan
      // task can be verified before re-dispatch.
      if (isDispatchInterrupted(unit)) {
        needsHuman.push({
          request: await createHumanRequest(
            unit,
            mission,
            { provider: unit.provider, prs: [] },
            `dispatch interrupted before the task id was recorded (correlation ${unit.dispatch?.id ?? "?"}) — verify no orphan task on ${repoLabel(unit.repo)} before re-dispatch`,
            deps,
          ),
          sortKey: sortKey(unit),
          order: requestOrder,
        })
        await deps.upsertUnit(unit.repo, unit)
        continue
      }

      const observed = await deps.observeUnit(unit)
      const evidence = await fillFuzzyFields(unit, mission, observed, deps)
      updateUnitFromObservedPrs(unit, observed)
      unit.lastCheckedMs = Date.now()

      if (await maybeMergeWithApproval(unit, observed, evidence, deps, applied)) {
        continue
      }

      const classified = classify(observed, unit)
      unit.provider = classified.provider
      unit.phase = classified.phase
      unit.artifact = classified.artifact
      unit.validation = classified.validation

      const action = nextAction(classified, unit, policy)
      await executeAction(
        action,
        unit,
        mission,
        observed,
        evidence,
        policy,
        deps,
        needsModel,
        needsHuman,
        applied,
        requestOrder,
      )
      await deps.upsertUnit(unit.repo, unit)
    } catch (err) {
      consola.warn(
        `first-mate: unit ${unit.missionId}:${unitHandle(unit)} step failed:`,
        err,
      )
      applied.push(`error advancing ${unit.missionId}:${unitHandle(unit)}: ${errText(err)}`)
    }
  }

  // Missions with no units yet need decomposition into dispatchable units.
  // `start_mission` only registers a mission; emit one decompose request per
  // unit-less active mission so the model returns the unit set (created on the
  // next wake by applyDecomposeAnswer).
  for (const mission of missions) {
    if (mission.status !== "active") continue
    if (units.some((unit) => unit.missionId === mission.id)) continue
    const repo = mission.repos[0]
    if (repo === undefined) continue
    needsModel.push({
      request: {
        requestId: `decompose:${mission.id}`,
        kind: "decompose",
        missionId: mission.id,
        repo,
        issue: null,
        pr: null,
        payload: {
          goal: mission.goal,
          acceptance_criteria: mission.acceptanceCriteria,
          repos: mission.repos.map((entry) => `${entry.owner}/${entry.name}`),
          house_rules: mission.houseRules ?? null,
        },
      },
      sortKey: 0,
      order: order++,
    })
  }

  await dispatchWave(
    units,
    missionsById,
    maxInFlightPerProvider,
    deps,
    applied,
  )

  const board = buildBoard(units, missions)
  const wakeAt = nextWakeAt(units, missionsById)
  await pruneTerminalRepos(units, deps)

  return {
    board,
    needsModel: capQueued(needsModel, topK),
    needsHuman: capQueued(needsHuman, topK),
    applied,
    nextWakeAt: wakeAt,
    nextWakeSeconds: wakeSeconds(wakeAt),
  }
}
