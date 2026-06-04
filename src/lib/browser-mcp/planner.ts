// planner.ts — fast-model fallback for compound-intent failures
// (Phase 3c). When a multi-step compound dispatched by browser_act
// fails partway, this module asks the compressor backend to RE-PLAN
// the remaining work given the page state at the failure point.
//
// Cost cap: ONE fast-model call per compound failure regardless of
// how many steps remain. The replanner returns the full revised step
// list; browser_act dispatches each replanned step through the same
// deterministic cascade (so the cascade still resolves the common
// case for each replanned step too).
//
// Why this isn't called on every step's failure individually: if a
// 5-step compound's step 3 fails and we replanned each remaining
// step, worst case is 5 fast-model calls for one user intent. The
// whole-compound-replan path is bounded at 1.

import { callCompressorPublic } from "./compressor"
import type { AtomicStep } from "./decompose"
import type { PageSnapshot, SnapshotElement } from "./snapshot-types"

export interface PlannerInput {
  /** Original lead-model intent that triggered the compound. */
  originalIntent: string
  /** Optional value the lead model passed alongside the intent. */
  originalValue?: string
  /** Atomic steps that completed successfully before the failure. */
  completedSteps: AtomicStep[]
  /** The step that failed. */
  failedStep: AtomicStep
  /** Error message from the failed step's dispatcher. */
  failureReason: string
  /** Page snapshot captured immediately after the failure. */
  snapshot: PageSnapshot
}

export interface PlannerResult {
  /** Replanned atomic steps to dispatch sequentially. Empty array
   * means "give up, surface the original error to the lead model." */
  steps: AtomicStep[]
  /** Short prose explanation of what the planner chose to do.
   * Surfaced in the final {ok, summary} envelope when replan succeeds. */
  reasoning: string
}

const PLANNER_SYSTEM = `You are a browser-automation replanner. A user issued a high-level intent that was decomposed into atomic steps. Several steps ran successfully, then one failed. You see the page state AFTER the failure and decide what to do next.

Your job: produce a revised list of atomic steps that will accomplish the original intent given the current page. If you cannot — the page has changed in a way that makes the intent impossible (login form vanished, navigation moved elsewhere, captcha appeared) — return an empty list and explain why in reasoning.

Each replanned step is a free-form natural-language intent ("the email input", "the Sign In button at the bottom of the form") plus an optional value for fill/type/select actions. Be SPECIFIC about element location ("at the bottom of the form", "in the top navigation") so the deterministic matcher cascade can resolve it without ambiguity. Do NOT reference element refs.

Cost rule: you get ONE call per compound failure. Make every step count.

Call the replan_compound tool with your answer.`

const PLANNER_TOOL = {
  name: "replan_compound",
  description: "Report the revised atomic steps to complete the original compound intent.",
  parameters: {
    type: "object",
    required: ["steps", "reasoning"],
    additionalProperties: false,
    properties: {
      steps: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["intent"],
          additionalProperties: false,
          properties: {
            intent: { type: "string" },
            value: { type: "string" },
          },
        },
      },
      reasoning: {
        type: "string",
        description: "1-2 sentence explanation of the replanning decision.",
      },
    },
  },
}

/**
 * Run the fast-model planner on a failed compound. Returns the
 * revised step list (may be empty if the planner gives up).
 *
 * The snapshot is trimmed before sending to keep the round-trip
 * small: only element role + name + brief value/placeholder if
 * present. Bbox / state flags / frame ids would just inflate tokens
 * without helping the natural-language replanner.
 */
export async function planCompoundReplan(
  input: PlannerInput,
  signal?: AbortSignal,
): Promise<PlannerResult> {
  const trimmed = input.snapshot.elements.slice(0, 80).map((e: SnapshotElement) => {
    const out: Record<string, unknown> = { role: e.role }
    if (e.name) out.name = e.name
    if (e.placeholder) out.placeholder = e.placeholder
    if (e.value) out.value = e.value
    return out
  })
  const userPayload = JSON.stringify({
    original_intent: input.originalIntent,
    original_value: input.originalValue,
    completed_steps: input.completedSteps.map((s) => ({
      intent: s.intent,
      ...(s.value !== undefined ? { value: s.value } : {}),
    })),
    failed_step: {
      intent: input.failedStep.intent,
      ...(input.failedStep.value !== undefined ? { value: input.failedStep.value } : {}),
    },
    failure_reason: input.failureReason,
    page_now: {
      url: input.snapshot.url ?? "",
      title: input.snapshot.title ?? "",
      visible_text: (input.snapshot.text ?? "").slice(0, 3000),
      actionable_elements: trimmed,
    },
  })
  const raw = await callCompressorPublic(PLANNER_SYSTEM, userPayload, PLANNER_TOOL, signal)
  if (!raw || typeof raw !== "object") {
    return { steps: [], reasoning: "planner returned empty response" }
  }
  const obj = raw as { steps?: unknown, reasoning?: unknown }
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : ""
  if (!Array.isArray(obj.steps)) return { steps: [], reasoning }
  const steps: AtomicStep[] = []
  for (const s of obj.steps.slice(0, 8)) {
    if (!s || typeof s !== "object") continue
    const intent = (s as { intent?: unknown }).intent
    const value = (s as { value?: unknown }).value
    if (typeof intent === "string" && intent.length > 0) {
      const step: AtomicStep = { intent }
      if (typeof value === "string") step.value = value
      steps.push(step)
    }
  }
  return { steps, reasoning }
}
