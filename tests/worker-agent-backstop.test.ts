/**
 * Request-boundary backstop (engine + stream-fn). When the assembled payload
 * would overflow the model's input bound, the run must STOP before the
 * upstream call with a VISIBLE, isError diagnostic — and it must fire on BOTH
 * the chat AND the `/responses` paths (browse routes through `/responses`, so
 * a chat-only backstop would ship broken for the workload this fixes).
 *
 * Driven through the real `runWorkerAgent` + the real `transformContext` /
 * stream-fn wiring, with a tiny catalog window so any real context (system
 * prompt + tool schemas) exceeds the input bound. `globalThis.fetch` throws if
 * called — proving the backstop prevents the upstream request.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { runWorkerAgent } from "~/lib/worker-agent/engine"
import { __resetForTests as resetWorkerSemaphore } from "~/lib/worker-agent/semaphore"

// Tiny window → inputHardLimit ≈ floor(12500·0.98) − 12000 = 250 tokens, which
// any real system-prompt + tool-schema payload exceeds → the backstop fires.
function tinyWindowModel(id: string, endpoints: Array<string>) {
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
      limits: { max_context_window_tokens: 12_500 },
      supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
    },
    supported_endpoints: endpoints,
  }
}

const RESPONSES_MODEL = "gpt-5.4-mini-test" // /responses-only (the browse path)
const CHAT_MODEL = "claude-test" // /chat/completions

const originalModels = state.models
const originalToken = state.copilotToken
const originalVs = state.vsCodeVersion
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      tinyWindowModel(RESPONSES_MODEL, ["/responses", "ws:/responses"]),
      tinyWindowModel(CHAT_MODEL, ["/v1/chat/completions", "/v1/messages"]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
  }
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  // The backstop must run BEFORE any upstream call — a fetch is a test failure.
  globalThis.fetch = mock(() => {
    throw new Error("fetch must NOT be called — the backstop should prevent it")
  }) as unknown as typeof fetch
  resetWorkerSemaphore()
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalToken
  state.vsCodeVersion = originalVs
  globalThis.fetch = originalFetch
  resetWorkerSemaphore()
})

function tmpDir(): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wa-backstop-")))
}

for (const [label, model, mode] of [
  ["/responses path (browse)", RESPONSES_MODEL, "browse"],
  ["chat path (explore)", CHAT_MODEL, "explore"],
] as const) {
  test(`backstop fires on the ${label}: visible isError diagnostic, no fetch`, async () => {
    const dir = tmpDir()
    try {
      const r = await runWorkerAgent({
        prompt: "do the thing",
        mode,
        model,
        workspace: dir,
      })
      expect(r.isError).toBe(true)
      // Visible + actionable — NOT the opaque "[worker exited with no output]".
      expect(r.text.toLowerCase()).toContain("narrow")
      expect(r.text).not.toContain("exited with no output")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
