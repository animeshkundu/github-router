import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { artifactToolsEnabled } from "../../src/lib/mcp-capabilities"
import { ARTIFACT_TOOLS } from "../../src/lib/artifact/tools"

type ArtifactTool = (typeof ARTIFACT_TOOLS)[number]

const ARTIFACT_ENV_KEYS = [
  "AIORDIE_BASE_URL",
  "AIORDIE_TOKEN",
  "AIORDIE_SESSION_ID",
  "AIORDIE_INSECURE_TLS",
] as const

let previousEnv: Record<(typeof ARTIFACT_ENV_KEYS)[number], string | undefined>
let originalFetch: typeof fetch

function setArtifactEnv(): void {
  process.env.AIORDIE_BASE_URL = "https://ai.example"
  process.env.AIORDIE_TOKEN = "tok-artifact"
  process.env.AIORDIE_SESSION_ID = "sess-1"
}

function clearArtifactEnv(): void {
  for (const key of ARTIFACT_ENV_KEYS) delete process.env[key]
}

function restoreArtifactEnv(): void {
  for (const key of ARTIFACT_ENV_KEYS) {
    const value = previousEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function toolByName(name: string): ArtifactTool {
  const tool = ARTIFACT_TOOLS.find((candidate) => candidate.toolNameHttp === name)
  expect(tool).toBeDefined()
  return tool!
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: Awaited<ReturnType<ArtifactTool["handler"]>>; json: unknown }> {
  const result = await toolByName(name).handler(args)
  return { result, json: JSON.parse(result.content[0]!.text) as unknown }
}

beforeEach(() => {
  previousEnv = {
    AIORDIE_BASE_URL: process.env.AIORDIE_BASE_URL,
    AIORDIE_TOKEN: process.env.AIORDIE_TOKEN,
    AIORDIE_SESSION_ID: process.env.AIORDIE_SESSION_ID,
    AIORDIE_INSECURE_TLS: process.env.AIORDIE_INSECURE_TLS,
  }
  originalFetch = globalThis.fetch
  clearArtifactEnv()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  restoreArtifactEnv()
  globalThis.fetch = originalFetch
})

describe("artifactToolsEnabled", () => {
  test("reflects the ai-or-die environment trio", () => {
    expect(artifactToolsEnabled()).toBe(false)

    process.env.AIORDIE_BASE_URL = "https://ai.example"
    process.env.AIORDIE_TOKEN = "tok-artifact"
    expect(artifactToolsEnabled()).toBe(false)

    process.env.AIORDIE_SESSION_ID = "sess-1"
    expect(artifactToolsEnabled()).toBe(true)
  })
})

describe("artifact MCP tools", () => {
  test("artifact_open posts the file and returns the review viewUrl", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      return Response.json({
        sessionId: "sess-1",
        key: "artifact-key",
        viewUrl: "https://ai.example/artifact/sess-1/artifact-key",
      })
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_open", { file: "src/App.tsx" })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      viewUrl: "https://ai.example/artifact/sess-1/artifact-key",
      sessionId: "sess-1",
      key: "artifact-key",
      next_step: "Tell the user to review at the Artifact panel, then call artifact_await to receive their feedback.",
    })
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/open",
        method: "POST",
        body: { file: "src/App.tsx" },
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("artifact_poll returns the human feedback payload", async () => {
    setArtifactEnv()
    const feedback = {
      status: "ready",
      prompts: ["Please tighten the spacing around the CTA."],
      layout_warnings: [{ severity: "warn", message: "CTA overlaps on mobile" }],
      dom_snapshot: { title: "Preview", buttons: ["Buy now"] },
      next_step: "Make the requested UI fix and reply.",
    }
    const calls: Array<{ url: string; method: string; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      return Response.json(feedback)
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    expect(json).toEqual(feedback)
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/poll",
        method: "GET",
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("artifact_end posts the end request and returns ok", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_end", {})

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      ok: true,
      next_step: "Artifact review loop ended.",
    })
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/end",
        method: "POST",
        body: undefined,
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("returns isError when the ai-or-die environment trio is missing", async () => {
    clearArtifactEnv()

    for (const name of ["artifact_open", "artifact_poll", "artifact_reply", "artifact_end", "artifact_update", "artifact_refresh", "artifact_await", "artifact_dismiss"]) {
      const { result, json } = await callTool(name, { file: "src/App.tsx", text: "done" })

      expect(result.isError).toBe(true)
      expect(json).toEqual({
        error: {
          code: "NOT_IN_AIORDIE_TAB",
          message:
            "artifact tools only work inside an ai-or-die tab-backed Claude session. Missing AIORDIE_BASE_URL, AIORDIE_TOKEN, or AIORDIE_SESSION_ID.",
        },
      })
    }
  })
})

describe("artifact_reply", () => {
  test("posts /agent-reply with the text and returns ok + response + next_step", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      // The consumer's /agent-reply returns { ok:true, reply }.
      return Response.json({ ok: true, reply: { id: "r1", text: "applied the fix" } })
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_reply", { text: "applied the fix" })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      ok: true,
      reply: { id: "r1", text: "applied the fix" },
      next_step: "Wait for further human review, or continue if the review loop is complete.",
    })
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/agent-reply",
        method: "POST",
        body: { text: "applied the fix" },
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("tolerates an empty 200 body (allowEmptyJson) and still returns ok + next_step", async () => {
    setArtifactEnv()
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_reply", { text: "done" })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      ok: true,
      next_step: "Wait for further human review, or continue if the review loop is complete.",
    })
  })
})

