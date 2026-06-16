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
 *   4. provision the worktree (only for write-capable filesystem modes
 *      with `worktree: true`; HARD ERROR if no git);
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
import process from "node:process"

import { Agent } from "@earendil-works/pi-agent-core"
import type {
  AfterToolCallContext,
  AgentMessage,
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
import { type AuditCtx, logAudit } from "./redact"
import { acquireWorkerSlot } from "./semaphore"
import { createCopilotStreamFn } from "./stream-fn"
import {
  buildBrowseTools,
  formatBrowseTerminalAnswer,
  isBrowseTerminalTool,
} from "./browse-tools"
import { makeContextBudget } from "./context-budget"
import { compactWorkerContext } from "./compaction"
import { capToolResultText } from "./tool-output-cap"
import { buildWorkerTools, createPlanState, renderPlan } from "./tools"
import type { PlanState } from "./tools"
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

/** Default model + thinking for the READ-ONLY worker modes (`explore`,
 *  `review`). `gemini-3.5-flash` at `high` (its top reasoning tier) — fast,
 *  1M-context, tool-call-capable.
 *
 *  HISTORY / CAVEAT: an earlier iteration moved OFF flash to
 *  `gemini-3.1-pro-preview` because *that* flash early-stopped with empty
 *  turns on the function-calling loop. `gemini-3.5-flash` is a NEWER model
 *  and is being re-evaluated for the read-only workload, where parallel
 *  read/search batches and sound stop/continue decisions matter. If it
 *  regresses to early-stopping, revert this to `gemini-3.1-pro-preview`.
 *
 *  Exported so the MCP handler + the gate (`workerToolsEnabled`) read the
 *  same constant — drift would ship a tool whose docs/gate disagree with
 *  its runtime default. Caller can override per call via the `model` arg. */
export const DEFAULT_MODEL = "gemini-3.5-flash"
const DEFAULT_THINKING: WorkerThinkingLevel = "high"

/** Default model + thinking for the READ+WRITE `implement` mode. `gpt-5.5`
 *  at `xhigh` — the strongest reasoning tier in the catalog, 1M+ context,
 *  routed through `/responses` by the stream-fn endpoint split. Coding edits
 *  benefit from maximum reasoning; the higher per-call cost is justified for
 *  autonomous implementation. An explicit `opts.model` still wins. */
export const IMPLEMENT_DEFAULT_MODEL = "gpt-5.5"
const IMPLEMENT_DEFAULT_THINKING: WorkerThinkingLevel = "xhigh"

/** Default model for `browse` mode. `gpt-5.4-mini` — the Gate-B-winning
 *  browse model (small + fast enough to drive a tab at human pace, with
 *  enough tool-calling discipline to terminate). This is DISTINCT from the
 *  gemini worker `DEFAULT_MODEL`: browse is a different workload (drive a
 *  page, not read a repo) and was tuned separately. May be retuned after
 *  the flash-vs-mini eval settles. Routed through `/responses` by the
 *  stream-fn's endpoint split (it's a gpt-5.x model). Caller can override
 *  per call via the `model` arg.
 *
 *  Exported so the MCP browse handler reads the same constant — drift
 *  between the two would ship a tool whose docs disagree with its runtime
 *  default. */
export const BROWSE_DEFAULT_MODEL = "gpt-5.4-mini"
/** Default thinking for `browse`. Higher than the page-driving workload
 *  strictly needs, but the termination discipline benefits from it. */
const BROWSE_DEFAULT_THINKING: WorkerThinkingLevel = "high"

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
async function runWorkerAgentOnce(
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
    //
    // Per-mode defaults (an explicit `opts.model`/`opts.thinking` always
    // wins): read-only `explore`/`review`/`plan` → `DEFAULT_MODEL`
    // (gemini-3.5-flash, high); read+write `implement`/`test` →
    // `IMPLEMENT_DEFAULT_MODEL` (gpt-5.5, xhigh — coding/test-authoring wants
    // max reasoning); `browse` → `BROWSE_DEFAULT_MODEL` (gpt-5.4-mini). The
    // workloads are distinct enough to warrant distinct defaults.
    const isBrowse = opts.mode === "browse"
    const isWriteCapable = opts.mode === "implement" || opts.mode === "test"
    const defaultModel = isBrowse
      ? BROWSE_DEFAULT_MODEL
      : isWriteCapable
        ? IMPLEMENT_DEFAULT_MODEL
        : DEFAULT_MODEL
    const defaultThinking = isBrowse
      ? BROWSE_DEFAULT_THINKING
      : isWriteCapable
        ? IMPLEMENT_DEFAULT_THINKING
        : DEFAULT_THINKING
    const resolved = resolveModelAndThinking({
      model: opts.model ?? defaultModel,
      thinking: opts.thinking ?? defaultThinking,
    })
    if (!resolved.ok) {
      return { text: resolved.error, isError: true }
    }

    // Per-run context budget from the resolved model's catalog window.
    // Undefined when the window is unknown → compaction + the per-result cap
    // no-op (the request backstop still guards). Sized ONCE and threaded into
    // `transformContext` (compaction) + `afterToolCall` (the per-result cap)
    // so the two defenses derive from one window and never drift. Per-run
    // (parallel runs resolve different windows) — never module state.
    const ctxBudget = makeContextBudget(resolved.contextWindow)

    // Step 3: workspace canonicalization. The per-call `confineToWorkspace`
    // chokepoint inside `tools.ts` requires its `workspaceAbs` to be
    // pre-realpath-resolved (see `paths.ts` docstring). Doing it once
    // here is cheaper than realpathing on every tool call and keeps
    // the trailing-separator check honest on macOS (`/var` →
    // `/private/var`) and Windows (junction-resolved drive letters).
    //
    // Browse doesn't use the filesystem — its tools drive a real browser
    // and ignore `ws.dir`. So an omitted `browse` workspace defaults to
    // `process.cwd()` purely to keep canonicalization (and the no-worktree
    // handle) happy; the value is never read by the browse tools.
    const workspaceInput =
      opts.workspace ?? (isBrowse ? process.cwd() : undefined)
    if (workspaceInput === undefined) {
      return {
        text: "workspace not accessible: a workspace path is required",
        isError: true,
      }
    }
    let workspaceAbs: string
    try {
      workspaceAbs = realpathSync.native(workspaceInput)
    } catch (err) {
      return {
        text: `workspace not accessible: ${(err as Error).message}`,
        isError: true,
      }
    }

    // Step 4: worktree provisioning (write-capable `implement`/`test` +
    // worktree only). HARD ERROR if no git — `createWorktree` throws for us.
    // We do NOT silently fall back to the no-worktree path: the caller asked
    // for isolation, and an undetected fallback would race with their other
    // edits (plan: peer-review HIGH, explicit policy).
    const useWorktree =
      (opts.mode === "implement" || opts.mode === "test") &&
      opts.worktree === true
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

    // Step 6: tools. `getMessages` exposes the LIVE Pi transcript to the
    // `advisor` tool so it can include the recent conversation as context;
    // `planState` is the per-run scratchpad the `update_plan` tool writes
    // and `transformContext` re-surfaces each turn so the plan survives
    // compaction. `agent` is assigned just below — the `getMessages`
    // closure reads it at tool-execute time, long after assignment.
    //
    // Browse mode swaps the filesystem toolset for the browser-control
    // tools (`buildBrowseTools`), scoped to the caller's browse session so
    // the tools enforce per-session tab ownership. The else-branch narrows
    // `opts.mode` to the three filesystem modes (browse is excluded by the
    // ternary), so `buildWorkerTools` keeps its narrower mode type.
    // `agentHolder` lets the `getMessages` closure (built before the Agent
    // exists, to pass into the tools) read the live transcript once the
    // Agent is assigned below. A const holder with a mutated field keeps
    // prefer-const happy while preserving the deferred-assignment shape.
    const agentHolder: { agent?: Agent } = {}
    const planState: PlanState = createPlanState()
    const getMessages = (): ReadonlyArray<AgentMessage> =>
      agentHolder.agent?.state.messages ?? []
    const tools =
      opts.mode === "browse"
        ? buildBrowseTools({ sessionId: opts.sessionId })
        : buildWorkerTools({
            mode: opts.mode,
            workspace: ws.dir,
            getMessages,
            planState,
          })

    // Step 7: Agent. `streamFn` is the routing override (per Pi docs
    // and our verified facts in the plan, this is the documented hook
    // for "all LLM traffic for this agent goes through MY function").
    // `toolExecution` is `"parallel"`: pure read/search batches run
    // concurrently for the latency win, while edit/write/bash/codex_review/
    // update_plan each declare `executionMode: "sequential"`, so Pi's
    // dispatch serializes ANY batch containing one of them — a write or a
    // stateful tool never runs concurrently with anything. (peer-review
    // HIGH, 2-lab confirmed; the per-tool flags are now the sole
    // serialization source.)
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPromptFor(opts.mode),
        model: makeModelShim(resolved.modelId),
        thinkingLevel: resolved.thinking,
        tools,
      },
      streamFn: createCopilotStreamFn({ resolved, contextBudget: ctxBudget }),
      toolExecution: "parallel",
      // transformContext is installed UNCONDITIONALLY — it is the seam for
      // BOTH structural compaction AND the per-turn plan reminder. Two
      // independent jobs under a single no-throw try/catch:
      //   (1) compaction — only when the model window is known
      //       (`ctxBudget`); skipped otherwise (no blind pruning). The
      //       compactor `structuredClone`s before mutating the live ref.
      //   (2) plan reminder — when `planState` is non-empty, append ONE
      //       synthetic `user`-role message with the current plan, but only
      //       when the last message isn't already a `user` message (avoid
      //       two consecutive user turns on the Copilot wire).
      // The output is a send-time view (never persisted), and `[...compacted,
      // reminder]` is a fresh array, so the canonical transcript is never
      // mutated: exactly one always-current plan copy, no accumulation, no
      // orphaned toolCall/toolResult pair. On any failure the original
      // messages are returned and the stream-fn request backstop guards
      // overflow.
      transformContext: async (messages) => {
        // Two independent, separately-guarded jobs so a failure in one
        // can't discard the other's result.
        let compacted = messages
        if (ctxBudget) {
          try {
            compacted = compactWorkerContext(messages, ctxBudget)
          } catch {
            compacted = messages
          }
        }
        try {
          return appendPlanReminder(compacted, planState)
        } catch {
          return compacted
        }
      },
      beforeToolCall: async (
        ctx: BeforeToolCallContext,
      ): Promise<BeforeToolCallResult | undefined> => {
        // Audit FIRST — even blocked calls should be visible to the
        // operator (otherwise a budget-exhausted run looks silent).
        // logAudit catches its own errors so it can't break the loop.
        // The `mode` cast is type-only: `AuditCtx["mode"]` predates the
        // `"browse"` mode; the runtime value is forwarded verbatim, so the
        // audit line reads `mode=browse` correctly. (Widening AuditCtx in
        // redact.ts would drop the cast — left to that file's owner.)
        logAudit({
          mode: opts.mode as AuditCtx["mode"],
          tool: ctx.toolCall.name,
          args: ctx.args,
          workspace: ws.dir,
        })
        const v = budget.checkBeforeCall(ctx.toolCall.name, ctx.args)
        if (v.block) return { block: true, reason: v.reason }
        // Browse terminal capture. The agent finishes by CALLING
        // `submit_answer` / `report_insufficient`; the answer lives in
        // the tool-call args, not in assistant text (the terminal turn's
        // assistant message is just the tool call → empty `finalText`).
        // Capture AFTER the budget gate so a capped-out terminal isn't
        // surfaced as a real answer. The terminal `execute` only echoes
        // args + sets `terminate:true`, so it can't fail past this point.
        if (isBrowse && isBrowseTerminalTool(ctx.toolCall.name)) {
          const a = formatBrowseTerminalAnswer(ctx.toolCall.name, ctx.args)
          if (a.trim()) terminalText = a
        }
        return undefined
      },
      afterToolCall: async (ctx: AfterToolCallContext) => {
        // Byte accounting on the realized tool result. `recordToolBytes`
        // walks `result.content[].text` parts and sums UTF-8 byte
        // lengths; non-text content (images) is counted as zero (the
        // model sees them, but they're not a context-pollution proxy
        // concern for our cap).
        budget.recordToolBytes(ctx.result)
        // Per-result source cap. `afterToolCall` runs after the tool's
        // execute and can REPLACE the result content; each parallel tool's
        // hook caps its OWN result (no shared state → race-free across the
        // batch). One giant read_page/bash/grep is shortened to the budget's
        // per-result cap so it can't dominate the next request; the per-turn
        // AGGREGATE across parallel results is bounded by the compactor's
        // current-turn truncation. No-op when the budget is unknown.
        if (ctxBudget) {
          const capped = capToolResultText(
            (ctx.result as { content?: unknown }).content,
            ctxBudget.perResultCapBytes,
          )
          if (capped) return { content: capped }
        }
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
    // Publish the agent to the `getMessages` closure (used by the advisor
    // tool) now that it exists.
    agentHolder.agent = agent

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
    // Browse-only: the answer captured from a terminal tool's args (see
    // the `beforeToolCall` capture). Preferred over `finalText` for browse
    // because the agent's authoritative answer is the terminal payload,
    // not any preamble text it may have emitted alongside the tool call.
    let terminalText: string | null = null
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

      // Browse mode finishes by calling a terminal tool, so its answer is
      // `terminalText` (captured from the tool args), NOT assistant text or
      // a worktree diff (browse has neither). Fall back to `finalText` for
      // the rare case the model emitted text but no terminal payload.
      const text = isBrowse
        ? (terminalText ?? finalText)
        : diff
          ? `${finalText}\n\n${diff}`
          : finalText
      // A run that aborted on a terminal stream error (stopReason="error") is
      // a FAILURE even if it emitted text. The request-boundary backstop puts
      // an actionable diagnostic in the assistant text on a predicted
      // overflow; a raw upstream error arrives with empty text. Surface the
      // diagnostic when present, else a generic sanitized message — never echo
      // a raw upstream error body, and never report an error as success.
      if (lastStopReason === "error") {
        const diag = (terminalText ?? finalText).trim()
        return {
          text:
            diag
            || "Worker run failed before producing an answer — the model's input "
              + "likely overflowed (a large tool result), or the upstream errored. "
              + "Retry with a narrower task: target a specific section / file / "
              + "element rather than reading everything at once.",
          isError: true,
        }
      }
      // Never return empty text — the harness has no signal to act on.
      if (!text.trim()) {
        return {
          text:
            `${NO_OUTPUT_PREFIX} `
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

/**
 * Prefix of the sentinel `runWorkerAgentOnce` returns when a worker stops
 * CLEANLY but emits no usable text — the model occasionally ends a turn right
 * after a tool call without summarizing. Stable so the retry wrapper can detect
 * exactly this case. Distinct from a budget cap (`WorkerAbort` → halt message),
 * a stream error (`stopReason="error"` → overflow/upstream diagnostic), and a
 * real failure — none of which carry this prefix, so none are retried.
 */
const NO_OUTPUT_PREFIX = "[worker exited with no output"

/** True iff `r` is the transient no-output sentinel (a clean stop with empty
 *  text), the one case worth a fresh retry. */
function isTransientNoOutput(r: WorkerAgentResult): boolean {
  return r.isError === true && typeof r.text === "string" && r.text.startsWith(NO_OUTPUT_PREFIX)
}

/**
 * Run `runOnce`, and on the transient no-output sentinel retry EXACTLY ONCE with
 * a fresh run before surfacing it. Real errors, budget caps, and stream errors
 * are returned as-is (they have distinct, actionable messages and a retry would
 * not help). A consumed abort signal short-circuits the retry. If the retry also
 * produces no output, the ORIGINAL is returned (one is enough signal; the
 * failure isn't hidden). Extracted + injected for unit-testability.
 */
export async function withNoOutputRetry(
  runOnce: (opts: WorkerAgentOpts) => Promise<WorkerAgentResult>,
  opts: WorkerAgentOpts,
): Promise<WorkerAgentResult> {
  const first = await runOnce(opts)
  if (!isTransientNoOutput(first) || opts.signal?.aborted) return first
  const second = await runOnce(opts)
  return isTransientNoOutput(second) ? first : second
}

/**
 * Public entry: a worker run with a single transient-no-output retry. Wraps the
 * implementation (`runWorkerAgentOnce`); the signature is unchanged so every
 * caller (MCP dispatch, the orchestration runner) gets the retry for free.
 */
export async function runWorkerAgent(opts: WorkerAgentOpts): Promise<WorkerAgentResult> {
  return withNoOutputRetry(runWorkerAgentOnce, opts)
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
/**
 * Append a single synthetic `user`-role plan reminder to a send-time
 * message view, so the current `update_plan` checklist survives context
 * compaction. Pure: returns the SAME array reference when there's nothing
 * to add, and a NEW array otherwise (never mutates the input). Appends
 * ONLY after a tool-result turn — that's the multi-step boundary where the
 * reminder is useful, and it can never double a `user` turn or split an
 * assistant→toolResult pair. Called inside the engine's `transformContext`,
 * whose output is a send-time view never persisted to the canonical
 * transcript.
 */
export function appendPlanReminder(
  messages: AgentMessage[],
  planState: PlanState,
): AgentMessage[] {
  if (planState.current.length === 0) return messages
  const last = messages[messages.length - 1]
  const lastRole = last ? (last as { role?: unknown }).role : undefined
  // Skip after a user turn (would create two consecutive user messages) and
  // after an assistant turn (would orphan any pending toolCalls / disrupt a
  // terminal assistant message). The plan reminder belongs after toolResults.
  if (lastRole === "user" || lastRole === "assistant") return messages
  const reminder: AgentMessage = {
    role: "user",
    content: `Current plan (update via update_plan if it changed):\n${renderPlan(planState)}`,
    timestamp: Date.now(),
  }
  return [...messages, reminder]
}

export const __testExports = {
  appendPlanReminder,
  extractAssistantText,
  makeModelShim,
  makeNoWorktreeHandle,
  WORKTREE_REGISTRY,
}
