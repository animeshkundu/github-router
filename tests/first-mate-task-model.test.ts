import { afterEach, beforeEach, expect, test } from "bun:test"

import { DEFAULT_CODEX_MODEL } from "~/lib/port"
import { resolveCloudAgentModel } from "~/lib/first-mate/task-model"
import { state } from "~/lib/state"

// resolveModel (used to normalize an explicit choice) consults the global
// catalog; null it out so normalization is identity and the membership check is
// driven purely by the INJECTED catalog these tests pass.
const originalModels = state.models

beforeEach(() => {
  state.models = undefined
})

afterEach(() => {
  state.models = originalModels
})

test("defaults to gpt-5.5 when no model is chosen and no catalog is available", () => {
  expect(resolveCloudAgentModel(undefined, null)).toBe(DEFAULT_CODEX_MODEL)
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.5")
})

test("returns the default when it IS present in the catalog", () => {
  expect(
    resolveCloudAgentModel(undefined, [{ id: "gpt-5.5" }, { id: "gpt-5.4" }]),
  ).toBe("gpt-5.5")
})

test("walks the fallback chain when the preferred default is absent for the tier", () => {
  // gpt-5.5 not served on this catalog; the first available fallback wins.
  expect(resolveCloudAgentModel(undefined, [{ id: "gpt-5.4" }])).toBe("gpt-5.4")
  expect(resolveCloudAgentModel(undefined, [{ id: "gpt-5.3-codex" }])).toBe(
    "gpt-5.3-codex",
  )
})

test("falls back to the default even when no fallback is in the catalog (best effort)", () => {
  // No default and no fallback present — still returns the preferred default
  // (the caller / dispatch surfaces the real availability error separately).
  expect(resolveCloudAgentModel(undefined, [{ id: "some-other-model" }])).toBe(
    DEFAULT_CODEX_MODEL,
  )
})

test("an explicitly chosen model present in the catalog is returned normalized", () => {
  expect(resolveCloudAgentModel("gpt-5.5", [{ id: "gpt-5.5" }])).toBe("gpt-5.5")
})

test("an explicitly chosen model ABSENT from a live catalog throws (never silently substituted)", () => {
  expect(() =>
    resolveCloudAgentModel("gpt-does-not-exist", [{ id: "gpt-5.5" }]),
  ).toThrow(/not in the Copilot catalog/)
})

test("an explicit choice with no catalog to check against is returned as-is (no enforcement)", () => {
  // Pre-fetch / test contexts: nothing to validate against, so honor the choice.
  expect(resolveCloudAgentModel("gpt-5.5", null)).toBe("gpt-5.5")
  expect(resolveCloudAgentModel("gpt-5.5", [])).toBe("gpt-5.5")
})

test("a blank / whitespace choice is treated as unspecified (default)", () => {
  expect(resolveCloudAgentModel("   ", null)).toBe(DEFAULT_CODEX_MODEL)
  expect(resolveCloudAgentModel("", null)).toBe(DEFAULT_CODEX_MODEL)
})
