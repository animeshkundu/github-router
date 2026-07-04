import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import {
  assignAgent as realAssignAgent,
  COPILOT_REVIEWER_LOGIN,
  createIssue as realCreateIssue,
  dismissPullRequestReview as realDismissPullRequestReview,
  findAgentPRs as realFindAgentPRs,
  getPullRequestReviews as realGetPullRequestReviews,
  getPullRequestState as realGetPullRequestState,
  getSelfLogin as realGetSelfLogin,
  markReadyForReview as realMarkReadyForReview,
  mergePullRequest as realMergePullRequest,
  requestReview as realRequestReview,
  rerunChecks as realRerunChecks,
  resolveAgentActor as realResolveAgentActor,
  resolveAgentRoster as realResolveAgentRoster,
  postComment as realPostComment,
  submitReview as realSubmitReview,
  type ReviewSummary,
} from "~/lib/agent/service"
import {
  cancelTask as realCancelTask,
  followUpTask as realFollowUpTask,
  startTask as realStartTask,
} from "~/lib/agent/tasks"
import type { RepoRef as AgentRepoRef } from "~/lib/agent/types"
import { PATHS } from "~/lib/paths"
import { recordApproval as realRecordApproval, releaseApproval as realReleaseApproval, verifyAndConsumeApproval as realVerifyAndConsumeApproval } from "~/lib/first-mate/approval"
import {
  classifyFixAddressed as realClassifyFixAddressed,
  classifyPlanReady as realClassifyPlanReady,
  classifyQuestionAnswerable as realClassifyQuestionAnswerable,
  classifyStuck as realClassifyStuck,
} from "~/lib/first-mate/classifier"
import {
  findByKey as realFindByKey,
  markAnswered as realMarkAnswered,
  readDecisions as realReadDecisions,
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
  currentFenceToken,
  pruneTerminal as realPruneTerminal,
  runFenced,
  upsertUnit as realUpsertUnit,
} from "~/lib/first-mate/ledger"
import { observeUnit as realObserveUnit } from "~/lib/first-mate/observe"
import { resolveCloudAgentModel } from "~/lib/first-mate/task-model"
import { Outbox } from "~/lib/first-mate/scheduler/outbox"
import { isCurrentFencingToken } from "~/lib/first-mate/scheduler/lease"
import {
  classify,
  nextAction,
} from "~/lib/first-mate/state-machine"
import {
  DEFAULT_POLICY,
  EMPTY_PR_OBSERVATION_CAP,
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
  releaseApproval: typeof realReleaseApproval
  upsertDecision: typeof realUpsertDecision
  findByKey: typeof realFindByKey
  readDecisions: typeof realReadDecisions
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
  getPullRequestReviews: typeof realGetPullRequestReviews
  dismissPullRequestReview: typeof realDismissPullRequestReview
  getSelfLogin: typeof realGetSelfLogin
  postComment: typeof realPostComment
  submitReview: typeof realSubmitReview
  requestReview: typeof realRequestReview
  rerunChecks: typeof realRerunChecks
  mergePullRequest: typeof realMergePullRequest
  markReadyForReview: typeof realMarkReadyForReview
  buildDecisionPacket: typeof realBuildDecisionPacket
  writeDecisionPacketHtml: (packetId: string, html: string) => Promise<string>
  /**
   * Chunk A step 1: durable dispatch outbox. Optional so existing callers/tests
   * are unaffected; the daemon/prod supply a real Outbox. dispatchWithOutbox
   * records the intent before startTask and settles it after the taskId is
   * persisted. RECOVERY of a crash mid-dispatch is the persisted-intent +
   * isDispatchInterrupted escalation (see dispatchWithOutbox), NOT an automatic
   * reconcile re-run — Outbox.reconcile is exercised by tests but is not wired
   * into the live loop, so nothing here silently re-fires startTask.
   */
  dispatchOutbox?: {
    record(a: { key: string; kind: string }): Promise<unknown>
    markDone(key: string): Promise<void>
  }
}

