import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleMcpDelete, handleMcpPost } from "./handler"

export const mcpRoutes = new Hono()

mcpRoutes.post("/", async (c) => {
  try {
    return await handleMcpPost(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

mcpRoutes.delete("/", (c) => {
  try {
    return handleMcpDelete(c)
  } catch {
    return c.body(null, 500)
  }
})
