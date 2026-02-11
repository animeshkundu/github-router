import { Hono } from "hono"

import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  if (!state.showToken) {
    return c.json(
      { error: { message: "Token endpoint disabled", type: "error" } },
      403,
    )
  }

  return c.json({
    token: state.copilotToken,
  })
})
