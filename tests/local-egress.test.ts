// Endpoint configuration for the `-m local` / `-m local2` launch profiles.
//
// The profiles deliberately know ONE fact about the endpoint: its base URL.
// These tests pin the resolution order (`--localurl` > `--localport` >
// `GH_ROUTER_LOCAL_BASE_URL` > `GH_ROUTER_LOCAL_PORT` > the documented
// default), the validation that turns a typo into a launch error instead of a
// connection error three seconds later, and the session-id fallback.

import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  LOCAL_DEFAULT_BASE_URL,
  configureLocalEgress,
  localBaseUrl,
  localSessionId,
} from "~/lib/local-egress"
import { state } from "~/lib/state"

beforeEach(() => {
  // The override is module-level (one launch per process). Clear it so tests
  // never inherit a previous case's endpoint.
  configureLocalEgress({})
  delete process.env.GH_ROUTER_LOCAL_BASE_URL
  delete process.env.GH_ROUTER_LOCAL_PORT
})

describe("localBaseUrl", () => {
  test("defaults to the measured https endpoint on port 11111", () => {
    expect(localBaseUrl({})).toBe("https://localhost:11111/v1")
    expect(LOCAL_DEFAULT_BASE_URL).toBe("https://localhost:11111/v1")
  })

  test("GH_ROUTER_LOCAL_BASE_URL is used verbatim (trailing slashes trimmed)", () => {
    expect(
      localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "http://localhost:11111/v1/" }),
    ).toBe("http://localhost:11111/v1")
  })

  test("a bare origin gains the /v1 prefix", () => {
    expect(localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "http://localhost:11111" }))
      .toBe("http://localhost:11111/v1")
  })

  test("a path and its case survive normalization", () => {
    expect(localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "http://LocalHost:1234/V1/" }))
      .toBe("http://localhost:1234/V1")
  })

  test("GH_ROUTER_LOCAL_PORT replaces only the port of the base URL", () => {
    expect(
      localBaseUrl({
        GH_ROUTER_LOCAL_BASE_URL: "http://localhost:11111/v1",
        GH_ROUTER_LOCAL_PORT: "9999",
      }),
    ).toBe("http://localhost:9999/v1")
  })

  test("a non-http scheme is a launch error, not a silent accept", () => {
    expect(() =>
      localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "ftp://localhost/v1" }),
    ).toThrow(/http\(s\)/)
  })

  test("a non-integer env port is a launch error", () => {
    expect(() => localBaseUrl({ GH_ROUTER_LOCAL_PORT: "abc" })).toThrow(/integer/)
    expect(() => localBaseUrl({ GH_ROUTER_LOCAL_PORT: "70000" })).toThrow(/65535/)
  })
})

describe("configureLocalEgress", () => {
  test("--localurl wins over every env layer", () => {
    configureLocalEgress({ baseUrl: "http://localhost:11111/v1" })
    expect(
      localBaseUrl({
        GH_ROUTER_LOCAL_BASE_URL: "https://elsewhere:1/v1",
        GH_ROUTER_LOCAL_PORT: "2",
      }),
    ).toBe("http://localhost:11111/v1")
  })

  test("--localport replaces the port and keeps the default scheme", () => {
    configureLocalEgress({ port: "11111" })
    expect(localBaseUrl({})).toBe("https://localhost:11111/v1")
  })

  test("--localport wins over GH_ROUTER_LOCAL_PORT", () => {
    configureLocalEgress({ port: 11111 })
    expect(localBaseUrl({ GH_ROUTER_LOCAL_PORT: "9999" })).toBe(
      "https://localhost:11111/v1",
    )
  })

  test("passing both spellings is a launch error, not silent precedence", () => {
    expect(() =>
      configureLocalEgress({
        baseUrl: "http://localhost:11111/v1",
        port: "11111",
      }),
    ).toThrow(/cannot be combined/)
  })

  test("invalid --localport values fail the launch", () => {
    expect(() => configureLocalEgress({ port: "0" })).toThrow(/between 1 and 65535/)
    expect(() => configureLocalEgress({ port: "70000" })).toThrow(/between 1 and 65535/)
    expect(() => configureLocalEgress({ port: "abc" })).toThrow(/integer/)
  })

  test("a valueless --localurl or --localport is a launch error, not the default", () => {
    // citty reports a flag given without a value as `""`, and `typeof ""` is
    // "string", so the call sites DO pass it. Treating emptiness as "absent"
    // silently sent the launch at https://localhost:11111/v1 with no
    // diagnostic at all.
    expect(() => configureLocalEgress({ baseUrl: "", profileId: "local" })).toThrow(
      /must not be empty/,
    )
    expect(() => configureLocalEgress({ port: "", profileId: "local" })).toThrow(
      /integer port/,
    )
  })

  test("a non-local profile is inert, not fatal", () => {
    // The flags are parsed by every launch; on a non-local profile they are
    // documented as inert. That has to hold for an unparsable value too:
    // "ignoring" followed by a launch failure is not inert.
    expect(() =>
      configureLocalEgress({ port: "11111", profileId: "cheapest2" }),
    ).not.toThrow()
    expect(() =>
      configureLocalEgress({ port: "abc", profileId: "cheapest2" }),
    ).not.toThrow()
    expect(() =>
      configureLocalEgress({ baseUrl: "not a url", profileId: "balanced" }),
    ).not.toThrow()
  })

  test("an inert non-local override is discarded, not stored", () => {
    configureLocalEgress({ port: "11111", profileId: "cheapest2" })
    // Nothing was stored, so the next local resolution is the default.
    expect(localBaseUrl({})).toBe(LOCAL_DEFAULT_BASE_URL)
  })

  test("a base URL query or fragment fails the launch", () => {
    // The egress concatenates `<base>/messages`, so a query does not survive
    // as one: `?x=1` becomes `x=1/messages` and the session 404s.
    expect(() =>
      configureLocalEgress({ baseUrl: "http://localhost:11111/v1?x=1" }),
    ).toThrow(/query or fragment/)
    expect(() =>
      configureLocalEgress({ baseUrl: "http://localhost:11111/v1#frag" }),
    ).toThrow(/query or fragment/)
    expect(() =>
      localBaseUrl({ GH_ROUTER_LOCAL_BASE_URL: "http://localhost:11111/v1?x=1" }),
    ).toThrow(/query or fragment/)
  })

  test("clearing restores the default", () => {
    configureLocalEgress({ baseUrl: "http://localhost:11111/v1" })
    configureLocalEgress({})
    expect(localBaseUrl({})).toBe("https://localhost:11111/v1")
  })
})

describe("localSessionId", () => {
  const app = new Hono()
  app.get("/", (c) => c.text(localSessionId(c)))

  test("the client's own x-claude-code-session-id always wins", async () => {
    const res = await app.request("/", {
      headers: { "x-claude-code-session-id": "  conversation-abc  " },
    })
    expect(await res.text()).toBe("conversation-abc")
  })

  test("a missing header falls back to the process session id", async () => {
    const res = await app.request("/")
    expect(await res.text()).toBe(state.sessionId)
  })

  test("a blank header falls back too (never synthesize a fresh id)", async () => {
    const res = await app.request("/", {
      headers: { "x-claude-code-session-id": "   " },
    })
    expect(await res.text()).toBe(state.sessionId)
  })
})
