import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  AUTH_REMEDY,
  WORKIQ_REFRESH_SKEW_MS,
  WorkiqAuthError,
  buildWorkiqAuthorizeUrl,
  ensureWorkiqToken,
  readWorkiqTokenFile,
  refreshWorkiqAccessToken,
  resetWorkiqTokenStateForTesting,
  runLoopbackAuth,
  workiqTokenPath,
  writeWorkiqTokenFile,
  type WorkiqTokenFile,
} from "../src/lib/workiq/token"
import {
  WORKIQ_DEFAULT_TENANT,
  WORKIQ_PUBLIC_CLIENT_ID,
  WORKIQ_SCOPE,
  WORKIQ_TOKEN_ENV,
  WORKIQ_TOKEN_PATH_ENV,
} from "../src/lib/workiq/constants"

// The token endpoint is mocked; the loopback listener is real, because the
// dual-stack bind and the state check are exactly the parts a mock would not
// exercise. Nothing here contacts login.microsoftonline.com.

const originalFetch = globalThis.fetch
const originalToken = process.env[WORKIQ_TOKEN_ENV]
const originalTokenPath = process.env[WORKIQ_TOKEN_PATH_ENV]
const originalTenant = process.env.GH_ROUTER_WORKIQ_TENANT

let tmpDir: string
let tokenPath: string

interface TokenCall {
  url: string
  form: Record<string, string>
}

