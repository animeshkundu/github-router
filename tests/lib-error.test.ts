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

test("forwardError remaps 413 with non-overflow body to 400 prompt-too-long", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json({ error: { message: "too large" } }, { status: 413 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  const json = (await response.json()) as {
    type: string
    error: { type: string; message: string }
  }
  expect(json.type).toBe("error")
  expect(json.error.type).toBe("invalid_request_error")
  expect(json.error.message).toContain("prompt is too long")
  expect(json.error.message).toContain("too large")
})

test("forwardError remaps 400 containing context_length_exceeded substring", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json(
          {
            error: {
              code: "context_length_exceeded",
              message: "your prompt exceeded the limit",
            },
          },
          { status: 400 },
        ),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  const json = (await response.json()) as {
    type: string
    error: { type: string; message: string }
  }
  expect(json.error.type).toBe("invalid_request_error")
  expect(json.error.message).toContain("prompt is too long")
})

test("forwardError does NOT remap 400 'model not found' (regression discriminator)", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json(
          { error: { message: "model not found" } },
          { status: 400 },
        ),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  const json = (await response.json()) as {
    type: string
    error: { type: string; message: string }
  }
  expect(json.error.type).toBe("invalid_request_error")
  expect(json.error.message).toBe("model not found")
  expect(json.error.message).not.toContain("prompt is too long")
})

test("forwardError remaps 413 with non-JSON body using sensible message", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        new Response("Request Entity Too Large", { status: 413 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  const json = (await response.json()) as {
    type: string
    error: { type: string; message: string }
  }
  expect(json.error.type).toBe("invalid_request_error")
  expect(json.error.message).toContain("prompt is too long")
  expect(json.error.message).toContain("Request Entity Too Large")
})
