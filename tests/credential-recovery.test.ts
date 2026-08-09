import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"
import {
  __resetRefreshCooldownsForTests,
  ensureFreshCopilotToken,
  refreshCopilotToken,
  setupCopilotToken,
  tryRefreshAndRetry,
} from "../src/lib/token"
import { credentialFingerprint } from "../src/services/github/get-copilot-token"

/**
 * Regression suite for the 2026-08-08 credential outage.
 *
 * Shape of the incident: a scheduled token exchange failed for a reason
 * nothing logged; six minutes later the cached Copilot token hit its TTL;
 * every retry for the next 53 minutes also failed; and a freshly minted
 * credential written to disk at 13:53 was never picked up, because
 * `state.githubToken` was read once at startup and never again. The session
 * could not recover without a restart.
 *
 * These tests pin the mechanisms that make it recoverable AND attributable.
 */

const originalFetch = globalThis.fetch
const originalTokenPathDescriptor = Object.getOwnPropertyDescriptor(
  PATHS,
  "GITHUB_TOKEN_PATH",
)
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalSource = state.githubTokenSource
const originalRefreshAt = state.copilotTokenRefreshAt

let tempDir = ""
let tokenPath = ""
/** The unique credential this test started with, on disk and in memory. */
let startingCredential = ""

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
}

/** A successful `/copilot_internal/v2/token` body. */
function exchangeOk(token: string, refreshIn = 1500): Response {
  return jsonResponse({
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    refresh_in: refreshIn,
    token,
  })
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-router-cred-"))
  tokenPath = path.join(tempDir, "github_token")
  Object.defineProperty(PATHS, "GITHUB_TOKEN_PATH", {
    configurable: true,
    value: tokenPath,
  })
  // Each test gets a UNIQUE credential, on disk and in memory.
  //
  // This is what makes the tests independent, and it does so without
  // touching `Date.now`. The refresh cooldowns are module-level and persist
  // for the life of the process, so a fake clock here would leak into every
  // other test file sharing the process (it did: it broke the cooldown test
  // in token.test.ts). A credential the process has not tried yet bypasses
  // the cooldowns by design — the post-`auth` recovery path — so a fresh one
  // per test gives isolation for free, using the real mechanism rather than
  // a clock stub that lies to unrelated code.
  const unique = `disk-token-${crypto.randomUUID()}`
  startingCredential = unique
  await fs.writeFile(tokenPath, unique)
  state.githubToken = unique
  state.githubTokenSource = "file"
  state.copilotToken = "copilot-v1"
  state.copilotTokenRefreshAt = undefined
  // The latch is process-global state, so a leak here would make one test's
  // warning suppress the next test's.
  state.authRequiredCredentialFingerprint = undefined
  // The cooldowns are module state that outlives a test, so one test's
  // refresh would otherwise suppress the next test's.
  __resetRefreshCooldownsForTests()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalTokenPathDescriptor) {
    Object.defineProperty(PATHS, "GITHUB_TOKEN_PATH", originalTokenPathDescriptor)
  }
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.githubTokenSource = originalSource
  state.copilotTokenRefreshAt = originalRefreshAt
  state.authRequiredCredentialFingerprint = undefined
  // Also reset on the way OUT, not just on the way in. The cooldowns are
  // module-level and outlive this file, and these tests deliberately end on a
  // failed refresh — which arms `lastRefreshFailure` and would make the NEXT
  // test file's first reactive refresh cool down and report "skipped".
  __resetRefreshCooldownsForTests()
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe("credential fingerprinting", () => {
  test("is stable, short, and never echoes the credential", () => {
    const fp = credentialFingerprint("ghu_supersecretvalue")
    expect(fp).toBe(credentialFingerprint("ghu_supersecretvalue"))
    expect(fp).toHaveLength(8)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect("ghu_supersecretvalue").not.toContain(fp)
  })

  test("distinguishes two credentials, which is the whole point", () => {
    // Without this, a log cannot answer "is the process holding a stale
    // credential, or is the one on disk dead?" — the 13:53 question.
    expect(credentialFingerprint("token-a")).not.toBe(
      credentialFingerprint("token-b"),
    )
    expect(credentialFingerprint(undefined)).toBe("none")
  })
})

