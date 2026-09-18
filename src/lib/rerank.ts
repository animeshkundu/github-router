/**
 * JIT cross-encoder reranking for lexical results (Phase 3).
 *
 * `code_search` ranked mode already orders by BM25F + AST definition signal,
 * which is optimal for single-identifier queries ("where is X"). For
 * NATURAL-LANGUAGE queries ("retry around the upstream fetch") BM25F's
 * tokenized matching is weak — this module reranks the BM25F top-N with a
 * local ONNX cross-encoder (flashrank-js) so the lexical engine degrades
 * gracefully on intent-shaped queries, including the `lexical-fallback`
 * path when the semantic index isn't ready.
 *
 * Design constraints (highest-value, lowest-risk):
 *   - NL-shaped queries ONLY (≥2 whitespace terms). Single identifiers skip
 *     reranking entirely — zero latency cost for the common case.
 *   - Two warm singletons (`tiny` 4MB / `mini` 23MB); load selects by live
 *     queue pressure (`tiny` when searches are queued, `mini` otherwise).
 *     ~27MB total, shared across all queries in the process.
 *   - Lazy warm: first NL query triggers background load and FALLS BACK to
 *     BM25F order within the budget — never blocks on model download.
 *   - Hard budget (default 150ms): on timeout/error, BM25F order stands.
 *     Reranking is a precision boost, never on the correctness path.
 *   - Opt-out: `GH_ROUTER_RERANK=off`. Force a model with `=tiny|mini`.
 *     Budget override: `GH_ROUTER_RERANK_BUDGET_MS`.
 */

import { queuedSearchCount } from "~/lib/search-concurrency"

type RerankerInstance = {
  rerank: (req: {
    query: string
    documents: Array<string>
    topN: number
  }) => Promise<Array<{ index: number; score: number }>>
  dispose?: () => Promise<void>
}

type RerankModel = "tiny" | "mini"

const RERANK_BUDGET_MS_DEFAULT = 150

function rerankMode(): "off" | "auto" | RerankModel {
  const raw = process.env.GH_ROUTER_RERANK?.toLowerCase()
  if (raw === "off" || raw === "0" || raw === "false") return "off"
  if (raw === "tiny" || raw === "mini") return raw
  return "auto"
}

function rerankBudgetMs(): number {
  const raw = Number(process.env.GH_ROUTER_RERANK_BUDGET_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return RERANK_BUDGET_MS_DEFAULT
}

/** True iff the query is natural-language shaped (multi-word). */
export function isNaturalLanguageQuery(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length >= 2
}

const instances = new Map<RerankModel, Promise<RerankerInstance | null>>()

/**
 * Load-serialization chain. Concurrent ONNX session initializations crash
 * the process under Bun's Node-API compat (reproduced: overlapping tiny +
 * mini `Reranker.create` → C++ exception). Chaining guarantees at most one
 * `create` runs at a time; inference on loaded sessions is unaffected.
 * A burst that needs both models (first query idle → mini starts, second
 * query queued → tiny starts) therefore serializes instead of crashing.
 */
let loadChain: Promise<unknown> = Promise.resolve()

/**
 * Every load ever started (never cleared). Budget-short-circuited callers
 * orphan their load — the download + ORT init continue detached. If the
 * process exits while native init is in flight, Bun's teardown crashes
 * (reproduced: C++ exception after a green run). Draining this set before
 * exit (tests: afterAll; proxy: shutdown chain) is what keeps teardown
 * clean. Short-lived by construction: each entry settles on load completion.
 */
const inflightLoads = new Set<Promise<unknown>>()

/**
 * Lazily load (and cache) a reranker. Never rejects — load failure
 * (no network, bad cache) resolves null so callers fall back to BM25F.
 */
function getReranker(model: RerankModel): Promise<RerankerInstance | null> {
  const cached = instances.get(model)
  if (cached) return cached
  const p = loadChain.then(async (): Promise<RerankerInstance | null> => {
    try {
      const { Reranker } = await import("flashrank-js")
      return (await Reranker.create({ model })) as RerankerInstance
    } catch {
      return null
    }
  })
  // Advance the chain (swallowing errors so one failed load never wedges
  // later ones); the cached promise itself never rejects (see above).
  loadChain = p.catch(() => {})
  instances.set(model, p)
  const tracked = p.catch(() => {})
  inflightLoads.add(tracked)
  void tracked.finally(() => {
    inflightLoads.delete(tracked)
  })
  return p
}

/** Test-only: drop cached instances (forces reload / failure paths). */
export function __resetRerankerForTests(): void {
  instances.clear()
}

/**
 * Await every in-flight model load (test/shutdown use). Without this, a
 * budget-short-circuited load orphaned near process exit crashes Bun's
 * native teardown. Bounded by `timeoutMs` so a hung download can't wedge
 * shutdown; callers that time out accept the residual exit-crash risk.
 */
export async function drainRerankerLoads(timeoutMs = 30_000): Promise<void> {
  const pending = [...inflightLoads]
  if (pending.length === 0) return
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ])
}

/**
 * Dispose all cached sessions and drop them (shutdown/script use). Live
 * ONNX sessions hold event-loop handles that keep a short-lived process
 * from exiting on its own; disposing releases them so the loop drains.
 * The long-lived proxy should call this (after `drainRerankerLoads`) in
 * its shutdown chain. Never throws.
 */
export async function disposeRerankers(): Promise<void> {
  const all = [...instances.values()]
  instances.clear()
  for (const p of all) {
    try {
      const r = await p
      await r?.dispose?.()
    } catch {
      // best effort
    }
  }
}

/**
 * Rerank `documents` against `query`, returning the top `topN` document
 * indexes in reranked order — or null when reranking is disabled,
 * unavailable, over budget, or errors. Null is NOT an error: the caller
 * keeps BM25F order.
 */
export async function rerankDocuments(
  query: string,
  documents: ReadonlyArray<string>,
  topN: number,
  signal?: AbortSignal,
): Promise<Array<number> | null> {
  const mode = rerankMode()
  if (mode === "off" || documents.length === 0 || topN <= 0) return null
  if (signal?.aborted) return null

  // Load-adaptive model: tiny when searches are queued (burst), else mini
  // (or the forced model). Both singletons stay warm once loaded.
  const model: RerankModel =
    mode === "auto" ? (queuedSearchCount() > 0 ? "tiny" : "mini") : mode

  const budget = rerankBudgetMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      (async () => {
        const reranker = await getReranker(model)
        if (!reranker || signal?.aborted) return null
        const ranked = await reranker.rerank({
          query,
          documents: [...documents],
          topN: Math.min(topN, documents.length),
        })
        if (signal?.aborted) return null
        return ranked.map((r) => r.index)
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget)
        timer.unref?.()
      }),
    ])
    return result
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
