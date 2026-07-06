import { randomUUID } from "node:crypto"
import consola from "consola"
import { z } from "zod"

import {
  closePullRequest as realClosePullRequest,
  commitFiles,
  getPullRequestState as realGetPullRequestState,
  getPullRequestDiffSummary as realGetPullRequestDiffSummary,
  getRequiredChecksForSha as realGetRequiredChecksForSha,
  getSelfLogin as realGetSelfLogin,
  mergePullRequest as realMergePullRequest,
  repoHasWorkflows as realRepoHasWorkflows,
} from "~/lib/agent/service"
import type { RepoRef as AgentRepoRef } from "~/lib/agent/types"
import { addUnitsToMission, advance as advanceController, buildBoard, summarizeInactiveMissions, type HumanDecision, type ModelAnswer } from "~/lib/first-mate/controller"
import {
  buildScaffoldFiles,
  planScaffoldFiles,
  type ExistingScaffoldFile,
  type ScaffoldCommandSet,
  type ScaffoldFileReport,
  type ScaffoldMode,
  type ScaffoldOpts,
  type ScaffoldTestContext,
} from "~/lib/first-mate/scaffold-spec"
import {
  createScaffoldBranch,
  createScaffoldPullRequest,
  deleteScaffoldBranch,
  getRepositoryDetails,
  normalizeBranchRef,
  parseRepoSlug,
  readRepoDirectoryNames,
  readRepoTextFile,
} from "~/lib/first-mate/scaffold-helpers"
import { loadAllUnits, readMissions, upsertMission, type Mission } from "~/lib/first-mate/registry"
import { upsertUnit as realUpsertUnit } from "~/lib/first-mate/ledger"
import { markAnswered as realMarkAnswered, readDecisions as realReadDecisions } from "~/lib/first-mate/decisions"
import { AnswerInbox } from "~/lib/first-mate/scheduler/answer-inbox"
import { SchedulerLease, makeDriveGate } from "~/lib/first-mate/scheduler/lease"
import { Tier1Shadow, fromModelRequest, shadowEnabled } from "~/lib/first-mate/scheduler/shadow"
import { resolveCloudAgentModel } from "~/lib/first-mate/task-model"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"
import type { McpGroup, NonPersonaMcpTool } from "~/lib/peer-mcp-personas"
import { state } from "~/lib/state"

const FIRST_MATE_GROUP: McpGroup = "first-mate"

/**
 * Phase 1.3 — the heartbeat/lead's drive lease. Shared (default first-mate dir)
 * with the daemon's lease, so when the daemon holds it this MCP advance path
 * defers (observe-only, drove:false) instead of double-driving. When no daemon
 * runs, this path acquires the lease and drives as before.
 *
 * Gated by its OWN hatch GH_ROUTER_FM_LEASE_GATE (default ON). Previously this
 * shared GH_ROUTER_FM_OCC with the ledger's OCC/CAS/fencing, so disabling OCC
 * silently ALSO disabled the single-driver lease gate — one hatch quietly
 * turning off two independent safety mechanisms. They are now separate:
 * GH_ROUTER_FM_OCC controls only ledger OCC; GH_ROUTER_FM_LEASE_GATE=0 is the
 * dedicated escape hatch back to today's unconditional drive.
 */
const heartbeatLease = new SchedulerLease()
export function leaseGateEnabled(): boolean {
  return process.env.GH_ROUTER_FM_LEASE_GATE !== "0"
}

/** Phase 2 Tier1 shadow (log-only; active only when GH_ROUTER_FM_SHADOW=1). */
const tier1Shadow = new Tier1Shadow()

/**
 * Phase A — shared durable answer inbox. When this MCP path defers (a daemon
 * holds the lease), submitted answers are persisted here and the daemon applies
 * them on its next tick. Same default dir as the daemon's inbox.
 */
const answerInbox = new AnswerInbox()

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface MissionStatusRow {
  missionId: string
  title: string
  status: Mission["status"]
  counts: Record<string, number>
  blocked: number
  units: Array<{
    unitId: string
    issue: number | null
    pr: number | null
    phase: UnitRow["phase"]
    provider: UnitRow["provider"]
    validation: UnitRow["validation"]
    model?: string
    blockedReason?: string
  }>
  summary: { done: number; failed: number }
}

class FirstMateToolInputError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "FirstMateToolInputError"
    this.code = code
  }
}

type MergeMethod = "merge" | "squash" | "rebase"

/**
 * Service dependencies the operator merge/close tools use. Injected so tests can
 * drive the safety gate deterministically without live GitHub; production wires
 * the real service functions. Kept minimal — only the PR read/merge/close/CI
 * surface the two tools actually call.
 */
export interface MergeCloseDeps {
  getPullRequestState: typeof realGetPullRequestState
  getRequiredChecksForSha: typeof realGetRequiredChecksForSha
  getPullRequestDiffSummary: typeof realGetPullRequestDiffSummary
  mergePullRequest: typeof realMergePullRequest
  closePullRequest: typeof realClosePullRequest
  repoHasWorkflows: typeof realRepoHasWorkflows
  getSelfLogin: typeof realGetSelfLogin
  readMissions: typeof readMissions
  loadAllUnits: typeof loadAllUnits
  upsertMission: typeof upsertMission
  upsertUnit: typeof realUpsertUnit
  markAnswered: typeof realMarkAnswered
  readDecisions: typeof realReadDecisions
}

function defaultMergeCloseDeps(): MergeCloseDeps {
  return {
    getPullRequestState: realGetPullRequestState,
    getRequiredChecksForSha: realGetRequiredChecksForSha,
    getPullRequestDiffSummary: realGetPullRequestDiffSummary,
    mergePullRequest: realMergePullRequest,
    closePullRequest: realClosePullRequest,
    repoHasWorkflows: realRepoHasWorkflows,
    getSelfLogin: realGetSelfLogin,
    readMissions,
    loadAllUnits,
    upsertMission,
    upsertUnit: realUpsertUnit,
    markAnswered: realMarkAnswered,
    readDecisions: realReadDecisions,
  }
}

/**
 * Backoff (ms) between mergeability polls when GitHub reports `mergeable: null`
 * / `UNKNOWN` (it computes the mergeable flag asynchronously after a push). We
 * NEVER merge on an unknown value — poll a few times, then refuse.
 */
const MERGEABLE_POLL_DELAYS_MS = [400, 800, 1600] as const

const ScaffoldDetectionOverridesSchema = z.object({
  tech_stack: z.string().trim().min(1).optional(),
  primary_os: z.string().trim().min(1).optional(),
  package_manager: z.string().trim().min(1).optional(),
  build_command: z.string().trim().min(1).optional(),
  typecheck_command: z.string().trim().min(1).optional(),
  lint_command: z.string().trim().min(1).optional(),
  test_command: z.string().trim().min(1).optional(),
  dev_command: z.string().trim().min(1).optional(),
  ui_evidence_required: z.boolean().optional(),
}).strict()

