import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import type { HumanDecision, ModelAnswer } from "~/lib/first-mate/controller"
import { PATHS } from "~/lib/paths"

/**
 * Durable inbox that decouples ANSWER SUBMISSION from DRIVING (Phase A).
 *
 * When the daemon is the drive-lease holder, a deferring lead/heartbeat cannot
 * apply its own judgment answers (that would be driving). Instead it enqueues
 * them here — a plain durable write, always allowed — and the holder drains +
 * applies them on its next tick. Without this, "lead answers, daemon drives"
 * deadlocks: the answers never reach the driver and the loop stalls.
 *
 * `drain()` uses atomic rename (not read-then-truncate) so an enqueue that
 * races the drain lands in a fresh file and is picked up next drain rather than
 * being lost. It also runs on the SAME promise-chain as `enqueue()`, so a late
 * append can never interleave between the rename and a reader and hit an
 * unlinked inode.
 *
 * Durability (ack-after-apply): `drain()` claims the queued answers by renaming
 * the inbox to a `.draining.*` file but does NOT delete it. The caller applies
 * the answers and then calls the returned `ack()` to unlink the claimed file(s)
 * — a checkpoint. A crash between drain and apply leaves the `.draining.*` file
 * on disk, and the next drain replays it, so answers are never dropped.
 */
export interface QueuedAnswers {
  modelAnswers: ModelAnswer[]
  humanDecisions: HumanDecision[]
}

export interface DrainedAnswers extends QueuedAnswers {
  /**
   * Delete the claimed inbox file(s). Call ONLY after the drained answers have
   * been durably applied (or their failures re-enqueued). Until ack, a crash
   * leaves the claim on disk for the next drain to replay.
   */
  ack: () => Promise<void>
}

interface InboxLine {
  t: "m" | "h"
  requestId: string
  verdict?: unknown
  choice?: string
}

export interface AnswerInboxOptions {
  dir?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Windows sharing-violation codes. When two processes rename the SAME source
 * concurrently, POSIX gives the loser a clean `ENOENT` (source already gone),
 * but Windows can transiently surface `EPERM`/`EACCES`/`EBUSY` (the source is
 * momentarily locked by the peer's in-flight rename) before it resolves to
 * ENOENT. Treat these as retryable, not fatal.
 */
const WIN_RENAME_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * Atomically claim `from` by renaming it to the process-unique `to`.
 * Returns `true` if THIS caller won the claim, `false` if a peer already took it
 * (source gone). Retries transient Windows sharing violations so two concurrent
 * drainers converge to exactly one winner instead of one throwing. Non-transient
 * errors propagate.
 */
async function claimByRename(from: string, to: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return false // a peer claimed it first
      if (WIN_RENAME_TRANSIENT.has(code ?? "") && attempt < 25) {
        await sleep(4 + attempt) // peer's rename is finishing; back off briefly
        continue
      }
      throw err
    }
  }
}

export class AnswerInbox {
  private readonly file: string
  private chain: Promise<void> = Promise.resolve()
  /**
   * `.draining.*` files this instance has claimed but not yet acked. The
   * orphan-replay in `claim()` skips these so a second drain before ack does
   * not re-read our own still-in-flight claim.
   */
  private readonly inflight = new Set<string>()

  constructor(opts: AnswerInboxOptions = {}) {
    this.file = path.join(opts.dir ?? PATHS.FIRST_MATE_DIR, "answers.jsonl")
  }

