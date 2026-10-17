import { afterEach, describe, expect, mock, test } from "bun:test"

import type { RunResult } from "../src/lib/exec"
import {
  ADO_CODE_SEARCH_TOKEN_RESOURCE,
  BLUEBIRD_MCP_TOKEN_RESOURCE,
} from "../src/lib/bluebird-client"
import {
  AZURE_TENANT_ENV,
  AzCliAccessTokenCache,
  __resetAzCliExecDepsForTests,
  __resetAzInteractiveLoginStateForTests,
  __setAzCliExecDepsForTests,
  acquireAzToken,
  classifyAzFailure,
  describeAzFailure,
  runAzCliAccessToken,
  runAzInteractiveLogin,
} from "../src/lib/azure-cli-token"

/**
 * Every test in this file swaps the exec seam. Nothing here may spawn a real
 * process: on a developer machine `az` exists, and an unswapped ladder test
 * would open a browser sign-in.
 */
const RESOURCE = "11111111-2222-3333-4444-555555555555"

/**
 * Observed `az` failures, verbatim. These are fixtures on purpose: a
 * classification test written against an invented message proves nothing about
 * the CLI that actually runs.
 */
const LOGIN_REQUIRED_STDERR = "ERROR: Please run 'az login' to setup account.\n"
const TENANT_STDERR =
  "ERROR: V2Error: invalid_resource AADSTS500011: The resource principal named "
  + "11111111-2222-3333-4444-555555555555 was not found in the tenant named "
  + "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee. You should not have received this "
  + "error unless you have an unusual configuration. You might have sent your "
  + "authentication request to the wrong tenant.\n"

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    timedOut: false,
    truncated: false,
    stderrTruncated: false,
    ...over,
  }
}

type Capture = ReturnType<typeof mock>

interface Harness {
  capture: Capture
  inherit: Capture
  resolve: ReturnType<typeof mock>
}

function installHarness(over: { az?: string | null } = {}): Harness {
  const capture = mock()
  const inherit = mock()
  const resolve = mock((name: string) =>
    name === "az" ? (over.az === undefined ? "/abs/az" : over.az) : null,
  )
  __setAzCliExecDepsForTests({
    resolveExecutable: resolve as never,
    runCommandCapture: capture as never,
    runCommandInherit: inherit as never,
  })
  return { capture, inherit, resolve }
}

/** The argv of the nth `get-access-token` capture call. */
function argvOf(capture: Capture, n = 0): Array<string> {
  return capture.mock.calls[n]![0] as Array<string>
}

afterEach(() => {
  __resetAzCliExecDepsForTests()
  __resetAzInteractiveLoginStateForTests()
  delete process.env[AZURE_TENANT_ENV]
})

