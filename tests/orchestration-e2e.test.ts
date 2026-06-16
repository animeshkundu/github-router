/**
 * GATED end-to-end verification of the LIVE orchestration paths (real Copilot
 * models). Skipped unless `GH_ROUTER_RUN_ORCHESTRATION_E2E=1` — the same pattern
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
})
