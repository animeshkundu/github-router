/**
 * The internal `internal-artifact-open` subcommand: invoked by a spawned Claude
 * Code session's `PostToolUse` hook (matcher `ExitPlanMode`), registered into the
 * mirrored settings.json by the launcher when running inside an ai-or-die tab
 * (`AIORDIE_SESSION_ID` set). It auto-opens the just-finalized plan in the
 * ai-or-die Artifact review panel so the human reviews it WITHOUT the model
 * having to call artifact_open itself.
 *
 * Auth: AIORDIE_TOKEN is stripped from the child env, so the token can't come via
 * env or argv (argv leaks to `ps`). The launcher writes a mode-600
 * `.aiordie-artifact.json` into CLAUDE_CONFIG_DIR; this hook reads it.
 *
 * Plan: the path isn't in the hook payload, so it opens the newest *.md in the
 * mirror's `plans/` dir (ExitPlanMode just fired → that is the active plan).
 *
 * Side-effect only: never writes stdout, never throws, always exits 0. Skips
 * subagent payloads (agent_id/agent_type) like the other hooks.
 */

import { defineCommand } from "citty"

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { ArtifactClient } from "./lib/artifact/client"
import { isSubagentContext } from "./lib/orchestration/stop-gate-policy"

interface ArtifactCreds {
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

function plansDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude")
  return path.join(dir, "plans")
}

function isSubagent(raw: string): boolean {
  try {
    return isSubagentContext(JSON.parse(raw) as Parameters<typeof isSubagentContext>[0])
  } catch {
    return false
  }
}

function readCreds(): ArtifactCreds | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credsPath(), "utf8")) as Partial<ArtifactCreds>
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

/** Newest *.md under the plans dir (the plan just finalized), realpath-resolved. */
function newestPlan(): string | undefined {
  try {
    const dir = plansDir()
    let best: string | undefined
    let bestMtime = -1
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const full = path.join(dir, name)
      try {
        const st = statSync(full)
        if (st.isFile() && st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs
          best = full
        }
      } catch {
        /* skip unreadable entry */
      }
    }
    if (!best) return undefined
    try {
      return realpathSync.native(best)
    } catch {
      return best
    }
  } catch {
    return undefined
  }
}

export const internalArtifactOpen = defineCommand({
  meta: { name: "internal-artifact-open", description: "Open the finalized plan in the ai-or-die panel" },
  async run() {
    try {
      if (isSubagent(readStdin())) return
      const creds = readCreds()
      if (!creds) return
      const plan = newestPlan()
      if (!plan) return
      const client = new ArtifactClient(creds)
      await client.open(plan)
    } catch {
      /* side-effect only: never block, never throw */
    }
  },
})
