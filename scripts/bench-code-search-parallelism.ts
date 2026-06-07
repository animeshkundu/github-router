/**
 * Benchmark: quantify the tree-sitter parse serialization in `code_search`
 * under concurrency, to decide whether Lever 2 (a worker_threads parse pool)
 * is worth building.
 *
 * Design ref: docs/research/tree-sitter-parallelism.md (Lever 2). The pool's
 * only real payoff is the concurrent-`code` case — multiple `code` calls under
 * the MCP cap-of-8 serialize on the single synchronous WASM heap.
 *
 * Measurements (medians of N trials to beat machine noise):
 *
 *   A.  Per-file raw parse cost (the serialization quantum).
 *   B.  Event-loop blocking: how long a synchronous parse loop freezes the
 *       loop (a 0ms timer can't fire until the loop yields).
 *   B2. What ONE real ranked call ACTUALLY parses — the structural pass groups
 *       hits BY FILE, so the top-50 *hits* may map to far fewer *files*.
 *       Instrumented via __readBenchStructuralStats (GH_ROUTER_BENCH_STRUCTURAL=1).
 *   C.  End-to-end scaling, RANKED (parses) vs LITERAL (no tree-sitter) control:
 *       if literal scales flat while ranked scales ~linearly, the structural
 *       parse pass IS the serializer (not rg/IO).
 *   E.  LLM-stream chunk jitter under 8 concurrent searches — the proxy
 *       tail-harm signal (the proxy serves SSE on the same event loop).
 *
 * Two fixture modes:
 *   - CLUSTERED (default): one recurring query symbol → hits cluster into a few
 *     files → the structural pass parses few files (common case).
 *   - SPREAD (BENCH_SPREAD=1): a unique symbol per file used once → ~1 hit/file
 *     → the top-50 hits map to ~50 distinct files → worst-case parse load.
 *
 * Run:  bun scripts/bench-code-search-parallelism.ts
 * Env:  BENCH_FILES=80 BENCH_LINES=160 BENCH_TRIALS=5 BENCH_SPREAD=1
 *       GH_ROUTER_BENCH_STRUCTURAL=1   (enables the [B2] structural counters)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"

import {
  searchCode,
  __readBenchStructuralStats,
  __resetBenchStructuralStats,
} from "~/lib/code-search"
import { getGrammarBundle } from "~/lib/tree-sitter-grammars"

const N_FILES = Number(process.env.BENCH_FILES ?? 80)
const N_LINES = Number(process.env.BENCH_LINES ?? 160)
const TRIALS = Number(process.env.BENCH_TRIALS ?? 5)
const STRUCTURAL_TOPN_FULL = 50 // mirror code-search.ts
const QUERY = "processPayload"
/**
 * SPREAD mode: when set, each file gets a UNIQUE symbol name and the query is
 * a common PREFIX, so ripgrep returns ~1 hit per file across MANY files — the
 * top-50 hits then map to ~50 DISTINCT files, the worst case for the
 * structural pass's by-file parse count (vs the clustered default where one
 * recurring symbol collapses to a few files). This bounds the realistic parse
 * load from above.
 */
const SPREAD = process.env.BENCH_SPREAD === "1"
const SPREAD_PREFIX = "handlerFor"
/** The query rg actually runs: the recurring symbol (clustered) or the shared
 *  prefix that substring-matches every file's unique symbol (spread). */
const EFFECTIVE_QUERY = SPREAD ? SPREAD_PREFIX : QUERY

function median(xs: Array<number>): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------------------------------------------------------------------------
// Corpus generation — realistic medium TS files.
// ---------------------------------------------------------------------------

