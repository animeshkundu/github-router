/**
 * Identity gate for adopting VS Code's GitHub OAuth app.
 *
 *   bun scripts/probe-device-flow.ts [--client-id <id>] [--scope "<scopes>"]
 *
 * github-router currently authenticates as the community Copilot GitHub App
 * `Iv1.b507a08c87ecfe98` (device flow, `read:user`, `ghu_` token). VS Code's
 * built-in `github-authentication` extension instead uses the CLASSIC OAuth app
 * `01ab8ac9400c4e429b23` (PKCE browser flow, with device code as a fallback),
 * yielding a `gho_` token. Matching it removes the last auth-layer signal that
 * distinguishes this proxy from VS Code Copilot Chat.
 *
 * Nothing may be changed in `src/` until this probe proves three things, because
 * each of them can independently kill the idea:
 *
 *   1. Device flow is ENABLED on that app. A classic OAuth app whose owner did
 *      not enable it answers `400 device_flow_disabled`.
 *   2. `/copilot_internal/v2/token` ACCEPTS a token minted from it. That
 *      endpoint is demonstrably picky about the minting app — the GitHub CLI's
 *      OAuth token gets a 403 from it — so "the login worked" is not evidence
 *      the exchange will.
 *   3. The GRANTED scopes are what we asked for. This is the one that can bite
 *      silently: a classic OAuth app device flow against an app the user has
 *      ALREADY authorized returns a token carrying the EXISTING grant's scopes,
 *      not the narrowly requested ones. If the user's VS Code grant includes
 *      `repo`/`workflow`, then `~/.local/share/github-router/github_token`
 *      quietly becomes a WRITE-CAPABLE credential — a file this codebase
 *      reasons about as read-only, and one that is also sent to Copilot's
 *      `/mcp` web-search endpoint. That is a blast-radius change, and it is a
 *      decision for a human, not a footnote.
 *
 * SAFETY, by construction:
 *   - never calls `setupGitHubToken`/`writeGithubToken`, so
 *     `PATHS.GITHUB_TOKEN_PATH` is never touched. The minted token lives in
 *     memory for the duration of this process and is validated through
 *     `getCopilotToken(credentialOverride)`, which exists precisely to try a
 *     candidate credential without publishing it to shared `state`.
 *   - forces `consola.level = 3`. `pollAccessToken` debug-logs the raw poll
 *     response, which contains the access token; running this at debug level
 *     would print a live credential to the terminal.
 *   - prints only the SHA-256 fingerprint (the same 8 hex chars the proxy
 *     already logs), never the credential.
 *
 * SIDE EFFECT, stated plainly: completing the flow creates or refreshes a real
 * OAuth grant on the account, and consumes one of GitHub's ten-tokens-per-hour
 * creations. If the ten-token-per-(user, app, scope) cap applies, it can evict
 * an existing token in that pool. Run it knowingly, as the account owner.
 */

import { createHash } from "node:crypto"

import consola from "consola"

