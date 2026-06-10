/**
 * Tests for `src/lib/worker-agent/browse-tools.ts`.
 *
 * NO live browser: every test injects a mock `dispatch` into
 * `buildBrowseTools({ dispatch })`, so nothing touches the real bridge /
 * extension. Covers:
 *
 *   - the full tool surface (12 browser wire tools + 2 synthetic terminals,
 *     in the brief's order);
 *   - wire-name mapping (`navigate` → `browser_navigate`);
 *   - args + AbortSignal pass-through to the dispatcher;
 *   - success text is surfaced as the tool result;
 *   - an `isError` dispatch envelope is surfaced as a thrown error the model
 *     sees (Pi wraps a thrown tool error as an `isError` tool result);
 *   - the synthetic terminals echo their args as JSON, set `terminate`, and
 *     never call the dispatcher;
 *   - schema derivation: the 9 derived tools reuse the `BROWSER_TOOLS`
 *     `inputSchema` (single source of truth), the 3 fold-in tools use the
 *     hand-written literals, and all schemas validate through Pi.
 */

import { describe, expect, test } from "bun:test"

import { BROWSER_TOOLS } from "../src/lib/browser-mcp"
import {
  __testExports,
  BROWSE_TERMINAL_TOOL_NAMES,
  buildBrowseTools,
  formatBrowseTerminalAnswer,
  isBrowseTerminalTool,
  REPORT_INSUFFICIENT_TOOL,
  SUBMIT_ANSWER_TOOL,
  type BrowserDispatch,
  type BrowserToolEnvelope,
} from "../src/lib/worker-agent/browse-tools"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { validateToolArguments } from "../src/vendor/pi/ai/utils/validation.ts"
import type { Tool, ToolCall } from "../src/vendor/pi/ai/types.ts"

// ============================================================
// Fixtures
// ============================================================

interface DispatchCall {
  tool: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

/**
 * A recording mock dispatcher. `reply` produces the envelope for each call;
 * `calls` captures what the tool forwarded so we can assert wire name + args
 * + signal pass-through.
 */
function recordingDispatch(
  reply: (call: DispatchCall) => BrowserToolEnvelope,
): { dispatch: BrowserDispatch; calls: Array<DispatchCall> } {
  const calls: Array<DispatchCall> = []
  const dispatch: BrowserDispatch = async (tool, args, signal) => {
    calls.push({ tool, args, signal })
    return reply({ tool, args, signal })
  }
  return { dispatch, calls }
}

/** Dispatcher that fails the test if invoked (terminal tools must not call it). */
const explodingDispatch: BrowserDispatch = async (tool) => {
  throw new Error(`dispatch must not be called, got: ${tool}`)
}

function textEnvelope(text: string, isError?: boolean): BrowserToolEnvelope {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] }
}

