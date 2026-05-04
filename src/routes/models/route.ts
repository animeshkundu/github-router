import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => {
      // Pass through every upstream field (billing, is_chat_default,
      // info_messages, model_picker_category, etc.) and overlay the
      // OpenAI-compat aliases. requestHeaders is router-internal — drop it.
      const { requestHeaders, ...rest } = model
      void requestHeaders
      return {
        ...rest,
        object: "model",
        type: model.capabilities?.type ?? "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: model.name,
      }
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
