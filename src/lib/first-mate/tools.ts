import { randomUUID } from "node:crypto"

import { advance as advanceController, type HumanDecision, type ModelAnswer } from "~/lib/first-mate/controller"
import { loadAllUnits, readMissions, upsertMission, type Mission } from "~/lib/first-mate/registry"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"
import type { McpGroup, NonPersonaMcpTool } from "~/lib/peer-mcp-personas"
import { state } from "~/lib/state"

const FIRST_MATE_GROUP: McpGroup = "first-mate"

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface BoardRow {
  missionId: string
  title: string
  repos: string[]
  counts: Record<string, number>
  blocked: number
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

export function createFirstMateTools(): ReadonlyArray<NonPersonaMcpTool> {
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
      }, ["goal", "repos", "acceptance_criteria"]),
      async (args) => {
        const repos = requiredStringArray(args, "repos").map(parseRepoRef)
        const now = Date.now()
        const missionId = randomUUID()
        await upsertMission({
          id: missionId,
          goal: requiredString(args, "goal"),
          acceptanceCriteria: requiredString(args, "acceptance_criteria"),
          houseRules: optionalString(args, "house_rules"),
          priority: optionalNumber(args, "priority"),
          repos,
          status: "active",
          createdMs: now,
          updatedMs: now,
        })
        return ok({ missionId, repos })
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
      }, []),
      async (args) => {
        const result = await advanceController({
          modelAnswers: optionalModelAnswers(args),
          humanDecisions: optionalHumanDecisions(args),
          topK: optionalNumber(args, "top_k"),
          maxInFlightPerProvider: optionalNumber(args, "max_in_flight_per_provider"),
        })
        return ok({
          board: result.board,
          needsModel: result.needsModel,
          needsHuman: result.needsHuman,
          applied_count: result.applied.length,
          nextWakeAt: result.nextWakeAt,
        })
      },
    ),
    tool(
      "board",
      "Read the first-mate board without waking the controller.",
      objectSchema({}, []),
      async () => {
        const [missions, units] = await Promise.all([readMissions(), loadAllUnits()])
        return ok({ board: buildBoard(missions, units) })
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

function buildBoard(missions: Mission[], units: UnitRow[]): BoardRow[] {
  const unitsByMission = groupUnitsByMission(units)
  return missions
    .filter((mission) => mission.status === "active")
    .map((mission) => {
      const missionUnits = unitsByMission.get(mission.id) ?? []
      return {
        missionId: mission.id,
        title: mission.goal,
        repos: mission.repos.map(repoLabel),
        counts: countsByPhase(missionUnits),
        blocked: blockedCount(missionUnits),
      }
    })
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

function repoLabel(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
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

function stringArrayProp(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description }
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
