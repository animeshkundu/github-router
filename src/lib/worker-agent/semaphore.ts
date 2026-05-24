/**
 * Worker concurrency semaphore.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Concurrency"
 * section).
 *
 * Defaults to 8 concurrent worker calls (equal to the global
 * `MAX_INFLIGHT_TOOLS_CALL` cap). The fast-path design is deliberate:
 * we DO NOT queue. If the cap is full when `acquireWorkerSlot` is
 * called, we return `null` immediately and the engine surfaces a
 * "Worker queue full" error to the caller. Queuing would let workers
 * pile up behind a deadline they can't meet (the MCP `/mcp` channel
 * has its own SSE heartbeats keeping long calls alive, but the gateway
 * still has soft caps); fast-fail keeps the caller informed.
 *
 * Acquire and release are pure synchronous counter mutations — no
 * async work. The `async` shape exists only because the future
 * "respect AbortSignal" path is asynchronous; today the signal is
 * checked once before the increment so an aborted call doesn't
 * occupy a slot.
 *
 * Test helpers `__resetForTests` and `__getInFlightForTests` are
 * exported so unit tests can assert the counter behaviour without
 * needing to spin up the engine.
 */

export const MAX_INFLIGHT_WORKER_CALLS = (() => {
  const raw = process.env.GH_ROUTER_WORKER_MAX_INFLIGHT
  if (!raw) return 8
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 8
  return n
})()

let inFlight = 0

/**
 * Acquire a worker slot.
 *
 * Returns a `release` function on success — call it exactly once when
 * the worker is done (engine wraps this in a `finally`). Returns
 * `null` when:
 *
 *   - the cap is already full (fast-fail, NO queuing); OR
 *   - the signal aborts before we get a chance to count (the engine
 *     bails to "aborted" before entering the agent loop).
 *
 * The `release` function is idempotent — calling it twice is a no-op
 * (defensive against finally-block double-fires; we don't want the
 * counter to drift negative).
 */
export async function acquireWorkerSlot(
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  if (signal?.aborted) return null
  if (inFlight >= MAX_INFLIGHT_WORKER_CALLS) return null

  inFlight += 1
  let released = false
  return () => {
    if (released) return
    released = true
    // Defensive clamp so a buggy double-release path can't drive the
    // counter negative and falsely admit slots.
    inFlight = Math.max(0, inFlight - 1)
  }
}

/**
 * Test-only: reset the in-flight counter to 0 between tests so cross-
 * file ordering can't bleed state. Matches the pattern in
 * `src/routes/mcp/handler.ts:__resetInFlightForTests`.
 */
export function __resetForTests(): void {
  inFlight = 0
}

/**
 * Test-only: observe the current in-flight counter without mutating
 * it. Useful for "did the release fn actually run?" assertions.
 */
export function __getInFlightForTests(): number {
  return inFlight
}
