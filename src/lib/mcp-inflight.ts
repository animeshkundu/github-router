/**
 * Shared concurrency cap for MCP `tools/call` dispatches.
 *
 * Originally lived as a module-private counter inside
 * `src/routes/mcp/handler.ts`. Extracted because the worker-agent's
 * `peer_review` and `advisor` tools (which dispatch to peer-model
 * personas / the advisor responses endpoint from inside a worker
 * subagent loop) must participate in the same backpressure budget;
 * otherwise a single worker can fan out unboundedly to peers and
 * starve the operator's own `tools/list` callers.
 *
 * The counter is a single process-wide integer — no per-route
 * partitioning. Persona calls at the MCP boundary (handler.ts),
 * peer/advisor calls nested inside a worker (tools.ts), and any
 * future MCP-adjacent dispatcher all increment the same number.
 *
 * Cap = `MAX_INFLIGHT_TOOLS_CALL` (default 128, override with
 * `GH_ROUTER_MAX_INFLIGHT_TOOLS_CALL`). Raised from 32 to widen
 * parallelism for orchestration fan-out (decompose / run_workflow drive
 * many nested persona + worker dispatches); persona handlers hold no
 * shared mutable state, so the ceiling is about not starving operator
 * traffic / upstream rate limits, not correctness. Set the env to 512+
 * for heavier fan-out, or lower if Copilot starts returning 429s.
 * Justification + history live at the historical home
 * (`src/routes/mcp/handler.ts` comment block) and
 * `docs/research/peer-mcp-investigation.md` § "Concurrency cap
 * investigation".
 */

export const MAX_INFLIGHT_TOOLS_CALL = ((): number => {
  const raw = Number.parseInt(process.env.GH_ROUTER_MAX_INFLIGHT_TOOLS_CALL ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 128
})()

let inFlight = 0

/**
 * Acquire a slot if one is available. Returns a release function the
 * caller MUST invoke exactly once (typically from a `finally` block);
 * returns `null` if the cap is saturated. The release fn is idempotent
 * — calling it twice is a no-op so callers can release defensively
 * without worrying about double-decrementing the counter under unusual
 * unwind paths.
 *
 * Synchronous on purpose. Async semaphore acquisition would let callers
 * queue indefinitely; we want immediate "queue full" feedback so the
 * MCP client (or the model holding the nested tool call) can choose to
 * back off or retry.
 */
export function acquireInFlightSlot(): (() => void) | null {
  if (inFlight >= MAX_INFLIGHT_TOOLS_CALL) return null
  inFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight--
  }
}

/** Read-only peek for telemetry/tests. */
export function currentInFlight(): number {
  return inFlight
}

/** Test helper: reset to a clean baseline between cases. */
export function __resetInFlightForTests(): void {
  inFlight = 0
}
