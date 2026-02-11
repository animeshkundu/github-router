import { test, expect, mock } from "bun:test"

import { state } from "../src/lib/state"
import { searchWeb } from "../src/services/copilot/web-search"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((url: string) => {
  if (url.endsWith("/github/chat/threads")) {
    return {
      ok: true,
      json: () => ({ thread_id: "thread-123" }),
    }
  }

  return {
    ok: true,
    json: () => ({ message: { content: "result" } }),
  }
})
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("searchWeb handles missing references", async () => {
  const result = await searchWeb("query")
  expect(result.content).toBe("result")
  expect(result.references).toEqual([])
})
