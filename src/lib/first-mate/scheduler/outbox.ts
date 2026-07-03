import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/**
 * A durable OUTBOX for external side effects (dispatch a cloud agent, merge a
 * PR, enable Pages, …).
 *
 * The peer review's "poison-pill" finding: if the controller performs a side
 * effect and then crashes before it records that fact, a naive retry re-runs
 * the side effect. GitHub then answers 409/422/405 ("already merged", "already
 * exists"), and a loop that treats those as failures livelocks forever.
 *
 * The outbox separates INTENT from EXECUTION and makes execution idempotent:
 *  1. record the intent (status `pending`) BEFORE doing anything external;
 *  2. execute; an executor maps a native "already applied" error to `already`;
 *  3. `already` and `done` both settle the entry — a re-run is a safe no-op.
 *
 * `key` is the idempotency key: a stable identifier for the intended effect
 * (e.g. `merge:owner/name#42@<sha>`). Recording the same key twice returns the
 * existing entry rather than duplicating.
 */
export type OutboxStatus = "pending" | "done" | "failed"

export interface OutboxEntry {
  key: string
  kind: string
  payload: unknown
  status: OutboxStatus
  attempts: number
  createdMs: number
  updatedMs: number
  lastError?: string
}

/** Result an executor returns for one entry. `already` == externally applied. */
export type ExecOutcome = "done" | "already" | "retry"

export interface OutboxOptions {
  dir?: string
  nowMs?: () => number
}

const OUTBOX_VERSION = 1

interface OutboxFile {
  version: 1
  entries: OutboxEntry[]
}

function outboxPath(dir: string): string {
  return path.join(dir, "scheduler.outbox.json")
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.key === "string" &&
    v.key.length > 0 &&
    typeof v.kind === "string" &&
    (v.status === "pending" || v.status === "done" || v.status === "failed") &&
    typeof v.attempts === "number" &&
    Number.isInteger(v.attempts) &&
    typeof v.createdMs === "number" &&
    typeof v.updatedMs === "number" &&
    (v.lastError === undefined || typeof v.lastError === "string")
  )
}

export class Outbox {
  private readonly file: string
  private readonly now: () => number
  private chain: Promise<void> = Promise.resolve()

  constructor(opts: OutboxOptions = {}) {
    this.file = outboxPath(opts.dir ?? PATHS.FIRST_MATE_DIR)
    this.now = opts.nowMs ?? Date.now
  }

  private async read(): Promise<OutboxEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>).version !== OUTBOX_VERSION
      ) {
        return []
      }
      const entries = (parsed as Record<string, unknown>).entries
      return Array.isArray(entries) ? entries.filter(isEntry) : []
    } catch {
      return []
    }
  }

  private async write(entries: OutboxEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
    const value: OutboxFile = { version: OUTBOX_VERSION, entries }
    try {
      await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(tmp, this.file)
    } catch (err) {
      await fs.unlink(tmp).catch(() => {})
      throw err
    }
  }

  /** Serialize mutations so concurrent calls in-process don't clobber. */
  private mutate<T>(work: (entries: OutboxEntry[]) => Promise<{ entries: OutboxEntry[]; result: T }>): Promise<T> {
    const run = this.chain.then(async () => {
      const current = await this.read()
      const { entries, result } = await work(current)
      await this.write(entries)
      return result
    })
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Record an intent. Idempotent by key: recording an existing key returns the
   * stored entry unchanged (so callers can safely record-before-execute on
   * every tick).
   */
  async record(input: { key: string; kind: string; payload?: unknown }): Promise<OutboxEntry> {
    return this.mutate(async (entries) => {
      const existing = entries.find((e) => e.key === input.key)
      if (existing) return { entries, result: existing }
      const now = this.now()
      const entry: OutboxEntry = {
        key: input.key,
        kind: input.kind,
        payload: input.payload ?? null,
        status: "pending",
        attempts: 0,
        createdMs: now,
        updatedMs: now,
      }
      return { entries: [...entries, entry], result: entry }
    })
  }

  async list(status?: OutboxStatus): Promise<OutboxEntry[]> {
    const entries = await this.read()
    return status ? entries.filter((e) => e.status === status) : entries
  }

  private async settle(key: string, status: OutboxStatus, error?: string): Promise<void> {
    await this.mutate(async (entries) => {
      const next = entries.map((e) =>
        e.key === key
          ? {
              ...e,
              status,
              attempts: e.attempts + (status === "failed" ? 1 : 0),
              updatedMs: this.now(),
              ...(error === undefined ? {} : { lastError: error }),
            }
          : e,
      )
      return { entries: next, result: undefined }
    })
  }

  markDone(key: string): Promise<void> {
    return this.settle(key, "done")
  }

  markFailed(key: string, error: string): Promise<void> {
    return this.settle(key, "failed", error)
  }

  /**
   * Drive due entries through `executor`. Drives BOTH `pending` entries and
   * previously-`failed` ones that are still under the retry budget and past
   * their backoff window (finding #4 — a transient blip must not permanently
   * drop a merge/pages-enable). `done`/`already` settle to `done` (idempotency);
   * `retry`/throw marks `failed` (attempts++) and re-arms it for a later pass;
   * once `attempts >= maxAttempts` the entry is left `failed` (a permanent
   * dead-letter) and no longer re-driven. Returns a small summary.
   */
  async reconcile(
    executor: (entry: OutboxEntry) => Promise<ExecOutcome>,
    opts: { maxAttempts?: number; baseBackoffMs?: number } = {},
  ): Promise<{ done: number; retried: number; deadLettered: number }> {
    const maxAttempts = opts.maxAttempts ?? 5
    const base = opts.baseBackoffMs ?? 1000
    const now = this.now()
    const all = await this.list()
    // Re-arm failed→retryable: pending always; failed if under budget AND due.
    const due = all.filter((e) => {
      if (e.status === "pending") return true
      if (e.status !== "failed") return false
      if (e.attempts >= maxAttempts) return false // permanent dead-letter
      const backoff = base * 2 ** (e.attempts - 1)
      return now - e.updatedMs >= backoff
    })
    let done = 0
    let retried = 0
    for (const entry of due) {
      let outcome: ExecOutcome
      try {
        outcome = await executor(entry)
      } catch (err) {
        await this.markFailed(entry.key, err instanceof Error ? err.message : String(err))
        retried += 1
        continue
      }
      if (outcome === "done" || outcome === "already") {
        await this.markDone(entry.key)
        done += 1
      } else {
        await this.markFailed(entry.key, "executor requested retry")
        retried += 1
      }
    }
    const deadLettered = (await this.list("failed")).filter((e) => e.attempts >= maxAttempts).length
    return { done, retried, deadLettered }
  }
}
