/**
 * Worker context-management units: per-run budget, structural compaction, and
 * the tool-output cap. Deterministic, hand-built `AgentMessage[]` + literal
 * `ContextBudget`s (small thresholds for fast fixtures) — no network, no Pi
 * loop. Platform-neutral byte math (`Buffer.byteLength`/`TextEncoder`).
 */

import { describe, expect, test } from "bun:test"

import type { AgentMessage } from "@earendil-works/pi-agent-core"

import {
  type ContextBudget,
  FALLBACK_WINDOW_TOKENS,
  makeContextBudget,
  tokensFromBytes,
} from "../src/lib/worker-agent/context-budget"
import {
  __testExports as compaction,
  compactWorkerContext,
} from "../src/lib/worker-agent/compaction"
import {
  capToolResultText,
  truncateModelText,
} from "../src/lib/worker-agent/tool-output-cap"

// Small budget so modest fixtures cross the thresholds. tokensFromBytes is
// bytes/3, so compactTrigger=100 ⇒ a ~300+ byte message triggers.
const TEST_BUDGET: ContextBudget = {
  windowKnown: true,
  windowTokens: 10_000,
  inputHardLimitTokens: 900,
  promptBudgetTokens: 800,
  compactTriggerTokens: 100,
  pruneTargetTokens: 60,
  hardLimitTokens: 200,
  keepRecentTokens: 40,
  maxProtectedTokens: 400,
  perResultCapBytes: 64 * 1024,
}

function user(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage
}
function assistantToolCall(id: string, name: string, args: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "github-copilot",
    model: "test",
    stopReason: "toolUse",
  } as unknown as AgentMessage
}
function toolResult(id: string, name: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: text,
    isError: false,
  } as unknown as AgentMessage
}
function assistantText(text: string, usageTotal?: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "github-copilot",
    model: "test",
    stopReason: "stop",
    ...(usageTotal !== undefined
      ? { usage: { input: usageTotal, output: 0, totalTokens: usageTotal } }
      : {}),
  } as unknown as AgentMessage
}

const MODEL_WINDOW_FIXTURES = [
  { id: "claude-opus-5", windowTokens: 1_000_000 },
  { id: "gemini-3.6-flash", windowTokens: 1_000_000 },
  { id: "gpt-5.6-sol", windowTokens: 1_050_000 },
  { id: "gpt-5.4-mini", windowTokens: 400_000 },
  { id: "gpt-5.3-codex", windowTokens: 272_000 },
  { id: "small-window-canary", windowTokens: 128_000 },
] as const

function overTriggerTranscript(budget: ContextBudget): AgentMessage[] {
  // bytes/3 is the structural floor. Add a fixed margin so this cannot sit on
  // a rounding boundary, and put the bulk in a tool result that can be stubbed.
  const bulkyBytes = budget.compactTriggerTokens * 3 + 1024
  return [
    user("audit context defenses"),
    assistantToolCall("old-read", "read", { path: "fixture.ts" }),
    toolResult("old-read", "read", "Z".repeat(bulkyBytes)),
    user("continue"),
    assistantToolCall("recent-read", "read", { path: "recent.ts" }),
    toolResult("recent-read", "read", "recent result"),
    assistantText("done"),
  ]
}

function assertToolPairing(messages: AgentMessage[]): void {
  const callIds = messages
    .filter((m) => (m as { role?: string }).role === "assistant")
    .flatMap((m) =>
      ((m as { content?: Array<{ type?: string; id?: string }> }).content ?? [])
        .filter((b) => b.type === "toolCall")
        .map((b) => b.id),
    )
  const resultIds = messages
    .filter((m) => (m as { role?: string }).role === "toolResult")
    .map((m) => (m as { toolCallId?: string }).toolCallId)
  expect(callIds).toEqual(resultIds)
}

// ============================================================
// makeContextBudget
// ============================================================

