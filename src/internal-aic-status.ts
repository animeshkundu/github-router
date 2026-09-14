/**
 * The internal `internal-aic-status` subcommand: the executable a spawned
 * Claude Code session's `statusLine` invokes (registered into the mirrored
 * settings.json by the launcher — see `src/lib/aic-statusline-settings.ts`).
 *
 * It reads this launch's AIC ledger snapshot (path via `GH_ROUTER_AIC_LEDGER`,
 * set in the spawned child's env) and prints a single-line status fragment:
 * `[AIC 12.42]`. When the user already had a `statusLine` command, its text
 * arrives via `GH_ROUTER_AIC_USER_STATUSLINE` and is run here so the output is
 * one composed line: `[AIC 12.42] <user line>`.
 *
 * Status-line contract: stdout is the rendered line (first line wins), fast
 * (<1s budget — the ledger file read is local; the user command gets a 5s
 * cap), and NEVER failing (any error → print whatever is available → exit 0).
 * Stdin (Claude Code's session JSON) is drained and ignored.
 */

import { defineCommand } from "citty"

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import {
  formatAicStatus,
  readAicSnapshotFile,
} from "./lib/aic-ledger"

/**
 * Read stdin synchronously and discard. Claude Code pipes session JSON to the
 * statusLine command; an unread pipe can SIGPIPE the writer on some platforms.
 */
function drainStdin(): void {
  try {
    if (process.stdin.isTTY) return
    readFileSync(0, "utf8")
  } catch {
    // Best-effort; the ledger read below does not depend on stdin.
  }
}

/**
 * Pure core: compose the status line from an AIC fragment and a user line.
 * Exported for unit tests.
 */
export function composeAicStatusLine(
  aicFragment: string,
  userLine: string,
): string {
  const aic = aicFragment.trim()
  const user = userLine.split("\n")[0]?.trim() ?? ""
  if (aic && user) return `${aic} ${user}`
  return aic || user
}

/**
 * Run the user's own statusLine command (from `GH_ROUTER_AIC_USER_STATUSLINE`),
 * returning its first stdout line or "" on any failure/timeout. Exported for
 * unit tests (command + timeout injectable).
 */
export function runUserStatusLine(
  command: string,
  timeoutMs = 5000,
): string {
  if (!command.trim()) return ""
  try {
    const result = spawnSync(command, {
      shell: true,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Inherit env so user scripts see the same session context they would
      // under their own statusLine (cwd included — spawnSync inherits it).
      env: process.env,
    })
    if (result.error) return ""
    const out = typeof result.stdout === "string" ? result.stdout : ""
    return out.split("\n")[0]?.trim() ?? ""
  } catch {
    return ""
  }
}

function readAicFragment(): string {
  try {
    const ledgerPath = process.env.GH_ROUTER_AIC_LEDGER
    if (!ledgerPath) return ""
    const snapshot = readAicSnapshotFile(ledgerPath)
    if (!snapshot) return ""
    return formatAicStatus(snapshot)
  } catch {
    return ""
  }
}

export const internalAicStatus = defineCommand({
  meta: {
    name: "internal-aic-status",
    description:
      "Internal: Claude Code statusLine handler printing this session's AIC total.",
  },
  async run() {
    drainStdin()
    const aic = readAicFragment()
    const userCommand = process.env.GH_ROUTER_AIC_USER_STATUSLINE ?? ""
    const userLine = userCommand ? runUserStatusLine(userCommand) : ""
    const line = composeAicStatusLine(aic, userLine)
    if (line) process.stdout.write(`${line}\n`)
    // Signal success WITHOUT tearing the loop down — same resolution as the
    // other internal hooks (see main.ts help-path comment): a hard
    // process.exit() can abort through a pipe on Windows.
    process.exitCode = 0
  },
})
