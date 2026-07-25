import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import {
  BROWSE_DEFAULT_MODEL,
  __testExports,
  runWorkerAgent,
} from "~/lib/worker-agent/engine"
import { __resetForTests as resetWorkerSemaphore } from "~/lib/worker-agent/semaphore"
import {
  type CapturedWorkerBody,
  recordingFetch,
  sseEmptyFinal,
  sseFinalText,
  sseResponse,
  sseToolCall,
} from "./helpers/worker-sse"

const MODEL = "nudge-chat-model"
const { EMPTY_OUTPUT_NUDGE, shouldNudgeForEmptyOutput } = __testExports

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
    supported_endpoints: ["/v1/chat/completions"],
  }
}

function tmpDir(tag: string): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `wa-nudge-${tag}-`)))
}

function bodyText(body: CapturedWorkerBody): string {
  return JSON.stringify(body)
}

function nudgeBodyCount(bodies: Array<CapturedWorkerBody>): number {
  return bodies.filter((body) => bodyText(body).includes(EMPTY_OUTPUT_NUDGE)).length
}

const originalModels = state.models
const originalToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      fakeModel(MODEL),
      fakeModel(BROWSE_DEFAULT_MODEL),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
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

test("the in-run nudge preserves the earlier tool result and includes it with the nudge in request #3", async () => {
  let call = 0
  const responses = [
    () => sseToolCall("noop"),
    () => sseEmptyFinal(),
    () => sseFinalText("summary"),
  ]
  const { fetchMock, bodies } = recordingFetch(() => responses[call++]!())
  globalThis.fetch = fetchMock

  const dir = tmpDir("preserves-context")
  try {
    const result = await runWorkerAgent({
      prompt: "gather and summarize",
      mode: "explore",
      model: MODEL,
      workspace: dir,
    })

    expect(bodies).toHaveLength(3)
    expect(result.text).toBe("summary")
    expect(result.text).not.toContain("[worker exited with no output")

    const thirdRequest = bodyText(bodies[2]!)
    expect(thirdRequest).toContain(EMPTY_OUTPUT_NUDGE)
    // `noop` is intentionally absent from the real worker toolset. Its durable
    // tool-result error is an unmistakable marker that the original transcript,
    // rather than a fresh retry, reached the nudge request.
    expect(thirdRequest).toContain("noop")
    expect(thirdRequest).toMatch(/not found|unknown|does not exist/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("empty forever nudges exactly once per run, then the retained fallback re-runs once (3 + 3 requests)", async () => {
  let callInRun = 0
  const { fetchMock, bodies } = recordingFetch(() => {
    const response = callInRun % 3 === 0 ? sseToolCall("noop") : sseEmptyFinal()
    callInRun += 1
    return response
  })
  globalThis.fetch = fetchMock

  const dir = tmpDir("two-tier")
  try {
    const result = await runWorkerAgent({
      prompt: "never summarize",
      mode: "explore",
      model: MODEL,
      workspace: dir,
    })

    // Tier 1 is the transcript-preserving nudge. Tier 2 is one complete fresh
    // run from withNoOutputRetry, so empty forever is 3 + 3 provider requests.
    expect(bodies).toHaveLength(6)
    expect(result.text).toStartWith("[worker exited with no output")
    expect(result.isError).toBe(true)
    expect(nudgeBodyCount(bodies)).toBe(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("nudge eligibility excludes non-clean terminal reasons", () => {
  test("aborted stream makes no extra request and never sends the nudge", async () => {
    const bodies: Array<CapturedWorkerBody> = []
    const ac = new AbortController()
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as CapturedWorkerBody)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        }, { once: true })
      })
    }) as unknown as typeof fetch

    const dir = tmpDir("aborted")
    try {
      const pending = runWorkerAgent({
        prompt: "wait",
        mode: "explore",
        model: MODEL,
        workspace: dir,
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 20)
      await pending

      expect(bodies).toHaveLength(1)
      expect(nudgeBodyCount(bodies)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("errored stream makes no extra request and never sends the nudge", async () => {
    const { fetchMock, bodies } = recordingFetch(() =>
      new Response("upstream failed", { status: 500 }),
    )
    globalThis.fetch = fetchMock

    const dir = tmpDir("error")
    try {
      const result = await runWorkerAgent({
        prompt: "fail",
        mode: "explore",
        model: MODEL,
        workspace: dir,
      })

      // The Copilot service layer naturally retries this HTTP failure three
      // times. The nudge layer must add no fourth request.
      expect(bodies).toHaveLength(3)
      expect(nudgeBodyCount(bodies)).toBe(0)
      expect(result.isError).toBe(true)
      expect(result.text).not.toContain("[worker exited with no output")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("length stop never nudges; only the retained full-run fallback repeats it", async () => {
    const { fetchMock, bodies } = recordingFetch(() =>
      sseResponse([{ choices: [{ delta: {}, finish_reason: "length" }] }]),
    )
    globalThis.fetch = fetchMock

    const dir = tmpDir("length")
    try {
      const result = await runWorkerAgent({
        prompt: "too long",
        mode: "explore",
        model: MODEL,
        workspace: dir,
      })

      // Empty length output still qualifies for the existing whole-run fallback,
      // but never for the new clean-stop nudge.
      expect(bodies).toHaveLength(2)
      expect(nudgeBodyCount(bodies)).toBe(0)
      expect(result.text).toStartWith("[worker exited with no output")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("shouldNudgeForEmptyOutput", () => {
  const assistant = (stopReason: string, content: Array<Record<string, unknown>>) => ({
    role: "assistant",
    stopReason,
    content,
  }) as never

  test("accepts only a clean empty assistant stop without tool calls", () => {
    expect(shouldNudgeForEmptyOutput(assistant("stop", []))).toBe(true)
    expect(shouldNudgeForEmptyOutput(assistant("stop", [{ type: "text", text: "  " }]))).toBe(true)
  })

  test.each(["toolUse", "length", "error", "aborted"])("rejects stopReason=%s", (reason) => {
    expect(shouldNudgeForEmptyOutput(assistant(reason, []))).toBe(false)
  })

  test("rejects non-empty text, tool calls, and non-assistant messages", () => {
    expect(shouldNudgeForEmptyOutput(assistant("stop", [{ type: "text", text: "answer" }]))).toBe(false)
    expect(shouldNudgeForEmptyOutput(assistant("stop", [{
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: {},
    }]))).toBe(false)
    expect(shouldNudgeForEmptyOutput({ role: "user", content: "", timestamp: 0 } as never)).toBe(false)
  })
})

test("browse terminal toolUse exits without a nudge", async () => {
  const { fetchMock, bodies } = recordingFetch(() =>
    sseToolCall("submit_answer", {
      status: "complete",
      answer: "done",
      evidence: "observed",
    }),
  )
  globalThis.fetch = fetchMock

  const dir = tmpDir("browse")
  try {
    const result = await runWorkerAgent({
      prompt: "browse",
      mode: "browse",
      model: BROWSE_DEFAULT_MODEL,
      workspace: dir,
    })

    expect(result.text).toBe("done\n\nEvidence: observed")
    expect(bodies).toHaveLength(1)
    expect(nudgeBodyCount(bodies)).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
