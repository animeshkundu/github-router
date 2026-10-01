// Coverage for the cheapest structured protégé consult:
//   - curated transcript budget resolver
//   - tool-aware rendering (head/tail, error exception, summary keep, bulk input)
//   - caller-context / operator-focus extraction
//   - XML-tagged layered prompt assembly
//   - cheapest advisor system prompt + lean tool description
//   - the injected CLAUDE.md consult contract
//
// The crucial invariant: every ADDED behavior is gated on the cheapest flag, so
// other advisor profiles remain byte-identical. The last block pins that.

import { describe, expect, test } from "bun:test"

import {
  ADVISOR_TOOL_RESULT_HEAD_LINES,
  ADVISOR_TOOL_RESULT_TAIL_LINES,
  buildCheapestAdvisorPrompt,
  boundedToolResultText,
  extractCallerContext,
  extractOriginalUserAsk,
  headTailTruncate,
  renderConversationAsText,
  resolveCheapestAdvisorTranscriptTokens,
  advisorSystemPrompt,
  CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS,
} from "~/services/advisor/advisor"
import {
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN,
} from "~/lib/cheapest-profile-contract"
import { buildOperatingDefaultsDirective, buildOperatingDefaultsDigest } from "~/lib/claude-md-injection"

type AnyRecord = Record<string, unknown>

// ---------------------------------------------------------------------------
// Budget resolver
// ---------------------------------------------------------------------------

describe("resolveCheapestAdvisorTranscriptTokens", () => {
  test("defaults to the curated value when unset", () => {
    expect(resolveCheapestAdvisorTranscriptTokens({})).toBe(
      CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
    )
  })

  test("honors a value inside the clamp range", () => {
    expect(
      resolveCheapestAdvisorTranscriptTokens({
        GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS: "20000",
      }),
    ).toBe(20_000)
  })

  test("clamps below the minimum and above the maximum", () => {
    expect(
      resolveCheapestAdvisorTranscriptTokens({
        GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS: "1",
      }),
    ).toBe(CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN)
    expect(
      resolveCheapestAdvisorTranscriptTokens({
        GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS: "1000000",
      }),
    ).toBe(CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX)
  })

  test("falls back to default for empty / non-numeric / non-positive", () => {
    for (const raw of ["", "  ", "abc", "0", "-5", "1.5", "NaN"]) {
      expect(
        resolveCheapestAdvisorTranscriptTokens({
          GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS: raw,
        }),
      ).toBe(CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT)
    }
  })
})

// ---------------------------------------------------------------------------
// Tool-aware truncation helpers
// ---------------------------------------------------------------------------

describe("headTailTruncate", () => {
  test("returns short text unchanged", () => {
    expect(headTailTruncate("hello", 100)).toBe("hello")
  })

  test("keeps a head and tail with an elision marker", () => {
    const text = "a".repeat(200)
    const out = headTailTruncate(text, 50)
    expect(out).toContain("elided")
    expect(out.length).toBeLessThanOrEqual(50 + 40)
  })
})

describe("boundedToolResultText", () => {
  test("passes through a short result", () => {
    const out = boundedToolResultText("line1\nline2", 1000)
    expect(out).toBe("line1\nline2")
  })

  test("keeps head and tail lines with an elision count", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
    const out = boundedToolResultText(lines.join("\n"), 10_000)
    expect(out).toContain(`line-0`)
    expect(out).toContain(`line-${ADVISOR_TOOL_RESULT_HEAD_LINES - 1}`)
    expect(out).toContain(`line-${49}`)
    expect(out).toContain("lines elided")
    const elided = 50 - ADVISOR_TOOL_RESULT_HEAD_LINES - ADVISOR_TOOL_RESULT_TAIL_LINES
    expect(out).toContain(`${elided} lines elided`)
    // A middle line must NOT survive.
    expect(out).not.toContain("line-25")
  })
})

// ---------------------------------------------------------------------------
// renderConversationAsText tool-aware mode
// ---------------------------------------------------------------------------

function conversationWithTools(): Array<AnyRecord> {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Review the auth change" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I changed the middleware; here is my brief." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "/x.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: Array.from({ length: 60 }, (_, i) => `row-${i}`).join("\n"),
        },
      ],
    },
  ]
}

