import { expect, test } from "bun:test"

import {
  OPENAI_FRONTIER_MODELS,
  shimDefaultsToXhigh,
} from "~/lib/openai-frontier"

test("OPENAI_FRONTIER_MODELS pins selection preference order", () => {
  expect(Array.from(OPENAI_FRONTIER_MODELS)).toEqual(["gpt-5.6-sol", "gpt-5.5"])
})

test("shimDefaultsToXhigh recognizes normalized frontier ids", () => {
  expect(shimDefaultsToXhigh("gpt-5.6-sol")).toBe(true)
  expect(shimDefaultsToXhigh("gpt-5.5")).toBe(true)
  expect(shimDefaultsToXhigh("openai/gpt-5.6-sol")).toBe(true)
  expect(shimDefaultsToXhigh("gpt-5.6-sol[1m]")).toBe(true)
})

test("shimDefaultsToXhigh rejects non-policy models", () => {
  expect(shimDefaultsToXhigh("gpt-5.3-codex")).toBe(false)
  expect(shimDefaultsToXhigh("gemini-3.1-pro-preview")).toBe(false)
  expect(shimDefaultsToXhigh("gpt-5.4-mini")).toBe(false)
})
