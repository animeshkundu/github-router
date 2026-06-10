/**
 * Browse-mode Pi `AgentTool` array — the toolset a Pi worker agent loops
 * over to drive a real Chrome / Edge tab through the browser-MCP bridge.
 *
 * Sibling to `tools.ts` (`buildWorkerTools`); the engine consumes this array
 * the SAME way (`Agent.initialState.tools`), so every tool follows Pi's
 * `AgentTool<TParameters, TDetails>` contract verbatim:
 *
 *   execute(toolCallId, params, signal?, onUpdate?) →
 *     Promise<AgentToolResult<TDetails>>
 *
 * Two families:
 *
 *   1. Browser WIRE tools (12). The Pi tool `name` is the BARE name
 *      (`navigate`); `execute` re-adds the `browser_` prefix when it
 *      forwards to `dispatchBrowserTool("browser_navigate", args, signal)`,
 *      so the extension still sees its unchanged wire string.
 *
 *        - Nine schemas are DERIVED from the matching `inputSchema` in
 *          `BROWSER_TOOLS` (`src/lib/browser-mcp/index.ts`), looked up by
 *          `toolNameHttp` — single source of truth, so an upstream schema
 *          change propagates here. Pi validates raw JSON-schema objects
 *          natively (the `!hasTypeBoxMetadata && isJsonSchemaObject` branch
 *          in `pi/ai/utils/validation.ts`) and `stream-fn.ts`'s
 *          `translateTools` ships them to the wire as-is, so no TypeBox
 *          round-trip is needed.
 *        - Three (`click` / `fill` / `locate`) are folded into `browser_act`
 *          upstream and absent from `BROWSER_TOOLS`, so their schemas are
 *          written here to match the extension handlers (`toolClick` /
 *          `toolFill` / `toolLocate` in `src/browser-ext/background.js`,
 *          kept in lockstep with `scripts/gate-b/tooldefs.ts`).
 *
 *      The schema lookup is deferred to `buildBrowseTools()` call time (NOT
 *      module init) so importing this module never throws — only an actual
 *      browse run pays the fail-loud check.
 *
 *   2. Two SYNTHETIC terminal tools (`submit_answer` / `report_insufficient`)
 *      the agent calls to FINISH. They never touch the browser — `execute`
 *      echoes the validated args back as JSON text and sets `terminate: true`
 *      so Pi stops the loop after the call. The runner detects the terminal
 *      state from the tool name + echoed JSON (see `BROWSE_TERMINAL_TOOL_NAMES`).
 *
 * Error convention (matches `tools.ts`): a browser dispatch that comes back
 * `isError: true` is re-thrown as `Error(text)` so Pi's agent-loop wraps it
 * as an `isError` tool result the model SEES on the next turn (verified at
 * `pi/agent/agent-loop.ts:656-662`) and the loop continues — the agent can
 * react (gather more, try another path, report the blocker) instead of
 * silently swallowing a failure. A success returns the dispatch text verbatim.
 *
 * Factory pattern: `buildBrowseTools()` returns a fresh `AgentTool[]` per
 * run. `dispatch` is injectable so unit tests pass a mock and never drive a
 * live browser.
 */