describe("runAzCliAccessToken", () => {
  test("tsv path returns the token with no deadline", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(result({ stdout: "  token-from-tsv \n" }))
    const minted = await runAzCliAccessToken(RESOURCE)
    expect(minted).toEqual({ token: "token-from-tsv", expiresAtMs: null })
    expect(argvOf(capture)).toEqual([
      "/abs/az",
      "account",
      "get-access-token",
      "--resource",
      RESOURCE,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ])
  })

  test("json path parses expires_on epoch seconds", async () => {
    const { capture } = installHarness()
    const expires = Math.floor(Date.now() / 1000) + 3600
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: expires }) }),
    )
    const minted = await runAzCliAccessToken(RESOURCE, { withExpiry: true })
    expect(minted.token).toBe("tok")
    expect(minted.expiresAtMs).toBe(expires * 1000)
  })

  test("json path normalizes a millisecond expires_on by magnitude", async () => {
    const { capture } = installHarness()
    const expiresMs = Date.now() + 3_600_000
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: expiresMs }) }),
    )
    expect((await runAzCliAccessToken(RESOURCE, { withExpiry: true })).expiresAtMs)
      .toBe(expiresMs)
  })

  test("json path accepts a digits-only string expires_on", async () => {
    const { capture } = installHarness()
    const expires = Math.floor(Date.now() / 1000) + 60
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: String(expires) }) }),
    )
    expect((await runAzCliAccessToken(RESOURCE, { withExpiry: true })).expiresAtMs)
      .toBe(expires * 1000)
  })

  test("legacy expiresOn string is parsed as local time", async () => {
    const { capture } = installHarness()
    const when = new Date(Date.now() + 5_400_000)
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expiresOn: when.toString() }) }),
    )
    const minted = await runAzCliAccessToken(RESOURCE, { withExpiry: true })
    // Date.parse of Date#toString is local-time; a UTC interpretation can only
    // move this by the host offset, so assert the round trip exactly.
    expect(minted.expiresAtMs).toBe(Date.parse(when.toString()))
  })

  test("an unparseable deadline is null, never fabricated", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: "not-a-time" }) }),
    )
    expect((await runAzCliAccessToken(RESOURCE, { withExpiry: true })).expiresAtMs).toBeNull()
  })

  test("a deadline older than 24h is treated as unparseable", async () => {
    const { capture } = installHarness()
    const stale = Math.floor((Date.now() - 86_400_000 * 2) / 1000)
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: stale }) }),
    )
    expect((await runAzCliAccessToken(RESOURCE, { withExpiry: true })).expiresAtMs).toBeNull()
  })

  test("an empty token is a login-shaped failure, not a silent empty string", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(result({ stdout: "   " }))
    await expect(runAzCliAccessToken(RESOURCE)).rejects.toThrow(/empty access token/)
  })

  test("az missing on PATH names the install problem", async () => {
    installHarness({ az: null })
    const err = await runAzCliAccessToken(RESOURCE).catch((e: unknown) => e)
    expect(classifyAzFailure(err)).toBe("az-missing")
  })

  test("a timeout is classified as its own kind", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(result({ code: null, timedOut: true }))
    const err = await runAzCliAccessToken(RESOURCE).catch((e: unknown) => e)
    expect(classifyAzFailure(err)).toBe("timeout")
  })

  test("AZURE_TENANT_ID rides on the mint argv", async () => {
    const { capture } = installHarness()
    process.env[AZURE_TENANT_ENV] = "tenant-abc"
    capture.mockResolvedValue(result({ stdout: "tok" }))
    await runAzCliAccessToken(RESOURCE)
    expect(argvOf(capture)).toEqual([
      "/abs/az",
      "account",
      "get-access-token",
      "--resource",
      RESOURCE,
      "--tenant",
      "tenant-abc",
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ])
  })
})

describe("classifyAzFailure", () => {
  test("the observed dead-session literal is login-required", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
    const err = await runAzCliAccessToken(RESOURCE).catch((e: unknown) => e)
    expect(classifyAzFailure(err)).toBe("login-required")
  })

  test("the observed invalid_resource literal is tenant, not login-required", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: TENANT_STDERR }))
    const err = await runAzCliAccessToken(RESOURCE).catch((e: unknown) => e)
    expect(classifyAzFailure(err)).toBe("tenant")
    expect(String((err as Error).message)).toContain("AADSTS500011")
  })

  test("unknown text falls through to unknown rather than guessing", () => {
    expect(classifyAzFailure(new Error("something else went wrong"))).toBe("unknown")
  })

  test("the resource verdict wins when a login hint appears alongside it", () => {
    // Both lines are observed separately in the fixtures above and are joined
    // here only to pin the PRECEDENCE: the remedy has to follow the resource
    // verdict, because telling the operator to run `az login` against a tenant
    // that does not carry the resource re-selects the same tenant and changes
    // nothing. Flipping the two checks in `classifyAzFailure` fails this.
    const combined = `WARNING: Please run 'az login' to setup account.\n${TENANT_STDERR}`
    expect(classifyAzFailure(new Error(combined))).toBe("tenant")
  })

  test("describeAzFailure gives per-class advice", () => {
    const login = describeAzFailure("Kusto", new Error(LOGIN_REQUIRED_STDERR))
    expect(login).toContain("az login")

    const tenant = describeAzFailure("Azure DevOps", new Error(TENANT_STDERR))
    expect(tenant).toContain("Azure DevOps")
    expect(tenant).toContain(AZURE_TENANT_ENV)
    // The wrong advice is the whole reason the classes exist.
    expect(tenant).not.toContain("run `az login`")

    const missing = describeAzFailure("Bluebird", new Error("Azure CLI executable `az` was not found on PATH."))
    expect(missing).toContain("Install the Azure CLI")
  })
})