describe("adopting a repaired credential from disk", () => {
  test("a newer credential on disk is picked up without a restart", async () => {
    // THE incident: the operator re-authenticates in another terminal while
    // the proxy is running. Before the fix, the running process never saw it.
    await fs.writeFile(tokenPath, "disk-token-v2")

    const seen: Array<string> = []
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      const auth = String(
        (init?.headers as Record<string, string>)?.authorization ?? "",
      )
      seen.push(auth)
      return exchangeOk("copilot-v2")
    }) as unknown as typeof fetch

    const outcome = await refreshCopilotToken("interval")

    expect(outcome).toBe("refreshed")
    expect(state.githubToken).toBe("disk-token-v2")
    expect(seen[0]).toContain("disk-token-v2")
    expect(state.copilotToken).toBe("copilot-v2")
  })

  test("a failing disk candidate does not evict the working in-memory credential", async () => {
    // Commit-after-success. A truncated or stale file must not be able to
    // destroy a credential that was working.
    await fs.writeFile(tokenPath, "disk-token-bad")

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch

    const outcome = await refreshCopilotToken("interval")

    expect(outcome).toBe("credential_rejected")
    expect(state.githubToken).toBe(startingCredential)
  })

  test("an explicit --github-token is never overridden from disk", async () => {
    state.githubTokenSource = "explicit"
    state.githubToken = "explicit-token"
    await fs.writeFile(tokenPath, "disk-token-v2")

    const seen: Array<string> = []
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      seen.push(
        String((init?.headers as Record<string, string>)?.authorization ?? ""),
      )
      return exchangeOk("copilot-v2")
    }) as unknown as typeof fetch

    await refreshCopilotToken("interval")

    expect(state.githubToken).toBe("explicit-token")
    expect(seen[0]).toContain("explicit-token")
    expect(seen[0]).not.toContain("disk-token-v2")
  })

  test("an unreadable or torn credential file leaves memory untouched", async () => {
    // Windows: a read racing the temp+rename write fails with
    // EPERM/EBUSY/EACCES/ENOENT. None of those mean the in-memory credential
    // went bad, and none may escape into the refresh loop.
    await fs.rm(tokenPath, { force: true })

    globalThis.fetch = mock(async () =>
      exchangeOk("copilot-v2")) as unknown as typeof fetch

    const outcome = await refreshCopilotToken("interval")

    expect(outcome).toBe("refreshed")
    expect(state.githubToken).toBe(startingCredential)
  })

  test("an empty credential file is treated as no credential, not as one", async () => {
    await fs.writeFile(tokenPath, "   \n")

    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      const auth = String(
        (init?.headers as Record<string, string>)?.authorization ?? "",
      )
      expect(auth).toContain(startingCredential)
      return exchangeOk("copilot-v2")
    }) as unknown as typeof fetch

    expect(await refreshCopilotToken("interval")).toBe("refreshed")
    expect(state.githubToken).toBe(startingCredential)
  })

  test("a newer credential bypasses the cooldown that would otherwise swallow recovery", async () => {
    // Without this the recovery window right after `github-router auth` is
    // eaten by the 30s success cooldown — precisely when it matters most.
    globalThis.fetch = mock(async () =>
      exchangeOk("copilot-v2")) as unknown as typeof fetch
    await refreshCopilotToken("interval")

    // Immediately after a success: a plain reactive refresh is cooled down...
    expect(await refreshCopilotToken("401-retry")).toBe("skipped")

    // ...but a credential the process has never tried is new information.
    await fs.writeFile(tokenPath, "disk-token-v3")
    expect(await refreshCopilotToken("401-retry")).toBe("refreshed")
    expect(state.githubToken).toBe("disk-token-v3")
  })

  test("an unvalidated candidate is never visible to concurrent requests", async () => {
    // `state` is process-global and read by every in-flight request when it
    // builds upstream headers. A candidate credential from disk must be
    // proven by a successful exchange BEFORE it is published there —
    // otherwise unrelated requests would pick up an unvalidated credential
    // mid-exchange and 401 while a working one was still in hand.
    await fs.writeFile(tokenPath, "disk-candidate-doomed")

    let credentialVisibleDuringExchange: string | undefined
    globalThis.fetch = mock(async () => {
      // Stands in for a concurrent request reading global state mid-flight.
      credentialVisibleDuringExchange = state.githubToken
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      })
    }) as unknown as typeof fetch

    await refreshCopilotToken("interval")

    expect(credentialVisibleDuringExchange).toBe(startingCredential)
    expect(credentialVisibleDuringExchange).not.toBe("disk-candidate-doomed")
    // And after a failed exchange the working credential is still in place.
    expect(state.githubToken).toBe(startingCredential)
  })

  test("concurrent refreshes still collapse to ONE exchange", async () => {
    // Single-flight regression. The cooldown-bypass check reads the
    // credential from disk, which is async — so if that await sits between
    // the `if (inflightRefresh)` guard and the assignment, two callers can
    // both pass the guard and launch overlapping exchanges against GitHub.
    // The guard and the assignment must not be separated by an await.
    let inFlight = 0
    let maxConcurrent = 0
    const fetchMock = mock(async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight--
      return exchangeOk("copilot-v2")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await Promise.all([
      refreshCopilotToken("401-retry"),
      refreshCopilotToken("401-retry"),
      refreshCopilotToken("expiry"),
      refreshCopilotToken("interval"),
    ])

    expect(maxConcurrent).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("exchange failure classification", () => {
  test("401 is a rejected credential", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      }),
    ) as unknown as typeof fetch
    expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
  })

  test("a bare 403 is TRANSIENT, because GitHub uses it for rate limits", async () => {
    // The dangerous false positive: treating a rate limit as a dead
    // credential would tell a user with a perfectly good token to
    // re-authenticate, and would do it for the whole session.
    globalThis.fetch = mock(async () =>
      new Response("You have exceeded a secondary rate limit", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    ) as unknown as typeof fetch
    expect(await refreshCopilotToken("interval")).toBe("transient_failure")
  })

  test("a 403 naming an entitlement problem is classified apart from a bad credential", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ notification_id: "subscription_ended" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch
    // Distinct from `credential_rejected`: "re-authenticate" is wrong advice
    // for a lapsed subscription.
    expect(await refreshCopilotToken("interval")).toBe("entitlement_lapsed")
  })

  test("an unrecognized 4xx defaults to transient", async () => {
    globalThis.fetch = mock(async () =>
      new Response("teapot", { status: 418 }),
    ) as unknown as typeof fetch
    expect(await refreshCopilotToken("interval")).toBe("transient_failure")
  })

  test("the thrown error carries status and fingerprint but never the credential", async () => {
    const { getCopilotToken } = await import(
      "../src/services/github/get-copilot-token"
    )
    state.githubToken = "ghu_secret_value_here"
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      }),
    ) as unknown as typeof fetch

    await expect(getCopilotToken()).rejects.toThrow(/HTTP 401/)
    try {
      await getCopilotToken()
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain("401")
      expect(msg).toContain("credential_rejected")
      expect(msg).toContain(credentialFingerprint("ghu_secret_value_here"))
      expect(msg).not.toContain("ghu_secret_value_here")
    }
  })
})

