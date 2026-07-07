import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/**
 * A single-driver lease with a monotonic FENCING TOKEN.
 *
 * Phase 1 of the deterministic-supervisor upgrade. The peer review flagged that
 * a bare time-based lock guarantees split-brain under stalls/sleep/GC: two
 * drivers can each believe the other is dead and both write the ledger. The
 * defence is a fencing token — a number that strictly increases every time the
 * lease is (re)acquired or stolen. A late writer that wakes up holding an old
 * token can be REJECTED at commit ({@link isCurrentFencingToken}) even though it
 * still thinks it owns the lease. The lease itself is only an optimization to
 * avoid contention; the fencing token is the actual safety boundary.
 */
export interface Lease {
  owner: string
  fencingToken: number
  acquiredMs: number
  expiresMs: number
}

export interface LeaseOptions {
  /** Directory the lease file lives in. Defaults to the first-mate dir. */
  dir?: string
  /** Lease time-to-live in ms. */
  ttlMs?: number
  /** Injectable clock for tests. */
  nowMs?: () => number
}

const DEFAULT_TTL_MS = 30_000

function leasePath(dir: string): string {
  return path.join(dir, "scheduler.lease.json")
}

function isLease(value: unknown): value is Lease {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.owner === "string" &&
    v.owner.length > 0 &&
    typeof v.fencingToken === "number" &&
    Number.isInteger(v.fencingToken) &&
    typeof v.acquiredMs === "number" &&
    Number.isFinite(v.acquiredMs) &&
    typeof v.expiresMs === "number" &&
    Number.isFinite(v.expiresMs)
  )
}

