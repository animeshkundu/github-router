// Native selection of the four non-Claude models through Claude Code's
// supported `modelPicker` settings surface. The settings writer itself is
// covered in model-picker-settings.test.ts; this suite pins the compatibility
// exports, env non-regression, and auto-compaction coupling.

import { afterEach, beforeEach, expect, test, describe } from "bun:test"

import { selectableModelsInCatalog } from "../src/lib/model-picker-settings"
import { getClaudeCodeEnvVars } from "../src/lib/server-setup"
import { state } from "../src/lib/state"

const standardRows = () => selectableModelsInCatalog("standard")

const SEED_TARGET_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gemini-3.8-flash",
  "grok-4.6",
] as const

function catalogModel(
  id: string,
  contextWindow?: number,
  promptWindow?: number,
  outputWindow?: number,
) {
  return {
    id,
    name: id,
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
      ...(contextWindow === undefined
        ? {}
        : {
            limits: {
              max_context_window_tokens: contextWindow,
              ...(promptWindow === undefined ? {} : { max_prompt_tokens: promptWindow }),
              ...(outputWindow === undefined ? {} : { max_output_tokens: outputWindow }),
            },
          }),
    },
    supported_endpoints: ["/responses"],
  }
}

function setCatalog(ids: ReadonlyArray<string>) {
  state.models = { object: "list", data: ids.map((id) => catalogModel(id)) as never }
}

/** Catalog whose entries advertise a real context window, so the `[1m]`
 *  decoration in `selectableModelsInCatalog` has something to gate on. */
function setCatalogWithWindows(entries: Record<string, number>) {
  state.models = {
    object: "list",
    data: Object.entries(entries).map(([id, ctx]) =>
      catalogModel(id, ctx, id === "gpt-5.6-luna" ? 922_000 : 900_000, 128_000)) as never,
  }
}

/** The live windows: three of the four targets are 1M-class; `grok-4.6`'s
 *  live window is 500K total (372K max prompt) and is deliberately NEVER
 *  decorated regardless of what a catalog fixture claims here. */
const LIVE_WINDOWS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gemini-3.8-flash": 1_000_000,
  "grok-4.6": 500_000,
}

let savedModels: typeof state.models
const TOUCHED_ENV = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedModels = state.models
  savedEnv = {}
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  state.models = savedModels
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe("selectableModelsInCatalog standard rows", () => {
  test("returns [] when the catalog is empty / unset", () => {
    state.models = undefined
    expect(standardRows()).toEqual([])
    state.models = { object: "list", data: [] as never }
    expect(standardRows()).toEqual([])
  })

  test("returns only the target models present in the catalog (graceful per-tier gating)", () => {
    // Simulate a lower tier where only gpt-5.6-luna is licensed.
    setCatalog(["claude-opus-4.8", "gpt-5.6-luna"])
    const got = standardRows()
    expect(got.map((m) => m.model)).toEqual(["gpt-5.6-luna"])
    expect(got[0].label).toBe("GPT-5.6 Luna")
  })

  test("returns exactly the four rows, in order, when all are catalogued", () => {
    setCatalog([...SEED_TARGET_IDS, "claude-opus-4.8"])
    const ids = standardRows().map((m) => m.model)
    expect(ids).toEqual([...SEED_TARGET_IDS])
  })

  test("no dynamic fifth row: an unrelated Gemini pro-preview model does not appear", () => {
    // The earlier design dynamically appended a Gemini review row
    // (gemini-3.1-pro-preview preferred, gemini-3.8-flash fallback). That
    // mechanism is retired — gemini-3.8-flash is now a first-class static
    // row on its own, and gemini-3.1-pro-preview is simply not on the list
    // at all, present in the catalog or not.
    setCatalog([...SEED_TARGET_IDS, "gemini-3.1-pro-preview"])
    const ids = standardRows().map((m) => m.model)
    expect(ids).toEqual([...SEED_TARGET_IDS])
    expect(ids).not.toContain("gemini-3.1-pro-preview")
  })
})