const ScaffoldRepoArgsSchema = z.object({
  repo: z.string().trim().min(1),
  mode: z.enum(["add-missing-only", "overwrite-approved", "enhance"]).optional(),
  base_ref: z.string().trim().min(1).optional(),
  detection_overrides: ScaffoldDetectionOverridesSchema.optional(),
}).strict()

type ScaffoldRepoArgs = z.infer<typeof ScaffoldRepoArgsSchema>

export function createFirstMateTools(
  depsOverride: Partial<MergeCloseDeps> = {},
): ReadonlyArray<NonPersonaMcpTool> {
  const deps: MergeCloseDeps = { ...defaultMergeCloseDeps(), ...depsOverride }
  function tool(
    toolNameHttp: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolResult>,
  ): NonPersonaMcpTool {
    return {
      toolNameHttp,
      group: FIRST_MATE_GROUP,
      description,
      inputSchema,
      capability: "agents",
      async handler(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
        if (!hasAgentToken()) {
          return errorResult(
            new FirstMateToolInputError(
              "AGENT_TOKEN_REQUIRED",
              "first-mate tools require --agents or GH_ROUTER_ENABLE_AGENTS=1 with a GitHub agent token",
            ),
          )
        }
        try {
          return await handler(args, signal)
        } catch (err) {
          return errorResult(err)
        }
      },
    }
  }

  return Object.freeze([
    tool(
      "start_mission",
      "Register a first-mate mission for one or more GitHub repositories. Unit decomposition is handled by later controller/model wakes.",
      objectSchema({
        goal: stringProp("Mission goal."),
        repos: stringArrayProp("Repositories as owner/name strings."),
        acceptance_criteria: stringProp("User-blessed acceptance criteria for the mission."),
        priority: numberProp("Optional numeric priority; higher values are handled by controller policy."),
        house_rules: stringProp("Optional repository or operator constraints."),
        default_model: stringProp("Model the GitHub cloud coding agent uses for this mission's tasks; defaults to gpt-5.5."),
        plan_gate: enumProp(
          ["hard", "soft"],
          "Plan-review gate. hard (default) requires the flow's review before build and re-plans on a rejecting review; soft auto-advances a passing plan review to build without human approval but escalates a rejecting review to a human.",
        ),
        ci_required: boolProp("When true, refuse merge approval if the repository reports no CI for the PR head."),
      }, ["goal", "repos", "acceptance_criteria"]),
      async (args) => {
        const repos = requiredStringArray(args, "repos").map(parseRepoRef)
        const now = Date.now()
        const missionId = randomUUID()
        // #2 — validate an explicit default_model at INPUT time (inside the tool
        // wrapper's try/catch), so a typo fails FAST with the actionable message
        // where the operator supplied it rather than throwing every controller
        // wake at dispatch. Unspecified → gpt-5.5 default → resolves silently.
        const defaultModel = optionalString(args, "default_model")
        resolveCloudAgentModel(defaultModel)
        const planGate = optionalPlanGate(args, "plan_gate")
        await upsertMission({
          id: missionId,
          goal: requiredString(args, "goal"),
          acceptanceCriteria: requiredString(args, "acceptance_criteria"),
          houseRules: optionalString(args, "house_rules"),
          priority: optionalNumber(args, "priority"),
          defaultModel,
          ...(planGate !== undefined ? { planGate } : {}),
          ...(optionalBoolean(args, "ci_required") !== undefined
            ? { ciRequired: optionalBoolean(args, "ci_required") }
            : {}),
          repos,
          status: "active",
          createdMs: now,
          updatedMs: now,
        })
        return ok({ missionId, repos })
      },
    ),
    tool(
      "scaffold_repo",
      "Seed deterministic agentic-dev convention files into a GitHub repository on a pull-request branch.",
      objectSchema({
        repo: stringProp("Repository as an owner/name string."),
        mode: enumProp(
          ["add-missing-only", "overwrite-approved", "enhance"],
          "How to handle files that already exist. add-missing-only skips tuned files; overwrite-approved replaces; enhance appends missing ## sections to guidance/history foundation files. Defaults to add-missing-only.",
        ),
        base_ref: stringProp("Optional base branch name. Defaults to the repository default branch."),
        detection_overrides: anyProp("Optional object of detection overrides: tech_stack, primary_os, package_manager, *_command, ui_evidence_required."),
      }, ["repo"]),
      async (args, signal) => {
        const input = parseScaffoldRepoArgs(args)
        const repo = parseRepoSlug(input.repo)
        const repository = input.base_ref === undefined
          ? await getRepositoryDetails(repo, signal)
          : { defaultBranch: normalizeBranchRef(input.base_ref) }
        const baseBranch = repository.defaultBranch
        const scaffoldOpts = await detectScaffoldOptions({
          repoSlug: input.repo,
          repo,
          baseBranch,
          repoDescription: repository.description,
          overrides: input.detection_overrides,
          signal,
        })
        const desiredFiles = buildScaffoldFiles(scaffoldOpts)
        const existingFiles = await readExistingScaffoldFiles(repo, baseBranch, desiredFiles.map((file) => file.path), signal)
        const mode: ScaffoldMode = input.mode ?? "add-missing-only"
        const plan = planScaffoldFiles({ mode, desired: desiredFiles, existing: existingFiles })
        if (plan.filesToCommit.length === 0) {
          return ok({
            committed: [],
            preserved: existingFiles.map((file) => file.path),
            report: plan.reports,
            pr: null,
            note: "nothing to scaffold (all files present or no missing sections)",
          })
        }
        const branch = await createScaffoldBranch(repo, baseBranch, signal)
        const result = await commitFiles(input.repo, branch, plan.filesToCommit, {
          mode: "overwrite-approved",
          message: "scaffold: seed agentic-dev conventions",
        })
        if (result.committed.length === 0) {
          try {
            await deleteScaffoldBranch(repo, branch, signal)
          } catch (err) {
            consola.debug("first-mate: scaffold no-op branch cleanup skipped:", err)
          }
          return ok({
            committed: [],
            preserved: result.preserved,
            report: plan.reports,
            pr: null,
            note: "nothing to scaffold (all files present or no missing sections)",
          })
        }
        const body = buildScaffoldPrBody(plan.reports)
        const pr = await createScaffoldPullRequest(repo, branch, baseBranch, signal, body)
        return ok({ pr, committed: result.committed, preserved: result.preserved, report: plan.reports })
      },
    ),
    tool(
      "advance",
      "Wake the first-mate controller once, applying model answers or human decisions, then return the compact board and pending requests.",
      objectSchema({
        model_answers: arrayOfObjectsProp(
          "Optional model judgments to apply before the wake.",
          {
            requestId: stringProp("Request id from a previous needsModel entry."),
            verdict: anyProp("Structured verdict for the request kind."),
          },
          ["requestId", "verdict"],
        ),
        human_decisions: arrayOfObjectsProp(
          "Optional human choices to apply before the wake.",
          {
            requestId: stringProp("Request id from a previous needsHuman entry."),
            choice: stringProp("Chosen option id or short decision text."),
          },
          ["requestId", "choice"],
        ),
        top_k: numberProp("Maximum model and human requests to return."),
        max_in_flight_per_provider: numberProp("Maximum active units per cloud-agent provider."),
        mission_id: stringProp("Optional mission id to scope the drive to a single mission. Absent → global sweep across all missions."),
        include_all: boolProp("When true, include inactive missions in the board. Default returns active missions only and summarizes inactive counts."),
      }, []),
      async (args) => {
        const modelAnswers = optionalModelAnswers(args)
        const result = await advanceController({
          modelAnswers,
          humanDecisions: optionalHumanDecisions(args),
          topK: optionalNumber(args, "top_k"),
          maxInFlightPerProvider: optionalNumber(args, "max_in_flight_per_provider"),
          missionId: optionalString(args, "mission_id"),
          includeAll: optionalBoolean(args, "include_all") ?? false,
          answerQueue: answerInbox,
          // When this MCP/heartbeat path is the drive holder it must apply the
          // SAME safety envelope as the daemon: fence every ledger write in the
          // sweep with the held lease token, and renew before each dispatch so a
          // lost lease stops the wave before the irreversible startTask. (When a
          // daemon holds the lease this path defers and none of this runs.)
          ...(leaseGateEnabled()
            ? {
                driveGate: makeDriveGate(heartbeatLease),
                fenceToken: () => heartbeatLease.fencingToken,
                renewLease: async () => (await heartbeatLease.renew()) !== undefined,
              }
            : {}),
        })
        // Phase 2: Tier1 SHADOW (log-only, fire-and-forget, never blocks/decides).
        if (shadowEnabled()) {
          for (const a of modelAnswers ?? []) {
            void tier1Shadow.recordLeadOutcome(a.requestId, a.verdict).catch(() => {})
          }
          for (const r of result.needsModel) {
            void tier1Shadow.observe(fromModelRequest(r)).catch(() => {})
          }
        }
        return ok({
          board: result.board,
          inactiveSummary: summarizeInactiveMissions(await deps.readMissions()),
          needsModel: result.needsModel,
          needsHuman: result.needsHuman,
          applied_count: result.applied.length,
          nextWakeAt: result.nextWakeAt,
          nextWakeSeconds: result.nextWakeSeconds,
          // Phase 1.3: false when a daemon holds the lease and this heartbeat
          // observed-and-deferred (no drive) — the caller should just yield.
          drove: result.drove !== false,
        })
      },
    ),
    tool(
      "board",
      "Read compact board status. Defaults to active missions only; pass include_all to include inactive missions.",
      objectSchema({
        include_all: boolProp("When true, include inactive missions in the board. Default returns active missions only and summarizes inactive counts."),
      }, []),
      async (args) => {
        const includeAll = optionalBoolean(args, "include_all") ?? false
        const [missions, units] = await Promise.all([readMissions(), loadAllUnits()])
        return ok({
          board: buildBoard(units, missions, { includeAll }),
          inactiveSummary: summarizeInactiveMissions(missions),
        })
      },
    ),
    tool(
      "merge_pr",
      "Merge a GitHub pull request the operator has reviewed. Head-guarded (rejects a moved head), ownership-scoped (agent-authored or an active first-mate mission repo, else requires allow_unowned), and gated on a pre-merge safety check (OPEN, not draft, MERGEABLE, CI green).",
      objectSchema({
        repo: stringProp("Repository as an owner/name string."),
        pr: numberProp("Pull request number."),
        expected_head_sha: stringProp("The exact head commit SHA the operator reviewed. The merge is REJECTED if the live head has moved from this value; re-review the new head before merging."),
        expected_base: stringProp("Optional base branch name the operator reviewed against. When set, the merge is rejected if the live base ref differs."),
        method: enumProp(["merge", "squash", "rebase"], "Merge method. Defaults to squash."),
        allow_unowned: boolProp("Set true to merge a PR that is neither agent-authored nor part of an active first-mate mission. Dangerous, explicit opt-in; the override is audit-logged."),
      }, ["repo", "pr", "expected_head_sha"]),
      async (args) => {
        const repoSlug = requiredString(args, "repo")
        const repo = parseRepoSlug(repoSlug)
        const pr = requiredPrNumber(args, "pr")
        const expectedHead = requiredString(args, "expected_head_sha")
        const expectedBase = optionalString(args, "expected_base")
        const method = optionalMergeMethod(args, "method")
        const allowUnowned = optionalBoolean(args, "allow_unowned") ?? false

        const live = await deps.getPullRequestState(repo, pr)

        // Head guard: the operator MUST pass the head it reviewed. A moved head
        // means the review is stale — refuse rather than bless a new head.
        if (live.headSha.length > 0 && live.headSha !== expectedHead) {
          return errorResult(
            new FirstMateToolInputError(
              "HEAD_MOVED",
              `live head ${live.headSha} does not match expected_head_sha ${expectedHead}; re-review the current head before merging`,
            ),
          )
        }

        const ownership = await resolveOwnership(repo, pr, live.authorLogin, deps)
        if (!ownership.owned) {
          if (!allowUnowned) {
            return errorResult(
              new FirstMateToolInputError(
                "UNOWNED_PR",
                `${repoSlug}#${pr} is ${ownership.reason}; pass allow_unowned:true to override`,
              ),
            )
          }
          consola.warn(
            `first-mate: merge_pr OVERRIDE on unowned PR ${repoSlug}#${pr} (author=${live.authorLogin ?? "unknown"}, actor=${ownership.selfLogin || "unknown"}, reason=${ownership.reason}) via allow_unowned`,
          )
        }

        const gate = await evaluateMergeSafety(repo, pr, live, expectedHead, expectedBase, deps)
        if (!gate.ok) {
          return errorResult(new FirstMateToolInputError("MERGE_BLOCKED", gate.reason))
        }

        const merged = await deps.mergePullRequest(repo, {
          pr,
          expectedHeadSha: expectedHead,
          ...(method !== undefined ? { method } : {}),
        })
        return ok({ merged: merged.merged, sha: merged.sha })
      },
    ),
    tool(
      "close_pr",
      "Close a GitHub pull request WITHOUT merging it. Ownership-scoped identically to merge_pr (agent-authored or active first-mate mission repo, else requires allow_unowned).",
      objectSchema({
        repo: stringProp("Repository as an owner/name string."),
        pr: numberProp("Pull request number."),
        allow_unowned: boolProp("Set true to close a PR that is neither agent-authored nor part of an active first-mate mission. Explicit opt-in; audit-logged."),
      }, ["repo", "pr"]),
      async (args) => {
        const repoSlug = requiredString(args, "repo")
        const repo = parseRepoSlug(repoSlug)
        const pr = requiredPrNumber(args, "pr")
        const allowUnowned = optionalBoolean(args, "allow_unowned") ?? false

        const live = await deps.getPullRequestState(repo, pr)
        if (live.state.toUpperCase() === "MERGED") {
          return errorResult(
            new FirstMateToolInputError("ALREADY_MERGED", `${repoSlug}#${pr} is already merged and cannot be closed`),
          )
        }

        const ownership = await resolveOwnership(repo, pr, live.authorLogin, deps)
        if (!ownership.owned) {
          if (!allowUnowned) {
            return errorResult(
              new FirstMateToolInputError(
                "UNOWNED_PR",
                `${repoSlug}#${pr} is ${ownership.reason}; pass allow_unowned:true to override`,
              ),
            )
          }
          consola.warn(
            `first-mate: close_pr OVERRIDE on unowned PR ${repoSlug}#${pr} (author=${live.authorLogin ?? "unknown"}, actor=${ownership.selfLogin || "unknown"}, reason=${ownership.reason}) via allow_unowned`,
          )
        }

        if (live.state.toUpperCase() === "CLOSED") {
          const reconciled = await reconcileClosedPr(repo, pr, deps)
          return ok({ closed: true, state: "CLOSED", note: "already closed", reconciled })
        }
        const result = await deps.closePullRequest(repo, pr)
        const reconciled = await reconcileClosedPr(repo, pr, deps)
        return ok({ closed: result.closed, state: result.state, reconciled })
      },
    ),
    tool(
      "add_units",
      "Add dispatchable units to an existing active first-mate mission. DependsOn entries are 0-based indices within the submitted units list.",
      objectSchema({
        mission_id: stringProp("Mission id to add units to."),
        units: arrayOfObjectsProp(
          "Units to add to the mission.",
          {
            title: stringProp("Unit title."),
            repo: stringProp("Optional owner/name repo. Defaults to the mission's first repo."),
            agent: enumProp(["copilot", "anthropic", "openai"], "Optional cloud-agent provider. Defaults to copilot."),
            dependsOn: { type: "array", items: { type: "number" }, description: "Optional 0-based dependency indices into this units list." },
            model: stringProp("Optional model override for this unit."),
          },
          ["title"],
        ),
      }, ["mission_id", "units"]),
      async (args) => {
        const missionId = requiredString(args, "mission_id")
        const missions = await deps.readMissions()
        const mission = missions.find((entry) => entry.id === missionId)
        if (mission === undefined) {
          return errorResult(new FirstMateToolInputError("MISSION_NOT_FOUND", `mission ${missionId} was not found`))
        }
        if (mission.status !== "active") {
          return errorResult(new FirstMateToolInputError("MISSION_NOT_ACTIVE", `mission ${missionId} is ${mission.status}; only active missions can receive units`))
        }
        const existingUnits = await deps.loadAllUnits(mission.id)
        const units = optionalRecordArray(args, "units")
        if (units === undefined || units.length === 0) {
          return errorResult(new FirstMateToolInputError("INVALID_ARGUMENT", "arguments.units must contain at least one unit"))
        }
        const created = await addUnitsToMission(mission, units, deps, existingUnits)
        return ok({ missionId, added: created })
      },
    ),
    tool(
      "abandon_mission",
      "Mark a first-mate mission abandoned so it drops from the active board. Existing units are marked terminal without merging.",
      objectSchema({
        mission_id: stringProp("Mission id to abandon."),
        reason: stringProp("Optional short reason for the abandonment."),
      }, ["mission_id"]),
      async (args) => {
        const missionId = requiredString(args, "mission_id")
        const reason = optionalString(args, "reason")
        const missions = await deps.readMissions()
        const mission = missions.find((entry) => entry.id === missionId)
        if (mission === undefined) {
          return errorResult(new FirstMateToolInputError("MISSION_NOT_FOUND", `mission ${missionId} was not found`))
        }
        if (mission.status === "done") {
          return errorResult(new FirstMateToolInputError("MISSION_TERMINAL", `mission ${missionId} is done and cannot be abandoned`))
        }
        if (mission.status !== "abandoned") {
          await deps.upsertMission({
            ...mission,
            status: "abandoned",
            updatedMs: Date.now(),
          })
        }
        const units = (await deps.loadAllUnits(missionId)).filter((unit) => unit.terminal !== true)
        for (const unit of units) {
          const decisionId = unit.blockingDecisionId
          unit.terminal = true
          unit.phase = "done"
          unit.cancelledBy = "external"
          unit.blockingDecisionId = null
          if (decisionId !== undefined && decisionId !== null) {
            await markDecisionAnsweredIfPending(deps, decisionId, "abandoned")
          }
          await deps.upsertUnit(unit.repo, unit)
        }
        return ok({ abandoned: true, missionId, terminalUnits: units.length, ...(reason !== undefined ? { reason } : {}) })
      },
    ),
    tool(
      "mission_status",
      "Read compact status for all first-mate missions, or for one mission id. Defaults to active missions only; pass include_all for inactive missions too.",
      objectSchema({
        mission_id: stringProp("Optional mission id to filter to."),
        include_all: boolProp("When true, include inactive missions in the status list. Default returns active missions only and summarizes inactive counts."),
      }, []),
      async (args) => {
        const [missions, units] = await Promise.all([readMissions(), loadAllUnits()])
        return ok({
          missions: buildMissionStatus(
            missions,
            units,
            optionalString(args, "mission_id"),
            optionalBoolean(args, "include_all") ?? false,
          ),
          inactiveSummary: summarizeInactiveMissions(missions),
        })
      },
    ),
  ])
}

