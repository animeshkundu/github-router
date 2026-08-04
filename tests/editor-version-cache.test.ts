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

  // A failed lookup yields the hardcoded constant. Persisting it would let a
  // transient outage freeze the version we advertise for the whole TTL — and
  // survive restarts — so the cache must stay empty for this key.
  expect(
    await resolveEditorVersion("copilotChat", async () => undefined, "FB"),
  ).toBe("FB")

  const raw =
    fs.existsSync(editorVersionCachePath()) ?
      fs.readFileSync(editorVersionCachePath(), "utf8")
    : "{}"
  expect(raw.includes("copilotChat")).toBe(false)

  clearCache()
})

test("a real version that EQUALS the fallback is still cached", async () => {
  clearCache()
  let fetches = 0
  // The live version legitimately equals the constant right after someone
  // bumps the fallback to the then-current release. Failure must be signalled
  // out-of-band (undefined), never inferred from `value === fallback` — that
  // reading would refuse to cache a perfectly good result and make every
  // launch re-pay the ~1.5s network call forever.
  const fetcher = async () => {
    fetches++
    return "SAME"
  }

  expect(await resolveEditorVersion("vscode", fetcher, "SAME")).toBe("SAME")
  expect(await resolveEditorVersion("vscode", fetcher, "SAME")).toBe("SAME")
  expect(fetches).toBe(1)

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
    await resolveEditorVersion("vscode", async () => undefined, "FALLBACK"),
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

test("concurrent cold resolutions do not clobber each other", async () => {
  clearCache()

  // `setupAndServe` resolves both keys under one Promise.all. Each spends
  // ~1.5s in its fetch, so without serialization both would write back the
  // empty object they read BEFORE fetching and the slower one would erase the
  // faster one's entry — leaving one version re-fetching on every launch.
  const slow = (value: string, ms: number) => async () => {
    await new Promise((r) => setTimeout(r, ms))
    return value
  }

  await Promise.all([
    resolveEditorVersion("vscode", slow("1.1.1", 40), "FALLBACK"),
    resolveEditorVersion("copilotChat", slow("2.2.2", 5), "FALLBACK"),
  ])

  const cache = JSON.parse(
    fs.readFileSync(editorVersionCachePath(), "utf8"),
  ) as Record<string, { value: string }>
  expect(cache.vscode?.value).toBe("1.1.1")
  expect(cache.copilotChat?.value).toBe("2.2.2")

  clearCache()
})
