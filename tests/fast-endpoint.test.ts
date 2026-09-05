import { describe, expect, test } from "bun:test"

import {
  advertisesEndpoint,
  fastEndpointForModel,
  fastEndpointRequirement,
} from "~/lib/fast-endpoint"
import { validateFastProfilePrerequisites } from "~/lib/launch-profile"

function model(id: string, endpoints: string[]) {
  return {
    id,
    supported_endpoints: endpoints,
    capabilities: {
      limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 900_000 },
      supports: {
        tool_calls: true,
        reasoning_effort: ["medium", "high", "max"],
        adaptive_thinking: true,
      },
    },
  } as never
}

describe("fast endpoint policy", () => {
  test.each([
    ["gpt-5.6-luna", "responses"],
    ["gpt-5.6-sol", "responses"],
    ["grok-4.6", "responses"],
    ["gemini-3.8-flash", "chat"],
    ["claude-opus-5", "messages"],
  ] as const)("requires %s on %s", (id, expected) => {
    expect(fastEndpointRequirement(id)).toBe(expected)
  })

  test("does not let advertisement order override the fast policy", () => {
    expect(
      fastEndpointForModel(model("gpt-5.6-luna", ["/chat/completions", "/responses"])),
    ).toBe("responses")
    expect(
      fastEndpointForModel(model("gemini-3.8-flash", ["/responses", "/chat/completions"])),
    ).toBe("chat")
  })

  test("checks arbitrary catalog entries against normalized endpoint names", () => {
    expect(advertisesEndpoint(model("gpt-5.3-codex", ["/responses"]), "responses")).toBe(true)
    expect(advertisesEndpoint(model("gpt-5.3-codex", ["/v1/responses"]), "responses")).toBe(true)
    expect(advertisesEndpoint(model("gpt-5.3-codex", ["/chat/completions"]), "responses")).toBe(false)
    expect(advertisesEndpoint(undefined, "responses")).toBe(false)
  })

  test("rejects a missing required endpoint", () => {
    expect(fastEndpointForModel(model("gpt-5.6-sol", ["/chat/completions"]))).toBeUndefined()
    expect(fastEndpointForModel(model("gemini-3.8-flash", ["/responses"]))).toBeUndefined()
  })

  test("fast prerequisites use the same policy and fail on wrong endpoints", () => {
    const full = [
      model("gpt-5.6-luna", ["/responses"]),
      model("gpt-5.6-sol", ["/chat/completions"]),
      model("grok-4.6", ["/responses"]),
      model("gemini-3.8-flash", ["/chat/completions"]),
      model("claude-opus-5", ["/v1/messages"]),
    ]
    const result = validateFastProfilePrerequisites({ object: "list", data: full } as never)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain(
      "gpt-5.6-sol: does not advertise a supported Responses endpoint",
    )
  })
})