export const FIRST_MATE_TOOLS: ReadonlyArray<NonPersonaMcpTool> = createFirstMateTools()

function hasAgentToken(): boolean {
  return typeof state.githubAgentToken === "string" && state.githubAgentToken.length > 0
}

interface OwnershipResult {
  owned: boolean
  reason: string
  selfLogin: string
}

/**
 * Ownership scope for the merge/close operator tools: a PR is "owned" ONLY when
 * (a) the agent-token bot authored it (self-login match), OR (b) the PR
 * CORRELATES to a live first-mate UNIT — some unit from `loadAllUnits()` targets
 * this repo AND has `unit.pr === thisPr`. A human's PR that merely happens to sit
 * in a repo an active mission targets is NOT owned (it requires an explicit
 * `allow_unowned` opt-in) — "an active mission targets the repo" is deliberately
 * NOT sufficient. `getSelfLogin`/`readMissions`/`loadAllUnits` failures degrade to
 * NOT owned (fail-closed) so a transient error can't silently widen scope.
 */
async function resolveOwnership(
  repo: AgentRepoRef,
  pr: number,
  authorLogin: string | undefined,
  deps: MergeCloseDeps,
): Promise<OwnershipResult> {
  const selfLogin = await deps.getSelfLogin().catch(() => "")
  if (loginMatches(authorLogin, selfLogin)) {
    return { owned: true, reason: "agent-authored", selfLogin }
  }

  // (b) Correlate to a first-mate unit: a unit we created for THIS PR in THIS
  // repo. This is the tight ownership signal — merely having an active mission
  // that targets the repo is NOT enough (that would make a human PR mergeable).
  try {
    const units = await deps.loadAllUnits()
    const correlated = units.some(
      (unit) => unit.pr === pr && repoMatchesTarget(unit.repo, repo),
    )
    if (correlated) {
      return { owned: true, reason: "correlated to a first-mate unit", selfLogin }
    }
  } catch (err) {
    // Fail-closed: an unreadable unit ledger must NOT widen scope.
    consola.debug("first-mate: unit load for ownership scope skipped:", err)
  }

  return {
    owned: false,
    reason: "not agent-authored and not correlated to a first-mate unit",
    selfLogin,
  }
}