describe("makeContextBudget", () => {
  test("unknown / invalid windows use the conservative defense floor", () => {
    for (const window of [undefined, 0, -5, NaN, Number.POSITIVE_INFINITY]) {
      const budget = makeContextBudget(window)
      expect(budget.windowTokens).toBe(FALLBACK_WINDOW_TOKENS)
      expect(budget.windowKnown).toBe(false)
    }
  })

  test("gpt-5.4-mini-class window yields ordered thresholds + a large read cap", () => {
    const b = makeContextBudget(264_000)!
    expect(b.windowTokens).toBe(264_000)
    expect(b.windowKnown).toBe(true)
    // input bound < window; prompt budget < input bound; thresholds ordered.
    expect(b.inputHardLimitTokens).toBeLessThan(b.windowTokens)
    expect(b.promptBudgetTokens).toBeLessThan(b.inputHardLimitTokens)
    expect(b.pruneTargetTokens).toBeLessThan(b.compactTriggerTokens)
    expect(b.compactTriggerTokens).toBeLessThan(b.hardLimitTokens)
    expect(b.hardLimitTokens).toBeLessThanOrEqual(b.promptBudgetTokens)
    // Per-result cap (0.30·264k·3 ≈ 232KB) sits in the [64KiB, 256KiB] band —
    // large enough that most pages fit one read.
    expect(b.perResultCapBytes).toBeGreaterThanOrEqual(200 * 1024)
    expect(b.perResultCapBytes).toBeLessThanOrEqual(256 * 1024)
  })

  test("per-result cap clamps to the 64KiB floor on a small window", () => {
    const b = makeContextBudget(30_000)!
    expect(b.perResultCapBytes).toBe(64 * 1024)
  })

  test("tokensFromBytes over-counts (bytes/3, conservative)", () => {
    expect(tokensFromBytes(300)).toBe(100)
    expect(tokensFromBytes(0)).toBe(0)
  })
})

describe("cross-model structural compaction", () => {
  for (const { id, windowTokens } of MODEL_WINDOW_FIXTURES) {
    test(`${id}: ordered budget, bounded pairing-safe compaction, deterministic output`, () => {
      const budget = makeContextBudget(windowTokens)
      expect(budget.windowTokens).toBe(windowTokens)
      expect(budget.pruneTargetTokens).toBeLessThan(budget.compactTriggerTokens)
      expect(budget.compactTriggerTokens).toBeLessThan(budget.hardLimitTokens)
      expect(budget.hardLimitTokens).toBeLessThanOrEqual(budget.promptBudgetTokens)
      expect(budget.keepRecentTokens).toBeGreaterThan(0)
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(budget.maxProtectedTokens)
      expect(budget.maxProtectedTokens).toBeLessThan(budget.promptBudgetTokens)

      const transcript = overTriggerTranscript(budget)
      expect(compaction.structuralTokens(transcript)).toBeGreaterThan(
        budget.compactTriggerTokens,
      )

      const out = compactWorkerContext(transcript, budget)
      expect(JSON.stringify(out)).toContain("elided")
      expect(compaction.structuralTokens(out)).toBeLessThanOrEqual(budget.hardLimitTokens)
      expect(out).toHaveLength(transcript.length)
      assertToolPairing(out)

      const repeated = compactWorkerContext(overTriggerTranscript(budget), budget)
      expect(repeated).toEqual(out)
    })
  }

  test("a resolved tool model with no catalog window uses the floor and compacts", () => {
    const resolvedModel = {
      id: "future-tool-model",
      capabilities: { supports: { tool_calls: true }, limits: {} },
    }
    const budget = makeContextBudget(
      (resolvedModel.capabilities.limits as { max_context_window_tokens?: number })
        .max_context_window_tokens,
    )
    expect(budget.windowTokens).toBe(FALLBACK_WINDOW_TOKENS)
    expect(budget.windowKnown).toBe(false)

    const transcript = overTriggerTranscript(budget)
    const out = compactWorkerContext(transcript, budget)
    expect(JSON.stringify(out)).toContain("elided")
    expect(compaction.structuralTokens(out)).toBeLessThanOrEqual(budget.hardLimitTokens)
    expect(out).toHaveLength(transcript.length)
    assertToolPairing(out)
  })
})

