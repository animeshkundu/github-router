/**
 * Structural, model-free context compaction for worker agents — the policy
 * fed to Pi's `transformContext` hook (the framework's documented seam for
 * "Context length management (pruning old messages)").
 *
 * Pi ships NO automatic compaction (only an explicit, idle-guarded
 * `AgentHarness.compact()` we don't use), so the trigger + pruner are ours to
 * supply — `transformContext` is exactly where Pi expects them. This is
 * STRUCTURAL (no LLM round-trip — workers stay fast) and applies to every
 * worker mode.
 *
 * Load-bearing facts (verified against `agent-loop.ts:283-289`):
 *   - `transformContext`'s return is bound to a LOCAL and passed only to
 *     `convertToLlm`; it is NEVER written back to `_state.messages`. So
 *     compaction is a non-destructive SEND-TIME view: the full transcript
 *     survives in `_state.messages` for the whole run.
 *   - BUT the hook is called with the LIVE `context.messages` reference, so we
 *     MUST `structuredClone` before mutating — else we'd corrupt the real
 *     transcript. We clone only on the (rare) compacting branch.
 *
 * Invariants:
 *   - We NEVER drop a message — only SHRINK content/args. Every `toolCall`
 *     keeps its `id` and its matching `toolResult` message, so tool-call ↔
 *     result pairing is structurally preserved (an orphaned pair is a NEW 400
 *     the compaction itself would otherwise cause).
 *   - Idempotent + convergent: stubbing only shrinks, already-small content is
 *     skipped, so re-running on the output is a no-op.
 *   - Pure function of input; never throws past the caller's try/catch.
 *
 * The trigger uses a conservative UTF-8 byte-floor estimate (`bytes/3`, via
 * `tokensFromBytes`) that OVER-counts tokens — never the `chars/4` undercount
 * that silently defeats a budget on dense DOM-JSON / HTML. The request
 * backstop in the stream-fn is the hard guarantee on top of this best-effort
 * pass.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core"

import { type ContextBudget, IMAGE_BYTES_EQUIV, tokensFromBytes } from "./context-budget"

/** Content already at/below this byte size isn't worth stubbing (idempotency). */
const STUB_SKIP_BYTES = 256

function toolResultStub(toolName: unknown): string {
  const name = typeof toolName === "string" && toolName ? toolName : "tool"
  return `[earlier ${name} output elided to fit context — re-read if needed]`
}
const BASH_OUTPUT_STUB = "[earlier bash output elided to fit context]"
function toolArgsStub(bytes: number): Record<string, unknown> {
  return {
    _elided: `tool-call arguments (~${Math.max(1, Math.round(bytes / 1024))}KB) elided to fit context`,
  }
}

function utf8(s: unknown): number {
  return typeof s === "string" ? Buffer.byteLength(s, "utf8") : 0
}

/** Sum the model-visible text bytes of a content array (`string` | blocks). */
function contentBytes(content: unknown): number {
  if (typeof content === "string") return utf8(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "text") total += utf8(b.text)
    else if (b.type === "image") total += IMAGE_BYTES_EQUIV
  }
  return total
}

/** Conservative UTF-8 byte length of all model-visible text in a message. */
function messageTextBytes(m: AgentMessage): number {
  const msg = m as { role: string; content?: unknown }
  switch (msg.role) {
    case "user":
    case "custom":
    case "toolResult":
      return contentBytes(msg.content)
    case "assistant": {
      const content = msg.content
      if (!Array.isArray(content)) return 0
      let total = 0
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as {
          type?: unknown
          text?: unknown
          thinking?: unknown
          name?: unknown
          arguments?: unknown
        }
        if (b.type === "text") total += utf8(b.text)
        else if (b.type === "thinking") total += utf8(b.thinking)
        else if (b.type === "toolCall") {
          total += utf8(b.name) + utf8(safeJson(b.arguments))
        }
      }
      return total
    }
    case "bashExecution": {
      const b = m as unknown as { command?: unknown; output?: unknown }
      return utf8(b.command) + utf8(b.output)
    }
    case "branchSummary":
    case "compactionSummary":
      return utf8((m as unknown as { summary?: unknown }).summary)
    default:
      return 0
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return ""
  }
}

function structuralTokens(messages: ReadonlyArray<AgentMessage>): number {
  let t = 0
  for (const m of messages) t += tokensFromBytes(messageTextBytes(m))
  return t
}

/** A turn boundary begins at a `user` or `bashExecution` message. */
function isTurnBoundary(m: AgentMessage): boolean {
  const role = (m as { role?: unknown }).role
  return role === "user" || role === "bashExecution"
}

