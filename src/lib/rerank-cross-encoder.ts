/**
 * In-repo cross-encoder reranker over transformers.js.
 *
 * Replaces `flashrank-js`, which reached `@huggingface/transformers: ^3.0.0`
 * transitively. Every 3.x transformers pins `onnxruntime-node@1.21.0` exactly,
 * and 1.21's linux/x64 `postinstall` downloads CUDA binaries from
 * `https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/...` —
 * a path that has returned 404 since 2026-11-17. npm treats a failed
 * postinstall as a failed install, so `npx github-router@latest` and
 * `npm install -g github-router` died in the install step on linux/x64 before
 * the CLI ever ran.
 *
 * That could not be fixed from the consuming side: npm honours `overrides`
 * only from the ROOT `package.json` (never from a dependency), and Bun's
 * `trustedDependencies` gate has no npm equivalent — npm's own `allowScripts`
 * is project-level, advisory, and explicitly unavailable to `npx`/`-g`. So the
 * old chain was pinned correctly for this repo's own install and for nothing
 * else. Owning the ~60 lines flashrank provided — load tokenizer + sequence
 * classification model, score (query, doc) pairs, normalize, sort — against a
 * DIRECT `@huggingface/transformers@^4` dependency is what removes ORT 1.21
 * from every consumer tree.
 *
 * Behaviour is deliberately identical to the package it replaces:
 *   - the same two Hugging Face repos (`tiny`, `mini`) at the same `fp32`
 *     dtype, so a warm transformers cache keeps working and ranking does not
 *     shift;
 *   - the same score normalization (sigmoid for a single-logit regression
 *     head, softmax class-1 probability for a two-logit head);
 *   - the same 32-document batch size;
 *   - `rerank` returns `{ index, score }` sorted descending, each index
 *     mapping back to the caller's input array.
 *
 * transformers.js is imported DYNAMICALLY inside `createCrossEncoder` so this
 * module stays dependency-free for the pure helpers (`normalizeScore`,
 * `makeCrossEncoder`). `src/lib/rerank.ts` only ever imports this module from
 * inside its lazily-started load chain, so a proxy boot never pays for ONNX.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  installedOptional,
  optionalInstallDisabled,
  scheduleOptionalInstall,
} from "~/lib/managed-install/optional"

export type RerankModel = "tiny" | "mini"

/**
 * The two FlashRank tiers, verbatim. `tiny` is ~4MB of weights and is used
 * when searches are already queued (burst); `mini` is ~23MB and is the idle
 * default. The dtype is load-bearing: `fp32` is the file set flashrank's
 * `defaultDtype` selected, so an existing Hugging Face cache resolves to the
 * same blobs instead of re-downloading a quantized sibling.
 */
export const RERANK_MODELS = {
  tiny: { huggingFaceId: "Xenova/ms-marco-TinyBERT-L-2-v2", dtype: "fp32" },
  mini: { huggingFaceId: "Xenova/ms-marco-MiniLM-L-6-v2", dtype: "fp32" },
} as const

const DEFAULT_BATCH_SIZE = 32

/** Minimal structural view of transformers.js's callable tokenizer. */
export type CrossEncoderTokenizer = (
  texts: ReadonlyArray<string>,
  options: {
    text_pair: ReadonlyArray<string>
    padding: boolean
    truncation: boolean
  },
) => Promise<unknown>

/** Minimal structural view of transformers.js's callable model. */
export type CrossEncoderModel = {
  (inputs: unknown): Promise<{ logits: { tolist: () => unknown } }>
  dispose?: () => Promise<void> | void
}

export interface RerankInput {
  query: string
  documents: ReadonlyArray<string>
  /** Omit for the full sorted permutation; `0` means "no results". */
  topN?: number
  batchSize?: number
}