import type {
  AgentTool,
  AgentToolResult,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core"
import type { TSchema } from "@earendil-works/pi-ai"

import { BROWSER_TOOLS } from "~/lib/browser-mcp"
import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"
import {
  assertSessionOwnsTab,
  recordSessionTab,
  releaseSessionTab,
} from "~/lib/browser-mcp/session-registry"

// ============================================================
// Types
// ============================================================

/** The MCP tool-result envelope `dispatchBrowserTool` returns. */
export interface BrowserToolEnvelope {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * The browser-dispatch dependency. The real implementation is
 * `dispatchBrowserTool`; unit tests inject a mock so no live browser is
 * touched. Matches the dispatcher's `(tool, args, signal?)` signature.
 */
export type BrowserDispatch = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BrowserToolEnvelope>

export interface BuildBrowseToolsOpts {
  /** Browser-call dependency. Defaults to the real `dispatchBrowserTool`. */
  dispatch?: BrowserDispatch
  /**
   * When set, enable tab-ownership enforcement against this browse session
   * (multi-session-parallel mode): `open_tab` records the new tab, every
   * tab-bearing tool asserts ownership before dispatch, `close_tab` releases.
   * Omit for Gate B / single-session — no enforcement, behaves as before.
   */
  sessionId?: string
}

type BrowseAgentTool = AgentTool<TSchema, Record<string, never>>

/**
 * Wire-tool metadata. `parameters` is resolved at build time: when
 * `literalSchema` is set it's used directly (the fold-in tools); otherwise
 * the schema is derived from `BROWSER_TOOLS` by `toolNameHttp`.
 *
 * `executionMode` refines the engine's agent-level `toolExecution: "parallel"`
 * per tool, exactly as `edit`/`write`/`bash` do in `tools.ts`:
 *   - read-only tools (read_page, screenshot, eval_js, find, locate, wait)
 *     omit it → parallel-eligible (the agent can fire several reads at once).
 *   - state-mutating input tools (navigate, open_tab, close_tab, click, fill,
 *     scroll) set "sequential" → the model can't fire two mutating actions
 *     concurrently against the single shared tab (CDP input + tab state is
 *     global per attachment; concurrent mutations race). Parallel reads,
 *     serialized writes.
 */
interface WireToolMeta {
  /** Bare Pi tool name. Wire name dispatched is `browser_<name>`. */
  name: string
  label: string
  description: string
  /** Hand-written schema for fold-in tools absent from `BROWSER_TOOLS`. */
  literalSchema?: TSchema
  /** Per-tool execution mode. Omit = parallel-eligible; "sequential" = serialized. */
  executionMode?: ToolExecutionMode
}

// ============================================================
// Helpers
// ============================================================

/** Wrap a text payload in Pi's tool-result shape (empty `details`). */
function textResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text }],
    details: {},
  }
}

/** Narrow Pi's `Static<TSchema>` (≈ `unknown`) to an args record. */
function argsRecord(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}

/**
 * Flatten every text item in a dispatch envelope. `dispatchBrowserTool`
 * returns a single text item today, but joining defensively means a future
 * multi-chunk payload (or a richer error envelope) isn't silently truncated
 * to its first block. Matches the `content.map(c => c.text).join(...)` idiom
 * `tools.ts` uses for `peer_review`.
 */
function joinEnvelopeText(env: BrowserToolEnvelope): string {
  return (env.content ?? []).map((c) => c.text).join("\n")
}

/**
 * How a tool interacts with a session's owned tabs:
 *   - "opens"  — `open_tab` (no tabId in; records the returned tabId);
 *   - "closes" — `close_tab` (takes a `tabIds` array; asserts + releases each);
 *   - "uses"   — every other tool (takes a single `tabId`; asserts ownership).
 */
function tabPolicyFor(name: string): "opens" | "closes" | "uses" {
  if (name === "open_tab") return "opens"
  if (name === "close_tab") return "closes"
  return "uses"
}

/** Numeric members of an unknown value that may be a `tabIds` array. */
function toNumberArray(v: unknown): Array<number> {
  return Array.isArray(v)
    ? v.filter((x): x is number => typeof x === "number")
    : []
}

