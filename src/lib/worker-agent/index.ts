/**
 * Public entry point for the worker-agent module.
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` — architecture diagram.
 *
 * Everything below is re-exported from sibling modules. Callers (the MCP
 * handler, integration tests, future CLI tooling) MUST import from
 * `~/lib/worker-agent` rather than reaching into the implementation files;
 * the deeper modules are free to refactor as long as this surface stays
 * stable.
 */

export { BROWSE_DEFAULT_MODEL, DEFAULT_MODEL, runWorkerAgent } from "./engine"
export type {
  BudgetConfig,
  ThinkingLevel,
  WorkerAgentOpts,
  WorkerAgentResult,
  WorkerThinkingLevel,
} from "./types"
