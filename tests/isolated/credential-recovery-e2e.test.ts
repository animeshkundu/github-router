/**
 * End-to-end proof of the 2026-08-08 recovery path, against a fake GitHub.
 *
 * The unit tests exercise individual mechanisms. This one walks the whole
 * incident in order — healthy, revoked, repaired-on-disk, recovered — driving
 * the real `setupCopilotToken` refresh loop against an HTTP server that
 * actually revokes a credential mid-run. It is the test that maps onto what
 * the user experienced, because the original bug was not in the refresh logic
 * itself: it was that the running process never looked at the file again.
 *
 * Sequence:
 *   1. Start with credential v1. Fake GitHub accepts it. Exchange succeeds.
 *   2. Fake GitHub starts rejecting v1 (simulating revocation). Refresh fails
 *      and the process is left holding a Copilot token that will expire.
 *   3. Credential v2 is written to disk — the `github-router auth` moment.
 *   4. WITHOUT restarting, the next refresh must recover.
 *
 * Step 4 is the assertion. Before the fix it could never pass.
 *
 * Runs in-process against a scratch HOME rather than spawning the CLI:
 * spawning would drag in self-update, colbert provisioning and toolbelt
 * materialization, none of which bear on the credential lifecycle.
 *
 * Lives under `tests/isolated/` because it sets `GITHUB_API_URL`, which
 * `~/lib/api-config` reads ONCE into a module-level constant at load time.
 * In a shared process that makes the value order-dependent — whichever test
 * file loads the module first wins — so this file gets its own process, which
 * is exactly what that lane exists for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const CRED_V1 = "ghu_credential_version_one"
const CRED_V2 = "ghu_credential_version_two"

let fakeGitHub: http.Server | undefined
let homeDir = ""

/** Flipped mid-test to simulate the credential being revoked upstream. */
let acceptedCredential = CRED_V1
/** Copilot tokens minted so far, so the proxy's own refresh is observable. */
let minted = 0

function startFakeGitHub(): Promise<number> {
  fakeGitHub = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? ""
    res.setHeader("content-type", "application/json")

    if (req.url?.includes("/copilot_internal/v2/token")) {
      // The exchange only honours the currently-valid credential. This is
      // what "revoked" looks like from the client side.
      if (!auth.includes(acceptedCredential)) {
        res.statusCode = 401
        res.end(JSON.stringify({ message: "Bad credentials" }))
        return
      }
      minted++
      res.end(
        JSON.stringify({
          token: `copilot-token-${minted}`,
          // Short, so the proxy re-exchanges promptly and the test does not
          // have to wait 25 minutes for the scheduled refresh.
          refresh_in: 60,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: {},
        }),
      )
      return
    }

    if (req.url?.endsWith("/user")) {
      res.end(JSON.stringify({ login: "e2e-user" }))
      return
    }

    res.statusCode = 404
    res.end("{}")
  })

  return new Promise((resolve) => {
    fakeGitHub!.listen(0, "127.0.0.1", () => {
      const addr = fakeGitHub!.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
    })
  })
}

beforeEach(async () => {
  acceptedCredential = CRED_V1
  minted = 0
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-e2e-"))
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!fakeGitHub) return resolve()
    fakeGitHub.close(() => resolve())
  })
  fakeGitHub = undefined
  if (homeDir) await fs.rm(homeDir, { recursive: true, force: true })
})

describe("credential recovery, end to end", () => {
  test("a running proxy adopts a credential repaired on disk, with no restart", async () => {
    const ghPort = await startFakeGitHub()

    // The credential file, where the proxy expects it under a scratch HOME.
    const appDir = path.join(homeDir, ".local", "share", "github-router")
    await fs.mkdir(appDir, { recursive: true })
    const tokenPath = path.join(appDir, "github_token")
    await fs.writeFile(tokenPath, CRED_V1)

    // Point the module at the fake GitHub and at a scratch credential path,
    // isolating the test from the developer's real credential.
    process.env.GITHUB_API_URL = `http://127.0.0.1:${ghPort}`
    const { state } = await import("../../src/lib/state")
    const { PATHS } = await import("../../src/lib/paths")
    Object.defineProperty(PATHS, "GITHUB_TOKEN_PATH", {
      configurable: true,
      value: tokenPath,
    })
    const { setupCopilotToken, refreshCopilotToken } = await import(
      "../../src/lib/token"
    )

    state.githubToken = CRED_V1
    state.githubTokenSource = "file"

    // 1. Healthy start.
    const stop = await setupCopilotToken()
    try {
      expect(state.copilotToken).toBe("copilot-token-1")

      // 2. The credential is revoked upstream. A refresh now fails, and the
      //    proxy is holding a credential that will never work again.
      acceptedCredential = CRED_V2
      expect(await refreshCopilotToken("interval")).toBe("credential_rejected")
      expect(state.copilotToken).toBe("copilot-token-1") // still the stale one

      // 3. The user runs `github-router auth` in another terminal. Atomic
      //    replace, exactly as `writeTokenFileAtomic` does it.
      const tmp = `${tokenPath}.new`
      await fs.writeFile(tmp, CRED_V2)
      await fs.rename(tmp, tokenPath)

      // 4. THE ASSERTION. No restart. The next refresh must find the repaired
      //    credential on disk, adopt it, and recover. Before the fix this
      //    could not happen: the process never re-read the file.
      expect(await refreshCopilotToken("401-retry")).toBe("refreshed")
      expect(state.githubToken).toBe(CRED_V2)
      expect(state.copilotToken).toBe("copilot-token-2")
    } finally {
      stop()
      delete process.env.GITHUB_API_URL
    }
  }, 30_000)
})
