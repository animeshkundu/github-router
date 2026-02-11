import { test, expect, mock, afterEach } from "bun:test"

import { state } from "../src/lib/state"
import { cacheModels, cacheVSCodeVersion, isNullish, sleep } from "../src/lib/utils"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("isNullish handles null and undefined", () => {
  expect(isNullish(null)).toBe(true)
  expect(isNullish(undefined)).toBe(true)
  expect(isNullish(0)).toBe(false)
})

test("cacheModels stores models in state", async () => {
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [], object: "list" }))
    }
    return new Response("pkgver=1.2.3")
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  state.copilotToken = "token"
  state.vsCodeVersion = "1.2.3"
  state.accountType = "individual"
  state.models = undefined
  await cacheModels()
  const models = state.models as { object: string } | undefined
  if (!models) {
    throw new Error("Expected models to be cached")
  }
  expect(models.object).toBe("list")
})

test("cacheVSCodeVersion updates state", async () => {
  const fetchMock = mock(() => new Response("pkgver=1.2.3"))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  state.vsCodeVersion = undefined
  await cacheVSCodeVersion()
  if (!state.vsCodeVersion) {
    throw new Error("Expected VSCode version to be cached")
  }
  expect(state.vsCodeVersion as string).toBe("1.2.3")
})

test("sleep resolves after timeout", async () => {
  await sleep(0)
  expect(true).toBe(true)
})
