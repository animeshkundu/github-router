import { expect, test } from "bun:test"
import fs from "node:fs"

import {
  editorVersionCachePath,
  resolveEditorVersion,
} from "~/lib/editor-version-cache"

/**
 * The editor-version cache exists so the VS Code / Copilot Chat impersonation
 * headers stay real WITHOUT paying a third-party network fetch on every
 * process spawn. These tests pin the two invariants that keep it honest.
 */

function clearCache(): void {
  fs.rmSync(editorVersionCachePath(), { force: true })
}

test("cold miss fetches and persists; warm hit does no network", async () => {
  clearCache()
  let fetches = 0
  const fetcher = async () => {
    fetches++
    return "9.9.9"
  }

  expect(await resolveEditorVersion("vscode", fetcher, "FALLBACK")).toBe("9.9.9")
  expect(fetches).toBe(1)
  expect(fs.existsSync(editorVersionCachePath())).toBe(true)

  // The whole point: a second resolution inside the TTL must not refetch.
  expect(await resolveEditorVersion("vscode", fetcher, "FALLBACK")).toBe("9.9.9")
  expect(fetches).toBe(1)

  clearCache()
})

test("a FALLBACK result is never persisted", async () => {
  clearCache()

  // A failed lookup returns the hardcoded constant. Persisting it would let a
  // transient outage freeze the version we advertise for the whole TTL — and
  // survive restarts — so the cache must stay empty for this key.
  expect(await resolveEditorVersion("copilotChat", async () => "FB", "FB")).toBe(
    "FB",
  )

  const raw =
    fs.existsSync(editorVersionCachePath()) ?
      fs.readFileSync(editorVersionCachePath(), "utf8")
    : "{}"
  expect(raw.includes("copilotChat")).toBe(false)

  clearCache()
})

test("a stale real value beats the fallback when a refetch fails", async () => {
  clearCache()
  await resolveEditorVersion("vscode", async () => "1.2.3", "FALLBACK")

  // Age the entry past the 12h TTL.
  const cache = JSON.parse(
    fs.readFileSync(editorVersionCachePath(), "utf8"),
  ) as Record<string, { value: string; checkedAt: string }>
  cache.vscode.checkedAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  fs.writeFileSync(editorVersionCachePath(), JSON.stringify(cache))

  // Refetch fails -> fallback. A version that was genuinely current is a
  // closer impersonation than a constant frozen at release time.
  expect(
    await resolveEditorVersion("vscode", async () => "FALLBACK", "FALLBACK"),
  ).toBe("1.2.3")

  clearCache()
})

test("a corrupt cache file degrades to a fetch, not a throw", async () => {
  fs.writeFileSync(editorVersionCachePath(), "{ not json")
  let fetches = 0
  const v = await resolveEditorVersion(
    "vscode",
    async () => {
      fetches++
      return "5.5.5"
    },
    "FALLBACK",
  )
  expect(v).toBe("5.5.5")
  expect(fetches).toBe(1)
  clearCache()
})