type MergeSafety = { ok: true } | { ok: false; reason: string }

/**
 * Pre-merge safety gate. Refuses unless the PR is OPEN, not a draft, cleanly
 * MERGEABLE, and CI is green. Mergeability is computed asynchronously by GitHub,
 * so a `null`/`UNKNOWN` value is polled a few times with backoff and NEVER
 * merged on unknown. CI-green is judged from the check-run rollup for the exact
 * reviewed head (`getRequiredChecksForSha`) — `reviewDecision` alone is not a CI
 * signal. Limitation: a repo with no CI workflows has no check runs to gate on,
 * so a genuinely CI-less repo passes this gate on the human's review alone; a
 * repo that HAS workflows but hasn't reported checks yet is refused.
 */
function requiresCodeAndTests(mission: Mission | undefined, unit: UnitRow | undefined): boolean {
  const text = `${mission?.acceptanceCriteria ?? ""}\n${unit?.title ?? ""}`.toLowerCase()
  return /\bcode\b/.test(text) && /\btests?\b/.test(text)
}

function isDocsOnlyDiff(diff: Awaited<ReturnType<MergeCloseDeps["getPullRequestDiffSummary"]>>): boolean {
  if (diff.files.length === 0) return false
  return diff.files.every((file) => {
    const p = file.path.toLowerCase()
    return p.startsWith("docs/") || p.endsWith(".md") || p.endsWith(".mdx") || p.endsWith(".txt")
  })
}