function genFile(idx: number): string {
  const lines: Array<string> = []
  lines.push(`// module ${idx} — synthetic benchmark fixture`)
  lines.push(`import { helper } from "./helper${idx % 5}"`)
  lines.push(``)
  // The query symbol. In SPREAD mode each file gets a UNIQUE name sharing the
  // query prefix and used EXACTLY ONCE (→ ~1 hit/file across many files, so the
  // top-50 hits map to ~50 distinct files). In clustered mode the SAME symbol
  // recurs many times (→ hits cluster into a few files).
  const sym = SPREAD ? `${SPREAD_PREFIX}${idx}` : QUERY
  lines.push(`export function ${sym}(input: Record<string, unknown>): string {`)
  lines.push(`  const out = helper(input)`)
  lines.push(`  return JSON.stringify(out)`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`export class Processor${idx} {`)
  lines.push(`  private readonly cache = new Map<string, number>()`)
  for (let m = 0; m < 6; m++) {
    lines.push(`  method${m}(arg${m}: string): number {`)
    // Clustered: reuse the recurring query symbol (more hits/file). Spread:
    // use a NON-matching local so the query symbol appears once per file.
    lines.push(`    const v = ${SPREAD ? "helper" : QUERY}({ key: arg${m} })`)
    lines.push(`    this.cache.set(arg${m}, v.length)`)
    lines.push(`    return v.length`)
    lines.push(`  }`)
  }
  lines.push(`}`)
  lines.push(``)
  let fnIdx = 0
  while (lines.length < N_LINES) {
    lines.push(`export function filler${idx}_${fnIdx}(x: number): number {`)
    lines.push(`  const r = ${SPREAD ? "helper" : QUERY}({ n: x })`)
    lines.push(`  return r.length + x * ${fnIdx}`)
    lines.push(`}`)
    fnIdx++
  }
  return lines.join("\n") + "\n"
}

function makeWorkspace(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-bench-cs-")))
  mkdirSync(path.join(root, "src"))
  for (let i = 0; i < N_FILES; i++) {
    writeFileSync(path.join(root, "src", `mod${i}.ts`), genFile(i))
  }
  return root
}

// ---------------------------------------------------------------------------
// A — per-file raw parse cost.
// ---------------------------------------------------------------------------

async function measureRawParse(sources: Array<string>): Promise<number> {
  const { default: Parser } = await import("web-tree-sitter")
  const grammars = await getGrammarBundle().ready
  const ts = grammars.get("typescript")
  if (!ts) throw new Error("typescript grammar failed to load")
  const parser = new Parser()
  parser.setLanguage(ts)
  for (const s of sources.slice(0, 5)) parser.parse(s)?.delete() // warm JIT
  const perTrial: Array<number> = []
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now()
    for (const s of sources) parser.parse(s)?.delete()
    perTrial.push((performance.now() - t0) / sources.length)
  }
  parser.delete()
  return median(perTrial)
}

// ---------------------------------------------------------------------------
// B — event-loop blocking caused by synchronous parsing.
// ---------------------------------------------------------------------------

async function measureEventLoopBlock(sources: Array<string>): Promise<{
  starvationMs: number
  parseMs: number
  parsedFiles: number
}> {
  const { default: Parser } = await import("web-tree-sitter")
  const grammars = await getGrammarBundle().ready
  const ts = grammars.get("typescript")!
  const parser = new Parser()
  parser.setLanguage(ts)
  const slice = sources.slice(0, Math.min(STRUCTURAL_TOPN_FULL, sources.length))

  // Arm a 0ms timer that SHOULD fire ~immediately, then immediately enter the
  // synchronous parse loop. Because `parser.parse` is synchronous CPU on the
  // JS thread, the loop never yields, so the timer callback cannot run until
  // the whole loop completes. The delay the timer actually observes is the
  // starvation a concurrent call's pending callback would suffer.
  const armed = performance.now()
  let firedAt = 0
  const timerDone = new Promise<void>((resolve) => {
    setTimeout(() => {
      firedAt = performance.now()
      resolve()
    }, 0)
  })

  const t0 = performance.now()
  for (const s of slice) parser.parse(s)?.delete() // synchronous, blocks loop
  const parseMs = performance.now() - t0

  await timerDone
  parser.delete()
  // How long the 0ms timer was actually delayed = event-loop starvation.
  return { starvationMs: firedAt - armed, parseMs, parsedFiles: slice.length }
}

// ---------------------------------------------------------------------------
// C — end-to-end concurrency scaling.
// ---------------------------------------------------------------------------

async function measureConcurrencyOnce(
  workspaces: Array<string>,
  mode: "ranked" | "literal",
): Promise<number> {
  const calls = workspaces.map((ws) =>
    searchCode({
      query: EFFECTIVE_QUERY,
      workspace: ws,
      mode,
      structural: "full",
      summary: false,
      limit: 200,
    }),
  )
  const t0 = performance.now()
  await Promise.all(calls)
  return performance.now() - t0
}

async function measureConcurrency(
  c: number,
  mode: "ranked" | "literal",
): Promise<number> {
  const walls: Array<number> = []
  for (let t = 0; t < TRIALS; t++) {
    // Fresh, distinct workspaces every trial → cold _treeCache, no reuse.
    const ws: Array<string> = []
    for (let i = 0; i < c; i++) ws.push(makeWorkspace())
    try {
      walls.push(await measureConcurrencyOnce(ws, mode))
    } finally {
      for (const w of ws) rmSync(w, { recursive: true, force: true })
    }
  }
  return median(walls)
}