function fakeIdToken(account: string): string {
  const payload = Buffer.from(JSON.stringify({ preferred_username: account })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

function tokenSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: "synthetic-access-1",
      refresh_token: "synthetic-refresh-1",
      expires_in: 3600,
      id_token: fakeIdToken("ana@contoso.example"),
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function tokenFailure(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Install a token-endpoint mock. Loopback requests pass through to the real
 * fetch so `runLoopbackAuth` can be driven by actually hitting its listener.
 */
function mockTokenEndpoint(
  handler: (form: Record<string, string>, callIndex: number) => Response | Promise<Response>,
): Array<TokenCall> {
  const calls: Array<TokenCall> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("http://localhost:")) {
      return originalFetch(input as string, init)
    }
    if (!url.startsWith("https://login.microsoftonline.com/")) {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
    calls.push({ url, form })
    return handler(form, calls.length)
  }) as typeof fetch
  return calls
}

function tokenFile(overrides: Partial<WorkiqTokenFile> = {}): WorkiqTokenFile {
  return {
    version: 1,
    clientId: WORKIQ_PUBLIC_CLIENT_ID,
    tenant: WORKIQ_DEFAULT_TENANT,
    scope: WORKIQ_SCOPE,
    accessToken: "synthetic-access-existing",
    refreshToken: "synthetic-refresh-existing",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    ...overrides,
  }
}

interface CapturedAuthorizeUrl {
  url: Promise<URL>
  onAuthorizeUrl: (url: string) => void
}

function captureAuthorizeUrl(): CapturedAuthorizeUrl {
  let resolve!: (url: URL) => void
  const url = new Promise<URL>((r) => {
    resolve = r
  })
  return { url, onAuthorizeUrl: (value) => resolve(new URL(value)) }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workiq-token-"))
  tokenPath = path.join(tmpDir, "workiq-token.json")
  process.env[WORKIQ_TOKEN_PATH_ENV] = tokenPath
  delete process.env[WORKIQ_TOKEN_ENV]
  delete process.env.GH_ROUTER_WORKIQ_TENANT
  resetWorkiqTokenStateForTesting()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetWorkiqTokenStateForTesting()
  if (originalToken === undefined) delete process.env[WORKIQ_TOKEN_ENV]
  else process.env[WORKIQ_TOKEN_ENV] = originalToken
  if (originalTokenPath === undefined) delete process.env[WORKIQ_TOKEN_PATH_ENV]
  else process.env[WORKIQ_TOKEN_PATH_ENV] = originalTokenPath
  if (originalTenant === undefined) delete process.env.GH_ROUTER_WORKIQ_TENANT
  else process.env.GH_ROUTER_WORKIQ_TENANT = originalTenant
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe("buildWorkiqAuthorizeUrl", () => {
  test("carries the public client, PKCE challenge, loopback redirect and scope", () => {
    const url = new URL(
      buildWorkiqAuthorizeUrl({
        tenant: "contoso.example",
        redirectUri: "http://localhost:49152/",
        codeChallenge: "challenge-value",
        state: "state-value",
      }),
    )

    expect(url.origin).toBe("https://login.microsoftonline.com")
    expect(url.pathname).toBe("/contoso.example/oauth2/v2.0/authorize")
    expect(url.searchParams.get("client_id")).toBe(WORKIQ_PUBLIC_CLIENT_ID)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:49152/")
    expect(url.searchParams.get("scope")).toBe(WORKIQ_SCOPE)
    expect(url.searchParams.get("scope")).toContain("offline_access")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("state-value")
    expect(url.searchParams.get("login_hint")).toBeNull()
  })

  test("adds login_hint only when one was asked for", () => {
    const url = new URL(
      buildWorkiqAuthorizeUrl({
        tenant: WORKIQ_DEFAULT_TENANT,
        redirectUri: "http://localhost:1/",
        codeChallenge: "c",
        state: "s",
        loginHint: "ana@contoso.example",
      }),
    )
    expect(url.searchParams.get("login_hint")).toBe("ana@contoso.example")
  })
})

describe("runLoopbackAuth", () => {
  test("a mismatched state is refused without settling the sign-in", async () => {
    const calls = mockTokenEndpoint(() => tokenSuccess())
    const captured = captureAuthorizeUrl()

    let settled = false
    const auth = runLoopbackAuth({
      onAuthorizeUrl: captured.onAuthorizeUrl,
      openBrowser: () => {},
      timeoutMs: 10_000,
    })
    auth.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    const authorizeUrl = await captured.url
    const redirect = authorizeUrl.searchParams.get("redirect_uri")!
    const state = authorizeUrl.searchParams.get("state")!

    const bad = await originalFetch(`${redirect}?code=abc&state=not-the-state`)
    expect(bad.status).toBe(400)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    expect(calls).toEqual([])

    // The real redirect still completes the flow, proving the wrong-state
    // request did not consume or poison it.
    const good = await originalFetch(`${redirect}?code=abc&state=${state}`)
    expect(good.status).toBe(200)
    await auth
    expect(calls.length).toBe(1)
  })

  test("an error redirect is surfaced verbatim, with the upstream code kept", async () => {
    mockTokenEndpoint(() => tokenSuccess())
    const captured = captureAuthorizeUrl()

    // Attach the rejection handler at creation: the flow settles while the
    // redirect request is being served, before this test awaits it.
    const auth = runLoopbackAuth({
      onAuthorizeUrl: captured.onAuthorizeUrl,
      openBrowser: () => {},
      timeoutMs: 10_000,
    })
    const outcome = auth.then(
      () => null,
      (err: unknown) => err,
    )

    const authorizeUrl = await captured.url
    const redirect = authorizeUrl.searchParams.get("redirect_uri")!
    const state = authorizeUrl.searchParams.get("state")!
    const detail = "AADSTS65001: The user or administrator has not consented to use the application."
    const res = await originalFetch(
      `${redirect}?error=access_denied&error_description=${encodeURIComponent(detail)}&state=${state}`,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("AADSTS65001")

    const caught = await outcome
    expect(caught).toBeInstanceOf(WorkiqAuthError)
    expect((caught as WorkiqAuthError).message).toContain(detail)
    expect((caught as WorkiqAuthError).errorCode).toBe("access_denied")
    expect((caught as WorkiqAuthError).remedy).toBe(AUTH_REMEDY)
  })

  test("exchanges the code, persists the token, and reads the account from the id token", async () => {
    const calls = mockTokenEndpoint(() => tokenSuccess())
    const captured = captureAuthorizeUrl()

    const auth = runLoopbackAuth({
      onAuthorizeUrl: captured.onAuthorizeUrl,
      openBrowser: () => {},
      timeoutMs: 10_000,
    })

    const authorizeUrl = await captured.url
    const redirect = authorizeUrl.searchParams.get("redirect_uri")!
    const state = authorizeUrl.searchParams.get("state")!
    const challenge = authorizeUrl.searchParams.get("code_challenge")!

    await originalFetch(`${redirect}?code=auth-code-123&state=${state}`)
    const file = await auth

    expect(calls.length).toBe(1)
    const form = calls[0]!.form
    expect(form.grant_type).toBe("authorization_code")
    expect(form.code).toBe("auth-code-123")
    expect(form.redirect_uri).toBe(redirect)
    expect(form.client_id).toBe(WORKIQ_PUBLIC_CLIENT_ID)
    expect(form.scope).toBe(WORKIQ_SCOPE)
    expect(form.code_verifier).toBeTruthy()
    // The verifier the exchange sends must be the one the challenge commits to.
    const { createHash } = await import("node:crypto")
    expect(createHash("sha256").update(form.code_verifier!).digest("base64url")).toBe(challenge)

    expect(file.account).toBe("ana@contoso.example")
    expect(file.accessToken).toBe("synthetic-access-1")
    expect(file.refreshToken).toBe("synthetic-refresh-1")
    expect(file.expiresAtMs).toBeGreaterThan(Date.now() + 3500 * 1000)

    const onDisk = await readWorkiqTokenFile(workiqTokenPath())
    expect(onDisk?.refreshToken).toBe("synthetic-refresh-1")
    expect(onDisk?.account).toBe("ana@contoso.example")
  })

  test("a failure response from the token endpoint keeps Entra's text", async () => {
    mockTokenEndpoint(() =>
      tokenFailure("invalid_grant", "AADSTS70000: The provided grant is not valid."),
    )
    const captured = captureAuthorizeUrl()

    const auth = runLoopbackAuth({
      onAuthorizeUrl: captured.onAuthorizeUrl,
      openBrowser: () => {},
      timeoutMs: 10_000,
    })
    const outcome = auth.then(
      () => null,
      (err: unknown) => err,
    )
    const authorizeUrl = await captured.url
    const redirect = authorizeUrl.searchParams.get("redirect_uri")!
    const state = authorizeUrl.searchParams.get("state")!
    await originalFetch(`${redirect}?code=abc&state=${state}`)

    const caught = await outcome
    expect(caught).toBeInstanceOf(WorkiqAuthError)
    expect((caught as WorkiqAuthError).message).toContain("AADSTS70000")
    expect((caught as WorkiqAuthError).errorCode).toBe("invalid_grant")
  })
})

describe("ensureWorkiqToken", () => {
  test("WORKIQ_MCP_TOKEN short-circuits everything", async () => {
    const calls = mockTokenEndpoint(() => tokenSuccess())
    process.env[WORKIQ_TOKEN_ENV] = "synthetic-env-bearer"

    expect(await ensureWorkiqToken()).toBe("synthetic-env-bearer")
    expect(calls).toEqual([])
    // And it does not need a token file to exist.
    expect(await readWorkiqTokenFile()).toBeNull()
  })

  test("a token comfortably outside the skew window is used as-is", async () => {
    const calls = mockTokenEndpoint(() => tokenSuccess())
    await writeWorkiqTokenFile(tokenFile({ expiresAtMs: Date.now() + 30 * 60 * 1000 }))

    expect(await ensureWorkiqToken()).toBe("synthetic-access-existing")
    expect(calls).toEqual([])
  })

  test("a token inside the five-minute skew window is refreshed and rotated", async () => {
    const calls = mockTokenEndpoint(() =>
      tokenSuccess({ access_token: "synthetic-access-2", refresh_token: "synthetic-refresh-2" }),
    )
    await writeWorkiqTokenFile(
      tokenFile({ expiresAtMs: Date.now() + WORKIQ_REFRESH_SKEW_MS - 1000 }),
    )

    expect(await ensureWorkiqToken()).toBe("synthetic-access-2")

    expect(calls.length).toBe(1)
    expect(calls[0]!.form.grant_type).toBe("refresh_token")
    expect(calls[0]!.form.refresh_token).toBe("synthetic-refresh-existing")
    expect(calls[0]!.form.client_id).toBe(WORKIQ_PUBLIC_CLIENT_ID)

    const onDisk = await readWorkiqTokenFile()
    expect(onDisk?.accessToken).toBe("synthetic-access-2")
    expect(onDisk?.refreshToken).toBe("synthetic-refresh-2")
  })

  test("concurrent callers share exactly one refresh", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = mockTokenEndpoint(async () => {
      await gate
      return tokenSuccess({ access_token: "synthetic-access-shared" })
    })
    await writeWorkiqTokenFile(
      tokenFile({ expiresAtMs: Date.now() + WORKIQ_REFRESH_SKEW_MS - 1000 }),
    )

    const first = ensureWorkiqToken()
    const second = ensureWorkiqToken()
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a).toBe("synthetic-access-shared")
    expect(b).toBe("synthetic-access-shared")
    // A second grant would present an already-rotated refresh token and fail.
    expect(calls.length).toBe(1)
  })

  test("no login at all names the command that creates one", async () => {
    mockTokenEndpoint(() => tokenSuccess())

    let caught: unknown
    try {
      await ensureWorkiqToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkiqAuthError)
    expect((caught as WorkiqAuthError).remedy).toBe(AUTH_REMEDY)
    expect((caught as WorkiqAuthError).message).toContain("No Work IQ login found")
  })

  test("forceRefresh ignores a still-valid in-memory token (the 401 path)", async () => {
    const calls = mockTokenEndpoint(() =>
      tokenSuccess({ access_token: "synthetic-access-forced" }),
    )
    await writeWorkiqTokenFile(tokenFile({ expiresAtMs: Date.now() + 30 * 60 * 1000 }))

    expect(await ensureWorkiqToken()).toBe("synthetic-access-existing")
    expect(await ensureWorkiqToken({ forceRefresh: true })).toBe("synthetic-access-forced")
    expect(calls.length).toBe(1)
  })
})

describe("refreshWorkiqAccessToken", () => {
  test("invalid_grant re-reads the file and retries with the newest refresh token", async () => {
    // Two proxy processes share one login file. Process B rotated the token,
    // so process A's grant fails; the retry must use what is on disk rather
    // than the value it started with.
    const calls = mockTokenEndpoint((form) =>
      form.refresh_token === "synthetic-refresh-newest"
        ? tokenSuccess({
            access_token: "synthetic-access-recovered",
            refresh_token: "synthetic-refresh-rotated",
          })
        : tokenFailure("invalid_grant", "AADSTS70000: The refresh token has been revoked."),
    )
    const stale = tokenFile({ refreshToken: "synthetic-refresh-stale" })
    await writeWorkiqTokenFile(
      tokenFile({ refreshToken: "synthetic-refresh-newest", accessToken: "synthetic-access-newest" }),
    )

    const next = await refreshWorkiqAccessToken(stale)

    expect(calls.length).toBe(2)
    expect(calls[0]!.form.refresh_token).toBe("synthetic-refresh-stale")
    expect(calls[1]!.form.refresh_token).toBe("synthetic-refresh-newest")
    expect(next.accessToken).toBe("synthetic-access-recovered")

    const onDisk = await readWorkiqTokenFile()
    expect(onDisk?.refreshToken).toBe("synthetic-refresh-rotated")
  })

  test("invalid_grant with an unchanged file fails once, with the upstream text", async () => {
    const calls = mockTokenEndpoint(() =>
      tokenFailure("invalid_grant", "AADSTS70000: The refresh token has been revoked."),
    )
    const stale = tokenFile()
    await writeWorkiqTokenFile(stale)

    let caught: unknown
    try {
      await refreshWorkiqAccessToken(stale)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkiqAuthError)
    expect((caught as WorkiqAuthError).errorCode).toBe("invalid_grant")
    expect((caught as WorkiqAuthError).message).toContain("AADSTS70000")
    // A second identical grant would fail identically, so it must not be sent.
    expect(calls.length).toBe(1)
  })

  test("a non-invalid_grant failure is not retried", async () => {
    const calls = mockTokenEndpoint(() =>
      tokenFailure("interaction_required", "AADSTS50079: MFA is required."),
    )
    const stale = tokenFile()
    await writeWorkiqTokenFile(tokenFile({ refreshToken: "synthetic-refresh-other" }))

    await expect(refreshWorkiqAccessToken(stale)).rejects.toThrow(/AADSTS50079/)
    expect(calls.length).toBe(1)
  })

  test("an omitted refresh_token in the response keeps the previous one", async () => {
    mockTokenEndpoint(() =>
      tokenSuccess({ access_token: "synthetic-access-3", refresh_token: undefined }),
    )
    const current = tokenFile()
    await writeWorkiqTokenFile(current)

    const next = await refreshWorkiqAccessToken(current)
    expect(next.accessToken).toBe("synthetic-access-3")
    expect(next.refreshToken).toBe(current.refreshToken)
  })
})