/** Parse the `tabId` field out of `open_tab`'s JSON text result. */
function parseOpenedTabId(text: string): number | undefined {
  try {
    const parsed = JSON.parse(text) as { tabId?: unknown }
    return typeof parsed.tabId === "number" ? parsed.tabId : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a wire tool's JSON-schema from `BROWSER_TOOLS` by `toolNameHttp`.
 * Throws (fail-loud) if the wire tool is no longer present upstream — same
 * breakage signal as `scripts/gate-b/tooldefs.ts` so a rename is caught at
 * build time, not silently shipped as a tool with no schema.
 */
function inputSchemaFor(wireName: string): TSchema {
  const spec = BROWSER_TOOLS.find((t) => t.toolNameHttp === wireName)
  if (!spec) {
    throw new Error(
      `browse-tools: wire tool "${wireName}" is no longer in BROWSER_TOOLS — `
        + "update WIRE_TOOL_META or hand-write its schema.",
    )
  }
  return spec.inputSchema as unknown as TSchema
}

// ============================================================
// Fold-in schemas (click / fill / locate)
// ============================================================
//
// Folded into `browser_act` at the MCP surface and absent from
// `BROWSER_TOOLS`. Schemas mirror the extension's `toolClick` / `toolFill` /
// `toolLocate` arg parsing in `src/browser-ext/background.js`.

const CLICK_SCHEMA = {
  type: "object",
  required: ["tabId"],
  additionalProperties: false,
  properties: {
    tabId: { type: "number", description: "Tab id from open_tab / list_tabs." },
    ref: {
      type: "string",
      description:
        "Element ref from read_page / locate (preferred). Pass exactly one of ref or selector.",
    },
    selector: {
      type: "string",
      description: "CSS selector (fallback when no ref is available).",
    },
    button: {
      type: "string",
      enum: ["left", "right"],
      description: "Mouse button. Default 'left'. 'right' fires a contextmenu event.",
    },
    clickCount: {
      type: "number",
      description: "Number of clicks to dispatch. Default 1.",
    },
  },
} as const

const FILL_SCHEMA = {
  type: "object",
  required: ["tabId", "value"],
  additionalProperties: false,
  properties: {
    tabId: { type: "number", description: "Tab id from open_tab / list_tabs." },
    ref: {
      type: "string",
      description:
        "Element ref from read_page / locate (preferred). Pass exactly one of ref or selector.",
    },
    selector: {
      type: "string",
      description: "CSS selector (fallback when no ref is available).",
    },
    value: {
      type: "string",
      description: "Value to set. For checkbox/radio a truthy string checks the box.",
    },
    clearFirst: {
      type: "boolean",
      description: "Clear the field before typing. Default true.",
    },
    pressEnter: {
      type: "boolean",
      description: "Dispatch Enter after filling (submit search boxes). Default false.",
    },
  },
} as const

const LOCATE_SCHEMA = {
  type: "object",
  required: ["tabId"],
  additionalProperties: false,
  properties: {
    tabId: { type: "number", description: "Tab id from open_tab / list_tabs." },
    ref: {
      type: "string",
      description: "Element ref from read_page (preferred). Pass exactly one of ref or selector.",
    },
    selector: {
      type: "string",
      description: "CSS selector. Pass exactly one of ref or selector.",
    },
  },
} as const

// ============================================================
// Wire-tool table (terse, agent-facing descriptions)
// ============================================================
//
// Order is stable and matches the brief: descriptions guide a small fast
// model, so they stay short and concrete and encode the "gather more before
// you conclude, report blockers, don't bypass" spirit where it matters.

const WIRE_TOOL_META: ReadonlyArray<WireToolMeta> = [
  {
    name: "navigate",
    label: "Navigate tab",
    description:
      "Navigate an existing tab: goto a URL, or go back / forward / reload. Same URL block as open_tab — a blocked nav returns {blocked,reason}; report it, don't route around it.",
    executionMode: "sequential",
  },
  {
    name: "open_tab",
    label: "Open tab",
    description:
      "Open a URL in a new tab and wait for load. Returns the new tab id, final URL after redirects, and HTTP status. Stick to ONE tab for the task.",
    executionMode: "sequential",
  },
  {
    name: "close_tab",
    label: "Close tabs",
    description: "Close one or more tabs by id.",
    executionMode: "sequential",
  },
  {
    name: "read_page",
    label: "Read page",
    description:
      "Snapshot the page for reasoning: visible text + interactive elements with stable refs + viewport. mode 'summary' (default) = viewport-visible; 'full' = enumerate off-screen. Read again after any action that mutates the page. Absence in one snapshot is not proof — scroll / wait / check frames before concluding a value is missing.",
  },
  {
    name: "screenshot",
    label: "Screenshot",
    description:
      "PNG of the visible viewport (base64). Use when text isn't enough — canvas / charts / visual layout.",
  },
  {
    name: "scroll",
    label: "Scroll",
    description:
      "Scroll a tab: top / bottom / by pixels / to an element (ref) / wheel at a pointer (for inner scroll containers). Bring off-screen content into view before you read it.",
    executionMode: "sequential",
  },
  {
    name: "wait",
    label: "Wait",
    description:
      "Wait for an element (selector), a URL match, or network idle. Use after navigation or an action that loads content asynchronously, before deciding the content is absent.",
  },
  {
    name: "eval_js",
    label: "Eval JS",
    description:
      "Evaluate a JS expression in the page (DevTools-console equivalent). Returns {result} or {error}. Escape hatch to reach DOM / iframe / shadow-root content the other tools can't read. Report what the page returns; never invent a value.",
  },
  {
    name: "click",
    label: "Click",
    description:
      "Click an element by ref (from read_page / locate) or CSS selector. Returns {ok, navigated}. Use for buttons, links, and consent / accept controls.",
    literalSchema: CLICK_SCHEMA as unknown as TSchema,
    executionMode: "sequential",
  },
  {
    name: "fill",
    label: "Fill field",
    description:
      "Set a form field's value (input / textarea / select / checkbox / radio) by ref or selector; goes through the native setter so React onChange fires. pressEnter to submit a search box.",
    literalSchema: FILL_SCHEMA as unknown as TSchema,
    executionMode: "sequential",
  },
  {
    name: "locate",
    label: "Locate element",
    description:
      "Resolve a ref or selector to its geometry: bounding box, center, viewport, and visibility / in-view flags. Confirm an element exists and is visible before acting on it.",
    literalSchema: LOCATE_SCHEMA as unknown as TSchema,
  },
  {
    name: "find",
    label: "Find elements",
    description:
      "Find up to 5 elements matching a natural-language intent ('the Accept button', 'the search box'). Returns ranked refs to pass to click. Cheaper than read_page when you already know what you're after.",
  },
]

// ============================================================
// Terminal tools (submit_answer / report_insufficient)
// ============================================================

export const SUBMIT_ANSWER_TOOL = "submit_answer"
export const REPORT_INSUFFICIENT_TOOL = "report_insufficient"

/** Tool names the runner treats as loop-terminating. */
export const BROWSE_TERMINAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  SUBMIT_ANSWER_TOOL,
  REPORT_INSUFFICIENT_TOOL,
])