// Claude Code budgets a modelPicker row off the model id, and its 1M detector
// (`/\[1m\]/i`) has no vendor gate. Without the suffix a 1,050,000-token model
// is accounted at the 200K default and auto-compacts at roughly a fifth of its
// real window.
describe("selectableModelsInCatalog — [1m] context accounting", () => {
  test("brackets only the ids whose catalog window is >=1M, and NEVER grok-4.6", () => {
    setCatalogWithWindows(LIVE_WINDOWS)
    expect(standardRows().map((m) => m.model)).toEqual([
      "gpt-5.6-sol[1m]",
      "gpt-5.6-luna[1m]",
      "gemini-3.8-flash[1m]",
      // 500K total / 372K max-prompt — deliberately bare, and deliberately
      // never decorated even if the catalog advertised >=1M for it (see the
      // next test).
      "grok-4.6",
    ])
  })

  test("grok-4.6 stays bare even when its catalog window is (hypothetically) >=1M", () => {
    setCatalogWithWindows({ ...LIVE_WINDOWS, "grok-4.6": 1_000_000 })
    const grokRow = standardRows().find((m) =>
      m.model.startsWith("grok-4.6"),
    )
    expect(grokRow?.model).toBe("grok-4.6")
  })

  test("leaves labels undecorated", () => {
    setCatalogWithWindows(LIVE_WINDOWS)
    const got = standardRows()
    expect(got.map((m) => m.label)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.6 Luna",
      "Gemini 3.8 Flash",
      "Grok 4.6",
    ])
  })

  test("a catalog entry with no advertised window stays bare", () => {
    // `setCatalog` builds entries without `capabilities.limits`.
    setCatalog([...SEED_TARGET_IDS])
    expect(standardRows().map((m) => m.model)).toEqual([
      ...SEED_TARGET_IDS,
    ])
  })

  test("a window just under 1M stays bare (threshold is inclusive at 1M)", () => {
    setCatalogWithWindows({ "gpt-5.6-luna": 999_999, "gpt-5.6-sol": 1_000_000 })
    expect(standardRows().map((m) => m.model)).toEqual([
      "gpt-5.6-sol[1m]",
      "gpt-5.6-luna",
    ])
  })

  test("CLAUDE_CODE_DISABLE_1M_CONTEXT suppresses every bracket", () => {
    setCatalogWithWindows(LIVE_WINDOWS)
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"
    expect(standardRows().map((m) => m.model)).toEqual([
      ...SEED_TARGET_IDS,
    ])
  })

  test("matches Claude Code's presence-based opt-out, where \"0\" also disables", () => {
    // Claude Code's own gate is a raw truthiness read of the env var, so the
    // string "0" disables 1M there. The decoration must agree with the
    // accounting in every case, so it matches the quirk rather than parsing.
    setCatalogWithWindows(LIVE_WINDOWS)
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "0"
    expect(standardRows().map((m) => m.model)).toEqual([
      ...SEED_TARGET_IDS,
    ])
  })

  test("an empty opt-out value is falsy on both sides, so brackets stay on", () => {
    setCatalogWithWindows(LIVE_WINDOWS)
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = ""
    expect(standardRows().map((m) => m.model)).toContain(
      "gpt-5.6-sol[1m]",
    )
  })
})

describe("getClaudeCodeEnvVars — native model selection compatibility", () => {
  test("never enables gateway discovery, whose 2.1.260 refresh drops non-Claude rows", () => {
    setCatalog([...SEED_TARGET_IDS])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")
  })

  test("modelPicker migration does not disturb tier defaults or the active model", () => {
    setCatalog([...SEED_TARGET_IDS])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787", "claude-opus-5[1m]")
    expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5")
    expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
    expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5")
    expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5")
    expect(vars.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]")
  })

  test("includes selectable picker rows in the launch-global compaction bound", () => {
    setCatalogWithWindows(LIVE_WINDOWS)
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("798000")
  })
})