describe("artifact_poll tolerates the consumer's real payloads", () => {
  function pollReturning(payload: unknown): void {
    globalThis.fetch = mock(async () => Response.json(payload)) as unknown as typeof fetch
  }

  test("review_feedback with object prompts (selector/text/sourceLine/target) → returned ready", async () => {
    setArtifactEnv()
    // The exact annotation shape ai-or-die's SDK posts (buildAnnotation).
    const prompts = [
      {
        uid: "u1",
        selector: "main > h2:nth-of-type(1)",
        tag: "h2",
        text: "Proposed approach",
        prompt: "tighten this section",
        sourceLine: 12,
      },
      {
        uid: "u2",
        selector: "main > p:nth-of-type(2)",
        tag: "p",
        text: "some selected phrase",
        prompt: "reword",
        sourceLine: 20,
        target: { selector: "main > p:nth-of-type(2)", path: [0, 1], offset: 4 },
      },
    ]
    pollReturning({
      status: "review_feedback",
      prompts,
      layout_warnings: [],
      next_step: "review_feedback",
    })

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    // Prompts pass through verbatim (object annotations preserved intact).
    expect(json).toEqual({
      status: "review_feedback",
      prompts,
      layout_warnings: [],
      next_step: "review_feedback",
    })
  })

  test("review_feedback with bare-string composer prompts → returned ready, strings preserved", async () => {
    setArtifactEnv()
    // The free-text composer posts bare strings: { prompts: ["..."] }.
    pollReturning({
      status: "review_feedback",
      prompts: ["make the header bigger"],
      next_step: "review_feedback",
    })

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      status: "review_feedback",
      prompts: ["make the header bigger"],
      next_step: "review_feedback",
    })
  })

  test("ended status → returned as-is (not treated as still-waiting)", async () => {
    setArtifactEnv()
    pollReturning({ status: "ended", prompts: [], next_step: "ended" })

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      status: "ended",
      prompts: [],
      next_step: "ended",
    })
  })

  test("bare poll timeout (empty prompts) → surfaces as waiting, no error", async () => {
    setArtifactEnv()
    // Consumer's empty long-poll timeout: pollPayload(review, null, 'poll').
    pollReturning({ status: "open", prompts: [], next_step: "poll" })

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    const record = json as Record<string, unknown>
    // Classified as "no feedback yet" — the caller-facing contract, independent
    // of internal re-poll attempts.
    expect(record.status).toBe("waiting")
    expect(record.next_step).toBe("No human feedback is ready yet. Call artifact_poll again.")
  })
})