// ---------------------------------------------------------------------------
// E — LLM-streaming jitter under concurrent code_search load. THIS is the
// proxy-relevant tail-harm measurement: the proxy serves SSE streams on the
// SAME event loop. While code_search parses synchronously, a stream's chunk
// callbacks are starved. Measure the worst inter-chunk gap of a 5ms "stream"
// running alongside 8 concurrent ranked searches.
// ---------------------------------------------------------------------------

async function measureStreamJitter(): Promise<{
  idleMaxGapMs: number
  loadedMaxGapMs: number
}> {
  const CHUNK_MS = 5
  const DURATION_MS = 400

  async function runStream(background: Promise<unknown> | null): Promise<number> {
    let last = performance.now()
    let maxGap = 0
    let stop = false
    const tick = (): void => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      if (!stop) setTimeout(tick, CHUNK_MS)
    }
    setTimeout(tick, CHUNK_MS)
    const done = new Promise<void>((r) => setTimeout(() => { stop = true; r() }, DURATION_MS))
    if (background) await background
    await done
    return maxGap
  }

  // Idle baseline.
  const idleMaxGapMs = await runStream(null)

  // Under load: 8 concurrent ranked searches over distinct cold workspaces.
  const ws: Array<string> = []
  for (let i = 0; i < 8; i++) ws.push(makeWorkspace())
  let loadedMaxGapMs = 0
  try {
    const bg = Promise.all(
      ws.map((w) =>
        searchCode({ query: EFFECTIVE_QUERY, workspace: w, mode: "ranked", summary: false, limit: 200 }),
      ),
    )
    loadedMaxGapMs = await runStream(bg)
  } finally {
    for (const w of ws) rmSync(w, { recursive: true, force: true })
  }
  return { idleMaxGapMs, loadedMaxGapMs }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const warmWs = makeWorkspace()
  const sources: Array<string> = []
  for (let i = 0; i < N_FILES; i++) {
    sources.push(readFileSync(path.join(warmWs, "src", `mod${i}.ts`), "utf8"))
  }
  const avgBytes = Math.round(
    sources.reduce((a, s) => a + Buffer.byteLength(s), 0) / sources.length,
  )

  try {
    await getGrammarBundle().ready
    await searchCode({ query: EFFECTIVE_QUERY, workspace: warmWs, mode: "ranked", summary: false, limit: 200 })

    console.log(
      `\n=== Corpus: ${N_FILES} TS files, ~${N_LINES} lines (~${avgBytes}B) each, ` +
        `query="${EFFECTIVE_QUERY}", spread=${SPREAD}, ${TRIALS} trials, median reported ===`,
    )

    // A
    const perFileMs = await measureRawParse(sources)
    const parseCpuPerCall = perFileMs * Math.min(STRUCTURAL_TOPN_FULL, N_FILES)
    console.log(`\n[A] Per-file parse (single WASM heap): ${perFileMs.toFixed(3)} ms/file`)
    console.log(
      `    Structural pass parses ≤${STRUCTURAL_TOPN_FULL} files/call → ` +
        `${parseCpuPerCall.toFixed(1)} ms parse-CPU per call (on-thread, non-overlapping)`,
    )
    console.log(
      `    The serialization ceiling: 8 concurrent calls = ` +
        `${(parseCpuPerCall * 8).toFixed(0)} ms of parse-CPU that CANNOT overlap on one heap.`,
    )

    // B
    const block = await measureEventLoopBlock(sources)
    console.log(
      `\n[B] Event-loop blocking: parsing ${block.parsedFiles} files back-to-back ` +
        `took ${block.parseMs.toFixed(1)} ms and froze the event loop for ` +
        `${block.starvationMs.toFixed(1)} ms in the longest unbroken stretch.`,
    )
    console.log(
      `    → During this window every concurrent call's rg-stream callbacks, ` +
        `timers, and Promise continuations are starved.`,
    )

    // B2 — what does the structural pass ACTUALLY parse per real call?
    // (codex_critic's key challenge: [C] conc=1 wall << [A] 50-file estimate,
    // because top-N HITS collapse into far fewer distinct FILES.)
    __resetBenchStructuralStats()
    const cold = makeWorkspace()
    await searchCode({ query: EFFECTIVE_QUERY, workspace: cold, mode: "ranked", summary: false, limit: 200 })
    const st = __readBenchStructuralStats()
    rmSync(cold, { recursive: true, force: true })
    console.log(
      `\n[B2] What ONE real ranked call actually parses (cold cache, ${N_FILES}-file ws):`,
    )
    console.log(
      `    files considered=${st.filesConsidered}, files PARSED=${st.filesParsed}, ` +
        `parse-CPU=${st.parseMsTotal.toFixed(1)} ms, budget-hit=${st.budgetHit > 0}`,
    )
    console.log(
      `    → top-50 HITS map to ${st.filesParsed} distinct FILES ` +
        (SPREAD
          ? `(spread: ~1 hit/file → many files)`
          : `(clustered: one recurring symbol → few files)`) +
        `, REAL parse-CPU/call ≈ ${st.parseMsTotal.toFixed(0)} ms ` +
        `(50-file upper bound ≈ ${parseCpuPerCall.toFixed(0)} ms).`,
    )

    // C — control: ranked (with structural parse) vs literal (NO parse). If
    // literal scales the same as ranked, parse is NOT the serialization driver.
    console.log(`\n[C] End-to-end wall by concurrency — RANKED (parses) vs LITERAL (no parse):`)
    console.log(`    conc | ranked(ms) | literal(ms) | ranked-extra(ms) | ranked-scale`)
    const rankedC1 = await measureConcurrency(1, "ranked")
    const rows: Array<{ c: number; ranked: number; literal: number }> = []
    for (const c of [1, 2, 4, 8]) {
      const ranked = c === 1 ? rankedC1 : await measureConcurrency(c, "ranked")
      const literal = await measureConcurrency(c, "literal")
      rows.push({ c, ranked, literal })
    }
    for (const r of rows) {
      console.log(
        `    ${String(r.c).padStart(4)} | ${r.ranked.toFixed(1).padStart(10)} | ` +
          `${r.literal.toFixed(1).padStart(11)} | ${(r.ranked - r.literal).toFixed(1).padStart(16)} | ` +
          `${(r.ranked / rankedC1).toFixed(2)}x`,
      )
    }

    // E — LLM-streaming jitter under concurrent load (the proxy tail-harm test).
    const jit = await measureStreamJitter()
    console.log(`\n[E] LLM-stream chunk jitter (5ms target) — proxy tail-harm:`)
    console.log(
      `    idle max inter-chunk gap = ${jit.idleMaxGapMs.toFixed(1)} ms; ` +
        `under 8 concurrent ranked searches = ${jit.loadedMaxGapMs.toFixed(1)} ms`,
    )

    const c8 = rows.find((r) => r.c === 8)!
    console.log(`\n[D] Verdict inputs:`)
    console.log(
      `    • REAL parse-CPU/call ≈ ${st.parseMsTotal.toFixed(0)} ms over ${st.filesParsed} files; ` +
        `synchronous, blocks the loop for that long`,
    )
    console.log(
      `    • ranked-vs-literal extra at conc=8 = ${(c8.ranked - c8.literal).toFixed(1)} ms ` +
        `(the part attributable to the structural parse pass)`,
    )
    console.log(
      `    • ranked wall(conc=8)/wall(conc=1) = ${(c8.ranked / rankedC1).toFixed(2)}x`,
    )
    console.log(
      `    • LLM-stream worst gap under load = ${jit.loadedMaxGapMs.toFixed(0)} ms ` +
        `(idle ${jit.idleMaxGapMs.toFixed(0)} ms) — the proxy-responsiveness signal`,
    )
    console.log(
      `    • The live 200ms structural budget caps each call; under contention the cost ` +
        `surfaces as latency+precision loss + event-loop freezes, not linear wall growth.`,
    )
  } finally {
    rmSync(warmWs, { recursive: true, force: true })
  }
}

// Keep the event loop alive for the whole run. The tree-sitter pool's workers
// are `unref()`-ed (so they never keep the PROXY alive on their own — correct
// for production, where the HTTP server holds the loop). But in a standalone
// script with no server, once the synchronous setup drains, Bun would see only
// unref'd worker handles and EXIT before a pooled `searchCode` resolves. A
// ref'd timer holds the loop open until `main()` finishes and clears it.
const keepAlive = setInterval(() => {}, 1 << 30)

main()
  .then(() => {
    clearInterval(keepAlive)
    process.exit(0)
  })
  .catch((err: unknown) => {
    clearInterval(keepAlive)
    console.error("[bench] FAILED:", err)
    process.exit(1)
  })
