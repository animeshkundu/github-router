/**
 * Claude Code `statusLine` injection for the per-session AIC total + rich
 * default session line.
 *
 * `github-router claude` writes `{ statusLine: { type: "command", command } }`
 * into the mirrored settings.json so the status bar shows
 * `[AIC 12.42] [####------] 42% | model | dir (branch) | ...`,
 * updating as the ledger file grows. The command itself
 * (`internal-aic-status`) reads the ledger path from `GH_ROUTER_AIC_LEDGER`
 * in the spawned child's env — never a path baked into settings — so the
 * same mirror mechanics work for concurrent launches. AIC is pinned: it
 * renders even when the terminal is too narrow for any other segment.
 *
 * Standard launches use wrap-don't-clobber: when the user's own config
 * already defines `statusLine` as a `{type:"command", command:string}`
 * shape, that command is preserved via `GH_ROUTER_AIC_USER_STATUSLINE`
 * (set by the caller from the returned `userCommand`) and the hook
 * composes one line: `[AIC x.xx] <user line>`. Any other pre-existing
 * `statusLine` shape is left untouched (`reason: "unrecognized"`) rather
 * than risk breaking an exotic config.
 *
 * Pinned launches (fast/cheap/cheap1m/cheapest, `routerWins: true`) run
 * router-provided surfaces only: ANY pre-existing `statusLine` is backed
 * up to a mirror sidecar and replaced with ours (`mode: "forced"`), so the
 * native rich line always renders and the user command never executes.
 *
 * Failure model matches the sibling settings writers: a transient read error
 * or a non-object settings.json throws (never clobber a file we don't
 * understand); the caller wraps this in warn-and-continue so a settings-write
 * hiccup never blocks launch. Writes use a same-directory temp file, mode
 * 0o600, then rename.
 */

import fs from "node:fs/promises"

import type { SelfInvocation } from "./hook-launcher/self-invocation"
import { buildSelfCommand } from "./hook-launcher/self-invocation"

/** Env var carrying the ledger snapshot path into the spawned child. */
export const AIC_LEDGER_ENV = "GH_ROUTER_AIC_LEDGER"
/** Env var carrying the user's own statusLine command (wrap mode only). */
export const AIC_USER_STATUSLINE_ENV = "GH_ROUTER_AIC_USER_STATUSLINE"
/** Opt-out for the whole injection (mirrors GH_ROUTER_DISABLE_NO_ATTRIBUTION). */
export const AIC_STATUSLINE_DISABLE_ENV = "GH_ROUTER_DISABLE_AIC_STATUSLINE"

export function buildAicStatusHookCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-aic-status")
}

export type AicStatuslineInjectionResult =
  | { written: true; mode: "injected" | "wrapped" | "forced"; userCommand?: string; hadPrevious?: boolean }
  | { written: false; reason: "already-set" | "unrecognized" }

function isCommandStatusLine(value: unknown): value is {
  type: string
  command: string
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.type === "command"
    && typeof record.command === "string"
    && record.command.length > 0
  )
}

export async function injectAicStatusLineIntoSettingsFile(
  settingsPath: string,
  statusCommand: string,
  opts: { routerWins?: boolean } = {},
): Promise<AicStatuslineInjectionResult> {
  let existing: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (err) {
    // Never clobber on a transient read error; a missing file starts clean.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    raw = undefined
  }
  if (raw !== undefined) {
    // A parse failure means a real file we don't understand: do NOT replace it.
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    } else {
      throw new Error(
        `settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`,
      )
    }
  }

  const current = existing.statusLine
  if (current !== undefined) {
    // Idempotency: a previous injection already points at our hook.
    if (
      isCommandStatusLine(current)
      && current.command.includes("internal-aic-status")
    ) {
      return { written: false, reason: "already-set" }
    }
    // Pinned profiles run the router line only: back up whatever was
    // there (command or exotic shape) to a mirror sidecar for audit and
    // replace it. The user command is recorded but never executed.
    if (opts.routerWins) {
      const hadPrevious = true
      const merged = {
        ...existing,
        statusLine: { type: "command", command: statusCommand },
      }
      await writeSettingsAtomically(settingsPath, merged)
      await writeBackupSidecar(settingsPath, current)
      return { written: true, mode: "forced", hadPrevious }
    }
    // Wrap-don't-clobber: preserve the user's command via env.
    if (isCommandStatusLine(current)) {
      const userCommand = current.command
      const merged = {
        ...existing,
        statusLine: { type: "command", command: statusCommand },
      }
      await writeSettingsAtomically(settingsPath, merged)
      return { written: true, mode: "wrapped", userCommand }
    }
    return { written: false, reason: "unrecognized" }
  }

  const merged = {
    ...existing,
    statusLine: { type: "command", command: statusCommand },
  }
  await writeSettingsAtomically(settingsPath, merged)
  return { written: true, mode: "injected" }
}

async function writeSettingsAtomically(
  settingsPath: string,
  merged: Record<string, unknown>,
): Promise<void> {
  const tmp = `${settingsPath}.${process.pid}.aicstatus.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
}

/**
 * Record a replaced `statusLine` value in a mirror sidecar for audit.
 * Mirror-only (same dir as the mirrored settings.json); the operator's
 * real settings are never touched. Best-effort: a backup failure must
 * not fail the injection that already succeeded.
 */
async function writeBackupSidecar(
  settingsPath: string,
  previous: unknown,
): Promise<void> {
  const backupPath = `${settingsPath}.aic-statusline-backup.json`
  const payload = { replacedStatusLine: previous }
  try {
    await fs.writeFile(backupPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Audit-only; the injection itself already landed.
  }
}
