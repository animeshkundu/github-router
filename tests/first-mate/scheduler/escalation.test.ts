import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { EscalationQueue, type EscalationItem } from "~/lib/first-mate/scheduler/escalation"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-escal-"))
})

describe("Phase C — EscalationQueue (push-not-poll)", () => {
  test("enqueue durably records and fires the push hook", async () => {
    const pushed: EscalationItem[] = []
    const q = new EscalationQueue({ dir, nowMs: () => 5000, push: (i) => void pushed.push(i) })
    const item = await q.enqueue({
      requestId: "r1",
      kind: "judge_review",
      target: "lead",
      reason: "high stakes",
    })
    expect(item.atMs).toBe(5000)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.requestId).toBe("r1")
    const listed = await q.list()
    expect(listed.map((i) => i.requestId)).toEqual(["r1"])
    expect(listed[0]?.target).toBe("lead")
  })

  test("a throwing push hook never breaks enqueue (still durably recorded)", async () => {
    const q = new EscalationQueue({
      dir,
      push: () => {
        throw new Error("no wake channel")
      },
    })
    await q.enqueue({ requestId: "r2", kind: "author_fix", target: "human", reason: "irreversible" })
    expect((await q.list()).map((i) => i.requestId)).toEqual(["r2"])
  })

  test("list is empty when nothing has escalated", async () => {
    const q = new EscalationQueue({ dir })
    expect(await q.list()).toEqual([])
  })
})
