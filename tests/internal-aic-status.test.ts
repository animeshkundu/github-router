import { describe, expect, test } from "bun:test"

import {
  composeAicStatusLine,
  runUserStatusLine,
} from "~/internal-aic-status"

describe("composeAicStatusLine", () => {
  test("prepends the AIC fragment to the user line", () => {
    expect(composeAicStatusLine("[AIC 12.42]", "main * model")).toBe(
      "[AIC 12.42] main * model",
    )
  })

  test("either side may be empty", () => {
    expect(composeAicStatusLine("", "main")).toBe("main")
    expect(composeAicStatusLine("[AIC 1.00]", "")).toBe("[AIC 1.00]")
    expect(composeAicStatusLine("", "")).toBe("")
  })

  test("only the first user line is kept, trimmed", () => {
    expect(composeAicStatusLine("[AIC 1.00]", "  line1\nline2\n")).toBe(
      "[AIC 1.00] line1",
    )
  })
})

describe("runUserStatusLine", () => {
  test("empty command is a no-op", () => {
    expect(runUserStatusLine("", "")).toBe("")
    expect(runUserStatusLine("   ", "")).toBe("")
  })

  test("a failing command yields empty, never throws", () => {
    expect(runUserStatusLine("definitely-not-a-real-command-xyz", "")).toBe("")
  })

  test("captures the first stdout line", () => {
    // `echo` exists in both POSIX sh and Windows cmd.
    expect(runUserStatusLine("echo hello-aic", "")).toBe("hello-aic")
  })

  test("forwards session JSON on stdin (scripts reading to EOF terminate)", () => {
    // A script that blocks reading stdin to end-of-input must receive the
    // forwarded session JSON and terminate — previously stdin was
    // disconnected and such scripts hung until the timeout.
    const echoStdin = `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d))"`
    expect(runUserStatusLine(echoStdin, '{"model":"sonnet"}')).toBe('{"model":"sonnet"}')
    expect(runUserStatusLine(echoStdin, "")).toBe("")
  })
})
