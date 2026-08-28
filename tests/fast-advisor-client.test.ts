import { describe, expect, test } from "bun:test"

import {
  fastAdvisorClientEnabled,
  withFixedFastAdvisorArg,
} from "../src/lib/fast-advisor-client"
import { FAST_PROFILE_ADVISOR_CLIENT_MODEL } from "../src/lib/fast-profile-contract"

describe("fixed fast Advisor child arguments", () => {
  test("removes every Advisor spelling and appends one fixed value", () => {
    expect(withFixedFastAdvisorArg([
      "--advisor", "opus",
      "--print", "hello",
      "--advisor=claude-opus-5",
      "--",
      "--advisor", "sonnet",
      "--advisor=haiku",
    ])).toEqual([
      "--print", "hello",
      "--advisor", FAST_PROFILE_ADVISOR_CLIENT_MODEL,
      "--",
    ])
  })

  test("removes a missing-value Advisor flag without eating the next option", () => {
    expect(withFixedFastAdvisorArg(["--advisor", "--print", "hello"]))
      .toEqual(["--print", "hello", "--advisor", FAST_PROFILE_ADVISOR_CLIENT_MODEL])
  })

  test("hard disable removes caller Advisor args and appends nothing", () => {
    expect(withFixedFastAdvisorArg(["--advisor", "opus"], false)).toEqual([])
  })

  test("enablement matches hard-disable and experimental opt-out semantics", () => {
    expect(fastAdvisorClientEnabled({})).toBe(true)
    expect(fastAdvisorClientEnabled({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "" })).toBe(true)
    for (const value of ["1", "0", "false", "off", "anything"]) {
      expect(fastAdvisorClientEnabled({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: value }))
        .toBe(false)
    }
    for (const value of ["", "0", "false", "no", "off"]) {
      expect(fastAdvisorClientEnabled({
        CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: value,
      })).toBe(false)
    }
    for (const value of ["1", "true", "yes", "on", "unexpected"]) {
      expect(fastAdvisorClientEnabled({
        CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: value,
      })).toBe(true)
    }
  })
})
