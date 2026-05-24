/**
 * `runWorkerAgent` — the engine that wires every foundation module
 * (`types`, `paths`, `prompts`, `budget`, `redact`, `semaphore`,
 * `model-resolve`, `bash`, `worktree`, `lifecycle`, `tools`,
 * `stream-fn`) into a single Pi `Agent` run.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Engine sketch
 * (verified Pi API)"). The order of operations below is load-bearing
 * and matches the verified 14-step sketch exactly. Any reorder
 * either leaks a resource (cleanup-before-allocate inversion) or
 * skips a security check (workspace canonicalization, model
 * validation).
 *
 * Public surface: a single function. Inputs come in via
 * `WorkerAgentOpts`; outputs leave via `WorkerAgentResult`. Both
 * shapes live in `./types.ts` so the MCP registration layer can
 * import them without pulling Pi into its compile graph.
 *
 * Halt messages, audit lines, network gating, and budget caps are
 * all enforced by the foundation modules — the engine just wires
 * the right hooks into Pi's `Agent`. The few engine-only
 * responsibilities:
 *
 *   1. acquire the worker semaphore slot (fail-fast on cap or
 *      pre-aborted signal);
 *   2. validate + clamp model/thinking against the live Copilot
 *      catalog;
 *   3. realpath-canonicalize the workspace (so every per-call
 *      `confineToWorkspace` inside `tools.ts` operates on a stable
 *      base — the docstring there requires this);
 *   4. provision the worktree (only for `implement` + `worktree:
 *      true`; HARD ERROR if no git);
 *   5. construct the `Budget` (which reads env overrides on its own);
 *   6. construct the tool array bound to the resolved workspace
 *      + a live getter for the advisor's transcript;
 *   7. construct the `Agent` with the custom Copilot stream fn, the
 *      audit-and-budget `beforeToolCall`, and the byte-accounting
 *      `afterToolCall`;
 *   8. wire `opts.signal` → `agent.abort()` so outer cancellation
 *      propagates cleanly into Pi's tool-level signals;
 *   9. subscribe to `message_end` so we can extract the assistant's
 *      final text from the content-part array (Pi does NOT hand us
 *      a string here — `extractAssistantText` is mandatory, see
 *      plan's peer-review HIGH finding);
 *  10. set a wall-clock timer that fires `agent.abort()` on expiry
 *      (the budget's `checkBeforeCall` is per-call; a runaway
 *      bash could exceed the cap mid-run);
 *  11. `await agent.prompt(...)` then `await agent.waitForIdle()`
 *      (the former already awaits the run, but waitForIdle is a
 *      cheap no-op insurance line that survives if Pi ever changes
 *      `prompt()`'s return semantics);
 *  12. capture the worktree diff BEFORE removal so the response
 *      carries the diff + Pi's text;
 *  13. ALWAYS attempt `ws.remove()` in the inner `finally` — on
 *      both success and Pi-throws-mid-loop paths;
 *  14. release the semaphore slot in the outer `finally` — this
 *      runs even when the inner blocks throw, so the slot can't
 *      leak.
 *
 * Output format: the response text is `diff ? "${finalText}\n\n${diff}"
 * : finalText`. No banners, no labels, no clamp notices. Pi spoke;
 * we deliver verbatim. The plan calls this out explicitly: the
 * worker is a tool, and tool output should be terse facts that the
 * caller (Claude Code) can read without parsing prose.
 */

import { realpathSync } from "node:fs"

