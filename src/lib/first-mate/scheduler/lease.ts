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
    // Confirm we won: atomic rename is last-writer-wins, so re-read and verify
    // our owner+token survived a possible concurrent acquirer.
    const confirmed = await readLeaseFile(this.file)
    if (
      !confirmed ||
      confirmed.owner !== this.owner ||
      confirmed.fencingToken !== next.fencingToken
    ) {
      this.held = undefined
      return undefined
    }
    this.held = confirmed
    return confirmed
  }

  /**
   * Extend an already-held lease WITHOUT bumping the fencing token (a renewal
   * is the same reign). Returns undefined if the lease was lost/stolen.
   */
  async renew(): Promise<Lease | undefined> {
    const current = await readLeaseFile(this.file)
    const now = this.now()
    if (!current || current.owner !== this.owner) {
      this.held = undefined
      return undefined
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
  }

  /** Voluntarily give up the lease (expire it now) while keeping the token monotonic. */
  async release(): Promise<void> {
    const current = await readLeaseFile(this.file)
    if (current && current.owner === this.owner) {
      await writeLeaseAtomic(this.file, { ...current, expiresMs: this.now() })
    }
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