describe("worker catalog context-window fixture audit", () => {
  function missingToolModelWindows(catalog: Array<{
    id: string
    capabilities: {
      supports: { tool_calls: boolean }
      limits: { max_context_window_tokens?: number }
    }
  }>): Array<string> {
    return catalog
      .filter((model) => model.capabilities.supports.tool_calls === true)
      .filter((model) => {
        const window = model.capabilities.limits.max_context_window_tokens
        return window === undefined || !Number.isFinite(window) || window <= 0
      })
      .map((model) => model.id)
  }

  test("detects a tool-capable catalog entry with missing window metadata", () => {
    const catalog = [
      ...MODEL_WINDOW_FIXTURES.map(({ id, windowTokens }) => ({
        id,
        capabilities: {
          supports: { tool_calls: true },
          limits: { max_context_window_tokens: windowTokens },
        },
      })),
      {
        id: "future-tool-model-without-window",
        capabilities: { supports: { tool_calls: true }, limits: {} },
      },
      {
        id: "non-tool-model-without-window",
        capabilities: { supports: { tool_calls: false }, limits: {} },
      },
    ]

    expect(missingToolModelWindows(catalog)).toEqual([
      "future-tool-model-without-window",
    ])
  })
})

// ============================================================
// truncateModelText + capToolResultText
// ============================================================

describe("truncateModelText", () => {
  test("under-cap text unchanged", () => {
    expect(truncateModelText("small", 1024)).toBe("small")
  })

  test("over-cap → head+tail+notice, ≤ cap, head & tail preserved", () => {
    const out = truncateModelText("A".repeat(80 * 1024), 16 * 1024)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(out).toContain("truncated")
    expect(out.startsWith("A")).toBe(true)
    expect(out.endsWith("A")).toBe(true)
  })

  test("UTF-8 safe: no replacement char at either boundary", () => {
    const out = truncateModelText("😀".repeat(20 * 1024), 16 * 1024)
    expect(out).not.toContain("�")
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(16 * 1024)
  })

  test("degenerate cap smaller than the notice still respects the cap", () => {
    const out = truncateModelText("X".repeat(1000), 32)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(32)
  })
})

describe("capToolResultText", () => {
  test("under-cap string → undefined (caller leaves it)", () => {
    expect(capToolResultText("ok", 1024)).toBeUndefined()
  })

  test("over-cap string → single capped text block", () => {
    const out = capToolResultText("A".repeat(40 * 1024), 16 * 1024)!
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe("text")
    expect(Buffer.byteLength(out[0]!.text, "utf8")).toBeLessThanOrEqual(16 * 1024)
  })

  test("array content: caps text, PRESERVES image blocks", () => {
    const content = [
      { type: "image", data: "imgdata", mimeType: "image/png" },
      { type: "text", text: "B".repeat(40 * 1024) },
    ]
    const out = capToolResultText(content, 16 * 1024)!
    // image preserved + one capped text block.
    expect(out.some((b) => (b as { type: string }).type === "image")).toBe(true)
    expect(out.some((b) => (b as { type: string }).type === "text")).toBe(true)
  })

  test("image-only result (no text) → undefined (untouched)", () => {
    const content = [{ type: "image", data: "x", mimeType: "image/png" }]
    expect(capToolResultText(content, 16)).toBeUndefined()
  })
})

// ============================================================
// compactWorkerContext
// ============================================================

