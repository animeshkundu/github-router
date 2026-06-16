/**
 * The LIVE composition for `run_workflow`: assembles the real side-effecting
 * primitives (git worktrees via `createWorktree`, the worker engine via
 * `runWorkerAgent`, a cross-lab critic via `dispatchModelCall`, sealed-gate exec
 * via `liveExec`) into a kernel run. Validates the caller's inputs, pre-verifies
 * the IR, runs `executeWorkflow`, and ALWAYS cleans up every worktree it created.
 *
 * Imports `dispatchModelCall` from the MCP handler the same way `stand-in.ts` and
 * `decompose-live.ts` do (a proven, non-fatal module cycle), so this module is
 * NOT re-exported from `index.ts`. The kernel + runner + adapter logic it drives
 * is unit-tested with fakes; the genuinely-live composition is covered by the
 * gated E2E (`GH_ROUTER_RUN_ORCHESTRATION_E2E=1`).
 *
 * Accepted limitations (cross-lab review, recorded not hidden):
 *  - `workspace` is a caller-supplied absolute path. This matches the existing
 *    symmetric threat model of `worker_implement` (which already runs `bash` in a
 *    caller-supplied workspace); it is not a new capability. A non-repo path makes
 *    `createWorktree` throw, which the kernel treats as infra failure -> ship
 *    baseline, so a bogus path fails safe.
 *  - A sealed gate that needs installed deps (`tsc`/`eslint`/`bun test`) may not
 *    pass in a BARE git worktree (a worktree has no `node_modules`). That is
 *    floor-SAFE (the gate fails -> not-passed -> the baseline ships) but means the
 *    orchestration upside is unavailable on dep-bearing repos until the worktree
 *    provisions deps. A known follow-up, not a floor violation.
 *  - Worktrees are removed in `cleanup()` after the run; a process kill mid-run
 *    leaks them, but they reuse the worker-agent layout
 *    (`.git/worktrees/worker-worktrees/worker/<pid>-<uuid>`) so the existing
 *    age-sweep + boot-time sweep reclaim them regardless of this process.
 */

import { randomUUID } from "node:crypto"
import path from "node:path"

import { dispatchModelCall } from "~/routes/mcp/handler"
import { runWorkerAgent } from "~/lib/worker-agent/engine"
import { createWorktree } from "~/lib/worker-agent/worktree"
import type { Effort, PersonaSpec } from "~/lib/peer-mcp-personas"

import { resolveSealedGate, sealedGateIds } from "./gate-registry"
import { type WorkflowIR } from "./ir"
import { executeWorkflow, type KernelOutcome } from "./kernel"
import { liveExec } from "./live-exec"
import { makeRunner } from "./runner"
import { buildLiveRunner, type LiveRunnerPrimitives } from "./runner-live"
import { type TiePolicy } from "./select"
import { verifyWorkflowIR } from "./verify"

type Endpoint = PersonaSpec["endpoint"]

export interface RunWorkflowOpts {
  ir: unknown
  ask: string
  workspace: string
  gateId: string
  /** Floor-vs-upside tie-break; defaults to the conservative "strict". */
  tiePolicy?: TiePolicy
  maxRetries?: number
  signal?: AbortSignal
}

export type RunWorkflowResult =
  | { ok: false; error: string }
  | { ok: true; outcome: KernelOutcome }

const CRITIC_INSTRUCTIONS =
  "You are a cross-lab code reviewer. Review the diff for correctness, edge cases, "
  + "and security, and report concrete findings. Your verdict is advisory; the "
  + "executable gate is the authority."

/** Map an IR `checkerLab` to a concrete cross-lab critic. Unknown labs are
 *  skipped (the critic is advisory, so a missing lab never blocks). */
