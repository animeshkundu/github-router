import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __testing } from "~/lib/paths"

/**
 * `mirrorDirRecursive` copies the user's `~/.claude` into a fresh per-launch
 * mirror on EVERY `github-router claude` start (the target dir is new each
 * time, so its mtime skip never fires across launches). It was a serial walk;
 * it now runs entries concurrently under a shared bounded semaphore.
 *
 * These tests pin the two things that change could break: the resulting tree
 * must be byte-identical to the serial version's, and the bound must actually
 * bound (an unbounded fan-out over hundreds of files exhausts file handles).
 */

const { mirrorDirRecursive, createSemaphore, MIRROR_COPY_CONCURRENCY } =
  __testing

async function makeTree(root: string): Promise<void> {
  // Wide and deep enough that concurrency and recursion actually interleave.
  for (let d = 0; d < 12; d++) {
    const dir = path.join(root, `dir${d}`, "nested", `deep${d}`)
    await fsp.mkdir(dir, { recursive: true })
    for (let f = 0; f < 12; f++) {
      await fsp.writeFile(path.join(dir, `f${f}.txt`), `content-${d}-${f}`)
    }
  }
  await fsp.writeFile(path.join(root, "top.txt"), "top-level")
}

function fingerprint(root: string): string {
  const h = createHash("sha256")
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const r = path.posix.join(rel, name)
      const st = fs.lstatSync(p)
      if (st.isDirectory()) {
        h.update(`D:${r}\n`)
        walk(p, r)
      } else if (st.isFile()) {
        h.update(`F:${r}:${fs.readFileSync(p, "utf8")}\n`)
      }
    }
  }
  walk(root, "")
  return h.digest("hex")
}

test("parallel mirror copy produces a byte-identical tree", async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "ghr-mirror-"))
  const src = path.join(base, "src")
  const dst = path.join(base, "dst")
  await fsp.mkdir(src, { recursive: true })
  await fsp.mkdir(dst, { recursive: true })
  await makeTree(src)

  await mirrorDirRecursive(src, dst, "")

  // Same content, same structure, nothing dropped and nothing duplicated.
  expect(fingerprint(dst)).toBe(fingerprint(src))

  await fsp.rm(base, { recursive: true, force: true })
})

test("the copy is idempotent across repeated runs", async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "ghr-mirror-"))
  const src = path.join(base, "src")
  const dst = path.join(base, "dst")
  await fsp.mkdir(src, { recursive: true })
  await fsp.mkdir(dst, { recursive: true })
  await makeTree(src)

  await mirrorDirRecursive(src, dst, "")
  const first = fingerprint(dst)
  // Second pass exercises the mtime-skip branch under concurrency.
  await mirrorDirRecursive(src, dst, "")
  expect(fingerprint(dst)).toBe(first)

  await fsp.rm(base, { recursive: true, force: true })
})

test("the semaphore never exceeds its limit", async () => {
  const limit = 4
  const withSlot = createSemaphore(limit)
  let active = 0
  let peak = 0

  await Promise.all(
    Array.from({ length: 200 }, () =>
      withSlot(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 1))
        active--
      }),
    ),
  )

  expect(peak).toBeLessThanOrEqual(limit)
  expect(active).toBe(0)
})

test("the semaphore releases its slot when the task throws", async () => {
  const withSlot = createSemaphore(1)
  await expect(
    withSlot(() => Promise.reject(new Error("boom"))),
  ).rejects.toThrow("boom")
  // A leaked slot at limit=1 would deadlock this second acquisition.
  expect(await withSlot(async () => "ok")).toBe("ok")
})

test("the concurrency limit is a sane bound", () => {
  expect(MIRROR_COPY_CONCURRENCY).toBeGreaterThan(1)
  expect(MIRROR_COPY_CONCURRENCY).toBeLessThanOrEqual(64)
})