describe("expiry deadline", () => {
  test("is derived from refresh_in, so a clock running ahead cannot cause a storm", async () => {
    // The exchange advertises an absolute `expires_at` far in the PAST.
    // Honouring it would mark a brand-new token already expired.
    globalThis.fetch = mock(async () =>
      jsonResponse({ expires_at: 1, refresh_in: 1500, token: "copilot-v2" }),
    ) as unknown as typeof fetch

    await refreshCopilotToken("interval")

    expect(state.copilotTokenRefreshAt).toBeGreaterThan(Date.now())
  })

  test("a garbage refresh_in is clamped instead of producing a hot loop", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ expires_at: 0, refresh_in: 0, token: "copilot-v2" }),
    ) as unknown as typeof fetch

    await refreshCopilotToken("interval")

    // Clamped to the 60s floor, minus the skew — never a zero-length timer.
    expect(state.copilotTokenRefreshAt).toBeDefined()
    expect(state.copilotTokenRefreshAt! - Date.now()).toBeGreaterThan(-121_000)
  })

  test("a short refresh_in cannot produce an already-past deadline", async () => {
    // Spin-loop guard. The deadline is `now + refresh_in - skew`, and the
    // skew is 120s — so any `refresh_in` at or below that would land in the
    // PAST, the scheduler would floor the delay to 1s, and the proxy would
    // hammer GitHub at 1 Hz forever. The deadline must always be in the
    // future regardless of what upstream returns.
    globalThis.fetch = mock(async () =>
      jsonResponse({ expires_at: 0, refresh_in: 60, token: "copilot-v2" }),
    ) as unknown as typeof fetch

    await refreshCopilotToken("interval")

    expect(state.copilotTokenRefreshAt).toBeDefined()
    expect(state.copilotTokenRefreshAt!).toBeGreaterThan(Date.now())
  })

  test("ensureFreshCopilotToken does nothing before the deadline", async () => {
    const fetchMock = mock(async () => exchangeOk("nope"))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotTokenRefreshAt = Date.now() + 60_000

    await ensureFreshCopilotToken()

    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test("ensureFreshCopilotToken refreshes once the deadline has passed", async () => {
    const fetchMock = mock(async () => exchangeOk("copilot-fresh"))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotTokenRefreshAt = Date.now() - 1

    await ensureFreshCopilotToken()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(state.copilotToken).toBe("copilot-fresh")
  })
})

