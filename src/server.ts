import { Hono } from "hono"
import { cors } from "hono/cors"

import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { searchRoutes } from "./routes/search/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(cors())

server.get("/", (c) => c.text("Server running"))

// Claude CLI sends HEAD / as health check before each request
server.on("HEAD", ["/"], (c) => c.body(null, 200))

server.route("/chat/completions", completionRoutes)
server.route("/responses", responsesRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/search", searchRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/responses", responsesRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/search", searchRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Return Anthropic-format JSON for unknown endpoints
server.notFound((c) =>
  c.json(
    {
      type: "error",
      error: {
        type: "not_found_error",
        message: `${c.req.method} ${c.req.path} not found`,
      },
    },
    404,
  ),
)