describe("AzCliAccessTokenCache", () => {
  test("a cached token is served without a second az call", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 }) }),
    )
    const cache = new AzCliAccessTokenCache()
    expect(await cache.get(RESOURCE)).toBe("tok")
    expect(await cache.get(RESOURCE)).toBe("tok")
    expect(capture).toHaveBeenCalledTimes(1)
  })

  test("an entry inside the refresh margin re-mints", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 60 }) }),
    )
    const cache = new AzCliAccessTokenCache()
    await cache.get(RESOURCE)
    await cache.get(RESOURCE)
    // 60s of life against a 5min margin: every read must re-mint.
    expect(capture).toHaveBeenCalledTimes(2)
  })

  test("an unknown deadline is never cached", async () => {
    const { capture } = installHarness()
    capture.mockResolvedValue(
      result({ stdout: JSON.stringify({ accessToken: "tok" }) }),
    )
    const cache = new AzCliAccessTokenCache()
    await cache.get(RESOURCE)
    await cache.get(RESOURCE)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  test("concurrent reads share ONE az invocation", async () => {
    const { capture } = installHarness()
    let release: (r: RunResult) => void = () => {}
    capture.mockImplementation(
      () =>
        new Promise<RunResult>((resolve) => {
          release = resolve
        }),
    )
    const cache = new AzCliAccessTokenCache()
    const both = Promise.all([cache.get(RESOURCE), cache.get(RESOURCE)])
    release(result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 }) }))
    expect(await both).toEqual(["tok", "tok"])
    expect(capture).toHaveBeenCalledTimes(1)
  })

  test("forceRefresh bypasses a live entry", async () => {
    const { capture } = installHarness()
    let n = 0
    capture.mockImplementation(async () => {
      n += 1
      return result({
        stdout: JSON.stringify({ accessToken: `tok-${n}`, expires_on: Math.floor(Date.now() / 1000) + 3600 }),
      })
    })
    const cache = new AzCliAccessTokenCache()
    expect(await cache.get(RESOURCE)).toBe("tok-1")
    expect(await cache.get(RESOURCE)).toBe("tok-1")
    expect(await cache.get(RESOURCE, { forceRefresh: true })).toBe("tok-2")
    expect(await cache.get(RESOURCE)).toBe("tok-2")
  })

  test("invalidate drops the entry (the 401 path)", async () => {
    const { capture } = installHarness()
    let n = 0
    capture.mockImplementation(async () => {
      n += 1
      return result({
        stdout: JSON.stringify({ accessToken: `tok-${n}`, expires_on: Math.floor(Date.now() / 1000) + 3600 }),
      })
    })
    const cache = new AzCliAccessTokenCache()
    expect(await cache.get(RESOURCE)).toBe("tok-1")
    cache.invalidate(RESOURCE)
    expect(await cache.get(RESOURCE)).toBe("tok-2")
  })

  test("an aborted reader detaches without cancelling the shared mint", async () => {
    const { capture } = installHarness()
    let release: (r: RunResult) => void = () => {}
    capture.mockImplementation(
      () =>
        new Promise<RunResult>((resolve) => {
          release = resolve
        }),
    )
    const cache = new AzCliAccessTokenCache()
    const controller = new AbortController()
    const waiter = cache.get(RESOURCE, { signal: controller.signal })
    const survivor = cache.get(RESOURCE)
    controller.abort(new Error("caller went away"))
    await expect(waiter).rejects.toThrow(/caller went away/)
    release(result({ stdout: JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 }) }))
    expect(await survivor).toBe("tok")
    expect(capture).toHaveBeenCalledTimes(1)
  })
})

