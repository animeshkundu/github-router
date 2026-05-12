import { Hono } from "hono"
import { cors } from "hono/cors"

import packageJson from "../package.json" with { type: "json" }

import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { mcpRoutes } from "./routes/mcp/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { searchRoutes } from "./routes/search/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(cors())

server.get("/", (c) => c.text("Server running"))

// Build identity. Operators can `curl http://localhost:<port>/version` to
// confirm which build is serving requests — useful when upgrading via
// `npx github-router@latest` and verifying the new code actually loaded.
server.get("/version", (c) =>
  c.json({
    name: packageJson.name,
    version: packageJson.version,
    gitSha: process.env.GITHUB_SHA ?? "unknown",
  }),
)

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

// Peer-MCP endpoint: hosts gpt-5.5/gpt-5.3-codex/gemini-3.1-pro
// persona tools (codex_critic / codex_reviewer / gemini_critic) for
// the spawned Claude Code session to consult via MCP. Auth is a
// per-launch nonce stored in `state.peerMcpNonce`; the route
// rejects all requests when the nonce is unset (e.g. proxy started
// standalone via `github-router start`). See src/routes/mcp/handler.ts.
server.route("/mcp", mcpRoutes)

// Stub out Claude Code SDK telemetry so it doesn't 404-spam logs.
// Copilot doesn't expose this endpoint; clients fire it best-effort.
server.post("/api/event_logging/batch", (c) => c.body(null, 200))

// Phase E P1.4: explicit Files-API not-supported route. Claude Code's
// BriefTool upload + utils/teleport/gitBundle paths hit
// GET /v1/files/{id}/content (download), GET /v1/files (list),
// POST /v1/files (upload). Copilot has no equivalent storage backend
// (verified via cc-backup src/services/api/filesApi.ts). Without this
// explicit route, requests fall to the default 404 with a generic
// "not found" message — fine but unhelpful.
//
// Why surface explicitly: the user gets a clear signal "this feature
// isn't supported here" instead of inferring it from a generic 404.
// Fail-loud-with-explanation aligns with cc-backup mentality #10
// (errors are logged not swallowed; surface the limitation).
server.all("/v1/files/*", (c) =>
  c.json(
    {
      type: "error",
      error: {
        type: "not_found_error",
        message:
          "Files API is not supported by github-router (Copilot has no equivalent storage backend). "
          + "Use the Anthropic API directly for file uploads/downloads.",
      },
    },
    404,
  ),
)

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