describe("tryRefreshAndRetry: the generation counter", () => {
  test("retries when another caller refreshed, even though this call was cooled down", async () => {
    // The concurrency bug this design exists to prevent. Requests A and B
    // both hold a stale token and both 401. A refreshes; B's refresh lands
    // inside the 30s success cooldown and reports "skipped". A verdict-based
    // rule would fail B with a 503 even though a good token is in state.
    //
    // The interleaving is what matters: A's refresh must land AFTER B has
    // captured its generation (i.e. after B's first attempt) and BEFORE B
    // consults it. So request A is simulated from inside B's first attempt.
    globalThis.fetch = mock(async () =>
      exchangeOk("copilot-v2")) as unknown as typeof fetch
    state.copilotTokenRefreshAt = Date.now() + 600_000

    let attempts = 0
    const res = await tryRefreshAndRetry(async () => {
      attempts++
      if (attempts === 1) {
        // Request A completes its refresh here, between B's capture and B's
        // own (about to be cooled-down) refresh call.
        await refreshCopilotToken("401-retry")
        return new Response("unauthorized", { status: 401 })
      }
      return new Response("ok", { status: 200 })
    }, "/test")

    // B's own refresh is skipped by the cooldown, but the generation moved,
    // so B retries and succeeds instead of surfacing a 503.
    expect(attempts).toBe(2)
    expect(res.status).toBe(200)
  })

  test("does not re-send when nothing new is available", async () => {
    // During the outage every request paid a second, guaranteed-401 round
    // trip. With no newer token there is nothing to gain by re-sending.
    globalThis.fetch = mock(async () =>
      new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch

    let attempts = 0
    const res = await tryRefreshAndRetry(async () => {
      attempts++
      return new Response("unauthorized", { status: 401 })
    }, "/test")

    expect(attempts).toBe(1)
    expect(res.status).toBe(401)
  })

  test("an identical token string still counts as progress", async () => {
    // Upstream demonstrably returns a byte-identical token from two
    // consecutive successful exchanges, so comparing strings would suppress
    // a legitimate retry. The generation is what moves.
    state.copilotToken = "same-token"
    state.copilotTokenRefreshAt = Date.now() + 600_000
    globalThis.fetch = mock(async () =>
      exchangeOk("same-token")) as unknown as typeof fetch

    const before = state.copilotTokenGeneration
    let attempts = 0
    const res = await tryRefreshAndRetry(async () => {
      attempts++
      return attempts === 1
        ? new Response("unauthorized", { status: 401 })
        : new Response("ok", { status: 200 })
    }, "/test")

    // Same string in, same string out — but the generation advanced, which
    // is what lets the retry happen.
    expect(state.copilotToken).toBe("same-token")
    expect(state.copilotTokenGeneration).toBeGreaterThan(before)
    expect(attempts).toBe(2)
    expect(res.status).toBe(200)
  })

  test("a non-401 response is returned untouched, with no refresh", async () => {
    const fetchMock = mock(async () => exchangeOk("unused"))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotTokenRefreshAt = Date.now() + 600_000

    const res = await tryRefreshAndRetry(
      async () => new Response("created", { status: 201 }),
      "/test",
    )

    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })
})

/**
 * The other half of the 2026-08-08 outage: the credential was revoked, and
 * nothing said so.
 *
 * `credential_rejected` was PRODUCED by the exchange and CONSUMED nowhere, and
 * upstream 401s are remapped to 503 `overloaded_error` to protect the client's
 * synthetic credential — so a dead credential was indistinguishable from a busy
 * upstream, from either side. The server-side line is the only honest signal,
 * which makes "is it emitted, once, with the right remedy" a correctness
 * property rather than a cosmetic one.
 */
describe("a rejected credential tells a human what to do", () => {
  /** Captured consola output for the duration of one test. */
  function captureConsola(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    // Reporters are process-global and other modules replace them wholesale,
    // so snapshot and restore rather than appending and hoping.
    const previous = consola.options.reporters
    consola.setReporters([
      {
        log: (logObj) => {
          lines.push(logObj.args.map((a) => String(a)).join(" "))
        },
      },
    ])
    return {
      lines,
      restore: () => {
        consola.setReporters([...previous])
      },
    }
  }

  const rejected = () =>
    jsonResponse({ message: "Bad credentials" }, { status: 401 })

  test("says it once per credential, not once per refresh tick", async () => {
    // The refresh loop retries for as long as the process lives. Advice
    // repeated every few minutes is advice nobody reads.
    globalThis.fetch = (async () => rejected()) as unknown as typeof fetch
    const captured = captureConsola()
    try {
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
    } finally {
      captured.restore()
    }

    const advice = captured.lines.filter((l) => l.includes("github-router auth"))
    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain(credentialFingerprint(startingCredential))
    // The remap is why this line has to exist at all; saying so in the line
    // stops the next reader concluding the proxy is merely overloaded.
    expect(advice[0]).toContain("503")
  })

  test("re-arms once a different credential is installed and also dies", async () => {
    // A latch that never resets would silently swallow the SECOND outage.
    const second = `disk-token-${crypto.randomUUID()}`
    let phase: "reject-first" | "accept-second" | "reject-second" =
      "reject-first"
    globalThis.fetch = (async () =>
      phase === "accept-second"
        ? exchangeOk("copilot-v2")
        : rejected()) as unknown as typeof fetch

    const captured = captureConsola()
    try {
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")

      // A human runs `github-router auth`; the proxy adopts it from disk.
      phase = "accept-second"
      await fs.writeFile(tokenPath, second)
      __resetRefreshCooldownsForTests()
      expect(await refreshCopilotToken("interval")).toBe("refreshed")
      expect(state.githubToken).toBe(second)
      // A success is proof the credential works, so the latch must be gone.
      expect(state.authRequiredCredentialFingerprint).toBeUndefined()

      phase = "reject-second"
      __resetRefreshCooldownsForTests()
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
    } finally {
      captured.restore()
    }

    const advice = captured.lines.filter((l) => l.includes("github-router auth"))
    expect(advice).toHaveLength(2)
    expect(advice[0]).toContain(credentialFingerprint(startingCredential))
    expect(advice[1]).toContain(credentialFingerprint(second))
  })

  test("tells an --github-token operator to replace the value, not to re-auth", async () => {
    // `readGithubTokenIfUsable` never reads disk for an explicit credential,
    // so "run github-router auth" would be instructions that cannot work.
    state.githubTokenSource = "explicit"
    globalThis.fetch = (async () => rejected()) as unknown as typeof fetch

    const captured = captureConsola()
    try {
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
    } finally {
      captured.restore()
    }

    const rejection = captured.lines.filter((l) => l.includes("REJECTED"))
    expect(rejection).toHaveLength(1)
    expect(rejection[0]).toContain("GH_TOKEN")
    expect(rejection[0]).not.toContain('"github-router auth" to')
  })

  test("a lapsed entitlement is not told to re-authenticate", async () => {
    // The credential is fine; the seat is not. Sending this person around the
    // login loop is the one remedy guaranteed not to help.
    globalThis.fetch = (async () =>
      jsonResponse(
        { notification_id: "subscription_ended" },
        { status: 403 },
      )) as unknown as typeof fetch

    const captured = captureConsola()
    try {
      expect(await refreshCopilotToken("interval")).toBe("entitlement_lapsed")
    } finally {
      captured.restore()
    }

    // Match the remedy sentence, not the word "entitlement": the raw failure
    // line quotes the upstream `entitlement_lapsed` kind and would match too.
    const lapsed = captured.lines.filter((l) =>
      l.includes("Copilot entitlement lapsed"),
    )
    expect(lapsed).toHaveLength(1)
    expect(lapsed[0]).toContain("will NOT help")
    expect(state.authRequiredCredentialFingerprint).toBe(
      credentialFingerprint(startingCredential),
    )
  })

  test("a bare 403 is transient and must not accuse the credential", async () => {
    // GitHub answers 403 for rate limits. Telling a rate-limited user their
    // credential is revoked is a worse failure than the one being fixed.
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 403 })) as unknown as typeof fetch

    const captured = captureConsola()
    try {
      expect(await refreshCopilotToken("interval")).toBe("transient_failure")
    } finally {
      captured.restore()
    }

    expect(captured.lines.filter((l) => l.includes("REJECTED"))).toHaveLength(0)
    expect(state.authRequiredCredentialFingerprint).toBeUndefined()
  })
})

