import { Hono } from "hono"

import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  return c.json({
    token: state.copilotToken,
  })
})
