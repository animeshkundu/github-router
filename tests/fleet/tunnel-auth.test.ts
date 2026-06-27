import { describe, expect, test } from "bun:test"

import {
  TunnelAuthError,
  assertTrustedDevtunnelPath,
  createTunnelTokenProvider,
  parseJwtExpMs,
  redactTunnelSecrets,
  type DevtunnelRunResult,
} from "../../src/lib/fleet/tunnel-auth"

// ---- helpers ---------------------------------------------------------------

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

/** Build a structurally-valid JWT whose payload carries `exp` (seconds). */
function makeJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJIUzI1NiJ9.${b64url(payload)}.sig`
}

function jwtExpiringInSeconds(secondsFromNow: number): string {
  return makeJwt({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })
}

interface FakeRunner {
  (args: ReadonlyArray<string>): Promise<DevtunnelRunResult>
  calls: Array<Array<string>>
}

function fakeRunner(impl: (args: ReadonlyArray<string>) => DevtunnelRunResult | Promise<DevtunnelRunResult>): FakeRunner {
  const calls: Array<Array<string>> = []
  const fn = (async (args: ReadonlyArray<string>) => {
    calls.push([...args])
    return impl(args)
  }) as FakeRunner
  fn.calls = calls
  return fn
}

function okResult(stdout: string): DevtunnelRunResult {
  return { stdout, stderr: "", code: 0, timedOut: false }
}

async function expectTunnelAuthError(promise: Promise<unknown>, code: TunnelAuthError["code"]): Promise<void> {
  try {
    await promise
    throw new Error("expected TunnelAuthError")
  } catch (err) {
    expect(err).toBeInstanceOf(TunnelAuthError)
    expect((err as TunnelAuthError).code).toBe(code)
  }
}

const CFG = { tunnelId: "aiordie-host-gh.usw2" }

// ---- cwd-hijack guard ------------------------------------------------------

describe("assertTrustedDevtunnelPath", () => {
  test("rejects an unresolved (null) path", () => {
    expect(() => assertTrustedDevtunnelPath(null, "/work")).toThrow(TunnelAuthError)
  })

  test("rejects a non-absolute path", () => {
    expect(() => assertTrustedDevtunnelPath("./devtunnel", "/work")).toThrow(TunnelAuthError)
  })

  test("rejects a cwd-local binary", () => {
    expect(() => assertTrustedDevtunnelPath("/work/devtunnel", "/work")).toThrow(TunnelAuthError)
  })

  test("accepts a trusted absolute path outside cwd", () => {
    expect(assertTrustedDevtunnelPath("/usr/local/bin/devtunnel", "/work")).toBe("/usr/local/bin/devtunnel")
  })

  test("rejects a .cmd/.bat shim (native binary required)", () => {
    expect(() => assertTrustedDevtunnelPath("/opt/bin/devtunnel.cmd", "/work")).toThrow(TunnelAuthError)
    expect(() => assertTrustedDevtunnelPath("/opt/bin/devtunnel.bat", "/work")).toThrow(TunnelAuthError)
  })
})

// ---- parseJwtExpMs ---------------------------------------------------------

describe("parseJwtExpMs", () => {
  test("converts a seconds exp claim to epoch milliseconds", () => {
    expect(parseJwtExpMs(makeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000)
  })

  test("throws PARSE for a missing/non-numeric exp", () => {
    expect(() => parseJwtExpMs(makeJwt({ foo: 1 }))).toThrow(TunnelAuthError)
    expect(() => parseJwtExpMs(makeJwt({ exp: "soon" }))).toThrow(TunnelAuthError)
  })

  test("throws PARSE for a non-JWT string", () => {
    expect(() => parseJwtExpMs("not-a-jwt")).toThrow(TunnelAuthError)
  })
})

// ---- redaction -------------------------------------------------------------

describe("redactTunnelSecrets", () => {
  test("strips JWT-shaped and scheme-prefixed tokens", () => {
    const jwt = makeJwt({ exp: 1 })
    const out = redactTunnelSecrets(`failed for tunnel ${jwt} and Bearer ${jwt}`)
    expect(out).not.toContain(jwt)
    expect(out).toContain("<redacted-token>")
  })
})

// ---- provider: mint / cache / argv ----------------------------------------

describe("createTunnelTokenProvider", () => {
  test("mints with the correct devtunnel argv and returns the token", async () => {
    const jwt = jwtExpiringInSeconds(3600)
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwt })))
    const provider = createTunnelTokenProvider(runner)

    expect(await provider.getToken(CFG)).toBe(jwt)
    expect(runner.calls[0]).toEqual(["token", "aiordie-host-gh.usw2", "--scopes", "connect", "--json"])
  })

  test("caches a fresh token (no re-mint within the margin)", async () => {
    const jwt = jwtExpiringInSeconds(3600)
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwt })))
    const provider = createTunnelTokenProvider(runner)

    await provider.getToken(CFG)
    await provider.getToken(CFG)
    expect(runner.calls.length).toBe(1)
  })

  test("rate-limits re-minting of a short-TTL token (no per-request spawn storm)", async () => {
    // exp 4 min out — inside the 5 min refresh margin, so a naive impl would
    // re-mint on every call; the min re-mint interval bounds it to one spawn.
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwtExpiringInSeconds(240) })))
    const provider = createTunnelTokenProvider(runner)

    await provider.getToken(CFG)
    await provider.getToken(CFG)
    await provider.getToken(CFG)
    expect(runner.calls.length).toBe(1)
  })

  test("single-flights concurrent cold-cache callers into one mint", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const runner = fakeRunner(async () => {
      await gate
      return okResult(JSON.stringify({ token: jwtExpiringInSeconds(3600) }))
    })
    const provider = createTunnelTokenProvider(runner)

    const ps = [0, 1, 2, 3, 4].map(() => provider.getToken(CFG))
    release()
    const tokens = await Promise.all(ps)

    expect(runner.calls.length).toBe(1)
    expect(new Set(tokens).size).toBe(1)
  })

  test("extracts the token from plain (non-JSON) devtunnel output", async () => {
    const jwt = jwtExpiringInSeconds(3600)
    const runner = fakeRunner(() => okResult(`\n${jwt}\n`))
    const provider = createTunnelTokenProvider(runner)
    expect(await provider.getToken(CFG)).toBe(jwt)
  })

  test("ignores non-token dotted strings in JSON output (eyJ-prefix guard)", async () => {
    const jwt = jwtExpiringInSeconds(3600)
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwt, version: "1.2.3", build: "a.b.c" })))
    const provider = createTunnelTokenProvider(runner)
    expect(await provider.getToken(CFG)).toBe(jwt)
  })

  test("rejects a tunnelId that is not a valid devtunnel name", async () => {
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwtExpiringInSeconds(3600) })))
    const provider = createTunnelTokenProvider(runner)
    await expectTunnelAuthError(provider.getToken({ tunnelId: "--help" }), "MINT_FAILED")
    expect(runner.calls.length).toBe(0)
  })

  test("refuses to guess when output carries more than one distinct token", async () => {
    const a = makeJwt({ exp: 1, jti: "a" })
    const b = makeJwt({ exp: 2, jti: "b" })
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: a, refresh: b })))
    const provider = createTunnelTokenProvider(runner)
    await expectTunnelAuthError(provider.getToken(CFG), "PARSE")
  })

  test("rejects an already-expired minted token", async () => {
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: makeJwt({ exp: 1 }) })))
    const provider = createTunnelTokenProvider(runner)
    await expectTunnelAuthError(provider.getToken(CFG), "PARSE")
  })

  test("classifies a not-logged-in failure and backs off (no spawn storm)", async () => {
    const runner = fakeRunner(() => ({ stdout: "", stderr: "Please log in first", code: 1, timedOut: false }))
    const provider = createTunnelTokenProvider(runner)

    await expectTunnelAuthError(provider.getToken(CFG), "NOT_LOGGED_IN")
    // second immediate call is served from backoff — runner is NOT invoked again
    await expectTunnelAuthError(provider.getToken(CFG), "NOT_LOGGED_IN")
    expect(runner.calls.length).toBe(1)
  })

  test("classifies a tunnel-not-found failure", async () => {
    const runner = fakeRunner(() => ({ stdout: "", stderr: "Tunnel not found", code: 1, timedOut: false }))
    const provider = createTunnelTokenProvider(runner)
    await expectTunnelAuthError(provider.getToken(CFG), "TUNNEL_NOT_FOUND")
  })

  test("classifies a timeout and does NOT back off (retryable)", async () => {
    const runner = fakeRunner(() => ({ stdout: "", stderr: "", code: null, timedOut: true }))
    const provider = createTunnelTokenProvider(runner)

    await expectTunnelAuthError(provider.getToken(CFG), "TIMEOUT")
    await expectTunnelAuthError(provider.getToken(CFG), "TIMEOUT")
    // timeout is transient — the second call re-attempts rather than backing off
    expect(runner.calls.length).toBe(2)
  })

  test("invalidate() evicts the cache so the next getToken re-mints", async () => {
    const runner = fakeRunner(() => okResult(JSON.stringify({ token: jwtExpiringInSeconds(3600) })))
    const provider = createTunnelTokenProvider(runner)

    await provider.getToken(CFG)
    provider.invalidate(CFG)
    await provider.getToken(CFG)
    expect(runner.calls.length).toBe(2)
  })

  test("never surfaces a token inside an error message", async () => {
    const jwt = jwtExpiringInSeconds(3600)
    const runner = fakeRunner(() => ({ stdout: "", stderr: `boom with tunnel ${jwt}`, code: 1, timedOut: false }))
    const provider = createTunnelTokenProvider(runner)
    try {
      await provider.getToken(CFG)
      throw new Error("expected failure")
    } catch (err) {
      expect((err as Error).message).not.toContain(jwt)
    }
  })
})
