import fs from "node:fs/promises"
import path from "node:path"

import type { LaunchProfileId } from "./launch-profile"
import { MAX_PROFILE_MODELS } from "./max-profile-contract"
import { withOneMSuffix } from "./one-m-context"
import { state } from "./state"

export interface ModelPickerOption {
  model: string
  label: string
  behavesAs: string
}

interface DeclaredPickerModel {
  id: string
  label: string
  behavesAs: string
  neverOneM?: boolean
}

const STANDARD_PICKER_MODELS: ReadonlyArray<DeclaredPickerModel> = Object.freeze([
  // Claude Code 2.1.260 offers an unknown modelPicker row only when behavesAs
  // maps it onto a model the client knows. The selected id still goes out
  // unchanged. Map by the closest client-side capability/effort profile; the
  // request preprocessors remain authoritative for the actual upstream effort.
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", behavesAs: "claude-opus-5" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", behavesAs: "claude-opus-5" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", behavesAs: "claude-sonnet-5" },
  // Grok 4.6 currently serves a 500K total window. Keep this guard even if a
  // bad catalog fixture claims 1M: a process-global window override would then
  // over-budget the row and can follow a later runtime model switch.
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    behavesAs: "claude-sonnet-5",
    neverOneM: true,
  },
])

const MAX_PICKER_MODELS: ReadonlyArray<DeclaredPickerModel> = Object.freeze([
  { id: MAX_PROFILE_MODELS.sol, label: "GPT-5.6 Sol", behavesAs: "claude-opus-5" },
  { id: MAX_PROFILE_MODELS.luna, label: "GPT-5.6 Luna", behavesAs: "claude-opus-5" },
  { id: MAX_PROFILE_MODELS.gemini, label: "Gemini 3.8 Flash", behavesAs: "claude-sonnet-5" },
  { id: MAX_PROFILE_MODELS.opus, label: "Claude Opus 5", behavesAs: "claude-opus-5" },
])

/**
 * Return the ordered, profile-specific `/model` rows supported by the live
 * Copilot catalog. Fast intentionally shares Standard's four-row inventory;
 * Max replaces Grok with Opus because Grok is not an allowed Max lead.
 *
 * The `[1m]` suffix is Claude Code's local accounting marker and is never sent
 * upstream. `withOneMSuffix` attaches it only when the exact live entry serves
 * at least 1M and the user has not opted out. `behavesAs` is required by Claude
 * Code 2.1.260 to OFFER an otherwise-unknown modelPicker row. It supplies the
 * closest known client-side prompt/capability profile without changing the row
 * label or selected model id; the proxy's request preprocessors still enforce
 * each profile's actual model/effort contract.
 */
export function selectableModelsInCatalog(
  profile: LaunchProfileId,
): ModelPickerOption[] {
  const catalog = state.models?.data
  if (!catalog || catalog.length === 0) return []

  const present = new Set(catalog.map((entry) => entry.id))
  const declared = profile === "max" ? MAX_PICKER_MODELS : STANDARD_PICKER_MODELS
  return declared
    .filter((entry) => present.has(entry.id))
    .map((entry) => ({
      model: entry.neverOneM ? entry.id : withOneMSuffix(entry.id),
      label: entry.label,
      behavesAs: entry.behavesAs,
    }))
}

const RENAME_RETRY_DELAYS_MS = [25, 75, 200] as const
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"])

async function renameSettingsWithRetry(temp: string, target: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rename(temp, target)
      return
    } catch (error) {
      lastError = error
      const retryable = RETRYABLE_RENAME_CODES.has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
      if (!retryable || attempt === RENAME_RETRY_DELAYS_MS.length) break
      await new Promise<void>((resolve) =>
        setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
      )
    }
  }
  await fs.rm(temp, { force: true }).catch(() => {})
  throw lastError
}

/**
 * Add router rows through Claude Code's supported `modelPicker` setting.
 *
 * The caller passes the per-launch mirror's settings.json path, never the
 * operator's real config. Existing `modelPicker` values are preserved wholesale
 * because Claude Code chooses one highest-precedence picker object rather than
 * merging picker rows across settings sources. Unrelated settings are retained.
 *
 * Missing files start as an empty object. Invalid JSON, non-object settings, and
 * transient read failures throw rather than risk clobbering user data; launch
 * callers catch and warn. Writes use a same-directory temporary file, mode
 * 0o600, and bounded Windows rename retries so readers never observe torn JSON.
 */
export interface ModelPickerInjectionResult {
  written: boolean
  reason?: "user-set" | "no-models"
  /** Every model reachable through the effective mirror-level picker. The
   * launcher feeds these into its one launch-global compaction bound. */
  models: string[]
}

function modelIdsFromExistingPicker(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const options = (value as { options?: unknown }).options
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return []
    const model = (option as { model?: unknown }).model
    return typeof model === "string" && model.trim() !== "" ? [model] : []
  })
}

export async function injectModelPickerSettingsFile(
  settingsPath: string,
  profile: LaunchProfileId,
): Promise<ModelPickerInjectionResult> {
  const options = selectableModelsInCatalog(profile)

  let existing: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`,
      )
    }
    existing = parsed as Record<string, unknown>
  }

  if ("modelPicker" in existing) {
    return {
      written: false,
      reason: "user-set",
      models: modelIdsFromExistingPicker(existing.modelPicker),
    }
  }
  if (options.length === 0) {
    return { written: false, reason: "no-models", models: [] }
  }

  const merged = {
    ...existing,
    modelPicker: {
      options,
      replaceBuiltInOptions: false,
    },
  }
  const content = `${JSON.stringify(merged, null, 2)}\n`
  const temp = `${settingsPath}.${process.pid}.${Math.random().toString(36).slice(2)}.picker.tmp`
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  try {
    await fs.writeFile(temp, content, { mode: 0o600 })
    await renameSettingsWithRetry(temp, settingsPath)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return { written: true, models: options.map((option) => option.model) }
}
