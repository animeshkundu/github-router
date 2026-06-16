/**
 * Tests for the sealed gate registry (`gate-registry.ts`). The registry is the
 * invariant-5 boundary: a model references a gate by id and can never author the
 * command, so the key properties are "known ids resolve, unknown ids do not, and
 * the returned command set cannot be mutated back into the registry".
 */

import { describe, expect, test } from "bun:test"

import { resolveSealedGate, sealedGateIds } from "../src/lib/orchestration/gate-registry"

describe("gate-registry", () => {
  test("a known id resolves to its sealed checks", () => {
    const g = resolveSealedGate("default-ci")
    expect(g?.id).toBe("default-ci")
    expect(g?.checks.map((c) => c.id).sort()).toEqual(["lint", "test", "typecheck"])
    // every check carries a sealed command string.
    expect(g?.checks.every((c) => typeof c.command === "string" && c.command.length > 0)).toBe(true)
  })

  test("an unknown id resolves to undefined (rejected before the kernel runs)", () => {
    expect(resolveSealedGate("rm -rf /")).toBeUndefined()
    expect(resolveSealedGate("")).toBeUndefined()
  })

  test("sealedGateIds reports the registered gates and feeds knownGateIds", () => {
    const ids = sealedGateIds()
    expect(ids.has("default-ci")).toBe(true)
    expect(ids.has("typecheck-only")).toBe(true)
    expect(ids.has("nope")).toBe(false)
  })

  test("the returned check set is a defensive clone (cannot mutate the registry)", () => {
    const a = resolveSealedGate("default-ci")!
    a.checks[0]!.command = "echo pwned"
    a.checks.push({ id: "evil", command: "echo evil" })
    const b = resolveSealedGate("default-ci")!
    expect(b.checks.some((c) => c.command === "echo pwned")).toBe(false)
    expect(b.checks.some((c) => c.id === "evil")).toBe(false)
  })
})