describe("renderConversationAsText tool-aware mode", () => {
  test("default (toolAware=false) renders tool results in full", () => {
    const out = renderConversationAsText(
      conversationWithTools(),
      10_000_000,
      (s) => s.length,
      false,
      false,
    )
    expect(out).toContain("row-25")
    expect(out).not.toContain("lines elided")
  })

  test("toolAware=true truncates a raw tool result to head/tail", () => {
    const out = renderConversationAsText(
      conversationWithTools(),
      10_000_000,
      (s) => s.length,
      false,
      true,
    )
    expect(out).toContain("row-0")
    expect(out).toContain("row-59")
    expect(out).toContain("lines elided")
    expect(out).not.toContain("row-30")
  })

  test("toolAware=true keeps an error result at the larger cap", () => {
    const convo: Array<AnyRecord> = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: Array.from({ length: 200 }, (_, i) => `err-${i}`).join("\n"),
          },
        ],
      },
    ]
    const out = renderConversationAsText(convo, 10_000_000, (s) => s.length, false, true)
    expect(out).toContain("error=true")
  })

  test("toolAware=true keeps a subagent (summary) result body", () => {
    const body = Array.from({ length: 40 }, (_, i) => `finding-${i}`).join("\n")
    const convo: Array<AnyRecord> = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: body }] },
    ]
    const out = renderConversationAsText(convo, 10_000_000, (s) => s.length, false, true)
    // 40 lines is under the summary cap, so the whole body survives.
    expect(out).toContain("finding-0")
    expect(out).toContain("finding-39")
  })

  test("toolAware=true collapses a Write input to a size marker", () => {
    const convo: Array<AnyRecord> = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/big.ts", content: "x".repeat(5000) },
          },
        ],
      },
    ]
    const out = renderConversationAsText(convo, 10_000_000, (s) => s.length, false, true)
    expect(out).toContain("bulk input")
    expect(out).toContain("file_path")
    expect(out).not.toContain("x".repeat(100))
  })
})

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe("extractOriginalUserAsk", () => {
  test("returns the first user text", () => {
    expect(extractOriginalUserAsk(conversationWithTools())).toBe("Review the auth change")
  })

  test("handles string content", () => {
    expect(extractOriginalUserAsk([{ role: "user", content: "hello" }])).toBe("hello")
  })

  test("returns undefined when no user text exists", () => {
    expect(extractOriginalUserAsk([{ role: "assistant", content: "hi" }])).toBeUndefined()
  })
})

