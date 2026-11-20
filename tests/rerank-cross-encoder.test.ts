/**
 * Unit tests for `src/lib/rerank-cross-encoder.ts` — the in-repo cross-encoder
 * that replaced `flashrank-js`.
 *
 * NATIVE-FREE BY CONSTRUCTION: the module imports transformers.js only inside
 * `createCrossEncoder`, so importing the pure helpers here never loads ONNX.
 * Everything below runs against `makeCrossEncoder`'s injected seam, which is
 * exactly the shape `src/lib/rerank.ts` relies on. Live-model verification is
 * `bun run scripts/verify-rerank-live.ts`.
 */

import { describe, expect, test } from "bun:test"

import {
  makeCrossEncoder,
  normalizeScore,
  RERANK_MODELS,
  sigmoid,
  softmax,
  type CrossEncoderModel,
  type CrossEncoderTokenizer,
} from "../src/lib/rerank-cross-encoder"

describe("normalizeScore", () => {
  test("single logit → sigmoid", () => {
    expect(normalizeScore([0])).toBeCloseTo(0.5, 10)
    expect(normalizeScore([2])).toBeCloseTo(sigmoid(2), 10)
    expect(normalizeScore([-2])).toBeCloseTo(1 - sigmoid(2), 10)
    expect(normalizeScore([1000])).toBeCloseTo(1, 6)
    expect(normalizeScore([-1000])).toBeCloseTo(0, 6)
  })

  test("two logits → softmax class-1 probability", () => {
    expect(normalizeScore([0, 0])).toBeCloseTo(0.5, 10)
    expect(normalizeScore([0, 1])).toBeCloseTo(Math.E / (1 + Math.E), 10)
    expect(normalizeScore([5, -5])).toBeLessThan(0.01)
  })

  test("wider heads pass the first logit through untouched", () => {
    expect(normalizeScore([0.25, 2, 3])).toBe(0.25)
  })

  test("empty logits → 0 rather than NaN", () => {
    expect(normalizeScore([])).toBe(0)
  })

  test("softmax is shift-stable and sums to 1", () => {
    const probs = softmax([1000, 1001, 1002])
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(probs[2]).toBeGreaterThan(probs[1])
    expect(probs[1]).toBeGreaterThan(probs[0])
  })
})

describe("RERANK_MODELS", () => {
  test("is the flashrank pair, at the same dtype (warm caches stay valid)", () => {
    expect(RERANK_MODELS.tiny.huggingFaceId).toBe(
      "Xenova/ms-marco-TinyBERT-L-2-v2",
    )
    expect(RERANK_MODELS.mini.huggingFaceId).toBe(
      "Xenova/ms-marco-MiniLM-L-6-v2",
    )
    expect(RERANK_MODELS.tiny.dtype).toBe("fp32")
    expect(RERANK_MODELS.mini.dtype).toBe("fp32")
  })
})

/** Fake tokenizer/model pair; `scoreOf` decides each doc's logit. */
function fakeParts(scoreOf: (doc: string) => number, logitsFor?: (doc: string) => number[]) {
  const calls: Array<{ texts: Array<string>; pairs: Array<string> }> = []
  const tokenizer: CrossEncoderTokenizer = async (texts, options) => {
    calls.push({ texts: [...texts], pairs: [...options.text_pair] })
    return { pairs: [...options.text_pair] }
  }
  const model: CrossEncoderModel = async (inputs) => {
    const { pairs } = inputs as { pairs: Array<string> }
    return {
      logits: {
        tolist: () =>
          pairs.map((doc) => (logitsFor ? logitsFor(doc) : [scoreOf(doc)])),
      },
    }
  }
  return { tokenizer, model, calls }
}

describe("makeCrossEncoder", () => {
  test("ranks descending and maps indexes back to the caller's array", async () => {
    const parts = fakeParts((doc) => doc.length)
    const enc = makeCrossEncoder(parts)
    const out = await enc.rerank({
      query: "q",
      documents: ["a", "bbb", "cc"],
      topN: 3,
    })
    expect(out.map((r) => r.index)).toEqual([1, 2, 0])
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  test("topN slices the sorted head; omitted returns the full permutation", async () => {
    const enc = makeCrossEncoder(fakeParts((doc) => doc.length))
    const docs = ["a", "bb", "ccc", "dddd"]
    expect((await enc.rerank({ query: "q", documents: docs, topN: 2 })).map((r) => r.index)).toEqual([3, 2])
    expect((await enc.rerank({ query: "q", documents: docs })).map((r) => r.index)).toEqual([3, 2, 1, 0])
  })

  test("topN 0 and empty documents short-circuit without touching the model", async () => {
    const parts = fakeParts(() => 1)
    const enc = makeCrossEncoder(parts)
    expect(await enc.rerank({ query: "q", documents: ["a"], topN: 0 })).toEqual([])
    expect(await enc.rerank({ query: "q", documents: [] })).toEqual([])
    expect(parts.calls).toHaveLength(0)
  })

  test("batches at 32 by default and honours an explicit batchSize", async () => {
    const big = fakeParts(() => 1)
    await makeCrossEncoder(big).rerank({
      query: "q",
      documents: Array.from({ length: 40 }, (_, i) => `d${i}`),
    })
    expect(big.calls.map((c) => c.pairs.length)).toEqual([32, 8])

    const small = fakeParts(() => 1)
    await makeCrossEncoder(small).rerank({
      query: "q",
      documents: ["a", "b", "c", "d", "e"],
      batchSize: 2,
    })
    expect(small.calls.map((c) => c.pairs.length)).toEqual([2, 2, 1])
  })

  test("every pair is tokenized against the same query", async () => {
    const parts = fakeParts((doc) => doc.length)
    await makeCrossEncoder(parts).rerank({
      query: "auth token refresh",
      documents: ["b", "a"],
      batchSize: 1,
    })
    expect(parts.calls.map((c) => c.texts)).toEqual([
      ["auth token refresh"],
      ["auth token refresh"],
    ])
    expect(parts.calls.map((c) => c.pairs)).toEqual([["b"], ["a"]])
  })

  test("two-logit heads are scored by class-1 probability", async () => {
    const enc = makeCrossEncoder(
      fakeParts(() => 0, (doc) => (doc === "best" ? [0, 5] : [5, 0])),
    )
    const out = await enc.rerank({ query: "q", documents: ["worst", "best"] })
    expect(out[0].index).toBe(1)
    expect(out[0].score).toBeGreaterThan(0.99)
    expect(out[1].score).toBeLessThan(0.01)
  })

  test("dispose releases the model and refuses further reranks", async () => {
    let disposed = 0
    const parts = fakeParts(() => 1)
    parts.model.dispose = async () => {
      disposed += 1
    }
    const enc = makeCrossEncoder(parts)
    await enc.dispose()
    await enc.dispose() // idempotent
    expect(disposed).toBe(1)
    await expect(enc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow(
      /disposed/,
    )
  })

  test("a failing model dispose never fails the caller", async () => {
    const parts = fakeParts(() => 1)
    parts.model.dispose = async () => {
      throw new Error("native teardown")
    }
    const enc = makeCrossEncoder(parts)
    await expect(enc.dispose()).resolves.toBeUndefined()
  })
})