async function findUnitForPr(
  repo: AgentRepoRef,
  pr: number,
  deps: MergeCloseDeps,
): Promise<{ unit?: UnitRow; mission?: Mission }> {
  const [units, missions] = await Promise.all([deps.loadAllUnits(), deps.readMissions()])
  const unit = units.find((entry) => entry.pr === pr && repoMatchesTarget(entry.repo, repo))
  const mission = unit === undefined ? undefined : missions.find((entry) => entry.id === unit.missionId)
  return { unit, mission }
}

async function evaluateMergeSafety(
  repo: AgentRepoRef,
  pr: number,
  initial: Awaited<ReturnType<MergeCloseDeps["getPullRequestState"]>>,
  expectedHead: string,
  expectedBase: string | undefined,
  deps: MergeCloseDeps,
): Promise<MergeSafety> {
  let live = initial
  let poll = 0
  while (isUnknownMergeable(live.mergeable) && poll < MERGEABLE_POLL_DELAYS_MS.length) {
    await delay(MERGEABLE_POLL_DELAYS_MS[poll]!)
    poll += 1
    live = await deps.getPullRequestState(repo, pr)
  }

  // Re-assert the head after any polling: a push during the window would make
  // the mergeable/CI signals we validated belong to a different commit than the
  // one merge would target. (mergePullRequest is also server-side head-guarded.)
  if (live.headSha.length > 0 && live.headSha !== expectedHead) {
    return { ok: false, reason: `head moved to ${live.headSha} during safety evaluation; re-review the current head` }
  }
  if (live.state.toUpperCase() !== "OPEN") {
    return { ok: false, reason: `PR is not OPEN (state=${live.state})` }
  }
  if (live.isDraft) {
    return { ok: false, reason: "PR is a draft; mark it ready for review before merging" }
  }
  if (expectedBase !== undefined && live.baseRef !== expectedBase) {
    return { ok: false, reason: `live base ${live.baseRef} does not match expected_base ${expectedBase}` }
  }
  if (isUnknownMergeable(live.mergeable)) {
    return { ok: false, reason: "mergeability is still UNKNOWN after retries; refusing to merge on an unknown state" }
  }
  if ((live.mergeable ?? "").toUpperCase() !== "MERGEABLE") {
    return { ok: false, reason: `PR is not cleanly mergeable (mergeable=${live.mergeable})` }
  }

  const diff = await deps.getPullRequestDiffSummary(repo, pr)
  if (!diff.truncated && diff.fileCount === 0 && diff.totalAdditions === 0 && diff.totalDeletions === 0) {
    return { ok: false, reason: "PR has no changed files and no additions/deletions; refusing to merge an empty diff" }
  }

  const { unit, mission } = await findUnitForPr(repo, pr, deps)
  if (
    unit?.dispatchMode === "build" &&
    requiresCodeAndTests(mission, unit) &&
    !diff.truncated &&
    isDocsOnlyDiff(diff)
  ) {
    return { ok: false, reason: "build unit requires code and tests but the PR diff is docs-only" }
  }

  // Test-count ratchet is intentionally advisory here: the diff file list is not
  // an absolute repo test count, so enforcing it would false-block legitimate
  // force-pushes/reverts/renames that reduce the cumulative base..head test-file
  // diff. Keep the empty-diff and docs-only guards above as the merge blockers
  // until a reliable absolute head-tree test count is available.

  const checks = await deps.getRequiredChecksForSha(repo, live.headSha)
  if (checks.rollup === "failing") {
    const names = checks.failing.map((f) => f.name).filter((n) => n.length > 0).join(", ")
    return { ok: false, reason: `CI checks are failing${names ? ` (${names})` : ""}` }
  }
  if (checks.rollup === "pending") {
    return { ok: false, reason: "CI checks are still running; refusing to merge before they complete" }
  }
  if (checks.rollup === "none") {
    // Zero check-runs AND no legacy status. Distinguish a genuinely CI-less repo
    // (merge rests on the human review + head/mergeable guards) from a repo that
    // HAS workflows but hasn't reported yet (refuse). FAIL-SAFE: an INDETERMINATE
    // picture — the workflow probe errored, or there is no base ref to probe —
    // is treated as NOT-green and refuses, so we never merge on an unverifiable
    // CI picture.
    let hasWorkflows = false
    let workflowsIndeterminate = false
    if (live.baseRef.length > 0) {
      try {
        hasWorkflows = await deps.repoHasWorkflows(repo, live.baseRef)
      } catch {
        workflowsIndeterminate = true
      }
    } else {
      workflowsIndeterminate = true
    }
    if (mission?.ciRequired === true) {
      return {
        ok: false,
        reason: "mission requires CI but no check runs or legacy statuses are reported for this head",
      }
    }
    if (hasWorkflows) {
      return {
        ok: false,
        reason: "repo has CI workflows but no check runs are reported for this head yet; refusing to merge before CI reports",
      }
    }
    if (workflowsIndeterminate) {
      return {
        ok: false,
        reason: "unable to determine whether the repo has CI workflows (indeterminate CI); refusing to merge until the CI picture is verifiable",
      }
    }
    // No CI workflows in the repo: nothing to gate on. Documented limitation —
    // absence of CI cannot be verified green; the merge rests on the operator's
    // review plus the head/mergeable guards.
  }
  return { ok: true }
}