describe("artifact insecure-TLS detection", () => {
  async function tlsAppliedFor(baseUrl: string): Promise<boolean> {
    process.env.AIORDIE_BASE_URL = baseUrl
    process.env.AIORDIE_TOKEN = "tok"
    process.env.AIORDIE_SESSION_ID = "sess-1"
    let sawTls = false
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      // Under bun:test, applyInsecureTls sets init.tls; under Node it sets dispatcher.
      sawTls = Boolean((init as Record<string, unknown> | undefined)?.tls
        || (init as Record<string, unknown> | undefined)?.dispatcher)
      return Response.json({ sessionId: "sess-1", key: "k", viewUrl: "x" })
    }) as unknown as typeof fetch
    await callTool("artifact_open", { file: "p" })
    return sawTls
  }

  test("literal loopback IP https → insecure TLS applied", async () => {
    expect(await tlsAppliedFor("https://127.0.0.1:7777")).toBe(true)
    expect(await tlsAppliedFor("https://[::1]:7777")).toBe(true)
  })

  test("non-loopback https → fail closed (no bypass)", async () => {
    expect(await tlsAppliedFor("https://ai.example")).toBe(false)
  })

  test("localhost requires explicit opt-in (resolver can be remapped)", async () => {
    expect(await tlsAppliedFor("https://localhost:7777")).toBe(false)
    process.env.AIORDIE_INSECURE_TLS = "1"
    expect(await tlsAppliedFor("https://localhost:7777")).toBe(true)
  })

  test("AIORDIE_INSECURE_TLS=0 disables bypass even on loopback", async () => {
    process.env.AIORDIE_INSECURE_TLS = "0"
    expect(await tlsAppliedFor("https://127.0.0.1:7777")).toBe(false)
  })
})

describe("artifact_update", () => {
  function captureFetch(response: unknown): {
    fetchFn: typeof fetch
    calls: Array<{ url: string; method: string; body?: unknown }>
  } {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      })
      return Response.json(response)
    }) as unknown as typeof fetch
    return { fetchFn, calls }
  }

  test("posts {file} to /update and returns ok + response + next_step", async () => {
    setArtifactEnv()
    const cap = captureFetch({ ok: true, viewUrl: "https://ai.example/artifact/sess-1/v" })
    globalThis.fetch = cap.fetchFn
    const { result, json } = await callTool("artifact_update", { file: "docs/plan.html" })
    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({ ok: true, viewUrl: "https://ai.example/artifact/sess-1/v" })
    expect((json as Record<string, unknown>).next_step).toBeDefined()
    expect(cap.calls[0]).toEqual({
      url: "https://ai.example/api/artifact/sess-1/update",
      method: "POST",
      body: { file: "docs/plan.html" },
    })
  })

  test("posts {html} to /update", async () => {
    setArtifactEnv()
    const cap = captureFetch({ ok: true })
    globalThis.fetch = cap.fetchFn
    const { result } = await callTool("artifact_update", { html: "<p>hi</p>" })
    expect(result.isError).toBeUndefined()
    expect(cap.calls[0]!.body).toEqual({ html: "<p>hi</p>" })
  })

  test("neither file nor html -> INVALID_ARGUMENT isError, no request made", async () => {
    setArtifactEnv()
    let fetched = false
    globalThis.fetch = mock(async () => {
      fetched = true
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_update", {})
    expect(result.isError).toBe(true)
    expect((json as { error?: { code?: string } }).error?.code).toBe("INVALID_ARGUMENT")
    expect(fetched).toBe(false)
  })

  test("both file and html -> INVALID_ARGUMENT isError, no request made", async () => {
    setArtifactEnv()
    let fetched = false
    globalThis.fetch = mock(async () => {
      fetched = true
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_update", { file: "a.html", html: "<p>x</p>" })
    expect(result.isError).toBe(true)
    expect((json as { error?: { code?: string } }).error?.code).toBe("INVALID_ARGUMENT")
    expect(fetched).toBe(false)
  })

  test("server INVALID_REQUEST (html without existing review) surfaces as isError", async () => {
    setArtifactEnv()
    globalThis.fetch = mock(async () =>
      Response.json({ error: { code: "INVALID_REQUEST", message: "no open review" } }, { status: 400 })) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_update", { html: "<p>x</p>" })
    expect(result.isError).toBe(true)
    expect((json as { error?: { code?: string } }).error?.code).toBe("INVALID_REQUEST")
  })
})

describe("artifact_refresh / artifact_dismiss", () => {
  test("artifact_refresh posts /refresh and returns ok", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method ?? "GET" })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_refresh", {})
    expect(result.isError).toBeUndefined()
    expect((json as Record<string, unknown>).ok).toBe(true)
    expect(calls[0]).toEqual({ url: "https://ai.example/api/artifact/sess-1/refresh", method: "POST" })
  })

  test("artifact_dismiss posts /dismiss and returns ok (review stays alive)", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method ?? "GET" })
      return Response.json({ ok: true, status: "open", visibility: "dismissed" })
    }) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_dismiss", {})
    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({ ok: true, status: "open", visibility: "dismissed" })
    expect(calls[0]).toEqual({ url: "https://ai.example/api/artifact/sess-1/dismiss", method: "POST" })
  })
})

