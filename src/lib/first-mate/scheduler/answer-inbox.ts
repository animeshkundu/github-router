import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

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
 * being lost.
 */
export interface QueuedAnswers {
  modelAnswers: ModelAnswer[]
  humanDecisions: HumanDecision[]
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

export class AnswerInbox {
  private readonly file: string
  private chain: Promise<void> = Promise.resolve()

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

  async drain(): Promise<QueuedAnswers> {
    const out: QueuedAnswers = { modelAnswers: [], humanDecisions: [] }
    const dir = path.dirname(this.file)
    const base = path.basename(this.file)
    // Crash-mid-drain recovery: a prior drain that renamed the inbox to a
    // `.draining.*` file but died before consuming it leaves the answers
    // orphaned. Replay any such orphans FIRST so answers are never lost.
    // (The lease holder is the single drainer, so a live concurrent drain
    // stealing another's in-flight file is not a real scenario here.)
    let siblings: string[] = []
    try {
      siblings = await fs.readdir(dir)
    } catch {
      siblings = []
    }
    for (const name of siblings) {
      if (!name.startsWith(`${base}.draining.`)) continue
      const orphan = path.join(dir, name)
      try {
        this.mergeLines(await fs.readFile(orphan, "utf8"), out)
      } catch {
        // unreadable — drop
      } finally {
        await fs.unlink(orphan).catch(() => {})
      }
    }
    // Claim the current inbox atomically.
    const claimed = `${this.file}.draining.${process.pid}.${randomBytes(4).toString("hex")}`
    try {
      await fs.rename(this.file, claimed)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out
      throw err
    }
    try {
      this.mergeLines(await fs.readFile(claimed, "utf8"), out)
    } finally {
      await fs.unlink(claimed).catch(() => {})
    }
    return out
  }
}
