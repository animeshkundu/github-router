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

/**
 * Clients do send `{role:"system"}` INSIDE `messages[]`, which the Anthropic
 * Messages schema does not define. Upstream evidently accepts it and drops it
 * before validating, so its `messages.N` stops agreeing with ours and the
 * repair lands on the system element and declines — observed in production as
 * `reason=message-not-assistant roleAtIndex=system`, which silently disabled
 * the whole recovery path.
 */
describe("thinking history repair with an in-array system message", () => {
  const signedBlocks = [
    { type: "thinking", thinking: "", signature: "opaque-signature" },
    { type: "text", text: "carrying on" },
  ]

  /** `[user, system, assistant]` — upstream retains only index 0 and 2. */
  function hoistedBody(): string {
    return JSON.stringify({
      model: "claude-opus-5",
      messages: [
        { role: "user", content: "start" },
        { role: "system", content: "injected by the client" },
        { role: "assistant", content: signedBlocks },
      ],
    })
  }

  function errorAt(messageIndex: number, contentIndex: number): string {
    return integrityError.replace(
      "messages.1.content.88",
      `messages.${messageIndex}.content.${contentIndex}`,
    )
  }

  test("direct index still wins when upstream reports the raw wire index", () => {
    // The regression this ordering exists to prevent: mapping FIRST would
    // filter to [user, assistant], find retained index 2 out of range, and
    // decline on a request that repairs correctly today.
    const outcome = repairRejectedThinkingHistory(hoistedBody(), errorAt(2, 0))
    if (!outcome.ok) {
      throw new Error(`expected a repair, declined: ${outcome.decline.reason}`)
    }
    expect(outcome.repair.messageIndex).toBe(2)
    expect(outcome.repair.removedBlocks).toBe(1)
    const parsed = JSON.parse(outcome.repair.body) as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>
    }
    // The system element is left exactly where it was.
    expect(parsed.messages[1]?.role).toBe("system")
    expect(parsed.messages[2]?.content.map((b) => b.type)).toEqual(["text"])
  })

  test("falls back to the hoist-adjusted index when the direct one is the system element", () => {
    // Upstream counts [user, assistant] and names messages.1; ours is at 2.
    const outcome = repairRejectedThinkingHistory(hoistedBody(), errorAt(1, 0))
    if (!outcome.ok) {
      throw new Error(`expected a repair, declined: ${outcome.decline.reason}`)
    }
    expect(outcome.repair.messageIndex).toBe(2)
    expect(outcome.repair.removedBlocks).toBe(1)
  })

  test("fails closed when the named block is not a signed block", () => {
    // Same shape, but upstream names a content index that is NOT thinking. If
    // the index shift has some other cause, the fallback must not strip blocks
    // from an innocent turn.
    const outcome = repairRejectedThinkingHistory(hoistedBody(), errorAt(1, 1))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.decline.reason).toBe("message-not-assistant")
    expect(outcome.decline.roleAtIndex).toBe("system")
  })

  test("a decline explains the misalignment without leaking content", () => {
    const outcome = repairRejectedThinkingHistory(hoistedBody(), errorAt(1, 1))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    const rendered = formatThinkingRepairDecline(outcome.decline)
    expect(rendered).toContain("hoistedCount=1")
    expect(rendered).toContain("roleSequence=user,system,assistant")
    expect(rendered).not.toContain("injected by the client")
    expect(rendered).not.toContain("opaque-signature")
  })

  test("no hoisted elements means the mapping never runs", () => {
    // Identity case: behaviour must be bit-for-bit what it was before.
    const outcome = repairRejectedThinkingHistory(
      JSON.stringify({
        messages: [
          { role: "user", content: "start" },
          { role: "user", content: "still the user" },
        ],
      }),
      errorAt(1, 0),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.decline.reason).toBe("message-not-assistant")
    expect(outcome.decline.hoistedCount).toBe(0)
    expect(outcome.decline.mappedIndex).toBeUndefined()
  })

  test("declines instead of stripping the wrong turn when both indices are valid", () => {
    // Two hoisted elements, and BOTH the raw index and the hoist-adjusted one
    // land on an assistant carrying a signed block at the reported position.
    // Taking the raw index blind would rewrite assistant A while the corrupt
    // turn is actually assistant B. Declining costs nothing — the client gets
    // the same 400 it would have got — and rewrites no innocent history.
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "injected" },
        { role: "assistant", content: signedBlocks },
        { role: "system", content: "injected again" },
        { role: "assistant", content: signedBlocks },
      ],
    })
    const outcome = repairRejectedThinkingHistory(body, errorAt(1, 0))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.decline.reason).toBe("ambiguous-index")
    expect(outcome.decline.messageIndex).toBe(1)
    expect(outcome.decline.mappedIndex).toBe(3)
    expect(outcome.decline.hoistedCount).toBe(2)
  })

  test("the adjusted index is reported in the decline detail", () => {
    // `mappedIndex` is advertised on the decline interface, so it has to be
    // populated where the mapping actually ran.
    const outcome = repairRejectedThinkingHistory(hoistedBody(), errorAt(1, 1))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.decline.mappedIndex).toBe(2)
  })
})
