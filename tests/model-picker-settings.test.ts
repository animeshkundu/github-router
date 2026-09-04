import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  injectModelPickerSettingsFile,
  selectableModelsInCatalog,
} from "~/lib/model-picker-settings"
import type { LaunchProfileId } from "~/lib/launch-profile"
import { state } from "~/lib/state"

const STANDARD_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gemini-3.8-flash",
  "grok-4.6",
] as const
const MAX_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gemini-3.8-flash",
  "claude-opus-5",
] as const

function catalogModel(id: string, contextWindow?: number) {
  return {
    id,
    name: id,
    object: "model",
    vendor: id.startsWith("claude") ? "Anthropic" : "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
      ...(contextWindow === undefined
        ? {}
        : { limits: { max_context_window_tokens: contextWindow } }),
    },
  }
}

function setCatalog(entries: Record<string, number>): void {
  state.models = {
    object: "list",
    data: Object.entries(entries).map(([id, context]) =>
      catalogModel(id, context)) as never,
  }
}

const WINDOWS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gemini-3.8-flash": 1_000_000,
  "grok-4.6": 500_000,
  "claude-opus-5": 1_000_000,
}

let savedModels: typeof state.models
let savedDisable1M: string | undefined
let dir: string
let settingsPath: string

beforeEach(async () => {
  savedModels = state.models
  savedDisable1M = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-picker-"))
  settingsPath = path.join(dir, "settings.json")
})

afterEach(async () => {
  state.models = savedModels
  if (savedDisable1M === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = savedDisable1M
  await fs.rm(dir, { recursive: true, force: true })
})

function ids(profile: LaunchProfileId): string[] {
  return selectableModelsInCatalog(profile).map((row) => row.model)
}

describe("selectableModelsInCatalog", () => {
  test("gates rows on the live catalog and keeps Standard and Fast aligned", () => {
    setCatalog(WINDOWS)
    expect(ids("standard")).toEqual([
      "gpt-5.6-sol[1m]",
      "gpt-5.6-luna[1m]",
      "gemini-3.8-flash[1m]",
      "grok-4.6",
    ])
    expect(ids("fast")).toEqual(ids("standard"))
    expect(selectableModelsInCatalog("standard").map((row) => row.label)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.6 Luna",
      "Gemini 3.8 Flash",
      "Grok 4.6",
    ])

    setCatalog({ "gpt-5.6-luna": WINDOWS["gpt-5.6-luna"]! })
    expect(ids("standard")).toEqual(["gpt-5.6-luna[1m]"])
  })

  test("uses the exact Max lineup and excludes Grok from lead selection", () => {
    setCatalog(WINDOWS)
    expect(ids("max")).toEqual([
      "gpt-5.6-sol[1m]",
      "gpt-5.6-luna[1m]",
      "gemini-3.8-flash[1m]",
      "claude-opus-5[1m]",
    ])
    expect(ids("max")).not.toContain("grok-4.6")
  })

  test("returns rows in declared order, never appends unrelated catalog models", () => {
    setCatalog({
      "gemini-3.1-pro-preview": 1_000_000,
      ...WINDOWS,
      "gpt-5.5": 1_000_000,
    })
    expect(ids("standard").map((id) => id.replace(/\[1m\]$/i, ""))).toEqual([
      ...STANDARD_IDS,
    ])
    expect(ids("max").map((id) => id.replace(/\[1m\]$/i, ""))).toEqual([
      ...MAX_IDS,
    ])
  })

  test("matches the presence-based 1M opt-out and never decorates Grok", () => {
    setCatalog({ ...WINDOWS, "grok-4.6": 1_000_000 })
    expect(ids("standard")).toContain("grok-4.6")
    expect(ids("standard")).not.toContain("grok-4.6[1m]")

    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "0"
    expect(ids("standard")).toEqual([...STANDARD_IDS])
    expect(ids("max")).toEqual([...MAX_IDS])
  })
})

describe("injectModelPickerSettingsFile", () => {
  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>

  test("creates an additive curated picker with required capability mappings", async () => {
    setCatalog(WINDOWS)
    const result = await injectModelPickerSettingsFile(settingsPath, "standard")
    expect(result).toEqual({
      written: true,
      models: selectableModelsInCatalog("standard").map((option) => option.model),
    })
    const settings = await read()
    expect(settings.modelPicker).toEqual({
      options: selectableModelsInCatalog("standard"),
      replaceBuiltInOptions: false,
    })
    const options = (settings.modelPicker as { options: Array<Record<string, unknown>> }).options
    expect(options.map((option) => option.behavesAs)).toEqual([
      "claude-opus-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-5",
    ])
    for (const option of options) {
      expect(option).not.toHaveProperty("description")
    }
  })

  test("preserves unrelated settings and an existing user modelPicker wholesale", async () => {
    const userPicker = {
      options: [{ model: "my-gateway-model", label: "Mine", behavesAs: "sonnet" }],
      replaceBuiltInOptions: true,
    }
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: { Stop: [] }, modelPicker: userPicker }, null, 2))
    setCatalog(WINDOWS)
    const before = await fs.readFile(settingsPath, "utf8")
    expect(await injectModelPickerSettingsFile(settingsPath, "max")).toEqual({
      written: false,
      reason: "user-set",
      models: ["my-gateway-model"],
    })
    expect(await fs.readFile(settingsPath, "utf8")).toBe(before)
    expect((await read()).modelPicker).toEqual(userPicker)
  })

  test("does not write an empty picker when no profile rows are available", async () => {
    state.models = { object: "list", data: [] as never }
    expect(await injectModelPickerSettingsFile(settingsPath, "standard")).toEqual({
      written: false,
      reason: "no-models",
      models: [],
    })
    await expect(fs.stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("returns every valid model from a preserved user picker for compaction", async () => {
    const modelPicker = {
      options: [
        { model: "custom-low-ceiling[1m]", label: "Custom" },
        null,
        { model: "" },
        { label: "Missing model" },
        "not-an-option",
      ],
      replaceBuiltInOptions: true,
    }
    await fs.writeFile(settingsPath, JSON.stringify({ modelPicker }))
    state.models = { object: "list", data: [] as never }

    expect(await injectModelPickerSettingsFile(settingsPath, "standard")).toEqual({
      written: false,
      reason: "user-set",
      models: ["custom-low-ceiling[1m]"],
    })
  })

  test("preserves other keys, writes atomically, and is idempotent", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ model: "opus", hooks: { Stop: [] } }, null, 2))
    setCatalog(WINDOWS)
    expect((await injectModelPickerSettingsFile(settingsPath, "fast")).written).toBe(true)
    const first = await read()
    expect(first.model).toBe("opus")
    expect(first.hooks).toEqual({ Stop: [] })
    expect((await fs.readdir(dir)).sort()).toEqual(["settings.json"])

    const bytes = await fs.readFile(settingsPath, "utf8")
    expect(await injectModelPickerSettingsFile(settingsPath, "fast")).toEqual({
      written: false,
      reason: "user-set",
      models: selectableModelsInCatalog("fast").map((option) => option.model),
    })
    expect(await fs.readFile(settingsPath, "utf8")).toBe(bytes)
  })

  test("refuses invalid or non-object settings instead of clobbering them", async () => {
    for (const raw of ["{invalid", "[1,2,3]"]) {
      await fs.writeFile(settingsPath, raw)
      setCatalog(WINDOWS)
      await expect(injectModelPickerSettingsFile(settingsPath, "standard")).rejects.toThrow()
      expect(await fs.readFile(settingsPath, "utf8")).toBe(raw)
    }
  })
})