import { GITHUB_API_BASE_URL, standardHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"
import { getCopilotToken } from "~/services/github/get-copilot-token"

/** VS Code's built-in `github-authentication` client id, read out of the
 *  shipped `extensions/github-authentication/dist/extension.js` bundle. */
const VSCODE_CLIENT_ID = "01ab8ac9400c4e429b23"

/** Narrowest scope first. Broader ones are only worth probing if this fails. */
const DEFAULT_SCOPE = "read:user"

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fingerprint(token: string): string {
  // Same derivation the proxy logs, so probe output and proxy output are
  // directly comparable.
  return createHash("sha256").update(token).digest("hex").slice(0, 8)
}

async function main(): Promise<void> {
  // Load-bearing: see the safety note above.
  consola.level = 3

  const clientId = arg("--client-id") ?? VSCODE_CLIENT_ID
  const scope = arg("--scope") ?? DEFAULT_SCOPE

  // `githubHeaders` sends `editor-version`/`editor-plugin-version` from state.
  // Pin literals rather than calling the cache helpers, which would write the
  // editor-version cache under the app dir — this probe writes nothing.
  state.vsCodeVersion = "1.130.0"
  state.copilotVersion = "0.45.1"

  consola.info(`client_id=${clientId}`)
  consola.info(`scope="${scope}"`)

  // --- 1. device flow enabled? -------------------------------------------
  let device
  try {
    device = await getDeviceCode({ clientId, scope })
  } catch (error) {
    consola.error(
      "GATE FAILED at /login/device/code. A `device_flow_disabled` error here "
        + "means the app's owner has not enabled device flow, and this approach "
        + "is dead as written.",
      error,
    )
    process.exitCode = 1
    return
  }
  consola.success("/login/device/code accepted the client_id")

  consola.box(
    `Enter code  ${device.user_code}\nat          ${device.verification_uri}`,
  )

  const token = await pollAccessToken(device, clientId)
  const fp = fingerprint(token)
  consola.success(
    `minted a credential: prefix=${token.slice(0, 4)} fingerprint=${fp}`,
  )
  if (!token.startsWith("gho_")) {
    consola.warn(
      `expected a classic OAuth token (gho_) from this app, got `
        + `"${token.slice(0, 4)}". Worth understanding before proceeding.`,
    )
  }

  // --- 3. what was ACTUALLY granted? -------------------------------------
  // Checked BEFORE the exchange, because a broad grant is a reason to stop even
  // if the exchange would have succeeded.
  const userResponse = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: { ...standardHeaders(), authorization: `token ${token}` },
  })
  const grantedScopes = userResponse.headers.get("x-oauth-scopes") ?? ""
  const requested = scope.split(/[\s,]+/).filter(Boolean)
  const granted = grantedScopes.split(/[\s,]+/).filter(Boolean)
  const requestedSet = new Set(requested)
  const grantedSet = new Set(granted)
  const extra = granted.filter((s) => !requestedSet.has(s))
  const missing = requested.filter((s) => !grantedSet.has(s))

  consola.info(`GET /user -> ${userResponse.status}`)
  consola.info(`x-oauth-scopes: "${grantedScopes}"`)
  if (extra.length > 0) {
    consola.warn(
      `GRANT IS BROADER THAN REQUESTED: ${extra.join(", ")}.\n`
        + `This is the pre-existing authorization on this account being reused. `
        + `Adopting this app would store a credential with those scopes at `
        + `PATHS.GITHUB_TOKEN_PATH — a file this codebase treats as read-only `
        + `and forwards to Copilot's /mcp endpoint. Decide explicitly before `
        + `landing the swap.`,
    )
  }
  if (missing.length > 0) {
    // The mirror-image failure, and the one a "no extra scopes" check alone
    // reports as success: GitHub can grant a SUBSET. A credential silently
    // short of what the proxy needs fails later, somewhere unrelated.
    consola.warn(
      `GRANT IS NARROWER THAN REQUESTED — missing: ${missing.join(", ")}. `
        + `The credential does not carry everything that was asked for.`,
    )
  }
  if (extra.length === 0 && missing.length === 0) {
    if (granted.length === 0) {
      // A GitHub App user-to-server token reports no OAuth scopes at all
      // (permissions are app-level), so an empty header is expected there and
      // meaningless rather than reassuring. Do not report it as a match.
      consola.info(
        `no x-oauth-scopes header content — expected for a GitHub App `
          + `user-to-server token, but it means this check proves nothing here.`,
      )
    } else {
      consola.success(`grant matches the request exactly`)
    }
  }

  // --- 2. does the Copilot exchange accept it? ---------------------------
  try {
    const result = await getCopilotToken(token)
    consola.success(
      `/copilot_internal/v2/token ACCEPTED it `
        + `(refresh_in=${result.refresh_in}, token=${result.token.length} chars)`,
    )
    consola.success(
      `GATE PASSED for client_id=${clientId} scope="${scope}". `
        + `Hard-code exactly this scope; do not ship a runtime fallback ladder.`,
    )
  } catch (error) {
    consola.error(
      `GATE FAILED at /copilot_internal/v2/token. The app minted a usable `
        + `GitHub credential, but Copilot will not exchange it — same class of `
        + `rejection the GitHub CLI's OAuth app gets. Do not land the swap.`,
      error,
    )
    process.exitCode = 1
  }
}

await main()
