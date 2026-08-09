import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { server } from "../src/server"
import { state } from "../src/lib/state"
import { getPackageVersion } from "../src/lib/version"

/**
 * `/version` is the machine-readable half of the revoked-credential signal.
 *
 * The proxy remaps every upstream 401 to a 503 `overloaded_error` so a spawned
 * Claude Code session never sees an auth failure against its synthetic
 * credential. That remap is deliberate and stays — but it means "the credential
 * is dead and a human must re-authenticate" and "upstream is busy, retry" are
 * the same observation to any caller. This endpoint is where they separate.
 */

const originalLatch = state.authRequiredCredentialFingerprint

interface VersionBody {
  name: string
  version: string
  gitSha: string
  auth_required: boolean
}

async function readVersion(): Promise<VersionBody> {
  const res = await server.request("/version")
  expect(res.status).toBe(200)
  return (await res.json()) as VersionBody
}

beforeEach(() => {
  state.authRequiredCredentialFingerprint = undefined
})

afterEach(() => {
  state.authRequiredCredentialFingerprint = originalLatch
})

describe("GET /version", () => {
  test("reports auth_required, and clears it again", async () => {
    // Three phases in one test on purpose. Asserting only the `true` phase
    // would pass against a handler that hard-codes `true`, and asserting only
    // the `false` phase would pass against one that hard-codes `false`.
    const healthy = await readVersion()
    expect(healthy.auth_required).toBe(false)

    state.authRequiredCredentialFingerprint = "d76b6f21"
    expect((await readVersion()).auth_required).toBe(true)

    // A successful exchange clears the latch (`commitCopilotToken`); the
    // endpoint must follow it back down rather than latching for the process
    // lifetime.
    state.authRequiredCredentialFingerprint = undefined
    expect((await readVersion()).auth_required).toBe(false)
  })

  test("never leaks the credential fingerprint or its source", async () => {
    // This route sits behind an unrestricted `cors()`, so any web page can read
    // it. A bare boolean is the same information a 503 already leaks; the
    // fingerprint and `githubTokenSource` are not, and the remedy that depends
    // on them belongs in the log instead.
    state.authRequiredCredentialFingerprint = "d76b6f21"
    const res = await server.request("/version")
    const raw = await res.text()

    expect(raw).toContain("auth_required")
    expect(raw).not.toContain("d76b6f21")
    expect(raw).not.toContain("githubTokenSource")
    expect(raw).not.toContain("explicit")
  })

  test("reports the version read at runtime, not one inlined at build time", async () => {
    // release.yml builds BEFORE `npm version patch`, so a build-time inline
    // always reports the pre-bump value — which makes `github-router --version`
    // and this endpoint lie in exactly the situation an operator consults them:
    // confirming an upgrade actually loaded.
    expect((await readVersion()).version).toBe(getPackageVersion())
  })
})
