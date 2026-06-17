import { describe, expect, mock, test } from "bun:test"

import {
  decidePromptSubmitV2,
  PROMPT_SEARCH_TIP,
  PROMPT_STEER_GOAL,
  type PromptSubmitV2IO,
} from "../src/lib/orchestration/prompt-submit-hook"

type SearchCode = PromptSubmitV2IO["searchCode"]
type Infer = PromptSubmitV2IO["infer"]
type ReadFindings = PromptSubmitV2IO["readFindings"]
type ClearFindings = PromptSubmitV2IO["clearFindings"]
type StorePrompt = PromptSubmitV2IO["storePrompt"]

function makeIo(overrides: {
  searchCode?: SearchCode
  infer?: Infer
  readFindings?: ReadFindings
  clearFindings?: ClearFindings
  storePrompt?: StorePrompt
  timeoutMs?: number
} = {}): {
  io: PromptSubmitV2IO
  searchCode: ReturnType<typeof mock<SearchCode>>
  infer: ReturnType<typeof mock<Infer>>
  readFindings: ReturnType<typeof mock<ReadFindings>>
  clearFindings: ReturnType<typeof mock<ClearFindings>>
  storePrompt: ReturnType<typeof mock<StorePrompt>>
} {
  const searchCode = mock<SearchCode>(overrides.searchCode ?? (async () => ""))
  const infer = mock<Infer>(overrides.infer ?? (async () => ""))
  const readFindings = mock<ReadFindings>(overrides.readFindings ?? (async () => null))
  const clearFindings = mock<ClearFindings>(overrides.clearFindings ?? (async () => {}))
  const storePrompt = mock<StorePrompt>(overrides.storePrompt ?? (async () => {}))
  const io: PromptSubmitV2IO = { searchCode, infer, readFindings, clearFindings, storePrompt }
  if (overrides.timeoutMs !== undefined) io.timeoutMs = overrides.timeoutMs
  return { io, searchCode, infer, readFindings, clearFindings, storePrompt }
}