function labPersona(lab: string): { model: string; endpoint: Endpoint; effort: Effort } | undefined {
  switch (lab.toLowerCase()) {
    case "openai":
      return { model: "gpt-5.5", endpoint: "/v1/responses", effort: "high" }
    case "google":
      return { model: "gemini-3.1-pro-preview", endpoint: "/v1/chat/completions", effort: "high" }
    case "anthropic":
      return { model: "claude-opus-4-6", endpoint: "/v1/chat/completions", effort: "high" }
    default:
      return undefined
  }
}

export async function runWorkflowLive(opts: RunWorkflowOpts): Promise<RunWorkflowResult> {
  const ask = typeof opts.ask === "string" ? opts.ask.trim() : ""
  if (!ask) return { ok: false, error: "ask is required (a non-empty string)" }
  if (typeof opts.workspace !== "string" || !path.isAbsolute(opts.workspace)) {
    return { ok: false, error: "workspace must be an absolute path" }
  }
  const gate = resolveSealedGate(opts.gateId)
  if (!gate) {
    return { ok: false, error: `unknown gateId "${opts.gateId}"; known: ${[...sealedGateIds()].join(", ")}` }
  }
  if (!opts.ir || typeof opts.ir !== "object") {
    return { ok: false, error: "ir must be an object (a typed WorkflowIR)" }
  }
  const tiePolicy: TiePolicy = opts.tiePolicy === "superset" ? "superset" : "strict"
  // Clamp a caller-supplied retry count to a small server-side bound so an
  // adversarial IR cannot amplify subprocess/model cost. Undefined falls through
  // to the kernel default.
  const maxRetries =
    typeof opts.maxRetries === "number" && Number.isFinite(opts.maxRetries)
      ? Math.min(3, Math.max(0, Math.floor(opts.maxRetries)))
      : undefined

  // Constrain IR verification to the SELECTED gate, not all known gates: an IR
  // whose executable gates reference any other gate is rejected, so the gate the
  // kernel actually runs (the canonical, from opts.gateId) always equals the gate
  // the verified IR declares. Closes the "IR declares X, kernel runs Y" gap.
  const selectedGateIds = new Set([opts.gateId])

  // Pre-flight verify so a malformed IR fails fast with actionable violation
  // codes (the kernel re-verifies as defense in depth before executing).
  const verdict = verifyWorkflowIR(opts.ir as WorkflowIR, { knownGateIds: selectedGateIds })
  if (!verdict.ok) {
    return { ok: false, error: `IR failed verification: ${verdict.violations.map((v) => v.code).join(", ")}` }
  }

  const canonicalGateIds = new Set(gate.checks.map((c) => c.id))

  const prim: LiveRunnerPrimitives = {
    async createWorktree() {
      const h = await createWorktree(opts.workspace, { instanceUuid: randomUUID() })
      return { dir: h.dir, finalize: () => h.finalize(), remove: () => h.remove() }
    },
    async runWorker({ mode, prompt, workspace }) {
      const r = await runWorkerAgent({ mode, prompt, workspace, signal: opts.signal })
      return { text: r.text, isError: r.isError }
    },
    async runCritic({ checkerLab, prompt, artifact }) {
      const p = labPersona(checkerLab)
      if (!p) return
      await dispatchModelCall({
        model: p.model,
        endpoint: p.endpoint,
        instructions: CRITIC_INSTRUCTIONS,
        userText: `${prompt}\n\nArtifact under review:\n${artifact}`,
        effort: p.effort,
        signal: opts.signal,
      })
    },
    exec: liveExec,
  }

  const lr = buildLiveRunner({ gate, baseWorkspace: opts.workspace }, prim)
  const runner = makeRunner(lr.deps, {
    rawAsk: ask,
    baseWorkspace: opts.workspace,
    canonicalGate: { id: gate.id, checks: canonicalGateIds },
  })
  try {
    const outcome = await executeWorkflow(opts.ir as WorkflowIR, runner, {
      tiePolicy,
      canonicalGateIds,
      knownGateIds: selectedGateIds,
      maxRetries,
    })
    return { ok: true, outcome }
  } finally {
    await lr.cleanup()
  }
}
