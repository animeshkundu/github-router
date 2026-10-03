import { describe, expect, test } from "bun:test"

import {
  buildDoneDigest,
  buildRebriefContext,
  estimateTokens,
  extractTranscriptSpan,
  REBRIEF_MAX_CHARS,
} from "../src/lib/cheapest-rebrief-context"

const ASK = "Refactor the auth handler across all modules"

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } })
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })
}

function errorResultLine(text: string): string {
  return JSON.stringify({ type: "result", is_error: true, result: text })
}

describe("extractTranscriptSpan", () => {
  test("extracts user/assistant text verbatim (extractive, no rephrase)", () => {
    const span = extractTranscriptSpan(userLine("Fix src/auth.ts:42 now"))
    expect(span?.text).toContain("src/auth.ts:42")
    const assistant = extractTranscriptSpan(assistantLine("Edited src/auth.ts:42"))
    expect(assistant?.text).toContain("src/auth.ts:42")
  })

  test("skips subagent lines", () => {
    expect(
      extractTranscriptSpan(JSON.stringify({ type: "user", parent_tool_use_id: "t1", message: { role: "user", content: "hi" } })),
    ).toBeNull()
  })

  test("collapses Write/Edit bulk input to a marker", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "w1", name: "Write", input: { file: "a.ts", content: "x".repeat(5000) } }],
      },
    })
    const span = extractTranscriptSpan(line)
    expect(span?.text).toMatch(/bulk input/)
    expect(span?.text.length).toBeLessThan(500)
  })

  test("errors outrank noise", () => {
    const err = extractTranscriptSpan(errorResultLine("FAIL: auth_test.ts"))
    const noise = extractTranscriptSpan(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 5 } }))
    expect(err?.priority).toBeLessThan(noise?.priority ?? 99)
  })

  test("never throws on garbage", () => {
    expect(extractTranscriptSpan("not json {{{")).not.toBeUndefined()
    expect(extractTranscriptSpan("")).toBeNull()
  })
})

describe("buildRebriefContext", () => {
  test("pins the original ask verbatim even under budget pressure", () => {
    const lines = Array.from({ length: 60 }, (_, i) => assistantLine(`filler turn ${i} ` + "x".repeat(500)))
    const ctx = buildRebriefContext({ transcriptLines: lines, originalAsk: ASK, maxTokens: 200 })
    expect(ctx.operatorFocus).toBe(ASK)
    expect(ctx.sessionContext).toContain(ASK)
    expect(ctx.sessionContext.length).toBeLessThanOrEqual(REBRIEF_MAX_CHARS)
    expect(ctx.truncated).toBe(true)
  })

  test("refined ask wins caller context", () => {
    const ctx = buildRebriefContext({
      transcriptLines: [userLine("old")],
      originalAsk: ASK,
      refinedAsk: "Focus only on the login route",
      lastAssistantBrief: "stale brief",
    })
    expect(ctx.callerContext).toBe("Focus only on the login route")
  })

  test("keeps identifiers verbatim (file:line preserved)", () => {
    const ctx = buildRebriefContext({
      transcriptLines: [assistantLine("See src/auth/handler.ts:120 and tests/auth_test.ts:8")],
      originalAsk: ASK,
    })
    expect(ctx.sessionExcerpt).toContain("src/auth/handler.ts:120")
    expect(ctx.sessionExcerpt).toContain("tests/auth_test.ts:8")
  })

  test("empty transcript still returns the ask (no throw, no empty context)", () => {
    const ctx = buildRebriefContext({ transcriptLines: [], originalAsk: ASK })
    expect(ctx.sessionContext).toContain(ASK)
    expect(ctx.truncated).toBe(false)
  })

  test("estimateTokens is ~4 chars/token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })

  test("done digest lists tools, files mutated, errors, and recent text", () => {
    const lines = [
      userLine("Fix auth"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Edited the handler." },
            { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/auth/handler.ts", old_string: "a", new_string: "b" } },
          ],
        },
      }),
      errorResultLine("FAIL: tests/auth_test.ts:8 boom"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }] },
      }),
    ]
    const digest = buildDoneDigest(lines)
    expect(digest).toContain("Files mutated: src/auth/handler.ts")
    expect(digest).toContain("Errors:")
    expect(digest).toContain("FAIL: tests/auth_test.ts:8 boom")
    expect(digest).toContain("Tools used: Bash, Edit")
    expect(digest).toContain("Edited the handler.")
    expect(digest.length).toBeLessThanOrEqual(2048)
  })

  test("done digest never invents facts from noise lines", () => {
    const digest = buildDoneDigest(["not json", "{"])
    expect(digest).toBe("")
  })

  test("Write collapse preserves the file path (load-bearing token)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "src/auth/handler.ts", content: "x".repeat(5000) } }],
      },
    })
    const span = extractTranscriptSpan(line)
    expect(span?.text).toContain("src/auth/handler.ts")
    expect(span?.text).toMatch(/bulk input/)
  })

  test("tool dumps are ordered by recency, not mistaken for summaries", () => {
    const dump = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ id: i, value: `item-${i}` })) }, null, 2)
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_result", tool_use_id: "t1", content: dump }] },
    })
    const span = extractTranscriptSpan(line)
    // Raw dump (not error, not from a summary tool) => lowest signal class.
    expect(span?.priority).toBe(4)
  })

  test("survivors render in chronological order, not priority order", () => {
    const lines = [
      assistantLine("old prose turn one"),
      errorResultLine("FAIL: boom in tests/auth_test.ts:8"),
      assistantLine("new prose turn three"),
    ]
    const ctx = buildRebriefContext({ transcriptLines: lines, originalAsk: ASK, maxTokens: 4000 })
    const excerpt = ctx.sessionExcerpt
    expect(excerpt.indexOf("old prose turn one")).toBeLessThan(excerpt.indexOf("FAIL: boom"))
    expect(excerpt.indexOf("FAIL: boom")).toBeLessThan(excerpt.indexOf("new prose turn three"))
  })

  test("long ask is never sliced by excerpt pressure; truncation is reported", () => {
    const longAsk = `Do the thing. Acceptance criteria: ${"criterion ".repeat(2000)}`
    const lines = Array.from({ length: 60 }, (_, i) => assistantLine(`filler turn ${i} ` + "y".repeat(800)))
    const ctx = buildRebriefContext({ transcriptLines: lines, originalAsk: longAsk, maxTokens: 400 })
    expect(ctx.sessionContext).toContain("Acceptance criteria:")
    // The excerpt absorbed the pressure, and the cut is accounted.
    expect(ctx.truncated).toBe(true)
  })
})
