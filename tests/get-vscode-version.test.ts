import { afterEach, expect, mock, test } from "bun:test"

import {
  getVSCodeVersion,
  VSCODE_VERSION_FALLBACK,
} from "../src/services/get-vscode-version"

/**
 * `globalThis.fetch` is stubbed PER TEST, not at module scope. The module used
 * to end in a bare top-level `await getVSCodeVersion()`, so importing it fired
 * a real network call and the stub had to be installed before the import — a
 * cross-file hazard in the shared test lane, since a module-scope assignment
 * leaks to every other file in the process. That top-level call is gone (the
 * value is resolved through the 12h cache in `cacheVSCodeVersion()` instead),
 * so the stub belongs in the tests that need it.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("getVSCodeVersion parses pkgver", async () => {
  // @ts-expect-error - minimal fetch stub for this test
  globalThis.fetch = mock(() =>
    Promise.resolve({ text: () => Promise.resolve("pkgver=1.2.3") }),
  )

  expect(await getVSCodeVersion()).toBe("1.2.3")
})

test("getVSCodeVersion falls back when missing pkgver", async () => {
  // @ts-expect-error - minimal fetch stub for this test
  globalThis.fetch = mock(() =>
    Promise.resolve({ text: () => Promise.resolve("no version here") }),
  )

  expect(await getVSCodeVersion()).toBe(VSCODE_VERSION_FALLBACK)
})

test("getVSCodeVersion falls back on fetch error", async () => {
  // @ts-expect-error - minimal fetch stub for this test
  globalThis.fetch = mock(() => Promise.reject(new Error("fail")))

  expect(await getVSCodeVersion()).toBe(VSCODE_VERSION_FALLBACK)
})

test("importing the module performs NO network call", async () => {
  let calls = 0
  const counting = mock((...args: Parameters<typeof fetch>) => {
    calls++
    return originalFetch(...args)
  })
  // @ts-expect-error - counting fetch stub
  globalThis.fetch = counting

  // A fresh import (cache-busted) must not fetch. This is the regression guard
  // for the top-level await that used to cost ~1.5s on EVERY process spawn,
  // including the per-turn Claude Code hooks.
  await import(`../src/services/get-vscode-version?probe=${Date.now()}`)
  expect(calls).toBe(0)
})
