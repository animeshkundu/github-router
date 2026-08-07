import { beforeEach, describe, expect, test } from "bun:test"

import {
  __resetThinkingHistoryRepairsForTests,
  rememberThinkingHistoryRepair,
  repairKnownThinkingHistory,
  repairRejectedThinkingHistory,
} from "../src/lib/thinking-history-repair"

const integrityError =
  "messages.1.content.88: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."

function brokenBody(): string {
  return JSON.stringify({
    model: "claude-opus-5",
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "opaque-signature" },
          { type: "redacted_thinking", data: "opaque-redacted-data" },
          { type: "text", text: "using a tool" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
        ],
      },
    ],
  })
}

beforeEach(() => {
  __resetThinkingHistoryRepairsForTests()
})

describe("thinking history repair", () => {
  test("repairs only the assistant message named by the exact upstream error", () => {
    const repair = repairRejectedThinkingHistory(brokenBody(), integrityError)
    expect(repair).toBeDefined()
    expect(repair!.messageIndex).toBe(1)
    expect(repair!.removedBlocks).toBe(2)

    const parsed = JSON.parse(repair!.body) as {
      thinking: unknown
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(parsed.thinking).toEqual({ type: "adaptive" })
    expect(parsed.messages[1]!.content.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
    ])
    expect(parsed.messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
    ])
  })

  test("unrelated 400 never triggers a repair", () => {
    expect(
      repairRejectedThinkingHistory(
        brokenBody(),
        "messages.1: tool_use ids were found without tool_result blocks",
      ),
    ).toBeUndefined()
  })

  test("invalid thinking signature rejection uses the same bounded repair", () => {
    const repair = repairRejectedThinkingHistory(
      brokenBody(),
      "messages.1.content.0: Invalid `signature` in `thinking` block",
    )
    expect(repair?.removedBlocks).toBe(2)
  })

  test("malformed and out-of-range paths fail closed", () => {
    expect(
      repairRejectedThinkingHistory(
        brokenBody(),
        "messages.99.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
      ),
    ).toBeUndefined()
    expect(
      repairRejectedThinkingHistory(
        brokenBody(),
        "messages.nope.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
      ),
    ).toBeUndefined()
  })

  test("does not produce an empty assistant message", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "only-block" },
          ],
        },
      ],
    })
    expect(
      repairRejectedThinkingHistory(
        body,
        integrityError.replace("messages.1.content.88", "messages.1.content.0"),
      ),
    ).toBeUndefined()
  })

  test("a successful repair fingerprint reapplies without retaining source content", () => {
    const first = repairRejectedThinkingHistory(brokenBody(), integrityError)
    expect(first).toBeDefined()
    expect(first!.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(first!.fingerprint).not.toContain("opaque")

    rememberThinkingHistoryRepair(first!.fingerprint)
    const known = repairKnownThinkingHistory(brokenBody())
    expect(known?.body).toBe(first!.body)
    expect(known?.fingerprint).toBe(first!.fingerprint)
  })
})
