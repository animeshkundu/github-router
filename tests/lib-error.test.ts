import { test, expect } from "bun:test"
import { Hono } from "hono"

import { HTTPError, forwardError } from "../src/lib/error"
import { TransportExhaustionError } from "../src/lib/upstream-retry"

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

// A transport exhaustion must NOT be reported as an overload. `overloaded_error`
// is the type Claude Code retries hardest against, and by the time this error
// exists the proxy has already spent its own retry budget on a transport that
// failed — so labelling it an overload multiplies a (potentially multi-megabyte)
// request instead of surfacing the failure.
test("forwardError maps exhausted transient transport errors to api_error 502, never overloaded_error", async () => {
  const cause = Object.assign(new Error("socket reset"), {
    code: "ECONNRESET",
  })
  const transportError = new TransportExhaustionError(
    {
      endpoint: "/v1/messages",
      label: "/v1/messages",
      attempts: 3,
      classification: "transient",
      lastError: {
        name: "TypeError",
        message: `fetch failed Bearer ${"x".repeat(24)} request body: {"prompt":"secret-body"}`,
        causeCode: "ECONNRESET",
      },
    },
    new TypeError("fetch failed", { cause }),
  )
  const app = new Hono()
  app.get("/", (c) => forwardError(c, transportError))

  const response = await app.request("/")
  expect(response.status).toBe(502)
  const json = (await response.json()) as {
    error: { type: string; message: string }
  }
  expect(json.error.type).toBe("api_error")
  expect(json.error.type).not.toBe("overloaded_error")
  // The diagnostic is what made this failure explicable at all; keep it.
  expect(json.error.message).toContain("/v1/messages")
  expect(json.error.message).toContain("3 attempts")
  expect(json.error.message).toContain("ECONNRESET")
  expect(json.error.message).toContain("[REDACTED]")
  expect(json.error.message).not.toContain("Bearer x")
  expect(json.error.message).not.toContain("secret-body")
})

test("forwardError maps deterministic connectivity failures to actionable 502", async () => {
  const transportError = new TransportExhaustionError(
    {
      endpoint: "https://api.invalid",
      attempts: 1,
      classification: "deterministic",
      lastError: {
        name: "TypeError",
        message: "fetch failed",
        causeCode: "ENOTFOUND",
      },
    },
    Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
  )
  const app = new Hono()
  app.get("/", (c) => forwardError(c, transportError))

  const response = await app.request("/")
  expect(response.status).toBe(502)
  const json = (await response.json()) as {
    error: { type: string; message: string }
  }
  expect(json.error.type).toBe("api_error")
  expect(json.error.message).toContain("Check DNS, proxy, firewall, and TLS")
  expect(json.error.message).toContain("ENOTFOUND")
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

test("forwardError remaps Copilot's exact context-window wording", async () => {
  const app = new Hono()
  const message =
    "Your input exceeds the context window of this model. Please adjust your input and try again."
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json(
          { error: { message, code: "invalid_request_body" } },
          { status: 400 },
        ),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `capability_rejected: prompt_too_long (prompt is too long: ${message})`,
    },
  })
})

/**
 * Both halves of the envelope are load-bearing, and each is matched
 * independently by the client: verified in the installed Claude Code bundle as
 * `IZ(e) = JBn(e.message) || wd(e.message, "prompt_too_long")` — the wording
 * matcher OR the capability token. These assertions replicate both matchers so
 * a future reword of our message cannot silently break recovery.
 */
test("overflow envelope satisfies BOTH client matchers independently", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json(
          { error: { message: "Your input exceeds the context window of this model." } },
          { status: 400 },
        ),
      ),
    ),
  )

  const json = (await (await app.request("/")).json()) as {
    error: { message: string }
  }
  const message = json.error.message

  // Client matcher 1 (`JBn`): lowercased substring on the wording.
  expect(message.toLowerCase().includes("prompt is too long")).toBe(true)

  // Client matcher 2 (`wd`): the token, followed by a character that is NOT
  // in [A-Za-z0-9_:.-] (its right-boundary check), so the class cannot be read
  // as a longer identifier.
  const token = "capability_rejected: prompt_too_long"
  const at = message.indexOf(token)
  expect(at).toBeGreaterThanOrEqual(0)
  const next = message[at + token.length]
  expect(next !== undefined && /[A-Za-z0-9_:.-]/.test(next)).toBe(false)
})

test("max_tokens overflow classifies as its own class, not prompt_too_long", async () => {
  const app = new Hono()
  const message =
    "input length and `max_tokens` exceed context limit: 900000 + 128000 > 1000000"
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError("Failed", Response.json({ error: { message } }, { status: 400 })),
    ),
  )

  const json = (await (await app.request("/")).json()) as {
    error: { message: string }
  }
  expect(json.error.message).toContain(
    "capability_rejected: max_tokens_context_overflow",
  )
  expect(json.error.message).not.toContain("prompt_too_long")
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

// ============================================================
// no-401 invariant — Claude Code's reactive refresh path (function
// `SZ1` in v2.1.140 binary) fires on any 401 from upstream and
// attempts to refresh the OAuth token. Spawned-via-proxy sessions
// use a synthetic credential (ensureClaudeConfigMirror's
// SYNTHETIC_CREDENTIAL); refreshing it would fail and degrade the
// session. forwardError remaps upstream 401 → 503 to maintain the
// invariant on the Anthropic-shape boundary.
// ============================================================

test("forwardError remaps upstream 401 to 503 (no-401 invariant)", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Failed",
        Response.json({ message: "Bearer rejected by Copilot" }, { status: 401 }),
      ),
    ),
  )

  const response = await app.request("/")
  // CRITICAL: status MUST NOT be 401 (would trigger Claude Code's
  // reactive refresh of our synthetic OAuth token, which would fail
  // and degrade the session).
  expect(response.status).toBe(503)
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: { type: "overloaded_error", message: "Bearer rejected by Copilot" },
  })
})

test("forwardError remaps upstream 401 with Anthropic-format body to 503 (still no-401 even when forwarding upstream shape)", async () => {
  // Even when upstream returns a properly Anthropic-shaped error JSON,
  // we must still map status 401 → 503 to prevent the refresh path.
  // The body is forwarded as-is (preserving the original error type),
  // but the HTTP status changes.
  const app = new Hono()
  const upstreamBody = {
    type: "error",
    error: { type: "authentication_error", message: "invalid x-api-key" },
  }
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError("Failed", Response.json(upstreamBody, { status: 401 })),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(503)
  // Body still forwarded unchanged (just status remapped)
  await expect(response.json()).resolves.toEqual(upstreamBody)
})

test("forwardError preserves non-401 statuses (only 401 is remapped)", async () => {
  // Sanity: the remap is targeted, not a blanket rewrite.
  for (const status of [400, 403, 404, 429, 500, 502, 504]) {
    const app = new Hono()
    app.get("/", (c) =>
      forwardError(
        c,
        new HTTPError("Failed", Response.json({ message: "x" }, { status })),
      ),
    )
    const response = await app.request("/")
    expect(response.status).toBe(status)
  }
})
