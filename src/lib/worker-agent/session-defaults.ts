import type { WorkerAgentOpts, WorkerThinkingLevel } from "./types"

export type WorkerMode = WorkerAgentOpts["mode"]

export interface WorkerSessionDefault {
  model?: string
  thinking?: WorkerThinkingLevel
}

const MODES: ReadonlyArray<WorkerMode> = Object.freeze([
  "explore",
  "review",
  "plan",
  "implement",
  "test",
  "browse",
])

/**
 * Process-global, in-memory overrides. They are intentionally not persisted.
 * In `serve` mode one process may serve multiple client sessions, so these
 * values are process-wide rather than isolated to an individual client.
 */
const overrides: Partial<Record<WorkerMode, WorkerSessionDefault>> = {}

export function getWorkerSessionDefault(mode: WorkerMode): WorkerSessionDefault {
  return { ...overrides[mode] }
}

export function setWorkerSessionDefault(
  mode: WorkerMode,
  value: WorkerSessionDefault,
): WorkerSessionDefault {
  const next = { ...overrides[mode] }
  if (value.model !== undefined) next.model = value.model
  if (value.thinking !== undefined) next.thinking = value.thinking
  overrides[mode] = next
  return { ...next }
}

export function resetWorkerSessionDefault(mode: WorkerMode): void {
  delete overrides[mode]
}

export function resetAllWorkerSessionDefaults(): void {
  for (const mode of MODES) delete overrides[mode]
}

export function snapshotWorkerSessionDefaults(): Record<WorkerMode, WorkerSessionDefault> {
  return Object.fromEntries(
    MODES.map((mode) => [mode, getWorkerSessionDefault(mode)]),
  ) as Record<WorkerMode, WorkerSessionDefault>
}

export const WORKER_MODES = MODES
