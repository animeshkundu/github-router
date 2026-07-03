import { afterEach, describe, expect, test } from "bun:test"

import { assertOccSafeForDaemon } from "~/lib/first-mate/scheduler"

/**
 * #9 (F5) — GH_ROUTER_FM_OCC=0 turns off the cross-process lock/CAS/fencing that
 * is the only thing rejecting a fenced-out driver's writes. Running the daemon
 * (a second driver) under OCC=0 reopens split-brain, so the daemon must refuse
 * to start unless an explicit, separate single-driver override is set.
 */
afterEach(() => {
  delete process.env.GH_ROUTER_FM_OCC
  delete process.env.GH_ROUTER_FM_ALLOW_UNSAFE_OCC
})

describe("daemon OCC-disabled start guard", () => {
  test("OCC on (default): daemon may start", () => {
    expect(() => assertOccSafeForDaemon()).not.toThrow()
  })

  test("OCC=0 without override: daemon refuses to start", () => {
    process.env.GH_ROUTER_FM_OCC = "0"
    expect(() => assertOccSafeForDaemon()).toThrow(/GH_ROUTER_FM_OCC=0|split-brain/i)
  })

  test("OCC=0 WITH the explicit single-driver override: allowed", () => {
    process.env.GH_ROUTER_FM_OCC = "0"
    process.env.GH_ROUTER_FM_ALLOW_UNSAFE_OCC = "1"
    expect(() => assertOccSafeForDaemon()).not.toThrow()
  })

  test("the override alone (OCC still on) is a no-op — daemon starts normally", () => {
    process.env.GH_ROUTER_FM_ALLOW_UNSAFE_OCC = "1"
    expect(() => assertOccSafeForDaemon()).not.toThrow()
  })
})
