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

  test("recovers a thinking-only assistant turn without emptying it", () => {
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
    const repair = repairRejectedThinkingHistory(
      body,
      integrityError.replace("messages.1.content.88", "messages.1.content.0"),
    )
    // Stripping alone would leave `content: []`, which Anthropic rejects — so
    // the turn is kept alive with a neutral placeholder instead of being
    // abandoned as unrepairable (which bricked the session on every retry).
    expect(repair).toBeDefined()
    const repaired = JSON.parse(repair!.body) as {
      messages: Array<{ role: string; content: Array<Record<string, string>> }>
    }
    expect(repaired.messages[1]!.content).toEqual([
      { type: "text", text: "[prior reasoning omitted]" },
    ])
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

  // The repair rewrites request history, so its blast radius is a safety
  // property: it must never reach instruction-bearing surfaces (system prompt,
  // tool definitions, or user turns — which is where Claude Code's
  // permission-mode reminders live). Only signed blocks in ONE assistant turn
  // may change.
  test("never alters system, tools, or any non-assistant turn", () => {
    const request = {
      model: "claude-opus-4.7",
      system: [{ type: "text", text: "Plan mode is active. Do not edit files." }],
      tools: [{ name: "Edit", input_schema: { type: "object" } }],
      metadata: { user_id: "u1" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>Plan mode is active.</system-reminder>" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "opaque" },
            { type: "text", text: "understood" },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>Still plan mode.</system-reminder>" }],
        },
      ],
    }
    const original = JSON.parse(JSON.stringify(request)) as typeof request
    const repair = repairRejectedThinkingHistory(
      JSON.stringify(request),
      integrityError.replace("messages.1.content.88", "messages.1.content.0"),
    )
    expect(repair).toBeDefined()
    const out = JSON.parse(repair!.body) as typeof request

    expect(out.system).toEqual(original.system)
    expect(out.tools).toEqual(original.tools)
    expect(out.metadata).toEqual(original.metadata)
    expect(out.messages[0]).toEqual(original.messages[0])
    expect(out.messages[2]).toEqual(original.messages[2])
    // Only the signed block in the named assistant turn is gone.
    expect(out.messages[1]!.content).toEqual([{ type: "text", text: "understood" }])
  })

  test("refuses to touch a turn upstream names that is not an assistant turn", () => {
    const request = {
      messages: [
        {
          role: "user",
          content: [{ type: "thinking", thinking: "", signature: "opaque" }],
        },
      ],
    }
    // Even if upstream named index 0, a non-assistant role is out of scope.
    expect(
      repairRejectedThinkingHistory(
        JSON.stringify(request),
        integrityError.replace("messages.1.content.88", "messages.0.content.0"),
      ),
    ).toBeUndefined()
  })
})