export interface CrossEncoder {
  rerank(input: RerankInput): Promise<Array<{ index: number; score: number }>>
  dispose: () => Promise<void>
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

export function softmax(logits: ReadonlyArray<number>): Array<number> {
  if (logits.length === 0) return []
  let max = logits[0]
  for (const l of logits) if (l > max) max = l
  const exps = logits.map((l) => Math.exp(l - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  if (sum === 0) return new Array<number>(logits.length).fill(1 / logits.length)
  return exps.map((e) => e / sum)
}

/**
 * Raw logits → one `[0,1]` score.
 *
 * MS MARCO cross-encoders ship in both head shapes: TinyBERT/MiniLM v2 here
 * are single-logit regression heads (sigmoid), while BGE-style bilingual
 * rerankers emit two class logits (softmax, take class 1). Anything wider
 * than two logits is not a reranking head we know, so the first logit is
 * passed through rather than invented into a probability.
 */
export function normalizeScore(logits: ReadonlyArray<number>): number {
  if (logits.length === 1) return sigmoid(logits[0])
  if (logits.length === 2) return softmax(logits)[1]
  return logits[0] ?? 0
}

/**
 * Build an encoder around an already-loaded tokenizer/model pair.
 *
 * The seam exists so unit tests can exercise ordering, batching and
 * normalization without ONNX — `createCrossEncoder` is the only caller that
 * needs the real library.
 */
export function makeCrossEncoder(parts: {
  tokenizer: CrossEncoderTokenizer
  model: CrossEncoderModel
}): CrossEncoder {
  let disposed = false
  return {
    async rerank(input) {
      if (disposed) throw new Error("rerank: cross-encoder has been disposed")
      const topN = input.topN
      if (input.documents.length === 0 || topN === 0) return []
      const batchSize =
        Number.isInteger(input.batchSize) && (input.batchSize as number) > 0
          ? (input.batchSize as number)
          : DEFAULT_BATCH_SIZE

      const scores = new Array<number>(input.documents.length)
      for (let start = 0; start < input.documents.length; start += batchSize) {
        const chunk = input.documents.slice(start, start + batchSize)
        const queries = new Array<string>(chunk.length).fill(input.query)
        const inputs = await parts.tokenizer(queries, {
          text_pair: chunk,
          padding: true,
          truncation: true,
        })
        const output = await parts.model(inputs)
        const raw = output.logits.tolist() as Array<number | Array<number>>
        const rows = Array.isArray(raw[0])
          ? (raw as Array<Array<number>>)
          : (raw as Array<number>).map((v) => [v])
        for (let i = 0; i < rows.length; i++) {
          scores[start + i] = normalizeScore(rows[i])
        }
      }

      const ranked = scores.map((score, index) => ({ index, score }))
      ranked.sort((a, b) => b.score - a.score)
      return topN !== undefined && topN < ranked.length
        ? ranked.slice(0, topN)
        : ranked
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await parts.model.dispose?.()
      } catch {
        // best effort: a failed native teardown must not fail the caller
      }
    },
  }
}

/**
 * Load transformers.js, preferring the shared `<APP_DIR>/optional` copy.
 *
 * The package is an optional PEER (547 MB with its ONNX runtime), so it is
 * normally absent from the installed tree and present once per machine under
 * APP_DIR. Resolution order, and why:
 *
 * 1. `optional/` copy — the payload the on-demand installer published. It is
 *    versioned and shared across github-router versions, so a version bump does
 *    not re-download it.
 * 2. The package tree's own `node_modules` — the developer checkout, and the
 *    `npm i -g` case where the peer resolved.
 * 3. Bare specifier — last resort, so a hoisted layout still works.
 *
 * A failure to load is NOT an error here: `rerank.ts` treats a rejection from
 * this function as "reranking unavailable" and keeps BM25F order, which is the
 * documented degradation. What must not happen is a hang or a crash on the
 * import, so each candidate is tried in turn.
 */
async function loadTransformers(): Promise<{
  AutoModelForSequenceClassification: {
    from_pretrained: (id: string, options?: Record<string, unknown>) => Promise<unknown>
  }
  AutoTokenizer: { from_pretrained: (id: string) => Promise<unknown> }
}> {
  type TransformersModule = Awaited<typeof import("@huggingface/transformers")>
  const load = async (specifier: string): Promise<TransformersModule | null> => {
    try {
      return (await import(/* @vite-ignore */ specifier)) as TransformersModule
    } catch {
      return null
    }
  }

  const shared = installedOptional("@huggingface/transformers")
  if (shared) {
    const entry = pathToFileURL(path.join(shared, "dist/transformers.node.mjs")).href
    const loaded = await load(entry)
    if (loaded) return loaded as unknown as Awaited<ReturnType<typeof loadTransformers>>
  }

  const local = await load("@huggingface/transformers")
  if (local) return local as unknown as Awaited<ReturnType<typeof loadTransformers>>

  // Nothing installed: ask for it once, in the background, and fail the way an
  // absent payload has always failed. This is the "on demand" half of the
  // optional payload — `github-router update` installs it upfront, and a machine
  // that never asked for it gets it the first time a search actually wants it.
  // The spawn is unref'd and once-per-process, so this costs one process on one
  // turn and BM25F order on that same turn.
  scheduleOptionalInstall("@huggingface/transformers", process.argv[1])
  if (optionalInstallDisabled()) {
    throw new Error(
      "@huggingface/transformers is not installed and GH_ROUTER_NO_OPTIONAL_INSTALL is set; reranking falls back to BM25F",
    )
  }
  throw new Error(
    "@huggingface/transformers is not installed; reranking falls back to BM25F (run `github-router update` to install it)",
  )
}

/**
 * Download (or load from the transformers cache) one model tier.
 *
 * Throws on a network/cache failure — callers treat that as "reranking
 * unavailable" and keep BM25F order (see `src/lib/rerank.ts`, which never
 * lets this rejection escape).
 */
export async function createCrossEncoder(model: RerankModel): Promise<CrossEncoder> {
  const info = RERANK_MODELS[model]
  const transformers = await loadTransformers()
  const { AutoModelForSequenceClassification, AutoTokenizer } = transformers
  // The dtype rides only on the model: it selects which ONNX file of the repo
  // is fetched. transformers.js ignores it for tokenizers, and its
  // `PretrainedTokenizerOptions` type rejects the key outright, so passing a
  // shared options object would not typecheck.
  const [tokenizer, sequenceClassifier] = await Promise.all([
    AutoTokenizer.from_pretrained(info.huggingFaceId),
    AutoModelForSequenceClassification.from_pretrained(info.huggingFaceId, {
      dtype: info.dtype,
    }),
  ])
  return makeCrossEncoder({
    tokenizer: tokenizer as unknown as CrossEncoderTokenizer,
    model: sequenceClassifier as unknown as CrossEncoderModel,
  })
}
