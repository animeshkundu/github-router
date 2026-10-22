import { describe, expect, test } from "bun:test"

import { withFixedCheapestAdvisorArg } from "../src/lib/cheapest-advisor-client"
import { CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL } from "../src/lib/cheapest-profile-contract"

/**
 * The cheapest family's client-side Advisor pin.
 *
 * Claude Code has its own `--advisor` option, so a caller-supplied value would
 * otherwise win over the profile's fixed identity. The helper removes every
 * caller form and inserts the contract's bare slug at a position Claude Code
 * parses as an option (before the first `--` separator).
 */
describe("withFixedCheapestAdvisorArg", () => {
  test("inserts the bare contract slug by default", () => {
    expect(withFixedCheapestAdvisorArg(["-m", "cheapest"], true)).toEqual([
      "-m",
      "cheapest",
      "--advisor",
      CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL,
    ])
    // The pin stays a bare 200K slug — a decorated `[1m]` would lift the pin.
    expect(CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL).not.toContain("[1m]")
  })

  test("uses an explicit model when one is supplied", () => {
    // This is the cheapest2 delta: the caller (or launcher) passes the family
    // contract's advisor client model rather than relying on the default.
    expect(withFixedCheapestAdvisorArg([], true, "gpt-6.1-sol")).toEqual([
      "--advisor",
      "gpt-6.1-sol",
    ])
  })

  test("replaces both `--advisor value` and `--advisor=value` forms", () => {
    const args = [
      "-m",
      "cheapest2",
      "--advisor",
      "opus",
      "--advisor=sonnet",
      "--verbose",
    ]
    expect(withFixedCheapestAdvisorArg(args, true, "gpt-6.1-sol")).toEqual([
      "-m",
      "cheapest2",
      "--verbose",
      "--advisor",
      "gpt-6.1-sol",
    ])
  })

  test("keeps scanning past the `--` separator", () => {
    // Anything after `--` is a passthrough argument, but a caller-supplied
    // `--advisor` there would still reach Claude Code's own parser, so it is
    // removed too.
    const args = ["-m", "cheapest", "--", "--advisor", "opus", "prompt"]
    expect(withFixedCheapestAdvisorArg(args, true)).toEqual([
      "-m",
      "cheapest",
      "--advisor",
      CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL,
      "--",
      "prompt",
    ])
  })

  test("inserts before the first `--` so Claude Code parses it as an option", () => {
    const result = withFixedCheapestAdvisorArg(["-m", "cheapest", "--", "prompt"], true)
    expect(result.indexOf("--advisor")).toBeLessThan(result.indexOf("--"))
    expect(result.slice(-2)).toEqual(["--", "prompt"])
  })

  test("a bare `--advisor` followed by another option does not consume it", () => {
    // `--advisor --verbose` is a malformed caller value; the next token is an
    // option, so it must survive rather than be swallowed as the value.
    expect(withFixedCheapestAdvisorArg(["--advisor", "--verbose"], true)).toEqual([
      "--verbose",
      "--advisor",
      CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL,
    ])
  })

  test("a bare `--advisor` at the end is simply removed", () => {
    expect(withFixedCheapestAdvisorArg(["-m", "cheapest", "--advisor"], true)).toEqual([
      "-m",
      "cheapest",
      "--advisor",
      CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL,
    ])
  })

  test("disabled strips caller values without inserting the fixed one", () => {
    expect(
      withFixedCheapestAdvisorArg(
        ["-m", "cheapest", "--advisor", "opus", "--advisor=sonnet", "--", "--advisor=x"],
        false,
      ),
    ).toEqual(["-m", "cheapest", "--"])
  })

  test("empty args become the fixed pair", () => {
    expect(withFixedCheapestAdvisorArg([], true, "gpt-6.1-sol")).toEqual([
      "--advisor",
      "gpt-6.1-sol",
    ])
  })
})
