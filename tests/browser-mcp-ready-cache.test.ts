import { expect, test } from "bun:test"

import {
  __resetEnsureBridgeReadyForTests,
  ensureBridgeReady,
} from "~/lib/browser-mcp/install-check"

/**
 * `ensureBridgeReady` runs twice per browser tool call (once in the pre-slot
 * `browserPreflight`, once in `dispatchBrowserTool` so internal compound
 * dispatches stay fail-closed). Its single-flight only collapses CONCURRENT
 * callers, so each sequential run was re-probing health and re-installing the
 * native-messaging host — spawning `where`/`which` (~196ms on Windows) and
 * `reg.exe` (~26ms) per browser, synchronously, on the server's event loop.
 *
 * A short-TTL cache of the READY result collapses that. The invariant that
 * matters is asymmetric: ready is cached, install_required is NOT — otherwise
 * loading the extension or installing a browser would not take effect until a
 * restart.
 */

test("an install_required result is never cached", async () => {
  __resetEnsureBridgeReadyForTests()

  // No browser/bridge is provisioned in CI, so this resolves install_required.
  const first = await ensureBridgeReady()
  if (!first.install_required) {
    // A dev machine with a live bridge: the negative case can't be exercised,
    // but the positive one still can — a ready result must be reused.
    const second = await ensureBridgeReady()
    expect(second).toBe(first)
    __resetEnsureBridgeReadyForTests()
    return
  }

  const second = await ensureBridgeReady()
  // Not the same object: the impl re-ran rather than serving a cached failure,
  // so a user who fixes the install is observed on the very next call.
  expect(second).not.toBe(first)
  expect(second.install_required).toBe(true)

  __resetEnsureBridgeReadyForTests()
})

test("concurrent callers still share one in-flight check", async () => {
  __resetEnsureBridgeReadyForTests()

  const [a, b, c] = await Promise.all([
    ensureBridgeReady(),
    ensureBridgeReady(),
    ensureBridgeReady(),
  ])

  // Single-flight is preserved by the caching change: all three observe the
  // same resolution rather than each spawning their own NMH install.
  expect(b).toBe(a)
  expect(c).toBe(a)

  __resetEnsureBridgeReadyForTests()
})

test("the reset helper clears the ready cache", async () => {
  __resetEnsureBridgeReadyForTests()
  const first = await ensureBridgeReady()
  __resetEnsureBridgeReadyForTests()
  const afterReset = await ensureBridgeReady()
  // Tests must not leak a cached ready result into each other.
  expect(afterReset).not.toBe(first)
  __resetEnsureBridgeReadyForTests()
})
