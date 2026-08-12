/**
 * The internal `internal-plan-review` subcommand: a PostToolUse(ExitPlanMode)
 * hook that spawns a bounded advisory critic review when the main agent finalizes
 * a substantive plan.
 *
 * It never blocks ExitPlanMode: the hook process exits 0 quickly after deciding
 * whether to spawn a detached reviewer. The detached child calls a cross-lab plan
 * critic and writes material findings to the SAME per-session findings store used
 * by the Stop review, so the next UserPromptSubmit surfaces them with the existing
 * non-authoritative findings path.
 */

import { defineCommand } from "citty"

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"

import { PACKAGE_ROOT_FLAG, explicitPackageRoot } from "./lib/package-root"

import { hookMcpRuntimeFromEnv } from "./lib/orchestration/hook-mcp-client"
import {
  decidePlanReviewHook,
  filePlanReviewDebounce,
  runPlanReview,
  type PlanReviewSpawnContext,
} from "./lib/orchestration/plan-review-hook"
import { fileFindingsStore, stopReviewStateDir } from "./lib/orchestration/stop-gate-policy"

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

async function readDetachedPayload(): Promise<PlanReviewSpawnContext | undefined> {
  const payloadPath = (process.env.GH_ROUTER_PLAN_REVIEW_PAYLOAD ?? "").trim()
  if (payloadPath.length === 0) return undefined
  try {
    const raw = await fs.readFile(payloadPath, "utf8")
    await fs.unlink(payloadPath).catch(() => {})
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const p = parsed as Partial<PlanReviewSpawnContext>
    if (!p.sessionId || !p.cwd || !p.plan || !p.planHash) return undefined
    return { sessionId: p.sessionId, cwd: p.cwd, plan: p.plan, planHash: p.planHash }
  } catch {
    await fs.unlink(payloadPath).catch(() => {})
    return undefined
  }
}

function spawnDetachedPlanReview(ctx: PlanReviewSpawnContext): void {
  let payloadPath: string | undefined
  try {
    const dir = stopReviewStateDir()
    mkdirSync(dir, { recursive: true })
    payloadPath = path.join(dir, `plan-review-${process.pid}-${randomBytes(4).toString("hex")}.json`)
    writeFileSync(payloadPath, JSON.stringify(ctx), { mode: 0o600 })
    const scriptArgs = process.argv[1] && process.argv[1] !== process.execPath ? [process.argv[1]] : []
    const root = explicitPackageRoot()
    const packageRootArgs = root ? [PACKAGE_ROOT_FLAG, root] : []
    const child = spawn(process.execPath, [...scriptArgs, ...packageRootArgs, "internal-plan-review"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, GH_ROUTER_PLAN_REVIEW_PAYLOAD: payloadPath },
    })
    const orphan = payloadPath
    child.on("error", () => {
      if (orphan) {
        try {
          unlinkSync(orphan)
        } catch {
          /* best-effort */
        }
      }
    })
    child.unref()
  } catch {
    if (payloadPath) {
      try {
        unlinkSync(payloadPath)
      } catch {
        /* best-effort */
      }
    }
  }
}

export const internalPlanReview = defineCommand({
  meta: {
    name: "internal-plan-review",
    description:
      "Internal: advisory ExitPlanMode plan reviewer. Spawns a bounded detached critic review "
      + "for substantive plans and writes findings for the next prompt. Always exit 0.",
  },
  async run() {
    try {
      const runtime = hookMcpRuntimeFromEnv()
      if (!runtime) return

      const detached = await readDetachedPayload()
      if (detached) {
        await runPlanReview({
          runtime,
          sessionId: detached.sessionId,
          cwd: detached.cwd,
          plan: detached.plan,
          findingsStore: fileFindingsStore(stopReviewStateDir()),
        })
        return
      }

      const decision = await decidePlanReviewHook({
        stdin: readStdin(),
        runtimeAvailable: true,
        debounce: filePlanReviewDebounce(stopReviewStateDir()),
        fallbackCwd: process.cwd(),
      })
      if (decision.kind === "spawn") spawnDetachedPlanReview(decision)
    } catch {
      /* side-effect only: never block ExitPlanMode */
    }
    process.exitCode = 0
  },
})