async function readLeaseFile(file: string): Promise<Lease | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLease(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function writeLeaseAtomic(file: string, lease: Lease): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

export const LEASE_LOCK_TTL_MS = 10_000
const LEASE_LOCK_MAX_WAIT_MS = 10_000

/**
 * Serialize read-modify-write of the lease file across processes with an atomic
 * create-if-absent lock. Without this, tryAcquire() and renew() interleave:
 * B.tryAcquire can write token N+1 while A.renew (having read the pre-steal
 * state) then writes token N on top, silently REGRESSING the fencing token and
 * leaving BOTH drivers believing they hold the lease. Under the lock the
 * read+write is atomic, so tokens are monotonic and exactly one driver wins.
 * Uses REAL time (not the injectable lease clock) for lock liveness.
 *
 * ATOMICITY (R3 #1). Acquisition is a single atomic assert: we stage our owner
 * token in a private file and `fs.link()` it onto the lock path. link() is
 * create-if-absent, so EXACTLY ONE contender can create the lock — there is no
 * unlink-then-recreate window. The previous "stat-stale then unlink then
 * open(wx)" broke this: a waiter that had already observed a stale lock would,
 * on resuming, blindly `unlink(lockPath)` — deleting whatever sat there NOW,
 * including a FRESH lock a peer had re-taken in the meantime — letting both into
 * the critical section to read the same lease and mint the same fencing token
 * (double dispatch). We now NEVER unlink-to-steal. A stale lock is retired by
 * moving it aside with a single-source `fs.rename()` and then CONFIRMING the
 * moved inode still carries the exact stale token we observed; if a fresh holder
 * had re-taken the path between our observe and our rename, we PUT IT BACK
 * (restore) and wait our turn rather than stealing it. link() stays the only
 * winner-picker.
 *
 * HONEST LIMITATION: POSIX offers no compare-and-swap on a path, so a stale-lock
 * steal cannot be made fully race-free — a third contender that re-links during
 * our restore window is not covered here. The fencing token (checked at commit)
 * and the ledger's rev-based CAS are the true safety boundary; this lock is a
 * best-effort contention optimizer that no longer actively deletes live locks.
 *
 * Exported for the regression tests that exercise the stolen-lock finally.
 * `hooks` is a test-only injection point (default undefined = no-op) used to
 * force the observe→break interleaving deterministically.
 */
export interface LeaseLockTestHooks {
  /** Awaited AFTER a stale lock is observed but BEFORE it is broken. */
  onObservedStale?: () => Promise<void>
}

export async function withLeaseLock<T>(
  file: string,
  fn: () => Promise<T>,
  hooks?: LeaseLockTestHooks,
): Promise<T> {
  const lockPath = `${file}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  // Unique per-acquisition owner token. The lock TTL (10s) < lease TTL (30s), so
  // a stalled driver holding the lock can be broken-as-stale and its lock
  // re-taken by another driver. When the stalled driver resumes it still
  // believes it holds the lock — the owner-token re-check in `finally` is what
  // stops it deleting a DIFFERENT active driver's lock. Mirrors withRepoLock.
  const ownerToken = `${process.pid}-${randomBytes(8).toString("hex")}`
  // Staging file holding our token; the lock is a HARDLINK to it. Acquiring via
  // link(staging → lockPath) is atomic create-if-absent, the sole winner-picker.
  const staging = `${lockPath}.acq.${ownerToken}`
  await fs.writeFile(staging, ownerToken, { mode: 0o600 })
  const start = Date.now()
  try {
    for (;;) {
      try {
        await fs.link(staging, lockPath)
        break // won — lockPath is now our token
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        // A lock exists. Retire it ONLY if stale, and never by unlink-to-steal.
        let observed: string | undefined
        try {
          observed = (await fs.readFile(lockPath, "utf8")).trim()
          const st = await fs.stat(lockPath)
          if (Date.now() - st.mtimeMs > LEASE_LOCK_TTL_MS) {
            if (hooks?.onObservedStale) await hooks.onObservedStale()
            // Move the stale lock aside with a single-source rename (at most one
            // waiter moves a given inode; the rest get ENOENT and re-contend).
            const breaker = `${lockPath}.stale.${ownerToken}`
            let moved = false
            try {
              await fs.rename(lockPath, breaker)
              moved = true
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
              // a peer already retired/re-took it — re-contend on link()
            }
            if (moved) {
              // Confirm we moved the SAME stale lock. If a fresh holder re-took
              // the path between our observe and our rename, the moved token
              // differs → restore it and wait rather than stealing a live lock.
              let movedToken: string | undefined
              try {
                movedToken = (await fs.readFile(breaker, "utf8")).trim()
              } catch {
                movedToken = undefined
              }
              if (movedToken === observed) {
                await fs.unlink(breaker).catch(() => {}) // genuinely stale — retire
              } else {
                // Turned fresh under us — put it back for its rightful holder.
                await fs.rename(breaker, lockPath).catch(async () => {
                  await fs.unlink(breaker).catch(() => {}) // a peer re-linked first
                })
              }
            }
            continue // re-contend immediately
          }
        } catch {
          // vanished/unreadable between ops — re-contend immediately
        }
        if (Date.now() - start > LEASE_LOCK_MAX_WAIT_MS) {
          throw new Error(`first-mate lease lock timeout for ${file}`)
        }
        await new Promise((r) => setTimeout(r, 15))
      }
    }
  } finally {
    // The lock now stands on its own hardlink; drop the staging name. On a
    // timeout throw we also land here and clean up the unused staging file.
    await fs.unlink(staging).catch(() => {})
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
    return await fn()
  } finally {
    // Only remove the lock if it is still ours — never delete a thief's lock.
    if (await verifyOwner()) await fs.unlink(lockPath).catch(() => {})
  }
}

/**
 * Read the fencing token currently recorded on disk, or 0 if there is no lease.
 * Used by commit-time guards to reject a stale writer.
 */
export async function currentFencingToken(dir = PATHS.FIRST_MATE_DIR): Promise<number> {
  const lease = await readLeaseFile(leasePath(dir))
  return lease?.fencingToken ?? 0
}

/**
 * True iff `token` is still the newest fencing token on disk — i.e. no other
 * driver has stolen the lease since it was issued. A driver MUST call this
 * immediately before any external side effect / ledger write; if it returns
 * false, the driver has been fenced out and must abort without writing.
 *
 * TOKEN-UNIQUENESS RESIDUAL (FOLLOWUP). This compares the token NUMBER only; it
 * is EXPIRY-BLIND (an expired-but-unstolen lease keeps the same token — the
 * answer/dispatch hot path additionally requires a SUCCESSFUL `renew()` as a
 * live-lease proof, see controller `dispatchWithOutbox`). A fully race-free
 * cross-process lease is NOT achievable with POSIX file locks (no path-level
 * compare-and-swap — see {@link withLeaseLock}'s HONEST LIMITATION), so a
 * narrow break-a-fresh-lock window can let two drivers briefly both believe
 * they hold the lease. The safety BACKSTOPS that make this survivable are:
 *   - deterministic dispatch idempotency key → no double-DISPATCH,
 *   - single-use approval consume → no double-MERGE,
 *   - ledger rev-CAS → no lost update.
 * The RESIDUAL is duplicate best-effort side effects (reviews / comments /
 * check-reruns) in that window, which are individually harmless. A robust
 * future fix is atomic token minting or a per-(unit,attempt) atomic
 * single-dispatch claim (an O_CREAT|O_EXCL `wx` create) — out of scope here.
 */
export async function isCurrentFencingToken(
  token: number,
  dir = PATHS.FIRST_MATE_DIR,
): Promise<boolean> {
  return (await currentFencingToken(dir)) === token
}

export class SchedulerLease {
  readonly owner: string
  private readonly file: string
  private readonly ttlMs: number
  private readonly now: () => number
  private held: Lease | undefined

  constructor(opts: LeaseOptions = {}) {
    this.file = leasePath(opts.dir ?? PATHS.FIRST_MATE_DIR)
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.nowMs ?? Date.now
    this.owner = `${process.pid}-${randomBytes(6).toString("hex")}`
  }

  /**
   * Acquire the lease if it is free or expired. Bumps the fencing token.
   * Returns the held lease, or undefined if a *live* lease owned by someone
   * else is present (we do not steal a lease that has not expired).
   */
  async tryAcquire(): Promise<Lease | undefined> {
    return withLeaseLock(this.file, async () => {
      const current = await readLeaseFile(this.file)
      const now = this.now()
      if (current && current.owner !== this.owner && current.expiresMs > now) {
        return undefined
      }
      const next: Lease = {
        owner: this.owner,
        fencingToken: (current?.fencingToken ?? 0) + 1,
        acquiredMs: now,
        expiresMs: now + this.ttlMs,
      }
      await writeLeaseAtomic(this.file, next)
      this.held = next
      return next
    })
  }

  /**
   * Extend an already-held lease WITHOUT bumping the fencing token. Runs under
   * the lease lock so it cannot interleave with a concurrent acquire: if the
   * lease was stolen (owner changed), renew FAILS (caller stops driving) rather
   * than clobbering the stealer's higher token — the token is monotonic.
   */
  async renew(): Promise<Lease | undefined> {
    return withLeaseLock(this.file, async () => {
      const current = await readLeaseFile(this.file)
      const now = this.now()
      if (!current || current.owner !== this.owner) {
        this.held = undefined
        return undefined // lost/stolen — never regress the token
      }
      const next: Lease = {
        owner: this.owner,
        fencingToken: current.fencingToken,
        acquiredMs: now,
        expiresMs: now + this.ttlMs,
      }
      await writeLeaseAtomic(this.file, next)
      this.held = next
      return next
    })
  }

  /** Voluntarily give up the lease (expire it now) while keeping the token monotonic. */
  async release(): Promise<void> {
    await withLeaseLock(this.file, async () => {
      const current = await readLeaseFile(this.file)
      if (current && current.owner === this.owner) {
        await writeLeaseAtomic(this.file, { ...current, expiresMs: this.now() })
      }
    })
    this.held = undefined
  }

  /** The fencing token of the currently-held lease, or undefined if not held. */
  get fencingToken(): number | undefined {
    return this.held?.fencingToken
  }
}

/**
 * A drive gate for advance(): renew (or acquire) the lease and report whether
 * we now hold it. Passed as `advance({ driveGate })` so a non-holder
 * observes-and-defers instead of double-driving.
 */
export function makeDriveGate(lease: SchedulerLease): () => Promise<boolean> {
  return async () => {
    const held = (await lease.renew()) ?? (await lease.tryAcquire())
    return held !== undefined
  }
}