  /** Append submitted answers. Returns how many records were enqueued. */
  async enqueue(a: {
    modelAnswers?: ModelAnswer[]
    humanDecisions?: HumanDecision[]
  }): Promise<number> {
    const lines: InboxLine[] = [
      ...(a.modelAnswers ?? []).map(
        (m): InboxLine => ({ t: "m", requestId: m.requestId, verdict: m.verdict }),
      ),
      ...(a.humanDecisions ?? []).map(
        (h): InboxLine => ({ t: "h", requestId: h.requestId, choice: h.choice }),
      ),
    ]
    if (lines.length === 0) return 0
    const run = this.chain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(
        this.file,
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        { mode: 0o600 },
      )
    })
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
    return lines.length
  }

  /** Atomically claim all queued answers and clear the inbox. */
  private mergeLines(raw: string, out: QueuedAnswers): void {
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue
      let parsed: InboxLine
      try {
        parsed = JSON.parse(line) as InboxLine
      } catch {
        continue
      }
      if (parsed.t === "m" && typeof parsed.requestId === "string") {
        out.modelAnswers.push({ requestId: parsed.requestId, verdict: parsed.verdict })
      } else if (
        parsed.t === "h" &&
        typeof parsed.requestId === "string" &&
        typeof parsed.choice === "string"
      ) {
        out.humanDecisions.push({ requestId: parsed.requestId, choice: parsed.choice })
      }
    }
  }

  async drain(): Promise<DrainedAnswers> {
    // Serialize on the SAME chain as enqueue() so a late append cannot land
    // between the rename and a reader (unlinked-inode race).
    const run = this.chain.then(() => this.claim())
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async claim(): Promise<DrainedAnswers> {
    const out: QueuedAnswers = { modelAnswers: [], humanDecisions: [] }
    const dir = path.dirname(this.file)
    const base = path.basename(this.file)
    const claimed: string[] = []
    // Crash-mid-drain recovery: a prior drain that renamed the inbox to a
    // `.draining.*` file but died before acking leaves the answers orphaned.
    // Replay any such orphans FIRST so answers are never lost. Skip files this
    // instance still holds in-flight (claimed, not yet acked) so a re-drain
    // before ack does not double-read its own claim. Orphans are returned but
    // NOT unlinked here — ack does that once the caller has applied them.
    let siblings: string[] = []
    try {
      siblings = await fs.readdir(dir)
    } catch {
      siblings = []
    }
    for (const name of siblings) {
      if (!name.startsWith(`${base}.draining.`)) continue
      const orphan = path.join(dir, name)
      if (this.inflight.has(orphan)) continue
      // R3 #3: CLAIM the orphan ATOMICALLY before reading. The old code read the
      // orphan in place, so two concurrent drainers (separate processes → separate
      // process-local `inflight` sets) both read and applied the SAME orphan →
      // double-apply. A single-source rename to a process-unique name means only
      // ONE drainer can claim a given orphan; the rest get ENOENT and skip. The
      // claim keeps the `.draining.` prefix so a crash before ack still leaves it
      // discoverable for a later replay. claimByRename retries transient Windows
      // sharing violations so the loser converges to ENOENT (skip) rather than
      // throwing and failing the whole drain.
      const claim = `${orphan}.claim.${process.pid}.${randomBytes(4).toString("hex")}`
      if (!(await claimByRename(orphan, claim))) continue // a peer claimed it
      try {
        this.mergeLines(await fs.readFile(claim, "utf8"), out)
        claimed.push(claim)
      } catch (err) {
        // R3 #4: NEVER delete an unread answer on a transient read error
        // (EMFILE/ENOMEM/EACCES) — the old blind `catch { unlink }` permanently
        // dropped human decisions. Leave the claimed file on disk (it keeps the
        // `.draining.` prefix) so a later drain retries it; losing nothing beats
        // losing a decision. ENOENT just means it was already consumed.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          consola.warn(`first-mate: deferring unreadable answer claim ${claim} for retry:`, err)
        }
      }
    }
    // Claim the current inbox atomically (same Windows-transient resilience).
    const target = `${this.file}.draining.${process.pid}.${randomBytes(4).toString("hex")}`
    if (await claimByRename(this.file, target)) {
      try {
        this.mergeLines(await fs.readFile(target, "utf8"), out)
        claimed.push(target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          consola.warn(`first-mate: deferring unreadable inbox claim ${target} for retry:`, err)
        }
      }
    }
    for (const p of claimed) this.inflight.add(p)
    const ack = async (): Promise<void> => {
      for (const p of claimed) {
        await fs.unlink(p).catch(() => {})
        this.inflight.delete(p)
      }
    }
    return { ...out, ack }
  }
}