/** Index where the protected recent suffix begins (messages [idx, len) are kept). */
function recentCutIndex(messages: ReadonlyArray<AgentMessage>, budget: ContextBudget): number {
  const len = messages.length
  let acc = 0
  let cut = len
  for (let i = len - 1; i >= 0; i -= 1) {
    const t = tokensFromBytes(messageTextBytes(messages[i]!))
    // Don't admit a message that breaches the protected cap — unless it's the
    // single newest (always protected) — so the prunable window stays non-empty.
    if (i < len - 1 && acc + t > budget.maxProtectedTokens) {
      cut = i + 1
      break
    }
    acc += t
    if (acc >= budget.keepRecentTokens) {
      // Snap to a turn boundary so the newest turn is protected whole.
      let j = i
      while (j > 0 && !isTurnBoundary(messages[j]!)) j -= 1
      cut = j
      break
    }
    cut = i
  }
  return cut
}

/**
 * Shrink one message's bulky content IN PLACE (the message is from a
 * structuredClone, so this never touches the caller's array). Returns true iff
 * it changed anything. Skips content already at/below `STUB_SKIP_BYTES`
 * (idempotency). Never removes the message or alters a `toolCall.id` —
 * pairing is preserved.
 */
function stubMessage(m: AgentMessage): boolean {
  const msg = m as { role: string; content?: unknown }
  switch (msg.role) {
    case "toolResult": {
      if (contentBytes(msg.content) <= STUB_SKIP_BYTES) return false
      const stub = toolResultStub((m as unknown as { toolName?: unknown }).toolName)
      msg.content = typeof msg.content === "string" ? stub : [{ type: "text", text: stub }]
      return true
    }
    case "bashExecution": {
      const b = m as unknown as { output?: unknown }
      if (utf8(b.output) <= STUB_SKIP_BYTES) return false
      b.output = BASH_OUTPUT_STUB
      return true
    }
    case "assistant": {
      const content = msg.content
      if (!Array.isArray(content)) return false
      let changed = false
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as { type?: unknown; arguments?: unknown }
        if (b.type === "toolCall") {
          const bytes = utf8(safeJson(b.arguments))
          if (bytes > STUB_SKIP_BYTES) {
            b.arguments = toolArgsStub(bytes)
            changed = true
          }
        }
      }
      return changed
    }
    default:
      return false
  }
}

/**
 * Stub bulky messages oldest-first over `[0, hi)`, skipping `skipIdx` (the
 * task), until the running sum is at/below `target`. Returns the new sum.
 */
function prunePass(
  out: AgentMessage[],
  hi: number,
  skipIdx: number,
  target: number,
  startSum: number,
): number {
  let sum = startSum
  for (let i = 0; i < hi && sum > target; i += 1) {
    if (i === skipIdx) continue
    const before = tokensFromBytes(messageTextBytes(out[i]!))
    if (!stubMessage(out[i]!)) continue
    sum -= before - tokensFromBytes(messageTextBytes(out[i]!))
  }
  return sum
}

/**
 * Compact the transcript for the next request. No-op below the trigger.
 * Pass 1 prunes old (pre-recent-suffix) tool results / bash output /
 * tool-call args to `pruneTargetTokens`. Pass 2 (only if still over
 * `hardLimitTokens`) extends pruning into the recent suffix — current-turn
 * truncation — since a single turn's parallel reads can alone exceed the
 * window; it leaves the single newest message intact (bounded by the
 * afterToolCall per-result cap). If the result is still over the limit
 * (pathological), it is returned anyway and the request backstop rejects it
 * with a visible diagnostic rather than crashing.
 */
export function compactWorkerContext(
  messages: AgentMessage[],
  budget: ContextBudget,
): AgentMessage[] {
  if (structuralTokens(messages) <= budget.compactTriggerTokens) return messages
  const out = structuredClone(messages)
  const firstUserIdx = out.findIndex((m) => (m as { role?: unknown }).role === "user")
  const cut = recentCutIndex(out, budget)

  let sum = structuralTokens(out)
  sum = prunePass(out, cut, firstUserIdx, budget.pruneTargetTokens, sum)
  if (sum > budget.hardLimitTokens) {
    // Escalation: stub current-turn results too, but spare the single newest
    // (the in-flight result the agent will act on).
    sum = prunePass(out, out.length - 1, firstUserIdx, budget.hardLimitTokens, sum)
  }
  if (sum > budget.hardLimitTokens) {
    // Last resort: stub the NEWEST too. Only reached when it alone (plus
    // unshrinkable content) still exceeds the hard limit — in production the
    // afterToolCall per-result cap keeps it below, so this is the pathological
    // tail. A stubbed in-flight result + a re-read cue beats an aborted run.
    sum = prunePass(out, out.length, firstUserIdx, budget.hardLimitTokens, sum)
  }
  return out
}

/** Test-only internals. */
export const __testExports = {
  messageTextBytes,
  structuralTokens,
  recentCutIndex,
  stubMessage,
}