function toolByName(
  tools: Array<AgentTool>,
  name: string,
): AgentTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool "${name}" not found`)
  return t
}

function resultText(r: { content: Array<{ type: string; text?: string }> }): string {
  const c = r.content[0]
  return c && c.type === "text" ? (c.text ?? "") : ""
}

/** Bare → wire name for the 12 browser tools, in the brief's order. */
const BROWSER_TOOL_NAMES = [
  "navigate",
  "open_tab",
  "close_tab",
  "read_page",
  "screenshot",
  "scroll",
  "wait",
  "eval_js",
  "click",
  "fill",
  "locate",
  "find",
] as const

// ============================================================
// Surface
// ============================================================

describe("buildBrowseTools surface", () => {
  test("exposes 12 browser tools + 2 terminals in the brief's order", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    expect(tools.map((t) => t.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      SUBMIT_ANSWER_TOOL,
      REPORT_INSUFFICIENT_TOOL,
    ])
  })

  test("every tool carries a well-formed object schema, label, description", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    for (const t of tools) {
      expect(typeof t.label).toBe("string")
      expect(t.label.length).toBeGreaterThan(0)
      expect(typeof t.description).toBe("string")
      expect(t.description.length).toBeGreaterThan(0)
      expect((t.parameters as { type?: string }).type).toBe("object")
      expect(typeof t.execute).toBe("function")
    }
  })

  test("returns fresh tool objects each call", () => {
    const a = buildBrowseTools({ dispatch: explodingDispatch })
    const b = buildBrowseTools({ dispatch: explodingDispatch })
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })

  test("mutating input tools are sequential; read-only tools stay parallel-eligible", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    const modeOf = (name: string) =>
      (toolByName(tools, name) as { executionMode?: string }).executionMode
    // State-mutating input → serialized (no concurrent writes to the one tab).
    for (const name of ["navigate", "open_tab", "close_tab", "click", "fill", "scroll"]) {
      expect(modeOf(name)).toBe("sequential")
    }
    // Read-only → parallel-eligible (executionMode omitted).
    for (const name of ["read_page", "screenshot", "eval_js", "find", "locate", "wait"]) {
      expect(modeOf(name)).toBeUndefined()
    }
  })
})

// ============================================================
// Wire-name mapping + args/signal passthrough + text surface
// ============================================================

describe("browser tools dispatch correctly", () => {
  for (const bare of BROWSER_TOOL_NAMES) {
    test(`${bare} → browser_${bare}, args + signal pass through, text surfaced`, async () => {
      const { dispatch, calls } = recordingDispatch(() => textEnvelope("RESULT-OK"))
      const tools = buildBrowseTools({ dispatch })
      const tool = toolByName(tools, bare)

      const args = { tabId: 7, marker: `arg-${bare}` }
      const signal = new AbortController().signal
      const r = await tool.execute("call-1", args, signal)

      expect(calls).toHaveLength(1)
      expect(calls[0]!.tool).toBe(`browser_${bare}`)
      expect(calls[0]!.args).toEqual(args)
      expect(calls[0]!.signal).toBe(signal)
      expect(resultText(r)).toBe("RESULT-OK")
    })
  }

  test("non-object params are normalized to an empty args record", async () => {
    const { dispatch, calls } = recordingDispatch(() => textEnvelope("ok"))
    const tools = buildBrowseTools({ dispatch })
    // params can be anything Pi hands us; a malformed call shouldn't crash.
    await toolByName(tools, "read_page").execute("c", undefined as never, undefined)
    expect(calls[0]!.args).toEqual({})
  })

  test("multi-item envelope content is concatenated, not truncated to [0]", async () => {
    const { dispatch } = recordingDispatch(() => ({
      content: [
        { type: "text" as const, text: "part-1" },
        { type: "text" as const, text: "part-2" },
      ],
    }))
    const tools = buildBrowseTools({ dispatch })
    const r = await toolByName(tools, "read_page").execute("c", { tabId: 1 }, undefined)
    expect(resultText(r)).toBe("part-1\npart-2")
  })
})

// ============================================================
// Error surfacing
// ============================================================

describe("isError envelopes surface as model-visible errors", () => {
  test("re-throws the dispatch error text (so Pi marks the result isError)", async () => {
    const { dispatch } = recordingDispatch(() =>
      textEnvelope("no element matched intent", true),
    )
    const tools = buildBrowseTools({ dispatch })
    await expect(
      toolByName(tools, "click").execute("c", { tabId: 1, ref: "e9" }, undefined),
    ).rejects.toThrow("no element matched intent")
  })

  test("blocked-URL JSON envelope is surfaced verbatim in the thrown error", async () => {
    const blocked = JSON.stringify({ blocked: true, reason: "settings page" })
    const { dispatch } = recordingDispatch(() => textEnvelope(blocked, true))
    const tools = buildBrowseTools({ dispatch })
    await expect(
      toolByName(tools, "navigate").execute(
        "c",
        { tabId: 1, action: "goto", url: "chrome://settings" },
        undefined,
      ),
    ).rejects.toThrow(blocked)
  })

  test("isError with no text falls back to a named error", async () => {
    const { dispatch } = recordingDispatch(() => ({ content: [], isError: true }))
    const tools = buildBrowseTools({ dispatch })
    await expect(
      toolByName(tools, "open_tab").execute("c", { url: "http://x" }, undefined),
    ).rejects.toThrow("browser_open_tab failed")
  })
})

// ============================================================
// Terminal tools
// ============================================================

describe("synthetic terminal tools", () => {
  test("submit_answer echoes args as JSON, sets terminate, never dispatches", async () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    const args = { status: "complete", answer: "XOM_7f3a91", evidence: "cross-origin frame" }
    const r = await toolByName(tools, SUBMIT_ANSWER_TOOL).execute("c", args, undefined)
    expect(JSON.parse(resultText(r))).toEqual(args)
    expect(r.terminate).toBe(true)
  })

  test("report_insufficient echoes args as JSON, sets terminate, never dispatches", async () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    const args = { reason: "no phone number anywhere on the page" }
    const r = await toolByName(tools, REPORT_INSUFFICIENT_TOOL).execute("c", args, undefined)
    expect(JSON.parse(resultText(r))).toEqual(args)
    expect(r.terminate).toBe(true)
  })

  test("terminal-name helpers", () => {
    expect(isBrowseTerminalTool(SUBMIT_ANSWER_TOOL)).toBe(true)
    expect(isBrowseTerminalTool(REPORT_INSUFFICIENT_TOOL)).toBe(true)
    expect(isBrowseTerminalTool("navigate")).toBe(false)
    expect([...BROWSE_TERMINAL_TOOL_NAMES].sort()).toEqual(
      [REPORT_INSUFFICIENT_TOOL, SUBMIT_ANSWER_TOOL].sort(),
    )
  })
})

describe("formatBrowseTerminalAnswer (engine surfaces the terminal payload)", () => {
  // The agent finishes by CALLING a terminal tool, so its answer is in the
  // tool args — NOT in assistant text. Without this formatter the engine saw
  // empty text and returned "[worker exited with no output]" on success.
  test("submit_answer complete: answer + evidence", () => {
    expect(
      formatBrowseTerminalAnswer(SUBMIT_ANSWER_TOOL, {
        status: "complete",
        answer: "XOM_7f3a91",
        evidence: "cross-origin frame",
      }),
    ).toBe("XOM_7f3a91\n\nEvidence: cross-origin frame")
  })

  test("submit_answer blocked: prefixes the blocker", () => {
    expect(
      formatBrowseTerminalAnswer(SUBMIT_ANSWER_TOOL, {
        status: "blocked",
        answer: "Cloudflare Turnstile challenge",
        evidence: "full-page interstitial",
      }),
    ).toBe("Blocked: Cloudflare Turnstile challenge\n\nEvidence: full-page interstitial")
  })

  test("submit_answer without evidence omits the Evidence line", () => {
    expect(
      formatBrowseTerminalAnswer(SUBMIT_ANSWER_TOOL, {
        status: "complete",
        answer: "42",
        evidence: "",
      }),
    ).toBe("42")
  })

  test("report_insufficient: honest no-data outcome", () => {
    expect(
      formatBrowseTerminalAnswer(REPORT_INSUFFICIENT_TOOL, {
        reason: "no phone number in any frame or footer",
      }),
    ).toBe("Insufficient evidence: no phone number in any frame or footer")
  })

  test("report_insufficient with partial labels it as NOT the answer", () => {
    expect(
      formatBrowseTerminalAnswer(REPORT_INSUFFICIENT_TOOL, {
        reason: "no support phone present",
        partial: "a generic contact form",
      }),
    ).toBe(
      "Insufficient evidence: no support phone present\n\n" +
        "Partial (NOT the requested value): a generic contact form",
    )
  })

  test("empty answer returns '' so the engine falls back to assistant text", () => {
    expect(
      formatBrowseTerminalAnswer(SUBMIT_ANSWER_TOOL, {
        status: "complete",
        answer: "",
        evidence: "",
      }),
    ).toBe("")
  })

  test("non-object / missing args degrade gracefully (no throw)", () => {
    expect(formatBrowseTerminalAnswer(SUBMIT_ANSWER_TOOL, null)).toBe("")
    expect(formatBrowseTerminalAnswer(REPORT_INSUFFICIENT_TOOL, undefined)).toBe(
      "Insufficient evidence: the requested value was not found on the page.",
    )
  })
})

// ============================================================
// Schema derivation
// ============================================================

describe("schema derivation", () => {
  const DERIVED = [
    "navigate",
    "open_tab",
    "close_tab",
    "read_page",
    "screenshot",
    "scroll",
    "wait",
    "eval_js",
    "find",
  ] as const

  for (const bare of DERIVED) {
    test(`${bare} reuses the BROWSER_TOOLS inputSchema (single source of truth)`, () => {
      const tools = buildBrowseTools({ dispatch: explodingDispatch })
      const upstream = BROWSER_TOOLS.find((t) => t.toolNameHttp === `browser_${bare}`)
      expect(upstream).toBeDefined()
      // Identity, not just deep-equality — proves we forward the upstream
      // object rather than a divergent copy.
      expect(toolByName(tools, bare).parameters as unknown).toBe(
        upstream!.inputSchema as unknown,
      )
    })
  }

  test("fold-in tools use the hand-written literal schemas", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    expect(toolByName(tools, "click").parameters as unknown).toBe(
      __testExports.CLICK_SCHEMA as unknown,
    )
    expect(toolByName(tools, "fill").parameters as unknown).toBe(
      __testExports.FILL_SCHEMA as unknown,
    )
    expect(toolByName(tools, "locate").parameters as unknown).toBe(
      __testExports.LOCATE_SCHEMA as unknown,
    )
  })

  test("inputSchemaFor throws for an unknown wire tool (fail-loud)", () => {
    expect(() => __testExports.inputSchemaFor("browser_does_not_exist")).toThrow(
      "no longer in BROWSER_TOOLS",
    )
  })
})

// ============================================================
// Pi accepts every schema (validation smoke)
// ============================================================

describe("Pi validates the tool schemas", () => {
  function validate(tool: AgentTool, args: Record<string, unknown>): unknown {
    const piTool = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } as Tool
    const tc = {
      type: "toolCall",
      id: "x",
      name: tool.name,
      arguments: args,
    } as unknown as ToolCall
    return validateToolArguments(piTool, tc)
  }

  test("valid args pass for derived + fold-in + terminal tools", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    expect(validate(toolByName(tools, "navigate"), { tabId: 1, action: "reload" })).toEqual({
      tabId: 1,
      action: "reload",
    })
    expect(validate(toolByName(tools, "click"), { tabId: 2, ref: "e1" })).toEqual({
      tabId: 2,
      ref: "e1",
    })
    expect(
      validate(toolByName(tools, SUBMIT_ANSWER_TOOL), {
        status: "blocked",
        answer: "login wall",
        evidence: "redirected to /login",
      }),
    ).toMatchObject({ status: "blocked" })
  })

  test("string tabId is coerced to a number (sloppy-model tolerance)", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    expect(validate(toolByName(tools, "locate"), { tabId: "3", ref: "e2" })).toEqual({
      tabId: 3,
      ref: "e2",
    })
  })

  test("bad enum / missing-required / extra-prop are rejected", () => {
    const tools = buildBrowseTools({ dispatch: explodingDispatch })
    // bad enum
    expect(() =>
      validate(toolByName(tools, "read_page"), { tabId: 1, mode: "bogus" }),
    ).toThrow()
    // missing required (submit_answer needs status/answer/evidence)
    expect(() =>
      validate(toolByName(tools, SUBMIT_ANSWER_TOOL), { status: "complete" }),
    ).toThrow()
    // additionalProperties:false on a fold-in schema
    expect(() =>
      validate(toolByName(tools, "fill"), { tabId: 1, value: "x", junk: true }),
    ).toThrow()
  })
})