describe("extractCallerContext", () => {
  test("returns the LAST assistant text as the curated brief", () => {
    const convo: Array<AnyRecord> = [
      { role: "assistant", content: [{ type: "text", text: "early" }] },
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "text", text: "the brief" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "__anthropic_advisor", input: {} }] },
    ]
    expect(extractCallerContext(convo)).toBe("the brief")
  })

  test("joins multiple text blocks in the same turn", () => {
    const convo: Array<AnyRecord> = [
      { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
    ]
    expect(extractCallerContext(convo)).toBe("one\n\ntwo")
  })

  test("returns undefined for a terse lead with no assistant text", () => {
    const convo: Array<AnyRecord> = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "__anthropic_advisor", input: {} }] },
    ]
    expect(extractCallerContext(convo)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layered prompt assembly
// ---------------------------------------------------------------------------

describe("buildCheapestAdvisorPrompt", () => {
  test("emits all four layers when focus and context exist", () => {
    const out = buildCheapestAdvisorPrompt({
      operatorFocus: "Fix the bug",
      callerContext: "I think it is in auth.ts",
      transcript: "### Turn 1 — user\nFix the bug",
    })
    expect(out).toContain("<operator_focus>\nFix the bug\n</operator_focus>")
    expect(out).toContain("<caller_context>\nI think it is in auth.ts\n</caller_context>")
    expect(out).toContain("<session_transcript note=")
    expect(out).toContain("<operator_focus_restated>\nFix the bug\n</operator_focus_restated>")
    // Restated focus must come AFTER the transcript.
    expect(out.indexOf("<session_transcript")).toBeLessThan(
      out.indexOf("<operator_focus_restated"),
    )
  })

  test("omits empty layers but always includes the transcript", () => {
    const out = buildCheapestAdvisorPrompt({ transcript: "only transcript" })
    expect(out).toContain("<session_transcript note=")
    expect(out).not.toContain("<operator_focus>")
    expect(out).not.toContain("<caller_context>")
    expect(out).not.toContain("<operator_focus_restated>")
  })

  test("labels the transcript as untrusted data", () => {
    const out = buildCheapestAdvisorPrompt({ transcript: "x" })
    expect(out).toContain("untrusted data")
  })
})

// ---------------------------------------------------------------------------
// System prompt + tool description + contract prose
// ---------------------------------------------------------------------------

describe("advisorSystemPrompt cheapest clause", () => {
  test("contains the structured reply shape and Luna awareness", () => {
    const prompt = advisorSystemPrompt(false, false, false, false, true)
    for (const label of [
      "JUDGMENT",
      "WHY",
      "ASSUMPTIONS",
      "RISK",
      "ALTERNATIVE",
      "FLIPS_IF",
      "CONFIDENCE",
    ]) {
      expect(prompt).toContain(label)
    }
    expect(prompt).toContain("<operator_focus>")
    expect(prompt).toContain("<caller_context>")
    expect(prompt).toContain("<session_transcript>")
    expect(prompt.toLowerCase()).toContain("luna")
    expect(prompt).toContain("untrusted data")
  })

  test("other profiles do NOT get the cheapest clause", () => {
    const base = advisorSystemPrompt(false, false, false, false, false)
    expect(base).not.toContain("FLIPS_IF")
    expect(base).not.toContain("JUDGMENT (one decisive line)")
  })

  test("the cheapest reviewer keeps its verdict shape, not the lead's", () => {
    // reviewerProfile + cheapestProfile: the mentor/verdict clause wins and the
    // lead's JUDGMENT/FLIPS_IF reply shape must NOT be appended.
    const reviewer = advisorSystemPrompt(false, false, false, true, true)
    expect(reviewer).toContain("Verdict (SHIP / FIX / BLOCK)")
    expect(reviewer).not.toContain("FLIPS_IF")
    expect(reviewer).not.toContain("JUDGMENT (one decisive line)")
  })
})

describe("CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS", () => {
  test("is the lean 'what' description without a when/how procedure list", () => {
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("Sol")
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("non-binding")
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("curated")
    // The when/how contract moved to the CLAUDE.md block; the tool description
    // must not carry the old process bullets.
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).not.toContain("When to consult advisor:")
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).not.toContain("Discriminator vs Oracle")
  })
})

describe("layered prompt composition (as runAdvisor assembles it)", () => {
  test("composes operator focus + caller context + tool-aware transcript + restated focus", () => {
    // Mirror runAdvisor's cheapest branch: render tool-aware, then wrap.
    const convo = conversationWithTools()
    const transcript = renderConversationAsText(
      convo,
      10_000_000,
      (s) => s.length,
      false,
      true,
    )
    const prompt = buildCheapestAdvisorPrompt({
      operatorFocus: extractOriginalUserAsk(convo),
      callerContext: extractCallerContext(convo),
      transcript,
    })

    // Operator focus (the user ask) is bookended.
    expect(prompt).toContain("<operator_focus>\nReview the auth change\n</operator_focus>")
    expect(prompt).toContain("<operator_focus_restated>\nReview the auth change\n</operator_focus_restated>")
    // Caller context is the lead's pre-call brief.
    expect(prompt).toContain("<caller_context>\nI changed the middleware; here is my brief.\n</caller_context>")
    // Transcript is present, labeled untrusted, and tool-aware truncated.
    expect(prompt).toContain("<session_transcript note=")
    expect(prompt).toContain("lines elided")
  })
})

describe("cheapest CLAUDE.md consult contract", () => {
  test("is injected into the directive for the cheapest profile only", () => {
    const cheapest = buildOperatingDefaultsDirective({ profile: "cheapest" })
    expect(cheapest).toContain("Consulting `advisor`")
    expect(cheapest).toContain("self-contained brief")
    expect(cheapest).toContain("Never paste raw tool output")

    for (const profile of ["fast", "cheap", "balanced", "max"] as const) {
      const other = buildOperatingDefaultsDirective({ profile })
      expect(other).not.toContain("Consulting `advisor`")
    }
  })

  test("is injected into the digest for the cheapest profile only", () => {
    const cheapest = buildOperatingDefaultsDigest({ profile: "cheapest" })
    expect(cheapest).toContain("Consulting `advisor`")

    for (const profile of ["fast", "cheap", "balanced", "max"] as const) {
      const other = buildOperatingDefaultsDigest({ profile })
      expect(other).not.toContain("Consulting `advisor`")
    }
  })
})
