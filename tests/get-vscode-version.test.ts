import { test, expect, mock, afterEach } from "bun:test"

const originalFetch = globalThis.fetch
const fetchMock = mock(() =>
  Promise.resolve({
    text: () => Promise.resolve("pkgver=1.2.3"),
  }),
)
// @ts-expect-error - override fetch for module import
globalThis.fetch = fetchMock

const { getVSCodeVersion } = await import("../src/services/get-vscode-version")

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("getVSCodeVersion parses pkgver", async () => {
  const version = await getVSCodeVersion()
  expect(version).toBe("1.2.3")
})

test("getVSCodeVersion falls back when missing pkgver", async () => {
  const noMatchFetch = mock(() =>
    Promise.resolve({
      text: () => Promise.resolve("no version here"),
    }),
  )
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = noMatchFetch

  const version = await getVSCodeVersion()
  expect(version).toBe("1.104.3")
})

test("getVSCodeVersion falls back on fetch error", async () => {
  const errorFetch = mock(() => Promise.reject(new Error("fail")))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = errorFetch

  const version = await getVSCodeVersion()
  expect(version).toBe("1.104.3")
})
