/**
 * Tests for `src/lib/colbert/watcher.ts` (Phase 2d).
 *
 * Real `fs.watch` on temp dirs (no mocks). Debounce forced to ~50ms via
 * `GH_ROUTER_WATCH_DEBOUNCE_MS` so the suite stays fast; production default
 * (10s) is covered by the debounce unit shape, not wall-clock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { watchWorkspace, type WatchEvent } from "../src/lib/colbert/watcher"

let dirs: Array<string> = []
let handles: Array<{ close: () => void }> = []

beforeEach(() => {
  process.env.GH_ROUTER_WATCH_DEBOUNCE_MS = "50"
})

afterEach(() => {
  for (const h of handles) h.close()
  handles = []
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  delete process.env.GH_ROUTER_WATCH_DEBOUNCE_MS
})

function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-watch-")))
  dirs.push(root)
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "a.ts"), "const a = 1\n")
  return root
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - t0 > timeoutMs) {
        reject(new Error("timed out waiting for watch event predicate"))
        return
      }
      setTimeout(poll, 25).unref?.()
    }
    poll()
  })
}

describe("watchWorkspace", () => {
  test("file change fires with the relative path", async () => {
    const root = fixture()
    const events: Array<WatchEvent> = []
    handles.push(watchWorkspace(root, (e) => events.push(e)))
    // Let the watcher attach before mutating.
    await Bun.sleep(200)
    writeFileSync(path.join(root, "src", "a.ts"), "const a = 2\n")
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/a.ts" || f.endsWith("/a.ts"))
    ))
    const matchingEvent = events.find((e) =>
      e.files.some((f) => f === "src/a.ts" || f.endsWith("/a.ts"))
    )!
    expect(matchingEvent.truncated).toBe(false)
  })

  test("rapid edits coalesce into one signal", async () => {
    const root = fixture()
    const events: Array<WatchEvent> = []
    handles.push(watchWorkspace(root, (e) => events.push(e)))
    await Bun.sleep(200)
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(root, "src", "a.ts"), `const a = ${i}\n`)
    }
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/a.ts" || f.endsWith("/a.ts"))
    ))
    // Debounce may allow a second flush on slow filesystems; the point is
    // coalescing happened (far fewer signals than edits).
    expect(events.length).toBeLessThan(5)
  })

  test("new file fires; delete fires", async () => {
    const root = fixture()
    const events: Array<WatchEvent> = []
    handles.push(watchWorkspace(root, (e) => events.push(e)))
    await Bun.sleep(200)
    writeFileSync(path.join(root, "src", "b.ts"), "const b = 1\n")
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/b.ts" || f.endsWith("/b.ts"))
    ))
    events.length = 0
    rmSync(path.join(root, "src", "b.ts"))
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/b.ts" || f.endsWith("/b.ts"))
    ))
  })

  test("ignored dirs (.git, node_modules) never fire", async () => {
    const root = fixture()
    mkdirSync(path.join(root, ".git"))
    mkdirSync(path.join(root, "node_modules"))
    const events: Array<WatchEvent> = []
    handles.push(watchWorkspace(root, (e) => events.push(e)))
    await Bun.sleep(200)
    writeFileSync(path.join(root, ".git", "index"), "x\n")
    writeFileSync(path.join(root, "node_modules", "p.js"), "x\n")
    // Also touch a real file to prove the watcher is alive at all.
    writeFileSync(path.join(root, "src", "a.ts"), "const a = 9\n")
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/a.ts" || f.endsWith("/a.ts"))
    ))
    const all = events.flatMap((e) => e.files)
    expect(all.some((f) => f.includes(".git") || f.includes("node_modules"))).toBe(false)
    expect(all.length).toBeGreaterThan(0)
  })

  test("close() stops callbacks", async () => {
    const root = fixture()
    const events: Array<WatchEvent> = []
    const h = watchWorkspace(root, (e) => events.push(e))
    handles.push(h)
    // Prove attachment first AND drain any fixture-creation events
    // (FSEvents can deliver those late — they must not pollute the
    // post-close assertion).
    writeFileSync(path.join(root, "src", "a.ts"), "const a = 2\n")
    await waitFor(() => events.some((e) =>
      e.files.some((f) => f === "src/a.ts" || f.endsWith("/a.ts"))
    ))
    events.length = 0
    h.close()
    writeFileSync(path.join(root, "src", "a.ts"), "const a = 3\n")
    await Bun.sleep(300)
    expect(events.length).toBe(0)
  })

  test("watchedDirs reports live watchers; missing root degrades", async () => {
    const root = fixture()
    const h = watchWorkspace(root, () => {})
    handles.push(h)
    expect(h.watchedDirs()).toBeGreaterThan(0)
    const missing = watchWorkspace(path.join(root, "nope"), () => {})
    handles.push(missing)
    // Never throws; close is safe on both.
    missing.close()
    expect(true).toBe(true)
  })
})
