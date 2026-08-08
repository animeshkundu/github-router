import { describe, expect, test } from "bun:test"

import {
  CLIENT_REDUNDANCY_MARKERS,
  detectToolLoop,
  extractAnthropicTurns,
  extractChatTurns,
  extractResponsesTurns,
  guardAnthropicBody,
} from "../src/lib/tool-loop-guard"

const MARKER = [...CLIENT_REDUNDANCY_MARKERS][0]!
const THRESHOLDS = { nudgeAt: 4, abortAt: 7 }

interface CallSpec {
  id: string
  name?: string
  input?: unknown
  result?: unknown
  isError?: boolean
}

/**
 * One Anthropic turn: an assistant message issuing `calls`, followed by the
 * user message carrying their results.
 */
function anthropicTurn(
  calls: Array<CallSpec>,
  opts: { narration?: string; reverseResults?: boolean } = {},
): Array<unknown> {
  const content: Array<unknown> = []
  if (opts.narration) content.push({ type: "text", text: opts.narration })
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name ?? "Read",
      input: call.input ?? { file_path: "a.js", offset: 250, limit: 100 },
    })
  }
  const results = calls.map((call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: call.result ?? MARKER,
    ...(call.isError === undefined ? {} : { is_error: call.isError }),
  }))
  return [
    { role: "assistant", content },
    {
      role: "user",
      content: opts.reverseResults ? [...results].reverse() : results,
    },
  ]
}

/** `count` repetitions of the incident's exact turn shape. */
function loopBody(
  count: number,
  opts: { narration?: string; result?: (i: number) => unknown } = {},
): Record<string, unknown> {
  const messages: Array<unknown> = [{ role: "user", content: "go" }]
  for (let i = 0; i < count; i++) {
    messages.push(
      ...anthropicTurn(
        [{ id: `toolu_${i}`, result: opts.result?.(i) ?? MARKER }],
        { narration: opts.narration },
      ),
    )
  }
  return { model: "claude-opus-5", messages }
}

describe("tool loop guard — the incident", () => {
  test("escalates none → nudge → abort as the run grows", () => {
    const at = (n: number) =>
      detectToolLoop(extractAnthropicTurns(loopBody(n)), THRESHOLDS)

    expect(at(3).action).toBe("none")
    expect(at(4).action).toBe("nudge")
    expect(at(6).action).toBe("nudge")

    const aborted = at(7)
    expect(aborted.action).toBe("abort")
    // Tier A: the client itself declared the call redundant, so no silence
    // test was needed to reach this verdict.
    expect(aborted.tier).toBe("A")
    expect(aborted.repeats).toBe(7)
    expect(aborted.toolName).toBe("Read")
  })

  test("a long run saturates at the abort threshold rather than scanning it all", () => {
    // 50 synthetic turns of the incident's shape. This is NOT a replay of the
    // real 4,020-repeat transcript — it pins the tail-scan property, namely
    // that `repeats` stops at `abortAt` however long the history is.
    const verdict = detectToolLoop(
      extractAnthropicTurns(loopBody(50)),
      THRESHOLDS,
    )
    expect(verdict.action).toBe("abort")
    expect(verdict.repeats).toBe(7)
  })
})

describe("tool loop guard — false negatives that the per-call design missed", () => {
  test("a repeated PARALLEL batch trips (flattening would give A,B,A,B and never fire)", () => {
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        ...anthropicTurn([
          { id: `a_${i}`, name: "Read", input: { file_path: "a.js" } },
          { id: `b_${i}`, name: "Read", input: { file_path: "b.js" } },
        ]),
      )
    }
    const verdict = detectToolLoop(
      extractAnthropicTurns({ messages }),
      THRESHOLDS,
    )
    expect(verdict.action).toBe("abort")
    expect(verdict.repeats).toBe(7)
  })

  test("results serialized in a different order still compare equal", () => {
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        ...anthropicTurn(
          [
            { id: `a_${i}`, input: { file_path: "a.js" } },
            { id: `b_${i}`, input: { file_path: "b.js" } },
          ],
          // Pairing is by tool_use_id, so a reversed result array is the same
          // turn — position-based pairing would silently break the streak.
          { reverseResults: i % 2 === 0 },
        ),
      )
    }
    expect(
      detectToolLoop(extractAnthropicTurns({ messages }), THRESHOLDS).action,
    ).toBe("abort")
  })

  test("Tier B catches a silent loop with no client marker", () => {
    const body = loopBody(7, { result: () => "identical bash output" })
    const verdict = detectToolLoop(extractAnthropicTurns(body), THRESHOLDS)
    expect(verdict.action).toBe("abort")
    expect(verdict.tier).toBe("B")
  })
})