export function isBrowseTerminalTool(name: string): boolean {
  return BROWSE_TERMINAL_TOOL_NAMES.has(name)
}

/**
 * Render a terminal tool's validated args into the human-readable answer the
 * browse run returns to its caller.
 *
 * Load-bearing: the agent finishes by CALLING a terminal tool, so its answer
 * lives in the tool-call ARGS, not in any assistant text. The terminal turn's
 * assistant message is just the tool call (stopReason=toolUse, usually no
 * text), so without this the engine would see empty `finalText` and report
 * "[worker exited with no output]" on a perfectly successful run. The engine
 * captures the args in `beforeToolCall` and routes them through here.
 *
 * Returns "" only when the model called a terminal with an empty payload; the
 * engine treats that as "no answer" and falls back to assistant text.
 */
export function formatBrowseTerminalAnswer(name: string, args: unknown): string {
  const a = argsRecord(args)
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

  if (name === REPORT_INSUFFICIENT_TOOL) {
    const reason = str(a.reason)
    const partial = str(a.partial)
    const head = reason
      ? `Insufficient evidence: ${reason}`
      : "Insufficient evidence: the requested value was not found on the page."
    return partial
      ? `${head}\n\nPartial (NOT the requested value): ${partial}`
      : head
  }

  // submit_answer
  const answer = str(a.answer)
  const evidence = str(a.evidence)
  if (!answer) return ""
  const head = str(a.status) === "blocked" ? `Blocked: ${answer}` : answer
  return evidence ? `${head}\n\nEvidence: ${evidence}` : head
}

