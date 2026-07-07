import { describe, expect, test } from "bun:test"

import { dispatchIdempotencyKey } from "~/lib/first-mate/controller"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const repo: RepoRef = { owner: "octo", name: "app" }
function unit(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "m1",
    repo,
    issue: null,
    pr: null,
    taskId: null,
    agent: "copilot",
    botLogin: "",
    dispatchMode: "plan",
    provider: "none",
    phase: "plan",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "t",
    id: "u1",
    ...overrides,
  }
}

describe("#1b — stable dispatch idempotency key", () => {
  test("is deterministic (same unit+attempt → same key), not random", () => {
    const a = dispatchIdempotencyKey(unit(), 1)
    const b = dispatchIdempotencyKey(unit(), 1)
    expect(a).toBe(b)
    expect(a).toBe("dispatch:octo/app#u1@1")
  })

  test("differs by attempt so a genuine re-dispatch is a new key", () => {
    expect(dispatchIdempotencyKey(unit(), 1)).not.toBe(dispatchIdempotencyKey(unit(), 2))
    expect(dispatchIdempotencyKey(unit(), 2)).toBe("dispatch:octo/app#u1@2")
  })

  test("falls back to issue number when the unit has no stable id", () => {
    expect(dispatchIdempotencyKey(unit({ id: undefined, issue: 42 }), 1)).toBe(
      "dispatch:octo/app#issue-42@1",
    )
  })
})
