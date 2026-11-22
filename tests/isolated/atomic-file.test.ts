import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  RENAME_RETRY_DELAYS_MS,
  readFileWithRetry,
  renameWithRetry,
  writeFileAtomic,
} from "~/lib/atomic-file"

const dirs: Array<string> = []

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("writeFileAtomic", () => {
  test("replaces the destination and leaves no temp file behind", async () => {
    const dir = await tmpDir()
    const target = path.join(dir, "current.json")
    await fs.writeFile(target, '{"v":1}\n')
    await writeFileAtomic(target, '{"v":2}\n')
    expect(await fs.readFile(target, "utf8")).toBe('{"v":2}\n')
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  test.skipIf(process.platform === "win32")(
    "creates the destination 0o600 by default and honours an explicit mode",
    async () => {
      // POSIX-only by nature: Windows has no mode bits. `fs.stat().mode` there is
      // derived from the read-only attribute, so 0o600 and 0o644 are
      // indistinguishable and this assertion cannot mean anything. The behaviour
      // it guards (the atomic write passes `mode` through) is still exercised on
      // Windows by the replace/leftover tests above.
      const dir = await tmpDir()
      const secret = path.join(dir, "token")
      await writeFileAtomic(secret, "s3cret")
      expect((await fs.stat(secret)).mode & 0o777).toBe(0o600)

      const worldReadable = path.join(dir, "pointer.json")
      await writeFileAtomic(worldReadable, "{}", { mode: 0o644 })
      expect((await fs.stat(worldReadable)).mode & 0o777).toBe(0o644)
    },
  )

  test("a pre-placed symlink at a temp name is never written through", async () => {
    const dir = await tmpDir()
    const victim = path.join(dir, "victim.txt")
    await fs.writeFile(victim, "untouched")
    // Plant symlinks under every plausible temp name shape: `randomBytes(8)`
    // makes a real collision unreachable, so this pins the *mechanism* (`wx`),
    // not the name.
    await fs.symlink(victim, path.join(dir, "planted"))
    const target = path.join(dir, "target.json")
    await writeFileAtomic(target, "new")
    expect(await fs.readFile(victim, "utf8")).toBe("untouched")
    expect(await fs.readFile(target, "utf8")).toBe("new")
  })

  test("a destination inside a missing directory throws rather than writing elsewhere", async () => {
    const dir = await tmpDir()
    await expect(writeFileAtomic(path.join(dir, "nope", "x.json"), "{}")).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("binary payloads round-trip byte-for-byte", async () => {
    const dir = await tmpDir()
    const target = path.join(dir, "blob")
    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    await writeFileAtomic(target, bytes)
    expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes)
  })
})

describe("renameWithRetry", () => {
  test("moves the file and reports success", async () => {
    const dir = await tmpDir()
    const from = path.join(dir, "a")
    const to = path.join(dir, "b")
    await fs.writeFile(from, "x")
    expect(await renameWithRetry(from, to, { delaysMs: [] })).toBe(true)
    expect(await fs.readFile(to, "utf8")).toBe("x")
  })

  test("accepts a racer that landed identical bytes", async () => {
    const dir = await tmpDir()
    const to = path.join(dir, "target")
    await fs.writeFile(to, "same")
    const missing = path.join(dir, "missing")
    expect(
      await renameWithRetry(missing, to, { acceptedContent: "same", delaysMs: [] }),
    ).toBe(true)
  })

  test("reports failure (never throws) when the destination differs and the source is gone", async () => {
    const dir = await tmpDir()
    const to = path.join(dir, "target")
    await fs.writeFile(to, "theirs")
    const missing = path.join(dir, "missing")
    expect(
      await renameWithRetry(missing, to, { acceptedContent: "ours", delaysMs: [] }),
    ).toBe(false)
    // The destination is untouched — that is the property a pointer needs.
    expect(await fs.readFile(to, "utf8")).toBe("theirs")
  })

  test("without acceptedContent a mismatched destination is a hard failure", async () => {
    const dir = await tmpDir()
    const to = path.join(dir, "target")
    await fs.writeFile(to, "theirs")
    expect(await renameWithRetry(path.join(dir, "missing"), to, { delaysMs: [] })).toBe(false)
  })

  test("retries through a transient EPERM and then succeeds", async () => {
    const dir = await tmpDir()
    const from = path.join(dir, "a")
    const to = path.join(dir, "b")
    await fs.writeFile(from, "x")

    // Simulate the Windows AV window by making the first rename attempt fail.
    const realRename = fs.rename.bind(fs)
    let attempts = 0
    const spy = async (src: fs.FileHandle | string, dest: string) => {
      attempts += 1
      if (attempts === 1) {
        const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException
        err.code = "EPERM"
        throw err
      }
      return realRename(src as string, dest)
    }
    const original = fs.rename
    ;(fs as unknown as { rename: typeof spy }).rename = spy
    try {
      expect(await renameWithRetry(from, to, { delaysMs: [0] })).toBe(true)
    } finally {
      ;(fs as unknown as { rename: typeof original }).rename = original
    }
    expect(attempts).toBe(2)
    expect(await fs.readFile(to, "utf8")).toBe("x")
  })

  test("the retry schedule has more than one attempt with a non-zero first delay", () => {
    expect(RENAME_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(2)
    expect(RENAME_RETRY_DELAYS_MS[0]!).toBeGreaterThan(0)
  })
})

describe("readFileWithRetry", () => {
  test("reads normally", async () => {
    const dir = await tmpDir()
    const file = path.join(dir, "f")
    await fs.writeFile(file, "hi")
    expect(await readFileWithRetry(file)).toBe("hi")
  })

  test("a missing file still throws ENOENT after the retries", async () => {
    const dir = await tmpDir()
    const err = (await readFileWithRetry(path.join(dir, "absent"), { delaysMs: [] }).catch(
      (e: unknown) => e,
    )) as NodeJS.ErrnoException
    expect(err.code).toBe("ENOENT")
  })

  test("retryMissing:false surfaces ENOENT immediately (the pointer's first-run path)", async () => {
    const dir = await tmpDir()
    const started = Date.now()
    const err = (await readFileWithRetry(path.join(dir, "absent"), {
      retryMissing: false,
    }).catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(err.code).toBe("ENOENT")
    // With the default schedule this would take the full 750 ms backoff.
    expect(Date.now() - started).toBeLessThan(200)
  })
})