describe("compactWorkerContext", () => {
  test("below trigger → returns the SAME array reference (lazy, no clone)", () => {
    const msgs = [user("task"), assistantText("short answer")]
    expect(compactWorkerContext(msgs, TEST_BUDGET)).toBe(msgs)
  })

  test("does NOT mutate the input (structuredClone before pruning)", () => {
    const bigResult = toolResult("c1", "read_page", "Z".repeat(2000))
    const msgs = [
      user("task"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      bigResult,
      assistantText("done"),
    ]
    const beforeContent = (bigResult as unknown as { content: string }).content
    compactWorkerContext(msgs, TEST_BUDGET)
    // Original message object untouched (the live transcript must survive).
    expect((bigResult as unknown as { content: string }).content).toBe(beforeContent)
    expect((bigResult as unknown as { content: string }).content.length).toBe(2000)
  })

  test("stubs an OLD tool result; never drops a message; keeps pairing", () => {
    const msgs = [
      user("task"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      toolResult("c1", "read_page", "Z".repeat(3000)), // old, bulky
      user("next"),
      assistantToolCall("c2", "read_page", { tabId: 1 }),
      toolResult("c2", "read_page", "kept recent"),
      assistantText("answer"),
    ]
    const out = compactWorkerContext(msgs, TEST_BUDGET)
    expect(out).not.toBe(msgs) // compacted (a copy)
    expect(out).toHaveLength(msgs.length) // NEVER drops a message
    // Every toolCall id still has a matching toolResult (no orphan → no 400).
    const callIds = out
      .filter((m) => (m as { role?: string }).role === "assistant")
      .flatMap((m) =>
        ((m as { content?: Array<{ type?: string; id?: string }> }).content ?? [])
          .filter((b) => b.type === "toolCall")
          .map((b) => b.id),
      )
    const resultIds = out
      .filter((m) => (m as { role?: string }).role === "toolResult")
      .map((m) => (m as { toolCallId?: string }).toolCallId)
    for (const id of callIds) expect(resultIds).toContain(id)
    // The OLD result was stubbed; the recent one kept.
    const oldRes = out[2] as unknown as { content: unknown }
    expect(JSON.stringify(oldRes.content)).toContain("elided")
  })

  test("structural trigger ignores a stale assistant usage (gemini critical)", () => {
    // Last assistant reports a tiny usage, but the raw transcript is large.
    // A usage-anchored trigger would miss-fire → crash; the structural sum
    // must compact regardless.
    const msgs = [
      user("task"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      toolResult("c1", "read_page", "Z".repeat(5000)),
      assistantText("done", /* usageTotal */ 1),
    ]
    const out = compactWorkerContext(msgs, TEST_BUDGET)
    expect(out).not.toBe(msgs)
    expect(JSON.stringify((out[2] as unknown as { content: unknown }).content)).toContain(
      "elided",
    )
  })

  test("idempotent + convergent: re-compacting the output is stable", () => {
    const msgs = [
      user("task"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      toolResult("c1", "read_page", "Z".repeat(4000)),
      user("n"),
      assistantText("a"),
    ]
    const once = compactWorkerContext(msgs, TEST_BUDGET)
    const twice = compactWorkerContext(once, TEST_BUDGET)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  test("CJK content triggers via the byte floor (char/4 would under-count)", () => {
    // 200 CJK chars = 600 UTF-8 bytes = 200 tokens (bytes/3) > trigger 100.
    // A chars/4 estimate (50) would NOT trigger — proves the byte floor.
    const msgs = [
      user("t"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      toolResult("c1", "read_page", "界".repeat(400)),
      user("n"),
      assistantText("a"),
    ]
    const out = compactWorkerContext(msgs, TEST_BUDGET)
    expect(out).not.toBe(msgs)
  })

  test("stubs oversized assistant tool-call ARGUMENTS, not just results", () => {
    const msgs = [
      user("task"),
      assistantToolCall("c1", "write", { path: "x", contents: "Z".repeat(3000) }),
      toolResult("c1", "write", "ok"),
      user("n"),
      assistantText("a"),
    ]
    const out = compactWorkerContext(msgs, TEST_BUDGET)
    const args = JSON.stringify(
      (
        (out[1] as { content?: Array<{ type?: string; arguments?: unknown }> }).content ?? []
      ).find((b) => b.type === "toolCall")?.arguments,
    )
    expect(args).toContain("elided")
  })

  test("current-turn truncation: escalation bounds a heavy recent turn", () => {
    // Both results sit in the protected recent suffix. Pass 1 prunes nothing;
    // escalation (pass 2 + last-resort pass 3) truncates current-turn results
    // — including the newest as a last resort here, since with this tiny test
    // budget a single result alone exceeds hardLimit — bringing the transcript
    // under the limit instead of overflowing.
    const msgs = [
      user("task"),
      assistantToolCall("c1", "read_page", { tabId: 1 }),
      toolResult("c1", "read_page", "Z".repeat(2000)),
      assistantToolCall("c2", "read_page", { tabId: 2 }),
      toolResult("c2", "read_page", "Y".repeat(2000)),
    ]
    const out = compactWorkerContext(msgs, TEST_BUDGET)
    // The older current-turn result was truncated...
    expect(JSON.stringify((out[2] as unknown as { content: unknown }).content)).toContain(
      "elided",
    )
    // ...and the whole transcript is now bounded (no overflow).
    expect(compaction.structuralTokens(out)).toBeLessThanOrEqual(
      TEST_BUDGET.hardLimitTokens,
    )
  })
})

// ---------------------------------------------------------------------------
// Image budget — images used to bypass every cap in the system
// ---------------------------------------------------------------------------

describe("capToolResultText image budget", () => {
  const img = (bytes: number) => ({
    type: "image" as const,
    mimeType: "image/png",
    // base64 expands 3 bytes to 4 chars; close enough for a budget assertion.
    data: "A".repeat(Math.ceil((bytes * 4) / 3)),
  })

  test("an all-image result is now inspected at all", () => {
    // Previously `textBytes <= capBytes` short-circuited with textBytes === 0,
    // so a result carrying only images was never examined and no budget applied.
    const content = Array.from({ length: 12 }, () => img(1024))
    const out = capToolResultText(content, 64_000)
    expect(out).toBeDefined()
    expect(out!.filter((b) => (b as { type: string }).type === "image")).toHaveLength(10)
  })

  test("dropping images is reported, never silent", () => {
    const content = Array.from({ length: 12 }, () => img(1024))
    const out = capToolResultText(content, 64_000)!
    const text = out.find((b) => b.type === "text")?.text ?? ""
    expect(text).toMatch(/2 of 12 image\(s\) dropped/)
    expect(text).toMatch(/lower quality/i)
  })

  test("a total-bytes runaway is bounded even under the count limit", () => {
    // 5 images x 4 MiB = 20 MiB, under the 10-image count cap but over the
    // 12 MiB byte cap.
    const content = Array.from({ length: 5 }, () => img(4 * 1024 * 1024))
    const out = capToolResultText(content, 64_000)!
    expect(out.filter((b) => (b as { type: string }).type === "image").length).toBeLessThan(5)
  })

  test("a normal result with a couple of images is left completely alone", () => {
    const content = [{ type: "text", text: "small" }, img(1024), img(1024)]
    expect(capToolResultText(content, 64_000)).toBeUndefined()
  })

  test("text is still capped independently of images", () => {
    const content = [{ type: "text", text: "x".repeat(200_000) }, img(1024)]
    const out = capToolResultText(content, 1_000)!
    expect(out.filter((b) => (b as { type: string }).type === "image")).toHaveLength(1)
    expect(out.find((b) => b.type === "text")?.text).toMatch(/truncated/i)
  })
})

describe("image budget does not punish unrelated blocks", () => {
  const img = (bytes: number) => ({
    type: "image" as const,
    mimeType: "image/png",
    data: "A".repeat(Math.ceil((bytes * 4) / 3)),
  })

  test("a non-image, non-text block is preserved and never counted", () => {
    // `images` used to collect EVERY non-text block, so an audio or resource
    // block consumed the image budget and could be dropped by a cap that was
    // never about it.
    const other = { type: "resource", uri: "file:///x" }
    const content = [{ type: "text", text: "t" }, other, ...Array.from({ length: 12 }, () => img(1024))]
    const out = capToolResultText(content, 64_000)!
    expect(out.some((b) => (b as { type: string }).type === "resource")).toBe(true)
  })

  test("one oversized image does not discard the smaller ones behind it", () => {
    // `break` stopped the loop entirely; `continue` skips only the offender.
    const content = [img(20 * 1024 * 1024), img(1024), img(1024)]
    const out = capToolResultText(content, 64_000)!
    expect(out.filter((b) => (b as { type: string }).type === "image")).toHaveLength(2)
    expect(out.find((b) => b.type === "text")?.text).toMatch(/1 of 3 image\(s\) dropped/)
  })
})
