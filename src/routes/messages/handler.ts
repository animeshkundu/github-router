import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createMessages } from "~/services/copilot/create-messages"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const rawBody = await c.req.text()

  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug("Anthropic request body:", rawBody.slice(0, 2000))
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createMessages(rawBody)

  const contentType = response.headers.get("content-type") ?? ""

  // Streaming: pipe the upstream SSE response body directly
  if (contentType.includes("text/event-stream")) {
    if (debugEnabled) {
      consola.debug("Streaming response from Copilot /v1/messages")
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  // Non-streaming: forward JSON response
  const body = await response.json()
  if (debugEnabled) {
    consola.debug(
      "Non-streaming response from Copilot /v1/messages:",
      JSON.stringify(body).slice(0, 2000),
    )
  }
  return c.json(body, response.status as 200)
}
