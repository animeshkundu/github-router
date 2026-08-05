/**
 * Request-prologue microbenchmark.
 *
 * `/v1/messages` runs a chain of full-body substring scans, JSON parses and
 * re-serializations before a single upstream byte is sent. All of it is
 * synchronous work on Bun's one event-loop thread, so it does not merely add
 * latency to the request that pays it — it head-of-line blocks every concurrent
 * MCP call, worker chunk and subagent request for its whole duration.
 *
 * This exists because a first measurement pass got three numbers wrong by
 * benchmarking an UNREALISTIC body (one enormous string). Anthropic bodies are
 * many small content blocks, and the shape dominates: `JSON.parse` is ~3.7x
 * more expensive on the realistic shape, while a regex over it is ~5x cheaper.
 * Optimizing against the wrong shape inverted a keep/remove decision.
 *
 * Run:  bun scripts/bench-request-prologue.ts
 * Env:  BENCH_TRIALS (default 20), BENCH_WARMUP (default 5)
 *
 * Reports medians. Every number is per-operation on one request body.
 */

import { performance } from "node:perf_hooks"

const TRIALS = Number(process.env.BENCH_TRIALS ?? 20)
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5)

function median(xs: Array<number>): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function p95(xs: Array<number>): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}

/** Time `fn` with warmup, returning median and p95 milliseconds. */
function bench(fn: () => void): { med: number; p95: number } {
  for (let i = 0; i < WARMUP; i++) fn()
  const samples: Array<number> = []
  for (let i = 0; i < TRIALS; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return { med: median(samples), p95: p95(samples) }
}

/**
 * A realistically-shaped Anthropic request body: many small text blocks with
 * cache_control markers, which is what Claude Code actually sends. NOT one
 * giant string — that shape makes scans look cheap and parses look free.
 */
function makeBody(targetBytes: number): string {
  const blocks: Array<Record<string, unknown>> = []
  let n = 0
  while (n < targetBytes) {
    const block = {
      type: "text",
      text: "word ".repeat(40),
      cache_control: { type: "ephemeral" },
    }
    blocks.push(block)
    n += JSON.stringify(block).length
  }
  return JSON.stringify({
    model: "claude-opus-5[1m]",
    max_tokens: 4096,
    messages: [{ role: "user", content: blocks }],
  })
}

const SIZES: Array<{ label: string; bytes: number }> = [
  { label: "40 KiB", bytes: 40 * 1024 },
  { label: "136 KiB", bytes: 136 * 1024 },
  { label: "520 KiB", bytes: 520 * 1024 },
  { label: "2.1 MiB", bytes: Math.round(2.1 * 1024 * 1024) },
  { label: "4.5 MiB", bytes: Math.round(4.5 * 1024 * 1024) },
]

const ADVISOR_RE = /"type":"advisor_\d+"/

console.log(
  `\nRequest-prologue cost by body size (median of ${TRIALS} trials, ${WARMUP} warmup)\n`,
)
console.log(
  "size      | scan MISS | scan HIT | JSON.parse | stringify | advisor RE | prologue total",
)
console.log(
  "----------|-----------|----------|------------|-----------|------------|---------------",
)

for (const { label, bytes } of SIZES) {
  const body = makeBody(bytes)

  // A guard whose token is ABSENT must scan the whole body.
  const scanMiss = bench(() => void body.includes('"scope"'))
  // A guard whose token is PRESENT early-exits — this asymmetry is why guard
  // value depends on hit rate, not just on body size.
  const scanHit = bench(() => void body.includes("cache_control"))
  const parse = bench(() => void JSON.parse(body))
  const parsed = JSON.parse(body) as unknown
  const stringify = bench(() => void JSON.stringify(parsed))
  const advisorRe = bench(() => void ADVISOR_RE.test(body))

  // Canonical path: 10 scans (worst case, all misses) + 3 parses + 2 stringifies.
  const total = scanMiss.med * 10 + parse.med * 3 + stringify.med * 2

  const f = (n: number) => n.toFixed(2).padStart(9)
  console.log(
    `${label.padEnd(9)} | ${f(scanMiss.med)} | ${f(scanHit.med).slice(2)} | ${f(parse.med).slice(1)} | ${f(stringify.med)} | ${f(advisorRe.med).slice(1)} | ${total.toFixed(2).padStart(10)} ms`,
  )
}

console.log(`
Read this before changing anything on the request path:

  * scan HIT vs MISS is the asymmetry that matters. A guard whose token is
    present costs ~nothing; only a MISS pays the full scan. So a guard's worth
    is a function of its HIT RATE in real traffic, which this bench cannot see.
  * "advisor RE" is cheaper than one JSON.parse on every realistic size, so
    the fast-path regex it powers is NET-POSITIVE and must stay.
  * "prologue total" assumes all ten guards miss. Real cost is lower and
    depends on traffic shape.
  * None of this justifies a refactor on its own without the live p50/p95 body
    size. A 40 KiB p50 makes the whole prologue sub-millisecond.
`)
