import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { isCurrentFencingToken } from "~/lib/first-mate/scheduler/lease"

export class DurableConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DurableConflictError"
  }
}

export class DurableFencedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DurableFencedError"
  }
}

/**
 * OCC + cross-process lock + fencing on durable JSON stores are ON by default.
 * Escape hatch: set `GH_ROUTER_FM_OCC=0` to fall back to in-process-serialized
 * writes (no lock, no CAS, no fencing).
 */
export function occEnabled(): boolean {
  return process.env.GH_ROUTER_FM_OCC !== "0"
}

/**
 * Ambient fencing token for durable store writes. A scheduler driver wraps its
 * whole sweep in `runFenced(token, ...)`; commits inside that scope default to
 * the token unless the caller passes an explicit `fencingToken`.
 */
const fenceStore = new AsyncLocalStorage<number>()

export function runFenced<T>(token: number, fn: () => Promise<T>): Promise<T> {
  return fenceStore.run(token, fn)
}

export function currentFenceToken(): number | undefined {
  return fenceStore.getStore()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function writeJsonSecure<T>(target: string, value: T): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => {})
    await fs.rename(tmp, target)
    await fs.chmod(target, 0o600).catch(() => {})
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

const LOCK_TTL_MS = 15_000
const LOCK_RETRY_MS = 25
const LOCK_MAX_WAIT_MS = 10_000

export async function withFileLock<T>(
  target: string,
  fn: (verifyOwner: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const lockPath = `${target}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const ownerToken = `${process.pid}-${randomBytes(8).toString("hex")}`
  const start = Date.now()
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx")
      await fh.writeFile(ownerToken)
      await fh.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        const st = await fs.stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(`first-mate durable-store lock timeout for ${target}`)
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  // True iff the lock file still holds OUR token (no one broke + re-took it).
  const verifyOwner = async (): Promise<boolean> => {
    try {
      return (await fs.readFile(lockPath, "utf8")).trim() === ownerToken
    } catch {
      return false // vanished / unreadable → we no longer own it
    }
  }
  try {
    return await fn(verifyOwner)
  } finally {
    // Only remove the lock if it is still ours — never delete a thief's lock.
    if (await verifyOwner()) await fs.unlink(lockPath).catch(() => {})
  }
}

const writeChains = new Map<string, Promise<void>>()

function serializeWrite<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous.then(work)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(file, settled)
  settled.then(() => {
    if (writeChains.get(file) === settled) writeChains.delete(file)
  })
  return next
}

export interface CommitJsonCasOptions<TValue, TResult> {
  path: string
  parse: (raw: string | undefined) => { rev: number; value: TValue }
  mutate: (
    value: TValue,
  ) => { value: TValue; result: TResult } | Promise<{ value: TValue; result: TResult }>
  build: (value: TValue, rev: number) => unknown
  occEnabled?: () => boolean
  expectedRev?: number
  fencingToken?: number
}

const OCC_MAX_ATTEMPTS = 5
const OCC_BACKOFF_MS = 10

async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/**
 * Generic durable JSON compare-and-swap commit. With OCC enabled, transient
 * rev conflicts for callers WITHOUT `expectedRev` are retried internally (fresh
 * read → re-apply `mutate` → CAS write); normal contention therefore does not
 * surface as `DurableConflictError` unless all retry attempts are exhausted.
 * Passing `expectedRev` requests strict CAS and surfaces the first conflict.
 */
export async function commitJsonCas<TValue, TResult = void>(
  opts: CommitJsonCasOptions<TValue, TResult>,
): Promise<{ rev: number; result: TResult }> {
  if ((opts.occEnabled ?? occEnabled)() === false) {
    let committed: { rev: number; result: TResult } | undefined
    await serializeWrite(opts.path, async () => {
      const { rev, value } = opts.parse(await readRaw(opts.path))
      const { value: next, result } = await opts.mutate(value)
      const nextRev = rev + 1
      await writeJsonSecure(opts.path, opts.build(next, nextRev))
      committed = { rev: nextRev, result }
    })
    return committed as { rev: number; result: TResult }
  }

  const explicit = opts.expectedRev !== undefined
  const fencingToken = opts.fencingToken ?? currentFenceToken()
  let lastConflict: DurableConflictError | undefined
  for (let attempt = 0; attempt < OCC_MAX_ATTEMPTS; attempt += 1) {
    const { rev, value } = opts.parse(await readRaw(opts.path))
    const base = explicit ? (opts.expectedRev as number) : rev
    if (explicit && base !== rev) {
      throw new DurableConflictError(
        `durable store rev mismatch for ${opts.path}: expected ${base}, on-disk ${rev}`,
      )
    }
    const { value: next, result } = await opts.mutate(value)
    const outcome = await withFileLock(opts.path, async (verifyOwner) => {
      const { rev: lockedRev } = opts.parse(await readRaw(opts.path))
      if (
        fencingToken !== undefined &&
        !(await isCurrentFencingToken(fencingToken))
      ) {
        throw new DurableFencedError(
          `stale fencing token ${fencingToken} for ${opts.path}`,
        )
      }
      if (lockedRev !== base) return "conflict" as const
      if (
        fencingToken !== undefined &&
        !(await isCurrentFencingToken(fencingToken))
      ) {
        throw new DurableFencedError(
          `stale fencing token ${fencingToken} for ${opts.path} (rotated before write)`,
        )
      }
      // FINAL gate: re-verify lock ownership immediately before the write, with
      // no further await in between. If our lock was broken-as-stale and re-taken
      // by another writer (e.g. we stalled >LOCK_TTL_MS mid-critical-section),
      // bail to "conflict" and retry on fresh state — never overwrite the thief.
      if (!(await verifyOwner())) return "conflict" as const
      await writeJsonSecure(opts.path, opts.build(next, lockedRev + 1))
      return "ok" as const
    })
    if (outcome === "ok") return { rev: base + 1, result }
    if (explicit) {
      throw new DurableConflictError(
        `durable store rev changed under CAS for ${opts.path} (expected ${base})`,
      )
    }
    lastConflict = new DurableConflictError(
      `durable store contention for ${opts.path} (attempt ${attempt + 1}/${OCC_MAX_ATTEMPTS})`,
    )
    await sleep(OCC_BACKOFF_MS * (attempt + 1))
  }
  throw (
    lastConflict ??
    new DurableConflictError(`durable store failed to converge for ${opts.path}`)
  )
}
