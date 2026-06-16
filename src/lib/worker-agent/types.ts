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
   *  - `"explore"`: read/glob/grep/code_search/web_search/fetch_url (read-only)
   *  - `"review"`: identical read-only tool surface to `"explore"`, but the
   *    system prompt frames the worker as a code reviewer that verifies
   *    correctness against the actual code rather than summarizing.
   *  - `"plan"`: identical read-only tool surface to `"explore"`, but the
   *    system prompt frames the worker as an implementation planner.
   *  - `"implement"`: explore tools plus edit/write/bash + codex_review.
   *  - `"test"`: identical read+write tool surface to `"implement"`, but the
   *    system prompt frames the worker as an independent test author.
   *  - `"browse"`: the browser-control tool surface (`buildBrowseTools`) —
   *    drives a real Chrome/Edge tab via the browser-MCP bridge. Does NOT
   *    touch the filesystem; `workspace` is irrelevant (defaulted to cwd by
   *    the engine purely so canonicalization stays happy) and `worktree` is
   *    ignored (worktrees stay implement/test-only).
   */
  mode: "explore" | "review" | "plan" | "implement" | "test" | "browse"
  /**
   * Absolute path to the workspace (real, realpath-canonicalized). Required
   * in practice for the filesystem modes (`explore`/`review`/`implement`);
   * OPTIONAL for `browse`, which ignores it — the engine defaults an omitted
   * `browse` workspace to `process.cwd()`. The MCP handler may therefore omit
   * it for browse calls.
   */
  workspace?: string
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
   * `false`/omitted, edit the workspace in place. Ignored for `browse`
   * (which never provisions a worktree).
   */
  worktree?: boolean
  /**
   * Browse-only. The browse-session id (from the browser-MCP session
   * registry) the browse tools scope their tab ownership to. Threaded into
   * `buildBrowseTools`; ignored by the other modes.
   */
  sessionId?: string
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
 *   - maxWallClockMs: 30 * 60_000 (30 min, sized under the 35-min MCP timeout)
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
  /** Absolute cap on total tool calls per run (fan-out bound). */
  maxToolCalls: number
  /**
   * Max CONSECUTIVE identical tool calls (same name + args) before the next
   * identical one is blocked — the duplicate-read / anti-loop guard that
   * curbs the heavy-DOM re-read burn without halting the run.
   */
  maxRepeatedCalls: number
}
