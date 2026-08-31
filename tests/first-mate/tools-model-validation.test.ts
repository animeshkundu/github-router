import { afterEach, describe, expect, test } from "bun:test"

import { createFirstMateTools } from "~/lib/first-mate/tools"
import { state } from "~/lib/state"

/**
 * #2/#4 — start_mission validates an explicit `default_model` at INPUT time (via
 * resolveCloudAgentModel, inside the tool wrapper's try/catch), so a typo fails
 * FAST with the actionable message where the operator supplied it — instead of
 * throwing every controller wake at dispatch (where unit.retries never bumps for
 * a bad model, so it would never converge). This asserts the invalid path fails
 * before any state is persisted; the valid path never reaches validation-throw
 * (resolveCloudAgentModel returns the normalized id and the flow proceeds).
 */

const savedModels = state.models
const savedToken = state.githubAgentToken
const savedFirstMateDir = process.env.GH_ROUTER_FIRST_MATE_DIR

afterEach(() => {
  state.models = savedModels
  state.githubAgentToken = savedToken
  if (savedFirstMateDir === undefined) delete process.env.GH_ROUTER_FIRST_MATE_DIR
  else process.env.GH_ROUTER_FIRST_MATE_DIR = savedFirstMateDir
})

function startMissionTool() {
  const tools = createFirstMateTools()
  const tool = tools.find((t) => t.toolNameHttp === "start_mission")
  if (tool === undefined) throw new Error("start_mission tool not found")
  return tool
}

describe("start_mission input-time model validation", () => {
  test("an invalid explicit default_model + live catalog fails fast with the actionable message", async () => {
    state.githubAgentToken = "agent-token" // pass the agent-token gate
    // @ts-expect-error - partial model data for testing
    state.models = { object: "list", data: [{ id: "gpt-5.5" }] }

    const res = await startMissionTool().handler({
      goal: "Ship it",
      repos: ["octo/repo"],
      acceptance_criteria: "Tests pass.",
      default_model: "gpt-does-not-exist",
    })

    expect(res.isError).toBe(true)
    // The throw happens BEFORE upsertMission, so no mission was persisted; the
    // actionable "not in the Copilot catalog" message reaches the operator.
    expect(res.content[0]?.text).toContain("not in the Copilot catalog")
  })
})
