import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses, handleResponsesCompact } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post("/compact", async (c) => {
  try {
    return await handleResponsesCompact(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
