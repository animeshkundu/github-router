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
 * Plan: the EXACT plan for THIS session comes from the ExitPlanMode payload —
 * `tool_input.planFilePath` (per-session; never the globally-newest file in the
 * shared plans dir) with `tool_input.plan` as the markdown fallback. The plan
 * markdown is rendered to a self-contained styled HTML file (HTML is the
 * canonical artifact, lavish's model — formatted + annotatable, not raw md), and
 * THAT `.html` is opened.
 *
 * Side-effect only: never writes stdout, never throws, always exits 0. Skips
 * subagent payloads (agent_id/agent_type) like the other hooks.
 */

import { defineCommand } from "citty"

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { ArtifactClient } from "./lib/artifact/client"
import { renderPlanHtml } from "./lib/artifact/plan-html"
import { isSubagentContext } from "./lib/orchestration/stop-gate-policy"

interface ArtifactCreds {
  baseUrl: string
  token: string
  sessionId: string
  insecureTLS: boolean
}

interface ExitPlanPayload {
  planFilePath?: string
  planMarkdown?: string
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

function isSubagent(payload: unknown): boolean {
  try {
    return isSubagentContext(payload as Parameters<typeof isSubagentContext>[0])
  } catch {
    return false
  }
}

/** Pull the per-session plan path + markdown content out of the hook payload. */
export function parseExitPlanPayload(raw: string): ExitPlanPayload {
  try {
    const obj = JSON.parse(raw) as { tool_input?: { planFilePath?: unknown; plan?: unknown } }
    const ti = obj.tool_input ?? {}
    const planFilePath = typeof ti.planFilePath === "string" && ti.planFilePath.trim() ? ti.planFilePath : undefined
    const planMarkdown = typeof ti.plan === "string" && ti.plan.trim() ? ti.plan : undefined
    return { planFilePath, planMarkdown }
  } catch {
    return {}
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

/**
 * Resolve the plan markdown + a title, preferring the file at `planFilePath`
 * (the source of truth, may be newer than the payload's snapshot), falling back
 * to the inline `tool_input.plan` content.
 */
function resolvePlanMarkdown(p: ExitPlanPayload): { markdown: string; title: string; nearPath?: string } | undefined {
  if (p.planFilePath) {
    try {
      const md = readFileSync(p.planFilePath, "utf8")
      if (md.trim()) return { markdown: md, title: path.basename(p.planFilePath, path.extname(p.planFilePath)), nearPath: p.planFilePath }
    } catch {
      /* fall through to inline content */
    }
  }
  if (p.planMarkdown) return { markdown: p.planMarkdown, title: "Plan" }
  return undefined
}

/**
 * Write the rendered HTML next to the plan (an allowed root) when we have a real
 * path, else into the plans dir under CLAUDE_CONFIG_DIR. Returns the realpath of
 * the written `.html`, or undefined on failure.
 */
function writePlanHtml(html: string, nearPath: string | undefined): string | undefined {
  let target: string
  if (nearPath) {
    // `<plan>.md` -> `<plan>.aiordie.html` (or append when there is no .md ext).
    const base = nearPath.replace(/\.(md|markdown)$/i, "")
    target = `${base}.aiordie.html`
  } else {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "plans")
    target = path.join(dir, `aiordie-plan-${process.pid}.html`)
  }
  try {
    writeFileSync(target, html, "utf8")
    try {
      return realpathSync.native(target)
    } catch {
      return target
    }
  } catch {
    return undefined
  }
}

export const internalArtifactOpen = defineCommand({
  meta: { name: "internal-artifact-open", description: "Open the finalized plan in the ai-or-die panel" },
  async run() {
    try {
      const raw = readStdin()
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = undefined
      }
      if (isSubagent(payload)) return
      const creds = readCreds()
      if (!creds) return
      const plan = resolvePlanMarkdown(parseExitPlanPayload(raw))
      if (!plan) return
      const htmlPath = writePlanHtml(renderPlanHtml(plan.markdown, plan.title), plan.nearPath)
      if (!htmlPath) return
      const client = new ArtifactClient(creds)
      await client.open(htmlPath)
    } catch {
      /* side-effect only: never block, never throw */
    }
  },
})
