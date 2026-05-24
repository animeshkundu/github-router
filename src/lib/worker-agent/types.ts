/**
 * Public types for the worker-agent module.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` (worker-agent section).
 *
 * These types are deliberately small and free of imports from the rest
 * of the worker-agent module so they can be referenced from the public
 * `runWorkerAgent` entrypoint and from MCP-handler glue without pulling
 * in budget/semaphore/path machinery.
 *
 * `ThinkingLevel` is re-exported from the vendored Pi `ai` slice so
 * downstream callers (e.g. `src/routes/mcp/handler.ts`) can type a
 * `thinking` parameter without depending directly on the vendor tree.
 *
 * Plain `ThinkingLevel` is `"minimal" | "low" | "medium" | "high" |
 * "xhigh"`. Worker callers (and `resolveModelAndThinking`) need to
 * express "drop the param entirely" — see the "no `reasoning_effort`
 * field at all" rule in the plan — so we also re-export Pi's
 * `ModelThinkingLevel` (`"off" | ThinkingLevel`) under the more
 * intuitive alias `WorkerThinkingLevel`.
 */

import type {
  ModelThinkingLevel,
  ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-ai"

/**
 * Pi's reasoning-effort enum, narrow (no `"off"`). Re-exported here so
 * MCP handler / engine code can reference it without importing the
 * vendor path alias directly.
 */
export type ThinkingLevel = PiThinkingLevel

/**
 * Worker-side reasoning-effort, which includes `"off"` for the "drop
 * the param entirely" case (model has no `reasoning_effort` capability).
 */
export type WorkerThinkingLevel = ModelThinkingLevel

export interface WorkerAgentOpts {
  /** The user/tool prompt handed to Pi as the first user message. */
  prompt: string
  /**
   * Tool surface:
   *  - `"explore"`: read/glob/grep/code_search/web_search/fetch_url/peer_review/advisor
   *  - `"implement"`: explore tools plus edit/write/bash.
   */
  mode: "explore" | "implement"
  /** Absolute path to the workspace (real, realpath-canonicalized). */
  workspace: string
  /**
   * Optional Copilot catalog model id. Validated and clamped by
   * `resolveModelAndThinking`. Defaults applied by the caller
   * (`engine.ts`) — `types.ts` deliberately doesn't bake the default.
   */
  model?: string
  /**
   * Optional reasoning depth. Same defaulting rule as `model`.
   */
  thinking?: WorkerThinkingLevel
  /**
   * Implement-only. When `true`, run the worker inside a fresh git
   * worktree and return the diff alongside the final text. When
   * `false`/omitted, edit the workspace in place.
   */
  worktree?: boolean
  /** Caller's AbortSignal — propagates through Pi via `agent.abort()`. */
  signal?: AbortSignal
}

export interface WorkerAgentResult {
  /**
   * The worker's final text. For worktree implement-mode this is Pi's
   * final assistant message followed by the unified diff (see plan).
   * For explore and direct implement-mode this is just Pi's text.
   */
  text: string
  /**
   * Set to `true` for non-recoverable failures (budget/semaphore/model
   * rejections, hard worktree errors, Pi mid-loop crashes). The MCP
   * layer mirrors this to its own `isError` field so the caller sees
   * the structured error path.
   */
  isError?: boolean
}

/**
 * Quality / speed / context-pollution caps. NOT cost-aware — the plan
 * explicitly drops token + dollar tracking because the proxy already
 * delegates Copilot billing.
 *
 * Defaults (applied by `class Budget`):
 *   - maxTurns: 500
 *   - maxWallClockMs: 30 * 60_000 (30 min)
 *   - maxToolBytes: 16 * 1024 * 1024 (16 MiB)
 *
 * Env overrides read at construction time:
 *   - GH_ROUTER_WORKER_MAX_TURNS
 *   - GH_ROUTER_WORKER_MAX_WALLCLOCK_MS
 *   - GH_ROUTER_WORKER_MAX_TOOL_BYTES
 */
export interface BudgetConfig {
  maxTurns: number
  maxWallClockMs: number
  maxToolBytes: number
}
