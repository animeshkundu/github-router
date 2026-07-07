/**
 * The internal `internal-decision-hook` subcommand: invoked by a spawned Claude
 * Code session's `PreToolUse` hook for mobile-mode Channel 1 approvals.
 *
 * It blocks selected tool decisions (Bash/Write/Edit/ExitPlanMode) while a human
 * approves or rejects from ai-or-die on their phone, then returns Claude Code's
 * PreToolUse allow/deny JSON contract. Unknown tools allow by printing nothing.
 *
 * Auth mirrors `internal-artifact-open`: AIORDIE_TOKEN is stripped from the child
 * env, so the launcher writes `.aiordie-artifact.json` in CLAUDE_CONFIG_DIR with
 * { baseUrl, token, sessionId, insecureTLS }. If the session env or mirror creds
 * are absent, this hook stands down (prints nothing) so a bare Claude CLI is not
 * gated. Once creds are present for an interceptable tool, errors fail CLOSED.
 *
 * Windows teardown safety: read stdin synchronously (`readFileSync(0)`) and exit
 * naturally via `process.exitCode = 0`; never hard `process.exit()`.
 */

import { defineCommand } from "citty"

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import {
  DEFAULT_DECISION_HOOK_MAX_HUMAN_WAIT_MS,
  DEFAULT_DECISION_HOOK_POLL_TIMEOUT_MS,
  DEFAULT_DECISION_HOOK_SELF_DEADLINE_MS,
  DECISION_HOOK_CLAUDE_TIMEOUT_SEC,
  createDecisionHookHttp,
  decisionHookDenyOutput,
  runDecisionHookPolicy,
} from "./lib/decision-hook-policy"

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

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function hookSelfDeadlineMs(): number {
  // Never trust an env override to exceed the host ceiling. Claude's hook timeout
  // fails OPEN, so the self-deadline is clamped safely below the registered 7200s.
  const hostSafe = (DECISION_HOOK_CLAUDE_TIMEOUT_SEC - 60) * 1_000
  const requested = positiveEnvMs(
    "GH_ROUTER_DECISION_HOOK_SELF_DEADLINE_MS",
    DEFAULT_DECISION_HOOK_SELF_DEADLINE_MS,
  )
  return Math.min(requested, hostSafe)
}

export const internalDecisionHook = defineCommand({
  meta: {
    name: "internal-decision-hook",
    description:
      "Internal: blocking ai-or-die mobile approval PreToolUse hook for Bash/Write/Edit/ExitPlanMode.",
  },
  async run() {
    let credsPresent = false
    try {
      const raw = readStdin()
      // Runtime gate mirrors the launcher gate: only activate inside an ai-or-die
      // tab-backed session. Without this env (or without mirror creds below), do
      // not interfere with a normal/bare Claude CLI.
      if ((process.env.AIORDIE_SESSION_ID ?? "").trim().length === 0) return

      const creds = readCreds()
      if (!creds) return
      credsPresent = true

      const result = await runDecisionHookPolicy({
        stdin: raw,
        http: createDecisionHookHttp(creds),
        fallbackCwd: process.cwd(),
        maxHumanWaitMs: positiveEnvMs(
          "GH_ROUTER_DECISION_HOOK_MAX_HUMAN_WAIT_MS",
          DEFAULT_DECISION_HOOK_MAX_HUMAN_WAIT_MS,
        ),
        hardDeadlineMs: hookSelfDeadlineMs(),
        pollTimeoutMs: positiveEnvMs(
          "GH_ROUTER_DECISION_HOOK_POLL_TIMEOUT_MS",
          DEFAULT_DECISION_HOOK_POLL_TIMEOUT_MS,
        ),
      })
      if (result.output) process.stdout.write(result.output)
    } catch {
      // If mobile-mode creds were active, fail CLOSED on unexpected hook errors.
      // Before creds, stand down to avoid wedging a bare CLI on local config issues.
      if (credsPresent) {
        try {
          process.stdout.write(decisionHookDenyOutput("mobile approval hook failed; denying fail-closed"))
        } catch {
          /* best effort only */
        }
      }
    }
    process.exitCode = 0
  },
})
