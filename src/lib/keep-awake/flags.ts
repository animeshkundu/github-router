/**
 * Env-flag parsing for the Windows keep-awake feature. Pure +
 * unit-testable (no spawn, no platform branch — the platform gate lives
 * in `keepAwakeEnabled()`).
 */

import process from "node:process"

import { parseBoolEnv } from "../exec"

/**
 * True unless the operator opted out via `GH_ROUTER_DISABLE_KEEP_AWAKE`.
 * Keep-awake is ON BY DEFAULT (the win32-only platform gate is applied
 * separately in `keepAwakeEnabled()`). Mirrors the colbert opt-out idiom
 * (`parseBoolEnv(...) !== true`) so on/off semantics don't drift.
 */
export function keepAwakeOptedIn(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_DISABLE_KEEP_AWAKE) !== true
}

/**
 * True iff the operator opted IN to keeping the DISPLAY awake too via
 * `GH_ROUTER_KEEP_DISPLAY_ON=1`. Default OFF: the machine stays awake
 * (`ES_SYSTEM_REQUIRED`) but the panel is allowed to sleep.
 */
export function keepDisplayOn(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_KEEP_DISPLAY_ON) === true
}
