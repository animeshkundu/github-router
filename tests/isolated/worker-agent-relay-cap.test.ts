/**
 * Tests for `src/lib/worker-agent/relay-cap.ts` — the relay-safe result
 * cap applied at the worker MCP boundary. A worker result over the byte
 * cap must be spilled to a durable file with a bounded UTF-8-safe preview
 * returned in its place, so it never overflows Claude Code's 25k-token
 * MCP result relay.
 *
 * Isolation: mock `os.homedir()` to a per-file temp dir BEFORE importing
 * anything that reads `PATHS`, so the spilled `.txt` lands under a temp
 * `WORKER_DIFFS_DIR` and never touches the real app dir.
 *
 * Cross-platform: no `process.platform === "win32"` skips (Windows-first CI).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cap-home-"))

mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const {
  relaySafeText,
  utf8HeadPreview,
  resolveMaxResultBytes,
  sweepAgedWorkerDiffs,
  WORKER_DIFF_NAME_RE,
} = await import("../../src/lib/worker-agent/relay-cap")
const { PATHS } = await import("../../src/lib/paths")

const ENV_KEY = "GH_ROUTER_WORKER_MAX_RESULT_BYTES"

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe("resolveMaxResultBytes", () => {
  test("defaults to 16KB and clamps the env override to [8KB, 20KB]", () => {
    delete process.env[ENV_KEY]
    expect(resolveMaxResultBytes()).toBe(16 * 1024)

    process.env[ENV_KEY] = "1000000" // way over
    expect(resolveMaxResultBytes()).toBe(20 * 1024)

    process.env[ENV_KEY] = "1024" // way under
    expect(resolveMaxResultBytes()).toBe(8 * 1024)

    process.env[ENV_KEY] = "12288" // in range
    expect(resolveMaxResultBytes()).toBe(12288)

    process.env[ENV_KEY] = "not-a-number"
    expect(resolveMaxResultBytes()).toBe(16 * 1024)
  })
})

describe("utf8HeadPreview", () => {
  test("returns the whole string when it fits", () => {
    expect(utf8HeadPreview("hello", 100)).toBe("hello")
  })

  test("never splits a multibyte codepoint", () => {
    // Each 😀 is 4 UTF-8 bytes. Ask for 6 bytes → must return exactly one
    // emoji (4 bytes), never a half-encoded second one.
    const s = "😀😀😀"
    const out = utf8HeadPreview(s, 6)
    expect(out).toBe("😀")
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(6)
    // The output must be valid UTF-8 with no replacement char.
    expect(out.includes("�")).toBe(false)
  })

  test("returns empty for a non-positive budget", () => {
    expect(utf8HeadPreview("abc", 0)).toBe("")
  })
})

describe("relaySafeText", () => {
  test("returns text unchanged when under the cap", async () => {
    const small = "just a small result"
    expect(await relaySafeText(small)).toBe(small)
  })

  test("spills over-cap text to a file and returns a bounded preview + path", async () => {
    process.env[ENV_KEY] = String(8 * 1024) // min cap for a smaller fixture
    const big = "A".repeat(50 * 1024)
    const out = await relaySafeText(big)

    // The returned envelope is at most the cap.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8 * 1024)
    // It carries the pointer to the saved file, and it is NOT the original.
    expect(out).toContain("full result saved to:")
    expect(out.length).toBeLessThan(big.length)

    // Extract the path and verify the FULL text is recoverable there.
    const marker = "saved to: "
    const savedPath = out.slice(out.lastIndexOf(marker) + marker.length).trim().replace(/]$/, "")
    expect(path.isAbsolute(savedPath)).toBe(true)
    expect(savedPath.startsWith(PATHS.WORKER_DIFFS_DIR)).toBe(true)
    expect(readFileSync(savedPath, "utf8")).toBe(big)
    rmSync(savedPath, { force: true })
  })
})

describe("sweepAgedWorkerDiffs", () => {
  test("removes >7-day .patch/.txt, keeps fresh ones, ignores foreign names", async () => {
    await fs.mkdir(PATHS.WORKER_DIFFS_DIR, { recursive: true })
    const old1 = path.join(PATHS.WORKER_DIFFS_DIR, "1234-abcd1234.patch")
    const old2 = path.join(PATHS.WORKER_DIFFS_DIR, "1234-abcd1234.txt")
    const fresh = path.join(PATHS.WORKER_DIFFS_DIR, "9999-99999999.txt")
    const foreign = path.join(PATHS.WORKER_DIFFS_DIR, "keep-me.md")
    await fs.writeFile(old1, "x")
    await fs.writeFile(old2, "x")
    await fs.writeFile(fresh, "x")
    await fs.writeFile(foreign, "x")

    // Backdate the two "old" files 8 days.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(old1, eightDaysAgo, eightDaysAgo)
    await fs.utimes(old2, eightDaysAgo, eightDaysAgo)

    await sweepAgedWorkerDiffs()

    expect(await fs.access(old1).then(() => true).catch(() => false)).toBe(false)
    expect(await fs.access(old2).then(() => true).catch(() => false)).toBe(false)
    expect(await fs.access(fresh).then(() => true).catch(() => false)).toBe(true)
    // A non-matching name is never touched, even if old.
    await fs.utimes(foreign, eightDaysAgo, eightDaysAgo)
    await sweepAgedWorkerDiffs()
    expect(await fs.access(foreign).then(() => true).catch(() => false)).toBe(true)

    rmSync(fresh, { force: true })
    rmSync(foreign, { force: true })
  })

  test("WORKER_DIFF_NAME_RE matches only <pid>-<8hex>.(patch|txt)", () => {
    expect(WORKER_DIFF_NAME_RE.test("123-abcdef01.patch")).toBe(true)
    expect(WORKER_DIFF_NAME_RE.test("123-abcdef01.txt")).toBe(true)
    expect(WORKER_DIFF_NAME_RE.test("123-abcdef01.md")).toBe(false)
    expect(WORKER_DIFF_NAME_RE.test("abc-abcdef01.txt")).toBe(false)
    expect(WORKER_DIFF_NAME_RE.test("123-xyz.txt")).toBe(false)
  })
})
