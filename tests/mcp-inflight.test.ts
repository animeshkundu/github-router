import { expect, test } from "bun:test"

import {
  __resetInFlightForTests,
  acquireInFlightSlot,
  currentInFlight,
} from "../src/lib/mcp-inflight"

test("a release from before a test reset cannot corrupt the new counter epoch", () => {
  __resetInFlightForTests()
  const staleRelease = acquireInFlightSlot()
  expect(staleRelease).not.toBeNull()
  expect(currentInFlight()).toBe(1)

  __resetInFlightForTests()
  const currentRelease = acquireInFlightSlot()
  expect(currentRelease).not.toBeNull()
  expect(currentInFlight()).toBe(1)

  staleRelease!()
  expect(currentInFlight()).toBe(1)

  currentRelease!()
  expect(currentInFlight()).toBe(0)
})