function isUnknownMergeable(mergeable: string | null | undefined): boolean {
  return mergeable == null || mergeable.toUpperCase() === "UNKNOWN"
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/i, "")
}

function loginMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const na = normalizeLogin(a)
  const nb = normalizeLogin(b)
  return na.length > 0 && na === nb
}

async function markDecisionAnsweredIfPending(
  deps: MergeCloseDeps,
  decisionId: string,
  choice: string,
): Promise<void> {
  const decisions = await deps.readDecisions()
  const decision = decisions.find((entry) => entry.decisionId === decisionId)
  if (decision !== undefined && decision.status === "pending") {
    await deps.markAnswered(decisionId, choice, "system")
  }
}

async function reconcileClosedPr(
  repo: AgentRepoRef,
  pr: number,
  deps: MergeCloseDeps,
): Promise<{ terminalUnits: number }> {
  const units = await deps.loadAllUnits()
  const targets = units.filter(
    (unit) => unit.pr === pr && repoMatchesTarget(unit.repo, repo) && unit.terminal !== true,
  )
  for (const unit of targets) {
    unit.terminal = true
    unit.phase = "done"
    unit.artifact = "pr_closed"
    unit.validation = "cancelled_external_close"
    unit.cancelledBy = "external"
    const decisionId = unit.blockingDecisionId
    unit.blockingDecisionId = null
    if (decisionId !== undefined && decisionId !== null) {
      await markDecisionAnsweredIfPending(deps, decisionId, "closed_pr")
    }
    await deps.upsertUnit(unit.repo, unit)
  }
  return { terminalUnits: targets.length }
}

function repoMatchesTarget(missionRepo: RepoRef, target: AgentRepoRef): boolean {
  return (
    missionRepo.owner.toLowerCase() === target.owner.toLowerCase()
    && missionRepo.name.toLowerCase() === target.repo.toLowerCase()
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requiredPrNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} is required and must be a positive integer`,
    )
  }
  return value
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") {
    throw new FirstMateToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a boolean`)
  }
  return value
}

function optionalMergeMethod(args: Record<string, unknown>, key: string): MergeMethod | undefined {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (value !== "merge" && value !== "squash" && value !== "rebase") {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be one of "merge", "squash", or "rebase"`,
    )
  }
  return value
}

function buildMissionStatus(
  missions: Mission[],
  units: UnitRow[],
  missionId: string | undefined,
  includeAll: boolean,
): MissionStatusRow[] {
  const unitsByMission = groupUnitsByMission(units)
  return missions
    .filter((mission) => missionId === undefined || mission.id === missionId)
    .filter((mission) => includeAll || mission.status === "active")
    .map((mission) => {
      const missionUnits = unitsByMission.get(mission.id) ?? []
      const board = buildBoard(missionUnits, [mission], { includeAll: true })[0]
      return {
        missionId: mission.id,
        title: mission.goal,
        status: mission.status,
        counts: board?.counts ?? {},
        blocked: board?.blocked ?? 0,
        units: board?.units ?? [],
        summary: board?.summary ?? { done: 0, failed: 0 },
      }
    })
}

function groupUnitsByMission(units: UnitRow[]): Map<string, UnitRow[]> {
  const result = new Map<string, UnitRow[]>()
  for (const unit of units) {
    const missionUnits = result.get(unit.missionId) ?? []
    missionUnits.push(unit)
    result.set(unit.missionId, missionUnits)
  }
  return result
}

function parseRepoRef(value: string): RepoRef {
  const trimmed = value.trim()
  const parts = trimmed.split("/")
  if (
    parts.length !== 2
    || parts[0] === undefined
    || parts[1] === undefined
    || parts[0].trim() === ""
    || parts[1].trim() === ""
  ) {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.repos entries must be owner/name strings; got ${JSON.stringify(value)}`,
    )
  }
  return { owner: parts[0].trim(), name: parts[1].trim() }
}

function optionalModelAnswers(args: Record<string, unknown>): ModelAnswer[] | undefined {
  const entries = optionalRecordArray(args, "model_answers")
  if (entries === undefined) return undefined
  return entries.map((entry) => {
    if (!Object.prototype.hasOwnProperty.call(entry, "verdict")) {
      throw new FirstMateToolInputError(
        "INVALID_ARGUMENT",
        "arguments.model_answers entries must include verdict",
      )
    }
    return {
      requestId: requiredString(entry, "requestId"),
      verdict: entry.verdict,
    }
  })
}

function optionalHumanDecisions(args: Record<string, unknown>): HumanDecision[] | undefined {
  const entries = optionalRecordArray(args, "human_decisions")
  if (entries === undefined) return undefined
  return entries.map((entry) => ({
    requestId: requiredString(entry, "requestId"),
    choice: requiredString(entry, "choice"),
  }))
}

interface ScaffoldDetectionInput {
  repoSlug: string
  repo: AgentRepoRef
  baseBranch: string
  repoDescription?: string
  overrides?: ScaffoldRepoArgs["detection_overrides"]
  signal?: AbortSignal
}

async function detectScaffoldOptions(input: ScaffoldDetectionInput): Promise<ScaffoldOpts> {
  const [packageJsonText, goMod, pyproject, cargoToml, readme, workflowNames, rootNames] = await Promise.all([
    readRepoTextFile(input.repo, "package.json", input.baseBranch, input.signal),
    readRepoTextFile(input.repo, "go.mod", input.baseBranch, input.signal),
    readRepoTextFile(input.repo, "pyproject.toml", input.baseBranch, input.signal),
    readRepoTextFile(input.repo, "Cargo.toml", input.baseBranch, input.signal),
    readFirstAvailableText(input.repo, ["README.md", "readme.md"], input.baseBranch, input.signal),
    readRepoDirectoryNames(input.repo, ".github/workflows", input.baseBranch, input.signal),
    readRepoDirectoryNames(input.repo, ".", input.baseBranch, input.signal),
  ])
  const workflowTexts = await readWorkflowTexts(input.repo, workflowNames, input.baseBranch, input.signal)
  const packageJson = parsePackageJson(packageJsonText)
  const commands = detectCommands(packageJson, input.overrides)
  const packageManager = input.overrides?.package_manager ?? detectPackageManager(rootNames, packageJsonText)
  const tests = detectTests(packageJson, rootNames, pyproject, cargoToml, goMod)
  const stackParts = detectStackParts({ packageJson, goMod, pyproject, cargoToml, packageManager })
  const frameworkNames = packageJson === undefined ? [] : Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
  const uiEvidenceRequired = input.overrides?.ui_evidence_required ?? detectsUi(frameworkNames)
  const workflowSignal = [...workflowNames, ...workflowTexts]
  const primaryOs = input.overrides?.primary_os ?? detectPrimaryOs(readme, workflowSignal)
  const matrix = detectCiMatrix(primaryOs, workflowSignal)
  return {
    repoName: input.repoSlug,
    repoDescription: input.repoDescription ?? summarizeReadme(readme),
    defaultBranch: input.baseBranch,
    techStack: input.overrides?.tech_stack ?? (stackParts.length > 0 ? stackParts.join(", ") : undefined),
    packageManager,
    commands,
    tests,
    ci: { ...(primaryOs !== undefined ? { primaryOs } : {}), matrix },
    uiEvidenceRequired,
    projectStructure: detectProjectStructure(rootNames),
    detectedNotes: detectNotes({ packageJson, goMod, pyproject, cargoToml, workflows: workflowNames, primaryOs }),
  }
}