const SUBMIT_ANSWER_SCHEMA = {
  type: "object",
  required: ["status", "answer", "evidence"],
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked"],
      description:
        "'complete' = you OBSERVED the answer on the page. 'blocked' = an un-bypassable barrier (login wall, paywall, captcha) stopped you — describe it in answer.",
    },
    answer: {
      type: "string",
      description:
        "The exact value you observed (status=complete), or the blocker description (status=blocked). Never a guessed or inferred value.",
    },
    evidence: {
      type: "string",
      description:
        "Where you saw it: which frame / element / section, plus the surrounding text that confirms it.",
    },
  },
} as const

const REPORT_INSUFFICIENT_SCHEMA = {
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      description:
        "What you searched (frames, sections, elements) and why the value is absent. The honest outcome when the data is not on the page.",
    },
    partial: {
      type: "string",
      description:
        "Optional related-but-insufficient information you did find, clearly labeled as NOT the requested value.",
    },
  },
} as const

const SUBMIT_ANSWER_DESCRIPTION =
  "Finish the task. status='complete' with the EXACT value you observed on the page (never a guess or inference); status='blocked' when an un-bypassable barrier (login wall, paywall, captcha) stops you — put the blocker in answer. evidence = where you saw it. If the value isn't actually present, call report_insufficient instead — do NOT fabricate."

const REPORT_INSUFFICIENT_DESCRIPTION =
  "Finish by declaring the requested value is NOT present after a genuine search. This is the correct, honest outcome when the data does not exist on the page — never invent a value to avoid calling this. reason = what you searched and why it's absent."

// ============================================================
// Tool factories
// ============================================================

/**
 * Build one browser wire tool. `execute` forwards to
 * `dispatch("browser_<name>", args, signal)` and surfaces the result text;
 * an `isError` envelope is re-thrown so Pi wraps it as a model-visible error.
 *
 * When `sessionId` is set, tab-ownership is enforced: a tab-bearing call
 * asserts ownership BEFORE dispatch (throws → model-visible isError, no side
 * effect), `open_tab` records the new tab AFTER a successful dispatch, and
 * `close_tab` releases each owned tab after it closes. When `sessionId` is
 * undefined, no enforcement runs (Gate B / single-session — unchanged).
 */
function makeBrowserTool(
  meta: WireToolMeta,
  parameters: TSchema,
  dispatch: BrowserDispatch,
  sessionId?: string,
): BrowseAgentTool {
  const wireName = `browser_${meta.name}`
  const policy = tabPolicyFor(meta.name)
  const tool: BrowseAgentTool = {
    name: meta.name,
    label: meta.label,
    description: meta.description,
    parameters,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const args = argsRecord(params)
      // Pre-dispatch ownership guard (the no-mixup invariant). Throwing here
      // happens BEFORE any browser side effect, so a cross-session call is
      // rejected cleanly. Fail CLOSED — never dispatch a tab-bearing call in
      // a session without a passing ownership check.
      if (sessionId) {
        if (policy === "uses") {
          if (!Number.isInteger(args.tabId)) {
            throw new Error(
              `${wireName}: a valid tabId is required in a browse session`,
            )
          }
          assertSessionOwnsTab(sessionId, args.tabId as number)
        } else if (policy === "opens") {
          // `reuseActive` navigates the currently-ACTIVE tab, which may be
          // another session's tab or a user tab — adopting it would breach
          // isolation. A session must open a FRESH tab.
          if (args.reuseActive === true) {
            throw new Error(
              "open_tab: reuseActive is disabled in a browse session (it would "
                + "adopt a tab outside the session); open a fresh tab instead",
            )
          }
        } else {
          // policy === "closes": assert ownership of every tab being closed.
          for (const tabId of toNumberArray(args.tabIds)) {
            assertSessionOwnsTab(sessionId, tabId)
          }
        }
      }
      const env = await dispatch(wireName, args, signal)
      const text = joinEnvelopeText(env)
      if (env.isError) {
        // Re-throw so Pi's loop records an isError tool result the model
        // sees and can react to (gather more / try another path / report
        // the blocker) — never bypass.
        throw new Error(text || `${wireName} failed`)
      }
      // Post-dispatch session bookkeeping (only on success).
      if (sessionId) {
        if (policy === "opens") {
          const tabId = parseOpenedTabId(text)
          if (typeof tabId === "number") recordSessionTab(sessionId, tabId)
        } else if (policy === "closes") {
          for (const tabId of toNumberArray(args.tabIds)) {
            releaseSessionTab(sessionId, tabId)
          }
        }
      }
      return textResult(text)
    },
  }
  // Only declare executionMode when set, mirroring `tools.ts` (which marks
  // only the sequential write tools); omission leaves the tool parallel-
  // eligible under the engine's agent-level toolExecution.
  if (meta.executionMode) tool.executionMode = meta.executionMode
  return tool
}