/**
 * The startup exchange is a SEPARATE code path from the refresh loop, and it is
 * the one a revoked credential is most likely to be discovered on: a user whose
 * session died restarts, and restarting runs exactly this. Before this was
 * wired it aborted launch with a bare "HTTP 401", never naming the one action
 * that fixes it — which is precisely how the original incident got diagnosed as
 * "restart didn't help" instead of "the credential is revoked".
 */
describe("a credential rejected at startup", () => {
  test("still names the remedy before it aborts the launch", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { message: "Bad credentials" },
        { status: 401 },
      )) as unknown as typeof fetch

    const lines: string[] = []
    const previous = consola.options.reporters
    consola.setReporters([
      { log: (o) => lines.push(o.args.map((a) => String(a)).join(" ")) },
    ])
    try {
      // The launch must still fail — a credential that cannot be exchanged is
      // not something to start up around.
      await expect(setupCopilotToken()).rejects.toThrow()
    } finally {
      consola.setReporters([...previous])
    }

    const advice = lines.filter((l) => l.includes("github-router auth"))
    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain(credentialFingerprint(startingCredential))

    // Second phase, folded in rather than split out: on its own this assertion
    // passes against unfixed code (which emits no advice at all, ever), so as a
    // standalone test it would be decoration. It is also the assertion that
    // matters most — a 500 at launch is upstream having a bad minute, and
    // sending that user to re-authenticate points them at something that is not
    // broken.
    state.authRequiredCredentialFingerprint = undefined
    globalThis.fetch = (async () =>
      new Response("upstream boom", { status: 500 })) as unknown as typeof fetch

    const transientLines: string[] = []
    consola.setReporters([
      { log: (o) => transientLines.push(o.args.map((a) => String(a)).join(" ")) },
    ])
    try {
      await expect(setupCopilotToken()).rejects.toThrow()
    } finally {
      consola.setReporters([...previous])
    }

    expect(
      transientLines.filter((l) => l.includes("github-router auth")),
    ).toHaveLength(0)
    expect(state.authRequiredCredentialFingerprint).toBeUndefined()
  })
})
