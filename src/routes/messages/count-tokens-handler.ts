import type { Context } from "hono"

import consola from "consola"

import { countTokens } from "~/services/copilot/create-messages"

/**
 * Passthrough handler for Anthropic token counting.
 * Forwards the request directly to Copilot's native /v1/messages/count_tokens endpoint.
 */
export async function handleCountTokens(c: Context) {
  const rawBody = await c.req.text()
  const response = await countTokens(rawBody)
  const body = await response.json()

  consola.info("Token count:", JSON.stringify(body))

  return c.json(body)
}