import { Agent } from "@earendil-works/pi-agent-core"
import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core"
import type {
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai"

import { Budget, WorkerAbort } from "./budget"
import {
  WorktreeRegistry,
  getInstanceUuid,
  registerExitHandlers,
} from "./lifecycle"
import { resolveModelAndThinking } from "./model-resolve"
import { systemPromptFor } from "./prompts"
import { logAudit } from "./redact"
import { acquireWorkerSlot } from "./semaphore"
import { createCopilotStreamFn } from "./stream-fn"
import { buildWorkerTools } from "./tools"
import type {
  WorkerAgentOpts,
  WorkerAgentResult,
  WorkerThinkingLevel,
} from "./types"
import { type WorktreeHandle, createWorktree } from "./worktree"

/**
 * Process-wide worktree registry. One instance per proxy lifetime
 * — the lifecycle module's `registerExitHandlers` is idempotent and
 * latches the FIRST registry it sees, so we eagerly create + register
 * at module-load so the SIGINT/SIGTERM sweep is wired up before any
 * worker runs.
 *
 * Exported solely for the test helpers in this file to reach.
 */
const WORKTREE_REGISTRY = new WorktreeRegistry()
registerExitHandlers(WORKTREE_REGISTRY)

/** Default model + thinking. See plan: gemini-3.5-flash + "high" — the
 *  defaults are sized for the model that backs the worker tool's
 *  description string in `peer-mcp-personas.ts`. Caller can override.
 *
 *  Exported so the MCP handler (which renders the worker tool's
 *  description to the LLM and pins a probe row against the model)
 *  reads the same constant — drift between the two would silently
 *  ship a tool whose docs disagree with its runtime default. */
export const DEFAULT_MODEL = "gemini-3.5-flash"
const DEFAULT_THINKING: WorkerThinkingLevel = "high"

/**
 * `Model<any>` shim used to satisfy `Agent.initialState.model` typing.
 *
 * The custom `streamFn` (created by `createCopilotStreamFn`) is the
 * authoritative model + thinking routing path — it ignores the
 * `model` argument the Agent loop hands it and uses the captured
 * `resolved` config instead. So the fields below exist purely to
 * pass type-checks; nothing reads them at runtime in our wiring.
 *
 * Stamping `id` with the resolved model id keeps surface-level
 * diagnostics (e.g. error-message AssistantMessage's `model` field
 * if Pi ever inspects it) faithful to what the caller asked for.
 */
function makeModelShim(modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  }
}

/**
 * Concatenate the `TextContent.text` parts of an assistant message's
 * `content` array into a single string. Pi's `message_end.message.content`
 * is `(TextContent | ThinkingContent | ToolCall)[]` (see vendored
 * `ai/types.ts:279`) — NOT a string. Calling `.toString()` or treating
 * the field as text would give us `[object Object]` (peer-review HIGH
 * from opus that the plan calls out at line 43).
 *
 * `ThinkingContent` is intentionally dropped — the caller wants the
 * answer, not the chain of thought. `ToolCall` is also dropped — tool
 * calls are addressed to other tools, not to the caller, and including
 * them in the worker's reply would be confusing.
 */
function extractAssistantText(
  content: ReadonlyArray<TextContent | ThinkingContent | ToolCall>,
): string {
  let out = ""
  for (const part of content) {
    if (part.type === "text") out += part.text
  }
  return out
}

/**
 * Trivial stub for the no-worktree path. `dir` is the workspace
 * itself; `finalize` returns an empty diff (the response text won't
 * suffix anything); `remove` is a no-op (nothing to clean).
 *
 * Keeping the same `WorktreeHandle` interface lets the rest of the
 * engine treat both modes uniformly — no per-call `if (worktree)`
 * branches around the prompt/finalize/remove dance.
 */
function makeNoWorktreeHandle(workspace: string): WorktreeHandle {
  return {
    dir: workspace,
    branch: "",
    finalize: () => Promise.resolve(""),
    remove: () => Promise.resolve(),
  }
}

/**
 * Run a worker-agent task end-to-end.
 *
 * Contract:
 *   - Returns `{text, isError?}`. Never throws — failures are encoded
 *     as `{text: "<terse error>", isError: true}` so the MCP layer
 *     can just forward the result.
 *   - The semaphore slot is released in the outer `finally` regardless
 *     of how the inner code path exits.
 *   - The worktree (when used) is removed in the inner `finally`,
 *     so it cleans up on both success AND on Pi-throws-mid-loop.
 *   - The outer `opts.signal` is bridged into `agent.abort()` once;
 *     the listener is removed in the inner `finally` so a long-lived
 *     `AbortSignal` (e.g. an `AbortSignal.timeout(60_000)` reused
 *     across multiple worker calls) can't leak listeners.
 */
