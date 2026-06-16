/**
 * GATED end-to-end verification of the LIVE orchestration paths (real Copilot
 * models). Skipped unless `GH_ROUTER_RUN_ORCHESTRATION_E2E=1`, the same pattern
 * as the browser E2E (`GH_ROUTER_RUN_BROWSER_E2E`), because it needs live model
 * auth (run `github-router auth` first) and is not deterministic enough for unit
 * CI. This is the "real verification" for the live decompose adapter; the pure
 * logic it sits on is covered by the fast unit suites.
 *
 *   GH_ROUTER_RUN_ORCHESTRATION_E2E=1 bun test tests/orchestration-e2e.test.ts
 */

import { describe, expect, test } from "bun:test"

import { decomposeWorkflow } from "../src/lib/orchestration"
import { buildLiveDecomposeDeps } from "../src/lib/orchestration/decompose-live"
import { runWorkflowLive } from "../src/lib/orchestration/run-workflow-live"
import { verifyWorkflowIR, type WorkflowIR } from "../src/lib/orchestration"

const RUN = process.env.GH_ROUTER_RUN_ORCHESTRATION_E2E === "1"
const maybe = RUN ? test : test.skip

const CATALOG =
  "roles: research, plan, implement, review, test, verify, baseline, selector, "
  + "integration. Gate kinds: executable, cross_lab, none."

describe("orchestration E2E (gated: GH_ROUTER_RUN_ORCHESTRATION_E2E=1)", () => {
  maybe(
    "decompose composes a VERIFIED workflow IR for a real ask",
    async () => {
      const deps = buildLiveDecomposeDeps({
        toolCatalog: CATALOG,
        critic: { model: "gemini-3.1-pro-preview", endpoint: "/v1/chat/completions", effort: "high" },
      })
      const result = await decomposeWorkflow(
        "Add a function `slugify(s: string): string` with unit tests.",
        deps,
        { maxRounds: 3 },
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        // The returned IR must independently re-verify clean (the kernel runs the
        // same check before executing it).
        expect(verifyWorkflowIR(result.ir as WorkflowIR).ok).toBe(true)
      }
    },
    180_000,
  )

  maybe(
    "run_workflow executes a minimal IR through the live kernel and delivers a champion",
    async () => {
      // A minimal baseline + implement + selector IR. The implement worker is told
      // to make a no-op so both branches pass the sealed gate; champion-retention
      // then delivers one of them. Uses the fast `typecheck-only` gate so the E2E
      // does not run the full suite per worktree.
      const ir: WorkflowIR = {
        rawAskHash: "h",
        acceptanceCriteriaHash: "ac",
        maxDepth: 1,
        nodes: [
          { id: "base", role: "baseline", inputs: [], gate: { kind: "executable", gateId: "typecheck-only" }, onFail: "baseline", producerLab: "anthropic" },
          { id: "impl", role: "implement", inputs: [], gate: { kind: "executable", gateId: "typecheck-only" }, onFail: "baseline", producerLab: "openai" },
          { id: "sel", role: "selector", inputs: ["base", "impl"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
        ],
      }
      const r = await runWorkflowLive({
        ir,
        ask: "Do not change any code. Confirm the repo type-checks as-is.",
        workspace: process.cwd(),
        gateId: "typecheck-only",
        tiePolicy: "strict",
        maxRetries: 0,
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        // A delivered or baseline outcome both mean the floor held; an escalation
        // would mean the baseline itself could not run (an infra problem).
        expect(["delivered", "baseline"]).toContain(r.outcome.status)
      }
    },
    600_000,
  )
})
