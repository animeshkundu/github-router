import { describe, expect, test } from "bun:test"

import { parseIntent } from "../src/lib/browser-mcp/parse-intent"

describe("browser-mcp intent parser", () => {
  test.each([
    ["press Save", "click"],
    ["enter email field", "fill"],
    ["type search box", "type"],
    ["choose country dropdown", "select"],
    ["scroll-into-view Results", "scroll_into_view"],
  ] as const)("maps %s to the matcher verb %s", (intent, verb) => {
    expect(parseIntent(intent).verb).toBe(verb)
  })

  test.each([
    ["fill email with user@example.com", "user@example.com"],
    ["enter query to status:open", "status:open"],
    ["type token = abc-123", "abc-123"],
  ] as const)("extracts the value tail from %s", (intent, value) => {
    const parsed = parseIntent(intent)

    expect(parsed.valueFromIntent).toBe(value)
    expect(parsed.rawTarget).not.toContain(value)
  })

  test("explicit quotes preserve the exact accessible-name signal", () => {
    expect(parseIntent('click "Save changes" button')).toMatchObject({
      verb: "click",
      rawTarget: '"Save changes" button',
      quotedName: "Save changes",
      normTarget: '"save changes"',
    })
  })

  test("TitleCase labels supply an exact-name fallback without quotes", () => {
    expect(parseIntent("click Account Settings button")).toMatchObject({
      quotedName: "Account Settings",
      fieldHint: "settings",
      normTarget: "account settings",
    })
  })

  test.each([
    ["click the third card", { n: 3, kind: "card" }],
    ["click last tab", { n: -1, kind: "tab" }],
    ["click 4th button", { n: 4, kind: "button" }],
  ] as const)("extracts ordinal intent from %s", (intent, ordinal) => {
    expect(parseIntent(intent).ordinal).toEqual(ordinal)
  })

  test("normalizes an ordinal kind that is not also a field-hint kind", () => {
    expect(parseIntent("click the third card").normTarget).toBe("card")
  })

  test.each([
    ["fill email field", "email", "email"],
    ["click submit button", "submit", "submit"],
    ["select country dropdown", "country", "country"],
  ] as const)("extracts field hints and strips kind nouns from %s", (intent, fieldHint, normTarget) => {
    expect(parseIntent(intent)).toMatchObject({ fieldHint, normTarget })
  })

  test("normalization strips articles and collapses whitespace", () => {
    expect(parseIntent("  click   the   Save   button  ")).toMatchObject({
      verb: "click",
      rawTarget: "the   Save   button",
      normTarget: "save",
    })
  })

  test.each([
    ["", { rawTarget: "", normTarget: "" }],
    ["   ", { rawTarget: "", normTarget: "" }],
    ["%%% ???", { rawTarget: "%%% ???", normTarget: "%%% ???" }],
  ] as const)("malformed input %j falls through without inventing structure", (intent, expected) => {
    expect(parseIntent(intent)).toEqual(expected)
  })

  test("runtime nullish input is safely normalized despite the string API", () => {
    // MCP validation should normally keep this out, but the parser explicitly
    // promises a harmless fallback rather than throwing on a malformed caller.
    expect(parseIntent(null as unknown as string)).toEqual({
      rawTarget: "",
      normTarget: "",
    })
    expect(parseIntent(undefined as unknown as string)).toEqual({
      rawTarget: "",
      normTarget: "",
    })
  })

  test("unsupported focus and hover verbs leave the target intact", () => {
    // mapVerb cannot express these yet. Retaining the target makes the fallback
    // visible instead of silently claiming a supported action.
    expect(parseIntent("focus email field")).toMatchObject({
      rawTarget: "email field",
      normTarget: "email",
      fieldHint: "email",
    })
    expect(parseIntent("hover Help link")).toMatchObject({
      rawTarget: "Help link",
      normTarget: "help",
      fieldHint: "help",
    })
  })
})