describe("artifact_await (typed drain)", () => {
  function awaitReturning(payload: unknown): Array<{ url: string; method: string }> {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method ?? "GET" })
      return Response.json(payload)
    }) as unknown as typeof fetch
    return calls
  }

  test("returns typed events + cursor and threads cursor/timeoutMs to /await", async () => {
    setArtifactEnv()
    const events = [
      { kind: "action", id: "5", action: "approve", elementId: "plan-step-1", value: "true" },
      { kind: "comment", id: "6", prompt: "reword", text: "some text", selector: "main > p", sourceLine: 9 },
    ]
    const calls = awaitReturning({ events, status: "open", cursor: "6" })
    const { result, json } = await callTool("artifact_await", { cursor: "4", timeoutMs: 8000 })
    expect(result.isError).toBeUndefined()
    const record = json as Record<string, unknown>
    expect(record.events).toEqual(events)
    expect(record.cursor).toBe("6")
    expect(record.status).toBe("open")
    expect(record.next_step).toBeDefined()
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url).toContain("/await?")
    expect(calls[0]!.url).toContain("cursor=4")
    expect(calls[0]!.url).toContain("timeoutMs=8000")
  })

  test("empty events -> a keep-awaiting next_step", async () => {
    setArtifactEnv()
    awaitReturning({ events: [], status: "open", cursor: "4" })
    const { result, json } = await callTool("artifact_await", {})
    expect(result.isError).toBeUndefined()
    const record = json as Record<string, unknown>
    expect(record.events).toEqual([])
    expect(String(record.next_step)).toContain("artifact_await")
  })

  test("ended status -> an ended next_step", async () => {
    setArtifactEnv()
    awaitReturning({ events: [{ kind: "ended", id: "9" }], status: "ended", cursor: "9" })
    const { result, json } = await callTool("artifact_await", { cursor: "8" })
    expect(result.isError).toBeUndefined()
    expect(String((json as Record<string, unknown>).next_step).toLowerCase()).toContain("ended")
  })

  test("unknown event kinds are passed through, not rejected", async () => {
    setArtifactEnv()
    const events = [{ kind: "future_kind_v3", id: "10", blob: { x: 1 } }]
    awaitReturning({ events, status: "open", cursor: "10" })
    const { result, json } = await callTool("artifact_await", {})
    expect(result.isError).toBeUndefined()
    expect((json as Record<string, unknown>).events).toEqual(events)
  })
})

describe("artifact_await degraded-payload tolerance", () => {
  test("a server payload with no status does not crash the tool", async () => {
    setArtifactEnv()
    // Older/degraded /await returns events without a status field.
    globalThis.fetch = mock(async () =>
      Response.json({ events: [{ kind: "comment", id: "1", prompt: "x", text: "", selector: "" }], cursor: "1" })) as unknown as typeof fetch
    const { result, json } = await callTool("artifact_await", {})
    expect(result.isError).toBeUndefined()
    const record = json as Record<string, unknown>
    expect(record.cursor).toBe("1")
    expect(record.next_step).toBeDefined()
    // status omitted (undefined dropped by definedObject), no throw.
    expect(record.status).toBeUndefined()
  })
})
