/**
 * Endpoint-reachability guard in the worker-agent stream fn.
 *
 * The worker agent has exactly TWO clients: `/chat/completions` and
 * `/responses`. It cannot drive Copilot's native `/v1/messages`. A model whose
 * catalog `supported_endpoints` lists NEITHER of the two therefore cannot be
 * driven at all — and must fail LOCALLY with an actionable diagnostic instead
 * of being silently coerced onto the chat client and 400ing upstream with
 * `unsupported_api_for_model`.
 *
 * This is not hypothetical for the plan worker: `PLAN_DEFAULT_MODEL` is
 * `claude-opus-5`, and this repo's own translate fixtures model Claude entries
 * as `["/v1/messages"]`-only. If Copilot ever ships that shape, the coercion
 * would hide the reason the plan worker broke.
 *
 * `globalThis.fetch` throws if called — that is the assertion that carries the
 * regression: pre-fix the run reached the upstream, post-fix it never does.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model as PiModel,
} from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import {
  createCopilotStreamFn,
  type ResolvedModel,
} from "~/lib/worker-agent/stream-fn"

const MESSAGES_ONLY_MODEL_ID = "claude-opus-5-messages-only-test"

const RESOLVED: ResolvedModel = {
  modelId: MESSAGES_ONLY_MODEL_ID,
  thinking: "high",
}

const NOOP_MODEL = {
  id: MESSAGES_ONLY_MODEL_ID,
} as unknown as PiModel<"openai-completions">

const USER_CTX: Context = {
  messages: [{ role: "user", content: "plan the change", timestamp: 0 }],
}

function modelWithEndpoints(id: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "Anthropic",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
    },
    supported_endpoints: endpoints,
  } as unknown as Model
}

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalToken = state.copilotToken
const originalVs = state.vsCodeVersion

let fetchCalls = 0

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  fetchCalls = 0
  globalThis.fetch = mock(() => {
    fetchCalls += 1
    throw new Error("upstream must not be reached for an undrivable model")
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  state.copilotToken = originalToken
  state.vsCodeVersion = originalVs
})

async function drain(): Promise<{
  events: Array<AssistantMessageEvent>
  final: AssistantMessage
}> {
  const streamFn = createCopilotStreamFn({ resolved: RESOLVED })
  const stream = await streamFn(NOOP_MODEL, USER_CTX, undefined)
  const events: Array<AssistantMessageEvent> = []
  for await (const ev of stream) events.push(ev)
  return { events, final: await stream.result() }
}

test("a /v1/messages-only model fails locally instead of 400ing upstream", async () => {
  state.models = {
    object: "list",
    data: [modelWithEndpoints(MESSAGES_ONLY_MODEL_ID, ["/v1/messages"])],
  } as typeof state.models

  const { events, final } = await drain()

  // THE regression assertion: the coercion used to send this model to the chat
  // client, producing an opaque upstream failure with no local signal.
  expect(fetchCalls).toBe(0)

  // Pi StreamFn contract: `start` is always first, and a terminal `error` never
  // arrives without it. The early return added for this case bypasses BOTH
  // stream loops, so it would be the one path able to break that ordering.
  expect(events.at(0)?.type).toBe("start")
  expect(events.at(-1)?.type).toBe("error")

  expect(final.stopReason).toBe("error")
  const text = final.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
  // Actionable: names the model, what it actually serves, and what to do.
  expect(text).toContain(MESSAGES_ONLY_MODEL_ID)
  expect(text).toContain("/v1/messages")
  expect(text).toContain("/chat/completions")
  expect(text).toContain("/responses")
  expect(text.toLowerCase()).toContain("worker_defaults")
  expect(typeof final.errorMessage).toBe("string")
  expect(final.errorMessage).toContain("endpoint")
})

test("an embeddings-only model is likewise refused locally", async () => {
  state.models = {
    object: "list",
    data: [modelWithEndpoints(MESSAGES_ONLY_MODEL_ID, ["/embeddings"])],
  } as typeof state.models

  const { final } = await drain()

  expect(fetchCalls).toBe(0)
  expect(final.stopReason).toBe("error")
})

test("a model ABSENT from the catalog still defaults to the chat client", async () => {
  // "not in catalog" and "serves neither" are different answers. The unknown
  // model keeps its historical chat default (the catalog omits
  // `supported_endpoints` for chat-default models, and the proxy may run before
  // the catalog is populated) — it must NOT be swept up by the new guard.
  // The worker engine validates the model id against the catalog BEFORE ever
  // reaching this stream fn (`resolveModelAndThinking`, engine.ts:430), so an
  // unknown id here is a not-yet-populated catalog, not a user typo.
  state.models = { object: "list", data: [] } as typeof state.models

  const { final } = await drain()

  // Reached the chat client, whose fetch mock throws → terminal error, but the
  // point is that the request WAS attempted (retried once by design).
  expect(fetchCalls).toBeGreaterThan(0)
  expect(final.stopReason).toBe("error")
})

test("the /v1-prefixed chat spelling is drivable, NOT unreachable", async () => {
  // Copilot mixes prefixed and bare spellings across the catalog. Treating
  // `/v1/chat/completions` as "serves neither" would turn a working model into
  // a hard failure — the exact regression the new hard-fail could cause if
  // `pickEndpoint`'s match set were too narrow.
  state.models = {
    object: "list",
    data: [modelWithEndpoints(MESSAGES_ONLY_MODEL_ID, ["/v1/chat/completions"])],
  } as typeof state.models

  const { final } = await drain()

  expect(fetchCalls).toBeGreaterThan(0)
  expect(final.stopReason).toBe("error") // the fetch mock throws; routing is the point
})
