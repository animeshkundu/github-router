import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { StrategyRecord } from "~/lib/first-mate/types"
import { firstText, type McpToolResult } from "~/lib/attachments"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-strategy-"))

const realPaths = await import("~/lib/paths")
mock.module("~/lib/paths", () => ({
  ...realPaths,
  PATHS: { ...realPaths.PATHS, FIRST_MATE_DIR: firstMateDir },
}))

const { pruneStrategy, readStrategies, readStrategy, upsertStrategy } = await import(
  "~/lib/first-mate/strategy-store"
)
const { createFirstMateTools } = await import("~/lib/first-mate/tools")
const { state } = await import("~/lib/state")

const savedToken = state.githubAgentToken

function strategy(
  missionId: string,
  overrides: Partial<StrategyRecord> = {},
): StrategyRecord {
  return {
    missionId,
    currentPhase: "discover",
    openAssumptions: ["Users need this"],
    updatedMs: 0,
    ...overrides,
  }
}

function strategyTool(name: "read_strategy" | "write_strategy") {
  const tool = createFirstMateTools().find((entry) => entry.toolNameHttp === name)
  if (tool === undefined) throw new Error(`${name} tool not found`)
  return tool
}

function parsed(res: McpToolResult): Record<string, unknown> {
  return JSON.parse(firstText(res)) as Record<string, unknown>
}

beforeEach(async () => {
  state.githubAgentToken = "agent-token"
  await fs.rm(path.join(firstMateDir, "strategy.json"), { force: true })
  await fs.rm(path.join(firstMateDir, "strategy.json.lock"), { force: true })
})

afterEach(() => {
  state.githubAgentToken = savedToken
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("first-mate strategy store", () => {
  test("upsert then read round-trips a record and unknown returns undefined", async () => {
    await upsertStrategy(
      strategy("m1", {
        repos: ["octo/repo"],
        activeBet: {
          hypothesis: "A narrow workflow converts",
          metric: "activation",
          threshold: ">= 40%",
          decisionRule: "continue",
        },
      }),
    )

    const stored = await readStrategy("m1")
    expect(stored).toMatchObject({
      missionId: "m1",
      repos: ["octo/repo"],
      currentPhase: "discover",
    })
    expect(stored?.updatedMs).toBeGreaterThan(0)
    expect(await readStrategy("unknown")).toBeUndefined()
  })

  test("decisionLog merge-appends while other supplied fields overwrite", async () => {
    await upsertStrategy(
      strategy("m1", {
        currentPhase: "discover",
        decisionLog: [
          { atMs: 1, decision: "Pick niche", rationale: "Strongest signal" },
        ],
      }),
    )
    await upsertStrategy(
      strategy("m1", {
        currentPhase: "position",
        openAssumptions: ["Teams will pay"],
        decisionLog: [
          { atMs: 2, decision: "Lead with speed", rationale: "User interviews" },
        ],
      }),
    )

    const stored = await readStrategy("m1")
    expect(stored?.currentPhase).toBe("position")
    expect(stored?.openAssumptions).toEqual(["Teams will pay"])
    expect(stored?.decisionLog?.map((entry) => entry.atMs)).toEqual([1, 2])
  })

  test("concurrent CAS upserts to different missions both persist", async () => {
    await Promise.all([
      upsertStrategy(strategy("m1")),
      upsertStrategy(strategy("m2", { currentPhase: "build" })),
    ])

    expect((await readStrategies()).map((entry) => entry.missionId).sort()).toEqual([
      "m1",
      "m2",
    ])
  })

  test("prune removes only the selected mission", async () => {
    await upsertStrategy(strategy("m1"))
    await upsertStrategy(strategy("m2"))
    await pruneStrategy("m1")
    expect((await readStrategies()).map((entry) => entry.missionId)).toEqual(["m2"])
  })
})

describe("first-mate strategy MCP tools", () => {
  test("write_strategy then read_strategy returns the persisted record", async () => {
    const write = strategyTool("write_strategy")
    const read = strategyTool("read_strategy")

    const writeResult = await write.handler({
      mission_id: "m-tool",
      repos: ["octo/repo"],
      currentPhase: "measure",
      activeBet: {
        hypothesis: "Retention improves",
        metric: "week-4 retention",
        threshold: ">= 50%",
        decisionRule: "continue",
      },
      greatnessChecklist: [
        { item: "Users return", status: "pending", evidence: "dashboard/retention" },
      ],
      decisionLog: [
        { atMs: 7, decision: "Measure retention", rationale: "Leading indicator" },
      ],
      openAssumptions: ["Cohort is representative"],
      nextStrategicAction: { action: "Review cohort", trigger: "100 users" },
      ignored: "unknown fields are stripped",
    })

    expect(parsed(writeResult).ok).toBe(true)
    expect(parsed(writeResult).updatedMs).toBeGreaterThan(0)

    const readResult = await read.handler({ mission_id: "m-tool" })
    expect(parsed(readResult)).toMatchObject({
      missionId: "m-tool",
      repos: ["octo/repo"],
      currentPhase: "measure",
      nextStrategicAction: { action: "Review cohort", trigger: "100 users" },
    })
  })

  test("read_strategy for an unknown mission returns an empty-shaped record", async () => {
    const result = await strategyTool("read_strategy").handler({
      mission_id: "missing",
    })

    expect(parsed(result)).toEqual({
      missionId: "missing",
      currentPhase: null,
      activeBet: null,
      greatnessChecklist: [],
      decisionLog: [],
      openAssumptions: [],
      nextStrategicAction: null,
      repos: [],
      updatedMs: 0,
    })
  })

  test("both tools declare agents capability and enforce the token guard", async () => {
    for (const name of ["read_strategy", "write_strategy"] as const) {
      const tool = strategyTool(name)
      expect(tool.capability).toBe("agents")
      state.githubAgentToken = undefined
      const result = await tool.handler({ mission_id: "m1" })
      expect(result.isError).toBe(true)
      expect(parsed(result).error).toMatchObject({ code: "AGENT_TOKEN_REQUIRED" })
      state.githubAgentToken = "agent-token"
    }
  })
})
