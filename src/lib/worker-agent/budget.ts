/**
 * Worker budget caps + WorkerAbort sentinel.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Safety +
 * observability" section, "Budget env-overrides" + "Halt messages"
 * bullets).
 *
 * Budget tracks three orthogonal axes:
 *   - turns: pathological-loop guard (default 500)
 *   - wall-clock: speed bound for the longest realistic task (30 min)
 *   - tool-bytes: cumulative tool-output bytes — context-pollution
 *     proxy. Token / cost tracking is intentionally NOT in scope
 *     (proxy doesn't bill, doesn't tokenize, and the model-side cost
 *     belongs to Copilot's quota).
 *
 * Halt messages are deliberately terse — the plan calls them out as
 * `[halted: turns]`, `[halted: wallclock]`, `[halted: tool-bytes]`
 * with no per-failure advice. Pi receives them as tool-result text
 * and decides what to surface to the caller.
 */

import type { BudgetConfig } from "./types"

const DEFAULT_MAX_TURNS = 500
// Sized a few minutes UNDER the MCP per-tool-call timeout the proxy injects
// (`MCP_TOOL_TIMEOUT`, 35 min in server-setup.ts). Every worker runs behind an
// MCP tool, so the harness hard-kills the call at the MCP cap regardless of this
// value. Keeping the worker wall-clock below that cap means a non-converging
// worker hits ITS OWN wallclock first, raising WorkerAbort -> the engine returns
// the PARTIAL work + a "[halted: wallclock]" message that IS delivered before the
// harness gives up (vs returning NOTHING). 30 min of real autonomous work, with
// ~5 min of headroom under the 35-min MCP cap for graceful teardown + delivery.
// Override with GH_ROUTER_WORKER_MAX_WALLCLOCK_MS (keep it under MCP_TOOL_TIMEOUT).
const DEFAULT_MAX_WALLCLOCK_MS = 30 * 60_000
const DEFAULT_MAX_TOOL_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_TOOL_CALLS = 250
const DEFAULT_MAX_REPEATED_CALLS = 3

/**
 * Thrown when the wall-clock budget is exceeded. Engine catches this
 * around `agent.prompt()` / `agent.continue()` and converts it to a
 * terse `[halted: wallclock]` reply. Carries no extra metadata — by
 * design (no advice).
 */
export class WorkerAbort extends Error {
  readonly reason: "turns" | "wallclock" | "tool-bytes"
  constructor(reason: "turns" | "wallclock" | "tool-bytes") {
    super(`[halted: ${reason}]`)
    this.reason = reason
    this.name = "WorkerAbort"
  }
}

export interface BlockResult {
  block: boolean
  reason?: string
}

/**
 * Read a positive-integer env override. Returns `undefined` if the
 * env var is unset, empty, or doesn't parse to a positive integer —
 * keeping the constructor defaults intact. We don't throw on bad input
 * (env-var typos shouldn't crash the proxy at module load).
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined
  return n
}

/**
 * Resolve a `BudgetConfig` from defaults + env overrides + caller-
 * supplied overrides. Caller overrides win; env wins over defaults.
 *
 * Exported as a free function (not a constructor-only helper) so tests
 * can introspect the merged config without spinning up the `Budget`
 * class.
 */
export function resolveBudgetConfig(
  overrides?: Partial<BudgetConfig>,
): BudgetConfig {
  return {
    maxTurns:
      overrides?.maxTurns ??
      envInt("GH_ROUTER_WORKER_MAX_TURNS") ??
      DEFAULT_MAX_TURNS,
    maxWallClockMs:
      overrides?.maxWallClockMs ??
      envInt("GH_ROUTER_WORKER_MAX_WALLCLOCK_MS") ??
      DEFAULT_MAX_WALLCLOCK_MS,
    maxToolBytes:
      overrides?.maxToolBytes ??
      envInt("GH_ROUTER_WORKER_MAX_TOOL_BYTES") ??
      DEFAULT_MAX_TOOL_BYTES,
    maxToolCalls:
      overrides?.maxToolCalls ??
      envInt("GH_ROUTER_WORKER_MAX_TOOL_CALLS") ??
      DEFAULT_MAX_TOOL_CALLS,
    maxRepeatedCalls:
      overrides?.maxRepeatedCalls ??
      envInt("GH_ROUTER_WORKER_MAX_REPEATED_CALLS") ??
      DEFAULT_MAX_REPEATED_CALLS,
  }
}

/**
 * Worker budget tracker. Constructed once per `runWorkerAgent` call.
 *
 * Lifecycle:
 *   - `addTurn()` is called from Pi's `prepareNextTurn` hook before
 *     each LLM round-trip (after the first prompt).
 *   - `checkBeforeCall(name, args)` is called from Pi's
 *     `beforeToolCall` hook. Returns `{block: true, reason: "[halted:
 *     turns]"}` etc. when a cap fires.
 *   - `recordToolBytes(result)` is called from Pi's `afterToolCall`
 *     hook.
 *   - `checkWallClock()` is called by the engine around blocking
 *     awaits and from `beforeToolCall` — throws `WorkerAbort` when
 *     `Date.now() - startMs > maxWallClockMs`.
 */