export interface AdvanceInput {
  modelAnswers?: ModelAnswer[]
  humanDecisions?: HumanDecision[]
  policy?: Partial<Policy>
  maxInFlightPerProvider?: number
  topK?: number
  /**
   * Phase 1.3 lease gate. Returns whether THIS caller currently holds the
   * drive lease. When it returns false, advance() observes-and-defers (no
   * drive) but still PERSISTS submitted answers via answerQueue. Omitted →
   * always drives (backward-compatible single-driver).
   */
  driveGate?: () => boolean | Promise<boolean>
  /**
   * Durable answer queue that decouples answer-submission from driving. A
   * deferring (non-holder) call enqueues submitted answers here; the holder
   * drains + applies them. Omitted → answers apply inline (today's behavior).
   */
  answerQueue?: {
    enqueue(a: {
      modelAnswers?: ModelAnswer[]
      humanDecisions?: HumanDecision[]
    }): Promise<number>
    drain(): Promise<{
      modelAnswers: ModelAnswer[]
      humanDecisions: HumanDecision[]
      ack: () => Promise<void>
    }>
  }
  /**
   * Chunk A step 2: when this call defers (non-holder), it surfaces the work the
   * drive-holder has escalated by returning these as needsModel/needsHuman
   * instead of an empty board. Typically reads the EscalationQueue.
   */
  pendingEscalations?: () => Promise<{ needsModel: ModelRequest[]; needsHuman: HumanRequest[] }>
  /**
   * #3 hot-path fencing. When the caller holds a fencing lease it passes the
   * token accessor here; advance() wraps the ENTIRE drive in `runFenced(token)`
   * so every ledger write in the sweep is rejected if the lease was stolen
   * mid-flight. Read AFTER driveGate resolves (the gate renews/acquires the
   * lease, so the token is current). Omitted → unfenced (backward-compatible).
   */
  fenceToken?: () => number | undefined
  /**
   * #3 mid-sweep lease renewal. Called before each external dispatch; renews the
   * held lease and returns whether it is STILL held. A false result means the
   * lease was lost/stolen, so the dispatch wave stops WITHOUT performing the
   * irreversible startTask (fencing protects the ledger write, but not the
   * external side effect — this guards the side effect). Omitted → no mid-sweep
   * renew (single-driver / test callers).
   */
  renewLease?: () => Promise<boolean>
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
  /** Phase 1.3: whether this call actually drove (false when it deferred as a non-lease-holder). */
  drove?: boolean
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
  releaseApproval: realReleaseApproval,
  upsertDecision: realUpsertDecision,
  findByKey: realFindByKey,
  readDecisions: realReadDecisions,
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
  getPullRequestReviews: realGetPullRequestReviews,
  dismissPullRequestReview: realDismissPullRequestReview,
  getSelfLogin: realGetSelfLogin,
  postComment: realPostComment,
  submitReview: realSubmitReview,
  requestReview: realRequestReview,
  rerunChecks: realRerunChecks,
  mergePullRequest: realMergePullRequest,
  markReadyForReview: realMarkReadyForReview,
  buildDecisionPacket: realBuildDecisionPacket,
  writeDecisionPacketHtml,
  dispatchOutbox: new Outbox(),
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

/**
 * A5 provable-ownership sentinel. Every REQUEST_CHANGES review the controller
 * posts embeds this hidden marker so `dismissStaleOwnReviews` can dismiss ONLY
 * first-mate's own stale reviews — never a human's — without relying on author
 * identity (the solo operator's account may BE the router PAT).
 */
const FM_REVIEW_SENTINEL = "first-mate-review:"

function stampReviewSentinel(unit: UnitRow, body: string): string {
  const id = unit.id ?? unitHandle(unit)
  // PREPEND (not append): getPullRequestReviews truncates the body to the first
  // 4000 chars, so a long review body would drop a trailing marker and defeat
  // A5's own-review detection. A leading HTML comment is invisible on GitHub and
  // always survives the excerpt.
  return `<!-- ${FM_REVIEW_SENTINEL}${id} -->\n\n${body}`
}

/** A5 (5e): auto-dismiss defaults ON; any user-set 0/false/off disables it. */
function autoDismissEnabled(): boolean {
  const value = process.env.GH_ROUTER_FM_AUTO_DISMISS?.toLowerCase()
  return value !== "0" && value !== "false" && value !== "off"
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
  if (observed.prs.length === 1) {
    const pr = observed.prs[0]!
    unit.pr = pr.number
    unit.headSha = pr.headSha || unit.headSha
  }
  // A3: adopt the CORRELATED primary PR (set by observe only when it came from
  // unit.pr / branch / task, never the bare author-match fallback) when the unit
  // has no PR bound yet — covers the multi-PR case the length===1 path misses,
  // without ever binding an uncorrelated sibling PR to the unit.
  if (unit.pr === null && observed.primaryPr != null) unit.pr = observed.primaryPr
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
  renewLease?: () => Promise<boolean>,
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
    // #3 (replay guard) — a review_plan answer is only actionable while the unit
    // is still AWAITING its plan review (provider "completed" with a ready plan).
    // Once an approve/refine has re-dispatched a successor task the provider
    // moves to queued/in_progress; a REDELIVERED review_plan answer (e.g. a
    // re-drained inbox entry after a crash-before-ack) must NOT dispatch a second
    // task. Gating on the provider state covers BOTH approve→build and
    // refine→plan, which taskId/dispatchMode alone do not distinguish.
    if (unit.provider !== "completed") {
      consola.debug(
        `first-mate: ignoring stale/duplicate review_plan for ${unit.missionId}:${unitHandle(unit)} — provider is ${unit.provider}, not awaiting a plan review`,
      )
      return
    }
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
            model: resolveCloudAgentModel(unit.model ?? mission.defaultModel),
            createPullRequest: true,
            idempotencyKey,
          }),
          renewLease,
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
          deps.startTask(repo, {
            prompt: prompt + promptTag,
            model: resolveCloudAgentModel(unit.model ?? mission.defaultModel),
            createPullRequest: false,
            idempotencyKey,
          }),
          renewLease,
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
      await assertFenceHeld("fix-instruction review")
      await deps.submitReview(repo, unit.pr, "REQUEST_CHANGES", stampReviewSentinel(unit, instruction))
    }
    unit.retries += 1
    // A2: total author_fix dispatches over the unit's life — the hard bound that
    // the per-failure signature-reset can never zero. Kept UNCONDITIONAL (not
    // gated on pr!==null) so a unit that never opens a PR still escalates at the
    // cap rather than looping forever.
    unit.totalFixes = (unit.totalFixes ?? 0) + 1
    unit.phase = "fix"
    unit.lastSteer = { sha: unit.headSha ?? undefined, atMs: Date.now() }
    applied.push(`sent fix instruction for ${unit.missionId}:${unitHandle(unit)}`)
  } else if (kind === "answer_agent_question") {
    const answerText = stringValue(verdict.answer)
    // The agent surfaces questions in its PR thread; answer there via a comment.
    if (answerText !== undefined && unit.pr !== null) {
      await assertFenceHeld("agent-question comment")
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
      await assertFenceHeld("judge-verdict review")
      try {
        // A5: stamp the sentinel on a REQUEST_CHANGES so the controller can later
        // dismiss its OWN stale verdict once the agent pushes a fix (an APPROVE
        // is never dismissed, so it needs no marker).
        const body = passed ? reason : stampReviewSentinel(unit, reason)
        await deps.submitReview(repo, unit.pr, passed ? "APPROVE" : "REQUEST_CHANGES", body)
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

  // F1 ORDERING: mutate the units (and record any merge approval) FIRST, then
  // markAnswered LAST. The unit writes (upsertUnit) are the fenced/OCC writes
  // that can throw under contention; if one does, this function throws BEFORE
  // markAnswered so the decision stays un-answered and the unit stays blocked —
  // never a durable "answered but still blocked" wedge. The caller re-enqueues
  // the drained answer, and the retry re-applies cleanly. (A blocked unit is
  // skipped by the drive sweep, so re-emission does NOT self-heal a wedge — the
  // ordering + re-enqueue is the actual guarantee.)
  //
  // #4b: the blocking id is cleared only AFTER the branch's durable side effect
  // (approval recording) succeeds — never unconditionally up front — so a
  // getPullRequestState/recordApproval throw leaves the unit blocked + the
  // decision un-answered (the human's Approve is not silently lost).
  for (const unit of units.filter((row) => row.blockingDecisionId === decisionId)) {
    if (isAbandonChoice(decision.choice)) {
      unit.blockingDecisionId = null
      unit.terminal = true
      unit.phase = "done"
      unit.cancelledBy = "external"
      await deps.upsertUnit(unit.repo, unit)
    } else if (isApproveMergeChoice(decision.choice) && unit.pr !== null) {
      // SAFETY: an "approve" records a merge approval ONLY for a unit that is
      // genuinely merge-ready right now (floor_passed). Combined with the
      // judge_review guard, this stops a forged approve on an unrelated or
      // unverified decision from producing a merge approval.
      if (unit.validation !== "floor_passed") {
        consola.debug(
          `first-mate: ignoring merge approval for ${unitHandle(unit)} — unit is not floor_passed`,
        )
        unit.blockingDecisionId = null
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
      //
      // #4b — a getPullRequestState / recordApproval THROW is NOT swallowed: it
      // propagates so the block below is NOT cleared and markAnswered never runs,
      // leaving the decision pending for a clean re-enqueued retry rather than
      // losing the approval. A staleHead is a legitimate REFUSE (not a failure)
      // and still answers, matching v1 re-verification behavior.
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
      unit.blockingDecisionId = null
      await deps.upsertUnit(unit.repo, unit)
    } else {
      unit.blockingDecisionId = null
      await deps.upsertUnit(unit.repo, unit)
    }
  }

  // markAnswered LAST — only durably record "answered" once every affected unit
  // has been durably updated above (see F1 ORDERING).
  await deps.markAnswered(decisionId, decision.choice, "human")

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
        await applyModelAnswer(answer, units, missions, deps, applied, input.renewLease)
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
      // F1: the answer was destructively drained from the inbox. A failed apply
      // (OCC exhaustion / fenced upsertUnit) must NOT drop it — re-enqueue so a
      // later wake retries. markAnswered runs LAST in applyHumanDecision, so a
      // failure here leaves the decision un-answered and the unit still blocked
      // (never "answered but blocked"), and the retry applies cleanly.
      if (input.answerQueue) {
        try {
          await input.answerQueue.enqueue({ humanDecisions: [decision] })
          applied.push(`re-enqueued decision ${decision.requestId} after apply failure`)
        } catch (reErr) {
          consola.error(
            `first-mate: FAILED to re-enqueue decision ${decision.requestId} — answer may be lost:`,
            reErr,
          )
        }
      }
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

  // Collect the valid specs in order first, so a unit's `dependsOn` (0-based
  // decompose-list indices) can be resolved to the created units' stable ids —
  // plan-first units have no issue number to depend on.
  const specs: Array<{ spec: Record<string, unknown>; title: string; repo: RepoRef }> = []
  for (const raw of rawUnits) {
    const spec = asRecord(raw) ?? {}
    const title = stringValue(spec.title)
    if (title === undefined || title.length === 0) continue
    const repo = parseRepoRef(stringValue(spec.repo)) ?? mission.repos[0]
    if (repo === undefined) continue
    specs.push({ spec, title, repo })
  }
  const ids = specs.map(() => randomUUID())

  let created = 0
  for (let i = 0; i < specs.length; i += 1) {
    const { spec, title, repo } = specs[i]!
    const dependsOn = (Array.isArray(spec.dependsOn) ? spec.dependsOn : [])
      .filter(
        (idx): idx is number =>
          typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < ids.length && idx !== i,
      )
      .map((idx) => ids[idx]!)
    const unit: UnitRow = {
      id: ids[i]!,
      missionId,
      repo,
      issue: null,
      pr: null,
      taskId: null,
      agent: asAgentKey(stringValue(spec.agent)) ?? "copilot",
      botLogin: "",
      dispatchMode: "plan",
      // Per-unit model override from the decompose spec, else the mission
      // default. Absent → the controller resolves to DEFAULT_CODEX_MODEL at
      // dispatch (see resolveCloudAgentModel).
      model: stringValue(spec.model) ?? mission.defaultModel,
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

  // #4a reconciliation: if GitHub reports the PR already MERGED, a prior merge
  // attempt succeeded server-side even if the client saw a 5xx/timeout and
  // restored its approval for retry. Treat as SUCCESS — mark the unit terminal
  // WITHOUT calling merge again. This is what makes restore-on-throw (below)
  // safe against a double merge on an ambiguous merge outcome.
  if (live.state === "MERGED") {
    unit.terminal = true
    unit.phase = "done"
    unit.artifact = "pr_merged"
    unit.validation = "floor_passed"
    applied.push(`reconciled already-merged ${repoLabel(unit.repo)}#${live.number}`)
    await deps.upsertUnit(unit.repo, unit)
    return true
  }

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

  // Consume the single-use approval BEFORE the merge: consuming first keeps the
  // no-DOUBLE-MERGE backstop live during the merge window (a concurrent driver
  // finds no unconsumed approval). #4a — if markReadyForReview/mergePullRequest
  // then THROWS, the human's approval must NOT be silently lost: RESTORE it
  // (releaseApproval) so a later wake can retry with the same approval, and
  // re-throw so the unit is NOT marked terminal. An ambiguous 5xx that actually
  // merged is caught by the already-MERGED reconciliation above, so the restored
  // approval is never consumed into a second merge.
  const approval = await deps.verifyAndConsumeApproval({
    repo: unit.repo,
    pr: live.number,
    liveHeadSha: head,
    liveBaseSha: live.baseSha,
  })
  if (!approval.ok) return false

  try {
    if (live.isDraft && evidence.prNodeId !== undefined) {
      await deps.markReadyForReview(evidence.prNodeId)
    }
    await deps.mergePullRequest(agentRepo(unit.repo), {
      pr: live.number,
      expectedHeadSha: head,
    })
  } catch (err) {
    await deps
      .releaseApproval({ repo: unit.repo, pr: live.number, headSha: head })
      .catch((restoreErr) => {
        consola.error(
          `first-mate: FAILED to restore merge approval for ${repoLabel(unit.repo)}#${live.number} after a merge failure — manual re-approval may be needed:`,
          restoreErr,
        )
      })
    throw err
  }
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
  primary?: { isDraft?: boolean; prNodeId?: string },
): Promise<boolean> {
  if (unit.pr === null) return false

  // A4: a Copilot code review requested on a DRAFT PR silently no-ops — mark the
  // PR ready for review first (fence-guarded, best-effort) so the verifier
  // actually runs. Non-draft PRs are unchanged.
  if (primary?.isDraft === true && primary.prNodeId !== undefined) {
    await assertFenceHeld("mark ready before verifier")
    try {
      await deps.markReadyForReview(primary.prNodeId)
      applied.push(
        `marked ${unit.missionId}:${unitHandle(unit)} PR #${unit.pr} ready for review before verification`,
      )
    } catch (err) {
      consola.debug(
        `first-mate: markReadyForReview before verifier failed for ${unit.missionId}:${unitHandle(unit)}:`,
        err,
      )
    }
  }

  // Cross-lab verification that actually happens on the GitHub portal: request
  // a Copilot code review on the PR. It posts a COMMENTED review whose findings
  // the lead then judges (judge_review) — the lead / peer critics are a
  // different lab than the copilot producer, so producer≠checker holds at the
  // decision. (The other cloud agents cannot be requested as reviewers; only
  // Copilot code review is served — see docs/first-mate-design.md.)
  await assertFenceHeld("verifier review request")
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

/** Small stable digest (djb2) so a failure fingerprint stays short + comparable. */
function digest(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * A2 failure fingerprint. A stable string of the CURRENT blocking-failure
 * identity (CI rollup + review decision + floor verdict + a digest of the active
 * verifier findings). `retries` resets to 0 only when this changes wake-over-wake
 * (genuine progress on a NEW failure); the same failure recurring keeps climbing
 * toward the cap. Computed from `observed` (pre-classify) so it never depends on
 * a value the same sweep is about to overwrite.
 */
export function failureSignature(observed: Observed): string {
  return [
    `ci=${observed.ci?.rollup ?? "none"}`,
    `review=${observed.reviewDecision ?? "none"}`,
    `floor=${observed.floor ?? "none"}`,
    `findings=${digest(observed.reviewExcerpt ?? "")}`,
  ].join("|")
}

/**
 * A5 (5d) — dismiss first-mate's OWN stale CHANGES_REQUESTED reviews (sentinel
 * in the body, commit id older than the current head) so a fix the agent pushed
 * isn't blocked forever by a superseded review, then REFETCH and RECOMPUTE
 * `observed.reviewDecision` from what remains — never blind-clear, so a human
 * APPROVE or an at-head / human CHANGES_REQUESTED survives.
 */
async function dismissStaleOwnReviews(
  unit: UnitRow,
  observed: Observed,
  deps: ControllerDeps,
): Promise<void> {
  if (!autoDismissEnabled()) return
  if (
    observed.reviewDecision !== "CHANGES_REQUESTED" ||
    unit.pr === null ||
    !unit.headSha
  ) {
    return
  }

  const repo = agentRepo(unit.repo)
  const reviews = await deps.getPullRequestReviews(repo, unit.pr)
  const stale = reviews.filter(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      review.bodyExcerpt.includes(FM_REVIEW_SENTINEL) &&
      review.commitId !== undefined &&
      review.commitId !== unit.headSha &&
      review.nodeId !== undefined,
  )
  if (stale.length === 0) return

  await assertFenceHeld("dismiss stale own review")
  for (const review of stale) {
    await deps.dismissPullRequestReview(
      review.nodeId!,
      "Superseded by a newer commit; first mate dismissing its own stale review.",
    )
  }

  // Recompute from the post-dismiss reality (a refetch reflects the DISMISSED
  // state), taking the latest state per author so a human's standing wins.
  const remaining = await deps.getPullRequestReviews(repo, unit.pr)
  observed.reviewDecision = recomputeReviewDecision(remaining)
}

/** Latest-state-per-author reduction to a GitHub-style reviewDecision. */
function recomputeReviewDecision(reviews: ReviewSummary[]): string | null {
  const latestByAuthor = new Map<string, string>()
  for (const review of reviews) {
    // Dismissed/commented/pending don't change a reviewer's standing.
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") continue
    latestByAuthor.set(review.author, review.state)
  }
  const states = [...latestByAuthor.values()]
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED"
  if (states.includes("APPROVED")) return "APPROVED"
  return null
}

/**
 * A1 — a BLOCKED unit still gets OBSERVED (never dispatched/steered) so an
 * out-of-band merge/close of its PR is reconciled instead of leaving the unit
 * blocked forever. Decision-type aware: only a legitimate merge_approval merge
 * of the pinned, floor_passed PR is laundered into floor_passed; any other
 * external merge is recorded as `external_merge_unverified` (loud warn), a close
 * as `cancelled_external_close`, and an uncorrelated merge stays blocked for a
 * human. Returns after handling; the caller `continue`s.
 */
async function observeBlockedUnit(
  unit: UnitRow,
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  const decisionId = unit.blockingDecisionId
  if (!decisionId) return

  const observed = await deps.observeUnit(unit)
  updateUnitFromObservedPrs(unit, observed)
  unit.lastCheckedMs = Date.now()

  const mutation = observed.externalMutation
  let decision: DecisionRecord | undefined
  try {
    decision = (await deps.readDecisions()).find((d) => d.decisionId === decisionId)
  } catch (err) {
    consola.debug(`first-mate: readDecisions for blocked unit failed:`, err)
  }

  const answer = async (choice: string): Promise<void> => {
    try {
      await deps.markAnswered(decisionId, choice, "external")
    } catch (err) {
      consola.debug(`first-mate: markAnswered(${choice}) for external mutation failed:`, err)
    }
  }

  const mergedPr = observed.prs.find((pr) => pr.merged || pr.state === "MERGED")
  const mergedIsPinned = mergedPr != null && unit.pr != null && mergedPr.number === unit.pr
  // The merge is only "verified" if it landed the EXACT head the floor verdict
  // was recorded against. A blocked unit skips classify's stale-floor
  // invalidation, so without this a PR that was floor_passed at an OLD head,
  // then pushed and externally merged at a NEW head, would launder the stale
  // verdict into floor_passed. Mirror maybeMergeWithApproval's staleHead guard.
  const floorHeadMatches =
    unit.floorSha != null &&
    unit.floorSha.length > 0 &&
    mergedPr != null &&
    mergedPr.headSha.length > 0 &&
    mergedPr.headSha === unit.floorSha

  if (mutation === "merged") {
    if (
      decision?.type === "merge_approval" &&
      mergedIsPinned &&
      floorHeadMatches &&
      unit.validation === "floor_passed"
    ) {
      // Legitimate: the human approved a merge of exactly this floor_passed PR
      // and it merged out-of-band (or a client-side 5xx hid the success).
      unit.terminal = true
      unit.phase = "done"
      unit.artifact = "pr_merged"
      unit.validation = "floor_passed"
      unit.blockingDecisionId = null
      await answer("superseded_external_merge")
      applied.push(`reconciled approved external merge for ${repoLabel(unit.repo)}#${unit.pr}`)
    } else {
      // Merged out-of-band under a human_decision / retry-cap block, or never
      // floor_passed / CI-red: mark terminal but NEVER launder it into
      // floor_passed. Record the honest unverified state and warn loudly.
      unit.terminal = true
      unit.phase = "done"
      unit.artifact = "pr_merged"
      unit.validation = "external_merge_unverified"
      unit.blockingDecisionId = null
      await answer("superseded_external_merge_unverified")
      consola.warn(
        `first-mate: ${repoLabel(unit.repo)}#${unit.pr ?? "?"} was merged out-of-band WITHOUT a verified floor pass (decision ${decision?.type ?? "unknown"}) — recorded external_merge_unverified`,
      )
      applied.push(`recorded UNVERIFIED external merge for ${repoLabel(unit.repo)}#${unit.pr ?? "?"}`)
    }
  } else if (mutation === "closed") {
    unit.terminal = true
    unit.phase = "done"
    unit.artifact = "pr_closed"
    unit.validation = "cancelled_external_close"
    unit.blockingDecisionId = null
    await answer("cancelled_external_close")
    applied.push(`reconciled external close for ${repoLabel(unit.repo)}#${unit.pr ?? "?"}`)
  } else if (mutation === "merged_uncorrelated") {
    // A merge was seen only via the ambiguous author fallback — do NOT mark done.
    // Leave it blocked; the still-pending decision surfaces it for a human.
    consola.warn(
      `first-mate: an UNCORRELATED merged PR was observed for blocked ${unit.missionId}:${unitHandle(unit)} — leaving blocked for human reconciliation`,
    )
  }

  await deps.upsertUnit(unit.repo, unit)
}

/**
 * Lightweight, idempotent, best-effort reconciliation at the start of a drive.
 * (1) a stale blockingDecisionId (decision answered/absent) → clear it; (2) a
 * terminal unit still pointing at a pending decision → answer it; (3) warn on a
 * consumed approval whose unit never reached pr_merged. Never throws.
 */
async function reconcile(
  units: UnitRow[],
  deps: ControllerDeps,
  applied: string[],
): Promise<void> {
  let decisions: DecisionRecord[]
  try {
    decisions = await deps.readDecisions()
  } catch (err) {
    consola.debug("first-mate reconcile: readDecisions failed, skipping:", err)
    return
  }
  const byId = new Map(decisions.map((d) => [d.decisionId, d]))

  for (const unit of units) {
    const decisionId = unit.blockingDecisionId
    if (!decisionId) continue
    const decision = byId.get(decisionId)
    if (decision === undefined || decision.status === "answered") {
      // (1) the decision is gone or already resolved — the block is stale.
      unit.blockingDecisionId = null
      await deps.upsertUnit(unit.repo, unit)
      applied.push(`reconciled: cleared stale block on ${unit.missionId}:${unitHandle(unit)}`)
    } else if (unit.terminal === true) {
      // (2) a terminal unit shouldn't still hold a pending decision.
      try {
        await deps.markAnswered(decisionId, "reconciled_terminal", "system")
      } catch (err) {
        consola.debug("first-mate reconcile: markAnswered failed:", err)
      }
      unit.blockingDecisionId = null
      await deps.upsertUnit(unit.repo, unit)
      applied.push(`reconciled: answered pending decision on terminal ${unit.missionId}:${unitHandle(unit)}`)
    }
  }

  // (3) a consumed approval whose unit never reached pr_merged is an anomaly.
  for (const decision of decisions) {
    const approval = decision.approval
    if (approval?.consumed !== true) continue
    const owner = units.find(
      (unit) => repoLabel(unit.repo) === repoLabel(approval.repo) && unit.pr === approval.pr,
    )
    if (owner && !(owner.terminal === true && owner.artifact === "pr_merged")) {
      consola.warn(
        `first-mate reconcile: a consumed merge approval for ${repoLabel(approval.repo)}#${approval.pr} has no merged unit — manual verification may be needed`,
      )
    }
  }
}

/**
 * #8 — guard a duplicate-able external side effect with the ambient fencing
 * lease. A driver fenced out mid-sweep (its lease stolen) must not perform
 * external effects that have no OCC/idempotency backstop — reviews, comments,
 * review requests, check re-runs, task cancels. The ledger write is already
 * fenced (runFenced); this re-checks the lease IMMEDIATELY before the effect and
 * throws if we no longer hold it, so a fenced-out driver skips it (the throw is
 * caught by the per-unit / per-answer isolation and the effect never fires).
 * Outside a runFenced scope (tests / tools / the non-daemon lead) there is no
 * ambient token → no-op. (Merge is additionally protected by the single-use
 * approval it consumes, so it cannot be duplicated regardless.)
 *
 * Exported for the regression test.
 */
export async function assertFenceHeld(effect: string): Promise<void> {
  const token = currentFenceToken()
  if (token !== undefined && !(await isCurrentFencingToken(token))) {
    throw new Error(
      `first-mate: drive lease lost before ${effect} (token ${token}) — skipping side effect`,
    )
  }
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
    case "assign_verifier": {
      const primaryPr =
        observed.prs.find((entry) => entry.number === unit.pr) ?? observed.prs[0]
      if (
        await assignVerifier(unit, deps, applied, {
          isDraft: primaryPr?.isDraft,
          prNodeId: evidence.prNodeId,
        })
      )
        return
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
    }
    case "rerun_ci":
      if (evidence.runId !== undefined) {
        await assertFenceHeld("CI re-run")
        await deps.rerunChecks(agentRepo(unit.repo), {
          runId: evidence.runId,
          failedOnly: true,
        })
        applied.push(`reran checks for ${unit.missionId}:${unitHandle(unit)}`)
      }
      return
    case "cancel":
      if (unit.taskId !== null) {
        await assertFenceHeld("task cancel")
        await deps.cancelTask(agentRepo(unit.repo), unit.taskId)
      }
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
  // A dependency is satisfied only when the depended-on unit (by stable id) has
  // MERGED. Matching by id (not issue) is what makes ordering work for
  // plan-first/task-based units, which have no issue number.
  return unit.dependsOn.every((depId) =>
    units.some(
      (candidate) =>
        candidate.id === depId &&
        candidate.terminal === true &&
        candidate.artifact === "pr_merged" &&
        // A3: a genuinely merged dependency has its OWN PR bound. `pr != null`
        // rejects a unit that was spuriously marked pr_merged from an
        // uncorrelated sibling PR (which never adopts unit.pr).
        candidate.pr != null,
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
 * Idempotency-Key. On success the taskId is recorded and the intent cleared, and
 * that is PERSISTED before the outbox is settled (see #5 below). On throw the
 * intent stays pending on disk (unknown outcome) — recovery is the
 * isDispatchInterrupted escalation on the next healthy wake, NOT re-dispatch.
 * Returns null when the API returned no taskId — treated as ambiguous, so the
 * intent is LEFT pending (recovery escalates; never auto-re-dispatch).
 */
/**
 * Chunk A step 1 + #1b: STABLE dispatch idempotency key derived from the repo,
 * unit id, and attempt — NOT a fresh uuid — so a re-dispatch of the SAME attempt
 * dedupes at the provider and in the durable outbox; a genuinely new attempt
 * gets a new key. Exported for the regression test.
 */
export function dispatchIdempotencyKey(unit: UnitRow, attempt: number): string {
  const unitId = unit.id ?? (unit.issue !== null ? `issue-${unit.issue}` : "unit")
  return `dispatch:${unit.repo.owner}/${unit.repo.name}#${unitId}@${attempt}`
}

async function dispatchWithOutbox(
  unit: UnitRow,
  deps: ControllerDeps,
  start: (c: { idempotencyKey: string; promptTag: string }) => Promise<{ taskId: string; state: string }>,
  renewLease?: () => Promise<boolean>,
): Promise<{ taskId: string; state: string } | null> {
  // #3 (replay guard) — a dispatch intent already persisted means a startTask
  // may already be in flight (or a prior wake was interrupted mid-dispatch).
  // NEVER start a second task and do NOT bump `attempt`: reuse the existing
  // pending key and let the isDispatchInterrupted recovery (a human escalation
  // carrying the correlation id) resolve it. This closes the replay window where
  // a redelivered answer or a re-drained inbox entry (crash-before-ack) would
  // otherwise fire startTask twice for the same unit+attempt.
  if (unit.dispatch !== undefined) {
    consola.debug(
      `first-mate: skipping dispatch for ${unit.missionId}:${unitHandle(unit)} — a dispatch intent (${unit.dispatch.id}) is already pending; recovery resolves it`,
    )
    return null
  }
  // #1 (cutover) — require a LIVE-LEASE PROOF (a SUCCESSFUL renewal), not just
  // token equality, BEFORE we persist a dispatch intent or fire startTask. Token
  // equality (below) is EXPIRY-BLIND: an expired-but-unstolen lease keeps the
  // same token number, so a dispatch could fire on a dead lease. renewLease
  // extends the lease AND confirms we still own it; a false result means we are
  // no longer the sole driver, so we abort. Checking this BEFORE recording the
  // intent means an aborted dispatch leaves NO residue — the next wake retries
  // cleanly. This matters on the answer path (approve/refine), where taskId is
  // the prior PLAN task (non-null): a stuck intent there would NOT be caught by
  // isDispatchInterrupted (which requires taskId===null) and would wedge the
  // replay guard above. dispatchWave renews in its own pre-loop and omits this,
  // relying on the token-equality guard + isDispatchInterrupted recovery.
  if (renewLease !== undefined && !(await renewLease())) {
    throw new Error(
      `first-mate: drive lease renewal failed before dispatch side effect for ${unit.missionId}:${unitHandle(unit)} — aborting`,
    )
  }
  // A fresh dispatch is always attempt 1: the guard above returns early when a
  // prior intent exists (recovery, not a re-dispatch, resolves that), so we never
  // bump the counter here.
  const attempt = 1
  const key = dispatchIdempotencyKey(unit, attempt)
  unit.dispatch = { id: key, requestedMs: Date.now(), attempts: attempt }
  await deps.upsertUnit(unit.repo, unit) // persist intent BEFORE the side effect (hard stop if this throws)
  // Durable outbox: record the intent before the irreversible startTask. If a
  // crash lands between startTask and clearing the intent, RECOVERY is the
  // isDispatchInterrupted escalation (persisted intent + no taskId → surfaced to
  // a human to verify no orphan task), NOT an automatic re-dispatch. The stable
  // idempotency key is what makes any deliberate re-run (e.g. a future wired
  // reconcile, or a manual replay) a provider-side no-op — it is not itself a
  // recovery mechanism here.
  await deps.dispatchOutbox?.record({ key, kind: "dispatch" })
  // #3 — re-check the fencing lease IMMEDIATELY before the irreversible startTask.
  // The fenced intent-write above already aborts if the lease was stale then; this
  // closes the window where it is stolen AFTER that write but before the side
  // effect, and it covers EVERY dispatch path uniformly (the dispatch wave AND the
  // answer-driven approve/refine re-dispatches) — not just dispatchWave's pre-loop
  // renew. If fenced out we throw before startTask; the intent stays pending and a
  // healthy driver escalates it.
  const token = currentFenceToken()
  if (token !== undefined && !(await isCurrentFencingToken(token))) {
    throw new Error(`first-mate: drive lease lost before dispatch side effect (token ${token})`)
  }
  const task = await start({ idempotencyKey: key, promptTag: `\n\n<!-- fm-dispatch:${key} -->` })
  // Empty taskId on a 2xx is AMBIGUOUS (a task may have been created but the id
  // not echoed) — leave the intent pending so recovery escalates rather than
  // auto-re-dispatching into a possible duplicate. Only a real id clears it.
  if (task.taskId.length === 0) return null
  // #5 — PERSIST the dispatch outcome (taskId recorded, intent cleared) to the
  // ledger BEFORE settling the outbox. Ordering the durable ledger write first
  // means a crash in this window leaves at worst outbox=pending + ledger=done —
  // the SAFE direction (an idempotent replay at most). The reverse order could
  // leave outbox=done + ledger=intent-pending, which recovery would misread as an
  // interrupted dispatch and needlessly escalate. taskId and intent-clear MUST be
  // set together: clearing the intent while taskId is still null would flip the
  // unit back to isUndispatched and risk a double dispatch.
  unit.taskId = task.taskId
  unit.dispatch = undefined
  await deps.upsertUnit(unit.repo, unit)
  await deps.dispatchOutbox?.markDone(key)
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
      model: resolveCloudAgentModel(unit.model ?? mission.defaultModel),
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
  renewLease?: () => Promise<boolean>,
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

    // #3 — renew the lease immediately BEFORE the irreversible startTask. If the
    // lease was lost/stolen mid-sweep we are no longer the sole driver; STOP the
    // wave rather than perform an external side effect a second driver may also
    // perform. (Fencing rejects the ledger write; this guards the side effect.)
    if (renewLease !== undefined && !(await renewLease())) {
      applied.push("dispatch wave stopped: drive lease lost mid-sweep")
      break
    }

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

  // Phase 1.3 — lease-gate the DRIVE path; Phase A — decouple answer-submission
  // from driving. When a driveGate reports we do NOT hold the lease we
  // observe-and-defer (no execute/dispatch) — BUT submitting answers must still
  // succeed, else the lead's judgments never reach the daemon and the loop
  // stalls. So we PERSIST submitted answers to the durable queue here (a ledger
  // write, always allowed); the lease-holding driver drains + applies them on
  // its next tick. Backward-compatible: no driveGate → full drive.
  if (input.driveGate) {
    const canDrive = await input.driveGate()
    if (!canDrive) {
      const deferApplied: string[] = []
      if (input.answerQueue) {
        const queued = await input.answerQueue.enqueue({
          modelAnswers: input.modelAnswers,
          humanDecisions: input.humanDecisions,
        })
        if (queued > 0) deferApplied.push(`queued ${queued} answer(s) for the drive-holder`)
      }
      const observedUnits = await deps.loadAllUnits()
      const observedMissions = await deps.readMissions()
      const observedById = missionMap(observedMissions)
      const observedBoard = buildBoard(observedUnits, observedMissions)
      const observedWakeAt = nextWakeAt(observedUnits, observedById)
      // Routing-gap (Chunk A step 2): a deferring non-holder still SURFACES the
      // work pending for the lead/human. The drive-holder (daemon) has escalated
      // needsModel/needsHuman to the queue; reading it back here means the
      // heartbeat's advance observes real pending requests, never a blank board.
      const pending = input.pendingEscalations ? await input.pendingEscalations() : undefined
      return {
        board: observedBoard,
        needsModel: pending?.needsModel ?? [],
        needsHuman: pending?.needsHuman ?? [],
        applied: deferApplied,
        nextWakeAt: observedWakeAt,
        nextWakeSeconds: wakeSeconds(observedWakeAt),
        drove: false,
      }
    }
  }

  // #3 hot-path fencing — wrap the ENTIRE held drive in the lease's fencing
  // scope. runFenced sets an AsyncLocalStorage token that every commitUnits
  // below defaults to, so a driver fenced out mid-sweep (its lease stolen) is
  // rejected at every ledger write. The token is read AFTER the driveGate above
  // resolved (the gate renews/acquires, so it's current). Omitted → unfenced.
  const fenceToken = input.fenceToken?.()

  // #6 fail-CLOSED. A supervisor drive PROVIDES a fenceToken provider to fence
  // every write in the sweep. If that provider resolves to `undefined` while we
  // are about to drive (e.g. the lease is not actually held, or a wiring bug),
  // driving would run the ENTIRE sweep UNFENCED — reopening split-brain. Refuse
  // to drive rather than drive unfenced. Callers that intentionally drive
  // unfenced (tests / tools / the non-daemon lead) simply omit `fenceToken`, so
  // this only fires when fencing was requested but no token materialized.
  if (input.fenceToken !== undefined && fenceToken === undefined) {
    throw new Error(
      "first-mate: drive requested with a fenceToken provider that returned no token — " +
        "refusing to drive UNFENCED (fail-closed). The drive lease is not held.",
    )
  }

  const runDrive = async (): Promise<AdvanceResult> => {
    // Holder path: drain any answers queued by deferring callers and merge them
    // with answers submitted on THIS call, then apply all of them.
    let answersInput = input
    let ackDrained: (() => Promise<void>) | undefined
    if (input.answerQueue) {
      const drained = await input.answerQueue.drain()
      ackDrained = drained.ack
      if (drained.modelAnswers.length > 0 || drained.humanDecisions.length > 0) {
        answersInput = {
          ...input,
          modelAnswers: [...drained.modelAnswers, ...(input.modelAnswers ?? [])],
          humanDecisions: [...drained.humanDecisions, ...(input.humanDecisions ?? [])],
        }
      }
    }

    await applySubmittedAnswers(answersInput, deps, applied)
    // Checkpoint: the drained answers are now durably applied (and any that
    // failed to apply were re-enqueued by applySubmittedAnswers). Only now
    // delete the claimed inbox file(s). A crash before this ack leaves the
    // claim on disk for the next drain to replay, so no answer is dropped.
    if (ackDrained) await ackDrained()

    const units = await deps.loadAllUnits()
    const missions = await deps.readMissions()
    const missionsById = missionMap(missions)
    let order = 0

    // Start-of-drive reconciliation: clear stale blocks, answer pending
    // decisions on terminal units, warn on orphaned consumed approvals. Best
    // effort — never let a reconciliation hiccup abort the sweep.
    try {
      await reconcile(units, deps, applied)
    } catch (err) {
      consola.debug("first-mate: reconciliation sweep skipped:", err)
    }

    for (const unit of units.filter((row) => isActiveUnit(row, missionsById))) {
      const requestOrder = order
      order += 1

      // A1: a BLOCKED unit is never dispatched/steered, but it IS observed so an
      // out-of-band merge/close is reconciled (decision-type aware) rather than
      // wedging the unit forever. It never runs classify/executeAction.
      if (unit.blockingDecisionId) {
        try {
          await observeBlockedUnit(unit, deps, applied)
        } catch (err) {
          consola.warn(
            `first-mate: blocked unit ${unit.missionId}:${unitHandle(unit)} observe failed:`,
            err,
          )
          applied.push(`error observing blocked ${unit.missionId}:${unitHandle(unit)}: ${errText(err)}`)
        }
        continue
      }
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

        // A2 signature-reset: reset the per-failure retry counter only when the
        // blocking failure fingerprint CHANGES (genuine progress on a new
        // failure). The SAME failure recurring — even across a head move — keeps
        // climbing toward maxRetries. Runs BEFORE classify so retries reflects
        // this wake. (totalFixes, the hard bound, is never reset here.)
        const failSig = failureSignature(observed)
        if (unit.lastFailSig !== undefined && unit.lastFailSig !== null && failSig !== unit.lastFailSig) {
          unit.retries = 0
        }
        unit.lastFailSig = failSig

        // A5: dismiss first-mate's OWN stale CHANGES_REQUESTED reviews and
        // recompute reviewDecision, so a fix the agent pushed isn't blocked by a
        // superseded review. Best-effort; a human review always survives.
        try {
          await dismissStaleOwnReviews(unit, observed, deps)
        } catch (err) {
          consola.debug(`first-mate: dismissStaleOwnReviews skipped for ${unit.missionId}:${unitHandle(unit)}:`, err)
        }

        if (await maybeMergeWithApproval(unit, observed, evidence, deps, applied)) {
          continue
        }

        const classified = classify(observed, unit)
        unit.provider = classified.provider
        unit.phase = classified.phase
        unit.artifact = classified.artifact
        unit.validation = classified.validation

        // A6 empty-PR tracking: classifyValidation already gates an empty PR to
        // a non-advancing "unknown" (→ noop). Track consecutive empties here and
        // ESCALATE at the cap so it never noops forever; a PR with changes resets
        // the counter.
        const isEmptyPr =
          classified.artifact === "pr_open" &&
          observed.changedFiles === 0 &&
          observed.diffTruncated !== true
        if (isEmptyPr) {
          unit.emptyObservations = (unit.emptyObservations ?? 0) + 1
        } else if ((observed.changedFiles ?? 0) > 0) {
          unit.emptyObservations = 0
        }

        let action = nextAction(classified, unit, policy)
        if (isEmptyPr && (unit.emptyObservations ?? 0) >= EMPTY_PR_OBSERVATION_CAP) {
          action = {
            kind: "escalate_human",
            reason: "the agent's pull request has no changes after repeated observations",
          }
        }
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
      input.renewLease,
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
      drove: true,
    }
  }

  return fenceToken !== undefined ? runFenced(fenceToken, runDrive) : runDrive()
}
