import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { fleetToolsEnabled } from "../../src/lib/mcp-capabilities"
import { state } from "../../src/lib/state"

let previousFleetEnabled: boolean
let previousFleetEnv: string | undefined

function restoreFleetEnv(): void {
  if (previousFleetEnv === undefined) {
    delete process.env.GH_ROUTER_ENABLE_FLEET
  } else {
    process.env.GH_ROUTER_ENABLE_FLEET = previousFleetEnv
  }
}

describe("fleetToolsEnabled", () => {
  beforeEach(() => {
    previousFleetEnabled = state.fleetEnabled
    previousFleetEnv = process.env.GH_ROUTER_ENABLE_FLEET
    state.fleetEnabled = false
    delete process.env.GH_ROUTER_ENABLE_FLEET
  })

  afterEach(() => {
    state.fleetEnabled = previousFleetEnabled
    restoreFleetEnv()
  })

  test("is false by default", () => {
    expect(fleetToolsEnabled()).toBe(false)
  })

  test("is true when GH_ROUTER_ENABLE_FLEET=1", () => {
    process.env.GH_ROUTER_ENABLE_FLEET = "1"

    expect(fleetToolsEnabled()).toBe(true)
  })

  test("is true when state.fleetEnabled=true", () => {
    state.fleetEnabled = true

    expect(fleetToolsEnabled()).toBe(true)
  })
})
