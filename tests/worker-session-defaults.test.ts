import { afterEach, describe, expect, test } from "bun:test"

import {
  DEFAULT_MODEL,
  resolveModeDefaults,
  resolveWorkerRunOpts,
  withNoOutputRetry,
} from "../src/lib/worker-agent/engine"
import {
  getWorkerSessionDefault,
  resetAllWorkerSessionDefaults,
  resetWorkerSessionDefault,
  setWorkerSessionDefault,
  WORKER_MODES,
} from "../src/lib/worker-agent/session-defaults"
import { NON_PERSONA_MCP_TOOLS } from "../src/lib/peer-mcp-personas"
import { state } from "../src/lib/state"
import { workerToolsEnabled } from "../src/lib/mcp-capabilities"

afterEach(() => resetAllWorkerSessionDefaults())

const tool = NON_PERSONA_MCP_TOOLS.find((entry) => entry.toolNameHttp === "worker_defaults")!

function model(id: string, efforts: string[]) {
  return {
    id,
    name: id,
    version: "1",
    vendor: "test",
    capabilities: { supports: { tool_calls: true, reasoning_effort: efforts } },
    supported_endpoints: ["/v1/responses"],
  }
}

describe("worker session defaults", () => {
  test("all six modes are independently overridable and test is not yoked to implement", () => {
    for (const [index, mode] of WORKER_MODES.entries()) {
      setWorkerSessionDefault(mode, { model: `model-${index}`, thinking: "low" })
    }
    for (const [index, mode] of WORKER_MODES.entries()) {
      expect(resolveModeDefaults(mode)).toMatchObject({
        model: `model-${index}`,
        thinking: "low",
        modelSource: "override",
        thinkingSource: "override",
      })
    }
    setWorkerSessionDefault("test", { model: "test-only" })
    expect(resolveModeDefaults("test").model).toBe("test-only")
    expect(resolveModeDefaults("implement").model).not.toBe("test-only")
  })

  test("per-call values beat session values and retries retain one snapshot", async () => {
    setWorkerSessionDefault("explore", { model: "session-model", thinking: "low" })
    const concrete = resolveWorkerRunOpts({
      prompt: "x",
      mode: "explore",
      workspace: "C:/workspace",
      model: "per-call-model",
    })
    expect(concrete.model).toBe("per-call-model")
    expect(concrete.thinking).toBe("low")

    const seen: string[] = []
    await withNoOutputRetry(async (opts) => {
      seen.push(opts.model!)
      setWorkerSessionDefault("explore", { model: "changed-mid-run" })
      return seen.length === 1
        ? { text: "[worker exited with no output: clean stop]" }
        : { text: "done" }
    }, concrete)
    expect(seen).toEqual(["per-call-model", "per-call-model"])
  })

  test("workflow opt-out ignores session overrides while ordinary runs honor them", () => {
    setWorkerSessionDefault("implement", { model: "same-lab-override", thinking: "low" })
    const ordinary = resolveWorkerRunOpts({ prompt: "x", mode: "implement" })
    const workflow = resolveWorkerRunOpts({
      prompt: "x",
      mode: "implement",
      ignoreSessionDefaults: true,
    })

    expect(ordinary.model).toBe("same-lab-override")
    expect(ordinary.thinking).toBe("low")
    expect(workflow.model).toBe("gpt-5.6-sol")
    expect(workflow.thinking).toBe("xhigh")
  })

  test("reset restores built-ins and never mutates the gate sentinel", () => {
    const builtIn = resolveModeDefaults("explore")
    setWorkerSessionDefault("explore", { model: "override" })
    resetWorkerSessionDefault("explore")
    expect(resolveModeDefaults("explore")).toEqual(builtIn)
    expect(DEFAULT_MODEL).toBe("gpt-5.4-mini")
  })

  test("tool validates models, stores requested unclamped thinking, and reports sources", async () => {
    const original = state.models
    state.models = {
      object: "list",
      data: [
        model(DEFAULT_MODEL, ["low", "high"]),
        model("valid", ["low"]),
      ] as NonNullable<typeof state.models>["data"],
    }
    try {
      const rejected = await tool.handler({ mode: "review", model: "missing" })
      expect(rejected.isError).toBe(true)
      expect(rejected.content[0]?.text).toContain("Available models with tool_calls: gpt-5.4-mini, valid")

      const invalidClearAll = await tool.handler({ clearAll: true, clear: false })
      expect(invalidClearAll.isError).toBe(true)
      expect(invalidClearAll.content[0]?.text).toContain("clearAll:true must stand alone")

      const set = await tool.handler({ mode: "review", model: "valid", thinking: "xhigh", workspace: "ignored" })
      expect(set.isError).toBeUndefined()
      expect(getWorkerSessionDefault("review").thinking).toBe("xhigh")
      const table = JSON.parse(set.content[0]!.text)
      expect(table.review).toMatchObject({
        model: "valid",
        thinking: "xhigh",
        modelSource: "override",
        thinkingSource: "override",
      })
      expect(table.explore.modelSource).toBe("built-in")

      expect(workerToolsEnabled()).toBe(true)
      setWorkerSessionDefault("explore", { model: "not-the-sentinel" })
      expect(workerToolsEnabled()).toBe(true)
    } finally {
      state.models = original
    }
  })
})
