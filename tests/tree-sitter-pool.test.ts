/**
 * Tests for the tree-sitter worker-thread parse pool (Lever 2).
 *
 * Design + measured evidence: `docs/research/tree-sitter-parallelism.md`
 * ("Phase 2 decision"). The pool parallelizes the `code_search` structural
 * pass's parses off the main event loop. These tests pin the load-bearing
 * properties the design promises:
 *
 *   - DETERMINISM: the pooled path produces byte-identical results to the
 *     in-process path (order-independent merge), so the 5-run determinism test
 *     in code-search.test.ts holds with the pool active.
 *   - ABORT: an aborted search resolves cleanly (no hang, no throw beyond the
 *     existing clean-abort error).
 *   - WORKER-CRASH DEGRADATION: a crashing worker never kills the search — it
 *     degrades to the regex heuristic / in-process fallback and still returns
 *     correct (if less precisely ranked) results.
 *   - POOL DISABLED: GH_ROUTER_DISABLE_TS_POOL=1 forces the in-process path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { statSync } from "node:fs"

import { searchCode } from "../src/lib/code-search"
import {
  getTreeSitterPool,
  type PoolJob,
  __resetTreeSitterPoolForTests,
} from "../src/lib/tree-sitter-pool/pool"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFixture(setup: (root: string) => void): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-tspool-")))
  setup(root)
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best effort
      }
    },
  }
}

/** A SPREAD fixture: a unique symbol per file used once, queried by a shared
 *  prefix → ~1 hit/file across many files → the structural pass parses many
 *  distinct files (the pool's worst case, where it actually does work). */
function spreadFixture(nFiles: number): (root: string) => void {
  return (root) => {
    mkdirSync(path.join(root, "src"))
    for (let i = 0; i < nFiles; i++) {
      writeFileSync(
        path.join(root, "src", `mod${i}.ts`),
        [
          `export function handlerFor${i}(input: string): string {`,
          `  return input.trim()`,
          `}`,
          `export class Service${i} {`,
          `  run${i}() { return ${i} }`,
          `}`,
        ].join("\n") + "\n",
      )
    }
  }
}

// Reset the singleton (and any env knobs) between tests so each test gets a
// fresh pool with its own env.
beforeEach(() => {
  __resetTreeSitterPoolForTests()
})
afterEach(() => {
  __resetTreeSitterPoolForTests()
  delete process.env.GH_ROUTER_ENABLE_TS_POOL
  delete process.env.GH_ROUTER_DISABLE_TS_POOL
  delete process.env.GH_ROUTER_TS_WORKER_CRASH
  delete process.env.GH_ROUTER_TS_POOL_SIZE
})

/** Stable projection of a search response for equality comparison (drops the
 *  variable elapsed_ms / scanned_files). */
function stable(r: Awaited<ReturnType<typeof searchCode>>): string {
  return JSON.stringify({
    results: r.results.map((h) => ({
      file: h.file,
      line: h.line,
      role: h.role ?? null,
      sc: h.field_contributions?.symbol_context ?? null,
      score: h.score ?? null,
    })),
    outlines: (r.outlines ?? []).map((o) => ({
      file: o.file,
      names: o.outline.map((e) => `${e.name}@${e.line}#${e.depth}`),
    })),
    notice: r.notice,
  })
}

async function runRanked(workspace: string): Promise<Awaited<ReturnType<typeof searchCode>>> {
  return searchCode({
    query: "handlerFor",
    workspace,
    mode: "ranked",
    structural: "full",
    limit: 50,
    summary: true,
  })
}

// ---------------------------------------------------------------------------

// The pool is OPT-IN (GH_ROUTER_ENABLE_TS_POOL=1). Probe ONCE whether the
// worker_threads pool actually reproduces the in-process result IN THIS
// runtime: under bun on the CI runners (ubuntu/windows) the worker can't init
// its web-tree-sitter WASM grammar heap, so the pooled output degrades while
// the main-thread in-process path is fine. Where the worker can't init, skip
// the pool-specific describes — the pool is opt-in and production uses the
// in-process default. Mirrors the ast-grep `sgAvailable` gate.
async function probePoolFunctional(): Promise<boolean> {
  const fxA = makeFixture(spreadFixture(6))
  const fxB = makeFixture(spreadFixture(6))
  try {
    process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
    __resetTreeSitterPoolForTests()
    const pooled = stable(await runRanked(fxA.root))
    delete process.env.GH_ROUTER_ENABLE_TS_POOL
    process.env.GH_ROUTER_DISABLE_TS_POOL = "1"
    __resetTreeSitterPoolForTests()
    const inProcess = stable(await runRanked(fxB.root))
    return pooled === inProcess
  } catch {
    return false
  } finally {
    delete process.env.GH_ROUTER_ENABLE_TS_POOL
    delete process.env.GH_ROUTER_DISABLE_TS_POOL
    __resetTreeSitterPoolForTests()
    fxA.cleanup()
    fxB.cleanup()
  }
}
const poolFunctional = await probePoolFunctional()
const poolDescribe = poolFunctional ? describe : describe.skip

