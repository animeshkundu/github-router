import { afterEach, describe, expect, mock, test } from "bun:test"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

const realRename = fsSync.promises.rename.bind(fsSync.promises)
let failuresRemaining = 0
let renameAttempts = 0

async function stubbedRename(from: fsSync.PathLike, to: fsSync.PathLike): Promise<void> {
  renameAttempts += 1
  if (failuresRemaining > 0) {
    failuresRemaining -= 1
    const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException
    error.code = "EPERM"
    throw error
  }
  await realRename(from, to)
}

mock.module("node:fs/promises", () => {
  const patched = { ...fsSync.promises, rename: stubbedRename }
  return { ...patched, default: patched }
})

const { injectModelPickerSettingsFile } = await import("~/lib/model-picker-settings")
const { state } = await import("~/lib/state")

const savedModels = state.models
const dirs: string[] = []

afterEach(async () => {
  state.models = savedModels
  failuresRemaining = 0
  for (;;) {
    const dir = dirs.pop()
    if (!dir) break
    await fsSync.promises.rm(dir, { recursive: true, force: true })
  }
})

function setCatalog(): void {
  state.models = {
    object: "list",
    data: [{
      id: "gpt-5.6-sol",
      capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    }] as never,
  }
}

async function target(): Promise<string> {
  const dir = await fsSync.promises.mkdtemp(path.join(os.tmpdir(), "picker-retry-"))
  dirs.push(dir)
  return path.join(dir, "settings.json")
}

describe("modelPicker settings rename retries", () => {
  test("recovers from transient Windows EPERM contention", async () => {
    setCatalog()
    const settingsPath = await target()
    failuresRemaining = 2
    renameAttempts = 0

    await injectModelPickerSettingsFile(settingsPath, "standard")

    expect(renameAttempts).toBe(3)
    const settings = JSON.parse(await fsSync.promises.readFile(settingsPath, "utf8"))
    expect(settings.modelPicker.options[0].model).toBe("gpt-5.6-sol[1m]")
  })

  test("persistent contention is bounded and leaves no temporary file", async () => {
    setCatalog()
    const settingsPath = await target()
    failuresRemaining = Number.MAX_SAFE_INTEGER
    renameAttempts = 0

    await expect(injectModelPickerSettingsFile(settingsPath, "standard")).rejects.toThrow(/EPERM/)
    expect(renameAttempts).toBe(4)
    const leftovers = (await fsSync.promises.readdir(path.dirname(settingsPath)))
      .filter((name) => name.includes(".picker.tmp"))
    expect(leftovers).toEqual([])
  })
})