export async function runWorkerAgent(
  opts: WorkerAgentOpts,
): Promise<WorkerAgentResult> {
  // Step 1: semaphore slot. Pre-aborted signal AND cap-exhausted
  // both return null; we don't bother distinguishing in the caller-
  // visible error text because the user's recovery is the same
  // (retry later).
  const release = await acquireWorkerSlot(opts.signal)
  if (!release) {
    return {
      text: "Worker queue full; retry shortly.",
      isError: true,
    }
  }

  try {
    // Step 2: model + thinking validation. `resolveModelAndThinking`
    // returns a Result; on `ok:false` we emit the diagnostic verbatim
    // (it already enumerates the catalog's tool_call-capable models
    // on unknown-model errors, so the caller knows what to retry with).
    const resolved = resolveModelAndThinking({
      model: opts.model ?? DEFAULT_MODEL,
      thinking: opts.thinking ?? DEFAULT_THINKING,
    })
    if (!resolved.ok) {
      return { text: resolved.error, isError: true }
    }

    // Step 3: workspace canonicalization. The per-call `confineToWorkspace`
    // chokepoint inside `tools.ts` requires its `workspaceAbs` to be
    // pre-realpath-resolved (see `paths.ts` docstring). Doing it once
    // here is cheaper than realpathing on every tool call and keeps
    // the trailing-separator check honest on macOS (`/var` →
    // `/private/var`) and Windows (junction-resolved drive letters).
    let workspaceAbs: string
    try {
      workspaceAbs = realpathSync.native(opts.workspace)
    } catch (err) {
      return {
        text: `workspace not accessible: ${(err as Error).message}`,
        isError: true,
      }
    }

    // Step 4: worktree provisioning (implement + worktree only).
    // HARD ERROR if no git — `createWorktree` throws for us. We do NOT
    // silently fall back to the no-worktree path: the caller asked for
    // isolation, and an undetected fallback would race with their other
    // edits (plan: peer-review HIGH, explicit policy).
    const useWorktree = opts.mode === "implement" && opts.worktree === true
    let ws: WorktreeHandle
    if (useWorktree) {
      try {
        ws = await createWorktree(workspaceAbs, {
          instanceUuid: getInstanceUuid(),
          registry: WORKTREE_REGISTRY,
        })
      } catch (err) {
        return {
          text: (err as Error).message,
          isError: true,
        }
      }
    } else {
      ws = makeNoWorktreeHandle(workspaceAbs)
    }

    // Step 5: budget construction. Defaults from the constructor;
    // env-overrides are read by `resolveBudgetConfig` (called inside
    // the `Budget` constructor) so users can tighten the caps without
    // a code change.
    const budget = new Budget()

    // Step 6: tools. `getMessages` is wired with a forward-referenced
    // closure that resolves to `agent.state.messages` at call time —
    // the advisor tool consumes the LIVE transcript so its review has
    // the freshest context, not a snapshot from construction time.
    //
    // We use a single-field object as the forward-reference holder
    // rather than a bare `let`. `let agent: Agent | undefined` would
    // trip ESLint's `prefer-const` (it sees one assignment and doesn't
    // model the closure dependency); a ref holder is the conventional
    // workaround and reads truthfully: the agent is mutable from the
    // closure's perspective.
    const agentRef: { current?: Agent } = {}
    const tools = buildWorkerTools({
      mode: opts.mode,
      workspace: ws.dir,
      getMessages: () => agentRef.current?.state.messages ?? [],
    })

    // Step 7: Agent. `streamFn` is the routing override (per Pi docs
    // and our verified facts in the plan, this is the documented hook
    // for "all LLM traffic for this agent goes through MY function").
    // `toolExecution` is `"sequential"` for implement mode so the
    // model can't fire two write tools in parallel against the same
    // file — peer-review HIGH, 2-lab confirmed. (Edit/write/bash all
    // also declare `executionMode: "sequential"` per-tool, but the
    // agent-level setting belts-and-suspenders against future tool
    // additions that forget the per-tool flag.)
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPromptFor(opts.mode),
        model: makeModelShim(resolved.modelId),
        thinkingLevel: resolved.thinking,
        tools,
      },
      streamFn: createCopilotStreamFn({ resolved }),
      toolExecution: opts.mode === "implement" ? "sequential" : "parallel",
      beforeToolCall: async (
        ctx: BeforeToolCallContext,
      ): Promise<BeforeToolCallResult | undefined> => {
        // Audit FIRST — even blocked calls should be visible to the
        // operator (otherwise a budget-exhausted run looks silent).
        // logAudit catches its own errors so it can't break the loop.
        logAudit({
          mode: opts.mode,
          tool: ctx.toolCall.name,
          args: ctx.args,
          workspace: ws.dir,
        })
        const v = budget.checkBeforeCall(ctx.toolCall.name, ctx.args)
        if (v.block) return { block: true, reason: v.reason }
        return undefined
      },
      afterToolCall: async (ctx: AfterToolCallContext) => {
        // Byte accounting on the realized tool result. `recordToolBytes`
        // walks `result.content[].text` parts and sums UTF-8 byte
        // lengths; non-text content (images) is counted as zero (the
        // model sees them, but they're not a context-pollution proxy
        // concern for our cap).
        budget.recordToolBytes(ctx.result)
        return undefined
      },
      // Pi calls `prepareNextTurn` after `turn_end` and before the loop
      // decides whether another provider request should start. Counting
      // turns here (rather than per beforeToolCall) keeps the turns cap
      // honest: a single turn that fires N parallel tool calls is one
      // turn, not N. Returning `undefined` keeps the existing context.
      prepareNextTurn: async () => {
        budget.addTurn()
        return undefined
      },
    })

    // Step 8: bridge outer abort → agent.abort(). The listener is
    // `{once: true}` so it auto-removes after first fire; we ALSO
    // explicitly removeEventListener in the inner finally so a
    // long-lived `opts.signal` (test fixtures, repeated calls) can't
    // accumulate dead listeners.
    const abortHandler = (): void => agent?.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        // Late check — semaphore step 1 already gated pre-aborted, but
        // the signal might have aborted between then and here. Fire
        // the abort BEFORE we start the loop so the prompt doesn't
        // even get a chance to spin.
        agent.abort()
      } else {
        opts.signal.addEventListener("abort", abortHandler, { once: true })
      }
    }

    // Step 9: subscribe to message_end. The assistant's final text is
    // the LAST `message_end` event whose message role is "assistant".
    // (Multi-turn runs emit one `message_end` per assistant turn; we
    // overwrite as we go so the final state captures the last reply.)
    //
    // `event.message.content` is `(TextContent | ThinkingContent |
    // ToolCall)[]` — see `extractAssistantText` above for why we don't
    // just `.toString()`.
    let finalText = ""
    let lastStopReason: string | null = null
    const unsubscribe = agent.subscribe((event) => {
      if (event.type !== "message_end") return
      const msg = event.message
      if (typeof msg !== "object" || msg === null) return
      if ((msg as { role?: unknown }).role !== "assistant") return
      const content = (msg as AssistantMessage).content
      if (!Array.isArray(content)) return
      finalText = extractAssistantText(content)
      const sr = (msg as { stopReason?: unknown }).stopReason
      if (typeof sr === "string") lastStopReason = sr
    })

    // Step 10: wall-clock timer. `Budget.checkBeforeCall` already
    // enforces wallclock on each tool boundary, but a runaway bash
    // (whose own timeout is up to 10 minutes) could exceed the
    // 30-minute cap mid-run. The timer fires `agent.abort()` which
    // cascades into the per-tool signal and tears the bash down.
    // `.unref()` so the timer doesn't keep the event loop alive past
    // the test/scope that owns this call.
    const wallClockTimer = setTimeout(() => {
      agent?.abort()
    }, budget.config.maxWallClockMs)
    wallClockTimer.unref?.()

    try {
      // Step 11: drive the run. `agent.prompt()` already awaits the
      // entire run via `runWithLifecycle`; `waitForIdle()` is a
      // belt-and-suspenders await that survives any future change to
      // `prompt()`'s return semantics.
      await agent.prompt(opts.prompt)
      await agent.waitForIdle()

      // Step 12: capture the diff BEFORE removal. `finalize()` runs
      // `git add -N .` then `git diff HEAD` so untracked files appear
      // in the output (peer-review fix, see worktree.ts docstring).
      // Wrapped in its own try/catch so a finalize failure (rare —
      // git invocation error, disk full, etc.) doesn't shadow the
      // model's actual reply text.
      let diff = ""
      try {
        diff = await ws.finalize()
      } catch (err) {
        // Surface the finalize error in the diff slot so the caller
        // sees SOMETHING about what went wrong; better than losing it
        // silently.
        diff = `[diff capture failed: ${(err as Error).message}]`
      }

      // Step 13a: success-path cleanup. Still in the inner try, so
      // the outer finally's release(...) still runs even if remove()
      // throws (it doesn't — remove() is documented best-effort).
      try {
        await ws.remove()
      } catch {
        // remove() is documented to swallow EBUSY/ENOENT; an error
        // bubbling up here is a logic bug in worktree.ts, not a
        // caller-visible failure. Drop it — session-end sweep and
        // boot-time PID+instance sweep are the safety nets.
      }

      const text = diff ? `${finalText}\n\n${diff}` : finalText
      // Never return empty text — the harness has no signal to act on.
      // Distinguish (a) Pi exited silently after tool work from (b) a
      // legitimate no-op so the caller can decide to retry/rephrase.
      if (!text.trim()) {
        return {
          text:
            `[worker exited with no output `
            + `(stopReason=${lastStopReason ?? "unknown"}, `
            + `turns=${budget.turns}, elapsed=${budget.elapsedMs}ms)]`,
          isError: true,
        }
      }
      return { text }
    } catch (err) {
      // Step 13b: error-path cleanup. Mirror the success path so the
      // worktree can't strand on a Pi-throws-mid-loop path. For
      // `WorkerAbort` (budget cap hit), capture the diff before tearing
      // the worktree down — the partial work Pi did is still useful for
      // the caller to inspect.
      let diff = ""
      if (err instanceof WorkerAbort) {
        try {
          diff = await ws.finalize()
        } catch {
          /* ignore — best-effort, halt message stands alone */
        }
      }
      try {
        await ws.remove()
      } catch {
        /* same as above */
      }
      const haltOrErr = err instanceof Error ? err.message : String(err)
      const parts: Array<string> = []
      if (finalText) parts.push(finalText)
      if (diff) parts.push(diff)
      parts.push(haltOrErr)
      return {
        text: parts.join("\n\n"),
        isError: true,
      }
    } finally {
      // Inner finally: listener + subscription + timer teardown.
      // These run on BOTH the success try-block and the catch — keeps
      // a long-lived signal/timer from leaking on either path.
      clearTimeout(wallClockTimer)
      if (opts.signal) {
        opts.signal.removeEventListener("abort", abortHandler)
      }
      unsubscribe()
    }
  } finally {
    // Step 14: ALWAYS release the slot. Outer finally — runs whether
    // the inner code throws synchronously, returns normally, or
    // bubbles up an error from any await. The release function is
    // idempotent (see semaphore.ts) so a double-fire is harmless.
    release()
  }
}

// ============================================================
// Test exports
// ============================================================

/**
 * Test-only exports. The public surface of the engine is
 * `runWorkerAgent` alone; everything else is internal. Tests use
 * the helpers below for direct extract-assistant-text assertions
 * without spinning up the full agent.
 */
export const __testExports = {
  extractAssistantText,
  makeModelShim,
  makeNoWorktreeHandle,
  WORKTREE_REGISTRY,
}