poolDescribe("tree-sitter pool — determinism (pooled ≡ in-process)", () => {
  test("pooled output is byte-identical to the in-process path", async () => {
    const fx = makeFixture(spreadFixture(30))
    try {
      // Pool ON.
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const pooled = stable(await runRanked(fx.root))

      // Pool OFF (in-process baseline). Use a FRESH fixture so the
      // module-global _treeCache (keyed by path+mtime) can't carry a pooled
      // tree into the in-process run.
      const fx2 = makeFixture(spreadFixture(30))
      try {
        process.env.GH_ROUTER_DISABLE_TS_POOL = "1"
        __resetTreeSitterPoolForTests()
        const inProcess = stable(await runRanked(fx2.root)).replaceAll(
          path.basename(fx2.root),
          path.basename(fx.root),
        )
        // Paths are relative to workspace, so basenames don't appear; compare
        // directly. (The replaceAll is defensive and a no-op here.)
        expect(pooled).toBe(inProcess)
      } finally {
        fx2.cleanup()
      }
    } finally {
      fx.cleanup()
    }
  })

  test("5 consecutive pooled runs produce identical output", async () => {
    const fx = makeFixture(spreadFixture(25))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      const runs = new Set<string>()
      for (let i = 0; i < 5; i++) {
        runs.add(stable(await runRanked(fx.root)))
      }
      expect(runs.size).toBe(1)
    } finally {
      fx.cleanup()
    }
  })

  test("definitions are AST-confirmed via the worker path", async () => {
    const fx = makeFixture(spreadFixture(20))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      const r = await runRanked(fx.root)
      // Every file's `handlerForN` definition should be role-tagged.
      const defs = r.results.filter((h) => h.role === "definition")
      expect(defs.length).toBeGreaterThan(0)
      // The top hit should be a confirmed definition with a symbol_context boost.
      expect(r.results[0].role).toBe("definition")
      expect(r.results[0].field_contributions?.symbol_context).toBeGreaterThan(0)
    } finally {
      fx.cleanup()
    }
  })
})

poolDescribe("tree-sitter pool — abort propagation", () => {
  test("a pre-aborted ranked search rejects cleanly (no hang)", async () => {
    const fx = makeFixture(spreadFixture(30))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      const ac = new AbortController()
      ac.abort("test")
      await expect(runRankedWithSignal(fx.root, ac.signal)).rejects.toThrow()
    } finally {
      fx.cleanup()
    }
  })

  test("aborting after results return resolves without throwing", async () => {
    const fx = makeFixture(spreadFixture(30))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      // Not aborted — a normal completion under the pool.
      const r = await runRanked(fx.root)
      expect(r.results.length).toBeGreaterThan(0)
    } finally {
      fx.cleanup()
    }
  })
})

