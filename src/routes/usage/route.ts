import { Hono } from "hono"
import consola from "consola"

import { forwardError } from "~/lib/error"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    consola.error("Error fetching Copilot usage:", error)
    return await forwardError(c, error)
  }
})