describe("auth ladder", () => {
  /** A success on the default (tsv) mint path. */
  const okToken = () => result({ stdout: "fresh" })

  /** A success on the `withExpiry` (json) path. */
  const okTokenWithExpiry = () =>
    result({
      stdout: JSON.stringify({ accessToken: "fresh", expires_on: Math.floor(Date.now() / 1000) + 3600 }),
    })

  test("silent failure of a credential kind escalates to a login, then re-mints", async () => {
    const { capture, inherit } = installHarness()
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(okTokenWithExpiry())
    inherit.mockResolvedValue(result({ code: 0 }))

    const minted = await acquireAzToken(RESOURCE, { allowInteractiveLogin: true, withExpiry: true })
    expect(minted.token).toBe("fresh")
    expect(capture).toHaveBeenCalledTimes(2)
    expect(inherit).toHaveBeenCalledTimes(1)
    // Browser flow first, device code only as the fallback.
    expect(inherit.mock.calls[0]![0]).toEqual(["/abs/az", "login"])
  })

  test("a browser login that does not complete falls back to device code", async () => {
    const { capture, inherit } = installHarness()
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(okToken())
    inherit
      .mockResolvedValueOnce(result({ code: 1, stderr: "browser did not complete" }))
      .mockResolvedValueOnce(result({ code: 0 }))

    expect((await acquireAzToken(RESOURCE, { allowInteractiveLogin: true })).token).toBe("fresh")
    expect(inherit.mock.calls[1]![0]).toEqual(["/abs/az", "login", "--use-device-code"])
  })

  test("AZURE_TENANT_ID rides on the login argv too", async () => {
    const { capture, inherit } = installHarness()
    process.env[AZURE_TENANT_ENV] = "tenant-abc"
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(okToken())
    inherit.mockResolvedValue(result({ code: 0 }))
    await acquireAzToken(RESOURCE, { allowInteractiveLogin: true })
    expect(inherit.mock.calls[0]![0]).toEqual(["/abs/az", "login", "--tenant", "tenant-abc"])
  })

  test("the ladder is off by default: a silent failure surfaces unchanged", async () => {
    const { capture, inherit } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
    const err = await acquireAzToken(RESOURCE).catch((e: unknown) => e)
    expect(classifyAzFailure(err)).toBe("login-required")
    expect(capture).toHaveBeenCalledTimes(1)
    expect(inherit).not.toHaveBeenCalled()
  })

  test("a tenant failure never escalates: a login re-selects the same tenant", async () => {
    const { capture, inherit } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: TENANT_STDERR }))
    await acquireAzToken(RESOURCE, { allowInteractiveLogin: true }).catch(() => {})
    expect(classifyAzFailure(await acquireAzToken(RESOURCE, { allowInteractiveLogin: true }).catch((e: unknown) => e)))
      .toBe("tenant")
    expect(inherit).not.toHaveBeenCalled()
  })

  test("a missing az never escalates: that needs an install", async () => {
    const { inherit } = installHarness({ az: null })
    await acquireAzToken(RESOURCE, { allowInteractiveLogin: true }).catch(() => {})
    expect(inherit).not.toHaveBeenCalled()
  })

  test("an already-aborted caller never starts a login", async () => {
    const { capture, inherit } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
    const controller = new AbortController()
    controller.abort(new Error("gone before start"))
    await expect(
      acquireAzToken(RESOURCE, { allowInteractiveLogin: true, signal: controller.signal }),
    ).rejects.toThrow(/gone before start/)
    expect(inherit).not.toHaveBeenCalled()
  })

  test("a failed login keeps the ORIGINAL error and is not retried per call", async () => {
    const { capture, inherit } = installHarness()
    capture.mockResolvedValue(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
    inherit.mockResolvedValue(result({ code: 1, stderr: "nope" }))

    for (let i = 0; i < 3; i++) {
      const err = await acquireAzToken(RESOURCE, { allowInteractiveLogin: true }).catch((e: unknown) => e)
      // The mint error names the real cause; a login error would describe only
      // the fallback.
      expect(classifyAzFailure(err)).toBe("login-required")
      expect(String((err as Error).message)).toContain("Please run 'az login'")
    }
    // One completed attempt per process (browser + its device fallback), not
    // one per caller.
    expect(inherit).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(3)
  })

  test("after a login has succeeded the process never logs in again", async () => {
    const { capture, inherit } = installHarness()
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(okToken())
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
    inherit.mockResolvedValue(result({ code: 0 }))

    expect((await acquireAzToken(RESOURCE, { allowInteractiveLogin: true })).token).toBe("fresh")
    // A later failure has a different cause (the new session cannot mint this
    // resource); popping a browser again would be user-hostile and useless.
    await acquireAzToken(RESOURCE, { allowInteractiveLogin: true }).catch(() => {})
    expect(inherit).toHaveBeenCalledTimes(1)
  })

  test("concurrent callers share ONE login", async () => {
    const { capture, inherit } = installHarness()
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValue(okToken())
    let releaseLogin: (r: RunResult) => void = () => {}
    inherit.mockImplementation(
      () =>
        new Promise<RunResult>((resolve) => {
          releaseLogin = resolve
        }),
    )

    const both = Promise.all([
      acquireAzToken(RESOURCE, { allowInteractiveLogin: true }),
      acquireAzToken(RESOURCE, { allowInteractiveLogin: true }),
    ])
    // Let both silent mints fail and reach the login gate.
    await new Promise((r) => setTimeout(r, 0))
    releaseLogin(result({ code: 0 }))
    expect((await both).map((t) => t.token)).toEqual(["fresh", "fresh"])
    expect(inherit).toHaveBeenCalledTimes(1)
  })

  test("a caller that goes away does not kill the login another caller waits on", async () => {
    const { capture, inherit } = installHarness()
    capture
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValueOnce(result({ code: 1, stderr: LOGIN_REQUIRED_STDERR }))
      .mockResolvedValue(okToken())
    let releaseLogin: (r: RunResult) => void = () => {}
    inherit.mockImplementation(
      () =>
        new Promise<RunResult>((resolve) => {
          releaseLogin = resolve
        }),
    )

    const controller = new AbortController()
    const leaving = acquireAzToken(RESOURCE, { allowInteractiveLogin: true, signal: controller.signal })
    const staying = acquireAzToken(RESOURCE, { allowInteractiveLogin: true })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort(new Error("caller went away"))
    await expect(leaving).rejects.toThrow(/caller went away/)
    releaseLogin(result({ code: 0 }))
    expect((await staying).token).toBe("fresh")
    expect(inherit).toHaveBeenCalledTimes(1)
  })
})

