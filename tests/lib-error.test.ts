import { test, expect } from "bun:test"
import { Hono } from "hono"

import { HTTPError, forwardError } from "../src/lib/error"

test("forwardError uses top-level message from HTTPError JSON payload", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json({ message: "Top-level error" }, { status: 400 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: { type: "invalid_request_error", message: "Top-level error" },
  })
})

test("forwardError falls back to nested error message", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json({ error: { message: "Nested error" } }, { status: 422 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(422)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: { type: "api_error", message: "Nested error" },
  })
})

test("forwardError keeps raw text for HTTPError without JSON", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError("Failed", new Response("plain error", { status: 409 })),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: { type: "api_error", message: "plain error" },
  })
})

test("forwardError returns 500 for non-HTTP errors", async () => {
  const app = new Hono()
  app.get("/", (c) => forwardError(c, new Error("boom")))

  const response = await app.request("/")
  expect(response.status).toBe(500)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: { type: "api_error", message: "boom" },
  })
})

test("forwardError passes through Anthropic-format error from upstream", async () => {
  const app = new Hono()
  const upstreamError = {
    type: "error",
    error: { type: "invalid_request_error", message: "scope is not allowed" },
  }
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json(upstreamError, { status: 400 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual(upstreamError)
})
