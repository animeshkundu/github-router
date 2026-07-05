import { randomUUID } from "node:crypto"

import consola from "consola"
import { z } from "zod"

import {
  closePullRequest as realClosePullRequest,
  commitFiles,
  getPullRequestState as realGetPullRequestState,
  getRequiredChecksForSha as realGetRequiredChecksForSha,
  getSelfLogin as realGetSelfLogin,
  mergePullRequest as realMergePullRequest,
  repoHasWorkflows as realRepoHasWorkflows,
} from "~/lib/agent/service"
import type { RepoRef as AgentRepoRef } from "~/lib/agent/types"
import { advance as advanceController, buildBoard, type HumanDecision, type ModelAnswer } from "~/lib/first-mate/controller"
import { buildScaffoldFiles } from "~/lib/first-mate/scaffold-spec"
import {
  createScaffoldBranch,
  createScaffoldPullRequest,
  deleteScaffoldBranch,
  getDefaultBranch,
  normalizeBranchRef,
  parseRepoSlug,
} from "~/lib/first-mate/scaffold-helpers"
import { loadAllUnits, readMissions, upsertMission, type Mission } from "~/lib/first-mate/registry"
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
  mergePullRequest: typeof realMergePullRequest
  closePullRequest: typeof realClosePullRequest
  repoHasWorkflows: typeof realRepoHasWorkflows
  getSelfLogin: typeof realGetSelfLogin
  readMissions: typeof readMissions
  loadAllUnits: typeof loadAllUnits
}

function defaultMergeCloseDeps(): MergeCloseDeps {
  return {
    getPullRequestState: realGetPullRequestState,
    getRequiredChecksForSha: realGetRequiredChecksForSha,
    mergePullRequest: realMergePullRequest,
    closePullRequest: realClosePullRequest,
    repoHasWorkflows: realRepoHasWorkflows,
    getSelfLogin: realGetSelfLogin,
    readMissions,
    loadAllUnits,
  }
}

/**
 * Backoff (ms) between mergeability polls when GitHub reports `mergeable: null`
 * / `UNKNOWN` (it computes the mergeable flag asynchronously after a push). We
 * NEVER merge on an unknown value — poll a few times, then refuse.
 */
const MERGEABLE_POLL_DELAYS_MS = [400, 800, 1600] as const

const ScaffoldRepoArgsSchema = z.object({
  repo: z.string().trim().min(1),
  mode: z.enum(["add-missing-only", "overwrite-approved"]).optional(),
  base_ref: z.string().trim().min(1).optional(),
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
          ["add-missing-only", "overwrite-approved"],
          "How to handle files that already exist. Defaults to add-missing-only.",
        ),
        base_ref: stringProp("Optional base branch name. Defaults to the repository default branch."),
      }, ["repo"]),
      async (args, signal) => {
        const input = parseScaffoldRepoArgs(args)
        const repo = parseRepoSlug(input.repo)
        const baseBranch = input.base_ref === undefined
          ? await getDefaultBranch(repo, signal)
          : normalizeBranchRef(input.base_ref)
        const branch = await createScaffoldBranch(repo, baseBranch, signal)
        const files = buildScaffoldFiles({ repoName: input.repo })
        const result = await commitFiles(input.repo, branch, files, {
          mode: input.mode ?? "add-missing-only",
          message: "scaffold: seed agentic-dev conventions",
        })
        // No-op scaffold: everything was already present, so nothing was
        // committed. Creating a PR here would 422 ("no commits between base and
        // head"), and the branch we created is an orphan — delete it (best
        // effort) and short-circuit with pr:null.
        if (result.committed.length === 0) {
          try {
            await deleteScaffoldBranch(repo, branch, signal)
          } catch (err) {
            consola.debug("first-mate: scaffold no-op branch cleanup skipped:", err)
          }
          return ok({
            committed: [],
            preserved: result.preserved,
            pr: null,
            note: "nothing to scaffold (all files present)",
          })
        }
        const pr = await createScaffoldPullRequest(repo, branch, baseBranch, signal)
        return ok({ pr, committed: result.committed, preserved: result.preserved })
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
      }, []),
      async (args) => {
        const modelAnswers = optionalModelAnswers(args)
        const result = await advanceController({
          modelAnswers,
          humanDecisions: optionalHumanDecisions(args),
          topK: optionalNumber(args, "top_k"),
          maxInFlightPerProvider: optionalNumber(args, "max_in_flight_per_provider"),
          missionId: optionalString(args, "mission_id"),
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
      "Read the first-mate board without waking the controller.",
      objectSchema({}, []),
      async () => {
        const [missions, units] = await Promise.all([readMissions(), loadAllUnits()])
        return ok({ board: buildBoard(units, missions) })
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
          return ok({ closed: true, state: "CLOSED", note: "already closed" })
        }
        const result = await deps.closePullRequest(repo, pr)
        return ok({ closed: result.closed, state: result.state })
      },
    ),
    tool(
      "mission_status",
      "Read compact status for all first-mate missions, or for one mission id.",
      objectSchema({
        mission_id: stringProp("Optional mission id to filter to."),
      }, []),
      async (args) => {
        const [missions, units] = await Promise.all([readMissions(), loadAllUnits()])
        return ok({ missions: buildMissionStatus(missions, units, optionalString(args, "mission_id")) })
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
): MissionStatusRow[] {
  const unitsByMission = groupUnitsByMission(units)
  return missions
    .filter((mission) => missionId === undefined || mission.id === missionId)
    .map((mission) => {
      const missionUnits = unitsByMission.get(mission.id) ?? []
      return {
        missionId: mission.id,
        title: mission.goal,
        status: mission.status,
        counts: countsByPhase(missionUnits),
        blocked: blockedCount(missionUnits),
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

function countsByPhase(units: UnitRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const unit of units) counts[unit.phase] = (counts[unit.phase] ?? 0) + 1
  return counts
}

function blockedCount(units: UnitRow[]): number {
  return units.filter((unit) => Boolean(unit.blockingDecisionId)).length
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
