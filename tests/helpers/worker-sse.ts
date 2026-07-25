import { mock } from "bun:test"

export interface CapturedWorkerBody {
  model?: string
  tools?: Array<{ type: string; function: { name: string } }>
  reasoning_effort?: string
  messages?: Array<unknown>
}

/** Build a chat-completions SSE response terminated by [DONE]. */
export function sseResponse(chunks: Array<object>): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
    + "data: [DONE]\n\n"
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/** Model emits one text turn and stops. */
export function sseFinalText(text: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ])
}

/** Alias used by low-level Pi contract tests. */
export const sseText = sseFinalText

/** Model emits one tool call and ends the turn with tool_calls. */
export function sseToolCall(
  name: string,
  args: Record<string, unknown> = {},
): Response {
  return sseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
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

/** Record JSON request bodies while returning a caller-selected response. */
export function recordingFetch(response: () => Response): {
  fetchMock: typeof fetch
  bodies: Array<CapturedWorkerBody>
} {
  const bodies: Array<CapturedWorkerBody> = []
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      try {
        bodies.push(JSON.parse(init.body) as CapturedWorkerBody)
      } catch {
        // Non-JSON bodies are outside this helper's assertion surface.
      }
    }
    return Promise.resolve(response())
  }) as unknown as typeof fetch
  return { fetchMock, bodies }
}

/** Fetch mock for a final worker text response, optionally capturing payloads. */
export function workerSseResponse(
  text: string,
  opts: { capturePayload?: (payload: Record<string, unknown>) => void } = {},
): typeof globalThis.fetch {
  return mock(async (_url: unknown, init?: { body?: string }) => {
    if (opts.capturePayload && init?.body) {
      try {
        opts.capturePayload(JSON.parse(init.body) as Record<string, unknown>)
      } catch {
        // Ignore malformed capture input; the worker parser still sees SSE.
      }
    }
    return sseFinalText(text)
  }) as unknown as typeof globalThis.fetch
}
