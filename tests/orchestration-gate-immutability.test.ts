/**
 * Unit tests for gate-immutability detection
 * (`src/lib/orchestration/gate-immutability.ts`). A miss here would let a
 * producer silently weaken the gates it is judged by — the cheapest floor
 * violation — so every weakening pattern has a positive case and the clean /
 * removed-line cases are pinned negative.
 */

import { describe, expect, test } from "bun:test"

import { detectGateWeakening } from "../src/lib/orchestration/gate-immutability"

const diff = (...lines: string[]): string => lines.join("\n")
const patterns = (d: string): string[] => detectGateWeakening(d).findings.map((f) => f.pattern)

describe("detectGateWeakening", () => {
  test("a clean diff is not flagged", () => {
    const d = diff("diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "+export const y = 1", "+function f() { return 2 }")
    const r = detectGateWeakening(d)
    expect(r.weakened).toBe(false)
    expect(r.findings).toEqual([])
  })

  test("adding a skipped test → skipped-test, with the file captured", () => {
    const d = diff("diff --git a/tests/a.test.ts b/tests/a.test.ts", "+++ b/tests/a.test.ts", "+  test.skip(\"flaky\", () => {})")
    const r = detectGateWeakening(d)
    expect(r.weakened).toBe(true)
    expect(r.findings[0]?.pattern).toBe("skipped-test")
    expect(r.findings[0]?.file).toBe("tests/a.test.ts")
  })

  test("xit / xdescribe / .only are all flagged as skipped-test", () => {
    expect(patterns(diff("+x", "+xit('a', () => {})"))).toContain("skipped-test")
    expect(patterns(diff("+xdescribe('a', () => {})"))).toContain("skipped-test")
    expect(patterns(diff("+describe.only('a', () => {})"))).toContain("skipped-test")
  })

  test("ts-ignore / ts-nocheck / ts-expect-error → ts-suppression", () => {
    expect(patterns(diff("+// @ts-ignore"))).toContain("ts-suppression")
    expect(patterns(diff("+// @ts-nocheck"))).toContain("ts-suppression")
    expect(patterns(diff("+// @ts-expect-error"))).toContain("ts-suppression")
  })

  test("`as any` and `: any` → any-cast", () => {
    expect(patterns(diff("+const x = foo as any"))).toContain("any-cast")
    expect(patterns(diff("+function f(x: any) {}"))).toContain("any-cast")
  })

  test("eslint-disable → eslint-disable", () => {
    expect(patterns(diff("+/* eslint-disable no-explicit-any */"))).toContain("eslint-disable")
    expect(patterns(diff("+foo() // eslint-disable-line"))).toContain("eslint-disable")
  })

  test("a REMOVED weakening (a `- .skip` line) is NOT flagged (strengthening)", () => {
    const d = diff("diff --git a/tests/a.test.ts b/tests/a.test.ts", "+++ b/tests/a.test.ts", "-  test.skip(\"flaky\", () => {})", "+  test(\"flaky\", () => {})")
    expect(detectGateWeakening(d).weakened).toBe(false)
  })

  test("the +++ file header itself is never flagged", () => {
    // a path containing "any" must not trip the any-cast pattern on the header.
    const d = diff("diff --git a/src/company.ts b/src/company.ts", "+++ b/src/company.ts", "+export const ok = true")
    expect(detectGateWeakening(d).weakened).toBe(false)
  })
})
