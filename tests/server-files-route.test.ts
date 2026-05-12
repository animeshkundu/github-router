import { test, expect, describe } from "bun:test"

import { server } from "../src/server"

describe("/v1/files/* explicit unsupported route (Phase E P1.4)", () => {
  // Files API is not supportable through Copilot — verified via
  // cc-backup/src/services/api/filesApi.ts (uses Anthropic-side
  // storage that has no Copilot equivalent). The proxy responds with
  // an explicit Anthropic-format error so users see the limitation
  // surfaced clearly instead of inferring it from a generic 404.

  const expectAnthropicError = (
    body: unknown,
  ): { type: string; error: { type: string; message: string } } => {
    const b = body as { type?: string; error?: { type?: string; message?: string } }
    expect(b.type).toBe("error")
    expect(b.error?.type).toBe("not_found_error")
    expect(b.error?.message).toContain("Files API")
    expect(b.error?.message).toContain("Copilot")
    return b as ReturnType<typeof expectAnthropicError>
  }

  test("GET /v1/files/<id>/content returns 404 with Files-API-not-supported message", async () => {
    const res = await server.request("/v1/files/file_01abc/content", {
      method: "GET",
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as unknown
    expectAnthropicError(body)
  })

  test("GET /v1/files/ (trailing slash, list endpoint shape) returns Files-API 404", async () => {
    // Hono's /v1/files/* wildcard matches the trailing-slash form
    // (empty segment after /). Covers the "list files" endpoint shape
    // Claude Code uses for session-file query.
    const res = await server.request("/v1/files/", { method: "GET" })
    expect(res.status).toBe(404)
    const body = (await res.json()) as unknown
    expectAnthropicError(body)
  })

  test("GET /v1/files (no trailing slash, bare path) — falls through to generic notFound", async () => {
    // Hono's /v1/files/* requires at least the / after files. The bare
    // /v1/files form (no trailing slash) doesn't match the wildcard
    // and falls to server.notFound. Document this gap so a future
    // contributor can decide whether to extend coverage by adding a
    // separate /v1/files exact-match route. Today: both forms 404,
    // just with different messages. The bare form gets the generic
    // "<METHOD> /v1/files not found" — still informative.
    const res = await server.request("/v1/files", { method: "GET" })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("not_found_error")
    // Either path produces a 404 — only the Files-specific one
    // mentions "Files API" / "Copilot".
    if (body.error.message.includes("Files API")) {
      // Wildcard caught it (Hono trailing-slash semantics matched);
      // perfectly fine.
      expect(body.error.message).toContain("Copilot")
    } else {
      // Generic notFound caught it — message includes the path.
      expect(body.error.message).toContain("/v1/files")
    }
  })

  test("POST /v1/files/upload returns 404 with explanatory message", async () => {
    const res = await server.request("/v1/files/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "data" }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as unknown
    expectAnthropicError(body)
  })

  test("DELETE /v1/files/<id> returns 404 with explanatory message", async () => {
    const res = await server.request("/v1/files/file_01abc", {
      method: "DELETE",
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as unknown
    expectAnthropicError(body)
  })

  test("error message points users at the Anthropic API directly (UX guidance)", async () => {
    const res = await server.request("/v1/files/anything", { method: "GET" })
    const body = (await res.json()) as { error: { message: string } }
    // Substring check — the message should tell users WHERE to go.
    expect(body.error.message).toContain("Anthropic API")
  })

  test("non-files route still 404s via the generic notFound (regression guard)", async () => {
    // Sanity: the /v1/files/* wildcard doesn't accidentally swallow
    // other endpoints. /v1/messages (a real route) wouldn't match this
    // test (it has its own handler), so we use a definitely-unknown path.
    const res = await server.request("/v1/some-other-endpoint/x", {
      method: "GET",
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("not_found_error")
    // The generic 404 mentions the path; the Files-specific 404 mentions
    // "Files API" / "Copilot". Distinguish them.
    expect(body.error.message).not.toContain("Files API")
    expect(body.error.message).toContain("/v1/some-other-endpoint/x")
  })
})
