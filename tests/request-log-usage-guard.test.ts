import { describe, expect, test } from "bun:test"

import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Regression coverage for a bug in `normalizeOpenAIUsage(usage) | undefined
 * usage` gating on the non-streaming `/v1/chat/completions` and
 * `/v1/responses` request-log wiring.
 *
 * `normalizeOpenAIUsage(undefined)` deliberately returns a DEFINED all-zero
 * object (`{totalInput: 0, ...}`), documented at its own call site as "so
 * Anthropic and Pi consumers do not count the same input twice" — it never
 * returns `undefined`. That is correct for its own callers, but it is a trap
 * for a caller that gates on `!isStreaming ? normalizeOpenAIUsage(rawUsage) :
 * undefined` and then reads `responseUsage?.totalInput`: once the ternary's
 * `!isStreaming` branch is taken, `responseUsage` is ALWAYS a defined object,
 * so `responseUsage?.totalInput` is ALWAYS a defined number (0 when usage was
 * absent) and never falls through past the `?.` to whatever the caller
 * intended for "we truly have no usage data" (the chat-completions path's
 * tokenizer-estimate `?? inputTokens` fallback, or — on `/v1/responses`,
 * which has no such fallback — omitting the `in:` field the way
 * `formatTokenInfo` does for a genuinely undefined `inputTokens`).
 *
 * `consola.info` capture is a documented anti-pattern in this repo (see
 * `tests/request-log-body-sizes.test.ts`'s "logBodySizeStats routes its line
 * through consola" test: it depends on which reporter a PRIOR test in the
 * same process installed, and is measured to pass locally while failing in
 * CI). So this asserts the WIRING statically, the same way that test does,
 * rather than capturing a log line.
 */
describe("chat-completions / responses: usage-presence gate before normalizeOpenAIUsage", () => {
  test("chat-completions handler gates normalizeOpenAIUsage on the RAW usage field, not on !isStreaming alone", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "..", "src", "routes", "chat-completions", "handler.ts"),
      "utf8",
    )
    const start = src.indexOf("const isStreaming = !isNonStreaming(response)")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("logRequest(", start)
    const block = src.slice(start, end)
    // The raw field must be read into its own binding and checked for
    // truthiness BEFORE normalizeOpenAIUsage is ever called — a direct
    // `!isStreaming ? normalizeOpenAIUsage(...) : undefined` (the shape of
    // the bug) would call the normalizer unconditionally on the non-streaming
    // branch regardless of whether `usage` itself was present.
    expect(block).toMatch(/const rawUsage = !isStreaming\s*\n\s*\? \(response as ChatCompletionResponse\)\.usage\s*\n\s*: undefined/)
    expect(block).toMatch(/const responseUsage = rawUsage \? normalizeOpenAIUsage\(rawUsage\) : undefined/)
    // The tokenizer-estimate fallback this fix restores access to.
    expect(src).toContain("inputTokens: responseUsage?.totalInput ?? inputTokens,")
  })

  test("responses handler gates normalizeOpenAIUsage on the RAW usage field, not on !isStreaming alone", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "..", "src", "routes", "responses", "handler.ts"),
      "utf8",
    )
    const start = src.indexOf("const isStreaming = !isNonStreaming(response)")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("logRequest(", start)
    const block = src.slice(start, end)
    expect(block).toMatch(/const rawUsage = !isStreaming\s*\n\s*\? \(response as ResponsesApiResponse\)\.usage\s*\n\s*: undefined/)
    expect(block).toMatch(
      /const responseUsage =\s*\n\s*rawUsage && typeof rawUsage === "object" && !Array\.isArray\(rawUsage\)\s*\n\s*\? normalizeOpenAIUsage\(rawUsage\)\s*\n\s*: undefined/,
    )
  })
})
