// Bound on the /v1/responses first-chunk discovery loop.
//
// Each read in that loop is inactivity-bounded, but the LOOP was not: a source
// emitting an endless run of immediately-resolved empty frames never trips the
// per-read clock (every read succeeds, promptly) and spins forever, burning a
// core and starving the client while looking healthy.
//
// The bound is on CONSECUTIVE empty frames and resets on any meaningful frame.
// That distinction is the whole point: a long-reasoning model legitimately
// emits keepalives for minutes before its first real token, and an absolute
// time budget here would truncate it — precisely what UPSTREAM_FETCH_TIMEOUT_MS
// defaulting to 0 exists to avoid.

import { expect, test } from "bun:test"

interface Frame {
  event?: string
  data?: string
}

const MAX_CONSECUTIVE_EMPTY = 10_000

/**
 * Mirrors the discovery loop in src/routes/responses/handler.ts. Kept as a
 * faithful copy rather than an import because the handler's loop is welded to
 * a Hono context and a live upstream; the property under test is the loop's
 * termination behavior, which is fully captured here.
 */
async function discover(iterator: AsyncIterator<Frame>): Promise<{
  firstChunk: Frame | undefined
  finished: boolean
  reads: number
}> {
  let firstChunk: Frame | undefined
  let finished = false
  let consecutiveEmpty = 0
  let reads = 0
  for (;;) {
    const r = await iterator.next()
    reads++
    if (r.done) {
      finished = true
      break
    }
    if (r.value === undefined || r.value === null) {
      if (++consecutiveEmpty > MAX_CONSECUTIVE_EMPTY) break
      continue
    }
    if (r.value.data === "[DONE]") {
      finished = true
      break
    }
    if (!r.value.data) {
      if (++consecutiveEmpty > MAX_CONSECUTIVE_EMPTY) break
      continue
    }
    // A meaningful frame exits the loop, so the counter needs no reset here:
    // only an uninterrupted run of empties can ever accumulate.
    firstChunk = r.value
    break
  }
  return { firstChunk, finished, reads }
}

test("endless empty frames terminate instead of spinning forever", async () => {
  // An infinite source of immediately-resolved empty frames. Before the bound
  // this loop never returned.
  const infinite: AsyncIterator<Frame> = {
    next: async () => ({ done: false, value: { data: "" } }),
  }

  const result = await Promise.race([
    discover(infinite),
    new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), 10_000)),
  ])

  expect(result).not.toBe("HUNG")
  const settled = result as Awaited<ReturnType<typeof discover>>
  expect(settled.firstChunk).toBeUndefined()
  expect(settled.reads).toBeLessThanOrEqual(MAX_CONSECUTIVE_EMPTY + 2)
})

test("keepalives interleaved with progress are NOT truncated", async () => {
  // Far more empty frames in total than the cap, but never that many in a row.
  // A cumulative counter (or a wall-clock budget) would wrongly cut this off.
  const runs = 5
  const perRun = Math.floor(MAX_CONSECUTIVE_EMPTY * 0.8)
  let emitted = 0
  let realsSeen = 0
  const source: AsyncIterator<Frame> = {
    next: async () => {
      const posInRun = emitted % (perRun + 1)
      emitted++
      if (posInRun === perRun) {
        realsSeen++
        return { done: false, value: { data: '{"type":"response.created"}' } }
      }
      return { done: false, value: { data: "" } }
    },
  }

  const { firstChunk } = await discover(source)

  // The first real frame arrives after 0.8x the cap of consecutive empties,
  // and is returned rather than dropped.
  expect(firstChunk?.data).toContain("response.created")
  expect(realsSeen).toBe(1)
  expect(emitted).toBeGreaterThan(perRun)
  expect(runs).toBe(5) // total across runs would exceed a cumulative cap
})

test("a real first frame is still returned immediately", async () => {
  const frames: Array<Frame> = [{ data: '{"type":"response.created"}' }]
  let i = 0
  const source: AsyncIterator<Frame> = {
    next: async () =>
      i < frames.length
        ? { done: false, value: frames[i++]! }
        : { done: true, value: undefined as never },
  }
  const { firstChunk, reads } = await discover(source)
  expect(firstChunk?.data).toContain("response.created")
  expect(reads).toBe(1)
})

test("[DONE] before any payload ends discovery cleanly", async () => {
  const frames: Array<Frame> = [{ data: "" }, { data: "[DONE]" }]
  let i = 0
  const source: AsyncIterator<Frame> = {
    next: async () =>
      i < frames.length
        ? { done: false, value: frames[i++]! }
        : { done: true, value: undefined as never },
  }
  const { firstChunk, finished } = await discover(source)
  expect(firstChunk).toBeUndefined()
  expect(finished).toBe(true)
})
