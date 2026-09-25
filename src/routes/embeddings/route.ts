import { Hono } from "hono"

import { extractAndRecordAic } from "~/lib/aic-ledger"
import { forwardError } from "~/lib/error"
import { resolveModel } from "~/lib/utils"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(payload)
    // Defensive: record only when upstream attaches `copilot_usage`
    // (no-op otherwise). Embeddings are presumed unbilled today; this
    // future-proofs the session total if Copilot ever bills them.
    extractAndRecordAic(resolveModel(payload.model), response)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