describe("decidePromptSubmitV2", () => {
  test("subagent stands down with empty injection and no io calls", async () => {
    const { io, searchCode, infer, readFindings, clearFindings, storePrompt } = makeIo()

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please refactor auth", agent_type: "Explore" }),
      steerEnabled: true,
      io,
    })

    expect(result).toEqual({ inject: "" })
    expect(searchCode.mock.calls.length).toBe(0)
    expect(infer.mock.calls.length).toBe(0)
    expect(readFindings.mock.calls.length).toBe(0)
    expect(clearFindings.mock.calls.length).toBe(0)
    expect(storePrompt.mock.calls.length).toBe(0)
  })

  test("trivial prompt injects the static search tip, stores the prompt, and makes no search or model call", async () => {
    const { io, searchCode, infer, storePrompt } = makeIo()

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "hi" }),
      steerEnabled: true,
      io,
    })

    expect(result.resetSession).toBe("s1")
    expect(result.inject).toContain(PROMPT_SEARCH_TIP)
    expect(searchCode.mock.calls.length).toBe(0)
    expect(infer.mock.calls.length).toBe(0)
    expect(storePrompt.mock.calls.length).toBe(1)
    expect(storePrompt.mock.calls[0]).toEqual(["s1", "hi"])
  })

  test("substantive prompt injects a grounded goal from lexical and semantic search", async () => {
    const groundedGoal = "SCOPE: focused\nGOAL: do X"
    const { io, searchCode, infer } = makeIo({
      searchCode: async (_query, mode) => `${mode} auth handler result`,
      infer: async () => groundedGoal,
    })

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please refactor the auth handler across all modules" }),
      steerEnabled: true,
      io,
    })

    expect(result.inject).toContain(groundedGoal)
    expect(searchCode.mock.calls.length).toBe(2)
    expect(searchCode.mock.calls.map((call) => call[1]).sort()).toEqual(["lexical", "semantic"])
    expect(infer.mock.calls.length).toBe(1)
    expect(infer.mock.calls[0]?.[1]).toContain("lexical auth handler result")
    expect(infer.mock.calls[0]?.[1]).toContain("semantic auth handler result")
  })

  test("threads an AbortSignal into searchCode and infer, and aborts it after the race", async () => {
    let inferSignal: AbortSignal | undefined
    const { io, searchCode } = makeIo({
      searchCode: async () => "hit",
      infer: async (_s, _u, signal) => {
        inferSignal = signal
        return "SCOPE: focused\nGOAL: do X"
      },
    })

    await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please refactor the auth handler across all modules" }),
      steerEnabled: true,
      io,
    })

    // Both search calls and the inference receive the SAME AbortSignal instance.
    const sigs = searchCode.mock.calls.map((c) => c[2])
    expect(sigs.every((s) => s instanceof AbortSignal)).toBe(true)
    expect(inferSignal).toBeInstanceOf(AbortSignal)
    expect(sigs[0]).toBe(inferSignal)
    // The orchestrator aborts the controller once the race settles (so a lost
    // fetch can't keep the short-lived hook process alive).
    expect(inferSignal?.aborted).toBe(true)
  })

  test("fail-open: infer rejection falls back to the static steer goal and returns normally", async () => {
    const { io, infer } = makeIo({
      infer: async () => { throw new Error("model unavailable") },
    })

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please refactor the auth handler across all modules" }),
      steerEnabled: true,
      io,
    })

    expect(infer.mock.calls.length).toBe(1)
    expect(result.inject).toBe(PROMPT_STEER_GOAL)
    expect(result.inject.length).toBeGreaterThan(0)
  })

  test("findings round-trip surfaces pending findings and clears them once", async () => {
    const finding = "Potential bug: the handler drops auth errors."
    const { io, clearFindings } = makeIo({ readFindings: async () => finding })

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s-findings", prompt: "hi" }),
      steerEnabled: true,
      io,
    })

    expect(result.inject).toContain(finding)
    expect(result.inject).toContain("NON-AUTHORITATIVE")
    expect(clearFindings.mock.calls.length).toBe(1)
    expect(clearFindings.mock.calls[0]).toEqual(["s-findings"])
  })

  test("findings round-trip leaves findings store alone when no pending findings exist", async () => {
    const { io, clearFindings } = makeIo({ readFindings: async () => null })

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s-empty", prompt: "hi" }),
      steerEnabled: true,
      io,
    })

    expect(result.inject).toContain(PROMPT_SEARCH_TIP)
    expect(clearFindings.mock.calls.length).toBe(0)
  })

  test("no-AC-store: the V2 IO surface requires no acceptance-criteria writer", async () => {
    const { io, storePrompt } = makeIo()
    expect(Object.keys(io).sort()).toEqual([
      "clearFindings",
      "infer",
      "readFindings",
      "searchCode",
      "storePrompt",
    ])

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "hi" }),
      steerEnabled: true,
      io,
    })

    expect(result.inject).toContain(PROMPT_SEARCH_TIP)
    expect(storePrompt.mock.calls.length).toBe(1)
  })

  test("timeout fail-open: a never-resolving infer falls back quickly to the static steer goal", async () => {
    // Simulate a hung model call: resolves only well AFTER the 50ms budget, with
    // an unref'd timer so the dangling call never keeps the test runner alive.
    const { io } = makeIo({
      infer: () =>
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve("late"), 5_000)
          t.unref?.()
        }),
      timeoutMs: 50,
    })
    const start = performance.now()

    const result = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: "s1", prompt: "Please refactor the auth handler across all modules" }),
      steerEnabled: true,
      io,
    })

    expect(result.inject).toBe(PROMPT_STEER_GOAL)
    expect(performance.now() - start).toBeLessThan(1_000)
  })
})
