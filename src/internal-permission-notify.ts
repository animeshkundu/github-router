/**
 * The internal `internal-permission-notify` subcommand: a NON-BLOCKING
 * `PermissionRequest` hook for ai-or-die mobile mode.
 *
 * `PermissionRequest` fires exactly when Claude is about to show a permission
 * dialog — i.e. only when Claude itself would prompt (it already honors bypass
 * mode, allow rules, and safe-command classification). This hook mirrors that
 * dialog to the phone WITHOUT taking it over: it POSTs the structured decision
 * packet to ai-or-die and then ABSTAINS (exit 0, no stdout), so Claude's own
 * native prompt still renders in the terminal. The phone becomes a remote
 * keyboard for that same static prompt (ai-or-die injects the keystroke on tap);
 * the desktop can still answer natively. Deterministic, transparent, and with no
 * blocking/timeout/fail-open surface at all.
 *
 * Auth mirrors `internal-artifact-open`: AIORDIE_TOKEN is stripped from the child
 * env, so the launcher writes `.aiordie-artifact.json` in CLAUDE_CONFIG_DIR with
 * { baseUrl, token, sessionId, insecureTLS }. Without the session env or mirror
 * creds this hook stands down (prints nothing). It NEVER prints a decision — any
 * failure just means "no phone mirror", never a suppressed or denied prompt.
 *
 * Windows teardown safety: read stdin synchronously (`readFileSync(0)`) and exit
 * naturally via `process.exitCode = 0`; never hard `process.exit()`.
 */

import { defineCommand } from "citty"

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { buildDecisionPacketFromStdin, createDecisionHookHttp } from "./lib/decision-hook-policy"

/** Cap the POST so a slow/absent ai-or-die never delays Claude's native prompt. */
const NOTIFY_POST_TIMEOUT_MS = 2_000

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

export const internalPermissionNotify = defineCommand({
  meta: {
    name: "internal-permission-notify",
    description:
      "Internal: non-blocking ai-or-die PermissionRequest mirror. POSTs the decision packet and abstains so Claude's native prompt still shows.",
  },
  async run() {
    try {
      const raw = readStdin()
      // Runtime gate: only mirror inside an ai-or-die tab-backed session with creds.
      if ((process.env.AIORDIE_SESSION_ID ?? "").trim().length === 0) return
      const creds = readCreds()
      if (!creds) return

      // PermissionRequest firing IS the "Claude would prompt" signal, so ignore the
      // coarse permission_mode gate (which is only for the PreToolUse approximation).
      const built = buildDecisionPacketFromStdin(raw, process.cwd(), { ignorePermissionMode: true })
      if (built.action !== "intercept") return

      const http = createDecisionHookHttp(creds)
      const signal =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(NOTIFY_POST_TIMEOUT_MS)
          : undefined
      // Fire-and-forget: a failed/slow POST must never hold up or suppress the
      // native prompt, so swallow every error and abstain regardless.
      await http.createDecision(built.packet, { signal }).catch(() => {})
    } catch {
      /* abstain on any error — never suppress Claude's own prompt */
    }
    // ALWAYS abstain: exit 0 with NO stdout so Claude renders its native dialog.
    process.exitCode = 0
  },
})
