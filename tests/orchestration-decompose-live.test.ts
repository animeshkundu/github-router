/**
 * Tests for the pure parts of the live decompose adapter
 * (`src/lib/orchestration/decompose-live.ts`): extracting the IR JSON from
 * model text and parsing critic concerns. The model dispatch itself is the
 * gated-E2E part and is not exercised here.
 */

import { describe, expect, test } from "bun:test"

import { extractJson, parseConcerns } from "../src/lib/orchestration/decompose-live"

describe("extractJson", () => {
  test("a bare JSON object parses", () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] })
  })

  test("a ```json fenced block parses", () => {
    expect(extractJson("here is the IR:\n```json\n{ \"ok\": true }\n```\n")).toEqual({ ok: true })
  })

  test("JSON embedded in prose is extracted by brace balance", () => {
    expect(extractJson('Sure!\n{"id":"x","nested":{"y":1}}\nLet me know.')).toEqual({ id: "x", nested: { y: 1 } })
  })

  test("braces inside strings do not confuse the balancer", () => {
    expect(extractJson('{"s":"a } b { c","n":1}')).toEqual({ s: "a } b { c", n: 1 })
  })

  test("no JSON → undefined", () => {
    expect(extractJson("no json here")).toBeUndefined()
  })

  test("invalid JSON → undefined (never throws)", () => {
    expect(extractJson("{ not valid json ]")).toBeUndefined()
    expect(extractJson(42 as unknown as string)).toBeUndefined()
  })
})

describe("parseConcerns", () => {
  test("a { concerns: [...] } JSON object", () => {
    expect(parseConcerns('{"concerns":["a","b"]}')).toEqual(["a", "b"])
  })

  test("a JSON object with no concerns → empty", () => {
    expect(parseConcerns('{"concerns":[]}')).toEqual([])
  })

  test("a bullet list fallback", () => {
    expect(parseConcerns("Concerns:\n- missing a test node\n- wrong checker lab\nthanks")).toEqual([
      "missing a test node",
      "wrong checker lab",
    ])
  })

  test("a numbered list fallback", () => {
    expect(parseConcerns("1. first\n2) second")).toEqual(["first", "second"])
  })

  test("prose with no list → empty", () => {
    expect(parseConcerns("The IR looks sound to me.")).toEqual([])
  })
})