describe("tool loop guard — false positives that must never fire", () => {
  test("seven identical calls inside ONE turn is not a loop", () => {
    // The model has observed no results at all here; zero feedback cycles have
    // completed, so there is nothing to have learned from.
    const calls = Array.from({ length: 7 }, (_, i) => ({ id: `toolu_${i}` }))
    const messages = [{ role: "user", content: "go" }, ...anthropicTurn(calls)]
    const turns = extractAnthropicTurns({ messages })
    // One turn carrying seven calls — NOT seven consecutive repeats.
    expect(turns).toHaveLength(1)
    expect(turns[0]?.calls).toHaveLength(7)
    expect(detectToolLoop(turns, THRESHOLDS).action).toBe("none")
  })

  test("a narrating poller with byte-identical results is never aborted", () => {
    // A CI poll returns identical output for minutes. Identical results alone
    // do NOT distinguish it from a wedged model — narration does.
    const body = loopBody(20, {
      narration: "still queued, checking again",
      result: () => '{"status":"queued"}',
    })
    const verdict = detectToolLoop(extractAnthropicTurns(body), THRESHOLDS)
    expect(verdict.action).toBe("nudge")
    expect(verdict.action).not.toBe("abort")
  })

  test("a SILENT byte-identical poller IS aborted — the accepted trade-off", () => {
    // Pinning a known, deliberate behaviour change rather than leaving it to
    // be discovered in production. Tier B cannot tell a silent poller from a
    // wedged model: both repeat the same call, get the same bytes back, and
    // say nothing. Narration is the only signal that separates them, so a
    // poller that narrates is safe (test above) and one that does not is
    // stopped at 7. Operators who genuinely need silent long-polling raise or
    // disable GH_ROUTER_LOOP_ABORT_AT.
    const body = loopBody(7, { result: () => '{"status":"queued"}' })
    const verdict = detectToolLoop(extractAnthropicTurns(body), THRESHOLDS)
    expect(verdict.action).toBe("abort")
    expect(verdict.tier).toBe("B")

    // ...and the escape hatch actually works.
    expect(
      detectToolLoop(extractAnthropicTurns(body), { nudgeAt: 4, abortAt: 0 })
        .action,
    ).toBe("nudge")
  })

  test("varying results never trip, however many times the call repeats", () => {    const body = loopBody(20, { result: (i) => `elapsed ${i}s` })
    expect(detectToolLoop(extractAnthropicTurns(body), THRESHOLDS).action).toBe(
      "none",
    )
  })

  test("a run of exactly 3 — the worst healthy run observed — does nothing", () => {
    expect(
      detectToolLoop(extractAnthropicTurns(loopBody(3)), THRESHOLDS).action,
    ).toBe("none")
  })

  test("a result that CONTAINS the marker is not a Tier A match", () => {
    // The marker text lives in this repo's docs and in stored transcripts, so
    // an agent reading either produces a result containing it. Substring
    // matching would make the guard fire on its own project.
    const body = loopBody(7, {
      narration: "reading the plan",
      result: () => `docs say: "${MARKER}" and more text`,
    })
    const verdict = detectToolLoop(extractAnthropicTurns(body), THRESHOLDS)
    expect(verdict.tier).not.toBe("A")
    expect(verdict.action).toBe("nudge")
  })

  test("is_error makes an otherwise identical result distinct", () => {    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        ...anthropicTurn([
          { id: `toolu_${i}`, result: "same text", isError: i % 2 === 0 },
        ]),
      )
    }
    expect(
      detectToolLoop(extractAnthropicTurns({ messages }), THRESHOLDS).action,
    ).toBe("none")
  })

  test("an unanswered tool call is not a completed cycle", () => {
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `toolu_${i}`, name: "Read", input: {} },
        ],
      })
    }
    // No results at all, so every turn contributes zero comparable calls.
    expect(
      extractAnthropicTurns({ messages }).filter((t) => t.calls.length > 0),
    ).toHaveLength(0)
  })

  test("a tool-less assistant turn breaks the run instead of being spliced out", () => {
    // An agent that narrates between attempts is making visible progress. If
    // the text-only turns were dropped, the tool turns either side would look
    // consecutive AND silent, and Tier B would abort a healthy agent.
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 10; i++) {
      messages.push(...anthropicTurn([{ id: `toolu_${i}` }]))
      messages.push(
        { role: "assistant", content: [{ type: "text", text: "let me think" }] },
        { role: "user", content: "go on" },
      )
    }
    const verdict = detectToolLoop(
      extractAnthropicTurns({ messages }),
      THRESHOLDS,
    )
    expect(verdict.action).toBe("none")
  })

  test("OpenAI array-shaped assistant content counts as narration", () => {
    // `content` may be multimodal parts rather than a string; treating only
    // strings as narration would mark an array-narrating model silent.
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        {
          role: "assistant",
          content: [{ type: "text", text: "still waiting on the build" }],
          tool_calls: [
            {
              id: `call_${i}`,
              type: "function",
              function: { name: "poll", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: `call_${i}`, content: "queued" },
      )
    }
    expect(
      detectToolLoop(extractChatTurns({ messages }), THRESHOLDS).action,
    ).toBe("nudge")
  })

  test("a partially-answered batch repeated forever is still caught", () => {
    // Only one of the two parallel calls gets a result. Dropping the whole
    // turn on a partial batch would blind the guard to this loop entirely.
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: `a_${i}`, name: "Read", input: { p: "a" } },
            { type: "tool_use", id: `b_${i}`, name: "Read", input: { p: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `a_${i}`, content: MARKER },
          ],
        },
      )
    }
    expect(
      detectToolLoop(extractAnthropicTurns({ messages }), THRESHOLDS).action,
    ).toBe("abort")
  })

  test("thresholds of 0 disable each stage", () => {
    const turns = extractAnthropicTurns(loopBody(20))
    expect(detectToolLoop(turns, { nudgeAt: 0, abortAt: 7 }).action).toBe(
      "abort",
    )
    expect(detectToolLoop(turns, { nudgeAt: 4, abortAt: 0 }).action).toBe(
      "nudge",
    )
    expect(detectToolLoop(turns, { nudgeAt: 0, abortAt: 0 }).action).toBe("none")
  })
})