/**
 * Build a synthetic terminal tool. `execute` never touches the browser — it
 * echoes the validated args back as JSON text and sets `terminate: true` so
 * Pi stops the loop after this call. The runner reads the final answer from
 * the echoed JSON + the tool name.
 */
function makeTerminalTool(
  name: string,
  label: string,
  description: string,
  parameters: TSchema,
): BrowseAgentTool {
  return {
    name,
    label,
    description,
    parameters,
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, never>>> {
      return {
        content: [{ type: "text", text: JSON.stringify(argsRecord(params)) }],
        details: {},
        terminate: true,
      }
    },
  }
}

// ============================================================
// Public surface
// ============================================================

/**
 * Build the browse-mode `AgentTool` array: 12 browser wire tools followed
 * by the 2 synthetic terminals, in a stable order (keeps the model's
 * tool-name prediction cache warm — same rationale as `buildWorkerTools`).
 *
 * Each call returns FRESH tool objects; `dispatch` is closure-captured, so
 * two concurrent runs with different dispatchers don't share state. Throws
 * (fail-loud) if a derived wire tool is no longer present in `BROWSER_TOOLS`.
 */
export function buildBrowseTools(
  opts: BuildBrowseToolsOpts = {},
): Array<BrowseAgentTool> {
  const dispatch = opts.dispatch ?? dispatchBrowserTool
  const browser = WIRE_TOOL_META.map((meta) => {
    const parameters = meta.literalSchema ?? inputSchemaFor(`browser_${meta.name}`)
    return makeBrowserTool(meta, parameters, dispatch, opts.sessionId)
  })
  return [
    ...browser,
    makeTerminalTool(
      SUBMIT_ANSWER_TOOL,
      "Submit answer",
      SUBMIT_ANSWER_DESCRIPTION,
      SUBMIT_ANSWER_SCHEMA as unknown as TSchema,
    ),
    makeTerminalTool(
      REPORT_INSUFFICIENT_TOOL,
      "Report insufficient",
      REPORT_INSUFFICIENT_DESCRIPTION,
      REPORT_INSUFFICIENT_SCHEMA as unknown as TSchema,
    ),
  ]
}

// ============================================================
// Test exports
// ============================================================

/**
 * Test-only exports. The public surface is `buildBrowseTools` + the
 * terminal-name helpers; these let the unit tests reach the schemas,
 * factories, and metadata without spinning up the full set.
 */
export const __testExports = {
  argsRecord,
  inputSchemaFor,
  joinEnvelopeText,
  parseOpenedTabId,
  tabPolicyFor,
  toNumberArray,
  makeBrowserTool,
  makeTerminalTool,
  textResult,
  WIRE_TOOL_META,
  CLICK_SCHEMA,
  FILL_SCHEMA,
  LOCATE_SCHEMA,
  SUBMIT_ANSWER_SCHEMA,
  REPORT_INSUFFICIENT_SCHEMA,
}
