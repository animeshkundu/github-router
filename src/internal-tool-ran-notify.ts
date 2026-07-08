/**
 * The internal `internal-tool-ran-notify` subcommand: a NON-BLOCKING `PostToolUse`
 * hook for ai-or-die mobile mode.
 *
 * When a gated tool (Bash/Write/Edit/ExitPlanMode) actually RUNS, the human has
 * approved it — either by tapping the phone card (which ai-or-die already resolved)
 * or by answering Claude's native prompt directly on the desktop. This hook fires
 * on that run and tells ai-or-die to clear any still-pending decision for the
 * session, so a mirrored card on another surface dismisses instead of lingering
 * (and so it does not resurface on a later /decisions poll). Deny leaves the tool
 * un-run, so no PostToolUse fires there — that path falls back to the decision TTL.
 *
 * Fire-and-forget and ALWAYS abstains (exit 0, no stdout): a failed/slow POST must
 * never affect the tool result. Gated on AIORDIE_SESSION_ID + mirror creds like
 * the other ai-or-die hooks; stands down (prints nothing) otherwise.
 *
 * Windows teardown safety: read stdin synchronously (`readFileSync(0)`) and exit
 * naturally via `process.exitCode = 0`; never hard `process.exit()`.
 */

import { defineCommand } from "citty"

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { createDecisionHookHttp } from "./lib/decision-hook-policy"

/** Cap the POST so a slow/absent ai-or-die never delays the tool pipeline. */
const RESOLVE_POST_TIMEOUT_MS = 2_000

interface DecisionCreds {
  baseUrl: string
  token: string
  sessionId: string
  insecureTLS: boolean
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function credsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude")
  return path.join(dir, ".aiordie-artifact.json")
}

function readCreds(): DecisionCreds | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credsPath(), "utf8")) as Partial<DecisionCreds>
    if (!parsed.baseUrl || !parsed.token || !parsed.sessionId) return undefined
    return {
      baseUrl: parsed.baseUrl,
      token: parsed.token,
      sessionId: parsed.sessionId,
      insecureTLS: parsed.insecureTLS === true,
    }
  } catch {
    return undefined
  }
}

export const internalToolRanNotify = defineCommand({
  meta: {
    name: "internal-tool-ran-notify",
    description:
      "Internal: non-blocking ai-or-die PostToolUse signal that a gated tool ran, so a mirrored mobile decision card dismisses.",
  },
  async run() {
    try {
      readStdin() // drain stdin (Windows teardown safety); content is unused.
      if ((process.env.AIORDIE_SESSION_ID ?? "").trim().length === 0) return
      const creds = readCreds()
      if (!creds) return

      const http = createDecisionHookHttp(creds)
      const signal =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(RESOLVE_POST_TIMEOUT_MS)
          : undefined
      await http.resolveSession({ signal }).catch(() => {})
    } catch {
      /* abstain on any error — never affect the tool result */
    }
    process.exitCode = 0
  },
})
