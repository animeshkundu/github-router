import { afterEach, describe, expect, test } from "bun:test"

import { leaseGateEnabled } from "~/lib/first-mate/tools"

/**
 * Minor: the drive-lease gate has its OWN hatch (GH_ROUTER_FM_LEASE_GATE) and is
 * no longer coupled to GH_ROUTER_FM_OCC. Disabling ledger OCC must NOT silently
 * also disable the single-driver lease gate — that would be one hatch turning
 * off two independent safety mechanisms.
 */
afterEach(() => {
  delete process.env.GH_ROUTER_FM_LEASE_GATE
  delete process.env.GH_ROUTER_FM_OCC
})

describe("drive-gate hatch is decoupled from the OCC hatch", () => {
  test("default: lease gate ON", () => {
    expect(leaseGateEnabled()).toBe(true)
  })

  test("GH_ROUTER_FM_OCC=0 does NOT disable the lease gate", () => {
    process.env.GH_ROUTER_FM_OCC = "0"
    expect(leaseGateEnabled()).toBe(true)
  })

  test("GH_ROUTER_FM_LEASE_GATE=0 is the dedicated lease-gate hatch", () => {
    process.env.GH_ROUTER_FM_LEASE_GATE = "0"
    expect(leaseGateEnabled()).toBe(false)
  })
})
