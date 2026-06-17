import { describe, expect, test } from "bun:test"

import {
  buildPromptSubmitHookCommand,
  decidePromptSubmit,
  isNonTrivialPrompt,
  PROMPT_STEER_GOAL,
} from "../src/lib/orchestration/prompt-submit-hook"

describe("isNonTrivialPrompt", () => {
  test("returns true for a long prompt at the threshold", () => {
    expect(isNonTrivialPrompt("x".repeat(280))).toBe(true)
  })

  test("returns true for imperative build/change verbs", () => {
    for (const verb of ["implement", "refactor", "fix", "debug", "migrate", "add", "create", "build", "diagnose", "audit"]) {
      expect(isNonTrivialPrompt(`Please ${verb} the affected handler.`)).toBe(true)
    }
  })

  test("returns true for multi-file scope phrases", () => {
    expect(isNonTrivialPrompt("Apply the naming cleanup across all modules")).toBe(true)
    expect(isNonTrivialPrompt("Check this throughout every route")).toBe(true)
  })

  test("returns false for short trivial prompts and empty input", () => {
    expect(isNonTrivialPrompt("hi")).toBe(false)
    expect(isNonTrivialPrompt("what time is it")).toBe(false)
    expect(isNonTrivialPrompt("")).toBe(false)
    expect(isNonTrivialPrompt("   ")).toBe(false)
  })
})

describe("decidePromptSubmit", () => {
  test("subagent payload with agent_type or agent_id stands down without resetting the top-level session", () => {
    for (const agentFields of [{ agent_type: "Explore" }, { agent_id: "worker-1" }]) {
      const result = decidePromptSubmit({
        stdin: JSON.stringify({ session_id: "s1", prompt: "Please implement the feature", ...agentFields }),
        steerEnabled: true,
      })
      expect(result).toEqual({ inject: "" })
      expect(result).not.toHaveProperty("resetSession")
    }
  })

  test("top-level non-trivial prompt resets the session and injects the steer goal when enabled", () => {
    const result = decidePromptSubmit({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please implement the feature across all modules" }),
      steerEnabled: true,
    })
    expect(result.resetSession).toBe("s1")
    expect(result.inject).toBe(PROMPT_STEER_GOAL)
  })

  test("top-level trivial prompt resets the session but does not inject", () => {
    const result = decidePromptSubmit({
      stdin: JSON.stringify({ session_id: "s1", prompt: "hi" }),
      steerEnabled: true,
    })
    expect(result).toEqual({ resetSession: "s1", inject: "" })
  })

  test("disabled steering resets the session but does not inject for a non-trivial prompt", () => {
    const result = decidePromptSubmit({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please implement the feature across all modules" }),
      steerEnabled: false,
    })
    expect(result).toEqual({ resetSession: "s1", inject: "" })
  })

  test("unparseable stdin fails open without throwing or resetting", () => {
    expect(decidePromptSubmit({ stdin: "not json", steerEnabled: true })).toEqual({ inject: "" })
  })

  test("payload without session_id does not set resetSession", () => {
    const result = decidePromptSubmit({
      stdin: JSON.stringify({ prompt: "Please implement the missing behavior" }),
      steerEnabled: true,
    })
    expect(result.inject).toBe(PROMPT_STEER_GOAL)
    expect(result).not.toHaveProperty("resetSession")
  })
})

describe("buildPromptSubmitHookCommand", () => {
  test("includes both execPath and scriptPath when they differ", () => {
    expect(buildPromptSubmitHookCommand("/bin/bun", "/app/github-router.js")).toBe(
      '"/bin/bun" "/app/github-router.js" internal-prompt-submit',
    )
  })

  test("omits scriptPath when it is the same as execPath", () => {
    expect(buildPromptSubmitHookCommand("/app/github-router", "/app/github-router")).toBe(
      '"/app/github-router" internal-prompt-submit',
    )
  })

  test("omits scriptPath when it is undefined", () => {
    expect(buildPromptSubmitHookCommand("/app/github-router", undefined)).toBe(
      '"/app/github-router" internal-prompt-submit',
    )
  })
})