async function readFirstAvailableText(
  repo: AgentRepoRef,
  paths: ReadonlyArray<string>,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const path of paths) {
    const content = await readRepoTextFile(repo, path, ref, signal)
    if (content !== undefined) return content
  }
  return undefined
}

async function readWorkflowTexts(
  repo: AgentRepoRef,
  workflowNames: ReadonlyArray<string>,
  ref: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const workflowFiles = workflowNames.filter((name) => /\.(ya?ml)$/i.test(name))
  const entries = await Promise.all(workflowFiles.map((name) => readRepoTextFile(repo, `.github/workflows/${name}`, ref, signal)))
  return entries.filter((entry): entry is string => entry !== undefined)
}

interface ParsedPackageJson {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  packageManager?: string
}

function parsePackageJson(text: string | undefined): ParsedPackageJson | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return undefined
    return {
      scripts: stringRecord(parsed.scripts),
      dependencies: stringRecord(parsed.dependencies),
      devDependencies: stringRecord(parsed.devDependencies),
      ...(typeof parsed.packageManager === "string" ? { packageManager: parsed.packageManager } : {}),
    }
  } catch (err) {
    consola.debug("first-mate: package.json detection skipped:", err)
    return undefined
  }
}

function detectCommands(
  packageJson: ParsedPackageJson | undefined,
  overrides: ScaffoldRepoArgs["detection_overrides"],
): ScaffoldCommandSet {
  const commands: ScaffoldCommandSet = {}
  const pm = overrides?.package_manager ?? packageJson?.packageManager?.split("@")[0]
  const runner = pm === "bun" || pm === "pnpm" || pm === "yarn" || pm === "npm" ? pm : "npm"
  const scripts = packageJson?.scripts ?? {}
  if (packageJson !== undefined) {
    commands.install = installCommand(runner)
    for (const key of ["build", "typecheck", "lint", "test", "dev"] as const) {
      if (scripts[key] !== undefined) commands[key] = runScriptCommand(runner, key)
    }
  }
  if (overrides?.build_command !== undefined) commands.build = overrides.build_command
  if (overrides?.typecheck_command !== undefined) commands.typecheck = overrides.typecheck_command
  if (overrides?.lint_command !== undefined) commands.lint = overrides.lint_command
  if (overrides?.test_command !== undefined) commands.test = overrides.test_command
  if (overrides?.dev_command !== undefined) commands.dev = overrides.dev_command
  return commands
}

function detectPackageManager(rootNames: ReadonlyArray<string>, packageJsonText: string | undefined): string | undefined {
  const names = new Set(rootNames)
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun"
  if (names.has("pnpm-lock.yaml")) return "pnpm"
  if (names.has("yarn.lock")) return "yarn"
  if (names.has("package-lock.json") || packageJsonText !== undefined) return "npm"
  if (names.has("go.mod")) return "go"
  if (names.has("pyproject.toml")) return "python"
  if (names.has("Cargo.toml")) return "cargo"
  return undefined
}

function installCommand(packageManager: string): string {
  if (packageManager === "bun") return "bun install --frozen-lockfile"
  if (packageManager === "pnpm") return "pnpm install --frozen-lockfile"
  if (packageManager === "yarn") return "yarn install --immutable"
  return "npm ci"
}

function runScriptCommand(packageManager: string, script: string): string {
  if (packageManager === "bun") return `bun run ${script}`
  if (packageManager === "pnpm") return `pnpm ${script}`
  if (packageManager === "yarn") return `yarn ${script}`
  return `npm run ${script}`
}

function detectTests(
  packageJson: ParsedPackageJson | undefined,
  rootNames: ReadonlyArray<string>,
  pyproject: string | undefined,
  cargoToml: string | undefined,
  goMod: string | undefined,
): ScaffoldTestContext {
  const deps = packageJson === undefined ? {} : { ...packageJson.dependencies, ...packageJson.devDependencies }
  if (deps["bun-types"] !== undefined || packageJson?.scripts.test?.includes("bun test") === true) {
    return { framework: "bun:test", directory: rootNames.includes("tests") ? "tests/" : "<!-- TODO: confirm test directory. -->", glob: "**/*.{test,spec}.{ts,tsx,js,jsx}" }
  }
  if (deps.vitest !== undefined) return { framework: "Vitest", directory: rootNames.includes("tests") ? "tests/" : "src/", glob: "**/*.{test,spec}.{ts,tsx,js,jsx}" }
  if (deps.jest !== undefined) return { framework: "Jest", directory: rootNames.includes("tests") ? "tests/" : "__tests__/", glob: "**/*.{test,spec}.{ts,tsx,js,jsx}" }
  if (deps.mocha !== undefined) return { framework: "Mocha", directory: rootNames.includes("test") ? "test/" : "tests/", glob: "**/*.test.{js,ts}" }
  if (goMod !== undefined) return { framework: "go test", directory: "./...", glob: "**/*_test.go" }
  if (cargoToml !== undefined) return { framework: "cargo test", directory: "tests/ and inline #[cfg(test)] modules", glob: "**/*.rs" }
  if (pyproject !== undefined) return { framework: pyproject.includes("pytest") ? "pytest" : "python test runner", directory: rootNames.includes("tests") ? "tests/" : "<!-- TODO: confirm Python test directory. -->", glob: "**/test_*.py" }
  return {}
}

function detectStackParts(input: {
  packageJson: ParsedPackageJson | undefined
  goMod: string | undefined
  pyproject: string | undefined
  cargoToml: string | undefined
  packageManager: string | undefined
}): string[] {
  const parts: string[] = []
  if (input.packageJson !== undefined) parts.push(`JavaScript/TypeScript (${input.packageManager ?? "package manager TODO"})`)
  if (input.goMod !== undefined) parts.push("Go")
  if (input.pyproject !== undefined) parts.push("Python")
  if (input.cargoToml !== undefined) parts.push("Rust")
  const deps = input.packageJson === undefined ? {} : { ...input.packageJson.dependencies, ...input.packageJson.devDependencies }
  for (const framework of ["react", "next", "vite", "svelte", "vue", "hono", "express"] as const) {
    if (deps[framework] !== undefined) parts.push(framework)
  }
  return parts
}

