/**
 * Regression: a trailing EMPTY assistant turn must not erase an earlier turn's
 * substantive text.
 *
 * `message_end` overwrites `finalText` on every assistant turn. Without a
 * high-water mark of the last NON-EMPTY text, a worker that spends 40 minutes
 * reading 60 files, reports its findings alongside a tool call, and then ends
 * with an empty turn returns only the `[worker exited with no output ...]`
 * sentinel. For the read-only modes (explore / review / plan) the transcript
 * lives only in memory, so that investigation is unrecoverable.
 *
 * The recovered text must be LABELLED — silently returning an earlier turn's
 * prose as if it were the final answer would be its own bug.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { __testExports, runWorkerAgent } from "~/lib/worker-agent/engine"
import { __resetForTests as resetWorkerSemaphore } from "~/lib/worker-agent/semaphore"
import { sseFinalText, sseResponse } from "./helpers/worker-sse"

const MODEL = "recovered-text-model"
const MARKER = "IMPORTANT_FINDINGS_ALPHA"
const RECOVERED_RE = /recovered from an earlier/i

function fakeModel(id: string) {
  return {
    id,
    name: id,
    vendor: "OpenAI",
    version: id,
    preview: true,
    model_picker_enabled: true,
    object: "model",
    capabilities: {
      type: "chat",
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: {},
      supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
    },
    // The real Copilot catalog advertises the UNVERSIONED path, and
    // `pickEndpoint` matches on exactly that. A `/v1/`-prefixed fixture is
    // now resolved as "serves neither of our two clients" and short-circuits
    // before the agent loop ever runs.
    supported_endpoints: ["/chat/completions"],
  }
}

/**
 * One assistant turn that emits BOTH text and a tool call — the shape the
 * defect needs. `noop` is intentionally not a real worker tool: its
 * unknown-tool result keeps the loop going for one more turn without touching
 * the filesystem.
 */
function sseTextThenToolCall(text: string, name: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])
}

/** Model stops cleanly with no content delta at all. */
function sseEmptyFinal(): Response {
  return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
}

function tmpDir(tag: string): string {
  return realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), `wa-recovered-${tag}-`)),
  )
}

const originalModels = state.models
const originalToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.models = {
    object: "list",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: [fakeModel(MODEL)] as any,
  }
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  resetWorkerSemaphore()
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalToken
  state.vsCodeVersion = originalVsCodeVersion
  globalThis.fetch = originalFetch
  resetWorkerSemaphore()
})

test("a trailing empty turn cannot erase an earlier turn's findings", async () => {
  let call = 0
  globalThis.fetch = mock(() =>
    Promise.resolve(
      call++ === 0 ? sseTextThenToolCall(MARKER, "noop") : sseEmptyFinal(),
    ),
  ) as unknown as typeof fetch

  const dir = tmpDir("clobber")
  try {
    const r = await runWorkerAgent({
      prompt: "investigate deeply",
      mode: "explore",
      model: MODEL,
      workspace: dir,
    })

    // The honest status still leads — callers key off this stable prefix.
    expect(r.text).toStartWith("[worker exited with no output")
    expect(r.isError).toBe(true)
    // ...and the expensive work is no longer destroyed.
    expect(r.text).toContain(MARKER)
    // ...and it is labelled as recovered, not passed off as a final answer.
    expect(r.text).toMatch(RECOVERED_RE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a clean final answer is returned verbatim, with no recovered-text banner", async () => {
  let call = 0
  globalThis.fetch = mock(() =>
    Promise.resolve(
      call++ === 0
        ? sseTextThenToolCall(MARKER, "noop")
        : sseFinalText("final summary"),
    ),
  ) as unknown as typeof fetch

  const dir = tmpDir("clean")
  try {
    const r = await runWorkerAgent({
      prompt: "investigate then summarize",
      mode: "explore",
      model: MODEL,
      workspace: dir,
    })

    // The high-water mark must never leak into a healthy run: no banner, no
    // stale earlier turn appended, no change to the verbatim contract.
    expect(r.text).toBe("final summary")
    expect(r.text).not.toMatch(RECOVERED_RE)
    expect(r.isError).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an aborted run keeps the earlier turn's text alongside the halt reason", async () => {
  const ac = new AbortController()
  let call = 0
  globalThis.fetch = mock((_url: string, init?: RequestInit) => {
    if (call++ === 0) {
      return Promise.resolve(sseTextThenToolCall(MARKER, "noop"))
    }
    // Second model call never resolves; the abort is the only way out — the
    // real-world shape of a wall-clock halt landing on an empty turn.
    setTimeout(() => ac.abort(), 10)
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        },
        { once: true },
      )
    })
  }) as unknown as typeof fetch

  const dir = tmpDir("abort")
  try {
    const r = await runWorkerAgent({
      prompt: "long investigation",
      mode: "explore",
      model: MODEL,
      workspace: dir,
      signal: ac.signal,
    })

    expect(r.isError).toBe(true)
    expect(r.text).toContain("[halted: cancelled]")
    expect(r.text).toContain(MARKER)
    expect(r.text).toMatch(RECOVERED_RE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("recoveredBlock", () => {
  const { recoveredBlock, RECOVERED_TEXT_BANNER } = __testExports

  test("stays silent whenever recovery would be noise", () => {
    // Live text exists — nothing was lost, so nothing is salvaged.
    expect(recoveredBlock("real answer", "earlier")).toBe("")
    // No turn ever produced text.
    expect(recoveredBlock("", "")).toBe("")
    // A whitespace-only high-water mark is not text.
    expect(recoveredBlock("", "   \n\t ")).toBe("")
    // A whitespace-only "live" answer still counts as empty, so it recovers.
    expect(recoveredBlock("   ", "earlier")).toContain("earlier")
  })

  test("labels the salvage so it cannot read as a final answer", () => {
    const out = recoveredBlock("", "  findings  ")
    expect(out).toStartWith(RECOVERED_TEXT_BANNER)
    expect(out).toEndWith("findings")
    expect(RECOVERED_TEXT_BANNER).toMatch(RECOVERED_RE)
    // The banner must say what it is NOT, not merely where it came from.
    expect(RECOVERED_TEXT_BANNER).toMatch(/not a conclusion/i)
  })
})