export class Budget {
  readonly config: BudgetConfig
  private readonly startMs: number
  private turnCount = 0
  private toolBytes = 0
  private toolCallCount = 0
  private lastCallKey: string | null = null
  private consecutiveRepeats = 0

  constructor(overrides?: Partial<BudgetConfig>) {
    this.config = resolveBudgetConfig(overrides)
    this.startMs = Date.now()
  }

  /** Record a turn. Does NOT throw — `checkBeforeCall` surfaces the cap. */
  addTurn(): void {
    this.turnCount += 1
  }

  /** Current turn count (test helper; safe to call anywhere). */
  get turns(): number {
    return this.turnCount
  }

  /** Current cumulative tool-output bytes recorded so far. */
  get bytes(): number {
    return this.toolBytes
  }

  /** Milliseconds elapsed since construction. */
  get elapsedMs(): number {
    return Date.now() - this.startMs
  }

  /**
   * Throw `WorkerAbort("wallclock")` if elapsed time exceeds
   * `maxWallClockMs`. Engine wraps long awaits in `await
   * Promise.race([..., wallClockTimer])` for prompt cancellation; this
   * is the fallback for cases where the timer hasn't fired yet but a
   * call site wants to be sure (e.g. before sending the next LLM
   * request).
   */
  checkWallClock(): void {
    if (this.elapsedMs > this.config.maxWallClockMs) {
      throw new WorkerAbort("wallclock")
    }
  }

  /**
   * Pi `beforeToolCall` integration. Returns `{block: true, reason}`
   * when any cap has fired, `{block: false}` otherwise. We block on
   * the tool call (rather than throwing) so Pi's loop sees the
   * blocked-tool result and exits cleanly with the partial text it
   * has rather than dying mid-turn.
   *
   * Order: turns first (cheapest), then wall-clock, then tool-bytes.
   * Tool-bytes is checked here (in addition to `afterToolCall`'s
   * `recordToolBytes`) so a runaway tool that just returned 100 MB
   * triggers the cap before the NEXT call rather than after.
   *
   * `toolName` / `args` are accepted for forward compat — current
   * caps are tool-agnostic — and to satisfy the `BeforeToolCallContext`
   * signature in Pi without forcing the engine into a wrapper.
   */
  checkBeforeCall(toolName: string, args: unknown): BlockResult {
    if (this.turnCount > this.config.maxTurns) {
      return { block: true, reason: "[halted: turns]" }
    }
    if (this.elapsedMs > this.config.maxWallClockMs) {
      return { block: true, reason: "[halted: wallclock]" }
    }
    if (this.toolBytes > this.config.maxToolBytes) {
      return { block: true, reason: "[halted: tool-bytes]" }
    }
    this.toolCallCount += 1
    if (this.toolCallCount > this.config.maxToolCalls) {
      return { block: true, reason: "[halted: tool-calls]" }
    }
    // Duplicate-read / anti-loop guard. Block (NOT halt) the next identical
    // call after `maxRepeatedCalls` CONSECUTIVE repeats — the model sees the
    // block as a tool result and must vary the call or finish. A different
    // call resets the counter, so legit re-reads after a scroll/click are
    // unaffected. Repeated ignores still burn `toolCallCount` toward the
    // hard cap, so a stuck model eventually halts.
    const key = `${toolName}:${stableArgs(args)}`
    if (key === this.lastCallKey) {
      this.consecutiveRepeats += 1
    } else {
      this.lastCallKey = key
      this.consecutiveRepeats = 1
    }
    if (this.consecutiveRepeats > this.config.maxRepeatedCalls) {
      return {
        block: true,
        reason:
          `Blocked: this exact ${toolName} call was repeated `
          + `${this.consecutiveRepeats}× with no change. Vary it (scroll / a `
          + "different selector or query / a different tool) or finish with the "
          + "result you already have.",
      }
    }
    return { block: false }
  }

  /**
   * Pi `afterToolCall` integration. Best-effort byte accounting from
   * the tool's text result. We don't double-count images / binary
   * payloads — Pi's tool-result content is text-or-image union and
   * the worker's tools all return text. If a tool returns a non-text
   * content array (image), we count zero bytes for it (the model
   * sees the image directly; it's not a context-pollution proxy
   * concern).
   */
  recordToolBytes(result: unknown): void {
    const n = extractTextByteLength(result)
    if (n > 0) this.toolBytes += n
  }
}

/**
 * Extract the cumulative text-byte length from a Pi
 * `AgentToolResult`-shaped value. The plan-specified Pi shape is
 * `{isError, content: Array<{type: "text", text: string} | …>}` so we
 * walk the content array and sum the UTF-8 byte length of every
 * `text` part.
 *
 * Defensive against unknown shapes — anything we can't read returns
 * 0 (don't crash the agent loop over an unrecognized tool result).
 */
/**
 * Stable string key for a tool call's args, for the duplicate-call guard.
 * Defensive: a non-serializable value collapses to "" (treated as "no args"),
 * which can only make two calls look MORE alike — never crashes the loop.
 */
function stableArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? ""
  } catch {
    return ""
  }
}

function extractTextByteLength(result: unknown): number {
  if (!result || typeof result !== "object") return 0
  const r = result as { content?: unknown }
  const content = r.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === "text" && typeof p.text === "string") {
      total += Buffer.byteLength(p.text, "utf8")
    }
  }
  return total
}
