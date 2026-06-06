import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleMcpDelete, handleMcpPost } from "./handler"

export const mcpRoutes = new Hono()

// Unscoped union — full tool surface, retained for BYO `start` / `codex`
// clients that point a single MCP server at `/mcp`.
mcpRoutes.post("/", async (c) => {
  try {
    return await handleMcpPost(c, "all")
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Scoped endpoints — `/mcp/<group>` serves ONLY that group's tools. The
// `claude` subcommand registers one `mcpServers` entry per group pointing
// here so the model sees `mcp__<group>__<tool>`. The raw `:group` is passed
// through; `handleMcpPost` validates it AFTER auth (so an unauthenticated
// probe can't enumerate valid groups) and returns 404 for an unknown one.
mcpRoutes.post("/:group", async (c) => {
  try {
    return await handleMcpPost(c, c.req.param("group"))
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

// `handleMcpDelete` is session-teardown only (scope-agnostic); accept the
// `/mcp/<group>` form so a client that opened on a scoped URL can DELETE
// the same path. Unknown group is harmless here (no-op teardown), so we
// don't bother validating it.
mcpRoutes.delete("/:group", (c) => {
  try {
    return handleMcpDelete(c)
  } catch {
    return c.body(null, 500)
  }
})
