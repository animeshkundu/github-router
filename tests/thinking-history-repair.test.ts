import { beforeEach, describe, expect, test } from "bun:test"

import {
  __resetThinkingHistoryRepairsForTests,
  formatThinkingRepairDecline,
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
  /** Unwrap a successful outcome, failing loudly with the reason if it declined. */
  function repairOf(
    outcome: ReturnType<typeof repairRejectedThinkingHistory>,
  ) {
    if (!outcome.ok) {
      throw new Error(`expected a repair, declined: ${outcome.decline.reason}`)
    }
    return outcome.repair
  }

  /** Assert a decline and return its structured detail. */
  function declineOf(
    outcome: ReturnType<typeof repairRejectedThinkingHistory>,
  ) {
    if (outcome.ok) throw new Error("expected a decline, got a repair")
    return outcome.decline
  }

  test("repairs only the assistant message named by the exact upstream error", () => {
    const repair = repairOf(
      repairRejectedThinkingHistory(brokenBody(), integrityError),
    )
    expect(repair.messageIndex).toBe(1)
    expect(repair.removedBlocks).toBe(2)

    const parsed = JSON.parse(repair.body) as {
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
      declineOf(
        repairRejectedThinkingHistory(
          brokenBody(),
          "messages.1: tool_use ids were found without tool_result blocks",
        ),
      ).reason,
    ).toBe("error-not-recognized")
  })

  test("invalid thinking signature rejection uses the same bounded repair", () => {
    const repair = repairOf(
      repairRejectedThinkingHistory(
        brokenBody(),
        "messages.1.content.0: Invalid `signature` in `thinking` block",
      ),
    )
    expect(repair.removedBlocks).toBe(2)
  })

  test("malformed and out-of-range paths fail closed, and say which", () => {
    // Out of range: the index parses but names no message.
    expect(
      declineOf(
        repairRejectedThinkingHistory(
          brokenBody(),
          "messages.99.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
        ),
      ),
    ).toMatchObject({ reason: "message-missing", messageIndex: 99 })
    // Unparseable index: the error shape is not recognised at all.
    expect(
      declineOf(
        repairRejectedThinkingHistory(
          brokenBody(),
          "messages.nope.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
        ),
      ).reason,
    ).toBe("error-not-recognized")
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
    const repair = repairOf(
      repairRejectedThinkingHistory(
        body,
        integrityError.replace("messages.1.content.88", "messages.1.content.0"),
      ),
    )
    // Stripping alone would leave `content: []`, which Anthropic rejects — so
    // the turn is kept alive with a neutral placeholder instead of being
    // abandoned as unrepairable (which bricked the session on every retry).
    const repaired = JSON.parse(repair.body) as {
      messages: Array<{ role: string; content: Array<Record<string, string>> }>
    }
    expect(repaired.messages[1]!.content).toEqual([
      { type: "text", text: "[prior reasoning omitted]" },
    ])
  })

  test("a successful repair fingerprint reapplies without retaining source content", () => {
    const first = repairOf(
      repairRejectedThinkingHistory(brokenBody(), integrityError),
    )
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(first.fingerprint).not.toContain("opaque")

    rememberThinkingHistoryRepair(first.fingerprint)
    const known = repairKnownThinkingHistory(brokenBody())
    expect(known?.body).toBe(first.body)
    expect(known?.fingerprint).toBe(first.fingerprint)
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
    const repair = repairOf(
      repairRejectedThinkingHistory(
        JSON.stringify(request),
        integrityError.replace("messages.1.content.88", "messages.1.content.0"),
      ),
    )
    const out = JSON.parse(repair.body) as typeof request

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
    // Even if upstream named index 0, a non-assistant role is out of scope —
    // and the decline says so rather than failing silently.
    expect(
      declineOf(
        repairRejectedThinkingHistory(
          JSON.stringify(request),
          integrityError.replace("messages.1.content.88", "messages.0.content.0"),
        ),
      ),
    ).toMatchObject({ reason: "message-not-assistant", roleAtIndex: "user" })
  })

  // Every non-repair exit must name itself. A silent decline is what made a
  // 44-rejection production incident impossible to explain after the fact.
  test("each decline path reports a distinct, structured reason", () => {
    const named = (index: number) =>
      integrityError.replace("messages.1.content.88", `messages.${index}.content.0`)
    const bodyOf = (messages: unknown) => JSON.stringify({ messages })

    expect(
      declineOf(repairRejectedThinkingHistory("{not json", named(0))).reason,
    ).toBe("body-not-json")

    expect(
      declineOf(repairRejectedThinkingHistory("{}", named(0))).reason,
    ).toBe("no-messages-array")

    expect(
      declineOf(
        repairRejectedThinkingHistory(
          bodyOf([{ role: "assistant", content: "plain string" }]),
          named(0),
        ),
      ),
    ).toMatchObject({ reason: "content-not-array" })

    // An assistant turn upstream blames, but with nothing signed left to strip.
    expect(
      declineOf(
        repairRejectedThinkingHistory(
          bodyOf([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]),
          named(0),
        ),
      ),
    ).toMatchObject({
      reason: "no-signed-blocks",
      blocksAtIndex: 1,
      signedBlocksAtIndex: 0,
    })
  })

  test("decline detail is log-safe: shapes and counts, never content", () => {
    const decline = declineOf(
      repairRejectedThinkingHistory(
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "SECRET-CONTENT-MARKER" }],
            },
          ],
        }),
        integrityError.replace("messages.1.content.88", "messages.0.content.0"),
      ),
    )
    const rendered = formatThinkingRepairDecline(decline)
    expect(rendered).not.toContain("SECRET-CONTENT-MARKER")
    expect(rendered).toContain("reason=no-signed-blocks")
    expect(rendered).toContain("blocksAtIndex=1")
  })
})
