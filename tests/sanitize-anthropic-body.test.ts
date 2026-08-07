import { describe, expect, test } from "bun:test"

import { sanitizeAnthropicBody } from "../src/lib/sanitize-anthropic-body"

describe("sanitizeAnthropicBody", () => {
  test("empty/no-relevant-content body → unchanged (idempotent fast-path)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(sanitizeAnthropicBody(body)).toBe(body)
  })

  test("malformed JSON → returns unchanged (defensive)", () => {
    const body = "not-json{{"
    expect(sanitizeAnthropicBody(body)).toBe(body)
  })

  test("body without messages array → unchanged", () => {
    const body = JSON.stringify({ model: "claude-opus-4.7" })
    expect(sanitizeAnthropicBody(body)).toBe(body)
  })

  test("plain conversation with no advisor blocks → unchanged (fast-path miss)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    })
    expect(sanitizeAnthropicBody(body)).toBe(body)
  })

  test("generic tool_use with toolu_* id → NOT touched (regression guard against ID round-trip trap)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_normal_42",
              name: "Read",
              input: { file_path: "/tmp/x" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_normal_42",
              content: "file contents",
            },
          ],
        },
      ],
    })
    const out = sanitizeAnthropicBody(body)
    expect(out).toBe(body)
  })

  test("tools[] containing advisor_20260301 typed entry → stripped", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "Read", input_schema: { type: "object" } },
        { type: "advisor_20260301" },
        { name: "Write", input_schema: { type: "object" } },
      ],
    })
    const out = sanitizeAnthropicBody(body)
    const parsed = JSON.parse(out) as { tools: Array<Record<string, unknown>> }
    expect(parsed.tools.length).toBe(2)
    expect(
      parsed.tools.some(
        (t) => typeof t.type === "string" && t.type.startsWith("advisor_"),
      ),
    ).toBe(false)
  })

  // ── Round-7 holistic fix: translate historical advisor pairs ──

  test("historical assistant turn with server_tool_use{advisor} + advisor_tool_result → split into assistant/user/assistant + advisor tool re-injected into tools[]", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me consult." },
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_1",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_1",
              content: { type: "advisor_result", text: "Advice text here." },
            },
            { type: "text", text: "Based on advisor: proceeding." },
          ],
        },
        { role: "user", content: "follow up" },
      ],
    })
    const out = sanitizeAnthropicBody(body)
    expect(out).not.toBe(body)
    const parsed = JSON.parse(out) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
      tools: Array<Record<string, unknown>>
    }
    // Original 3 messages → 5 messages after split:
    // [0] user "first"
    // [1] assistant [text "Let me consult.", tool_use{__anthropic_advisor}]
    // [2] user [tool_result "Advice text here."]
    // [3] assistant [text "Based on advisor..."]
    // [4] user "follow up"
    expect(parsed.messages.length).toBe(5)
    expect(parsed.messages[0]!.role).toBe("user")
    expect(parsed.messages[1]!.role).toBe("assistant")
    expect(parsed.messages[2]!.role).toBe("user")
    expect(parsed.messages[3]!.role).toBe("assistant")
    expect(parsed.messages[4]!.role).toBe("user")

    // Assistant turn 1 ends with tool_use{__anthropic_advisor}
    const tu = parsed.messages[1]!.content.find((b) => b.type === "tool_use")
    expect(tu).toBeDefined()
    expect(tu!.name).toBe("__anthropic_advisor")
    // Id translated from srvtoolu_advisor_1 → toolu_advisor_1
    expect(tu!.id).toBe("toolu_advisor_1")
    expect(tu!.input).toEqual({})

    // User turn after carries the tool_result with same toolu_* id
    const tr = parsed.messages[2]!.content.find((b) => b.type === "tool_result")
    expect(tr).toBeDefined()
    expect(tr!.tool_use_id).toBe("toolu_advisor_1")
    expect(tr!.content).toBe("Advice text here.")

    // Continuation assistant turn has the trailing text
    expect(parsed.messages[3]!.content[0]).toEqual({
      type: "text",
      text: "Based on advisor: proceeding.",
    })

    // tools[] re-injected with __anthropic_advisor so the tool_use.name resolves
    expect(parsed.tools.some((t) => t.name === "__anthropic_advisor")).toBe(
      true,
    )
  })

  test("malformed srvtoolu_ id (toolu_* leftover from before round-5 fix) → translated to fresh toolu_* id; pairing preserved", () => {
    // The actual production failure mode: pre-round-5 sessions have
    // server_tool_use{id:toolu_*} blocks. Sanitizer translates to the
    // tool_use shape Copilot accepts, generating a synthesized
    // toolu_advisor_N id since the original wasn't srvtoolu_*.
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "toolu_BAD_advisor_99",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "toolu_BAD_advisor_99",
              content: { type: "advisor_result", text: "advice" },
            },
          ],
        },
      ],
    })
    const out = sanitizeAnthropicBody(body)
    const parsed = JSON.parse(out) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(parsed.messages.length).toBe(2)
    const tu = parsed.messages[0]!.content[0] as Record<string, unknown>
    const tr = parsed.messages[1]!.content[0] as Record<string, unknown>
    expect(tu.type).toBe("tool_use")
    expect(tu.name).toBe("__anthropic_advisor")
    // Already-toolu_* id — preserved as-is (no need to synthesize).
    expect(tu.id).toBe("toolu_BAD_advisor_99")
    expect(tr.type).toBe("tool_result")
    expect(tr.tool_use_id).toBe(tu.id) // pairing preserved
  })

  test("multiple advisor pairs in one assistant turn → split into 5+ messages, each pair properly paired", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "First consult." },
            { type: "server_tool_use", id: "srvtoolu_a", name: "advisor", input: {} },
            { type: "advisor_tool_result", tool_use_id: "srvtoolu_a", content: { type: "advisor_result", text: "advice 1" } },
            { type: "text", text: "Second consult." },
            { type: "server_tool_use", id: "srvtoolu_b", name: "advisor", input: {} },
            { type: "advisor_tool_result", tool_use_id: "srvtoolu_b", content: { type: "advisor_result", text: "advice 2" } },
            { type: "text", text: "Done." },
          ],
        },
      ],
    })
    const out = sanitizeAnthropicBody(body)
    const parsed = JSON.parse(out) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    // assistant→user→assistant→user→assistant pattern
    expect(parsed.messages.length).toBe(5)
    const roles = parsed.messages.map((m) => m.role)
    expect(roles).toEqual(["assistant", "user", "assistant", "user", "assistant"])

    // First pair
    const tu1 = parsed.messages[0]!.content.find((b) => b.type === "tool_use")!
    const tr1 = parsed.messages[1]!.content[0]!
    expect(tu1.id).toBe("toolu_a")
    expect(tr1.tool_use_id).toBe("toolu_a")
    expect(tr1.content).toBe("advice 1")

    // Second pair
    const tu2 = parsed.messages[2]!.content.find((b) => b.type === "tool_use")!
    const tr2 = parsed.messages[3]!.content[0]!
    expect(tu2.id).toBe("toolu_b")
    expect(tr2.tool_use_id).toBe("toolu_b")
    expect(tr2.content).toBe("advice 2")

    // Trailing text in final assistant turn
    expect(parsed.messages[4]!.content[0]).toEqual({ type: "text", text: "Done." })
  })

  test("parallel advisor history becomes one assistant turn followed by all results", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Consulting twice." },
            {
              type: "server_tool_use",
              id: "srvtoolu_parallel_a",
              name: "advisor",
              input: {},
            },
            {
              type: "server_tool_use",
              id: "srvtoolu_parallel_b",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_parallel_a",
              content: { type: "advisor_result", text: "advice a" },
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_parallel_b",
              content: { type: "advisor_result", text: "advice b" },
            },
            { type: "text", text: "Continuing." },
          ],
        },
      ],
    })

    const parsed = JSON.parse(sanitizeAnthropicBody(body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ])
    expect(parsed.messages[0]!.content.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
      "tool_use",
    ])
    expect(parsed.messages[0]!.content
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id)).toEqual([
      "toolu_parallel_a",
      "toolu_parallel_b",
    ])
    expect(parsed.messages[1]!.content.map((block) => block.tool_use_id)).toEqual([
      "toolu_parallel_a",
      "toolu_parallel_b",
    ])
    expect(parsed.messages[1]!.content.map((block) => block.content)).toEqual([
      "advice a",
      "advice b",
    ])
    expect(parsed.messages[2]!.content).toEqual([
      { type: "text", text: "Continuing." },
    ])
  })

  test("idempotent on already-translated body (re-running on output produces same output)", () => {
    const original = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_x", name: "advisor", input: {} },
            { type: "advisor_tool_result", tool_use_id: "srvtoolu_x", content: { type: "advisor_result", text: "ok" } },
          ],
        },
      ],
    })
    const once = sanitizeAnthropicBody(original)
    const twice = sanitizeAnthropicBody(once)
    expect(twice).toBe(once)
  })

  test("stray advisor_tool_result without preceding server_tool_use fails clearly", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_orphan",
              content: { type: "advisor_result", text: "orphan" },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    })
    expect(() => sanitizeAnthropicBody(body)).toThrow(
      "Invalid advisor history",
    )
  })

  test("mixed client/advisor turn merges both results into one immediate user message without changing thinking", () => {
    const thinking = {
      type: "thinking",
      thinking: "",
      signature: "signed-opaque-value",
    }
    const body = JSON.stringify({
      model: "claude-opus-5",
      messages: [
        {
          role: "assistant",
          content: [
            thinking,
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "/tmp/x" },
            },
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_1",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_1",
              content: { type: "advisor_result", text: "reviewed" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "contents",
            },
            { type: "text", text: "continue" },
          ],
        },
      ],
    })

    const parsed = JSON.parse(sanitizeAnthropicBody(body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ])
    expect(parsed.messages[0]!.content[0]).toEqual(thinking)
    expect(parsed.messages[0]!.content.map((block) => block.type)).toEqual([
      "thinking",
      "tool_use",
      "tool_use",
    ])
    expect(parsed.messages[1]!.content.map((block) => block.type)).toEqual([
      "tool_result",
      "tool_result",
      "text",
    ])
    expect(parsed.messages[1]!.content.map((block) => block.tool_use_id)).toEqual([
      "toolu_advisor_1",
      "toolu_read_1",
      undefined,
    ])
  })

  test("mixed turn also normalizes when the advisor call precedes a client tool", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_first",
              name: "advisor",
              input: {},
            },
            { type: "tool_use", id: "toolu_read_2", name: "Read", input: {} },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_first",
              content: { type: "advisor_result", text: "reviewed" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_2",
              content: "contents",
            },
          ],
        },
      ],
    })

    const parsed = JSON.parse(sanitizeAnthropicBody(body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ])
    expect(parsed.messages[0]!.content.map((block) => block.type)).toEqual([
      "tool_use",
      "tool_use",
    ])
    expect(parsed.messages[1]!.content.map((block) => block.tool_use_id)).toEqual([
      "toolu_advisor_first",
      "toolu_read_2",
    ])
  })

  test("mixed client/advisor turn rejects incomplete client results", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_read_1", name: "Read", input: {} },
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_1",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_1",
              content: { type: "advisor_result", text: "reviewed" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "missing result" }] },
      ],
    })
    expect(() => sanitizeAnthropicBody(body)).toThrow(
      "Invalid advisor history",
    )
  })

  test("mixed client/advisor turn rejects an impossible trailing continuation", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_read_1", name: "Read", input: {} },
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_1",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_1",
              content: { type: "advisor_result", text: "reviewed" },
            },
            { type: "text", text: "continued before Read completed" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "contents",
            },
          ],
        },
      ],
    })
    expect(() => sanitizeAnthropicBody(body)).toThrow(
      "Invalid advisor history",
    )
  })

  test("re-injecting tools[] preserves user-defined tools (additive)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_x", name: "advisor", input: {} },
            { type: "advisor_tool_result", tool_use_id: "srvtoolu_x", content: { type: "advisor_result", text: "ok" } },
          ],
        },
      ],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })
    const out = sanitizeAnthropicBody(body)
    const parsed = JSON.parse(out) as { tools: Array<Record<string, unknown>> }
    expect(parsed.tools.length).toBe(2)
    expect(parsed.tools.some((t) => t.name === "Read")).toBe(true)
    expect(parsed.tools.some((t) => t.name === "__anthropic_advisor")).toBe(true)
  })
})