function detectsUi(frameworkNames: ReadonlyArray<string>): boolean {
  return frameworkNames.some((name) => ["react", "next", "vite", "svelte", "vue", "@playwright/test", "cypress"].includes(name))
}

function detectPrimaryOs(readme: string | undefined, workflows: ReadonlyArray<string>): string | undefined {
  const haystack = `${readme ?? ""}\n${workflows.join("\n")}`.toLowerCase()
  if (haystack.includes("windows-first") || haystack.includes("windows 11 is the primary") || haystack.includes("primary deployment target") && haystack.includes("windows")) return "windows-latest"
  if (haystack.includes("macos") && haystack.includes("primary")) return "macos-latest"
  if (haystack.includes("linux") && haystack.includes("primary")) return "ubuntu-latest"
  return undefined
}

function detectCiMatrix(primaryOs: string | undefined, workflows: ReadonlyArray<string>): string[] {
  const matrix = new Set<string>()
  if (primaryOs !== undefined) matrix.add(primaryOs)
  const haystack = workflows.join("\n").toLowerCase()
  if (haystack.includes("windows")) matrix.add("windows-latest")
  if (haystack.includes("macos")) matrix.add("macos-latest")
  if (haystack.includes("ubuntu") || haystack.includes("linux")) matrix.add("ubuntu-latest")
  if (matrix.size === 0) {
    matrix.add("ubuntu-latest")
    matrix.add("windows-latest")
  }
  return [...matrix]
}

function summarizeReadme(readme: string | undefined): string | undefined {
  if (readme === undefined) return undefined
  const lines = readme.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
  return lines.slice(0, 3).join("\n\n") || undefined
}

function detectProjectStructure(rootNames: ReadonlyArray<string>): string[] {
  const interesting = ["src", "app", "packages", "tests", "test", "docs", ".github", "scripts"].filter((name) => rootNames.includes(name))
  return interesting.length > 0 ? interesting.map((name) => `\`${name}/\` — <!-- TODO: describe ownership and generated-file rules. -->`) : []
}

function detectNotes(input: {
  packageJson: ParsedPackageJson | undefined
  goMod: string | undefined
  pyproject: string | undefined
  cargoToml: string | undefined
  workflows: ReadonlyArray<string>
  primaryOs: string | undefined
}): string[] {
  const notes: string[] = []
  if (input.primaryOs === undefined) notes.push("Primary OS was not confidently detected; choose one before relying on OS-specific behavior.")
  if (input.workflows.length === 0) notes.push("No existing GitHub Actions workflows were detected; keep the starter CI matrix until branch protection is configured.")
  if (input.packageJson === undefined && input.goMod === undefined && input.pyproject === undefined && input.cargoToml === undefined) {
    notes.push("No package manifest was confidently detected; fill in stack and commands manually.")
  }
  return notes
}

async function readExistingScaffoldFiles(
  repo: AgentRepoRef,
  baseBranch: string,
  paths: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<ExistingScaffoldFile[]> {
  const entries = await Promise.all(paths.map(async (path): Promise<ExistingScaffoldFile | undefined> => {
    const content = await readRepoTextFile(repo, path, baseBranch, signal)
    return content === undefined ? undefined : { path, content }
  }))
  return entries.filter((entry): entry is ExistingScaffoldFile => entry !== undefined)
}

function buildScaffoldPrBody(reports: ReadonlyArray<ScaffoldFileReport>): string {
  const lines = reports.map((entry) => {
    if (entry.status === "enhanced") {
      const sections = entry.appendedSections?.join(", ") ?? "missing sections"
      return `- ${entry.path}: enhanced(appended: ${sections})`
    }
    if (entry.status === "skipped") return `- ${entry.path}: skipped(present)`
    return `- ${entry.path}: ${entry.status}`
  })
  return [
    "Seeds a repo-geared agentic-dev foundation for Copilot, local agents, CI, ADRs, changelog, durable learnings, and handoff discipline.",
    "",
    "## Scaffold report",
    "",
    ...lines,
    "",
    "No factory protocol files are seeded; orchestration remains external to the repository.",
  ].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry
  }
  return result
}

function parseScaffoldRepoArgs(args: Record<string, unknown>): ScaffoldRepoArgs {
  const parsed = ScaffoldRepoArgsSchema.safeParse(args)
  if (parsed.success) return parsed.data

  const issueSummary = parsed.error.issues
    .map((issue) => {
      const key = issue.path.length === 0 ? "arguments" : `arguments.${issue.path.join(".")}`
      return `${key}: ${issue.message}`
    })
    .join("; ")
  throw new FirstMateToolInputError(
    "INVALID_ARGUMENT",
    issueSummary || "arguments must match the scaffold_repo schema",
  )
}

function ok(value: unknown): McpToolResult {
  return jsonResult(value, false)
}

function jsonResult(value: unknown, isError: boolean): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function errorResult(err: unknown): McpToolResult {
  const code = errorCode(err)
  const message = err instanceof Error ? err.message : String(err)
  return jsonResult({ error: { code, message } }, true)
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "FIRST_MATE_ERROR"
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} is required and must be a non-empty string`,
    )
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new FirstMateToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === "" ? undefined : value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FirstMateToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a finite number`)
  }
  return value
}

function optionalPlanGate(
  args: Record<string, unknown>,
  key: string,
): "hard" | "soft" | undefined {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (value !== "hard" && value !== "soft") {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be one of "hard" or "soft"`,
    )
  }
  return value
}

function requiredStringArray(args: Record<string, unknown>, key: string): Array<string> {
  const value = args[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be an array of non-empty strings`,
    )
  }
  return value as Array<string>
}

function optionalRecordArray(
  args: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => asRecord(item) === undefined)) {
    throw new FirstMateToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be an array of objects`,
    )
  }
  return value as Array<Record<string, unknown>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function objectSchema(properties: Record<string, unknown>, required: Array<string>): Record<string, unknown> {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties,
  }
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description }
}

function numberProp(description: string): Record<string, unknown> {
  return { type: "number", description }
}

function boolProp(description: string): Record<string, unknown> {
  return { type: "boolean", description }
}

function stringArrayProp(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description }
}

function enumProp(values: ReadonlyArray<string>, description: string): Record<string, unknown> {
  return { type: "string", enum: [...values], description }
}

function arrayOfObjectsProp(
  description: string,
  properties: Record<string, unknown>,
  required: Array<string>,
): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: objectSchema(properties, required),
  }
}

function anyProp(description: string): Record<string, unknown> {
  return { description }
}