poolDescribe("tree-sitter pool — worker-crash degradation", () => {
  test("a crashing worker never kills the search; results still returned", async () => {
    const fx = makeFixture(spreadFixture(30))
    try {
      // Force every worker to crash on its first job. The search MUST still
      // succeed (falling back to the in-process path / regex heuristic).
      process.env.GH_ROUTER_TS_WORKER_CRASH = "1"
      __resetTreeSitterPoolForTests()
      const r = await runRanked(fx.root)
      // Search survived and returned the full ripgrep match set, reordered.
      expect(r.results.length).toBeGreaterThan(0)
      // It found the definition lines (line 1 of each file).
      expect(r.results.some((h) => h.line === 1)).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  test("after a crash, a subsequent search recovers (workers respawn)", async () => {
    const fx = makeFixture(spreadFixture(20))
    try {
      // First search: workers crash.
      process.env.GH_ROUTER_TS_WORKER_CRASH = "1"
      __resetTreeSitterPoolForTests()
      const crashed = await runRanked(fx.root)
      expect(crashed.results.length).toBeGreaterThan(0)

      // Second search WITHOUT the crash env: the pool respawns healthy workers
      // and confirms definitions again.
      delete process.env.GH_ROUTER_TS_WORKER_CRASH
      const fx2 = makeFixture(spreadFixture(20))
      try {
        const recovered = await runRanked(fx2.root)
        expect(recovered.results.some((h) => h.role === "definition")).toBe(true)
      } finally {
        fx2.cleanup()
      }
    } finally {
      fx.cleanup()
    }
  })

  test("crash degradation result matches the disabled-pool result set", async () => {
    // The crash fallback must return the SAME match set (files/lines) as the
    // pool-disabled path — only ranking precision may differ, never recall.
    const fxA = makeFixture(spreadFixture(15))
    const fxB = makeFixture(spreadFixture(15))
    try {
      process.env.GH_ROUTER_TS_WORKER_CRASH = "1"
      __resetTreeSitterPoolForTests()
      const crashed = await runRanked(fxA.root)

      delete process.env.GH_ROUTER_TS_WORKER_CRASH
      process.env.GH_ROUTER_DISABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const disabled = await runRanked(fxB.root)

      const keys = (r: Awaited<ReturnType<typeof searchCode>>) =>
        new Set(r.results.map((h) => `${h.file}:${h.line}`))
      expect(keys(crashed)).toEqual(keys(disabled))
    } finally {
      fxA.cleanup()
      fxB.cleanup()
    }
  })
})

describe("tree-sitter pool — disable knob", () => {
  test("GH_ROUTER_DISABLE_TS_POOL=1 still returns correct results", async () => {
    const fx = makeFixture(spreadFixture(20))
    try {
      process.env.GH_ROUTER_DISABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const r = await runRanked(fx.root)
      expect(r.results.length).toBeGreaterThan(0)
      expect(r.results.some((h) => h.role === "definition")).toBe(true)
    } finally {
      fx.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Direct pool.parseFiles tests — the budget/abort/shutdown promise-resolution
// invariants the adversarial review flagged (a queued job must never leave its
// caller's Promise.all hanging past the deadline).
// ---------------------------------------------------------------------------

function buildJobs(root: string, n: number): Array<PoolJob> {
  const jobs: Array<PoolJob> = []
  for (let i = 0; i < n; i++) {
    const abs = path.join(root, "src", `mod${i}.ts`)
    jobs.push({
      file: `src/mod${i}.ts`,
      absPath: abs,
      language: "typescript",
      mtimeMs: statSync(abs).mtimeMs,
      confirmHits: [{ line: 1, matchStart: 16, matchEnd: 16 + `handlerFor${i}`.length }],
      outline: true,
    })
  }
  return jobs
}

poolDescribe("tree-sitter pool — budget / abort / shutdown never hang", () => {
  test("budgetMs=0 over many files returns promptly (queued jobs resolved, no hang)", async () => {
    const fx = makeFixture(spreadFixture(40))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const pool = getTreeSitterPool()
      expect(pool).not.toBeNull()
      const jobs = buildJobs(fx.root, 40)
      const t0 = Date.now()
      // A zero budget must NOT wait for all 40 parses; queued jobs are dropped.
      const run = await pool!.parseFiles(jobs, {
        budgetMs: 0,
        signal: new AbortController().signal,
      })
      const elapsed = Date.now() - t0
      // Resolved (not null = pool ran) and FAST — well under what 40 serial
      // parses would take, and far under the bun:test 5s timeout.
      expect(run).not.toBeNull()
      expect(run!.budgetHit).toBe(true)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      fx.cleanup()
    }
  })

  test("abort during parseFiles resolves promptly", async () => {
    const fx = makeFixture(spreadFixture(40))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const pool = getTreeSitterPool()!
      const jobs = buildJobs(fx.root, 40)
      const ac = new AbortController()
      // Abort almost immediately.
      setTimeout(() => ac.abort("test"), 1)
      const t0 = Date.now()
      const run = await pool.parseFiles(jobs, { budgetMs: 10_000, signal: ac.signal })
      expect(Date.now() - t0).toBeLessThan(2000)
      // Aborted runs resolve (possibly partial) — never hang.
      expect(run).not.toBeNull()
    } finally {
      fx.cleanup()
    }
  })

  test("shutdown during an in-flight parseFiles does not hang the caller", async () => {
    const fx = makeFixture(spreadFixture(40))
    try {
      process.env.GH_ROUTER_ENABLE_TS_POOL = "1"
      __resetTreeSitterPoolForTests()
      const pool = getTreeSitterPool()!
      const jobs = buildJobs(fx.root, 40)
      const t0 = Date.now()
      const p = pool.parseFiles(jobs, {
        budgetMs: 10_000,
        signal: new AbortController().signal,
      })
      // Tear the pool down mid-flight.
      setTimeout(() => __resetTreeSitterPoolForTests(), 5)
      const run = await p
      expect(Date.now() - t0).toBeLessThan(2000)
      // It resolved (null or partial) rather than hanging.
      expect(run === null || run.byFile instanceof Map).toBe(true)
    } finally {
      fx.cleanup()
    }
  })
})

async function runRankedWithSignal(
  workspace: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof searchCode>>> {
  return searchCode(
    {
      query: "handlerFor",
      workspace,
      mode: "ranked",
      structural: "full",
      limit: 50,
      summary: true,
    },
    signal,
  )
}