describe("runAzInteractiveLogin", () => {
  test("inherits stdio so the device code reaches the human", async () => {
    const { inherit } = installHarness()
    inherit.mockResolvedValue(result({ code: 0 }))
    expect(await runAzInteractiveLogin()).toBe(true)
    // `runCommandInherit`, not a captured run: `az login --use-device-code`
    // prints the code and URL the user has to read.
    expect(inherit).toHaveBeenCalledTimes(1)
    expect(inherit.mock.calls[0]![1]).toMatchObject({ timeoutMs: 120_000 })
  })

  test("without az on PATH it reports failure rather than spawning anything", async () => {
    const { inherit } = installHarness({ az: null })
    expect(await runAzInteractiveLogin()).toBe(false)
    expect(inherit).not.toHaveBeenCalled()
  })
})

describe("resource constants", () => {
  test("the two Bluebird-flow audiences stay distinct", () => {
    // Sending the ADO-audience token to mcp.bluebird-ai.net is a 401 (measured
    // live), and sending the Bluebird-audience token to almsearch is a
    // 302-sign-in (also measured). A future "simplify to one token" edit has to
    // fail here.
    expect(BLUEBIRD_MCP_TOKEN_RESOURCE).toBe("f8efec34-6ac0-4538-8a18-ee59319d7338")
    expect(ADO_CODE_SEARCH_TOKEN_RESOURCE).toBe("499b84ac-1321-427f-aa17-267ca6975798")
    expect(BLUEBIRD_MCP_TOKEN_RESOURCE).not.toBe(ADO_CODE_SEARCH_TOKEN_RESOURCE)
  })
})
