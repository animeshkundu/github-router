import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-durable-store-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const { SchedulerLease } = await import("~/lib/first-mate/scheduler/lease")
const {
  DurableConflictError,
  DurableFencedError,
  commitJsonCas,
  runFenced,
  withFileLock,
  writeJsonSecure,
} = await import("~/lib/first-mate/durable-store")

interface StoreFile {
  version: 1
  rev?: number
  items: string[]
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function parseStore(raw: string | undefined): { rev: number; value: string[] } {
  if (raw === undefined) return { rev: 0, value: [] }
  const parsed = JSON.parse(raw) as Partial<StoreFile>
  return {
    rev: isNonNegativeInteger(parsed.rev) ? parsed.rev : 0,
    value: Array.isArray(parsed.items)
      ? parsed.items.filter((item): item is string => typeof item === "string")
      : [],
  }
}

function buildStore(items: string[], rev: number): StoreFile {
  return { version: 1, rev, items }
}

function storePath(name: string): string {
  return path.join(firstMateDir, `${name}.json`)
}

async function appendItem(
  file: string,
  item: string,
  opts: { expectedRev?: number; fencingToken?: number } = {},
): Promise<{ rev: number; result: string }> {
  return commitJsonCas<string[], string>({
    path: file,
    parse: parseStore,
    mutate: (items) => ({ value: [...items, item], result: item }),
    build: buildStore,
    expectedRev: opts.expectedRev,
    fencingToken: opts.fencingToken,
  })
}

async function readStore(file: string): Promise<StoreFile> {
  return JSON.parse(await fs.readFile(file, "utf8")) as StoreFile
}

beforeEach(async () => {
  delete process.env.GH_ROUTER_FM_OCC
  await fs.rm(firstMateDir, { recursive: true, force: true })
  await fs.mkdir(firstMateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(firstMateDir, { recursive: true, force: true })
})

describe("durable-store CAS primitive", () => {
  test("single-writer OCC-on commits increment rev", async () => {
    const file = storePath("single")

    await expect(appendItem(file, "a")).resolves.toEqual({ rev: 1, result: "a" })
    await expect(appendItem(file, "b")).resolves.toEqual({ rev: 2, result: "b" })

    await expect(readStore(file)).resolves.toMatchObject({
      version: 1,
      rev: 2,
      items: ["a", "b"],
    })
  })

  test("OCC-off escape hatch ignores stale expectedRev", async () => {
    process.env.GH_ROUTER_FM_OCC = "0"
    const file = storePath("off")

    await expect(appendItem(file, "a", { expectedRev: 999 })).resolves.toEqual({
      rev: 1,
      result: "a",
    })

    await expect(readStore(file)).resolves.toMatchObject({ rev: 1, items: ["a"] })
  })

  test("stale expectedRev throws DurableConflictError and does not clobber", async () => {
    const file = storePath("stale")
    await appendItem(file, "a") // rev 1
    const stale = (await readStore(file)).rev
    await appendItem(file, "b") // rev 2

    await expect(appendItem(file, "c", { expectedRev: stale })).rejects.toBeInstanceOf(
      DurableConflictError,
    )

    await expect(readStore(file)).resolves.toMatchObject({ rev: 2, items: ["a", "b"] })
  })

  test("three concurrent transparent-retry commits converge without lost updates", async () => {
    const file = storePath("concurrent")
    await appendItem(file, "seed")

    let readsAtSeed = 0
    let releaseSeedReads: () => void = () => {}
    const allReadSeed = new Promise<void>((resolve) => {
      releaseSeedReads = resolve
    })

    async function gatedAppend(item: string): Promise<{ rev: number; result: string }> {
      return commitJsonCas<string[], string>({
        path: file,
        parse: parseStore,
        mutate: async (items) => {
          if (items.length === 1 && items[0] === "seed") {
            readsAtSeed += 1
            if (readsAtSeed === 3) releaseSeedReads()
            await allReadSeed
          }
          return { value: [...items, item], result: item }
        },
        build: buildStore,
      })
    }

    await Promise.all([gatedAppend("a"), gatedAppend("b"), gatedAppend("c")])

    const after = await readStore(file)
    expect(after.rev).toBe(4)
    expect(after.items.sort()).toEqual(["a", "b", "c", "seed"])
  })

  test("fencing current token wins and stale token is rejected", async () => {
    const file = storePath("fence")
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()

    await appendItem(file, "a", { fencingToken: held1!.fencingToken })
    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2).toBeDefined()

    await expect(
      appendItem(file, "stale", { fencingToken: held1!.fencingToken }),
    ).rejects.toBeInstanceOf(DurableFencedError)
    await appendItem(file, "b", { fencingToken: held2!.fencingToken })

    await expect(readStore(file)).resolves.toMatchObject({ rev: 2, items: ["a", "b"] })
    await lease2.release()
  })

  test("ambient runFenced token is checked and stale tokens are rejected", async () => {
    const file = storePath("ambient")
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()

    await runFenced(held1!.fencingToken, async () => {
      await appendItem(file, "a")
    })
    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2).toBeDefined()

    await expect(
      runFenced(held1!.fencingToken, async () => {
        await appendItem(file, "stale")
      }),
    ).rejects.toBeInstanceOf(DurableFencedError)

    await expect(readStore(file)).resolves.toMatchObject({ rev: 1, items: ["a"] })
    await lease2.release()
  })

  test("pre-write fencing re-check aborts when token rotates after the first check", async () => {
    const file = storePath("recheck")
    await appendItem(file, "a")
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const leasePath = path.join(firstMateDir, "scheduler.lease.json")
    const originalReadFile = fs.readFile.bind(fs)
    let leaseReads = 0
    const readFileSpy = spyOn(fs, "readFile").mockImplementation(
      (async (...args: Parameters<typeof fs.readFile>) => {
        const result = await originalReadFile(...args)
        if (path.resolve(String(args[0])) === leasePath && leaseReads === 0) {
          leaseReads += 1
          // Return the first check's already-read token 1, but rotate the lease
          // before the second durable-store fencing check executes.
          await lease1.release()
          const held2 = await lease2.tryAcquire()
          expect(held2?.fencingToken).toBeGreaterThan(held1!.fencingToken)
        }
        return result
      }) as typeof fs.readFile,
    )

    try {
      await expect(
        appendItem(file, "b", { fencingToken: held1!.fencingToken }),
      ).rejects.toBeInstanceOf(DurableFencedError)
    } finally {
      readFileSpy.mockRestore()
      await lease2.release().catch(() => {})
    }

    await expect(readStore(file)).resolves.toMatchObject({ rev: 1, items: ["a"] })
    expect(leaseReads).toBe(1)
  })

  test("withFileLock preserves a stolen owner-token lock on release", async () => {
    const file = storePath("locked")
    const lockPath = `${file}.lock`

    let ownedBefore = false
    let ownedAfterSteal = true
    await withFileLock(file, async (verifyOwner) => {
      ownedBefore = await verifyOwner()
      await fs.writeFile(lockPath, "thief-token")
      ownedAfterSteal = await verifyOwner()
    })

    expect(ownedBefore).toBe(true)
    expect(ownedAfterSteal).toBe(false)
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("thief-token")
  })

  test("writeJsonSecure writes 0600 JSON with no temp files left behind", async () => {
    const file = storePath("secure")

    await writeJsonSecure(file, { version: 1, rev: 1, items: ["a"] })

    expect(await fs.readFile(file, "utf8")).toBe(
      `${JSON.stringify({ version: 1, rev: 1, items: ["a"] }, null, 2)}\n`,
    )
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    const entries = await fs.readdir(firstMateDir)
    expect(entries.some((entry) => entry.includes(".tmp."))).toBe(false)
  })

  test("back-compat parse treats no-rev file as rev 0 then first commit writes rev 1", async () => {
    const file = storePath("back-compat")
    await fs.writeFile(file, `${JSON.stringify({ version: 1, items: ["old"] }, null, 2)}\n`)

    await expect(appendItem(file, "new")).resolves.toEqual({ rev: 1, result: "new" })

    await expect(readStore(file)).resolves.toMatchObject({
      version: 1,
      rev: 1,
      items: ["old", "new"],
    })
  })
})