describe("tool loop guard — body handling", () => {
  test("detection alone never re-serializes the body", () => {
    const raw = JSON.stringify(loopBody(3))
    const outcome = guardAnthropicBody(raw)
    expect(outcome.action).toBe("none")
    expect(outcome.body).toBeUndefined()
  })

  test("a request with no tool traffic short-circuits before parsing", () => {
    const outcome = guardAnthropicBody(
      JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    )
    expect(outcome.action).toBe("none")
    expect(outcome.body).toBeUndefined()
  })

  test("the nudge is a sibling block and leaves every tool_result untouched", () => {
    const raw = JSON.stringify(loopBody(4))
    const outcome = guardAnthropicBody(raw)
    expect(outcome.action).toBe("nudge")

    interface Block {
      type: string
      text?: string
    }
    interface Parsed {
      messages: Array<{ role: string; content: Array<Block> }>
    }

    const before = JSON.parse(raw) as Parsed
    const after = JSON.parse(outcome.body!) as Parsed
    expect(after.messages).toHaveLength(before.messages.length)

    const lastBefore = before.messages.at(-1)!.content
    const lastAfter = after.messages.at(-1)!.content
    // Original blocks byte-identical; exactly one text block appended.
    expect(lastAfter.slice(0, lastBefore.length)).toEqual(lastBefore)
    expect(lastAfter).toHaveLength(lastBefore.length + 1)
    expect(lastAfter.at(-1)!.type).toBe("text")
    expect(lastAfter.at(-1)!.text).toContain("repeated")
  })

  test("malformed JSON is passed through untouched", () => {
    const outcome = guardAnthropicBody('{"messages":[ tool_result broken')
    expect(outcome.action).toBe("none")
  })
})

describe("tool loop guard — other wire formats", () => {
  test("OpenAI Chat tool_calls are extracted and trip", () => {
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${i}`,
              type: "function",
              function: { name: "read", arguments: '{"path":"a.js"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: `call_${i}`, content: MARKER },
      )
    }
    const verdict = detectToolLoop(extractChatTurns({ messages }), THRESHOLDS)
    expect(verdict.action).toBe("abort")
    expect(verdict.tier).toBe("A")
  })

  test("OpenAI Chat assistant narration blocks the Tier B abort", () => {
    const messages: Array<unknown> = [{ role: "user", content: "go" }]
    for (let i = 0; i < 7; i++) {
      messages.push(
        {
          role: "assistant",
          content: "still waiting on the build",
          tool_calls: [
            {
              id: `call_${i}`,
              type: "function",
              function: { name: "poll", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: `call_${i}`, content: "queued" },
      )
    }
    expect(
      detectToolLoop(extractChatTurns({ messages }), THRESHOLDS).action,
    ).toBe("nudge")
  })

  test("Responses function_call / function_call_output pairs trip", () => {
    const input: Array<unknown> = []
    for (let i = 0; i < 7; i++) {
      input.push(
        {
          type: "function_call",
          call_id: `fc_${i}`,
          name: "read",
          arguments: '{"path":"a.js"}',
        },
        { type: "function_call_output", call_id: `fc_${i}`, output: MARKER },
      )
    }
    const verdict = detectToolLoop(extractResponsesTurns({ input }), THRESHOLDS)
    expect(verdict.action).toBe("abort")
    expect(verdict.tier).toBe("A")
  })

  test("a Responses parallel batch is one turn, not several", () => {
    const input: Array<unknown> = [
      {
        type: "function_call",
        call_id: "fc_a",
        name: "read",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "fc_b",
        name: "read",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "fc_a", output: MARKER },
      { type: "function_call_output", call_id: "fc_b", output: MARKER },
    ]
    const turns = extractResponsesTurns({ input })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.calls).toHaveLength(2)
  })
})
