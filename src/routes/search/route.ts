import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { searchWeb } from "~/services/copilot/web-search"

export const searchRoutes = new Hono()

searchRoutes.post("/", async (c) => {
  try {
    const { query } = await c.req.json<{ query: string }>()

    if (!query || typeof query !== "string") {
      return c.json(
        { error: { message: "Missing required field: query" } },
        400,
      )
    }

    const results = await searchWeb(query)
    return c.json({ results })
  } catch (error) {
    return await forwardError(c, error)
  }
})
